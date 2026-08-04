---
description: Collect every Workspace this plugin has left on disk, unlanded ones included, and delete their branches
argument-hint: (no arguments)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" clean`

Above is what came of collecting the Workspaces. Each one that went took its branch with it, and an
unlanded diff lived on that branch and nowhere else — so what those Workers wrote is gone. A
Workspace whose Delegation is still running is left alone; its Worker is writing into it.

A branch whose Workspace directory has already been deleted is collected here too, in this
repository. Session end takes those only when the branch holds nothing the Worker committed.

Show the user what they asked for and stop there.

This is the user's command and the only thing that collects unlanded work. Session end collects far
less — a Workspace whose diff has already Landed, and one nothing was ever written into — because an
unlanded branch is the Worker's work rather than the plugin's litter. Do not run this for them, and
do not offer it as a way of tidying up after a Delegation you would rather they forgot.

The Result of every collected Delegation is still on disk: `/delegate:result <id>` has its summary
and its Verification Signal. The diff is not in it. If the user wanted a change that has just been
collected, say so plainly — it has to be delegated again, and that costs a Delegation.
