# `delegate` — decision log

Output of a `/grill-with-docs` session on 2026-08-02. Twenty-three decisions, plus the
corrections a consistency audit produced and the questions deliberately left open.

This is the input to `/to-spec`. It exists because most of these decisions are ordinary — they
don't clear the bar for an ADR — but every one of them is load-bearing, and without this file they
would live only in a conversation transcript.

**Read alongside:**

| File | What it holds |
| :-- | :-- |
| [`CONTEXT.md`](../../CONTEXT.md) | The glossary. Terms in **bold** below are defined there. |
| [`docs/adr/0001`](../adr/0001-independent-runtime-over-codex-exec.md) | Independent runtime over `codex exec` |
| [`docs/adr/0002`](../adr/0002-autonomous-delegation-bounded-by-budget.md) | Autonomous delegation, bounded by budget |
| [`docs/adr/0003`](../adr/0003-read-before-change.md) | Read-Before-Change |
| [`docs/adr/0004`](../adr/0004-disable-codex-sandbox-under-outer-sandbox.md) | Preferring Codex's own sandbox under an outer one, `danger-full-access` as fallback |
| [`docs/research/claude-code-orchestrating-codex.md`](../research/claude-code-orchestrating-codex.md) | Both products' extension surfaces, cited |
| [`docs/research/sandbox-nesting-probe.md`](../research/sandbox-nesting-probe.md) | Measured sandbox behaviour |
| [`docs/research/exec-event-stream-shape.md`](../research/exec-event-stream-shape.md) | The `--json` event stream as it actually arrives |
| [`docs/research/exec-resume-surface.md`](../research/exec-resume-surface.md) | `codex exec resume`'s flags, and what a refusal looks like |

---

## Product shape

**D1 — The product is the policy layer.** Value is in what gets delegated, what context travels
with it, and what is allowed back — not in the transport. This is why a first-party plugin
already existing does not make this one redundant.

**D2 — Independent thin runtime over `codex exec`.** No dependency on `openai/codex-plugin-cc`, no
`app-server`, no bundled MCP server. → ADR-0001

**D17 — The plugin is named `delegate`.** Chosen over `codex-orch` / `codex-agents` because in
autonomous routing the Orchestrator reads the agent name, and an action reads better than a
product name. Surfaces as `delegate:review`, `@agent-delegate:adversarial`, `/delegate:status`.

**D18 — Packaging: `defaultEnabled: false`, Apache-2.0, `version` left unset.** Ships installed but
off. Apache-2.0 matches `codex-plugin-cc`, whose schemas and prompt templates may be adapted.
`version` unset so the git SHA drives updates during fast iteration. → ADR-0002 (first item)

**D19 — All six Task Kinds ship in the first release.** Rejected: a vertical slice, or Advisory
first. Accepted cost — six prompt templates written before real usage informs them.

*Four of the six exist as of #9*: Review, Diagnosis, Adversarial and Implementation. Repro and
Migration have a Delegation Class, a schema and a sandbox mode already; what they still need is a
prompt template and a Forwarder each.

---

## Taxonomy

**D3 — Six Task Kinds across two Delegation Classes.** Advisory: **Review**, **Diagnosis**,
**Adversarial** — `read-only`, output is prose. Verifiable: **Implementation**, **Repro**,
**Migration** — `workspace-write` in a **Workspace**, output is a diff plus a mechanical signal.
→ `CONTEXT.md`

**D16 — Reasoning effort per Task Kind; model never set.** Effort travels as
`-c model_reasoning_effort=<level>` from a table in the **Runner** (Adversarial and Diagnosis
high, Review medium, Repro and Migration low), overridable by the user's `config.toml`. The model
is never passed — published model names are inconsistent across sources and churn fast.

*Implemented on #5, with two details the decision did not settle.* `-c` **beats** `config.toml` in
Codex's own precedence, so "overridable by the user's `config.toml`" can only mean the Runner does
not pass the flag at all when their config sets the key — it scans `$CODEX_HOME/config.toml` and
`<cwd>/.codex/config.toml` for a top-level `model_reasoning_effort` and defers to either. And D16
names five Task Kinds.

