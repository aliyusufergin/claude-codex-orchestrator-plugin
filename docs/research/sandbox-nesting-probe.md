# Probe: does Codex's sandbox work inside Claude Code's sandbox?

**Linux (CachyOS, kernel 7.1.5), `codex-cli 0.146.0`, Claude Code `2.1.220`.**

This closes open question #1 of [claude-code-orchestrating-codex.md](./claude-code-orchestrating-codex.md).

Two runs, a day apart. The first said **no**. The second found the first had mismeasured the
cause: the answer is **yes, provided `/tmp` is writable**. Both runs are kept below, because the
first run's failure signature is what a user actually hits, and because the correction matters
more than the conclusion.

| Run | Date | `enableWeakerNestedSandbox` | Verdict |
| :-- | :-- | :-- | :-- |
| 1 | 2026-08-02 | `false` (default) | nesting fails; only `danger-full-access` works |
| 2 | 2026-08-03 | `false` and `true` | setting is irrelevant; a writable `/tmp` is what nesting needs |

## Run 1 — 2026-08-02, `enableWeakerNestedSandbox` unset (`false`)

Claude Code sandboxing was **not** enabled in the session that ran this probe, so the outer
sandbox was reconstructed by hand with `bubblewrap` — the same mechanism Claude Code uses on
Linux. Verified shape before testing Codex:

```
bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev --bind "$SCRATCH" "$SCRATCH"
  → writes to $HOME    : "Read-only file system"   (blocked, as Claude Code's sandbox blocks them)
  → writes to $SCRATCH : OK                        (the workspace bind, as Claude Code allows cwd)
```

### Results

Each run: `codex exec --json --ephemeral -C <git worktree> <prompt> < /dev/null`.

| # | Outer sandbox | `$CODEX_HOME` | `-s` | Outcome |
| :-- | :-- | :-- | :-- | :-- |
| A | none | writable | `workspace-write` | exit 0; file written; `command_execution` events present |
| B | bwrap | **read-only** | `workspace-write` | exit 1; dies before any event |
| C | bwrap | writable | `workspace-write` | **exit 0**; file *not* written; no `command_execution` |
| D | bwrap | writable | `danger-full-access` | exit 0; file written |
| E | bwrap | writable | `read-only` | shell execution blocked; fell back to MCP resource tools |

#### B — `$CODEX_HOME` must be writable, `--ephemeral` notwithstanding

```
WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)
Error: failed to initialize in-process app-server client: Read-only file system (os error 30)
```

Isolated by binding paths one at a time: `~/.codex` writable → starts; `/tmp` writable alone →
still fails. So a sandboxed user needs `sandbox.filesystem.allowWrite: ["~/.codex"]` for *any*
Delegation, not only for a resumed one. This also closes open question #9's practical half: the
requirement is identical for both Delegation Classes, so resume support adds no new permission.

Run 2 shows `~/.codex` is necessary but not sufficient: the allowlist is
`["~/.codex", "/tmp"]`. The two are needed by different layers and fail differently — see run 2's
caveats.

#### C — the dangerous one: silent failure with a zero exit code

Codex emitted two `file_change` items, reported success in its final message, and exited `0`.
The file did not exist. The only trace of the failure was on stderr:

```
ERROR codex_core::tools::router: error=Exit code: 1
Failed to write file .../ws-probe/probe-ok.txt
```

**The exit code is not a reliable failure signal.** The research document already established
that stderr is not one either (unrelated MCP client errors land there — reproduced again in every
run here). Neither channel can be trusted alone: the Runner must parse the JSONL event stream for
tool-router errors and reconcile them against the Worker's own claims.

#### D and E — it is Codex's sandbox layer that breaks, not bubblewrap

`danger-full-access` works nested (D), which rules out bubblewrap as the obstacle — the bind mount
is writable and Codex can use it. What fails is Codex's own sandbox layer initialising inside an
existing bubblewrap jail.

