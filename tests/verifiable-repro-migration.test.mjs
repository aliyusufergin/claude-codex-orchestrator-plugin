// Seam 1 — the last two Verifiable Task Kinds: Repro, whose Verification Signal is inverted, and
// Migration, whose correctness is the build rather than the diff.
//
// The failure this file exists for is C1's: a Repro whose test passes. Every other Verifiable
// Delegation reports that as "not done yet", and the one repair that is never correct for a Repro is
// changing the code — so what the Runner renders for that case is asserted here, from both sides.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createFixtureRepo,
  flagValue,
  git,
  runRunner,
  verifiablePayload,
} from "./helpers/harness.mjs";

const REPRO = ["delegate", "--kind", "repro", "--prompt", "a token expiring exactly now is accepted"];
const MIGRATE = ["delegate", "--kind", "migration", "--prompt", "replace every `assert.ok` with `expect`"];

/** The test file a Repro Worker writes, and the Result it reports for it. */
const REPRO_TEST = { "tests/token.test.ts": "test('expiry boundary', () => expect(expired(now)).toBe(true));\n" };

const reproPayload = (overrides = {}) =>
  verifiablePayload({
    summary: "Added a test asserting a token expiring exactly now is rejected. It fails on the boundary.",
    files_changed: Object.keys(REPRO_TEST),
    diff_stat: { files: 1, insertions: 4, deletions: 0 },
    verification: { command: "npm test -- tests/token.test.ts", exit_code: 1, passed: true },
    caveats: ["Only the unit suite was run."],
    expected_failure: true,
    ...overrides,
  });

describe("the Repro Delegation", () => {
  it("is a success when the Worker reports a test that fails", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: REPRO_TEST, payload: reproPayload() });

    const run = await runRunner(fixture, REPRO);
    assert.equal(run.code, 0, run.stderr);

    // C1: a non-zero exit code with `passed` true is the correct shape of a Repro Result, and the
    // headline has to say that rather than reporting the exit code as a failure.
    assert.match(run.stdout, /## Repro — verification failed, as this Task Kind requires/);
    assert.match(run.stdout, /exit 1, passed \(inverted: the command failing is the success condition\)/);
    assert.match(run.stdout, /npm test -- tests\/token\.test\.ts/);
    assert.match(run.stdout, /### Files changed \(1\)/);
    assert.match(run.stdout, /tests\/token\.test\.ts/);
    // Still a Verifiable Result like any other: nothing is Landed by producing one.
    assert.match(run.stdout, /Nothing has been Landed/);
    assert.match(run.stdout, /never on its own licenses a Landing/);
  });

  it("surfaces a passing test as the test being wrong, never the code", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: REPRO_TEST,
      payload: reproPayload({
        summary: "Wrote the test, and it passes — the boundary is already handled.",
        verification: { command: "npm test -- tests/token.test.ts", exit_code: 0, passed: false },
      }),
    });

    const run = await runRunner(fixture, REPRO);
    // The Delegation ran, produced a diff and a signal, and is rendered: what is wrong is the test,
    // which is a thing the Orchestrator reads rather than a failure of the transport.
    assert.equal(run.code, 0, run.stderr);

    assert.match(run.stdout, /## Repro — the command passed, so the test is wrong/);
    assert.match(run.stdout, /does not fail, so it does not capture the bug/i);
    assert.match(run.stdout, /passing test means the test is wrong and must be fixed/i);
    // The half that stops the repair going the wrong way. Without it, "did not pass" reads as an
    // ordinary red build and the code is what gets edited.
    assert.match(run.stdout, /never that the code needs changing/i);
    assert.match(run.stdout, /Do not change the code to make it fail/i);
    // And it is still not a licence to touch the user's files either way.
    assert.match(run.stdout, /never on its own licenses a Landing/);
  });

  it("reads the inversion from the Task Kind when the Worker forgot to report it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: REPRO_TEST,
      payload: reproPayload({
        verification: { command: "npm test", exit_code: 0, passed: false },
        expected_failure: null,
      }),
    });

    const run = await runRunner(fixture, REPRO);
    assert.equal(run.code, 0, run.stderr);

    // The inversion is a property of Repro, not of the Worker's bookkeeping. A Worker that left the
    // field null would otherwise have its passing test headlined as a success, which is the exact
    // misreading C1 exists to prevent.
    assert.match(run.stdout, /the command passed, so the test is wrong/);
    assert.match(run.stderr, /expected_failure is not true on a repro/);
  });

  it("does not call a test that never ran a passing one", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: REPRO_TEST,
      payload: reproPayload({
        summary: "The test does not reproduce the report: the boundary is handled on this path.",
        verification: { command: "npm test", exit_code: 1, passed: false },
        caveats: ["The suite was already failing on two unrelated cases before I started."],
      }),
    });

    const run = await runRunner(fixture, REPRO);
    assert.equal(run.code, 0, run.stderr);

    // The honest could-not-reproduce path the prompt asks for: `passed` false against a command that
    // did fail, for some other reason. Reporting that as a passing test would contradict the exit
    // code three lines below it and send the reader to rewrite a test that never ran.
    assert.match(run.stdout, /## Repro — the failure is not the one this Task Kind needs/);
    assert.doesNotMatch(run.stdout, /the command passed/);
    assert.match(run.stdout, /may be erroring on its own/);
    // The prohibition is the same either way: whatever went wrong, it is the test that gets fixed.
    assert.match(run.stdout, /The repair is the test, never the code/);
  });

  it("runs against the uncommitted code the bug is usually in", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: REPRO_TEST, payload: reproPayload() });

    // D5, and the reason Repro needs it most: the reported bug lives in work that is not committed.
    writeFileSync(path.join(fixture.repo, "token.ts"), "export const expired = (at) => at < now();\n");
    writeFileSync(path.join(fixture.repo, "README.md"), "# fixture\n\nuncommitted\n");

    const run = await runRunner(fixture, REPRO);
    assert.equal(run.code, 0, run.stderr);

    const workspace = flagValue(fixture.invocation().args, "-C");
    assert.equal(
      readFileSync(path.join(workspace, "token.ts"), "utf8"),
      "export const expired = (at) => at < now();\n",
      "the Worker was given a Workspace without the untracked code the bug is in",
    );
    assert.equal(readFileSync(path.join(workspace, "README.md"), "utf8"), "# fixture\n\nuncommitted\n");
  });
});

