// Seam 1 — the first Verifiable Delegation, end to end: the Implementation Task Kind, the schema it
// is held to, the reconciliation of what the Worker claimed against what its Workspace holds, and
// the two commands that address a Delegation while it runs.
//
// The failure this file exists for is the one the ticket called the worst shape available: a
// Delegation that reports success, passes its own Verification Signal, and leaves nothing behind,
// with nobody in the chain having lied. Only the Runner's own measurement of the Workspace catches
// it, so that measurement is asserted from both sides.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createFixtureRepo,
  flagValue,
  resultId,
  runRunner,
  verifiablePayload,
  whileRunning,
} from "./helpers/harness.mjs";

const IMPLEMENT = ["delegate", "--kind", "implementation", "--prompt", "make the token check inclusive"];

describe("the Implementation Delegation", () => {
  it("is held to the Verifiable schema and starts clean", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const { args } = fixture.invocation();
    const schema = flagValue(args, "--output-schema");
    assert.equal(path.basename(schema), "verifiable.json");
    // D11: a Verifiable Delegation is never resumed, so the session file would be written and never
    // read by anything.
    assert.ok(args.includes("--ephemeral"), args.join(" "));
    assert.equal(flagValue(args, "-s"), "workspace-write");
  });

  it("does not ask for the Advisory schema or leave an Advisory Delegation ephemeral", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "look"]);
    assert.equal(run.code, 0, run.stderr);

    const { args } = fixture.invocation();
    assert.equal(path.basename(flagValue(args, "--output-schema")), "advisory.json");
    // An Advisory thread is what makes a follow-up cheap (D11), and `--ephemeral` would throw it
    // away every time.
    assert.ok(!args.includes("--ephemeral"), args.join(" "));
  });

  it("renders the branch, the Verification Signal and what actually changed", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: { "src/auth/token.ts": "export const expired = (at) => at <= Date.now();\n" },
      payload: verifiablePayload({
        summary: "Compared the expiry inclusively and covered the boundary.",
        caveats: ["The integration suite was not run."],
      }),
    });

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    assert.match(run.stdout, /## Implementation — verification passed/);
    assert.match(run.stdout, /Compared the expiry inclusively/);
    assert.match(run.stdout, /npm test/);
    assert.match(run.stdout, /exit 0, passed/);
    assert.match(run.stdout, /### Files changed \(1\)/);
    assert.match(run.stdout, /src\/auth\/token\.ts/);
    assert.match(run.stdout, /The integration suite was not run\./);
    // Nothing here is a Landing, and a passing signal is not permission to make one (ADR-0003).
    assert.match(run.stdout, /Nothing has been Landed/);
    assert.match(run.stdout, /never on its own licenses a Landing/);
    // The one thing that makes the diff readable at all, and how much of it to read: in full when
    // small, by sampling when it is uniform and mechanical (ADR-0003). The threshold is the half of
    // that rule a process can enforce; this is the half only the prompt surface can carry.
    assert.match(run.stdout, /git -C .* diff /);
    assert.match(run.stdout, /in full when it is small/);
    assert.match(run.stdout, /read a sample of it/);
    // Where the Landing itself happens, so that it goes through the checks rather than around them.
    assert.match(run.stdout, /runner\.mjs" land implementation-[0-9a-f]{8}/);
  });

  it("announces the Delegation's id before the work rather than after it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: { "a.ts": "export const a = 1;\n" } });

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    // A Verifiable Delegation does not block (D12): the Forwarder is not waiting for this, and the
    // id is what `/delegate:status` and `/delegate:cancel` need in the meantime.
    const started = run.stdout.indexOf("started —");
    const result = run.stdout.indexOf("## Implementation");
    assert.ok(started >= 0, run.stdout);
    assert.ok(started < result, "the id was announced after the Result, which is too late to use it");
    assert.match(run.stdout, /\/delegate:cancel implementation-[0-9a-f]{8}/);
  });

  it("fails the Delegation when the Worker reports files its Workspace does not hold", async (t) => {
    const fixture = await createFixtureRepo(t);
    // Probe case C's shape, and the one the ticket names as the worst available: the writes were
    // reported as successful, the Verification Signal passed, and nothing is there. Nobody lied
    // anywhere in the chain that the exit code or the event stream can see.
    fixture.configureFake({ payload: verifiablePayload() });

    const run = await runRunner(fixture, IMPLEMENT);

    assert.notEqual(run.code, 0, "a Delegation that changed nothing was reported as done");
    assert.doesNotMatch(run.stdout, /## Implementation/);
    assert.match(run.stderr, /the Workspace holds none/);
    // The Result is still persisted: the Budget for it is spent, and the payload the Worker claimed
    // is the evidence of what went wrong.
    const [persisted] = fixture.persistedResults();
    assert.equal(persisted.class, "verifiable");
    assert.deepEqual(persisted.payload.files_changed, ["src/auth/token.ts"]);
  });

  it("fails a Result with no Verification Signal, which is what makes it Verifiable", async (t) => {
    const fixture = await createFixtureRepo(t);
    const { verification, ...withoutSignal } = verifiablePayload();
    fixture.configureFake({
      writeFiles: { "src/auth/token.ts": "export const changed = true;\n" },
      payload: withoutSignal,
    });

    const run = await runRunner(fixture, IMPLEMENT);

    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /verification is missing/);
  });

  it("reports what it measured, not what the Worker claimed, when the two disagree", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: { "measured.ts": "export const measured = true;\n" },
      payload: verifiablePayload({ files_changed: ["measured.ts", "never-touched.ts"] }),
    });

    const run = await runRunner(fixture, IMPLEMENT);

    // Reported rather than refused: the change is real, the Worker's bookkeeping is not, and
    // withholding the Result over the second would spend the Budget for nothing.
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /never-touched\.ts/);
    assert.match(run.stdout, /### Files changed \(1\)/);
    assert.doesNotMatch(run.stdout, /- `never-touched\.ts`/);
  });

  it("persists the Workspace and the tree it was seeded from, for the staleness check at Landing", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: { "a.ts": "export const a = 1;\n" } });

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const [persisted] = fixture.persistedResults();
    assert.equal(persisted.id, resultId(run.stdout));
    assert.equal(persisted.workspace.branch, `delegate/${persisted.id}`);
    assert.ok(existsSync(persisted.workspace.path));
    // D21: a Workspace whose seed no longer matches the working tree it came from is Stale, and its
    // diff can no longer be checked against present reality. This is the half measured at seed time.
    assert.match(persisted.workspace.seed_tree, /^[0-9a-f]{32}$/);
    assert.ok(persisted.workspace.seed_commit, "no commit to read the Worker's diff against");
  });

  it("records the size of the diff, which is what calibration has no other source for", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: { "a.ts": "export const a = 1;\n" },
      payload: verifiablePayload({
        files_changed: ["a.ts"],
        diff_stat: { files: 1, insertions: 30, deletions: 4 },
      }),
    });

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const finished = fixture.ledger().find((entry) => entry.event === "finished");
    assert.equal(finished.outcome, "ok");
    assert.equal(finished.diff_lines, 34);
  });

  it("says when the diff is too large to read, which is the moment the decision goes back", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      writeFiles: { "a.ts": "export const a = 1;\n" },
      payload: verifiablePayload({
        files_changed: ["a.ts"],
        diff_stat: { files: 40, insertions: 900, deletions: 200 },
      }),
    });

    const run = await runRunner(fixture, IMPLEMENT, { env: { DELEGATE_DIFF_MAX_LINES: "400" } });
    assert.equal(run.code, 0, run.stderr);

    // ADR-0003 withholds autonomous Landing when reading the diff costs more than the Delegation
    // saved. The threshold is the user's number, and this is the moment it is knowable.
    assert.match(run.stdout, /1100 lines, past the 400-line threshold/);
    assert.match(run.stdout, /the user's, not yours/);
  });
});