> **Corrected by run 2.** This section originally named Codex's *Landlock* layer as the thing that
> fails. That attribution was wrong, and it was load-bearing: it implied nothing could be done
> short of `danger-full-access`. Codex 0.146.0's Linux sandbox shells out to its own **bubblewrap**
> helper, and the helper dies for a mundane reason — no writable `/tmp`. See run 2.

E shows the breakage is not confined to writes. Under `read-only`, Codex reported *"The shell
reader is blocked by the environment's read-only sandbox setup"* and abandoned shell execution
entirely. Since running `git`, `grep`, and `cat` is how Codex investigates a repository, this
degrades Advisory Delegations as much as Verifiable ones.

## Run 2 — 2026-08-03, `enableWeakerNestedSandbox` `false` vs `true`

### What the setting actually does

Read out of Claude Code 2.1.220's Linux sandbox wrapper, which branches on it in exactly one place:

```js
$.push("--dev","/dev"); $.push("--unshare-pid");
if(!g) $.push("--unshare-user","--cap-drop","ALL","--proc","/proc");   // false (default)
else   $.push("--unshare-user","--bind","/proc","/proc");              // true
```

So it swaps a PID-namespace-scoped procfs for a bind of the **host** `/proc`, and drops
`--cap-drop ALL`. Confirmed to bite — inside the two shapes, `/proc/1/comm` reads `bwrap` vs
`systemd`, and `/proc` holds 5 vs 281 process entries. The capability half is a no-op here:
`CapEff` is already `0000000000000000` in both, because an unprivileged user namespace confers
none. The setting is therefore an *information-disclosure* relaxation, not a privilege one.

Run 1's reconstruction omitted `--cap-drop ALL`, `--new-session` and `--die-with-parent`. Run 2
uses Claude Code's exact argument set for both values of the setting, so any delta is attributable
to the setting alone.

### Results — `codex exec`, same five cases

Same command as run 1. `A` has no outer sandbox, so the setting cannot apply to it.

| # | Outer sandbox | `enableWeakerNestedSandbox` | `$CODEX_HOME` | `-s` | Outcome |
| :-- | :-- | :-- | :-- | :-- | :-- |
| A | none | n/a | writable | `workspace-write` | exit 0; file written; `command_execution` present |
| B | bwrap | `false` | **read-only** | `workspace-write` | exit 1; dies before any event |
| B | bwrap | **`true`** | **read-only** | `workspace-write` | exit 1; dies before any event — *identical* |
| C | bwrap | `false` | writable | `workspace-write` | exit 0; file *not* written; no `command_execution` |
| C | bwrap | **`true`** | writable | `workspace-write` | exit 0; file *not* written; no `command_execution` — *identical* |
| D | bwrap | `false` | writable | `danger-full-access` | exit 0; file written |
| D | bwrap | **`true`** | writable | `danger-full-access` | exit 0; file written — *identical* |
| E | bwrap | `false` | writable | `read-only` | shell execution blocked |
| E | bwrap | **`true`** | writable | `read-only` | shell execution blocked — *identical* |

**The setting changes nothing.** Every case reproduces run 1 under both values. Claude Code's
escape hatch for unprivileged containers is not an escape hatch for this collision, because the
collision was never about PID namespaces or capabilities.

### The actual cause, and the case run 1 never tried

Running case C again under `RUST_LOG=debug` produced the line the earlier run never surfaced:

```
thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:1214:13:
failed to open synthetic bubblewrap mount registry lock
/tmp/codex-bwrap-synthetic-mount-targets-1002/lock: Read-only file system (os error 30)
```

Every `exec_command` and `apply_patch` in that run logged `codex.sandbox_outcome … outcome=denied`
after ~40 ms — the helper never got far enough to enforce anything. Codex's Linux sandbox is
bubblewrap wrapping bubblewrap, and the inner one needs somewhere to build its mount targets.
Granting only the registry directory is not enough; it also mkdirs synthetic targets directly
under `/tmp`:

```
bwrap: Can't mkdir /tmp/.git: Read-only file system
```

