---
description: Show the Delegation Budget — what this window has spent, what is left, and the numbers behind it — and raise the ceiling
argument-hint: [new-ceiling]
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" quota "$1"`

Above is the Delegation Budget: how many Delegations this rolling window holds, the ceiling they
are counted against, and the four numbers the Runner enforces. Every one of those numbers is
provisional — none has been calibrated against real usage yet.

Show the user what they asked for and stop there.

The ceiling is the one place this bound is negotiable, and it is negotiable by the user, not by
you. If the Budget is exhausted, say so and say when the window frees up; do not raise the ceiling
on their behalf, and do not suggest working around the Budget by delegating from a different
directory or by turning the dedup cache off. A Delegation refused for want of Budget is a
Delegation not made — never one you make yourself instead.