describe("the Migration Delegation", () => {
  it("renders a broad change and the suite that establishes it", async (t) => {
    const fixture = await createFixtureRepo(t);
    const sites = Object.fromEntries(
      ["a", "b", "c"].map((name) => [`src/${name}.ts`, `expect(${name}).toBe(true);\n`]),
    );
    fixture.configureFake({
      writeFiles: sites,
      payload: verifiablePayload({
        summary: "Converted every `assert.ok` site found by `rg 'assert\\.ok' src` — 3 of 3.",
        files_changed: Object.keys(sites),
        diff_stat: { files: 3, insertions: 3, deletions: 3 },
        verification: { command: "npm run build && npm test", exit_code: 0, passed: true },
        caveats: ["`src/legacy.ts` was left alone: it asserts on a type the new form cannot express."],
      }),
    });

    const run = await runRunner(fixture, MIGRATE);
    assert.equal(run.code, 0, run.stderr);

    assert.match(run.stdout, /## Migration — verification passed/);
    assert.match(run.stdout, /exit 0, passed/);
    assert.doesNotMatch(run.stdout, /inverted/, "a Migration's signal is not the inverted one");
    assert.match(run.stdout, /### Files changed \(3\)/);
    assert.match(run.stdout, /src\/legacy\.ts` was left alone/);
    // ADR-0003's sampling half, which is what makes a diff of this shape readable at all.
    assert.match(run.stdout, /read a sample of it/);
    assert.match(run.stdout, /never on its own licenses a Landing/);
  });

  it("does not invert its signal because a Worker filled in Repro's field", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: { "src/a.ts": "export const a = 1;\n" },
      payload: verifiablePayload({
        files_changed: ["src/a.ts"],
        verification: { command: "npm run build", exit_code: 1, passed: false },
        expected_failure: true,
      }),
    });

    const run = await runRunner(fixture, MIGRATE);
    assert.equal(run.code, 0, run.stderr);

    // The inversion belongs to the Task Kind, not to the payload. Read from the field, a Migration
    // whose build failed would be headlined as a success — C1's mistake in the other direction.
    assert.match(run.stdout, /## Migration — verification did not pass/);
    assert.doesNotMatch(run.stdout, /the test is wrong/);
    assert.doesNotMatch(run.stdout, /inverted/);
    assert.match(run.stderr, /expected_failure is true on a migration/);
  });

  it("is held to the Verifiable schema in a workspace-write Workspace, like every Verifiable Kind", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: { "src/a.ts": "export const a = 1;\n" } });

    const run = await runRunner(fixture, MIGRATE);
    assert.equal(run.code, 0, run.stderr);

    const { args } = fixture.invocation();
    assert.equal(path.basename(flagValue(args, "--output-schema")), "verifiable.json");
    assert.equal(flagValue(args, "-s"), "workspace-write");
    // D11: a Verifiable Delegation always starts clean, so its session file is never read.
    assert.ok(args.includes("--ephemeral"), args.join(" "));
  });

  it("refuses a thread, because a Verifiable Delegation never continues one", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, [...MIGRATE, "--thread", "00000000-0000-4000-8000-000000000000"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /--thread is Advisory only/);
  });
});

describe("Repro and Migration reasoning effort", () => {
  for (const [kind, args] of [["repro", REPRO], ["migration", MIGRATE]]) {
    it(`runs ${kind} at low effort and passes no model`, async (t) => {
      const fixture = await createFixtureRepo(t);
      fixture.configureFake({ writeFiles: { "a.ts": "export const a = 1;\n" } });

      const run = await runRunner(fixture, args);
      assert.equal(run.code, 0, run.stderr);

      // D16 settled both at `low` on the Delegation Class rather than the Task Kind: a Verifiable
      // Result carries its own Verification Signal, so the iterations buy more than reasoning would.
      const invocation = fixture.invocation();
      assert.deepEqual(invocation.flags.config, ["model_reasoning_effort=low"]);
      // The model is never passed: published names churn, and pinning one overrides the user's own
      // choice silently.
      for (const flag of ["--model", "-m"]) {
        assert.ok(!invocation.args.includes(flag), `${kind} passed ${flag}`);
      }

      const [persisted] = fixture.persistedResults();
      assert.equal(persisted.kind, kind);
      assert.equal(persisted.class, "verifiable");
      assert.equal(persisted.reasoning_effort, "low");
    });

    it(`leaves ${kind}'s effort to the user's own config.toml when they set one`, async (t) => {
      const fixture = await createFixtureRepo(t);
      fixture.configureFake({ writeFiles: { "a.ts": "export const a = 1;\n" } });
      writeFileSync(path.join(fixture.codexHome, "config.toml"), 'model_reasoning_effort = "high"\n');

      const run = await runRunner(fixture, args);
      assert.equal(run.code, 0, run.stderr);

      // `-c` beats `config.toml` in Codex's own precedence, so deferring to the user can only mean
      // not passing the flag at all.
      assert.equal(fixture.invocation().flags.config, undefined, "the table overrode the user");
      assert.match(run.stderr, /leaving model_reasoning_effort to/);
    });
  }
});

describe("both new Task Kinds are routed like Verifiable work", () => {
  it("seeds a Workspace, reconciles what it holds, and fails a Worker that changed nothing", async (t) => {
    const fixture = await createFixtureRepo(t);
    await git(fixture.repo, ["commit", "-q", "--allow-empty", "-m", "second"]);
    // Probe case C, in the Kind whose Result is a test file: the Worker reports the test it wrote,
    // its Verification Signal is the failing one this Kind requires, and the Workspace is empty.
    fixture.configureFake({ payload: reproPayload() });

    const run = await runRunner(fixture, REPRO);

    assert.notEqual(run.code, 0, "a Repro that wrote no test was reported as done");
    assert.doesNotMatch(run.stdout, /## Repro —/);
    assert.match(run.stderr, /the Workspace holds none/);
  });
});