Under Claude Code's sandbox `/tmp` is inside the `--ro-bind / /` and nothing rebinds it, so the
helper panics. Add `/tmp` to the write allowlist and the nesting works:

| # | Outer sandbox | `enableWeakerNestedSandbox` | `/tmp` | `-s` | Outcome |
| :-- | :-- | :-- | :-- | :-- | :-- |
| H1 | bwrap | `false` | **writable** | `workspace-write` | exit 0; **file written**; 6 `command_execution`; no panic |
| H2 | bwrap | `false` | **writable** | `workspace-write` | repeat of H1 — identical |
| H3 | bwrap | `false` | read-only | `workspace-write` | helper panic; 0 `command_execution`; no file |

### Confirming it without the model in the loop

`codex exec` results are noisy: the Worker is free to give up, mis-format an `apply_patch`, or
claim success. `codex sandbox` runs a command inside Codex's sandbox with no model at all, which
makes every cell deterministic and free. Probe: `touch ./sbx-ok` in the workspace, then
`touch $HOME/sbx-bad` to check the outer boundary still holds.

| `enableWeakerNestedSandbox` | `/tmp` | `-s` | helper panic | wrote cwd | `$HOME` still blocked |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `false` | read-only | `workspace-write` | **yes** | no | (nothing ran) |
| `false` | read-only | `read-only` | **yes** | no | (nothing ran) |
| `false` | writable | `workspace-write` | no | **yes** | yes |
| `false` | writable | `read-only` | no | no *(correct)* | yes |
| `true` | read-only | `workspace-write` | **yes** | no | (nothing ran) |
| `true` | read-only | `read-only` | **yes** | no | (nothing ran) |
| `true` | writable | `workspace-write` | no | **yes** | yes |
| `true` | writable | `read-only` | no | no *(correct)* | yes |

Baseline with no outer sandbox behaves the same as the `/tmp`-writable rows. Two conclusions:
the setting is irrelevant in all eight cells, and **a writable `/tmp` is both necessary and
sufficient** for Codex's own sandbox to initialise inside Claude Code's — in either mode.

The `$HOME still blocked` column is the one that matters for ADR-0004's safety argument: with
nesting working under `workspace-write`, the outer jail is still refusing writes outside the
workspace. Both sandboxes hold at once, which is the arrangement `danger-full-access` gives up.

### E revisited — `read-only` regains shell execution

With `/tmp` writable, the `read-only` case stops degrading. Codex ran shell commands
(`command_execution` events present, where run 1 had none) and correctly refused the write with
`patch rejected: writing is blocked by read-only sandbox`. Advisory Delegations do not need
`danger-full-access` either.

### Caveats on run 2

- **`$CODEX_HOME` writable is still required for `codex exec`** (case B, unchanged under both
  settings) — but *not* for `codex sandbox`, which initialises with `~/.codex` read-only. Two
  different layers fail: B is app-server startup, the panic is sandbox startup. Both must be
  satisfied for a Delegation.
- **Run 1's silent success did not reproduce.** Today's case C runs reported the failure honestly
  in the final message instead of claiming the file was written. The zero exit code with no work
  done *did* reproduce, so run 1's conclusion — the exit code is not a reliable signal — stands on
  its own evidence. Whether the Worker lies about it is model-dependent, which argues for
  reconciling the event stream rather than trusting either channel.
- **Do not put the probe workspace under `/tmp` when `/tmp` is bound writable.** Codex's helper
  manipulates `/tmp`, shadowed the worktree, and produced a convincing false silent-failure. That
  cost one wrong reading before the workspace was moved under `$HOME`.
- **One configuration was not deterministic**, and it is not one of the cases above. In the
  model-free `codex sandbox` matrix, `enableWeakerNestedSandbox: true` combined with a *read-only*
  `$CODEX_HOME` hung with no output in 2 of 3 attempts, and succeeded in the third. That
  combination is absent from the table because the table holds `$CODEX_HOME` writable throughout.
  It does not disturb case B: under `codex exec`, a read-only `$CODEX_HOME` failed the same way,
  exit 1 before any event, under both values of the setting. A corner of an already-broken
  configuration, not pursued.
