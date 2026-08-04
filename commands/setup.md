---
description: Check that delegation can run at all — binary, login, the write allowances a sandboxed session needs, the Budget — and show the configuration behind it
argument-hint: (no arguments)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" ready --setup`

Above is what the plugin measured about this machine and this session, plus the configuration in
force: the four numbers the Runner enforces and where each came from, what a Worker's environment
carries, and where the plugin's state lives. The same readiness check runs at session start; this
is it on demand, with the configuration attached.

Show the user what they asked for and stop there.

Everything under **What to do** is the user's to do. Do not run `codex login` for them, do not edit
their Claude Code settings to add a `sandbox.filesystem.allowWrite` or `sandbox.network.allowedDomains`
entry, do not raise the Delegation Budget ceiling, and do not set `$DELEGATE_ENV_ALLOWLIST` on their
behalf — every one of those is a decision about what a third-party agent is allowed to see or spend,
and the plugin's whole point is that those decisions are made deliberately.

If a check failed, delegation does not work yet. Say so plainly and quote the remedy; do not delegate
anyway to see what happens, and do not do the delegated work yourself instead unless the user asks
for that.

A warning is not a failure. A spent Budget frees up on its own, an unreachable provider host may
still be reachable through a proxy this probe cannot see, and the unverified-platform notice on
macOS is a statement about what has been measured — not a fault to fix.
