# Disable Codex's sandbox when Claude Code already provides one

When the Runner detects that its own process is sandboxed, it invokes Codex with
`-s danger-full-access`. Read cold that looks indefensible, so: it is the *only* configuration
that works, and it does not lower the boundary that is actually holding.

Claude Code and Codex each ship a sandbox that knows nothing about the other. Starting Codex from
a sandboxed Bash call puts its Landlock layer inside an existing bubblewrap jail, where it cannot
initialise — and a Worker that cannot initialise its sandbox cannot run shell commands at all.
Measured on Linux ([probe](../research/sandbox-nesting-probe.md)): `workspace-write` reports
success and writes nothing, `read-only` loses shell execution and degrades into MCP resource
calls, `danger-full-access` works. The flag does not widen anything, because the outer jail is
enforcing the boundary either way — the probe confirms writes to `$HOME` stay blocked regardless
of what Codex is asked to do.

So the flag is conditional, never a default. With no outer sandbox there is no outer boundary to
rely on, and Codex runs under its own: `read-only` for Advisory, `workspace-write` for Verifiable.
Detection is a write attempt outside the working directory at Runner startup.

## Consequences

Sandboxed users must also allow writes to `~/.codex`. Codex fails to start without it — before
any event is emitted, `--ephemeral` or not — so this is a precondition for every Delegation, not
just for a resumed one.

The outer sandbox becomes load-bearing in a way it was not before. Previously two independent
layers had to fail for a Worker to escape; now one does. That trade is only acceptable because
the alternative is not "two layers" but "nothing runs".

The README has to explain a frightening flag honestly rather than hide it, including the part
where a user who disables Claude Code's sandbox *and* trusts this plugin's default is running
Codex with its own sandbox on — which is the safe case, and the opposite of what the flag name
suggests.
