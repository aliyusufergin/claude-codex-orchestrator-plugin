# Probe: does Codex's sandbox work inside Claude Code's sandbox?

**Date: 2026-08-02. Linux (CachyOS, kernel 7.1.5), `codex-cli 0.146.0`, Claude Code `2.1.220`.**

This closes open question #1 of [claude-code-orchestrating-codex.md](./claude-code-orchestrating-codex.md).
The answer is **no**, and the failure is quieter than expected.

Claude Code sandboxing was **not** enabled in the session that ran this probe, so the outer
sandbox was reconstructed by hand with `bubblewrap` — the same mechanism Claude Code uses on
Linux. Verified shape before testing Codex:

```
bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev --bind "$SCRATCH" "$SCRATCH"
  → writes to $HOME    : "Read-only file system"   (blocked, as Claude Code's sandbox blocks them)
  → writes to $SCRATCH : OK                        (the workspace bind, as Claude Code allows cwd)
```

## Results

Each run: `codex exec --json --ephemeral -C <git worktree> <prompt> < /dev/null`.

| # | Outer sandbox | `$CODEX_HOME` | `-s` | Outcome |
| :-- | :-- | :-- | :-- | :-- |
| A | none | writable | `workspace-write` | exit 0; file written; `command_execution` events present |
| B | bwrap | **read-only** | `workspace-write` | exit 1; dies before any event |
| C | bwrap | writable | `workspace-write` | **exit 0**; file *not* written; no `command_execution` |
| D | bwrap | writable | `danger-full-access` | exit 0; file written |
| E | bwrap | writable | `read-only` | shell execution blocked; fell back to MCP resource tools |

### B — `$CODEX_HOME` must be writable, `--ephemeral` notwithstanding

```
WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)
Error: failed to initialize in-process app-server client: Read-only file system (os error 30)
```

Isolated by binding paths one at a time: `~/.codex` writable → starts; `/tmp` writable alone →
still fails. So a sandboxed user needs `sandbox.filesystem.allowWrite: ["~/.codex"]` for *any*
Delegation, not only for a resumed one. This also closes open question #9's practical half: the
requirement is identical for both Delegation Classes, so resume support adds no new permission.

### C — the dangerous one: silent failure with a zero exit code

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

### D and E — it is Codex's sandbox layer that breaks, not bubblewrap

`danger-full-access` works nested (D), which rules out bubblewrap as the obstacle — the bind mount
is writable and Codex can use it. What fails is Codex's own Landlock layer initialising inside an
existing bubblewrap jail.

E shows the breakage is not confined to writes. Under `read-only`, Codex reported *"The shell
reader is blocked by the environment's read-only sandbox setup"* and abandoned shell execution
entirely. Since running `git`, `grep`, and `cat` is how Codex investigates a repository, this
degrades Advisory Delegations as much as Verifiable ones.

## Not specific to this plugin

`openai/codex-plugin-cc` 1.0.6 passes `sandbox: "read-only"` and `"workspace-write"`
(`scripts/codex-companion.mjs:491`, `scripts/lib/codex.mjs:68`) — the two modes that fail here.
It performs no outer-sandbox detection, and the string "sandbox" does not appear in its README.
A sandboxed Claude Code session running the first-party plugin hits case C or E, most likely
without noticing.

The collision lives beneath any plugin: two products each ship a sandbox, and neither knows about
the other. See [ADR-0004](../adr/0004-disable-codex-sandbox-under-outer-sandbox.md) for what this
plugin does about it.

## Not covered

- **macOS.** Seatbelt-inside-Seatbelt is a different pairing and needs a separate machine.
- **Network isolation.** The reconstructed sandbox shares the host network. Claude Code pre-allows
  no domains, so a genuinely sandboxed user may also need the OpenAI API host in
  `sandbox.network.allowedDomains`. Untested.
- **`enableWeakerNestedSandbox`.** Whether Claude Code's own escape hatch for unprivileged
  containers changes any of the above.

## Reproducing

```bash
SCRATCH=$(mktemp -d) && git worktree add --detach "$SCRATCH/ws" HEAD
bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev \
      --bind "$SCRATCH" "$SCRATCH" --bind ~/.codex ~/.codex \
  codex exec --json -s workspace-write --ephemeral -C "$SCRATCH/ws" \
    'Create a file named probe-ok.txt containing exactly the word ok.' < /dev/null
echo "exit=$?"; cat "$SCRATCH/ws/probe-ok.txt"   # exit=0, and no such file
```
