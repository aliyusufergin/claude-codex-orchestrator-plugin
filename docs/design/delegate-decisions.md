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
names five Task Kinds: Implementation sits at `high`, alongside the other kinds asked for judgement
rather than mechanism, until #9 calibrates it.

**D20 — Two output schemas, one per Delegation Class.**

*Advisory*: `verdict`, `summary`, `findings[]`, `next_steps[]`. Each finding carries `severity`,
`title`, `body`, `file`, `line_start`, `line_end`, **`evidence`** (the offending code verbatim),
`confidence`, `recommendation`. `evidence` is mandatory — Read-Before-Change depends on it.

*Verifiable*: `summary`, `branch`, `files_changed[]`, `diff_stat`, `verification`
(`command`, `exit_code`, `passed`), `caveats[]`. Task Kind differences ride as optional fields —
`expected_failure` for **Repro**.

*Advisory implemented on #5* (`schemas/advisory.json`). Vocabularies the decision left open:
`verdict` is `pass` / `concerns` / `blocking`, `severity` is `critical` / `high` / `medium` / `low`,
`confidence` is a number from 0 to 1. `file`, `line_start` and `line_end` are required but nullable,
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

**D12 — Advisory blocks, Verifiable does not.** Advisory is short and its whole value is the answer
returning to the flow. Verifiable runs for minutes and its result is a branch, so it runs in the
background and reports on completion.

**D11 — Advisory Delegations resume; Verifiable are single-shot.** Advisory persists `thread_id`
and follow-ups continue the thread via `codex exec resume`, so dialogue with a reviewer is cheap.
Verifiable always starts clean and may pass `--ephemeral`. If a resume attempt fails, the Runner
falls back to a fresh Delegation and flags `resume_unavailable` in the Result — a visible
degradation, never a silent one.

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

---

## Corrections from the consistency audit

**C1 — Repro's verification semantics are inverted** and must be stated in its prompt template, or
a Worker following D6's general instruction will "fix" the failing test and destroy the task.
*(Folded into `CONTEXT.md` and D6.)*

**C2 — Forwarders carry no schema, prompt, or Codex effort.** D9's original justification claimed
they would; D16 and D20 moved all three into the Runner. Agents pass `--kind` only.

**C3 — The dedup key is `(Task Kind + prompt + HEAD + thread_id)`.** Without `thread_id` a repeated
follow-up on a resumed Advisory thread would be served from cache and the thread would never
advance.

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
#4, which lands C5's preferred path; the Workspace itself is still #9's to place. *(Raised on #9
and #4.)*

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
- Never invoke via `npx` — Claude Code's permission wrapper-stripping does not include it.
- Never `cd` inside a subagent; pass `codex exec -C <dir>`.

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
