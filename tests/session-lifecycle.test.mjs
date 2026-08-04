// Seam 1 — what a Delegation leaves behind when the session that started it ends (D22).
//
// The rule this file exists to hold is a narrow one, and it is narrow in both directions. The plugin
// collects what it left behind: a Workspace whose diff has already Landed is a copy of what the user
// already has, and a Workspace nothing was ever written into is a worktree and a branch left behind
// by a Runner that died. Both go at session end. What it does not collect is anybody else's: an
// unlanded branch is a Worker's work, and a running Delegation is work in progress whose Budget is
// already spent. Both survive, and the second survives with the process still writing into it.
//
// The one thing that collects unlanded work is the user asking for it — `/delegate:clean`.

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createFixtureRepo,
  git,
  gitStdout,
  resultId,
  runRunner,
} from "./helpers/harness.mjs";

const IMPLEMENT = ["delegate", "--kind", "implementation", "--prompt", "make the token check inclusive"];

/** A finished Implementation Delegation whose Worker wrote `files`, and its id. */
async function delegated(fixture, files) {
  fixture.configureFake({ writeFiles: files });
  const run = await runRunner(fixture, IMPLEMENT);
  assert.equal(run.code, 0, run.stderr);
  return resultId(run.stdout);
}

/** Every Workspace branch the repository still has, one per line and sorted as git sorts refs. */
const branches = (fixture) =>
  gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/delegate"]);

/**
 * Wait for a Delegation other than the ones already known to announce itself.
 *
 * Not `whileRunning`: a Runner killed outright leaves its running record behind — that is the whole
 * shape of the case — so "the first record on disk" stops meaning "the one that just started" as
 * soon as this file has killed one.
 */
async function startedDelegation(fixture, known) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const entry = fixture.running().find((candidate) => !known.has(candidate.id));
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no new Delegation was ever recorded as running");
}

/** Start a Delegation that runs long enough to still be going while something else is measured. */
function delegationInFlight(fixture, files) {
  fixture.configureFake({ sleepMs: 3000, writeFiles: files });
  return runRunner(fixture, IMPLEMENT);
}

describe("the sweep at session end", () => {
  it("collects a Landed Workspace and an untouched one, and leaves a running and an unlanded one", async (t) => {
    const fixture = await createFixtureRepo(t);

    // Finished and Landed: its diff is in the user's working tree, so the Workspace holds a second
    // copy of what they already have.
    const landedId = await delegated(fixture, { "landed.ts": "export const landed = 1;\n" });
    const landing = await runRunner(fixture, ["land", landedId]);
    assert.equal(landing.code, 0, landing.stderr);

    // Finished and not Landed: the Worker's work, and nothing but the user says when it goes.
    const unlandedId = await delegated(fixture, { "unlanded.ts": "export const unlanded = 1;\n" });

    // Still running: its Budget is spent, its Worker is writing into that Workspace right now, and
    // its Result is retrievable next session.
    const inFlight = delegationInFlight(fixture, { "running.ts": "export const running = 1;\n" });
    const runningEntry = await startedDelegation(fixture, new Set([landedId, unlandedId]));

    // Untouched: a Runner killed outright before its Worker wrote anything, which is how a Workspace
    // with nothing in it survives to session end at all — the Runner's own disposal never ran, and
    // it never persisted a Result either, so the only thing that knows what this was is the Ledger.
    //
    // Last of the four, and the fake is configured to write nothing for the rest of the test: the
    // Worker of a Runner that was killed outlives it, so it reads the fake's configuration whenever
    // it happens to start, and a later one would have it writing into this Workspace after the fact.
    fixture.configureFake({ sleepMs: 5000 });
    const killed = runRunner(fixture, IMPLEMENT);
    const killedEntry = await startedDelegation(
      fixture,
      new Set([landedId, unlandedId, runningEntry.id]),
    );
    process.kill(killedEntry.pid, "SIGKILL");
    await killed;

    const swept = await runRunner(fixture, ["sweep"]);
    assert.equal(swept.code, 0, swept.stderr);

    assert.deepEqual(fixture.workspaces(), [unlandedId, runningEntry.id].sort(), swept.stdout);
    assert.equal(
      await branches(fixture),
      [`delegate/${unlandedId}`, `delegate/${runningEntry.id}`].sort().join("\n"),
    );
    assert.match(swept.stdout, /Collected 2 Workspace\(s\) at session end; 2 left in place\./);
    assert.match(swept.stdout, new RegExp(`${landedId}  its diff Landed at`));
    assert.match(swept.stdout, new RegExp(`${killedEntry.id}  nothing was ever written into it`));
    assert.match(swept.stdout, new RegExp(`${runningEntry.id}  its Delegation is still running`));
    assert.match(swept.stdout, new RegExp(`${unlandedId}  it holds 1 changed file\\(s\\)`));
    assert.match(swept.stdout, /\/delegate:clean/);

    // What Landed stays Landed — the collection took the copy, not the change.
    assert.ok(existsSync(path.join(fixture.repo, "landed.ts")));
    // And the Result of a collected Delegation is still on disk: the Workspace went, the record of
    // what was delegated did not.
    assert.ok(fixture.persistedResults().some((result) => result.id === landedId));

    await runRunner(fixture, ["cancel", runningEntry.id]);
    await inFlight;
  });

  it("keeps a Workspace nothing can measure, and `/delegate:clean` is what collects it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ sleepMs: 5000 });
    const killed = runRunner(fixture, IMPLEMENT);
    const entry = await startedDelegation(fixture, new Set());
    process.kill(entry.pid, "SIGKILL");
    await killed;

    // A Ledger with no record of the commit the Workspace was seeded at — which is every Workspace
    // made before that record existed, and the same shape as a worktree that cannot be read now.
    // Whether it holds work is unanswerable, so the sweep keeps it.
    const ledger = path.join(fixture.stateDir, "ledger.jsonl");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const { seed_commit: seed, ...rest } = JSON.parse(line);
          return `${JSON.stringify(rest)}\n`;
        })
        .join(""),
    );

    const swept = await runRunner(fixture, ["sweep"]);
    assert.equal(swept.code, 0, swept.stderr);
    assert.deepEqual(fixture.workspaces(), [entry.id], swept.stdout);
    assert.match(swept.stdout, /cannot be measured/);

    // The user asking is the authority the measurement could not supply — and without this half, a
    // Workspace nothing can measure would be uncollectable by anything the plugin ships.
    const cleaned = await runRunner(fixture, ["clean"]);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    assert.deepEqual(fixture.workspaces(), [], cleaned.stdout);
    assert.equal(await branches(fixture), "");
  });

  it("says so and does nothing when there is no Workspace at all", async (t) => {
    const fixture = await createFixtureRepo(t);

    const swept = await runRunner(fixture, ["sweep"]);
    assert.equal(swept.code, 0, swept.stderr);
    assert.match(swept.stdout, /No Workspace to collect/);
  });

  it("is not a subcommand that takes arguments", async (t) => {
    const fixture = await createFixtureRepo(t);

    const wrong = await runRunner(fixture, ["sweep", "everything"]);
    assert.equal(wrong.code, 2);
  });
});