*Implementation settled on #9, at `low`.* It sat at `high` in the meantime, on the reasoning that it
is asked for judgement rather than mechanism. What decides it is the **Delegation Class** rather than
the Task Kind: an Advisory Result is judgement and nothing checks it, so thought is what is being
bought, while a Verifiable Result carries its own **Verification Signal** — a Worker that reasons its
way to a wrong change still fails its own tests, and the iterations it then spends buy more than the
reasoning would have. Effort now splits along the Class boundary: Advisory `medium`/`high`,
Verifiable `low` throughout. Still provisional in O3's sense, and the Ledger's durations are what
settle it against real runs.

**D20 — Two output schemas, one per Delegation Class.**

*Advisory*: `verdict`, `summary`, `findings[]`, `next_steps[]`. Each finding carries `severity`,
`title`, `body`, `file`, `line_start`, `line_end`, **`evidence`** (the offending code verbatim),
`confidence`, `recommendation`. `evidence` is mandatory — Read-Before-Change depends on it.

*Verifiable*: `summary`, `branch`, `files_changed[]`, `diff_stat`, `verification`
(`command`, `exit_code`, `passed`), `caveats[]`. Task Kind differences ride as optional fields —
`expected_failure` for **Repro**.

*Verifiable implemented on #9* (`schemas/verifiable.json`). `diff_stat` is an object —
`files`, `insertions`, `deletions` — rather than the string `git diff --stat` prints, because the
Ledger records diff sizes for O3's calibration and a sentence would have to be parsed back. Like
Advisory's nullable-but-required fields, `expected_failure` is required and nullable: a Worker
cannot omit it, and every Kind but **Repro** nulls it. The Runner re-checks the payload on the way
back, and splits what it finds by what it costs, exactly as Advisory does — but with one check
Advisory has no equivalent of. A missing **Verification Signal** is fatal, because the Class *is*
the signal; and so is a Worker reporting files its **Workspace** does not hold, which is probe case
C in its most expensive form. Everything else — a claimed file the Workspace has no change to, a
changed file the Worker did not report, a branch it names wrongly, a malformed `diff_stat` — is
reported on stderr and rendered anyway. What the rendering lists as changed is the Runner's own
measurement of the Workspace, never the Worker's claim: that is the half of a Verifiable Result
that cannot be fabricated.

*Advisory implemented on #5* (`schemas/advisory.json`). Vocabularies the decision left open:
`verdict` is `pass` / `concerns` / `blocking`, `severity` is `critical` / `high` / `medium` / `low`,
`confidence` is a number from 0 to 1. *(Widened on #8: `verdict`'s three words were defined for
Review alone, and Diagnosis and Adversarial now share the schema. The vocabulary is unchanged and
each Kind reads it against its own question — for Diagnosis, whether the cause was found; for
Adversarial, whether the claim was refuted — stated both in the schema and in each prompt template,
because the Runner headlines the verdict and an arbitrary one there mislabels the whole Result.)*
`file`, `line_start` and `line_end` are required but nullable,
so a finding about the change as a whole is representable without a Worker being able to omit the
fields; `evidence` is never nullable. The Runner re-checks the payload against these rules on the
way back rather than trusting the schema to have held — a schema is a request, not a guarantee —
and splits what it finds by what it costs. A finding without `evidence`, or a payload with no
`findings` array, is fatal: there is nothing ADR-0003 can act on. Everything else is reported on
stderr and rendered anyway, because the Budget is spent by the time the check runs and withholding
nine sound findings over a confidence expressed as a string spends it for nothing. Either way what
came back is persisted first, unparseable text included, under `raw_payload`.

---

## Triggering and control

**D8 — Fully autonomous delegation.** Forwarder descriptions invite proactive use; no Delegation
requires a user trigger. → ADR-0002

**D9 — Six Forwarder subagents, one per Task Kind.** Routing happens in the main thread, where the
whole conversation is visible, rather than inside a Forwarder that would see only a handoff
paragraph. Cost is roughly 300 tokens per turn of always-on descriptions; accepted because
within-class misrouting is cheap (a worse prompt template, not a wrong action) and the expensive
boundary — Advisory vs Verifiable — is the legible one.

Each Forwarder is `tools: Bash` and nothing else, forbidden from doing work of its own, and
returns the Runner's stdout verbatim. It carries no schema, prompt, or Codex effort setting — it
passes `--kind` and the Runner resolves the rest.