describe("/delegate:status", () => {
  it("lists a Delegation while it runs, and what came of it afterwards", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ sleepMs: 2000, writeFiles: { "a.ts": "export const a = 1;\n" } });

    const delegation = runRunner(fixture, IMPLEMENT);
    const listed = await whileRunning(fixture, () => runRunner(fixture, ["status"]));

    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /1 running/);
    assert.match(listed.stdout, /Running\n\s+implementation-[0-9a-f]{8}\s+implementation/);
    assert.match(listed.stdout, /Workspace .*workspaces\/implementation-[0-9a-f]{8}/);

    const run = await delegation;
    assert.equal(run.code, 0, run.stderr);

    const after = await runRunner(fixture, ["status"]);
    assert.equal(after.code, 0, after.stderr);
    assert.match(after.stdout, /0 running/);
    assert.match(after.stdout, /Recent\n\s+implementation-[0-9a-f]{8}\s+implementation\s+ok in/);
    // The running record is the Runner's, and it does not outlive the Runner.
    assert.deepEqual(fixture.running(), []);
  });

  it("says so when nothing has been delegated", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["status"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /0 running/);
    assert.match(run.stdout, /Nothing has been delegated yet/);
  });
});

describe("/delegate:cancel", () => {
  it("stops a running Delegation and ends it as a cancellation, not as a Result", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ sleepMs: 5000 });

    const delegation = runRunner(fixture, IMPLEMENT);
    const cancelled = await whileRunning(fixture, (entry) =>
      runRunner(fixture, ["cancel", entry.id]),
    );

    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /Asked implementation-[0-9a-f]{8} to stop/);
    // The Budget counts what was asked of the provider, and cancelling does not un-ask it.
    assert.match(cancelled.stdout, /still counts against the Budget/);

    const run = await delegation;
    assert.notEqual(run.code, 0, "a cancelled Delegation reported a Result");
    assert.doesNotMatch(run.stdout, /## Implementation/);
    assert.match(run.stderr, /was cancelled/);

    // It ends like any other failed Delegation: the Ledger is closed, the running record is gone,
    // and a Workspace the Worker wrote nothing into is not left behind.
    const finished = fixture.ledger().find((entry) => entry.event === "finished");
    assert.equal(finished.outcome, "cancelled");
    assert.deepEqual(fixture.running(), []);
    assert.deepEqual(fixture.workspaces(), []);
  });

  it("refuses an id that is not running, and says whether there is a Result instead", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: { "a.ts": "export const a = 1;\n" } });

    const unknown = await runRunner(fixture, ["cancel", "implementation-deadbeef"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no running Delegation/);

    const shaped = await runRunner(fixture, ["cancel", "not-an-id"]);
    assert.equal(shaped.code, 2);

    const finished = await runRunner(fixture, IMPLEMENT);
    assert.equal(finished.code, 0, finished.stderr);
    const late = await runRunner(fixture, ["cancel", resultId(finished.stdout)]);
    assert.equal(late.code, 1);
    assert.match(late.stderr, /already finished/);
    assert.match(late.stderr, /delegate:result/);
  });

  it("sweeps a running record whose Runner is gone rather than signalling a reused pid", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ sleepMs: 30_000 });

    // Killed outright rather than asked to stop, so the Runner never cleaned up after itself.
    const delegation = runRunner(fixture, IMPLEMENT);
    const entry = await whileRunning(fixture, (running) => running);
    process.kill(entry.pid, "SIGKILL");
    await delegation;

    const run = await runRunner(fixture, ["status"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /0 running/);
    assert.match(run.stdout, /ended without recording a Result/);
    assert.deepEqual(fixture.running(), [], "a dead Delegation was left addressable");
  });
});

describe("the persisted Verifiable Result", () => {
  it("is retrievable by id long after the process that produced it exited", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ writeFiles: { "a.ts": "export const a = 1;\n" } });

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const id = resultId(run.stdout);
    const retrieved = await runRunner(fixture, ["result", id]);

    assert.equal(retrieved.code, 0, retrieved.stderr);
    const payload = JSON.parse(retrieved.stdout);
    assert.equal(payload.id, id);
    assert.equal(payload.reasoning_effort, "low");
    assert.equal(
      readFileSync(path.join(payload.workspace.path, "a.ts"), "utf8"),
      "export const a = 1;\n",
    );
  });
});
