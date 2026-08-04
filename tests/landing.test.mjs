// Seam 1 — Landing under Read-Before-Change (ADR-0003, D21). The one operation in this plugin that
// writes to the user's files, and the two refusals that stand in front of it.
//
// The case this file exists for is the ordinary one rather than the exotic one: the user kept
// working while the Delegation ran. Its Workspace is then **Stale**, its diff can no longer be
// checked against the tree it would land in, and no passing Verification Signal makes that safe. The
// refusal has to be mechanical — detected by measurement, not by asking the Orchestrator to
// remember — and `/delegate:apply` has to still work, or the user loses the Delegation they paid for.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createFixtureRepo,
  git,
  gitStdout,
  resultId,
  runRunner,
  verifiablePayload,
  whileRunning,
} from "./helpers/harness.mjs";

const IMPLEMENT = ["delegate", "--kind", "implementation", "--prompt", "make the token check inclusive"];

/**
 * File content git reads as binary — a NUL byte in the first few thousand, which is the whole of
 * how git decides. Escaped rather than written literally, because a NUL in a source file is
 * invisible to every reader of it and this fixture is nothing but that byte.
 */
const BINARY_ISH = "\u0000PNG\u0000 not really an image\n";

/** A finished Implementation Delegation whose Worker wrote `files`, and its id. */
async function delegated(fixture, files, config = {}) {
  fixture.configureFake({ writeFiles: files, ...config });
  const run = await runRunner(fixture, IMPLEMENT);
  assert.equal(run.code, 0, run.stderr);
  return resultId(run.stdout);
}

const read = (fixture, relative) => readFileSync(path.join(fixture.repo, relative), "utf8");

describe("a Landing after an untouched run", () => {
  it("applies the diff to the user's working tree, staging and committing nothing", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, {
      "src/auth/token.ts": "export const expired = (at) => at <= Date.now();\n",
      "README.md": "# fixture\n\nNow with a boundary check.\n",
    });

    // Nothing has Landed yet: the Result is a branch in a Workspace, and the user's tree is as it
    // was. That is the state a passing Verification Signal does not change on its own.
    assert.ok(!existsSync(path.join(fixture.repo, "src", "auth", "token.ts")));
    assert.equal(read(fixture, "README.md"), "# fixture\n");

    const landed = await runRunner(fixture, ["land", id]);
    assert.equal(landed.code, 0, landed.stderr);

    assert.equal(
      read(fixture, "src/auth/token.ts"),
      "export const expired = (at) => at <= Date.now();\n",
    );
    assert.equal(read(fixture, "README.md"), "# fixture\n\nNow with a boundary check.\n");
    assert.match(landed.stdout, new RegExp(`Landed \`${id}\``));
    assert.match(landed.stdout, /### Files landed \(2\)/);

    // Unstaged and uncommitted: what Landed is an ordinary working-tree change the user can read
    // with `git diff` and undo without the plugin's help.
    assert.equal(await gitStdout(fixture.repo, ["diff", "--cached", "--name-only"]), "");
    assert.equal(await gitStdout(fixture.repo, ["log", "--oneline", "--format=%s"]), "initial");
  });

  it("records the Landing on the Result, so the same diff cannot be applied twice", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, { "a.ts": "export const a = 1;\n" });

    const first = await runRunner(fixture, ["land", id]);
    assert.equal(first.code, 0, first.stderr);

    const [persisted] = fixture.persistedResults();
    assert.equal(persisted.landed.mode, "autonomous");
    assert.equal(persisted.landed.stale, false);
    assert.deepEqual(persisted.landed.files, ["a.ts"]);

    const second = await runRunner(fixture, ["land", id]);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already Landed/);
  });

  it("records the diff size it measured, not the size the Worker claimed", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(
      fixture,
      { "a.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n" },
      {
        payload: verifiablePayload({
          files_changed: ["a.ts"],
          diff_stat: { files: 40, insertions: 900, deletions: 200 },
        }),
      },
    );

    const landed = await runRunner(fixture, ["land", id]);
    assert.equal(landed.code, 0, landed.stderr);

    // O3's third observation. The Worker's own `diff_stat` is a claim and is recorded as one at the
    // end of the run; this is the Runner's measurement of the diff it actually applied.
    const landing = fixture.ledger().find((entry) => entry.event === "landing");
    assert.equal(landing.outcome, "landed");
    assert.equal(landing.mode, "autonomous");
    assert.equal(landing.diff_lines, 3);
    assert.equal(landing.diff_files, 1);
    assert.equal(fixture.ledger().find((entry) => entry.event === "finished").diff_lines, 1100);
  });
});

