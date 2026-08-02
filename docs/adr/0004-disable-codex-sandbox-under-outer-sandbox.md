# Prefer Codex's own sandbox under an outer sandbox, with `danger-full-access` as fallback

> **Retitled and superseded in part, 2026-08-03.** This ADR was filed as *"Disable Codex's sandbox
> when Claude Code already provides one"*. That premise — that `danger-full-access` is the only
> configuration that works nested — was measured correctly but diagnosed wrongly. A second probe
> found Codex's sandbox nests fine under Claude Code's once `/tmp` is writable, so the decision
> inverted: keep both sandboxes, and fall back to `danger-full-access` only when the preconditions
> for nesting are missing. **The rule in force is the one under "Decision" below.** The original
> reasoning is kept after it, because the failure it describes is exactly what an unconfigured
> user still hits.

## Decision

Detection is unchanged: a write attempt outside the working directory at Runner startup. When that
says the Runner is sandboxed, it prefers to leave Codex's sandbox **on**. In order:

1. If `/tmp` and `$CODEX_HOME` are both writable, run Codex under **its own sandbox** —
   `read-only` for Advisory, `workspace-write` for Verifiable. Same modes as the unsandboxed case;
   the outer jail is then a second layer rather than the only one.
2. Otherwise fall back to `-s danger-full-access`, naming the missing precondition. This remains
   correct when the preconditions are absent, for the reason the original decision gives: the
   alternative is not "two layers" but "nothing runs".

It does **not** branch on Claude Code's `enableWeakerNestedSandbox`. Why the preference inverted,
and why that setting is irrelevant, is in "Amendment" below.

## Original decision, 2026-08-02 — superseded, kept for the failure it documents

*Everything in this section describes what was believed on 2026-08-02. Its central claim —
"the only configuration that works" — is false; read it as history, not as the rule.*

When the Runner detects that its own process is sandboxed, it invokes Codex with
`-s danger-full-access`. Read cold that looks indefensible, so: it was measured to be the only
configuration that works, and it does not lower the boundary that is actually holding.

Claude Code and Codex each ship a sandbox that knows nothing about the other. Starting Codex from
a sandboxed Bash call puts its sandbox layer inside an existing bubblewrap jail, where it cannot
initialise — and a Worker that cannot initialise its sandbox cannot run shell commands at all.
Measured on Linux ([probe](../research/sandbox-nesting-probe.md)): `workspace-write` reports
success and writes nothing, `read-only` loses shell execution and degrades into MCP resource
calls, `danger-full-access` works. The flag does not widen anything, because the outer jail is
enforcing the boundary either way — the probe confirms writes to `$HOME` stay blocked regardless
of what Codex is asked to do.

So the flag is conditional, never a default. With no outer sandbox there is no outer boundary to
rely on, and Codex runs under its own: `read-only` for Advisory, `workspace-write` for Verifiable.
Detection is a write attempt outside the working directory at Runner startup.

## Scope of the measurement

**Linux and bubblewrap only.** Both probe runs were done on Linux, where Claude Code wraps
commands in bubblewrap. macOS pairs Seatbelt with Seatbelt, a different collision with no reason
to behave alike — and the cause found in the amendment is a Linux-specific implementation detail
of Codex's sandbox helper, so it does not transfer. That half is open as
[#16](https://github.com/aliyusufergin/claude-codex-orchestrator-plugin/issues/16). Until it is
measured, this ADR's rule is a Linux conclusion applied everywhere by default.

**Reconstructed, not observed.** Neither run enabled Claude Code's sandbox and delegated from
inside it. Both rebuilt the outer sandbox by hand from Claude Code 2.1.220's own `bwrap` argument
set — run 2 matching it exactly, including the branch this ADR's amendment turns on. The arguments
are right, but a reconstruction is not the product: anything Claude Code does outside that argv,
network isolation included, is unmeasured. Weigh the rule accordingly.

## Amendment — the obstacle is a read-only `/tmp`

Two things changed on 2026-08-03.

**Claude Code's `enableWeakerNestedSandbox` is irrelevant here.** It was worth checking, since it
exists precisely to let a nested sandbox initialise. It swaps a namespace-scoped procfs for a bind
of the host `/proc` and drops `--cap-drop ALL`; it does not touch what Codex needs. The probe's
cases A–E behave identically under both values, as does every cell of its model-free matrix.
**The selection rule does not branch on that setting.**

**The real obstacle is mundane.** Codex 0.146.0's Linux sandbox is itself bubblewrap-based, and
its helper builds synthetic mount targets under `/tmp`. Claude Code's sandbox leaves `/tmp` inside
its read-only root, so the helper panics before enforcing anything:

```
linux-sandbox/src/linux_run_main.rs:1214:13:
failed to open synthetic bubblewrap mount registry lock
/tmp/codex-bwrap-synthetic-mount-targets-<uid>/lock: Read-only file system (os error 30)
```

With `/tmp` writable, nested `workspace-write` writes to the working directory and nested `read-only`
regains shell execution — while the outer jail still refuses writes to `$HOME`. This is the
outcome the original decision assumed was unavailable: **both sandboxes enforcing at once.**

So the rule inverts its preference, to the ordering under "Decision" above.

The Runner's sandbox selection is not implemented yet (`scripts/runner.mjs:11` lists it as
pending), so nothing is being changed silently. The rule above is the specification it must be
built to, tracked on
[#4](https://github.com/aliyusufergin/claude-codex-orchestrator-plugin/issues/4).

**Do not put the Workspace under `/tmp`.** Granting `/tmp` hands it to Codex's helper, which mounts
over paths inside it. During the probe a worktree living under `/tmp` was shadowed by those mounts:
the Worker wrote its file, reported success truthfully, and the file was absent afterwards — the
`workspace-write` silent failure exactly reproduced, from an unrelated cause. `scripts/runner.mjs:73`
currently creates its scratch directory under `tmpdir()`, so this becomes live the moment the
preferred path is implemented. The Workspace belongs somewhere the inner sandbox does not
manipulate.

## Consequences

Sandboxed users must allow writes to **`~/.codex`** and **`/tmp`**. Codex fails to start without
the first — before any event is emitted, `--ephemeral` or not — and its sandbox helper panics
without the second. Both are preconditions for every Delegation, not just for a resumed one.
Neither is a boundary that matters much: `/tmp` is scratch space, and the outer jail keeps holding
the line that does.

The trade the original decision accepted — the outer sandbox becoming load-bearing alone, where
previously two independent layers had to fail — now applies only to the fallback path. On the
preferred path both layers are back, which is what makes the fallback worth avoiding rather than
merely worth explaining.

The README still has to explain a frightening flag honestly rather than hide it, including the
part where a user who disables Claude Code's sandbox *and* trusts this plugin's default is running
Codex with its own sandbox on — the safe case, and the opposite of what the flag name suggests. It
now also has to document the two write allowances, since they are what keeps a user off the
fallback path entirely.
