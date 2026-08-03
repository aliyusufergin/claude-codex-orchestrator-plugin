// Seam 1 — the bound that makes autonomy safe (ADR-0002): the Delegation Budget, the dedup cache
// and `/delegate:quota`. Both guards live in the Runner, so every assertion here is on the Runner
// driven as a process — what it did to the fake Codex binary, what it wrote to its state
// directory, and what it said when it refused.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { advisoryPayload, createFixtureRepo, git, runRunner } from "./helpers/harness.mjs";

/** The Delegation the dedup tests repeat, with one field changed at a time. */
const REVIEW = ["delegate", "--kind", "review", "--prompt", "review my diff"];

describe("dedup", () => {
  it("serves an identical Delegation from cache instead of invoking Codex again", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload({ summary: "the first answer" }) });

    const first = await runRunner(fixture, REVIEW);
    assert.equal(first.code, 0, first.stderr);

    // The fake is reconfigured so that a second invocation would be visible in stdout as well as
    // in the invocation log: if this text appears, Codex ran.
    fixture.configureFake({ payload: advisoryPayload({ summary: "a second, wasteful answer" }) });
    const second = await runRunner(fixture, REVIEW);

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 1, "the identical Delegation invoked Codex again");
    assert.match(second.stdout, /the first answer/);
    assert.doesNotMatch(second.stdout, /wasteful/);
    // Served from cache is a fact about the answer, so it is reported rather than hidden — and it
    // is reported on stdout, because a Forwarder returns stdout verbatim and reads stderr only
    // when the Runner exits non-zero. On stderr this would reach nobody.
    assert.match(second.stdout, /dedup cache/i);
    assert.match(second.stdout, /out of date/i);
  });

  it("invokes Codex again when only the thread differs", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    await runRunner(fixture, [...REVIEW, "--thread", "thread-one"]);
    assert.equal(fixture.invocations().length, 1);

    // C3: without `thread_id` in the key, a repeated follow-up on a resumed Advisory thread would
    // be served from cache and the thread would never advance.
    const second = await runRunner(fixture, [...REVIEW, "--thread", "thread-two"]);

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 2, "a different thread was served from cache");
  });

  it("invokes Codex again once HEAD has moved", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    await runRunner(fixture, REVIEW);
    assert.equal(fixture.invocations().length, 1);

    writeFileSync(path.join(fixture.repo, "second.txt"), "more\n");
    await git(fixture.repo, ["add", "."]);
    await git(fixture.repo, ["commit", "-m", "second"]);

    const second = await runRunner(fixture, REVIEW);

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 2, "the same prompt at a new HEAD was served from cache");
  });

  it("stops serving from cache once the dedup TTL has passed", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    await runRunner(fixture, REVIEW);
    const second = await runRunner(fixture, REVIEW, { env: { DELEGATE_DEDUP_TTL_MINUTES: "0" } });

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 2, "an expired cache entry was served anyway");
  });

  it("scopes cache entries to one repository while the Budget spans both", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });
    const other = await fixture.addRepo("other-repo");

    await runRunner(fixture, REVIEW);
    const second = await runRunner(fixture, REVIEW, { cwd: other });

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 2, "another repository's Result was served from cache");
    // The Budget is the Worker's provider's, and the provider does not care which repository the
    // Delegation came from.
    const started = fixture.ledger().filter((entry) => entry.event === "started");
    assert.equal(started.length, 2, "the Budget is not counted across repositories");
  });

  it("never serves a Verifiable Result from cache", async (t) => {
    const fixture = await createFixtureRepo(t);
    // The skeleton schema is what a Verifiable Delegation runs against until #9; any payload will
    // do, because this is about what is cached rather than about what came back.
    fixture.configureFake({ payload: { summary: "a branch somewhere" } });

    const first = await runRunner(fixture, ["delegate", "--kind", "implementation", "--prompt", "do it"]);
    assert.equal(first.code, 0, first.stderr);

    // A Verifiable Result names a branch in a Workspace (D11, D22). Serving it again would point
    // the Orchestrator at work that may since have been Landed or swept.
    const second = await runRunner(fixture, ["delegate", "--kind", "implementation", "--prompt", "do it"]);

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 2, "a Verifiable Result was served from cache");
  });

  it("does not spend the Budget on a Delegation served from cache", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    await runRunner(fixture, REVIEW);
    await runRunner(fixture, REVIEW);

    const started = fixture.ledger().filter((entry) => entry.event === "started");
    assert.equal(started.length, 1, "a cache hit spent a Delegation the provider never saw");
  });
});