describe("a Stale Workspace", () => {
  it("is refused autonomously when the user kept working, and `/delegate:apply` still lands it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      sleepMs: 1500,
      writeFiles: { "src/auth/token.ts": "export const expired = (at) => at <= Date.now();\n" },
    });

    const delegation = runRunner(fixture, IMPLEMENT);
    // The user kept working while the Delegation ran, which is the ordinary case rather than the
    // exceptional one: the tree the Worker was given is no longer the tree its diff would land in.
    await whileRunning(fixture, () =>
      writeFileSync(path.join(fixture.repo, "notes.md"), "thinking out loud\n"),
    );
    const run = await delegation;
    assert.equal(run.code, 0, run.stderr);
    const id = resultId(run.stdout);

    const refused = await runRunner(fixture, ["land", id]);
    assert.equal(refused.code, 1, "a Stale Workspace was Landed autonomously");
    assert.match(refused.stderr, /Stale/);
    assert.match(refused.stderr, /uncommitted working tree has changed/);
    assert.match(refused.stderr, new RegExp(`/delegate:apply ${id}`));
    // Nothing was applied, and the branch is left exactly where it was: the work is the user's, and
    // the refusal is about who decides rather than about whether the change is any good.
    assert.ok(!existsSync(path.join(fixture.repo, "src", "auth", "token.ts")));
    assert.equal(
      await gitStdout(fixture.repo, ["rev-parse", "--verify", `delegate/${id}`]),
      await gitStdout(fixture.repo, ["rev-parse", `delegate/${id}`]),
    );

    const applied = await runRunner(fixture, ["land", id, "--manual"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(
      read(fixture, "src/auth/token.ts"),
      "export const expired = (at) => at <= Date.now();\n",
    );
    // The manual path Lands it and says what it Landed it over. A Landing that did not say so would
    // read exactly like one taken against the tree the Worker saw.
    assert.match(applied.stdout, /Landed a Stale Workspace/);
    assert.equal(fixture.persistedResults()[0].landed.stale, true);
    // The user's own work is untouched by the Landing.
    assert.equal(read(fixture, "notes.md"), "thinking out loud\n");
  });

  it("is Stale when `HEAD` moved, even with the working tree as clean as it was", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, { "a.ts": "export const a = 1;\n" });

    writeFileSync(path.join(fixture.repo, "elsewhere.md"), "committed work\n");
    await git(fixture.repo, ["add", "elsewhere.md"]);
    await git(fixture.repo, ["commit", "-m", "the user kept going"]);

    const refused = await runRunner(fixture, ["land", id]);
    assert.equal(refused.code, 1);
    // The branch point moved, and the tree is clean at both ends — so the digest matches and only
    // the commit says anything. Naming what moved is the whole of the refusal's usefulness.
    assert.match(refused.stderr, /`HEAD` was [0-9a-f]{8} when the Workspace was seeded/);
    assert.doesNotMatch(refused.stderr, /uncommitted working tree has changed/);

    const landing = fixture.ledger().find((entry) => entry.event === "landing");
    assert.equal(landing.outcome, "stale");
    assert.equal(landing.stale, true);
  });

  it("leaves the working tree untouched when the diff no longer applies", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, { "README.md": "# fixture\n\nthe Worker's line\n" });

    writeFileSync(path.join(fixture.repo, "README.md"), "the user's own rewrite\n");

    const refused = await runRunner(fixture, ["land", id, "--manual"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /does not apply/);
    // `git apply` is all-or-nothing, so a Landing that fails halfway is not a state this can reach.
    assert.equal(read(fixture, "README.md"), "the user's own rewrite\n");
    assert.equal(fixture.ledger().find((entry) => entry.event === "landing").outcome, "failed");
  });
});

describe("a diff too large to be worth reading", () => {
  it("goes to the user rather than Landing, and `/delegate:apply` is the way past it", async (t) => {
    const fixture = await createFixtureRepo(t);
    const lines = Array.from({ length: 12 }, (_, at) => `export const v${at} = ${at};`).join("\n");
    const id = await delegated(fixture, { "generated.ts": `${lines}\n` });

    const threshold = { env: { DELEGATE_DIFF_MAX_LINES: "5" } };
    const refused = await runRunner(fixture, ["land", id], threshold);
    assert.equal(refused.code, 1, "a diff past the threshold was Landed without anybody reading it");
    assert.match(refused.stderr, /12 lines across 1 file\(s\), past the 5-line threshold/);
    assert.match(refused.stderr, /Authority returns to the user/);
    assert.ok(!existsSync(path.join(fixture.repo, "generated.ts")));

    const landing = fixture.ledger().find((entry) => entry.event === "landing");
    assert.equal(landing.outcome, "too-large");
    // Measured even on the path that refuses: the sizes that are turned away are exactly the ones
    // O3 needs to calibrate the threshold against.
    assert.equal(landing.diff_lines, 12);

    const applied = await runRunner(fixture, ["land", id, "--manual"], threshold);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(read(fixture, "generated.ts"), `${lines}\n`);
  });

  it("Lands the same diff when the threshold leaves room for it", async (t) => {
    const fixture = await createFixtureRepo(t);
    const id = await delegated(fixture, { "generated.ts": "export const one = 1;\n" });

    const landed = await runRunner(fixture, ["land", id], {
      env: { DELEGATE_DIFF_MAX_LINES: "400" },
    });
    assert.equal(landed.code, 0, landed.stderr);
    assert.equal(read(fixture, "generated.ts"), "export const one = 1;\n");
  });
});

