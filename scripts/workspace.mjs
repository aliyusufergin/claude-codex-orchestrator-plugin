// The Workspace — the throwaway `git worktree` a Verifiable Delegation runs in (D4, D5).
//
// Three properties are the whole of what this module exists to guarantee, and each of them is a
// failure the plugin has already paid for once:
//
//   - **The branch point is the session's `HEAD`.** Claude Code's own `isolation: worktree` branches
//     from the default branch, which is why the Runner creates its own (D4). A change built on a
//     branch point the developer is not on is a change against code they are not looking at.
//   - **The seed is the working tree, not `HEAD`.** Committed state, uncommitted changes and
//     untracked, non-ignored files (D5). The Worker sees what the user sees, which Repro requires
//     outright: the bug is usually in code that is not committed yet.
//   - **It does not live under `/tmp`.** Granting `/tmp` hands it to Codex's Linux sandbox helper,
//     which mounts over paths inside it. A worktree there was shadowed by exactly those mounts
//     during the probe: the Worker wrote its file, truthfully reported success, and the file was
//     gone when the run ended (C6, ADR-0004). That failure is invisible from every side.
//
// The user's own working tree is never written to. Everything here reads from it and writes into
// the Workspace, and the one thing that touches the user's repository at all is git's own worktree
// bookkeeping under `.git/worktrees`, which is what a worktree is.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

/** The branch every Workspace is on, named after the Delegation so the two are traceable to each other. */
const branchFor = (id) => `delegate/${id}`;

/**
 * The identity the seed commit is made under. A Workspace is not the user's history, and a seed
 * commit attributed to them would show up in `git log` as work they did. It is also what makes the
 * commit possible at all on a machine with no `user.email` configured.
 */
const SEED_AUTHOR = { name: "delegate", email: "delegate@localhost" };

const SEED_MESSAGE =
  "delegate: the working tree this Delegation was seeded from\n\n" +
  "Not the user's commit. The Runner committed the uncommitted and untracked state of the\n" +
  "working tree this Workspace was branched from, so that the Worker's own change is readable\n" +
  "as a diff against it.";

class WorkspaceError extends Error {}

/** One `git` invocation whose failure is fatal to the Workspace. Returns stdout as a Buffer. */
function git(cwd, args, { input } = {}) {
  const run = spawnSync("git", args, {
    cwd,
    input,
    // Paths and diffs both come through here, and a truncated read would be a silently wrong
    // Workspace rather than an error.
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.error) throw new WorkspaceError(`git ${args[0]} could not run: ${run.error.message}`);
  if (run.status !== 0) {
    const stderr = String(run.stderr ?? "").trim().split("\n").slice(-3).join("; ");
    throw new WorkspaceError(`git ${args.join(" ")} failed (${run.status}): ${stderr}`);
  }
  return run.stdout;
}

const text = (buffer) => buffer.toString("utf8");

/** A NUL-separated git list as an array of paths. */
const zSplit = (buffer) => text(buffer).split("\0").filter((entry) => entry !== "");

/** The path as the filesystem actually spells it, so that a symlinked `/tmp` cannot hide inside it. */
function resolved(target) {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    // A path that does not exist yet still has an answer: the deepest ancestor that does, plus the
    // rest. `/tmp/x/y` under a symlinked `/tmp` has to read as being under `/tmp`.
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolved(parent), path.basename(absolute));
  }
}

/** Whether `target` is `parent` or sits underneath it, both spelled as the filesystem does. */
export function isInside(target, parent) {
  const child = resolved(target);
  const root = resolved(parent);
  return child === root || child.startsWith(root + path.sep);
}

/**
 * Where Workspaces are kept: beside the rest of the plugin's state, unless that is somewhere Codex's
 * sandbox helper may mount over (C6). `$CODEX_HOME` is the fallback, because a Delegation has
 * already failed by the time it is not writable — and if even that is under one of the forbidden
 * roots there is nowhere safe left, so this refuses rather than running a Delegation whose output
 * can vanish without anybody lying about it.
 *
 * Returns the directory plus the diagnostic to print when it is not the first choice.
 */
