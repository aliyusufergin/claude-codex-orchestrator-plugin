# `codex exec --json` — the event stream as it actually arrives

**Measured 2026-08-03 on `codex-cli 0.146.0`, Linux, unsandboxed outer process.** One real
Delegation, run because #6's reconciler was built on three unmeasured assumptions and merging it
would have shipped all three as guesses.

## What was run

A read-only run against a throwaway one-file git repository, with the Runner's own flags:

```bash
codex exec --json -s read-only -c model_reasoning_effort=low \
  --output-schema schemas/advisory.json -o payload.json -C <repo> \
  -- '<prompt>' < /dev/null
```

The prompt asked the Worker to create `probe-ok.txt` **first** and then read a source file — a
write that `-s read-only` is guaranteed to deny, so that a failed tool call and a successful one
appear in the same stream. `probe-ok.txt` did not exist afterwards. Exit code `0`.

## Finding 1 — a failed tool call leaves no trace in the event stream

The whole stream, seven lines, with the write attempt in it:

```
{"type":"thread.started","thread_id":"019fc78b-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"verdict\":\"concerns\",…}"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/zsh -lc \"sed -n '1,240p' token.js\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",…,"exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\"verdict\":\"blocking\",…}"}}
{"type":"turn.completed","usage":{…}}
```

There is **no item for the rejected write**. No `error` item, no `turn.failed`, no item carrying
`status: "failed"`. The only record of it is on stderr:

```
2026-08-03T12:13:54.910296Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings
```

This is the same channel and the same `codex_core::tools::router` signature the
[sandbox probe](./sandbox-nesting-probe.md) recorded for case C, reproduced here on an ordinary
unsandboxed run — so it is a property of the transport, not of sandbox nesting.

**Consequence for #6.** The acceptance criterion "the Runner parses the JSONL event stream and
treats tool-router errors as failures" is not implementable as written: the event stream does not
carry them. The Runner matches the `codex_core::tools::router` signature on stderr by name, and
reads the event stream for the failures that *do* appear there — a failed turn, an error event, an
error item, an item reporting `status: "failed"`. Both feed one reconciliation.

The unrelated MCP client noise reproduced on the same channel in the same run, which is why the
signature is matched by name rather than stderr being read for failure:

```
ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(…)
```

## Finding 2 — items are flat, not nested under `details`

Every item arrived with its detail fields directly on the item:

| event | item keys | `details` present |
| --- | --- | --- |
| `item.completed` | `id, type, text` | no |
| `item.started` | `id, type, command, aggregated_output, exit_code, status` | no |
| `item.completed` | `id, type, command, aggregated_output, exit_code, status` | no |

The [transport research](./claude-code-orchestrating-codex.md) describes `ThreadItemDetails` as a
tagged union under a `details` field; serde flattens it on the wire. The Runner reads the flat
shape and falls back to a nested `details` object if one ever appears — the cost is one expression,
and the cost of guessing wrong is a failure signal silently stopping being seen.

## Finding 3 — with `--output-schema`, the closing message is the payload

The final `agent_message.text` was the payload, double-encoded, byte-identical to what `-o` wrote
unwrapped. This confirms the existing transport fact, and settles what "what the Worker claimed"
can mean for reconciliation: quoting the closing message raw would put a JSON blob in the
Orchestrator's context, so the Runner quotes the `verdict` and `summary` out of it instead.

Note also that **two** `agent_message` items arrived: a preamble (`"verdict":"concerns"`, empty
findings, "I'll attempt the requested write first") and then the real Result. The last one is the
Result; a reconciler that keeps the first would quote a claim the Worker had already superseded.

## Finding 4 — a denied write during an Advisory run is indistinguishable from a silent failure

The Worker reported its own failure honestly here (`"verdict":"blocking"`, "Creating probe-ok.txt
failed because the workspace is read-only"), which is the behaviour run 2 of the sandbox probe also
saw and case C did not. Candour is model-dependent; the router signature is not.

But it exposed a false-failure class. An Advisory Delegation runs `read-only` by design, so *any*
write the Worker attempts is denied and emits this signature — and an Advisory Result is prose from
reading, which a denied write does not invalidate. Under the rule as first written that run's
Result was discarded and its Delegation Budget spent for nothing.

Resolved by the Delegation Class, on #6 (C7 in the [decision log](../design/delegate-decisions.md)):
for Advisory, a router error whose text names a policy denial of a write is reported on stderr and
is not a failure; every other router error still is, which is what keeps probe case E — where the
read-only sandbox stopped the Worker reading at all — a failure. For Verifiable the same denial is
the failure itself. A Review Delegation independently reached the same conclusion about this code,
at confidence 0.99.

## What is still unmeasured

- What a tool-router error looks like when the *outer* sandbox is real rather than absent — #16.
- Whether any tool failure ever does produce an `error` item. None was provoked here; the event
  stream branches in the Runner remain belt to stderr's braces.
