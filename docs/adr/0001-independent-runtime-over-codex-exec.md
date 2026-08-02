# Independent runtime over `codex exec`

OpenAI ships a first-party, well-tested Claude Code plugin for this exact integration
(`openai/codex-plugin-cc`), and the obvious move would be to depend on it or to copy its
transport. We are doing neither: this plugin spawns `codex exec --json --output-schema` from its
own bundled Runner. The reason is that our product is the policy — which Task Kind a request
becomes, what context is packaged into the prompt, which sandbox it runs under, what is allowed
back into the Orchestrator's context — and every one of those levers lives inside the very layer
we would be delegating away.

## Considered options

**Depend on `openai/codex-plugin-cc` as the runtime.** Rejected on a mechanical fact as much as a
design one: a plugin cannot reference files outside its own directory, `${CLAUDE_PLUGIN_ROOT}`
resolves to *our* root, and the other plugin's script sits at a version-stamped cache path
(`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs`) that changes on
every update. Reaching it means hard-coding a marketplace name, a plugin name, and a glob over
version directories. Even if that were solved, we would inherit its fixed CLI surface, its job
state format, and its `codex-rescue` agent's write-by-default posture, none of which we could
override.

**Drive `codex app-server` over JSON-RPC, as that plugin does.** Rejected because `codex --help`
labels the subcommand `[experimental]` and the Codex docs steer automation elsewhere ("For
automation jobs or CI environments, the Codex SDK is recommended instead"). It buys thread
lifecycle and approval callbacks; we need neither, because Delegations are either single-shot or
resumed through `codex exec resume`.

**Bundle Codex as an MCP server.** Rejected: `codex mcp-server` exposes two coarse tools whose
crate still describes itself as a prototype, its schemas would cost main-context tokens every
turn, and MCP calls made from a subagent never auto-background — while a Delegation routinely
runs for minutes.

## Consequences

We own the transport, including three undocumented behaviours found by measurement and easy to
regress on. `codex exec` hangs forever if it inherits an open stdin. It writes unrelated MCP
client errors to stderr, so stderr is not a failure signal. And it can exit `0` while its work
failed outright — observed during the [sandbox probe](../research/sandbox-nesting-probe.md), where
a Worker emitted `file_change` events, claimed success, and wrote nothing. Neither the exit code
nor stderr can be trusted alone: the Runner reconciles the JSONL event stream against the Worker's
own claims, and this is what a Verification Signal actually rests on.
