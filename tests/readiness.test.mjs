// Seam 1 — readiness: what `SessionStart` and `/delegate:setup` measure before anything has been
// delegated, driven as a process against the fake Codex binary.
//
// The value of this check is entirely in what it says when something is wrong: every failure it
// names here is one that otherwise surfaces minutes later as a Delegation that dies without
// explaining itself. So the assertions are on the words — the path, the setting, the command —
// rather than only on the exit code.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { createFixtureRepo, runRunner } from "./helpers/harness.mjs";

/** Root can write into a mode-0555 directory, so the read-only cases are unmeasurable there. */
const canMeasureReadOnlyDirs = typeof process.getuid !== "function" || process.getuid() !== 0;

/** Make `dir` read-only for the rest of the test, restoring it if the fixture still exists. */
function makeReadOnly(t, dir) {
  chmodSync(dir, 0o555);
  t.after(() => {
    if (existsSync(dir)) chmodSync(dir, 0o755);
  });
}

/** A local port nothing is listening on — a connection to it is refused at once. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A local port something is listening on, closed when the test ends. */
async function openPort(t) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

describe("readiness", () => {
  it("reports every precondition and exits 0 when the plugin can run", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["ready"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /readiness/i);
    // The three the issue names, plus the Budget: binary, login, and $CODEX_HOME.
    assert.match(run.stdout, /codex binary/i);
    assert.match(run.stdout, /logged in/i);
    assert.match(run.stdout, /CODEX_HOME/);
    assert.match(run.stdout, /Delegation Budget/i);
  });

  it("fails naming $CODEX_HOME and the write allowance when it cannot be written to", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.codexHome);

    const run = await runRunner(fixture, ["ready"], { env: { DELEGATE_SANDBOXED: "1" } });

    // It kills `codex exec` at app-server startup under every sandbox mode, so it is a hard
    // failure rather than a warning — and the message has to name the path itself.
    assert.equal(run.code, 1);
    assert.match(run.stderr, /CODEX_HOME/);
    assert.match(run.stderr, new RegExp(fixture.codexHome));
    // Both channels carry the remedy, not just the verdict: what this check exists to produce is
    // the setting to add, and a harness may surface only one of the two.
    assert.match(run.stdout, /sandbox\.filesystem\.allowWrite/);
    assert.match(run.stderr, /sandbox\.filesystem\.allowWrite/);
  });

  it("fails when there is no Codex binary to run", async (t) => {
    const fixture = await createFixtureRepo(t);
    const missing = path.join(fixture.root, "no-such-codex");

    const run = await runRunner(fixture, ["ready"], { env: { DELEGATE_CODEX_BIN: missing } });

    assert.equal(run.code, 1);
    assert.match(run.stdout, new RegExp(missing));
    assert.match(run.stderr, /install the Codex CLI/i);
  });

  it("fails when Codex is not logged in, and says which command fixes it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ loggedIn: false });

    const run = await runRunner(fixture, ["ready"]);

    assert.equal(run.code, 1);
    assert.match(run.stdout, /codex login/);
  });

  it("reads an API key in the Worker's environment as authentication", async (t) => {
    const fixture = await createFixtureRepo(t);
    // Codex would report no login, and the key is what `codex exec` actually authenticates with.
    fixture.configureFake({ loggedIn: false });

    const run = await runRunner(fixture, ["ready"], {
      env: { CODEX_API_KEY: "the-worker-authenticates-with-this" },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /CODEX_API_KEY/);
    assert.ok(
      !fixture.invocations().some((invocation) => invocation.subcommand === "login status"),
      "Codex was asked about a login the environment had already answered",
    );
  });

  it("reports ADR-0004's conclusion as unverified on darwin under an outer sandbox", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const port = await openPort(t);

    const run = await runRunner(fixture, ["ready"], {
      env: {
        DELEGATE_PLATFORM: "darwin",
        DELEGATE_SANDBOXED: "1",
        DELEGATE_API_HOST: `127.0.0.1:${port}`,
      },
    });

    // Seatbelt inside Seatbelt is a different collision from the measured one, and the user is
    // told they are on unverified ground rather than handed a silent assumption.
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /unverified on this platform/i);
    assert.match(run.stdout, /ADR-0004/);
  });

  it("says nothing about the platform when nothing is nesting", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["ready"], {
      env: { DELEGATE_PLATFORM: "darwin", DELEGATE_SANDBOXED: "0" },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /unverified on this platform/i);
  });

  it("names sandbox.network.allowedDomains when the API host is unreachable under a sandbox", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const port = await closedPort();

    const run = await runRunner(fixture, ["ready"], {
      env: { DELEGATE_SANDBOXED: "1", DELEGATE_API_HOST: `127.0.0.1:${port}` },
    });

    // Claude Code pre-allows no domains, so this is the precondition nobody told the user about.
    assert.match(run.stdout, /sandbox\.network\.allowedDomains/);
    assert.match(run.stdout, new RegExp(`127\\.0\\.0\\.1:${port}`));
  });

  it("says nothing about allowed domains when the API host answers", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const port = await openPort(t);

    const run = await runRunner(fixture, ["ready"], {
      env: { DELEGATE_SANDBOXED: "1", DELEGATE_API_HOST: `127.0.0.1:${port}` },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /allowedDomains/);
  });

  it("does not probe the network at all when there is no outer sandbox", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const port = await closedPort();

    const run = await runRunner(fixture, ["ready"], {
      env: { DELEGATE_SANDBOXED: "0", DELEGATE_API_HOST: `127.0.0.1:${port}` },
    });

    // Unreachable and unsandboxed says nothing about `allowedDomains` — there is no outer sandbox
    // holding the connection, so a session that is merely offline would be told to edit a setting
    // that is not the cause.
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /allowedDomains/);
  });

  it("warns and names /delegate:quota when the Budget is already spent", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["ready"], { env: { DELEGATE_BUDGET_CEILING: "0" } });

    // A spent Budget is a state, not a broken installation: the session is still usable for
    // everything else, so it is reported rather than failed.
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\/delegate:quota/);
  });

  it("names /tmp as a precondition and keeps both sandboxes when it cannot have it", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.tmpProbe);
    const port = await openPort(t);

    const run = await runRunner(fixture, ["ready"], {
      env: {
        DELEGATE_PLATFORM: "linux",
        DELEGATE_SANDBOXED: "1",
        DELEGATE_API_HOST: `127.0.0.1:${port}`,
      },
    });

    // The outer jail is still holding, so this costs a layer rather than the Delegation — and the
    // user is told which allowance keeps them off the fallback path.
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, new RegExp(fixture.tmpProbe));
    assert.match(run.stdout, /danger-full-access/);
    assert.match(run.stdout, /sandbox\.filesystem\.allowWrite/);
  });

  it("fails on a read-only /tmp when nothing else is enforcing a boundary", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.tmpProbe);

    const run = await runRunner(fixture, ["ready"], {
      env: { DELEGATE_PLATFORM: "linux", DELEGATE_SANDBOXED: "0" },
    });

    // Unsandboxed there is no second layer, so `danger-full-access` would be the only thing
    // between a third-party agent and the machine. The Runner refuses that Delegation, and
    // readiness says so before one is attempted.
    assert.equal(run.code, 1);
    assert.match(run.stdout, new RegExp(fixture.tmpProbe));
  });

  it("does not probe /tmp on a platform where it is not the obstacle", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    makeReadOnly(t, fixture.tmpProbe);

    const run = await runRunner(fixture, ["ready"], {
      env: { DELEGATE_PLATFORM: "darwin", DELEGATE_SANDBOXED: "0" },
    });

    // The precondition is an implementation detail of Codex's Linux sandbox helper. Failing a mac
    // session on it would be reporting a measurement that was never taken there.
    assert.equal(run.code, 0, run.stderr);
  });
});

