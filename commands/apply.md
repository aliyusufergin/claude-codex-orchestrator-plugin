---
description: Land a finished Delegation's diff into the working tree by hand, including one whose Workspace has gone Stale
argument-hint: <delegation-id>
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" land "$1" --manual`

Above is what came of Landing that Delegation by hand. The diff in its Workspace was applied to the
working tree, unstaged and uncommitted, so `git diff` reads it and `git checkout --` throws it away.
The Workspace and its branch are left in place.

This is the escape hatch, not the normal path. The autonomous Landing refuses a **Stale Workspace** —
one whose `HEAD` or uncommitted state has moved since it was seeded, so its diff can no longer be
checked against present reality — and refuses a diff past the size threshold, where reading it would
cost more than the Delegation saved. This command is how the user overrides both, and it is the
user's decision to make, never yours: do not run it for them, and do not suggest it as a way past a
refusal you were given.

Show the user what they asked for and stop there.

A Landing is not a review. The Verification Signal in that Result is the Worker's report on its own
work and never on its own licenses a Landing — a Worker asked to make tests pass can satisfy that by
changing the tests. If the user asks whether what Landed is sound, read the diff in their working
tree and say what you found; do not answer from the signal.
