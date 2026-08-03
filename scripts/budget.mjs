// The Delegation Budget and the dedup cache — the two guards ADR-0002 puts *below* the
// Orchestrator, so that no amount of enthusiasm upstream can spend past them. Both are state on
// disk and enforcement in the Runner; neither appears in an agent or a command prompt, because a
// bound a model is asked to respect is a suggestion.
//
// The two have different scopes, and the difference is not cosmetic:
//
//   - **The Budget is provider-wide.** It counts against the same rolling window the Worker's own
//     provider enforces, and the provider does not care which repository a Delegation came from.
//     So the ledger lives at the root of the state directory, outside any one repository.
//   - **The cache is repo-scoped.** An identical prompt at an identical `HEAD` in a different
//     repository is a different question. Entries are partitioned by the repository they were
//     asked in — and still kept outside it, because a Worker's Result is not the user's source.
//
// The Ledger is append-only JSONL, and nothing here ever rewrites it — it is bounded by rotation,
// not by compaction. That is what makes counting at Delegation start safe under concurrency
// without a lock: each record is one small `O_APPEND` write, and no writer ever moves ground out
// from under another. Two Delegations starting in the same instant can both read a count below the
// ceiling and both start — the bound is one-over at worst, and the alternative is a lock file that
// outlives a killed Runner and refuses everything after it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const LEDGER_FILE = "ledger.jsonl";
/** The one generation of history kept behind the live ledger. Read alongside it, never written. */
const LEDGER_ARCHIVE = "ledger.1.jsonl";
const CACHE_DIR = "dedup";

/** Beyond this the ledger is rotated on the next append. Roughly ten thousand Delegations. */
const LEDGER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How long a cache entry is kept on disk, whatever the TTL in force. Pruning against the current
 * TTL instead would let one run with a lowered `DELEGATE_DEDUP_TTL_MINUTES` delete every entry the
 * next run at the default would have used.
 */
const CACHE_RETENTION_MINUTES = 24 * 60;

/** Enough of a hash to make a collision less likely than a disk error. */
const KEY_CHARS = 32;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function ledgerFile(stateRoot) {
  return path.join(stateRoot, LEDGER_FILE);
}

/** One `git` invocation, for the Runner's own use. Returns its whole stdout, or null. */
function git(cwd, args) {
  // The default `maxBuffer` is 1 MB and a truncated read here would silently change a digest.
  // Nothing this module runs git for produces more than a list of paths and hashes, so the cap is
  // generous rather than tuned.
  const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 || typeof run.stdout !== "string") return null;
  return run.stdout;
}

/** One `git` invocation whose answer is a single line. Returns that line, or null. */
function gitLine(cwd, args) {
  const line = git(cwd, args)?.split("\n")[0].trim();
  return line === undefined || line === "" ? null : line;
}

/**
 * Which repository a Delegation is in and what it is looking at: the toplevel that scopes the
 * cache, and the `HEAD` that goes into the key.
 *
 * A directory that is not a git repository is still a place work can be delegated from, so it
 * scopes the cache by its own path and carries no `HEAD` — which makes every Delegation there
 * distinguishable only by prompt and thread, and the TTL the only thing that expires it.
 */
export function repoIdentity(cwd) {
  const root = gitLine(cwd, ["rev-parse", "--show-toplevel"]) ?? path.resolve(cwd);
  const head = gitLine(cwd, ["rev-parse", "HEAD"]);
  // The directory name is carried into the slug so that a state directory is readable by a human
  // debugging it; the hash is what actually distinguishes two repositories with the same basename.
  const name = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32) || "repo";
  return { root, head, slug: `${name}-${sha256(root).slice(0, 12)}` };
}

/** How many paths one `git hash-object` invocation is asked about, so that argv stays under ARG_MAX. */
const HASH_BATCH = 256;