describe("/delegate:clean", () => {
  it("collects an unlanded Workspace and its branch, and still leaves a running one alone", async (t) => {
    const fixture = await createFixtureRepo(t);
    const unlandedId = await delegated(fixture, { "unlanded.ts": "export const unlanded = 1;\n" });

    const inFlight = delegationInFlight(fixture, { "running.ts": "export const running = 1;\n" });
    const runningEntry = await startedDelegation(fixture, new Set([unlandedId]));

    const cleaned = await runRunner(fixture, ["clean"]);
    assert.equal(cleaned.code, 0, cleaned.stderr);

    assert.deepEqual(fixture.workspaces(), [runningEntry.id]);
    assert.equal(await branches(fixture), `delegate/${runningEntry.id}`);
    assert.match(cleaned.stdout, /Collected 1 Workspace\(s\) and their branches; 1 left in place\./);
    assert.match(cleaned.stdout, new RegExp(`${unlandedId}  it holds 1 changed file\\(s\\)`));
    assert.match(cleaned.stdout, /A running Delegation keeps its Workspace/);
    // Nothing of the collected Workspace reached the user's tree: `/delegate:clean` collects, and
    // Landing is the only thing in this plugin that writes there.
    assert.ok(!existsSync(path.join(fixture.repo, "unlanded.ts")));

    // The Result outlives the diff it pointed at, and says what the Delegation was.
    const persisted = await runRunner(fixture, ["result", unlandedId]);
    assert.equal(persisted.code, 0, persisted.stderr);
    assert.equal(JSON.parse(persisted.stdout).id, unlandedId);

    await runRunner(fixture, ["cancel", runningEntry.id]);
    await inFlight;
  });
});

describe("a branch left without its Workspace", () => {
  /** The Workspace directory of a finished Delegation, as the user would find it to delete it. */
  const workspaceOf = (fixture, id) => path.join(fixture.stateDir, "workspaces", id);

  it("is collected at session end when the Worker committed nothing to it", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, { "a.ts": "export const a = 1;\n" });
    // A branch of the plugin's shape that is not a Delegation id: the user's own, and not this
    // plugin's to touch however much it looks like one.
    await git(fixture.repo, ["branch", "delegate/not-an-id"]);

    // The user deleted the worktree by hand, which is what somebody who does not know the plugin
    // made it reaches for. Whatever the Worker wrote went with the directory — the prompt asks it to
    // leave its change in the working tree — so the branch is at the commit it was seeded at and
    // holds nothing but a snapshot of the user's own tree.
    rmSync(workspaceOf(fixture, id), { recursive: true, force: true });

    const swept = await runRunner(fixture, ["sweep"]);
    assert.equal(swept.code, 0, swept.stderr);
    assert.match(swept.stdout, new RegExp(`${id}  its Workspace is gone`));
    assert.equal(await branches(fixture), "delegate/not-an-id", swept.stdout);
  });

  it("survives until the user asks when the Worker committed to it", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, { "a.ts": "export const a = 1;\n" });

    // A Worker that committed anyway has still done the work, and the branch is where it is.
    const workspace = workspaceOf(fixture, id);
    await git(workspace, ["add", "-A"]);
    await git(workspace, ["commit", "-m", "the Worker committed its change"]);
    rmSync(workspace, { recursive: true, force: true });

    const swept = await runRunner(fixture, ["sweep"]);
    assert.equal(swept.code, 0, swept.stderr);
    assert.equal(await branches(fixture), `delegate/${id}`, swept.stdout);
    assert.match(swept.stdout, /holds commits the Worker made/);

    const cleaned = await runRunner(fixture, ["clean"]);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    assert.equal(await branches(fixture), "", cleaned.stdout);
  });
});

describe("a Result from a previous session", () => {
  it("is readable by a later `result <id>` invocation, long after the Runner that wrote it exited", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "look at the uncommitted diff",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const id = resultId(run.stdout);

    // That Runner process is gone. Nothing of this Delegation survives in memory anywhere, and a
    // second process is as far from the first as the next session is.
    const later = await runRunner(fixture, ["result", id]);
    assert.equal(later.code, 0, later.stderr);

    const persisted = JSON.parse(later.stdout);
    assert.equal(persisted.id, id);
    assert.equal(persisted.request, "look at the uncommitted diff");
    assert.equal(persisted.payload.summary, "ok");
  });
});