describe("the Delegation Budget", () => {
  it("refuses when the Budget is exhausted, naming the cause", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    const first = await runRunner(fixture, REVIEW, { env: { DELEGATE_BUDGET_CEILING: "1" } });
    assert.equal(first.code, 0, first.stderr);

    // A different prompt, so the refusal is the Budget's doing and not the dedup cache's.
    const second = await runRunner(
      fixture,
      ["delegate", "--kind", "review", "--prompt", "review the other change"],
      { env: { DELEGATE_BUDGET_CEILING: "1" } },
    );

    assert.equal(second.code, 1, "an exhausted Budget must fail the Delegation, not pass it");
    assert.equal(second.stdout, "", "a refusal must not look like a Result");
    assert.match(second.stderr, /Budget/i);
    // The cause, not just the effect: the count, the ceiling, and where to raise it.
    assert.match(second.stderr, /exhausted/i);
    assert.match(second.stderr, /\/delegate:quota/);
    // Not an exception: a stack trace would mean the Runner crashed rather than refused.
    assert.doesNotMatch(second.stderr, /at .*runner\.mjs:\d+/);
    assert.equal(fixture.invocations().length, 1, "an exhausted Budget still invoked Codex");
  });

  it("counts a Delegation at its start, so one that failed still counts", async (t) => {
    const fixture = await createFixtureRepo(t);
    // A Delegation that runs and fails: the provider was still asked, so the window still holds it.
    fixture.configureFake({ exitCode: 1, writePayload: false });

    const failing = await runRunner(fixture, REVIEW, { env: { DELEGATE_BUDGET_CEILING: "1" } });
    assert.notEqual(failing.code, 0);

    const second = await runRunner(
      fixture,
      ["delegate", "--kind", "review", "--prompt", "another request entirely"],
      { env: { DELEGATE_BUDGET_CEILING: "1" } },
    );

    assert.equal(second.code, 1);
    assert.match(second.stderr, /Budget/i);
    assert.equal(fixture.invocations().length, 1, "a failed Delegation did not count against the Budget");
  });

  it("stops counting Delegations that have aged out of the window", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    const first = await runRunner(fixture, REVIEW, { env: { DELEGATE_BUDGET_CEILING: "1" } });
    assert.equal(first.code, 0, first.stderr);

    // A window that has already closed on the first Delegation — the rolling window is what makes
    // the Budget unreplenishable *within* it and replenished outside it.
    const second = await runRunner(
      fixture,
      ["delegate", "--kind", "review", "--prompt", "a later request"],
      { env: { DELEGATE_BUDGET_CEILING: "1", DELEGATE_BUDGET_WINDOW_HOURS: "0.0000001" } },
    );

    assert.equal(second.code, 0, second.stderr);
    assert.equal(fixture.invocations().length, 2);
  });

  it("records what calibration will need: what ran, how long it took, and how big the diff was", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    const run = await runRunner(fixture, REVIEW);
    assert.equal(run.code, 0, run.stderr);

    const ledger = fixture.ledger();
    const started = ledger.find((entry) => entry.event === "started");
    const finished = ledger.find((entry) => entry.event === "finished");

    assert.ok(started, "no start was recorded");
    assert.equal(started.kind, "review");
    assert.ok(Date.parse(started.at) > 0, `unreadable timestamp: ${started.at}`);

    assert.ok(finished, "no completion was recorded");
    assert.equal(finished.id, started.id, "the two halves of one Delegation do not share an id");
    assert.equal(typeof finished.duration_ms, "number");
    assert.equal(finished.outcome, "ok");
    // Advisory produces no diff. The field is present and null rather than absent, so that
    // calibration can tell "no diff" from "not recorded" once #9 lands the Verifiable path.
    assert.ok(Object.hasOwn(finished, "diff_lines"), "no place for a diff size");
    assert.equal(finished.diff_lines, null);
  });
});

describe("/delegate:quota", () => {
  it("shows the Budget state and the provisional numbers behind it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });
    await runRunner(fixture, REVIEW);

    const run = await runRunner(fixture, ["quota"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /1 of \d+/, run.stdout);
    // Every number the plugin enforces, and the fact that none of them is calibrated yet.
    assert.match(run.stdout, /provisional/i);
    assert.match(run.stdout, /dedup/i);
    assert.match(run.stdout, /diff/i);
  });

  it("raises the ceiling, and the next Delegation runs", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    const first = await runRunner(fixture, REVIEW);
    assert.equal(first.code, 0, first.stderr);

    // Lowered to what is already spent: the next Delegation is refused.
    const lower = await runRunner(fixture, ["quota", "1"]);
    assert.equal(lower.code, 0, lower.stderr);

    const refused = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "one more thing",
    ]);
    assert.equal(refused.code, 1, refused.stderr);

    const raised = await runRunner(fixture, ["quota", "5"]);
    assert.equal(raised.code, 0, raised.stderr);
    assert.match(raised.stdout, /1 of 5/, raised.stdout);

    const allowed = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "one more thing",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(fixture.invocations().length, 2);
  });

  it("does not claim a raise took when the environment overrides it", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["quota", "50"], {
      env: { DELEGATE_BUDGET_CEILING: "3" },
    });

    assert.equal(run.code, 0, run.stderr);
    // Saved is not the same as in force. Telling the user the bound moved when it did not is the
    // one thing this command must never do — it is the only place the bound is negotiable.
    assert.match(run.stderr, /overrides it/i);
    assert.match(run.stdout, /0 of 3/, run.stdout);
    assert.match(run.stdout, /DELEGATE_BUDGET_CEILING/);
  });

  it("shows the Budget when it is invoked with no ceiling at all", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    // How `/delegate:quota` with nothing after it can reach the Runner. Read as a ceiling of zero
    // it would refuse every Delegation from then on — for a command run to *look* at the Budget.
    const run = await runRunner(fixture, ["quota", ""]);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /of 0 Delegations/);

    const after = await runRunner(fixture, REVIEW);
    assert.equal(after.code, 0, after.stderr);
  });

  it("rejects a ceiling that is not a number", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["quota", "lots"]);

    assert.equal(run.code, 2);
    assert.match(run.stderr, /lots/);
  });
});
