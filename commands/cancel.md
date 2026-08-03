---
description: Stop a running Delegation, leaving whatever its Worker had already written in the Workspace
argument-hint: <delegation-id>
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" cancel "$1"`

Above is what came of stopping that Delegation. The Worker is killed, the Runner reports the
cancellation on its own output, and whatever had already been written stays in the Workspace — a
Workspace holding nothing is removed along with its branch.

Show the user what they asked for and stop there.

The Delegation still counts against the Delegation Budget. It counts what was asked of the Worker's
provider, and cancelling does not un-ask it — so do not re-run the same request expecting it to be
free, and do not suggest raising the ceiling to make room for the retry.

A cancelled Delegation produced no Result. Do not describe what it would have done, and do not do
the work yourself in its place unless the user asks for that.