- The host's `~/.codex` instructions wrap Worker shell commands in an unrelated proxy tool, which
  added noise to the `codex exec` runs. It affects both settings equally.

## Not specific to this plugin

`openai/codex-plugin-cc` 1.0.6 passes `sandbox: "read-only"` and `"workspace-write"`
(`scripts/codex-companion.mjs:491`, `scripts/lib/codex.mjs:68`) — the two modes that fail here
whenever `/tmp` is not writable, which is Claude Code's default. It performs no outer-sandbox
detection, and the string "sandbox" does not appear in its README. A sandboxed Claude Code session
running the first-party plugin hits case C or E, most likely without noticing.

Run 2 makes the fix cheaper than it looked: the plugin does not need a different sandbox mode, it
needs the user to allow writes to `/tmp`. That is a documentation problem more than a design one —
but nothing surfaces it, which is how it stays unnoticed.

The collision lives beneath any plugin: two products each ship a sandbox, and neither knows about
the other. See [ADR-0004](../adr/0004-disable-codex-sandbox-under-outer-sandbox.md) for what this
plugin does about it.

## Not covered

- **macOS.** Seatbelt-inside-Seatbelt is a different pairing and needs a separate machine. Tracked
  as [#16](https://github.com/aliyusufergin/claude-codex-orchestrator-plugin/issues/16). Note that
  run 2's cause is a Linux-specific implementation detail of Codex's sandbox helper, so it says
  nothing about what macOS does.
- **Network isolation.** The reconstructed sandbox shares the host network. Claude Code pre-allows
  no domains, so a genuinely sandboxed user may also need the OpenAI API host in
  `sandbox.network.allowedDomains`. Still untested.
- **Whether `/tmp` is enough for real work.** The probes write one small file. A Worker running a
  build or a test suite exercises far more of the filesystem, and may find further paths that
  Codex's helper needs.
- **A genuinely sandboxed Claude Code session.** Both runs reconstruct the outer sandbox by hand
  from Claude Code's own argument set rather than enabling its sandbox and delegating from inside
  it. The arguments match, but the reconstruction is not the product — the network isolation above
  and Claude Code's seccomp layer (absent on this machine, so never applied) both sit outside it.
  This is the Linux half of
  [#16](https://github.com/aliyusufergin/claude-codex-orchestrator-plugin/issues/16), and unlike
  the macOS half it needs no hardware anyone lacks.

## Reproducing

Run 1's failure — the case a sandboxed user hits today:

```bash
SCRATCH=$(mktemp -d) && git worktree add --detach "$SCRATCH/ws" HEAD
bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev \
      --bind "$SCRATCH" "$SCRATCH" --bind ~/.codex ~/.codex \
  codex exec --json -s workspace-write --ephemeral -C "$SCRATCH/ws" \
    'Create a file named probe-ok.txt containing exactly the word ok.' < /dev/null
echo "exit=$?"; cat "$SCRATCH/ws/probe-ok.txt"   # exit=0, and no such file
```

Run 2's correction — the same thing with `/tmp` writable, deterministic and free. Keep the
workspace out of `/tmp`; `--bind /proc /proc` in place of `--cap-drop ALL --proc /proc` selects
`enableWeakerNestedSandbox: true` and changes nothing:

```bash
WS=~/probe-ws && mkdir -p "$WS"
bwrap --new-session --die-with-parent --ro-bind / / --bind "$WS" "$WS" \
      --bind ~/.codex ~/.codex --bind /tmp /tmp \
      --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc \
  -- bash -c "cd '$WS' && codex sandbox -c sandbox_mode='\"workspace-write\"' \
       -- bash -c 'touch ./sbx-ok && echo WROTE_CWD; touch \$HOME/sbx-bad'"
# WROTE_CWD, and $HOME still "Read-only file system" — both sandboxes holding.
# Drop the --bind /tmp /tmp and it panics in linux_run_main.rs instead.
```
