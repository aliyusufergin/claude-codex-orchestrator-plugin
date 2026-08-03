// Seam 1 — the Worker process contract: which sandbox the Worker runs under, and what of the
// Orchestrator's environment it can see. Driven as a process against the fake Codex binary, which
// records the argv and environment it was handed.
//
// The environment allowlist is the regression that matters most in this plugin: when it fails,
// nothing looks wrong. Every assertion here is on the fake's record, stdout, or the exit code.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createFixtureRepo, flagValue, runRunner } from "./helpers/harness.mjs";

const ADVISORY_KINDS = ["review", "diagnosis", "adversarial"];
const VERIFIABLE_KINDS = ["implementation", "repro", "migration"];

/** Root can write into a mode-0555 directory, so the read-only cases are unmeasurable there. */
const canMeasureReadOnlyDirs = typeof process.getuid !== "function" || process.getuid() !== 0;

/** Make `dir` read-only for the rest of the test, restoring it if the fixture still exists. */
function makeReadOnly(t, dir) {
  chmodSync(dir, 0o555);
  t.after(() => {
    if (existsSync(dir)) chmodSync(dir, 0o755);
  });
}

function sandboxFlag(invocation) {
  return flagValue(invocation.args, "-s");
}

describe("worker environment", () => {
  it("hands the Worker an allowlist and not the Orchestrator's environment", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: {
        AWS_SECRET_ACCESS_KEY: "shaped-like-a-secret",
        GITHUB_TOKEN: "ghp_shaped_like_a_secret",
        ANTHROPIC_API_KEY: "sk-ant-shaped-like-a-secret",
        // Read by Codex's TUI onboarding to prefill a field, never by `codex exec` — so it is a
        // secret the Worker has no use for.
        OPENAI_API_KEY: "sk-shaped-like-a-secret",
        CODEX_API_KEY: "the-worker-authenticates-with-this",
        LANG: "en_GB.UTF-8",
        LC_TIME: "en_GB.UTF-8",
        TERM: "xterm-256color",
        SHELL: "/bin/zsh",
        USER: "orchestrator",
        TMPDIR: "/var/tmp",
      },
    });
    assert.equal(run.code, 0, run.stderr);

    const { env } = fixture.invocation();

    for (const secret of [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      assert.equal(env[secret], undefined, `${secret} reached the Worker`);
    }

    assert.equal(env.CODEX_API_KEY, "the-worker-authenticates-with-this");
    assert.equal(env.CODEX_HOME, fixture.codexHome);
    assert.equal(env.LANG, "en_GB.UTF-8");
    assert.equal(env.LC_TIME, "en_GB.UTF-8", "the LC_* prefix is not covered");
    assert.equal(env.TERM, "xterm-256color");
    assert.equal(env.SHELL, "/bin/zsh");
    assert.equal(env.USER, "orchestrator");
    assert.ok(env.PATH, "the Worker has no PATH");
    assert.ok(env.HOME, "the Worker has no HOME");
    assert.equal(env.TMPDIR, "/var/tmp");
  });

  it("keeps the Runner's own configuration out of the Worker's environment", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);
    assert.equal(run.code, 0, run.stderr);

    const { env } = fixture.invocation();
    assert.equal(env.DELEGATE_CODEX_BIN, undefined);
    assert.equal(env.DELEGATE_SANDBOXED, undefined);
    assert.equal(env.DELEGATE_ENV_ALLOWLIST, undefined);
  });

  it("extends the allowlist from user configuration, by name and by prefix", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: {
        DELEGATE_ENV_ALLOWLIST: "DELEGATE_FAKE_CODEX_DIR,CARGO_HOME,BUILD_*",
        CARGO_HOME: "/opt/cargo",
        BUILD_NUMBER: "41",
        BUILD_TAG: "nightly",
        NOT_BUILD: "excluded",
      },
    });
    assert.equal(run.code, 0, run.stderr);

    const { env } = fixture.invocation();
    assert.equal(env.CARGO_HOME, "/opt/cargo");
    assert.equal(env.BUILD_NUMBER, "41");
    assert.equal(env.BUILD_TAG, "nightly");
    assert.equal(env.NOT_BUILD, undefined);
  });

  it("refuses to let a bare wildcard turn the allowlist back into inheritance", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: {
        DELEGATE_ENV_ALLOWLIST: "DELEGATE_FAKE_CODEX_DIR,*",
        AWS_SECRET_ACCESS_KEY: "shaped-like-a-secret",
      },
    });
    assert.equal(run.code, 0, run.stderr);

    const { env } = fixture.invocation();
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "a bare `*` opened the allowlist");
    assert.ok(env.PATH, "the allowlist stopped working altogether");
  });
});

