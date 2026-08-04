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
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

/**
 * The branch every Workspace is on, named after the Delegation so the two are traceable to each
 * other. Exported because a Workspace outlives the session that made it: what collects one later
 * knows the Delegation's id and nothing else, and deriving the branch a second way would be a
 * second place for the naming to drift.
 */
export const workspaceBranch = (id) => `delegate/${id}`;

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

/** Where Workspaces go when the state directory is somewhere Codex's sandbox helper cannot mount over. */
const preferredBase = (stateRoot) => path.join(stateRoot, "workspaces");

/** Where they go when it is not — `$CODEX_HOME`, the one directory a Delegation has already needed. */
const fallbackBase = (codexHome) => path.join(codexHome, "delegate", "workspaces");

/**
 * Every directory a Workspace may be sitting in. Which of the two was chosen is the outcome of a
 * measurement taken in the session that created it, so anything collecting Workspaces afterwards
 * looks in both rather than re-taking a measurement of a machine that may have changed.
 */
export function workspaceLocations({ stateRoot, codexHome }) {
  return [...new Set([preferredBase(stateRoot), fallbackBase(codexHome)])];
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

  const preferred = preferredBase(stateRoot);
  const under = shadowed(preferred);
  if (under === null) return { dir: preferred, warning: null };

  const fallback = fallbackBase(codexHome);
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
  const branch = workspaceBranch(id);
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
 * The repository a Workspace belongs to, asked of the worktree itself.
 *
 * A Workspace outlives the session that created it (D22), and what collects one later may have no
 * record of it at all — a Runner killed outright never persisted a Result naming the repository it
 * came from. The worktree knows: its own `.git` file points at the repository's shared git
 * directory, and the repository is what that sits in. Returns `null` when the question cannot be
 * answered, which is a Workspace nothing can be done to rather than one that is safe to remove.
 */
export function workspaceRepo(dir) {
  try {
    const common = text(
      git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ).trim();
    return common === "" ? null : path.dirname(common);
  } catch {
    return null;
  }
}

/**
 * Whether a branch is still there — asked rather than inferred from whether a delete succeeded.
 *
 * Only one answer means "gone": `--quiet` exiting `1` with nothing on stderr, which is git saying the
 * ref does not resolve. Everything else — a git that could not run, a repository it could not read —
 * is not an answer at all, and an unanswered question about a branch reads as the branch still being
 * there. The cost of that is a collection reported as incomplete when it was not; the cost of the
 * other direction is one reported as complete with the branch still on disk.
 */
function branchExists(repoRoot, branch) {
  const run = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  return !(run.status === 1 && String(run.stderr ?? "") === "");
}

/** Delete one branch and report whether it is gone afterwards, however it got that way. */
function deleteBranch(repoRoot, branch) {
  try {
    git(repoRoot, ["branch", "-D", branch]);
    return true;
  } catch {
    // Already gone, or still checked out in a worktree that is still there. Asking is the only way
    // to tell those apart, and a git that cannot answer at all reads as the branch still being here.
    return !branchExists(repoRoot, branch);
  }
}

/**
 * Every `delegate/…` branch in a repository, with the commit it points at.
 *
 * This is the other half of what a Delegation leaves behind. A Workspace is a worktree *and* a
 * branch, and deleting the directory by hand — which is what a user reaches for when they do not
 * know the plugin made it — leaves the branch with nothing to enumerate it from the state directory.
 * The repository is where it is still visible.
 */
export function delegateBranches(repoRoot) {
  try {
    return text(
      git(repoRoot, [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)",
        "refs/heads/delegate/",
      ]),
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [branch, tip] = line.split("\t");
        return { branch, tip };
      });
  } catch {
    return [];
  }
}

/**
 * Delete a branch whose Workspace directory is gone, clearing the bookkeeping that stands in the
 * way only when all of it is this plugin's.
 *
 * git refuses to delete a branch it still believes is checked out, and it goes on believing that
 * until the record under `.git/worktrees` for the missing directory is pruned. `git worktree prune`
 * is the only thing that clears it and it is repo-wide: it would also drop the record of the user's
 * own worktree on a volume that happens to be unmounted right now. So it runs only when every
 * missing worktree in the repository is one of ours — otherwise the branch is left, and the caller
 * reports that rather than tidying up something it was not asked about.
 */
export function removeStrayBranch({ repoRoot, branch, bases }) {
  if (deleteBranch(repoRoot, branch)) return true;

  let listing;
  try {
    listing = text(git(repoRoot, ["worktree", "list", "--porcelain"]));
  } catch {
    return false;
  }

  const missing = [];
  for (const block of listing.split("\n\n")) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    if (dir === undefined || existsSync(dir)) continue;
    missing.push({ dir, ref: block.match(/^branch (.+)$/m)?.[1] ?? "" });
  }
  const ours = ({ dir, ref }) =>
    ref.startsWith("refs/heads/delegate/") || bases.some((base) => isInside(dir, base));
  if (missing.length === 0 || !missing.every(ours)) return false;

  try {
    git(repoRoot, ["worktree", "prune"]);
  } catch {
    return false;
  }
  return deleteBranch(repoRoot, branch);
}

/**
 * Remove a Workspace and its branch, and report whether anything is left behind.
 *
 * Called for a Workspace with nothing in it, whose Delegation's work is already Landed, or at the
 * user's own request through `/delegate:clean`. Never for one holding unlanded work of its own
 * accord: that work is the Worker's, and D22 leaves it alone.
 *
 * Both steps are attempted whatever the other one did, because they fail independently: a worktree
 * git will not remove leaves a branch it will not delete either, and saying so needs both answers.
 * Nothing here reaches wider than this Workspace — no `prune`, which would clear the bookkeeping of
 * every other worktree in the user's repository whose directory happens to be missing.
 * `removeStrayBranch` is where the case that needs pruning lives, and it looks before it does it.
 *
 * What is returned is what is true afterwards rather than which command exited zero: a Workspace
 * whose directory was already gone is collected, and one whose branch survived is not.
 */
export function removeWorkspace({ repoRoot, path: dir, branch }) {
  try {
    git(repoRoot, ["worktree", "remove", "--force", dir]);
  } catch {
    // Missing, locked, or not a worktree at all. The check below says whether it is still there.
  }

  const branchGone = deleteBranch(repoRoot, branch);
  return !existsSync(dir) && branchGone;
}