/**
 * A content-exact measurement of everything in the working tree that `HEAD` does not describe:
 * staged and unstaged changes to tracked files, deletions, and untracked, non-ignored files.
 *
 * This exists because `HEAD` alone is a bad answer to "is this the same tree?", and reviewing an
 * *uncommitted* diff is the plugin's first use. Two Delegations at the same commit with different
 * uncommitted work in them are different questions, and before this they hashed the same.
 *
 * Read-only by construction. Paths and status codes come from `git status`, and content comes from
 * `git hash-object` *without* `-w` — so nothing is written to the user's index, working tree or
 * object database to answer a question about a cache key. The alternative, seeding a temporary
 * index and calling `git write-tree`, is shorter and writes blobs into the user's repository for
 * bookkeeping that is none of its business.
 *
 * Returns `null` when the measurement could not be taken at all — not a repository, or a `git` that
 * failed. A null is not a clean tree: a clean tree has a digest like any other, and the caller has
 * to be able to tell "nothing has changed" from "nothing was measured".
 */
export function uncommittedDigest(cwd) {
  const root = gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return null;

  // `--porcelain=v1 -z` is the stable, unquoted, repo-root-relative form. `--no-renames` keeps every
  // entry one path, which is all this needs — a rename is a deletion and an addition to a digest.
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  if (status === null) return null;

  // `XY PATH`, NUL-terminated. The code matters as well as the path: a file deleted and a file
  // emptied both have no content to hash, and they are not the same working tree.
  const entries = status
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));

  // Only a regular file has content to hash. A deleted path, a broken symlink and a dirty submodule
  // are all recorded by their status code and path alone — asking `git hash-object` for any of them
  // would fail the whole measurement over an entry the status line already describes.
  const readable = entries.filter((entry) => {
    try {
      return statSync(path.join(root, entry.path)).isFile();
    } catch {
      return false;
    }
  });
  const contents = [];
  for (let at = 0; at < readable.length; at += HASH_BATCH) {
    const batch = readable.slice(at, at + HASH_BATCH);
    // No `-w`: this hashes and prints, and writes nothing.
    const hashed = git(root, ["hash-object", "--", ...batch.map((entry) => entry.path)]);
    if (hashed === null) return null;
    const lines = hashed.split("\n").filter((line) => line.trim() !== "");
    // One hash per path or the pairing is wrong, and a wrong pairing is a digest that is stable
    // across two different trees — the one failure this helper exists to prevent.
    if (lines.length !== batch.length) return null;
    batch.forEach((entry, index) => contents.push([entry.path, lines[index]]));
  }

  return sha256(
    JSON.stringify([entries.map((entry) => [entry.code, entry.path]), contents]),
  ).slice(0, KEY_CHARS);
}

/**
 * The dedup key: `(Task Kind + prompt + HEAD + thread_id + the uncommitted tree)`.
 *
 * C3 specified the first four. The fifth was added on #8 for the reason C3 recorded against itself:
 * `HEAD` is the only thing about the tree in those four, so a Delegation repeated against the same
 * commit with different uncommitted work in it hashed the same and was served a stale Result — and
 * reviewing an uncommitted diff is the plugin's first use, with the TTL its only guard. `thread_id`
 * became real on the same issue, which is why the key was edited once rather than twice.
 *
 * `null` for the tree is what a directory that is not a repository, or one whose tree could not be
 * measured, hashes as. That is the pre-#8 behaviour for exactly those cases, and the TTL is again
 * the only guard — so the Runner says so rather than leaving it to be inferred.
 */
export function dedupKey({ kind, request, head, thread, tree }) {
  return sha256(
    JSON.stringify([kind, request, head ?? null, thread ?? null, tree ?? null]),
  ).slice(0, KEY_CHARS);
}

function cacheFile(stateRoot, slug, key) {
  return path.join(stateRoot, CACHE_DIR, slug, `${key}.json`);
}

const ageMinutes = (iso, now) => (now - Date.parse(iso)) / 60_000;

/**
 * The cached Result for this key, or null. An entry that cannot be read is not an entry: the cache
 * exists to save a Delegation, and failing one over its own bookkeeping would cost more than it
 * ever saves.
 */
export function cacheLookup(stateRoot, slug, key, ttlMinutes, now = Date.now()) {
  if (ttlMinutes <= 0) return null;
  const file = cacheFile(stateRoot, slug, key);
  if (!existsSync(file)) return null;

  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    const age = ageMinutes(entry.created_at, now);
    if (!Number.isFinite(age) || age >= ttlMinutes) return null;
    if (typeof entry.stdout !== "string" || entry.stdout === "") return null;
    return { ...entry, age_minutes: age };
  } catch {
    return null;
  }
}