describe("/delegate:setup", () => {
  it("checks readiness and shows the configuration in force", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    // A state directory that has never been written to, which is what a first run has.
    rmSync(fixture.stateDir, { recursive: true, force: true });

    const run = await runRunner(fixture, ["ready", "--setup"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /readiness/i);
    // The numbers, where they came from, and the fact that none of them is measured.
    assert.match(run.stdout, /Delegations per window/);
    assert.match(run.stdout, /provisional/i);
    // The allowlist and the one variable that extends it.
    assert.match(run.stdout, /DELEGATE_ENV_ALLOWLIST/);
    assert.match(run.stdout, /CODEX_HOME/);
    // Where the plugin's own state lives, created rather than merely named.
    assert.match(run.stdout, new RegExp(fixture.stateDir));
    assert.equal(existsSync(fixture.stateDir), true);
  });

  it("says the plugin ships off and how it is turned on", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["ready", "--setup"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /defaultEnabled/);
  });

  it("rejects an argument it does not take", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["ready", "--everything"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /--everything/);
  });
});

describe("readiness and the state directory", () => {
  it("fails when the Ledger cannot be written, because a Budget that cannot be counted is not enforced", async (t) => {
    if (!canMeasureReadOnlyDirs) return t.skip("running as root");

    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const stateRoot = path.join(fixture.root, "read-only-state");
    mkdirSync(stateRoot);
    makeReadOnly(t, stateRoot);

    const run = await runRunner(fixture, ["ready"], { env: { DELEGATE_STATE_DIR: stateRoot } });

    assert.equal(run.code, 1);
    assert.match(run.stdout, new RegExp(stateRoot));
  });
});
