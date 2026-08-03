---
description: List Delegations that are still running and ones that finished recently, including work started in an earlier session
argument-hint: (no arguments)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" status`

Above is what the Runner knows about: Delegations still running, with the Workspace and branch each
one is working in, and the ones that finished recently. A Verifiable Delegation runs for minutes and
does not block the session that started it, so this is where it is visible while it works — and a
Delegation that outlived its session is listed here and retrievable by id afterwards.

Show the user what they asked for and stop there.

Do not read a Workspace listed here, do not run `git` against one, and do not describe what a
running Delegation is doing. It has not finished, and there is no Result until it has. Its Result
arrives on its own when the Worker is done; `/delegate:result <id>` retrieves it afterwards if that
notification never comes.