export function workspaceBase({ stateRoot, codexHome, forbidden }) {
  const shadowed = (dir) => forbidden.find((root) => isInside(dir, root)) ?? null;

  const preferred = path.join(stateRoot, "workspaces");
  const under = shadowed(preferred);
  if (under === null) return { dir: preferred, warning: null };

  const fallback = path.join(codexHome, "delegate", "workspaces");
  const alsoUnder = shadowed(fallback);
  if (alsoUnder !== null) {
    throw new WorkspaceError(
      `there is nowhere to put the Workspace: ${preferred} and ${fallback} are both under` +
        ` ${alsoUnder}, where Codex's sandbox helper mounts over paths — a Worker's writes there can` +
        " be reported as successful and be gone afterwards. Point $DELEGATE_STATE_DIR somewhere else.",
    );
  }
  return {
    dir: fallback,
    warning:
      `the state directory is under ${under}, where Codex's sandbox helper mounts over paths, so` +
      ` the Workspace goes to ${fallback} instead — a worktree there would be shadowed and the` +
      " Worker's writes would disappear without anything reporting a failure",
  };
}

/** Every untracked, non-ignored file in the working tree, copied into the Workspace as it stands. */
function copyUntracked(repoRoot, into) {
  for (const relative of zSplit(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    const from = path.join(repoRoot, relative);
    const to = path.join(into, relative);

    let stats;
    try {
      stats = lstatSync(from);
    } catch {
      // Listed and then gone: the user is still working, and the tree moved under the measurement.
      continue;
    }

    mkdirSync(path.dirname(to), { recursive: true });
    if (stats.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (stats.isFile()) {
      copyFileSync(from, to);
      // The executable bit is part of the file. A seeded script that is no longer executable fails
      // the Worker's own verification for a reason that has nothing to do with its change.
      chmodSync(to, stats.mode & 0o777);
    }
    // Anything else — a socket, a device node, an unreadable submodule directory — is not source.
  }
}

/**
 * Create the Workspace for one Delegation and seed it from the working tree.
 *
 * The seed lands as a commit on the Workspace's own branch rather than as uncommitted state. That
 * costs one commit in the user's object database, on a branch that is ours, and buys the thing the
 * whole Verifiable path rests on: the Worker's change is readable as a diff against a single named
 * commit, by the Worker itself, by the reconciliation that follows the run, and by the Landing that
 * comes later (D21). Left uncommitted, the Worker's diff and the user's own unfinished work would
 * arrive as one indistinguishable pile.
 *
 * Returns the Workspace's path, its branch, and the commit its seed is at — which is `head` exactly
 * when the working tree was clean.
 */
export function createWorkspace({ repoRoot, head, base, id }) {
  const branch = branchFor(id);
  const dir = path.join(base, id);

  mkdirSync(base, { recursive: true });
  // Branched from the session's `HEAD` — the commit, passed explicitly, so that this cannot drift to
  // the default branch or to whatever the repository happens to have checked out (D4).
  git(repoRoot, ["worktree", "add", "--quiet", "-b", branch, dir, head]);

  // Tracked changes, staged and unstaged together, deletions and mode changes included. `--binary`
  // so that a changed image or fixture survives the round trip instead of arriving as a stub.
  const patch = git(repoRoot, ["diff", "--binary", "HEAD"]);
  if (patch.length > 0) {
    git(dir, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
  }
  copyUntracked(repoRoot, dir);

  // `-A` rather than `.`: it is the whole tree that was seeded, deletions included.
  git(dir, ["add", "-A"]);
  const dirty = zSplit(git(dir, ["status", "--porcelain=v1", "-z"])).length > 0;
  if (!dirty) return { path: dir, branch, seedCommit: head };

  git(dir, [
    "-c",
    `user.name=${SEED_AUTHOR.name}`,
    "-c",
    `user.email=${SEED_AUTHOR.email}`,
    "commit",
    // The repository's own hooks live in the shared `.git` and would otherwise run against a commit
    // the user did not make. Signing is skipped for the same reason: this is bookkeeping, not
    // authorship, and a machine that prompts for a key would hang the Delegation.
    "--no-verify",
    "--no-gpg-sign",
    "--quiet",
    "-m",
    SEED_MESSAGE,
  ]);

  return { path: dir, branch, seedCommit: text(git(dir, ["rev-parse", "HEAD"])).trim() };
}

/**
 * What the Worker actually changed in the Workspace, measured against the commit it was seeded at.
 *
 * Committed and uncommitted alike: the prompt asks the Worker to leave its change in the working
 * tree, and a Worker that commits anyway has still done the work. Measuring only one of the two
 * would report an honest Worker's change as nothing at all — which is the exact shape of the
 * failure this measurement exists to catch.
 */
export function workspaceChanges(dir, sinceCommit) {
  const tracked = zSplit(git(dir, ["diff", "--name-only", "-z", sinceCommit]));
  const untracked = zSplit(git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * The whole of what a Workspace holds against its seed, as one patch plus the size of it — the two
 * things a Landing needs (D21). The size is the Runner's own measurement rather than the Worker's
 * `diff_stat` claim, because it is what the threshold is enforced against and what the Ledger
 * records for O3's calibration.
 *
 * Committed and uncommitted alike, untracked files included, for the reason `workspaceChanges` gives:
 * the prompt asks the Worker to leave its change in the working tree and a Worker that commits anyway
 * has still done the work. Getting the untracked half into a diff at all means staging it, which is
 * the one write this makes — to the Workspace's own index, never to the user's, and it changes no
 * content on either side.
 *
 * A binary file has no line count, so it is counted as a file and as no lines. Reporting it is the
 * caller's job: a Landing whose size reads as small because half of it is images is exactly the case
 * the threshold exists to catch.
 */
export function workspaceDiff(dir, sinceCommit) {
  git(dir, ["add", "-A"]);

  // `--no-renames` keeps every record one path, which is what both halves of this want: a rename is
  // a deletion and an addition to a patch and to a line count alike.
  const files = [];
  let lines = 0;
  let binary = 0;
  for (const record of zSplit(
    git(dir, ["diff", "--cached", "--numstat", "-z", "--no-renames", sinceCommit]),
  )) {
    const [added, deleted, file] = record.split("\t");
    if (file === undefined) continue;
    files.push(file);
    // `-` in either column is git saying the file is binary, not zero lines changed.
    if (added === "-" || deleted === "-") binary += 1;
    else lines += Number(added) + Number(deleted);
  }

  return {
    patch: git(dir, ["diff", "--cached", "--binary", "--no-renames", sinceCommit]),
    files: files.sort(),
    lines,
    binary,
  };
}

/**
 * Apply a Workspace's patch to the user's working tree — the one moment in this plugin that writes
 * there at all, and the reason every other path in this module is read-only on the user's side.
 *
 * Working tree only: no `--index`, so nothing is staged and nothing is committed. What Lands arrives
 * as the user's own uncommitted change, which is the state they can read with `git diff` and undo
 * without consulting the plugin.
 *
 * `git apply` is all-or-nothing without `--reject`, so a patch that no longer fits leaves the tree
 * exactly as it was and the caller reports a failure rather than a half-Landing.
 */
export function applyPatch({ repoRoot, patch }) {
  git(repoRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
}

/**
 * Remove a Workspace and its branch. Only ever called for a Workspace with nothing in it: a Worker's
 * unlanded work is the user's, not the plugin's litter to sweep (D22). Best-effort — a Workspace
 * that cannot be removed is untidy, and failing a Delegation over it would be worse.
 */
export function removeWorkspace({ repoRoot, path: dir, branch }) {
  try {
    git(repoRoot, ["worktree", "remove", "--force", dir]);
    git(repoRoot, ["branch", "-D", branch]);
    return true;
  } catch {
    return false;
  }
}
