// Seam 1 — the Workspace, driven through the Runner CLI as a process. Every assertion is on the
// filesystem: what the Workspace holds, what the user's repository still holds, and where git says
// the branch came from.
//
// The three properties here are the ones a Verifiable Delegation is worthless without. A Workspace
// branched from the wrong commit produces a change against code the developer is not looking at; a
// Workspace seeded from `HEAD` hides every bug that lives in uncommitted work; and a Workspace under
// `/tmp` is mounted over by Codex's own sandbox helper, so the Worker's writes are reported as
// successful and are gone afterwards. None of the three fails loudly on its own.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createFixtureRepo, flagValue, git, gitStdout, runRunner } from "./helpers/harness.mjs";

const IMPLEMENT = ["delegate", "--kind", "implementation", "--prompt", "make it so"];

/** Every file in the working tree, by content — git's own bookkeeping excluded. */
function snapshot(dir, prefix = "") {
  const files = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, snapshot(full, relative));
    else files[relative] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return files;
}

/** The one Workspace a single Delegation created, as an absolute path. */
function soleWorkspace(fixture) {
  const dirs = fixture.workspaces();
  assert.equal(dirs.length, 1, `expected one Workspace, got ${dirs.join(", ") || "none"}`);
  return path.join(fixture.stateDir, "workspaces", dirs[0]);
}

