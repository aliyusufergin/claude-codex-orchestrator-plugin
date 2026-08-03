// Seam 1 — the Runner CLI, driven as a process in a temporary git repository against the fake
// Codex binary. Every assertion here is on stdout, the exit code, or the filesystem.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { advisoryPayload, createFixtureRepo, flagValue, runRunner } from "./helpers/harness.mjs";

describe("runner delegate", () => {
  it("returns the Worker's Result on stdout and exits 0", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload({ summary: "looks fine" }) });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "review my diff",
    ]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /looks fine/);
  });

  it("reads the payload from the -o file, not the double-encoded copy in the event stream", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      payload: advisoryPayload({ summary: "from the output file" }),
      streamPayload: advisoryPayload({ summary: "from the event stream" }),
    });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /from the output file/);
    assert.doesNotMatch(run.stdout, /from the event stream/);
  });

  it("invokes `codex exec --json` with an output schema, an output file and the prompt", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "review my diff",
    ]);
    assert.equal(run.code, 0, run.stderr);

    const invocation = fixture.invocation();
    assert.equal(invocation.subcommand, "exec");
    // The prompt is the Task Kind's template with the request in it — the template's own coverage
    // is in `advisory-review.test.mjs`.
    assert.ok(invocation.prompt.includes("review my diff"), invocation.prompt);
    assert.ok(invocation.args.includes("--json"), invocation.args.join(" "));

    const schema = flagValue(invocation.args, "--output-schema");
    assert.ok(schema && existsSync(schema), `--output-schema missing or unreadable: ${schema}`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(schema, "utf8")));

    const outputFile = flagValue(invocation.args, "-o");
    assert.ok(outputFile, "expected -o <file>");
  });

  it("never invokes Codex through npx", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    const invocation = fixture.invocation();
    for (const arg of invocation.argv) {
      assert.ok(!/(^|[/\\])npx(\.\w+)?$/.test(arg), `npx in argv: ${arg}`);
      assert.ok(!/\bnpx\b/.test(arg), `npx in argv: ${arg}`);
    }
  });

  it("does not hang when it is invoked with an open stdin", async (t) => {
    const fixture = await createFixtureRepo(t);
    // The default fake reads stdin to EOF before doing anything, exactly as `codex exec` does.
    fixture.configureFake({ readStdin: true });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      holdStdinOpen: true,
    });

    assert.equal(run.timedOut, false, "the Runner hung with an open stdin");
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fixture.invocation().stdinBytes, 0, "Codex's stdin was not /dev/null");
  });

  it("reads the prompt from stdin when --prompt is -", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "-"], {
      stdin: "a prompt from stdin\n",
    });

    assert.equal(run.code, 0, run.stderr);
    assert.ok(fixture.invocation().prompt.includes("a prompt from stdin"), fixture.invocation().prompt);
  });

  it("passes the working directory as -C and never changes its own", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const target = path.join(fixture.repo, "packages", "inner");
    mkdirSync(target, { recursive: true });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "hello",
      "--cwd",
      target,
    ]);
    assert.equal(run.code, 0, run.stderr);

    const invocation = fixture.invocation();
    assert.equal(flagValue(invocation.args, "-C"), target);
    assert.equal(invocation.cwd, fixture.repo, "the Runner cd'd instead of passing -C");
  });

  it("defaults the working directory to its own", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(flagValue(fixture.invocation().args, "-C"), fixture.repo);
  });

  it("treats stderr noise from a successful run as diagnostic, not as failure", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      stderr: "ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n",
      payload: advisoryPayload({ summary: "fine despite the noise" }),
    });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /fine despite the noise/);
  });

  it("fails when Codex exits non-zero", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ exitCode: 1, writePayload: false });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.notEqual(run.code, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /codex/i);
  });

  it("fails when Codex reports success but writes no payload", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ exitCode: 0, writePayload: false });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.notEqual(run.code, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /payload/i);
  });

  it("fails when the Codex binary cannot be spawned", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"], {
      env: { DELEGATE_CODEX_BIN: path.join(fixture.root, "no-such-codex") },
    });

    assert.notEqual(run.code, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /no-such-codex/);
  });

  it("passes a prompt that opens with a dash as a prompt, not as flags", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    // `--prompt --help …` is ambiguous to the Runner's own parser, so a dash-leading prompt
    // arrives either attached or on stdin. Both must reach Codex as the prompt.
    const attached = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt=--help me read this diff",
    ]);
    assert.equal(attached.code, 0, attached.stderr);
    assert.ok(fixture.invocation().prompt.includes("--help me read this diff"), fixture.invocation().prompt);

    const piped = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "-"], {
      stdin: "-C /etc is not a flag here\n",
    });
    assert.equal(piped.code, 0, piped.stderr);
    assert.ok(fixture.invocation().prompt.includes("-C /etc is not a flag here"), fixture.invocation().prompt);
  });

  // Where the payload directory lives and that it is removed on failure is covered in
  // `worker-contract.test.mjs`, alongside the reason it is not under `/tmp`.

  it("leaves files the Worker wrote where the Worker wrote them", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: { "notes.txt": "written by the worker\n" } });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      readFileSync(path.join(fixture.repo, "notes.txt"), "utf8"),
      "written by the worker\n",
    );
  });
});

describe("runner usage", () => {
  it("rejects an unknown subcommand", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["frobnicate"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /frobnicate/);
  });

  it("rejects a missing subcommand", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, []);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /usage/i);
  });

  it("rejects delegate without --kind", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["delegate", "--prompt", "hello"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /--kind/);
  });

  it("rejects delegate without --prompt", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["delegate", "--kind", "review"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /--prompt/);
  });

  it("rejects an empty prompt on stdin", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "-"], {
      stdin: "   \n",
    });

    assert.equal(run.code, 2);
    assert.match(run.stderr, /--prompt/);
  });

  it("rejects a --cwd that is not a directory", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "hello",
      "--cwd",
      path.join(fixture.repo, "does-not-exist"),
    ]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /does-not-exist/);
  });

  it("rejects an unknown flag", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "hello",
      "--budget",
      "9",
    ]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /--budget/);
  });
});