**D10 — Dedup plus a rolling-window Delegation Budget.** Both enforced in the Runner, below the
Orchestrator. Budget counted at Delegation start. Rejected: a concurrency cap, and
visibility-only. → ADR-0002

*Implemented on #7.* The Budget is a count over an append-only **Ledger** of Delegation starts,
appended immediately before the spawn and never rewritten — which is what makes counting at start
safe under concurrency without a lock file that could outlive a killed Runner and refuse everything
after it. The Ledger is bounded by *rotation*, not compaction, for the same reason: a
truncate-and-rewrite would drop a start record a second Runner was appending at that moment, and
the Budget would under-count exactly when it is most loaded. Two Delegations starting in the same instant can both read a count below the ceiling, so
the bound is one-over at worst; the alternative was judged worse. A ledger that cannot be written
refuses the Delegation rather than proceeding uncounted: the Budget *is* the ledger, and running
unbounded is the outcome ADR-0002 exists to prevent. Refusal is exit `1` with the count, the
ceiling, the moment the window frees up, and `/delegate:quota` named — the Runner cannot ask,
because `AskUserQuestion` is unavailable to every subagent, so everything the user needs to decide
has to be in the refusal itself. Order in the Runner is dedup, then Budget, then the preconditions
for running Codex at all: serving a cached Result needs no Worker, and neither does refusing.

**D12 — Advisory blocks, Verifiable does not.** Advisory is short and its whole value is the answer
returning to the flow. Verifiable runs for minutes and its result is a branch, so it runs in the
background and reports on completion.

*Implemented on #9.* The non-blocking is the **Forwarder**'s, not the Runner's: the Runner runs to
completion in one process, and the Forwarder starts it as a background Bash call so the harness's
own completion notification is what carries the Result back. Nothing is forked and no job daemon
exists — a second process supervising the first would be state to reconcile, and the harness already
has the thing that reports on a finished command. What the Runner does add is an announcement: the
Delegation's id, its Workspace and its branch go to stdout the moment they exist, before the minutes
of work, so that the run is addressable while it happens. `/delegate:status` lists it from a live
record on disk, `/delegate:cancel <id>` signals the Runner that record names, and `/delegate:result
<id>` retrieves the whole Result afterwards if the notification never arrives.

The cancellation signals the *Runner*, never Codex, and the Runner never exits from its signal
handler: it kills the Worker and lets the run unwind, so the Delegation ends the way any other
failure does — Ledger closed, running record cleared, empty Workspace disposed of. A signal arriving
before the Worker has been spawned is held and honoured the moment there is one to kill; a signal
arriving after the Worker has finished is deliberately not honoured at all, because the Delegation is
paid for and its Result is in hand. The Budget is not refunded either way: it counts what was asked
of the provider, and cancelling does not un-ask it.

**D11 — Advisory Delegations resume; Verifiable are single-shot.** Advisory persists `thread_id`
and follow-ups continue the thread via `codex exec resume`, so dialogue with a reviewer is cheap.
Verifiable always starts clean and may pass `--ephemeral`. If a resume attempt fails, the Runner
falls back to a fresh Delegation and flags `resume_unavailable` in the Result — a visible
degradation, never a silent one.

*Implemented on #8, with three details the decision did not settle.*

*First, `codex exec resume` is not `codex exec` with an id on the end.* Measured on 0.146.0
([the resume surface](../research/exec-resume-surface.md)): it takes `--json`, `-c`,
`--output-schema` and `-o` like its parent, and it takes **neither `-s` nor `-C`** — the two flags
the Runner is least willing to leave to Codex's defaults. So the sandbox mode travels as
`-c sandbox_mode=<mode>`, which is validated against the same three values `-s` takes, and the
working directory travels as the child process's own, because there is no flag for it. The Runner's
own working directory is still never changed.

*Second, what counts as "a resume attempt failed".* A refused resume produces **no event stream at
all** — empty stdout, the `thread/resume` error on stderr, exit `1` — because Codex rejects the id
before the turn begins. The fallback therefore keys off the *absence of a thread*, not off the
message: no `thread.started`, no payload, no signal, non-zero exit. The stderr line is matched only
to name the cause in the notice the Orchestrator reads. Deciding on "the run failed" instead would
re-run a resume that opened a thread and *then* failed, spending a second Delegation on the same
failure; deciding on the message would break on the first wording change.

