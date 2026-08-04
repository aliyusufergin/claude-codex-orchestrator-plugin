# delegate

Claude Code orchestrates, Codex works.

A Claude Code plugin in which the Claude Code session is the **Orchestrator** and OpenAI Codex is a
delegated **Worker**. The product is the *policy* — what gets handed to Codex, what context travels
with it, where its output is allowed to land — not the transport that carries it.

Everything the plugin decides is in [`CONTEXT.md`](CONTEXT.md) (the vocabulary),
[`docs/adr/`](docs/adr/) (the decisions and what they were measured against), and
[`docs/design/delegate-decisions.md`](docs/design/delegate-decisions.md) (why each one went the way
it did). This file is what you need before running it.

## Install

```
/plugin marketplace add aliyusufergin/claude-codex-orchestrator-plugin
/plugin install delegate
```

Requires the [Codex CLI](https://github.com/openai/codex) on `$PATH`, logged in (`codex login`) or
authenticated by `$CODEX_API_KEY`, and Node 22 or newer.

**The plugin ships `defaultEnabled: false`, and stays off until you enable it.** Installing a plugin
and consenting to a second agent spending your provider allowance and writing code on your behalf
are not the same act, and a plugin that conflated them would be answering a question you were never
asked. Enable it in `/plugin` when you mean it.

Once enabled, run `/delegate:setup`. It checks that delegation can run at all — binary, login, the
write allowances a sandboxed session needs, the provider's host, the Budget — and prints the
configuration in force. The same check runs at every session start, so a broken precondition
surfaces as a message rather than as a Delegation that dies minutes later without explaining itself.

## What it does

Six **Task Kinds**, split by whether their Result can be checked mechanically:

| Class | Task Kind | What it returns |
| :-- | :-- | :-- |
| **Advisory** — runs `read-only`, blocks, returns prose | **Review** | A second opinion on a diff, as structured findings |
| | **Diagnosis** | Root cause of a failure — hypothesis plus evidence, and no fix |
| | **Adversarial** | An attempt to refute a claim you already made |
| **Verifiable** — runs `workspace-write` in a Workspace, returns a diff | **Implementation** | A change described by intent rather than mechanism |
| | **Repro** | A minimal failing test — correct precisely when it *fails* |
| | **Migration** | A broad mechanical change, checked by the build |

Delegation is autonomous: the Orchestrator routes to a Task Kind when the moment calls for one, and
you never have to ask. What bounds it is not a prompt but the **Delegation Budget** — a rolling
window enforced inside the Runner, below the Orchestrator, where no enthusiasm upstream can spend
past it.

Nothing a Worker produces reaches your files on its own. A Verifiable Delegation writes into a
**Workspace** — a throwaway git worktree branched from your `HEAD` and seeded with your working
tree, uncommitted and untracked files included — and **Landing** that diff into your tree is
governed by Read-Before-Change ([ADR-0003](docs/adr/0003-read-before-change.md)): the Orchestrator
alters your tree only from content it has itself read, a passing Verification Signal is evidence
rather than authority, and a Workspace whose seed no longer matches your tree never Lands
autonomously.

## Commands

| Command | What it does |
| :-- | :-- |
| `/delegate:setup` | Readiness check plus the configuration in force |
| `/delegate:status` | Delegations running now and recently finished, including from an earlier session |
| `/delegate:result <id>` | The whole persisted Result of any Delegation |
| `/delegate:cancel <id>` | Stop a running Delegation |
| `/delegate:apply <id>` | Land a diff by hand — the escape hatch, not the normal path |
| `/delegate:quota [<n>]` | Budget state, and the one place its ceiling is negotiable |
| `/delegate:clean` | Collect every Workspace on disk, unlanded ones included |

All seven are `disable-model-invocation`: they are yours, not the Orchestrator's. It reaches a
Delegation through a Forwarder subagent or not at all.

## The frightening flag

Under an outer sandbox the Runner may invoke Codex with **`-s danger-full-access`**. Read cold that
looks indefensible, so here is the whole of it. The measurement behind every claim is in
[ADR-0004](docs/adr/0004-disable-codex-sandbox-under-outer-sandbox.md) and the
[probe](docs/research/sandbox-nesting-probe.md); both probe runs were Linux and bubblewrap.

**It is conditional, never a default.** The Runner detects an outer sandbox by attempting a write
outside the working directory at startup — a measurement, not a setting. With no outer sandbox
there is no outer boundary to rely on, and Codex runs under **its own** sandbox: `read-only` for
Advisory, `workspace-write` for Verifiable. The flag does not appear.

**Under an outer sandbox, the preference is still Codex's own sandbox.** When `/tmp` and
`$CODEX_HOME` are both writable, Codex nests fine: same two modes, with the outer jail as a second
layer. That is the configuration to want, and the two write allowances below are what keep you in
it.

**The fallback is what the flag is for.** Codex's Linux sandbox helper builds its mount targets
under `/tmp`, and Claude Code's sandbox leaves `/tmp` inside its read-only root — so the helper
panics before enforcing anything. With it unavailable, `danger-full-access` is the only
configuration that *runs*: `workspace-write` reports success and writes nothing, `read-only` loses
shell execution entirely. The alternative to the flag is not "two layers", it is "nothing runs".

**It widens nothing.** The outer jail is enforcing the boundary either way — the probe confirms
writes to `$HOME` stay blocked whatever Codex is asked to do. What the fallback costs is a *second*
layer, not the only one, which is why it is worth avoiding rather than merely worth explaining.

**And the corollary, which is the opposite of what the flag name suggests:** if you turn Claude
Code's sandbox *off* and trust this plugin's default, Codex runs with its **own** sandbox on. That
is the safe case. The flag appears only where something else is already holding the line.

**macOS is unmeasured.** Seatbelt inside Seatbelt is a different collision from the one that was
probed, and the cause found on Linux is an implementation detail that does not transfer. Delegations
there take the preferred path, because two enforcing layers is the better guess to hold until it is
measured — and readiness says so rather than applying a Linux conclusion silently
([#16](https://github.com/aliyusufergin/claude-codex-orchestrator-plugin/issues/16)).

### If your session is sandboxed

Two directories must be writable, and they fail at different layers:

- **`~/.codex`** (`$CODEX_HOME`) — without it `codex exec` dies at app-server startup, before it
  emits a single event, `--ephemeral` or not. No sandbox mode rescues this, so the Runner refuses
  rather than pretending a mode change would help.
- **`/tmp`** — without it Codex's sandbox helper panics, and you land on the fallback above.

Add both to `sandbox.filesystem.allowWrite` in your Claude Code settings. Neither is a boundary that
matters much — `/tmp` is scratch space, and the outer jail keeps holding the line that does.

Claude Code also pre-allows **no** domains, so a sandboxed session may need the provider's host in
`sandbox.network.allowedDomains` — `api.openai.com`, or whichever host your Codex config points at.
Readiness probes it and names the setting when it does not answer.

## What a Worker can see

A Worker is a third-party agent. It does not inherit your environment: the Runner hands the Codex
process an explicit allowlist, and every command that Worker runs sees only what is on it.

```
PATH  HOME  USER  SHELL  LANG  LC_*  TERM  TMPDIR  CODEX_HOME
CODEX_API_KEY  CODEX_ACCESS_TOKEN
```

Everything else is dropped — your cloud credentials, your API tokens, and the Runner's own
`DELEGATE_*` configuration alike. `OPENAI_API_KEY` is deliberately absent: `codex exec` never reads
it, so passing it would leak a secret that buys nothing.

Extend it by name or by `PREFIX*` glob, rather than by editing the plugin:

```
export DELEGATE_ENV_ALLOWLIST="TURBO_TOKEN,CI_*"
```

A bare `*` is dropped rather than honoured — it would turn the allowlist back into the inheritance
it exists to replace.

## The numbers

| Setting | Default | Environment |
| :-- | :-- | :-- |
| Delegations per window | 20 | `DELEGATE_BUDGET_CEILING` |
| Rolling window | 5h | `DELEGATE_BUDGET_WINDOW_HOURS` |
| Dedup TTL | 15m | `DELEGATE_DEDUP_TTL_MINUTES` |
| Diff read threshold | 400 lines | `DELEGATE_DIFF_MAX_LINES` |

**Every one of them is provisional.** None has been calibrated against real usage: they are placed
where a first guess had to go, and they are pending calibration against what the Ledger records —
Delegation counts per window, durations, and diff sizes. Treat them as starting points, not as
findings, and expect them to move.

All four live in [`scripts/config.mjs`](scripts/config.mjs) and nowhere else. Each is overridable by
its environment variable and by `settings.json` in the state directory, the environment winning
because it is the more specific and the easier to undo. `/delegate:quota <n>` is the one that is
negotiated rather than edited — and it is negotiated by you, never by the Orchestrator.

Two other variables configure the plugin itself: `$DELEGATE_STATE_DIR`, where Results, the Ledger
and the dedup cache live, and `$DELEGATE_CODEX_BIN`, the Codex binary to run.

## How the Runner is invoked

Everything — every Forwarder, every command, both hooks — runs the Runner as:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" <subcommand>
```

There is **no `bin/` shim and no permission-rule strategy**. Permission prompting is the harness's
concern and yours to configure: if you want these invocations to stop prompting, that is a rule in
your own Claude Code settings, and the plugin does not reach into it or reshape its own invocation
to game the matcher. Codex is never invoked through `npx`, for the related reason that a wrapped
invocation prompts on a rule you cannot write.

## Development

```
npm test
```

Two test seams and no dependencies: the Runner driven as a real process in a temporary git
repository against a fake Codex binary, and an asset lint over the shipped markdown and JSON.

Apache-2.0.