describe("sandbox mode selection", () => {
  it("runs an Advisory Delegation read-only with no outer sandbox", async (t) => {
    const fixture = await createFixtureRepo(t);

    for (const kind of ADVISORY_KINDS) {
      fixture.configureFake({});
      const run = await runRunner(fixture, ["delegate", "--kind", kind, "--prompt", "hello"], {
        env: { DELEGATE_SANDBOXED: "0" },
      });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(sandboxFlag(fixture.invocation()), "read-only", kind);
    }
  });

  it("runs a Verifiable Delegation workspace-write with no outer sandbox", async (t) => {
    const fixture = await createFixtureRepo(t);

    for (const kind of VERIFIABLE_KINDS) {
      fixture.configureFake({});
      const run = await runRunner(fixture, ["delegate", "--kind", kind, "--prompt", "hello"], {
        env: { DELEGATE_SANDBOXED: "0" },
      });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(sandboxFlag(fixture.invocation()), "workspace-write", kind);
    }
  });

  it("keeps Codex's own sandbox on under an outer sandbox when the preconditions hold", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const advisory = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "x"], {
      env: { DELEGATE_SANDBOXED: "1" },
    });
    assert.equal(advisory.code, 0, advisory.stderr);
    assert.equal(sandboxFlag(fixture.invocation()), "read-only");
    assert.doesNotMatch(advisory.stderr, /danger-full-access/);

    const verifiable = await runRunner(
      fixture,
      ["delegate", "--kind", "implementation", "--prompt", "x"],
      { env: { DELEGATE_SANDBOXED: "1" } },
    );
    assert.equal(verifiable.code, 0, verifiable.stderr);
    assert.equal(sandboxFlag(fixture.invocation()), "workspace-write");
  });

  it("falls back to danger-full-access under an outer sandbox with a read-only /tmp", async (t) => {
    if (process.platform !== "linux") return t.skip("the /tmp precondition is Linux-only");
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.tmpProbe);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_SANDBOXED: "1" },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(sandboxFlag(fixture.invocation()), "danger-full-access");
    // The diagnostic names the precondition that failed — the two fail at different layers, and a
    // message that does not say which one is missing sends the user to the wrong fix.
    assert.match(run.stderr, new RegExp(fixture.tmpProbe));
    assert.doesNotMatch(run.stderr, /CODEX_HOME/);
  });

  it("never reaches for danger-full-access without an outer sandbox", async (t) => {
    if (process.platform !== "linux") return t.skip("the /tmp precondition is Linux-only");
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.tmpProbe);

    // With no outer jail, `danger-full-access` is the only thing between a third-party agent and
    // the machine — so the same precondition that costs a layer when sandboxed refuses here.
    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_SANDBOXED: "0" },
    });

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, new RegExp(fixture.tmpProbe));
    assert.equal(existsSync(path.join(fixture.fakeDir, "fake-codex-invocation.json")), false);
  });

  it("measures the outer sandbox rather than being told about it", async (t) => {
    if (process.platform !== "linux") return t.skip("the /tmp precondition is Linux-only");
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    // A $HOME the Runner cannot write to is what an outer sandbox looks like from inside, and a
    // read-only stand-in for `/tmp` is what it costs. Detection is left to run for real here.
    const home = path.join(fixture.root, "sandboxed-home");
    mkdirSync(home);
    makeReadOnly(t, home);
    makeReadOnly(t, fixture.tmpProbe);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_SANDBOXED: "", HOME: home },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(sandboxFlag(fixture.invocation()), "danger-full-access");
  });

  it("reads a writable $HOME as no outer sandbox", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const home = path.join(fixture.root, "ordinary-home");
    mkdirSync(home);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_SANDBOXED: "", HOME: home },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(sandboxFlag(fixture.invocation()), "read-only");
    assert.deepEqual(
      readdirSync(home).filter((entry) => entry.startsWith(".delegate-")),
      [],
      "the detection probe was left behind in $HOME",
    );
  });

  it("does not bypass Codex's approvals-and-sandbox switch", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_SANDBOXED: "1" },
    });

    const { args } = fixture.invocation();
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"), args.join(" "));
    assert.ok(!args.includes("--yolo"), args.join(" "));
  });
});

describe("codex home precondition", () => {
  it("fails before invoking Codex when $CODEX_HOME is not writable", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.codexHome);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /CODEX_HOME/);
    assert.match(run.stderr, new RegExp(fixture.codexHome));
    assert.equal(
      existsSync(path.join(fixture.fakeDir, "fake-codex-invocation.json")),
      false,
      "Codex was invoked despite a read-only $CODEX_HOME",
    );
  });

  it("reports a read-only $CODEX_HOME under an outer sandbox rather than working around it", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.codexHome);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_SANDBOXED: "1" },
    });

    // `danger-full-access` does not rescue this one: Codex dies at app-server startup, before it
    // reads a sandbox mode at all.
    assert.equal(run.code, 1);
    assert.match(run.stderr, /CODEX_HOME/);
  });

  it("creates $CODEX_HOME when it does not exist yet", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const codexHome = path.join(fixture.root, "fresh-codex-home");

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { CODEX_HOME: codexHome },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(existsSync(codexHome), true);
    assert.equal(fixture.invocation().env.CODEX_HOME, codexHome);
  });

  it("keeps its payload directory out of /tmp and removes it afterwards", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ refuseWrites: true });
    const forbiddenTmp = path.join(fixture.root, "tmp");
    mkdirSync(forbiddenTmp);

    // Codex's Linux sandbox helper mounts over paths under `/tmp`, so anything the Worker's run
    // depends on living there can be silently shadowed (ADR-0004).
    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { TMPDIR: forbiddenTmp },
    });

    assert.notEqual(run.code, 0);
    assert.deepEqual(readdirSync(forbiddenTmp), []);
    assert.deepEqual(
      readdirSync(fixture.codexHome).filter((entry) => entry.startsWith("delegate-")),
      [],
      "a payload directory was left behind in $CODEX_HOME",
    );
  });
});

describe("task kinds", () => {
  it("rejects a Task Kind it cannot place in a Delegation Class", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "refactor", "--prompt", "hello"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /refactor/);
    assert.equal(existsSync(path.join(fixture.fakeDir, "fake-codex-invocation.json")), false);
  });
});

describe("no stray writes", () => {
  it("leaves the user's working tree untouched by the Runner itself", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const before = readdirSync(fixture.repo).sort();
    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readdirSync(fixture.repo).sort(), before);
  });
});