*Third, a refused resume plus its fallback is **one** Delegation against the Budget.* The Budget
counts what was asked of the Worker's provider, and a rollout lookup that fails locally never asks
it. The Ledger records `resumed` and `resume_unavailable` per Delegation, so how often a persisted
thread is still resumable — the thing that decides whether Advisory dialogue is actually cheaper —
is answered from use rather than guessed. The degradation itself is announced on **stdout**, and
above the findings rather than in the footer: a Forwarder returns stdout verbatim and reads stderr
only on a non-zero exit, and reading a fresh Result as a continuation of a conversation it does not
have is the mistake the notice exists to prevent.

---

## Verifiable execution

**D4 — The Runner creates its own Workspace.** A `git worktree` it manages, not Claude Code's
`isolation: worktree` — that branches from the default branch rather than the session's `HEAD`,
and the branch point has to be ours.

**D5 — The Workspace is seeded from the working tree, not from `HEAD`.** Committed state plus
uncommitted changes plus untracked, non-ignored files. The Worker sees what the user sees, which
**Repro** requires outright — the bug is usually in code that isn't committed yet.

**D6 — The Worker produces its own Verification Signal.** It runs the build or tests, iterates
against them, and reports command, exit code and verdict. The Runner does not re-run them. For
**Repro** the semantics invert: the test is correct when it *fails*, so a passing test means the
test is wrong and must be fixed — never the code.

**D4, D5 and D6 implemented on #9**, with four details the decisions did not settle.

*First, the seed is a commit.* D5 says the Workspace is seeded from the working tree; it does not say
whether that arrives as uncommitted state or as a commit. It arrives as a commit on the Workspace's
own branch, whose parent is the session's `HEAD` — so the branch *point* is still `HEAD` as D4
requires, and the Worker's own change is readable as a diff against one named commit. Left
uncommitted, the Worker's diff and the user's unfinished work would arrive as one indistinguishable
pile, for the Worker, for the reconciliation, and for the Landing that comes later. The seed commit
is attributed to `delegate`, not to the user, and skips hooks and signing: it is bookkeeping, not
authorship, and the hooks in the shared `.git` would otherwise run against a commit nobody made.

*Second, the seeding is read-only on the user's side.* `git diff --binary HEAD` piped into
`git apply` in the Workspace carries staged and unstaged changes, deletions and mode changes;
`git ls-files --others --exclude-standard` carries the untracked, non-ignored files, copied with
their executable bit. Nothing writes to the user's index, working tree or object database, and the
test that matters asserts the working tree is byte-identical across a run in which the Worker wrote
files.

*Third, the Runner measures the Workspace itself.* D6 says the Runner does not re-run the Worker's
command, and it does not — but it does look at what the Workspace holds, `git diff --name-only`
against the seed commit plus the untracked files. That is not verification; it is the reconciliation
of #6 applied to a Class whose Result is a diff. A Worker reporting files that are not there fails
the Delegation.

*Fourth, an empty Workspace is swept and a written-in one is not*, however the run ended. D22 leaves
unlanded work alone because it is the user's. A Workspace nothing was written into is not that — it
is a worktree and a branch the plugin left behind — so it is removed with its branch, and the
distinction is measured rather than assumed. That covers the *successful* run that changed nothing
as well as the failed one: the schema calls an empty `files_changed` a legitimate Result, and D22's
sweep is not there to tidy up after a run that completed. The rendering says which of the two
happened, so it never points at a branch that is not there.

**D22 — A Delegation outlives its session.** `SessionEnd` collects only Workspaces that are
finished-and-Landed or untouched. A running Worker is left alone: its Budget is already spent, and
its Result is retrievable next session via `/delegate:result`. Unlanded branches are the user's
work, not the plugin's litter.

**D23 — Detect an outer sandbox; keep Codex's own on where the preconditions allow.** → ADR-0004
*(Originally "disable Codex's own when one is present". Reversed 2026-08-03 — see C5.)*

---

## Result handling

