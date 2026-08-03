# `codex exec resume` — the flag surface, and what a refusal looks like

**Measured 2026-08-03 on `codex-cli 0.146.0`, Linux, unsandboxed outer process.** Run because #8's
acceptance criteria say "continues the same Codex thread through `codex exec resume`", and the
obvious implementation — the existing `codex exec` argv with a thread id on the end — does not
compile as a command line.

## What was run

`codex exec resume --help`, and then four invocations against a thread id with no rollout behind it,
from inside a throwaway one-file git repository. None of them reached the provider, so none of them
cost anything.

## Finding 1 — `resume` takes neither `-s` nor `-C`

The two option sets, from `--help` on each:

| Option | `codex exec` | `codex exec resume` |
| :-- | :-- | :-- |
| `--json` | yes | yes |
| `-c, --config <key=value>` | yes | yes |
| `--output-schema <FILE>` | yes | yes |
| `-o, --output-last-message <FILE>` | yes | yes |
| `-m, --model` | yes | yes |
| `--ephemeral` | yes | yes |
| **`-s, --sandbox <SANDBOX_MODE>`** | **yes** | **no** |
| **`-C, --cd <DIR>`** | **yes** | **no** |
| `--add-dir` | yes | no |
| `-p, --profile` | yes | no |
| `--last`, `--all` | no | yes |

These are exactly the two flags the Runner is not willing to leave to Codex's own defaults. The
sandbox mode is what the Delegation Class decides — an Advisory Delegation runs `read-only` because
its Result is prose from reading — and the working directory is what the Worker sees at all.

**Consequence.** Both travel another way on the resume form:

- The sandbox mode as `-c sandbox_mode=<mode>`. Measured as validated by name — `-c
  sandbox_mode=bogus-mode` fails the run before anything else happens:

  ```
  Error loading config.toml: unknown variant `bogus-mode`, expected one of `read-only`,
  `workspace-write`, `danger-full-access`
  in `sandbox_mode`
  ```

  The same three values `-s` takes, so a typo here is a failed run rather than a Worker with more
  authority than its Class allows. `read-only` and `danger-full-access` were both accepted.
- The working directory as the child process's own. There is no flag for it, and `resume` does read
  the process's directory: run from outside a repository it refuses with `Not inside a trusted
  directory and --skip-git-repo-check was not specified.` before touching the session store. The
  Runner's own working directory is still never changed; `-C` is used wherever it exists, which is
  every fresh Delegation.

`--` works on the resume form, and the two positionals after it bind as `[SESSION_ID] [PROMPT]` in
that order — so a prompt that opens with a dash is still a prompt and not a flag.

## Finding 2 — a refused resume produces no event stream at all

```
$ codex exec resume 00000000-0000-4000-8000-000000000000 -c sandbox_mode=read-only --json -- hi
```

- **stdout: empty.** Not one byte. No `thread.started`, no `turn.started`, no `error` event.
- **stderr:** `Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-4000-8000-000000000000 (code -32600)`
- **exit code: 1**

This is a different shape from every failure the [event-stream research](./exec-event-stream-shape.md)
recorded: those are runs that happened and went wrong, and this is a run that never began. Codex
refuses the id before the turn starts, which is also why it costs nothing.

**Consequence for #8.** D11's fallback keys off *the absence of a thread*, not off the message. A
resume is treated as unavailable when it opened no thread, wrote no payload, was not killed by a
signal, and exited non-zero; the stderr line is matched only to name the cause in the degradation
notice the Orchestrator reads. Deciding on the message instead would break on the first wording
change, and — worse — deciding on "the run failed" would re-run a resume that got as far as a turn
and then failed, spending a second Delegation on the same failure.

The Delegation Budget is counted once for the pair. The Budget counts what was asked of the Worker's
provider, and a rollout lookup that fails locally never asks it.

## What is still unmeasured

- Whether `-c sandbox_mode=` on a resume beats the mode recorded in the session it resumes. `-c` is
  the highest-precedence config source in Codex's own ordering, so it should, but this needs a real
  resumable thread to confirm and is worth re-checking when it exists.
- Whether a thread expires from `~/.codex/sessions` on any schedule, which is what decides how often
  the fallback actually fires. The Ledger records `resumed` and `resume_unavailable` per Delegation
  so that this can be answered from use rather than guessed.
