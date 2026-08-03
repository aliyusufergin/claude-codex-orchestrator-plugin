// Seam 1 — the Advisory class complete (D11): a reviewer you can talk back to, and the two Task
// Kinds that join Review. Driven as a process against the fake Codex binary.
//
// The transport facts asserted here were measured against codex-cli 0.146.0 and are written up in
// `docs/research/exec-resume-surface.md`. The two that shape every test below: `codex exec resume`
// takes neither `-s` nor `-C`, and a resume it refuses produces nothing at all on stdout.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  REPO_ROOT,
  advisoryPayload,
  createFixtureRepo,
  flagValue,
  resultId,
  runRunner,
} from "./helpers/harness.mjs";

const THREAD = "019fc78b-0000-4000-8000-0123456789ab";

/** The `-c key=value` overrides in the fake's recorded argv. */
function configOverrides(invocation) {
  return invocation.args.filter((arg, index) => invocation.args[index - 1] === "-c");
}

/** The thread id out of a rendered Advisory Result — how a follow-up learns what to resume. */
function renderedThread(stdout) {
  return stdout.match(/Thread `([^`]+)`/)?.[1];
}

describe("resuming an Advisory thread", () => {
  it("carries the thread the Worker opened into the rendering and the Result", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ threadId: THREAD, payload: advisoryPayload() });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "review my diff"]);
    assert.equal(run.code, 0, run.stderr);

    // Without the id in the rendering there is nothing for a follow-up to name, and every
    // follow-up costs a whole fresh Delegation — which is the expense resume exists to avoid.
    assert.equal(renderedThread(run.stdout), THREAD);

    const [record] = fixture.persistedResults();
    assert.equal(record.thread_id, THREAD);
    assert.equal(record.thread, null, "a fresh Delegation resumed nothing");
  });

  it("continues the same thread through `codex exec resume` instead of starting a new one", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ threadId: THREAD, payload: advisoryPayload({ summary: "the first answer" }) });

    const first = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "review my diff"]);
    assert.equal(first.code, 0, first.stderr);
    const thread = renderedThread(first.stdout);

    fixture.configureFake({ payload: advisoryPayload({ summary: "the follow-up answer" }) });
    const followUp = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "why is that finding blocking?",
      "--thread",
      thread,
    ]);
    assert.equal(followUp.code, 0, followUp.stderr);
    assert.match(followUp.stdout, /the follow-up answer/);

    const [, resumed] = fixture.invocations();
    assert.ok(resumed, "the follow-up did not invoke Codex at all");
    assert.equal(resumed.subcommand, "exec resume");
    assert.equal(resumed.thread, thread, "the persisted thread is not what was resumed");
    assert.ok(resumed.prompt.includes("why is that finding blocking?"), resumed.prompt);

    // The Result records the thread it continued as well as the one it ran in — for a resume they
    // are the same, and they differ exactly when a resume was refused.
    const record = fixture.persistedResults().find((entry) => entry.thread !== null);
    assert.equal(record.thread, thread);
    assert.equal(record.thread_id, thread);
  });

  it("keeps the sandbox mode and the working directory on a form that has no flag for either", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });
    const inner = path.join(fixture.repo, "packages", "inner");
    mkdirSync(inner, { recursive: true });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "a follow-up",
      "--thread",
      THREAD,
      "--cwd",
      inner,
    ]);
    assert.equal(run.code, 0, run.stderr);

    const invocation = fixture.invocation();
    // Measured: `codex exec resume` accepts neither `-s` nor `-C`. A Delegation Class that could
    // not carry its sandbox mode onto the resume form would silently hand a Worker whatever mode
    // Codex defaults to, which is the one thing the Class decides.
    assert.equal(flagValue(invocation.args, "-s"), undefined, "-s is not a flag resume accepts");
    assert.equal(flagValue(invocation.args, "-C"), undefined, "-C is not a flag resume accepts");
    assert.ok(
      configOverrides(invocation).includes("sandbox_mode=read-only"),
      configOverrides(invocation).join(" "),
    );
    // With no `-C`, the only way the Worker sees the right tree is the child's own directory.
    assert.equal(invocation.cwd, inner);
  });

  it("still asks for the Task Kind's effort and still names no model on a resume", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "adversarial",
      "--prompt",
      "a follow-up",
      "--thread",
      THREAD,
    ]);
    assert.equal(run.code, 0, run.stderr);

    const invocation = fixture.invocation();
    assert.ok(configOverrides(invocation).includes("model_reasoning_effort=high"));
    assert.equal(flagValue(invocation.args, "-m"), undefined);
    assert.equal(flagValue(invocation.args, "--model"), undefined);
    for (const arg of invocation.args) {
      assert.ok(!/^model=/.test(arg), `a model reached Codex: ${arg}`);
    }
  });

  it("refuses --thread on a Verifiable Delegation rather than dropping it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    // D11: Verifiable Delegations are single-shot. A `--thread` silently ignored would read to the
    // caller as a continued conversation.
    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "implementation",
      "--prompt",
      "carry on",
      "--thread",
      THREAD,
    ]);

    assert.equal(run.code, 2);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /Advisory only/i);
    assert.equal(fixture.invocations().length, 0, "a refused invocation still ran Codex");
  });
});

describe("a resume Codex will not honour", () => {
  it("falls back to a fresh Delegation and says so in the Result", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      refuseResume: true,
      payload: advisoryPayload({ summary: "answered without the earlier conversation" }),
    });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "why is that finding blocking?",
      "--thread",
      THREAD,
    ]);

    // The answer still arrives — a refused resume is a degradation, not a failure.
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /answered without the earlier conversation/);

    // Visible, and on stdout: a Forwarder returns stdout verbatim and reads stderr only when the
    // Runner exits non-zero, so a degradation announced only on stderr would reach nobody.
    assert.match(run.stdout, /could not be resumed/i);
    assert.match(run.stdout, new RegExp(THREAD));

    const [refused, fresh] = fixture.invocations();
    assert.equal(refused.subcommand, "exec resume");
    assert.equal(fresh.subcommand, "exec", "the fallback was not a fresh Delegation");
    assert.equal(fresh.thread, null);

    const [record] = fixture.persistedResults();
    assert.equal(record.thread, THREAD, "the Result does not say what it tried to resume");
    assert.match(record.resume_unavailable, /no rollout found/);
  });

  it("does not spend a second Delegation on the fallback", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ refuseResume: true, payload: advisoryPayload() });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "diagnosis",
      "--prompt",
      "and what about the other test?",
      "--thread",
      THREAD,
    ]);
    assert.equal(run.code, 0, run.stderr);

    // Codex refused the id before the turn began, so the provider was never asked — and the Budget
    // counts what was asked of it.
    const started = fixture.ledger().filter((entry) => entry.event === "started");
    assert.equal(started.length, 1, "a refused resume was counted as a Delegation of its own");

    const finished = fixture.ledger().find((entry) => entry.event === "finished");
    assert.equal(finished.resume_unavailable, true);
    assert.equal(finished.resumed, false);
  });

  it("fails rather than re-running when the thread opened and the run then failed", async (t) => {
    const fixture = await createFixtureRepo(t);
    // A resume that got as far as a turn and then failed is a failed Delegation like any other.
    // Re-running it fresh would spend a second Delegation on the same failure.
    fixture.configureFake({
      events: [
        { type: "thread.started", thread_id: THREAD },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "the model is unavailable" } },
      ],
      writePayload: false,
      exitCode: 1,
    });

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "a follow-up",
      "--thread",
      THREAD,
    ]);

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /the model is unavailable/);
    assert.equal(fixture.invocations().length, 1, "a failed turn was retried as a fresh Delegation");
  });
});

describe("the Advisory Task Kinds", () => {
  const KINDS = {
    review: "medium",
    diagnosis: "high",
    adversarial: "high",
  };

  for (const [kind, level] of Object.entries(KINDS)) {
    it(`sends the ${kind} template at ${level} effort and names no model`, async (t) => {
      const fixture = await createFixtureRepo(t);
      fixture.configureFake({ payload: advisoryPayload() });

      const run = await runRunner(fixture, ["delegate", "--kind", kind, "--prompt", `a ${kind} request`]);
      assert.equal(run.code, 0, run.stderr);

      const invocation = fixture.invocation();
      assert.deepEqual(configOverrides(invocation), [`model_reasoning_effort=${level}`]);
      assert.equal(flagValue(invocation.args, "-m"), undefined);
      assert.equal(flagValue(invocation.args, "--model"), undefined);

      // The template is the Runner's, and the request goes inside it — a Forwarder that carried its
      // own prompt would drift from the schema the Runner enforces.
      const template = readFileSync(path.join(REPO_ROOT, "prompts", `${kind}.md`), "utf8");
      const preamble = template.split("{{REQUEST}}")[0].trim();
      assert.ok(invocation.prompt.includes(preamble), `the ${kind} template did not reach the Worker`);
      assert.ok(invocation.prompt.includes(`a ${kind} request`), "the request did not");

      // Advisory is `read-only` by Class, whichever of the three kinds it is.
      assert.equal(flagValue(invocation.args, "-s"), "read-only");
      assert.equal(
        flagValue(invocation.args, "--output-schema"),
        path.join(REPO_ROOT, "schemas", "advisory.json"),
      );
    });
  }

  it("tells a Diagnosis Worker to fix nothing", async (t) => {
    const template = readFileSync(path.join(REPO_ROOT, "prompts", "diagnosis.md"), "utf8");

    // A Diagnosis that edits the code is not a weaker Diagnosis; it is a Verifiable Delegation
    // running without a Workspace, in a sandbox that will deny half of it.
    assert.match(template, /do not fix anything/i);
    assert.match(template, /hypothes/i);
    assert.match(template, /evidence/i);
  });

  it("tells an Adversarial Worker that agreeing is a weak result", async (t) => {
    const template = readFileSync(path.join(REPO_ROOT, "prompts", "adversarial.md"), "utf8");

    // Its value is disagreement. A template that merely asked for a second opinion would buy a
    // Review at Adversarial's price.
    assert.match(template, /refute/i);
    assert.match(template, /weak result/i);
    assert.match(template, /already/i);
  });

  it("renders each kind under its own heading", async (t) => {
    const fixture = await createFixtureRepo(t);

    for (const kind of Object.keys(KINDS)) {
      fixture.configureFake({ payload: advisoryPayload({ verdict: "concerns" }) });
      const run = await runRunner(fixture, ["delegate", "--kind", kind, "--prompt", `a ${kind} request`]);
      assert.equal(run.code, 0, run.stderr);

      const heading = `${kind[0].toUpperCase()}${kind.slice(1)}`;
      assert.match(run.stdout, new RegExp(`## ${heading} — concerns`), run.stdout);
      assert.ok(resultId(run.stdout)?.startsWith(`${kind}-`), run.stdout);
    }
  });
});