**D7 — Landing is governed by Read-Before-Change.** *(Revised — originally "always an explicit user
command", which contradicted D13.)* → ADR-0003

**D13 — The Orchestrator verifies, triages, then applies.** Findings are checked against the code
via `evidence`; confirmed, localised, test-covered ones are applied; anything unverifiable,
broad, or touching behaviour, public API, security or architecture goes to the user. → ADR-0003

**D24 — Where a Result is persisted** *(new on #5; not from the session)*. `$DELEGATE_STATE_DIR`, else
`${CLAUDE_PLUGIN_DATA}`, else `$CODEX_HOME/delegate` — `results/<kind>-<8 hex>.json`, one file per
Delegation. `${CLAUDE_PLUGIN_ROOT}` is explicitly not durable across plugin updates; `$CODEX_HOME`
is the fallback because it is the one directory a Delegation has already established is writable,
including under an outer sandbox where `$HOME` is not. Persisting is best-effort: it happens before
the Result is validated or rendered, and a directory that cannot be written to costs
`/delegate:result`, never the answer — the Budget for it is already spent.

*Widened on #7.* The same root now holds the whole of the plugin's state: `results/`, the Budget
`ledger.jsonl`, `settings.json`, and `dedup/<repo>/` — all of it outside any repository, which the
Budget requires (it is the provider's, and the provider does not care which repository a Delegation
came from) and which keeps a Worker's Result out of the user's source tree. Only the dedup cache is
partitioned by repository, and it is partitioned by the hash of the repository's toplevel, not by
living inside it.

**D21 — A Stale Workspace cannot be Landed autonomously.** The Runner records the `HEAD` and a hash
of the uncommitted state it seeded from and compares at Landing time. → ADR-0003

**D14 — Two standing guardrails.** A failed Delegation is never substituted with the Orchestrator's
own answer — the failure is reported and work stops. And Result text is framed as data from an
external agent, so instruction-shaped content in it is not instruction. → ADR-0002 (closing
paragraph)

---

## Harness surface

**D15 — Two hooks, no `Stop` gate.** `SessionStart` checks readiness (binary present, logged in,
Budget state). `SessionEnd` performs the narrow cleanup of D22. A `Stop` review gate is *not*
shipped, even disabled: full autonomy already covers it, and it would compete with the Budget for
the same window.

**Command surface** *(derived from the decisions, not separately decided)*:

| Command | Purpose |
| :-- | :-- |
| `/delegate:setup` | Readiness check, config |
| `/delegate:status` | Running and recent Delegations |
| `/delegate:result <id>` | Full Result, including from a previous session |
| `/delegate:cancel <id>` | Stop a running Delegation |
| `/delegate:apply <id>` | Manual Landing — the escape hatch, not the normal path |
| `/delegate:quota` | Budget state; raise the ceiling |
| `/delegate:clean` | Collect unlanded Workspaces and branches |

Shipped so far: `/delegate:result` and `/delegate:quota` (#5, #7), `/delegate:status` and
`/delegate:cancel` (#9). All four are `disable-model-invocation` — they are the user's commands, and
the Orchestrator reaches a Delegation through a Forwarder or not at all.

---

## Corrections from the consistency audit

**C1 — Repro's verification semantics are inverted** and must be stated in its prompt template, or
a Worker following D6's general instruction will "fix" the failing test and destroy the task.
*(Folded into `CONTEXT.md` and D6.)*

**C2 — Forwarders carry no schema, prompt, or Codex effort.** D9's original justification claimed
they would; D16 and D20 moved all three into the Runner. Agents pass `--kind` only.

*Read as "no policy of their own" on #8.* An Advisory Forwarder also passes `--thread <id>` when the
request names one, which is what makes D11's resume reachable at all — the thread id is in the
rendering the Orchestrator holds, and a Forwarder that could not pass it back would leave every
follow-up costing a whole Delegation. It is a continuation id and not a setting: it selects no
schema, no prompt, no effort and no sandbox mode, and the Runner still resolves all four from
`--kind`. The asset lint enforces the distinction directly — each Forwarder names exactly one Task
Kind and carries none of `--output-schema`, `model_reasoning_effort`, `--model` or `--sandbox`.

**C3 — The dedup key is `(Task Kind + prompt + HEAD + thread_id)`.** Without `thread_id` a repeated
follow-up on a resumed Advisory thread would be served from cache and the thread would never
advance.

*Implemented on #7, with one consequence worth stating.* `HEAD` is the only thing about the tree in
the key, so a Delegation repeated against the same commit with different **uncommitted** work in it
hashes the same and is served from cache — and reviewing an uncommitted diff is the plugin's first
use. The dedup TTL is the only guard, which is why it defaults to 15 minutes and why a cache hit
reports how old its Result is and says plainly that a changed working tree makes it stale. The
`--thread` flag exists on `delegate` today only to feed this key; resuming a thread with it is #8's.
Widening the key with a hash of the uncommitted state is the obvious alternative and was left to
#8 deliberately: that is where `thread_id` stops being a placeholder, so the key is edited once
rather than twice. D21 needs the same measurement for a different comparison — the hash of what a
Workspace was *seeded* from, compared at Landing time, against this one's hash of the tree as it is
now — so #10 reuses #8's helper rather than writing a second one.
Entries are repo-scoped — an identical prompt at an identical `HEAD` in another repository is a
different question — and only a Result the Runner was willing to render is cached; a failed
Delegation is one to run again, not one to serve again.

**C3 (widened on #8) — the key is `(Task Kind + prompt + HEAD + thread_id + the uncommitted
tree)`.** The gap #7 recorded against itself is closed here, in the same edit that made `thread_id`
real. The measurement is `uncommittedDigest()` in `scripts/budget.mjs`: a content-exact digest over
everything `HEAD` does not describe — staged and unstaged changes to tracked files, deletions, and
untracked, non-ignored files. Paths and status codes come from
`git status --porcelain=v1 -z --untracked-files=all --no-renames`, and content from
`git hash-object` **without** `-w`, so nothing is written to the user's index, working tree or
object database to answer a question about a cache key. Seeding a temporary index and calling
`git write-tree` is shorter and was rejected for exactly that: it writes blobs into the user's
repository for the plugin's own bookkeeping, and it fails on a repository that is not writable.

A tree that cannot be measured — a directory that is not a repository, a `git` that failed — hashes
as `null`, which is the pre-#8 behaviour for exactly those cases with the TTL as the only guard. The
Runner says so on stderr rather than leaving it to be inferred, and only when there *is* a commit,
so a non-repository is not warned about for lacking a tree it was never going to have. With the
tree in the key the cache-hit notice loses its caveat: what it now says is that nothing the Worker
would read has changed, and that anything outside the repository has.

This is the same measurement D21 needs, taken at a different moment and compared against a different
thing — #10 hashes what a Workspace was *seeded* from and compares it at Landing time against the
tree as it then is. It reuses this helper rather than writing a second one.

Two further narrowings, both deliberate. Only **Advisory** Results are cached: a Verifiable Result
names a branch in a **Workspace**, and D22 sweeps Workspaces, so serving one a second time would
point the Orchestrator at work that may already have been Landed or collected — worse than spending
the Delegation. *Settled on #9: dedup for Verifiable means running it again.* The lookup is now
skipped outright rather than left to miss, because a Workspace that has since been Landed, swept, or
gone **Stale** under a working tree that moved on is worse than the Delegation it would have saved,
and the Budget is what bounds a caller who asks twice. And the cache hit announces
itself on **stdout**, not stderr: a Forwarder returns stdout verbatim and reads stderr only when the
Runner exits non-zero, so the notice that a Result is *n* minutes old would otherwise reach nobody
at all — which, given the uncommitted-work caveat above, is the disclosure that matters most.

**C4 — Two different `effort` settings exist.** The Forwarder's frontmatter `effort` is the
Orchestrator-side reasoning level and should be low — it is a dumb shell. Codex's effort is
`-c model_reasoning_effort` from the Runner's table (D16). Do not conflate them.

**C5 — D23 was backwards: nesting works, given a writable `/tmp`.** The nesting failure was never
Codex's Landlock layer. Codex's Linux sandbox is itself bubblewrap-based, and its helper builds
synthetic mount targets under `/tmp`; Claude Code leaves `/tmp` read-only, so the helper panics
before enforcing anything — while reporting each command as denied with exit code `0`, which is
how a crash came to be read as a policy denial. Grant `/tmp` and both sandboxes enforce at once.
So `danger-full-access` is the **fallback**, not the rule: prefer `read-only` for Advisory and
`workspace-write` for Verifiable, exactly as in the unsandboxed case, and fall back only when
`/tmp` or `$CODEX_HOME` is not writable — naming which. Sandboxed users need **two** write
allowances, `~/.codex` and `/tmp`, which fail at different layers and must be reported separately.
*(Folded into ADR-0004 and D23; acceptance criteria corrected on #4 and #13.)*

**C6 — The Workspace must not live under `/tmp`.** Granting `/tmp` hands it to Codex's sandbox
helper, which mounts over paths inside it. A worktree under `/tmp` was shadowed by those mounts
during the probe: the Worker wrote its file, truthfully reported success, and the file was gone
afterwards. The payload directory the Runner hands Codex moved from `tmpdir()` to `$CODEX_HOME` on
#4, which lands C5's preferred path. *(Raised on #9 and #4.)*

*Settled on #9 for the Workspace itself.* Workspaces live under the state directory, and the rule is
checked rather than assumed: `/tmp` and `$TMPDIR` are treated as one set of roots nothing may live
under, symlinks resolved, and a state directory that falls inside one sends Workspaces to
`$CODEX_HOME/delegate/workspaces` with the relocation stated on stderr. If even that is inside one,
the Delegation is refused — there is nowhere left where a Worker's writes are safe, and running
anyway is the one outcome with no visible failure. `$DELEGATE_TMP_DIR` replaces the whole set rather
than joining it, because the fixtures a test owns are themselves under the machine's `/tmp`.

**C7 — Which tool-router errors fail a Delegation is decided by the Delegation Class.** #6's
criterion is blunt: any tool-router error fails the run, whatever the exit code. Measured against
real Codex, that is wrong for Advisory. An Advisory Delegation runs `read-only` by design, so every
write the Worker attempts is denied by policy and emits the router signature — while the Result,
prose from reading, is untouched by a write that never happened. So a router error naming a policy
denial of a write is reported and not failed **for Advisory only**; every other router error still
fails it, which is what keeps probe case E — the read-only sandbox stopping the Worker reading at
all — a failure. For Verifiable the same denial *is* the failure, and probe case C's text differs
from it. *(Measured and landed on #6; a Review Delegation reached the same conclusion
independently.)*

---

## Transport facts the implementation must respect

All measured, not assumed. Detail in the research documents.

- `codex exec` **hangs forever on an inherited open stdin** — redirect from `/dev/null`.
- **stderr is not a failure signal** — unrelated MCP client errors land there on every run. One
  named signature on it is: `codex_core::tools::router`, and it is the *only* trace a rejected tool
  call leaves anywhere. Matching it by name is not the same as reading stderr for failure.
- **A rejected tool call produces no event** — measured on 0.146.0: a write denied by `-s read-only`
  left no `error` item, no `turn.failed`, no item reporting `status: "failed"`, and exit code `0`
  ([event-stream shape](../research/exec-event-stream-shape.md)).
- **The exit code is not a failure signal either** — a Delegation can fail completely and exit `0`.
  The Runner matches the tool-router signature on stderr, reads a failed turn, an error and the
  Worker's closing claim off the JSONL event stream, and reconciles the two. A command the Worker
  ran that exited non-zero is work, not failure, and is not reconciled against. This is what a
  Verification Signal actually rests on. *(Implemented on #6.)*
- **Items are flat on the wire** — detail fields sit directly on `item`, not under `details`.
- **The closing `agent_message.text` is the payload** under `--output-schema`, double-encoded — and
  there may be more than one `agent_message` in a turn, the last being the Result.
- **`$CODEX_HOME` must be writable**, `--ephemeral` or not, or Codex dies before emitting an event.
- `--output-schema` + `-o <file>` writes the payload already unwrapped; the same payload inside the
  event stream is double-encoded (a JSON string in `agent_message.text`).
- **`codex exec resume` takes neither `-s` nor `-C`** — the sandbox mode travels as
  `-c sandbox_mode=<mode>` (validated against the same three values) and the working directory as
  the child process's own. It does read that directory: outside a repository it refuses with
  `Not inside a trusted directory` before touching the session store
  ([the resume surface](../research/exec-resume-surface.md)). *(Implemented on #8.)*
- **A refused resume produces no event stream at all** — empty stdout, `Error: thread/resume: … no
  rollout found for thread id <id>` on stderr, exit `1`. It is a run that never began, not a run
  that went wrong, which is why it costs nothing and why the fallback keys off the absent thread.
- Never invoke via `npx` — Claude Code's permission wrapper-stripping does not include it.
- Never `cd` inside a subagent; pass `codex exec -C <dir>` — except on `resume`, which has no such
  flag, where the child process's own directory is the only way to carry it.

---

## Open — carried into the spec, none blocking

**O1 — macOS.** ADR-0004 is verified on Linux only. Seatbelt-inside-Seatbelt is untested and needs
a separate machine. C5 widens the gap rather than narrowing it: the Linux cause is an
implementation detail of Codex's Linux sandbox helper and does not transfer to Seatbelt at all, so
macOS needs the general question asked afresh — does Codex's macOS sandbox need any writable path
Claude Code denies? Open as #16.

**O2 — Network under an outer sandbox.** Claude Code pre-allows no domains, so a sandboxed user may
need the OpenAI API host in `sandbox.network.allowedDomains`. Untested — both probe runs shared the
host network, because both reconstructed the outer sandbox rather than running under a real one.
Answering it is part of #16's Linux half, which needs no special hardware.

**O3 — Numeric defaults.** Budget ceiling per window, dedup TTL, and the diff-size threshold above
which the Orchestrator stops reading and asks. To be calibrated, not guessed.

*Still open on #7, but no longer scattered.* All four numbers live in `scripts/config.mjs` and
nowhere else, each overridable by an environment variable and by `settings.json` in the state
directory, the environment winning:

| Setting | Default | Environment |
| :-- | :-- | :-- |
| Delegations per window | 20 | `DELEGATE_BUDGET_CEILING` |
| Rolling window | 5h | `DELEGATE_BUDGET_WINDOW_HOURS` |
| Dedup TTL | 15m | `DELEGATE_DEDUP_TTL_MINUTES` |
| Diff read threshold | 400 lines | `DELEGATE_DIFF_MAX_LINES` |

Every one of them is a placeholder. The window is the shape the Worker's provider enforces rather
than a measurement of it; the ceiling is a guess at how many Delegations fit in one; the TTL is set
by how long a working tree stays recognisable, not by data. The threshold gained its first consumer
on #9: a Verifiable rendering whose `diff_stat` exceeds it says so, and says the decision to Land is
the user's — the Landing itself is still #10's. `/delegate:quota` prints all four with where each came from and says they are
provisional, and the Ledger records what closing this needs: Delegation counts per window,
durations, and diff sizes.

**O4 — `enableWeakerNestedSandbox`. Answered 2026-08-03: no.** It swaps a namespace-scoped procfs
for a bind of the host `/proc` and drops `--cap-drop ALL` — neither is what Codex needs. Every
probe case is identical under both values, so the selection rule must not branch on it. Chasing
the question is what produced C5, which did change the ADR-0004 picture. Kept here rather than
deleted because the negative result is the reason no code branches on the setting.

**O5 — Environment filtering for the Worker. Implemented on #4.** The Runner passes an explicit
allowlist of environment variables to the Codex subprocess rather than inheriting `process.env`. A
Worker is a third-party agent; anything in the Orchestrator's environment — API tokens, cloud
credentials — would otherwise flow into its process and into every command it runs. The set is the
`WORKER_ENV_ALLOWLIST` constant in `scripts/runner.mjs`, extended by the user through
`DELEGATE_ENV_ALLOWLIST`. Two details worth keeping: the Runner's own `DELEGATE_*` configuration is
not on it, and `OPENAI_API_KEY` is deliberately excluded because `codex exec` never reads it —
`CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are the runtime auth variables.

---

## Deliberately out of scope

Raised during the session and settled as *not* part of this design:

- **Broad codebase exploration and full session transfer** as Task Kinds. The Orchestrator's own
  search is cheaper than the first; the second depends on an undocumented app-server method.
- **A `bin/` shim and any permission-rule strategy.** Permission prompting is the harness's
  concern and the user's to configure. The Runner is invoked as
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs"`; the README notes it, and that is all.
- **Submitting to the community marketplace** at first release — distribute from the project's own
  marketplace until the plugin is proven.