/** Drop what no TTL could still serve, so one repository's cache stays bounded. */
function pruneCache(dir, now) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const age = ageMinutes(JSON.parse(readFileSync(file, "utf8")).created_at, now);
      if (!Number.isFinite(age) || age >= CACHE_RETENTION_MINUTES) rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
}

/**
 * Remember what this Delegation returned. Best-effort, and deliberately so: a cache that cannot be
 * written costs a future Delegation, and the Result in hand is unaffected.
 */
export function cacheStore(stateRoot, slug, key, entry, ttlMinutes, now = Date.now()) {
  if (ttlMinutes <= 0) return false;
  const dir = path.join(stateRoot, CACHE_DIR, slug);
  try {
    mkdirSync(dir, { recursive: true });
    pruneCache(dir, now);
    writeFileSync(
      cacheFile(stateRoot, slug, key),
      `${JSON.stringify({ ...entry, created_at: new Date(now).toISOString() }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** One JSONL file's entries, oldest first. A line that is not JSON is skipped, not fatal. */
function readEntries(file) {
  if (!existsSync(file)) return [];
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line);
      if (entry !== null && typeof entry === "object") entries.push(entry);
    } catch {
      // A torn line from an interrupted append. One record is not worth the rest of the Ledger.
    }
  }
  return entries;
}

/** The whole Ledger, oldest first: the generation behind the live file, and then the live file. */
export function readLedger(stateRoot) {
  return [
    ...readEntries(path.join(stateRoot, LEDGER_ARCHIVE)),
    ...readEntries(ledgerFile(stateRoot)),
  ];
}

/**
 * Keep the Ledger bounded by rotating it, never by rewriting it in place.
 *
 * A truncate-and-rewrite would break the append-only invariant this module's counting rests on: a
 * second Runner appending a start record while the first rewrote the file would lose it, and the
 * Budget would under-count exactly when it is most loaded. A rename loses nothing — a process
 * holding the old file open goes on writing to the same inode under its new name, and the archive
 * is read back alongside the live file.
 *
 * One generation is kept. That is roughly twenty thousand Delegations of history for calibration,
 * and the oldest of them are of the least use to it.
 */
function rotateLedger(stateRoot) {
  const file = ledgerFile(stateRoot);
  try {
    if (statSync(file).size < LEDGER_MAX_BYTES) return;
    renameSync(file, path.join(stateRoot, LEDGER_ARCHIVE));
  } catch {
    // Rotation is housekeeping, and an unrotated Ledger still counts correctly.
  }
}

/**
 * Append one observation. Throws when it cannot: the Ledger is the Budget, and a Budget that
 * cannot be counted cannot be enforced — which is the one failure mode ADR-0002 exists to prevent.
 * The caller turns that into a refusal.
 */
export function record(stateRoot, entry, now = Date.now()) {
  mkdirSync(stateRoot, { recursive: true });
  rotateLedger(stateRoot);
  appendFileSync(
    ledgerFile(stateRoot),
    `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`,
  );
}

/**
 * What the window currently holds. `started` is what counts, not `finished`: a Delegation is
 * counted at its start, so work that outlives its session still counts, and a Delegation that
 * failed after the provider was asked counts too.
 *
 * `resets_at` is when the oldest Delegation in the window ages out — the first moment the next one
 * has room, and the only honest thing to tell a user whose Budget is spent.
 */
export function budgetState(stateRoot, { ceiling, windowHours }, now = Date.now()) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const since = now - windowMs;
  const started = readLedger(stateRoot)
    .filter((entry) => entry.event === "started")
    .map((entry) => Date.parse(entry.at))
    .filter((at) => Number.isFinite(at) && at >= since)
    .sort((a, b) => a - b);

  const oldest = started[0] ?? null;
  return {
    count: started.length,
    ceiling,
    windowHours,
    remaining: Math.max(0, ceiling - started.length),
    exhausted: started.length >= ceiling,
    oldest_at: oldest === null ? null : new Date(oldest).toISOString(),
    resets_at: oldest === null ? null : new Date(oldest + windowMs).toISOString(),
  };
}