describe("what cannot be Landed at all", () => {
  it("refuses a Delegation that failed, however much its Worker left behind", async (t) => {
    const fixture = await createFixtureRepo(t);
    // Probe case C's neighbour: the Worker wrote something, and the Runner refused the Result — here
    // because the tool router reported an error. The Workspace holds a change either way.
    fixture.configureFake({
      writeFiles: { "half.ts": "export const half = 1;\n" },
      stderr: "ERROR codex_core::tools::router: tool call failed\n",
    });
    const run = await runRunner(fixture, IMPLEMENT);
    assert.notEqual(run.code, 0, "a failed Delegation was rendered as a Result");
    const [persisted] = fixture.persistedResults();

    // D14's first guardrail at the one place it could be walked around: `land` is where "report the
    // failure and stop" would quietly become "Land it anyway". `--manual` does not reach past it —
    // the escape hatch is from a refusal about who decides, not from an unchecked Delegation.
    for (const args of [["land", persisted.id], ["land", persisted.id, "--manual"]]) {
      const refused = await runRunner(fixture, args);
      assert.equal(refused.code, 1, args.join(" "));
      assert.match(refused.stderr, /failed as a Delegation and has no Result to Land/);
    }
    assert.ok(!existsSync(path.join(fixture.repo, "half.ts")));
  });

  it("refuses a Result with no Verification Signal, which is what makes it Verifiable", async (t) => {
    const fixture = await createFixtureRepo(t);
    const { verification, ...withoutSignal } = verifiablePayload({ files_changed: ["a.ts"] });
    fixture.configureFake({
      writeFiles: { "a.ts": "export const a = 1;\n" },
      payload: withoutSignal,
    });
    const run = await runRunner(fixture, IMPLEMENT);
    assert.notEqual(run.code, 0);

    // The Result was persisted before it was checked, because the Budget for it was already spent.
    // What is on disk is therefore a Workspace full of changes beside a payload that is not a
    // Verifiable Result — and Landing it would be Landing a diff nothing ever signalled about.
    const [persisted] = fixture.persistedResults();
    const refused = await runRunner(fixture, ["land", persisted.id]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not a usable Verifiable Result/);
    assert.match(refused.stderr, /verification is missing/);
  });

  it("hands a binary diff to the user, because a line count says nothing about one", async (t) => {
    const fixture = await createFixtureRepo(t);
    // Two nulls make git call it binary. It counts as no lines, so a line threshold waves it through
    // however large it is — and it cannot be read, which is what the autonomous path acts on.
    const id = await delegated(fixture, { "logo.png": BINARY_ISH });

    const refused = await runRunner(fixture, ["land", id]);
    assert.equal(refused.code, 1, "a diff nobody can read was Landed autonomously");
    assert.match(refused.stderr, /1 binary file\(s\), which cannot be read/);
    assert.equal(fixture.ledger().find((entry) => entry.event === "landing").outcome, "unreadable");
    assert.ok(!existsSync(path.join(fixture.repo, "logo.png")));

    const applied = await runRunner(fixture, ["land", id, "--manual"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /Binary files: 1/);
  });


  it("refuses an Advisory Result, which is prose rather than a diff", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "look"]);
    assert.equal(run.code, 0, run.stderr);

    const refused = await runRunner(fixture, ["land", resultId(run.stdout)]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /no diff to Land/);
    // The Advisory path has its own rule, and it is not this one.
    assert.match(refused.stderr, /evidence/);
  });

  it("refuses an id it has no Result for, and an argument that is not an id", async (t) => {
    const fixture = await createFixtureRepo(t);

    const unknown = await runRunner(fixture, ["land", "implementation-deadbeef"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no Result with id/);

    const shaped = await runRunner(fixture, ["land", "not-an-id"]);
    assert.equal(shaped.code, 2);
  });
});