describe("the Workspace", () => {
  it("is a git worktree the Runner owns, and the Worker is put down inside it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const workspace = soleWorkspace(fixture);
    // A worktree, not a copy: `.git` here is a file pointing back at the user's repository.
    assert.ok(existsSync(path.join(workspace, ".git")), "the Workspace is not a git worktree");
    assert.equal(
      await gitStdout(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
      `delegate/${path.basename(workspace)}`,
      "the Workspace is not on its own branch",
    );
    // The Worker runs in the Workspace and never sees the user's working tree.
    assert.equal(flagValue(fixture.invocation().args, "-C"), workspace);
  });

  it("branches from the session HEAD, not from the default branch", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    // The session is on a branch that is ahead of `main`. Claude Code's own `isolation: worktree`
    // would branch from the default branch, which is why the Runner creates its own (D4).
    await git(fixture.repo, ["checkout", "-q", "-b", "side"]);
    writeFileSync(path.join(fixture.repo, "side.txt"), "on the side branch\n");
    await git(fixture.repo, ["add", "."]);
    await git(fixture.repo, ["commit", "-q", "-m", "a commit only this branch has"]);

    const head = await gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
    const main = await gitStdout(fixture.repo, ["rev-parse", "main"]);
    assert.notEqual(head, main, "the fixture did not diverge from the default branch");

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const workspace = soleWorkspace(fixture);
    // The tree was clean, so the branch is exactly at the session's `HEAD`.
    assert.equal(await gitStdout(workspace, ["rev-parse", "HEAD"]), head);
    assert.equal(readFileSync(path.join(workspace, "side.txt"), "utf8"), "on the side branch\n");
  });

  it("is seeded from the working tree: uncommitted changes and untracked, non-ignored files", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    writeFileSync(path.join(fixture.repo, ".gitignore"), "*.log\n");
    await git(fixture.repo, ["add", ".gitignore"]);
    await git(fixture.repo, ["commit", "-q", "-m", "ignore logs"]);

    // Three kinds of state `HEAD` does not describe (D5).
    writeFileSync(path.join(fixture.repo, "README.md"), "# fixture\n\nedited but not committed\n");
    writeFileSync(path.join(fixture.repo, "staged.txt"), "staged, not committed\n");
    await git(fixture.repo, ["add", "staged.txt"]);
    mkdirSync(path.join(fixture.repo, "src"), { recursive: true });
    writeFileSync(path.join(fixture.repo, "src", "untracked.ts"), "export const x = 1;\n");
    writeFileSync(path.join(fixture.repo, "debug.log"), "ignored\n");

    const head = await gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    const workspace = soleWorkspace(fixture);
    assert.equal(
      readFileSync(path.join(workspace, "README.md"), "utf8"),
      "# fixture\n\nedited but not committed\n",
      "an uncommitted change did not reach the Workspace",
    );
    assert.equal(readFileSync(path.join(workspace, "staged.txt"), "utf8"), "staged, not committed\n");
    assert.equal(
      readFileSync(path.join(workspace, "src", "untracked.ts"), "utf8"),
      "export const x = 1;\n",
      "an untracked, non-ignored file did not reach the Workspace",
    );
    // An ignored file is not the user's source and does not travel.
    assert.equal(existsSync(path.join(workspace, "debug.log")), false);

    // The seed is a commit of its own, so that the Worker's change is readable as a diff against
    // one named point — and the branch still starts at the session's `HEAD`.
    assert.equal(await gitStdout(workspace, ["rev-parse", "HEAD~1"]), head);
    assert.equal(await gitStdout(workspace, ["status", "--porcelain"]), "");
  });

  it("never writes to the user's working tree", async (t) => {
    const fixture = await createFixtureRepo(t);
    // A Worker that writes is the whole point of a Verifiable Delegation. None of it may land here.
    fixture.configureFake({
      writeFiles: {
        "src/added-by-the-worker.ts": "export const added = true;\n",
        "README.md": "# rewritten by the worker\n",
      },
    });

    writeFileSync(path.join(fixture.repo, "in-progress.txt"), "the user is still working\n");
    const before = snapshot(fixture.repo);

    const run = await runRunner(fixture, IMPLEMENT);
    assert.equal(run.code, 0, run.stderr);

    assert.deepEqual(snapshot(fixture.repo), before, "a Worker's write reached the user's tree");

    // And the same writes are in the Workspace, where they belong.
    const workspace = soleWorkspace(fixture);
    assert.equal(
      readFileSync(path.join(workspace, "src", "added-by-the-worker.ts"), "utf8"),
      "export const added = true;\n",
    );
    assert.equal(readFileSync(path.join(workspace, "README.md"), "utf8"), "# rewritten by the worker\n");
    // Seeded from the working tree, so the user's uncommitted file is there too.
    assert.equal(readFileSync(path.join(workspace, "in-progress.txt"), "utf8"), "the user is still working\n");
  });

  it("keeps the Workspace out of the directories Codex's sandbox helper mounts over", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    // The state directory under the stand-in for `/tmp`: the trap C6 records, where the worktree is
    // shadowed by the helper's own mounts and the Worker's writes vanish without a failure anywhere.
    const run = await runRunner(fixture, IMPLEMENT, {
      env: { DELEGATE_STATE_DIR: path.join(fixture.tmpProbe, "state") },
    });
    assert.equal(run.code, 0, run.stderr);

    assert.deepEqual(
      readdirSync(fixture.tmpProbe).filter((entry) => entry === "state").length === 0
        ? []
        : readdirSync(path.join(fixture.tmpProbe, "state")).filter((entry) => entry === "workspaces"),
      [],
      "the Workspace was created where the sandbox helper can mount over it",
    );

    const fallback = path.join(fixture.codexHome, "delegate", "workspaces");
    assert.equal(readdirSync(fallback).length, 1, `no Workspace under ${fallback}`);
    // Said out loud: a silently relocated Workspace is a surprise the next `git worktree list` has
    // to explain instead.
    assert.match(run.stderr, /mounts over paths/);
  });

  it("refuses a Verifiable Delegation with no commit to branch from", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const empty = path.join(fixture.root, "unborn");
    mkdirSync(empty);
    await git(empty, ["init", "-b", "main"]);

    const run = await runRunner(fixture, [...IMPLEMENT, "--cwd", empty]);

    assert.equal(run.code, 1);
    assert.match(run.stderr, /commit/);
    assert.equal(
      existsSync(path.join(fixture.fakeDir, "fake-codex-invocation.json")),
      false,
      "a Delegation was spent on a repository with nowhere to put a Workspace",
    );
    assert.deepEqual(fixture.ledger(), [], "the Budget was counted for a Delegation never made");
  });

  it("puts the Worker where the request was made, not at the repository root", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    const inner = path.join(fixture.repo, "packages", "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(inner, "index.ts"), "export const inner = true;\n");

    const run = await runRunner(fixture, [...IMPLEMENT, "--cwd", inner]);
    assert.equal(run.code, 0, run.stderr);

    const workspace = soleWorkspace(fixture);
    assert.equal(
      flagValue(fixture.invocation().args, "-C"),
      path.join(workspace, "packages", "inner"),
      "the Worker was put down somewhere other than the directory the request came from",
    );
  });

  it("removes a Workspace the Worker left nothing in, and keeps one it did not", async (t) => {
    const fixture = await createFixtureRepo(t);
    // A failed Delegation that wrote nothing: the worktree and branch behind it are the plugin's
    // litter, not the user's work (D22).
    fixture.configureFake({ exitCode: 1, writePayload: false });

    const empty = await runRunner(fixture, IMPLEMENT);
    assert.notEqual(empty.code, 0);
    assert.deepEqual(fixture.workspaces(), [], "an empty Workspace was left behind");
    assert.equal(await gitStdout(fixture.repo, ["branch", "--list", "delegate/*"]), "");

    // A failed Delegation that wrote something first: that is half-finished work, and it stays.
    fixture.configureFake({
      exitCode: 1,
      writePayload: false,
      writeFiles: { "half-done.ts": "export const halfDone = true;\n" },
    });

    const partial = await runRunner(fixture, IMPLEMENT);
    assert.notEqual(partial.code, 0);
    const workspace = soleWorkspace(fixture);
    assert.equal(readFileSync(path.join(workspace, "half-done.ts"), "utf8"), "export const halfDone = true;\n");
    assert.match(partial.stderr, /left in place/);
  });
});
