# Claude Code as orchestrator, OpenAI Codex as delegated agent

**Research date: 2026-08-02.**
**Versions observed at time of research:** Claude Code `2.1.220` (local `claude --version`); Codex CLI `codex-cli 0.146.0` (local `codex --version`); latest `openai/codex` release tag `rust-v0.146.0`, published 2026-07-29 (`GET https://api.github.com/repos/openai/codex/releases/latest`); `openai/codex-plugin-cc` at commit `db52e28f4d9ded852ab3942cea316258ae4ef346` (2026-07-07), plugin version `1.0.6`.

Both products ship on a fast release cadence and both docs sites moved hosts during this research (`docs.claude.com/en/docs/claude-code/*` → `code.claude.com/docs/en/*` via 301; `developers.openai.com/codex/*` → `learn.chatgpt.com/docs/*` via 308). Everything below is version-sensitive; sections flagged **[fast-moving]** are the ones most likely to drift.

---

## Summary / recommendation

**Build a Claude Code plugin that ships (a) one subagent whose only job is to shell out to a bundled Node script, (b) that script, which drives Codex over a long-lived process rather than a per-call `codex exec` fork, and (c) a small set of slash commands plus an optional `Stop` hook.** This is exactly the shape OpenAI itself shipped in `openai/codex-plugin-cc` (30,933 stars, Apache-2.0, described as "Use Codex from Claude Code to review code or delegate tasks" — `GET https://api.github.com/repos/openai/codex-plugin-cc`), and the convergence is not accidental: a subagent gives you a separate context window so Codex's verbose output never enters the main conversation ([Subagents](https://code.claude.com/docs/en/sub-agents)), while a single bundled script collapses the whole integration behind one allowlist entry (`Bash(node:*)`) instead of a permission-prompt storm.

**Do not** wrap Codex as a bundled MCP server unless you need Codex tools visible to the main thread. `codex mcp-server` exists and works, but its crate is annotated `//! Prototype MCP server.` (`openai/codex codex-rs/mcp-server/src/lib.rs:1`), it exposes only two coarse tools (`codex`, `codex-reply` — `openai/codex codex-rs/mcp-server/src/message_processor.rs:341-357`), and MCP tool schemas cost main-context tokens on every turn while a subagent's description costs only a line.

**Choose the transport deliberately.** `codex exec --json` is the stable, documented headless surface with a typed JSONL event stream and an `--output-schema` flag for structured output. `codex app-server` is richer (thread lifecycle, streamed events, approval callbacks) and is what OpenAI's own plugin uses, but `codex --help` labels it `[experimental]`. Recommendation: build against `codex exec --json --output-schema` first, keep the app-server path behind an interface, and revisit when app-server stabilizes.

---

## 1. Claude Code's extension surfaces

### 1.1 Plugins

A plugin is "a self-contained directory of components that extends Claude Code with custom functionality. Plugin components include skills, agents, hooks, MCP servers, LSP servers, and monitors" ([plugins-reference](https://code.claude.com/docs/en/plugins-reference)).

Manifest lives at `.claude-plugin/plugin.json`. It is **optional** — "If omitted, Claude Code auto-discovers components in default locations and derives the plugin name from the directory name" ([plugins-reference § Plugin manifest schema](https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema)). If present, `name` is the only required field.

Full schema, copied verbatim ([plugins-reference § Complete schema](https://code.claude.com/docs/en/plugins-reference#complete-schema)):

```json
{
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors.json"
  },
  "dependencies": [
    "helper-lib",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ]
}
```

Default component locations ([plugins-reference § File locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)):

| Component | Default Location |
| :--- | :--- |
| Manifest | `.claude-plugin/plugin.json` |
| Skills | `skills/` (`<name>/SKILL.md`) |
| Commands | `commands/` (flat `.md`) |
| Agents | `agents/` |
| Hooks | `hooks/hooks.json` |
| MCP servers | `.mcp.json` |
| LSP servers | `.lsp.json` |
| Monitors | `monitors/monitors.json` |
| Executables | `bin/` — "Executables added to the Bash tool's `PATH`. Files here are invokable as bare commands in any Bash tool call while the plugin is enabled" |
| Settings | `settings.json` — "Only the `agent` and `subagentStatusLine` keys are currently supported" |

> **Warning from the docs**: "The `.claude-plugin/` directory contains the `plugin.json` file. All other directories (commands/, agents/, skills/, workflows/, output-styles/, themes/, monitors/, hooks/) must be at the plugin root, not inside `.claude-plugin/`." ([plugins-reference § Standard plugin layout](https://code.claude.com/docs/en/plugins-reference#standard-plugin-layout))

Path variables available to plugin components ([plugins-reference § Environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)):

| Variable | Resolves to |
| :--- | :--- |
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path to the plugin's installation directory |
| `${CLAUDE_PLUGIN_DATA}` | Persistent directory that survives plugin updates, `~/.claude/plugins/data/{id}/` |
| `${CLAUDE_PROJECT_DIR}` | The project root |

Two constraints that matter a lot for an external-agent wrapper:

- **Plugins are copied into a cache.** "Claude Code copies *marketplace* plugins to the user's local **plugin cache** (`~/.claude/plugins/cache`) rather than using them in-place." ([plugins-reference § Plugin caching and file resolution](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution))
- **No path traversal out of the plugin.** "Installed plugins cannot reference files outside their directory. Paths that traverse outside the plugin root (such as `../shared-utils`) will not work after installation." (same section)
- **`${CLAUDE_PLUGIN_ROOT}` changes on update.** "The previous version's directory remains on disk for about two weeks after an update before cleanup, but treat it as ephemeral and don't write state there." (same section) → put job state in `${CLAUDE_PLUGIN_DATA}`, which is what `openai/codex-plugin-cc` does (`openai/codex-plugin-cc plugins/codex/scripts/lib/state.mjs:9-43`, `const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA"` with an `os.tmpdir()/codex-companion` fallback).

If your plugin bundles a Node runtime dependency, the documented pattern is a `SessionStart` hook that diffs the bundled `package.json` against a copy in `${CLAUDE_PLUGIN_DATA}` and reinstalls when they differ ([plugins-reference § Persistent data directory](https://code.claude.com/docs/en/plugins-reference#persistent-data-directory)).

### 1.2 Skills

Skills follow the [Agent Skills](https://agentskills.io) open standard; Claude Code extends it with invocation control, subagent execution, and dynamic context injection ([skills](https://code.claude.com/docs/en/skills)).

Minimal frontmatter, verbatim from the docs ([skills § Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference)):

```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: true
allowed-tools: Read Grep
---

Your skill instructions here...
```

Fields relevant to delegating to an external agent:

| Field | Meaning ([skills § Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference)) |
| :--- | :--- |
| `description` | "What the skill does and when to use it… the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing to reduce context usage." |
| `disable-model-invocation` | "Set to `true` to prevent Claude from automatically loading this skill. Use for workflows you want to trigger manually with `/name`." |
| `allowed-tools` | "Tools Claude can use without asking permission during the turn that invokes this skill. **The grant clears when you send your next message.**" |
| `disallowed-tools` | "Tools removed from Claude's available pool while this skill is active." |
| `context` | "Set to `fork` to run in a forked subagent context." |
| `agent` | "Which subagent type to use when `context: fork` is set." |
| `background` | "Only applies with `context: fork`. Set to `false` to wait for the forked subagent's result in the turn that invoked the skill… Default: `true`. Requires Claude Code v2.1.218 or later." |
| `model`, `effort` | Override model / effort while the skill is active. |

**Progressive disclosure** is the whole point of the skill mechanism: "Unlike CLAUDE.md content, a skill's body loads only when it's used, so long reference material costs almost nothing until you need it." ([skills](https://code.claude.com/docs/en/skills)) The listing (name + truncated description) is always-on; the body is on-invoke.

**Skill content lifecycle — important gotcha:** "When you or Claude invoke a skill, the rendered `SKILL.md` content enters the conversation as a single message and **stays there for the rest of the session**… Claude Code does not re-read the skill file on later turns." ([skills § Skill content lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle)) So a big skill body is a permanent context cost once triggered.

**`allowed-tools` is turn-scoped, not session-scoped.** "The grant clears when you send your next message, even though the skill content stays in context… To pre-approve tools for the whole session rather than a single turn, add allow rules to those permission settings instead." ([skills § Pre-approve tools for a skill](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill)) This is the single biggest reason a skill alone is not sufficient for a "call Codex repeatedly" workflow.

Example of a real `allowed-tools` line from OpenAI's plugin (`openai/codex-plugin-cc plugins/codex/commands/review.md`):

```yaml
---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---
```

Naming: a plugin skill at `my-plugin/skills/review/SKILL.md` becomes `/my-plugin:review`; frontmatter `name: fancy` makes it `/my-plugin:fancy` ([skills § How a skill gets its command name](https://code.claude.com/docs/en/skills#how-a-skill-gets-its-command-name)).

Useful substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}` ([skills § Available string substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions)).

### 1.3 Subagents

"Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions. When Claude encounters a task that matches a subagent's description, it delegates to that subagent, which works independently and returns results." ([sub-agents](https://code.claude.com/docs/en/sub-agents))

File format ([sub-agents § Write subagent files](https://code.claude.com/docs/en/sub-agents#write-subagent-files)):

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

"Subagents receive only this system prompt plus basic environment details like the working directory, **not** the full Claude Code system prompt." (same section)

Full frontmatter field list ([sub-agents § Supported frontmatter fields](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)) — only `name` and `description` are required:

| Field | Notes |
| :--- | :--- |
| `name` | "Unique identifier using lowercase letters and hyphens… Names can't contain `:`, which is reserved for plugin-scoped identifiers such as `my-plugin:reviewer`" (v2.1.218+) |
| `description` | "When Claude should delegate to this subagent" |
| `tools` | Allowlist. "Inherits every tool available to subagents if omitted." |
| `disallowedTools` | Denylist, applied before `tools` |
| `model` | `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit` (default) |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual`. **"Ignored for plugin subagents"** |
| `maxTurns` | Max agentic turns |
| `skills` | Skills preloaded into the subagent's context at startup — "The full skill content is injected, not only the description" |
| `mcpServers` | **"Ignored for plugin subagents"** |
| `hooks` | **"Ignored for plugin subagents"** |
| `memory` | `user`, `project`, or `local` — persistent memory directory |
| `background` | `true` to always run as a background task |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| `isolation` | "Set to `worktree` to run the subagent in a temporary git worktree… branched by default from your default branch rather than the parent session's `HEAD`. The worktree is automatically cleaned up if the subagent makes no changes." |
| `color` | Display color |
| `initialPrompt` | First user turn when run as main session agent |

**Plugin-shipped agents are a restricted subset.** "Plugin agents support `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, and `isolation` frontmatter fields. The only valid `isolation` value is `"worktree"`. For security reasons, `hooks`, `mcpServers`, and `permissionMode` are not supported for plugin-shipped agents." ([plugins-reference § Agents](https://code.claude.com/docs/en/plugins-reference#agents))

**How the main agent decides to delegate:** "Claude automatically delegates tasks based on the task description in your request, the `description` field in subagent configurations, and current context. To encourage proactive delegation, include phrases like 'use proactively' in your subagent's description field." ([sub-agents § Understand automatic delegation](https://code.claude.com/docs/en/sub-agents#understand-automatic-delegation)) Explicit invocation is via natural language, `@agent-<name>` / `@agent-my-plugin:code-reviewer`, or `--agent <name>` for the whole session.

**What comes back:** only the subagent's final report. "By delegating these to a subagent, the verbose output stays in the subagent's context while only the relevant summary returns to your main conversation." ([sub-agents § Isolate high-volume operations](https://code.claude.com/docs/en/sub-agents#isolate-high-volume-operations)) With a caveat: "When subagents complete, their results return to your main conversation. Running many subagents that each return detailed results can consume significant context." (same section)

**Background is now the default** (v2.1.198+): "As of v2.1.198, subagents run in the background by default. Claude runs a subagent in the foreground when it needs the result before continuing." ([sub-agents § Run subagents in foreground or background](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background))

**Background subagents get a reduced tool set** — critical if your subagent needs anything beyond Bash. "Apart from `Agent` and `ExitPlanMode`… a background subagent keeps every MCP tool but only these built-in tools: `Read`, `Grep`, `Glob`, `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage`, and `Artifact`." ([sub-agents § Available tools](https://code.claude.com/docs/en/sub-agents#available-tools)) `Bash` survives, which is all a Codex forwarder needs. `AskUserQuestion` is removed from **every** subagent (same section).

**Subagent output scanning** (v2.1.210+) is relevant because Codex output is untrusted text flowing into Claude's context: "Claude Code scans each subagent's final report before Claude reads it… the scan inserts a backslash into text that imitates Claude Code's own output, such as a `<system-reminder>` tag… [and] prepends a line starting with `[harness: subagent output matched instruction-shaped pattern(s):`". Crucially: "The scan doesn't judge whether content is malicious, and it doesn't change what an instruction in a report can do." ([sub-agents § Subagent output scanning](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning))

**API-error handling** (v2.1.199+): a subagent cut off by a rate limit returns partial output with a note in the foreground; in the background it is "marked failed, and the message Claude receives when it ends names the API error and includes the subagent's last output." ([sub-agents § API errors in subagents](https://code.claude.com/docs/en/sub-agents#api-errors-in-subagents))

### 1.4 Slash commands

Custom commands have been merged into skills: "A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way." ([skills](https://code.claude.com/docs/en/skills)) In a plugin, `commands/` holds flat `.md` files and `skills/` holds `<name>/SKILL.md` directories; the docs say "Use `skills/` for new plugins" ([plugins-reference § File locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)).

Both are namespaced `/<plugin-name>:<command>`.

For an orchestrator plugin, slash commands are the right surface for *user-initiated* delegation (`/codex:review`, `/codex:status`) because `disable-model-invocation: true` keeps them out of Claude's autonomous toolkit while still costing only a listing line. OpenAI's plugin uses exactly this split: `review.md`, `status.md`, `result.md`, `cancel.md`, `transfer.md`, `adversarial-review.md` all set `disable-model-invocation: true`, while `rescue.md` does not (`openai/codex-plugin-cc plugins/codex/commands/*.md`).

### 1.5 Hooks

Plugin hooks live in `hooks/hooks.json` at plugin root or inline in `plugin.json`. Format ([plugins-reference § Hooks](https://code.claude.com/docs/en/plugins-reference#hooks)):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

**Event list** (from [plugins-reference § Hooks](https://code.claude.com/docs/en/plugins-reference#hooks) and [hooks](https://code.claude.com/docs/en/hooks)): `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

**Hook types**: `command`, `http`, `mcp_tool`, `prompt`, `agent` ([plugins-reference § Hooks](https://code.claude.com/docs/en/plugins-reference#hooks)).

**JSON I/O contract.** Every hook receives JSON on stdin ([hooks](https://code.claude.com/docs/en/hooks)):

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "effort": { "level": "low|medium|high|xhigh|max" },
  "hook_event_name": "EventName"
}
```

Inside a subagent, hooks additionally receive `agent_id` and `agent_type` ([hooks](https://code.claude.com/docs/en/hooks)).

**Exit codes** ([hooks](https://code.claude.com/docs/en/hooks)):

- **0** — success. "Claude Code parses stdout for JSON output. On most events, stdout goes to debug log only. Exception: `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` — stdout added as context Claude can see. JSON output is only processed on exit 0."
- **2** — blocking error. "Blocks the action (behavior depends on event type). stderr text fed to Claude as error message. JSON output ignored; use stderr for the reason." For `Stop`: "Prevents stopping, continues conversation."
- **anything else** — non-blocking error; execution continues, transcript shows `<hook name> hook error`.

**JSON output on exit 0** ([hooks](https://code.claude.com/docs/en/hooks)):

```json
{
  "continue": true,
  "stopReason": "Optional message when continue=false",
  "suppressOutput": false,
  "systemMessage": "Warning message shown to user",
  "decision": "block",
  "reason": "Why blocked (for top-level decision events)",
  "hookSpecificOutput": {
    "hookEventName": "EventName",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "Reason text",
    "additionalContext": "Context for Claude",
    "updatedInput": { "command": "modified input" },
    "updatedToolOutput": "modified output",
    "retry": true
  }
}
```

**Timeouts** ([hooks](https://code.claude.com/docs/en/hooks)): `command`/`http`/`mcp_tool` default 600s (30s for `UserPromptSubmit`, 10s for `MessageDisplay`); `prompt` 30s; `agent` 60s. `SessionEnd` hooks share a 1.5-second budget that can be raised to at most 60s.

**Exec form vs shell form** matters for passing plugin paths safely ([hooks § Exec form and shell form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form)). Exec form (set `args`) spawns directly with no shell: "no pipes, `&&`, globs, or variable expansion… Each `args` element is one argument exactly as written." Shell form (omit `args`) goes through `sh -c`.

**Real-world use for a Codex orchestrator** — OpenAI's plugin registers three hooks (`openai/codex-plugin-cc plugins/codex/hooks/hooks.json`):

```json
{
  "description": "Optional stop-time review gate for Codex Companion.",
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"", "timeout": 900 }] }
    ]
  }
}
```

The `Stop` hook reads `last_assistant_message` from the hook input, runs Codex, and emits `{"decision":"block","reason":"…"}` to force Claude to keep working (`openai/codex-plugin-cc plugins/codex/scripts/stop-review-gate-hook.mjs`, functions `buildStopReviewPrompt` and `emitDecision`). Its README carries an explicit warning: "The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session." (`openai/codex-plugin-cc README.md`)

**Hooks that target the plugin's own MCP server must use scoped names**: "Tool matchers and `if` fields take the scoped tool name `mcp__plugin_<plugin-name>_<server-name>__<tool>`, and an `mcp_tool` hook's `server` field takes `plugin:<plugin-name>:<server-name>`. A matcher written against the bare server key never fires." ([plugins-reference § Hooks](https://code.claude.com/docs/en/plugins-reference#hooks))

### 1.6 MCP servers (as a way to expose Codex as a tool)

Claude Code supports four transports: `stdio`, `http`, `sse`, `ws` ([mcp § Installing MCP servers](https://code.claude.com/docs/en/mcp#installing-mcp-servers)).

Bundling inside a plugin — `.mcp.json` at plugin root ([mcp § Plugin-provided MCP servers](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers)):

```json
{
  "mcpServers": {
    "database-tools": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_URL": "${DB_URL}"
      }
    }
  }
}
```

Tool naming: "The full form is `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`, where any character outside `A-Z`, `a-z`, `0-9`, `_`, and `-` is replaced with `_`." e.g. `mcp__plugin_my-plugin_database-tools__query`. "The server itself registers under the scoped name `plugin:<plugin-name>:<server-name>`." (same section)

Lifecycle: "Plugin MCP servers start automatically when the plugin is enabled." ([plugins-reference § MCP servers](https://code.claude.com/docs/en/plugins-reference#mcp-servers)) Mid-session enable/disable requires `/reload-plugins`.

Two operational facts that argue against the MCP route for a delegating orchestrator:

1. **Long calls auto-background in the main conversation but not in subagents.** "An MCP tool call in the main conversation that is still running after two minutes moves to a background task instead of blocking the session." But: "Some calls never move to the background: Calls from subagents; Claude Code backgrounds only main-conversation calls." ([mcp § Automatic backgrounding of long tool calls](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls)) A Codex run routinely exceeds two minutes.
2. **Reloading a plugin with MCP servers invalidates the prompt cache.** "A plugin that provides MCP servers costs more when its tools aren't deferred by tool search: the change invalidates the cache and the next request re-reads the entire conversation." ([discover-plugins § Apply plugin changes without restarting](https://code.claude.com/docs/en/discover-plugins#apply-plugin-changes-without-restarting))

A subagent can also declare MCP servers inline via `mcpServers` frontmatter, which keeps their tool descriptions out of the main conversation — "To keep an MCP server out of the main conversation entirely and avoid its tool descriptions consuming context there, define it inline here rather than in `.mcp.json`" ([sub-agents § Scope MCP servers to a subagent](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent)) — **but this field is "Ignored for plugin subagents"** ([sub-agents § Supported frontmatter fields](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)). So a plugin cannot ship a subagent with a private Codex MCP server; a bundled MCP server is always visible to the main thread.

### 1.7 Claude Agent SDK

"The Agent SDK gives you the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript." ([agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview)) It supports Plugins ("Package skills, agents, hooks, and MCP servers, and load them by local path"), Subagents, Hooks, MCP, Permissions, and Sessions.

**Relevance to this project: low.** The SDK is the right tool if you want to *build a new host application* that embeds Claude Code. For a plugin distributed to existing Claude Code users, the SDK is not on the path — the plugin runs inside the user's Claude Code process. The SDK is worth knowing about for two secondary reasons: (a) it can load plugins by local path, giving you a scriptable test harness; (b) if you ever want a non-TypeScript/Python driver, the docs say "run the CLI as a subprocess with the `-p` flag and `--output-format json`" (same page).

One licensing note that could matter if this plugin is ever productized: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." ([agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview))

### 1.8 Seam comparison — which one for "call Codex for task X"

| Seam | Context isolation | Always-on token cost | Permission prompts | Streaming / long runs | Error handling |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Subagent + Bash** | **Best.** Separate context window; only the final report returns ([sub-agents](https://code.claude.com/docs/en/sub-agents)) | One line: name + `description` | One Bash allowlist entry covers every invocation | Background is the default (v2.1.198+); results arrive as a completion notification | Subagent API errors are surfaced explicitly (v2.1.199+); Bash exit code and stderr reach the subagent |
| **Skill + Bash** | **None.** Runs in the main conversation; skill body persists all session ([skills § Skill content lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle)) | Listing line, then full body once invoked, forever | `allowed-tools` grant **clears on your next message** ([skills § Pre-approve tools for a skill](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill)) | Bash tool `run_in_background` available; you own polling | Raw Bash output lands in main context |
| **Skill with `context: fork` + `agent:`** | Good — runs in a forked subagent | Listing line | Same turn-scoped grant caveat | `background: true` by default | Same as subagent |
| **Bundled MCP server** | **Poor for this use.** Tool schemas are always in main context; `mcpServers` on a subagent is ignored for plugin agents | Tool schema for every tool, every turn (mitigable with tool search) | MCP permission rules; can be pre-allowed by rule | Main-conversation calls auto-background after 2 min, **but subagent calls never do** ([mcp](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls)) | MCP protocol errors; `/reload-plugins` invalidates prompt cache |
| **Hook (`Stop`, `PostToolUse`)** | Full isolation (separate process) | Zero model-context cost — `claude plugin details` labels hooks "harness-only — no model context cost" ([plugins-reference § plugin details](https://code.claude.com/docs/en/plugins-reference#plugin-details)) | None — hooks bypass the permission system entirely | `timeout` up to 600s by default; OpenAI's plugin sets `900` on its `Stop` hook | Exit 2 + stderr blocks; JSON `decision: block` blocks with a reason |
| **Slash command** | Same as skill (they are the same mechanism) | Listing line | Per-command `allowed-tools`, turn-scoped | n/a | n/a |

**Verdict.** For "Claude decides to hand task X to Codex", the subagent is the correct seam: it is the only one that combines automatic model-driven delegation, a separate context window, and a stable session-level permission story. Slash commands are the right seam for user-initiated delegation and for job management (`status`/`result`/`cancel`). Hooks are the right seam for policy (a review gate) because they cost zero model context and can block. MCP is the wrong seam here unless you specifically want Codex tools callable from the main thread.

---

## 2. OpenAI Codex's programmatic invocation surfaces

### 2.1 Codex CLI subcommands

Verbatim from `codex --help` on `codex-cli 0.146.0` (local run):

```
Commands:
  exec            Run Codex non-interactively [aliases: e]
  review          Run a code review non-interactively
  login           Manage login
  logout          Remove stored authentication credentials
  mcp             Manage external MCP servers for Codex
  plugin          Manage Codex plugins
  mcp-server      Start Codex as an MCP server (stdio)
  app-server      [experimental] Run the app server or related tooling
  remote-control  [experimental] Manage the app-server daemon with remote control enabled
  completion      Generate shell completion scripts
  update          Update Codex to the latest version
  doctor          Diagnose local Codex installation, config, auth, and runtime health
  sandbox         Run commands within a Codex-provided sandbox
  debug           Debugging tools
  apply           Apply the latest diff produced by Codex agent as a `git apply` to your local
                  working tree [aliases: a]
  resume          Resume a previous interactive session (picker by default; use --last to continue
                  the most recent)
  archive         Archive a saved session by id or session name
  delete          Permanently delete a saved session by id or session name
  unarchive       Unarchive a saved session by id or session name
  fork            Fork a previous interactive session (picker by default; use --last to fork the
                  most recent)
  cloud           [EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally
  exec-server     [EXPERIMENTAL] Run the standalone exec-server service
  features        Inspect feature flags
  help            Print this message or the help of the given subcommand(s)
```

This matches the subcommand enum in source (`openai/codex codex-rs/cli/src/main.rs`, `enum Subcommand`). The docs mark `app-server`, `execpolicy`, `cloud`, and `remote-control` as Experimental and everything else Stable ([Codex developer commands reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).

### 2.2 `codex exec` — non-interactive / headless

Usage, verbatim from source (`openai/codex codex-rs/exec/src/cli.rs`):

```
codex exec [OPTIONS] [PROMPT]
codex exec [OPTIONS] <COMMAND> [ARGS]
```

Subcommands: `resume` and `review` (`openai/codex codex-rs/exec/src/cli.rs`, `pub enum Command`).

**stdin/stdout contract** (`openai/codex codex-rs/exec/src/cli.rs`, doc comment on `prompt`):

> "Initial instructions for the agent. If not provided as an argument (or if `-` is used), instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block."

Documented patterns ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)):

```bash
curl https://api.example.com/data | codex exec "format this as markdown"
cat prompt.txt | codex exec -
```

> **Spawning gotcha, verified on 0.146.0: `codex exec` hangs forever if it inherits an open stdin.** Even when a prompt is passed as argv, Codex prints `Reading additional input from stdin...` to stderr and waits for EOF before starting the turn. Invoked from a parent process that hands it an open pipe (which is what happens by default when a Node script uses `stdio: ["pipe", ...]`, and what happened when I first ran this probe under Claude Code's Bash tool), it blocks indefinitely and has to be killed. Redirecting from `/dev/null` makes it proceed immediately:
>
> ```bash
> codex exec --json 'Reply with the single word ok.' < /dev/null
> ```
>
> Any plugin that spawns `codex exec` must close stdin, redirect it from `/dev/null`, or write the prompt and then explicitly `end()` the stream. This is not documented anywhere I could find; it is an empirical finding from this machine (first attempt killed at the 2-minute mark with zero bytes on stdout; identical command with `< /dev/null` completed in well under a minute, exit `0`).

**Flags on `codex exec`** — the complete set from `codex exec --help` on 0.146.0, cross-checked against `openai/codex codex-rs/exec/src/cli.rs` and `openai/codex codex-rs/utils/cli/src/shared_options.rs`:

| Flag | Meaning |
| :--- | :--- |
| `-c, --config <key=value>` | "Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`. Use a dotted path (`foo.bar.baz`)… The `value` portion is parsed as TOML." |
| `--enable <FEATURE>` / `--disable <FEATURE>` | Equivalent to `-c features.<name>=true/false` |
| `--strict-config` | Error on unrecognized `config.toml` fields |
| `-i, --image <FILE>...` | Attach images |
| `-m, --model <MODEL>` | Model override |
| `--oss`, `--local-provider <P>` | Use a local OSS provider (lmstudio/ollama) |
| `-p, --profile <NAME>` | "Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config" |
| `-s, --sandbox <MODE>` | `read-only`, `workspace-write`, `danger-full-access` |
| `--dangerously-bypass-approvals-and-sandbox` | "Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS." (alias `--yolo`, per `shared_options.rs`) |
| `--dangerously-bypass-hook-trust` | Run enabled Codex hooks without persisted trust |
| `-C, --cd <DIR>` | "Tell the agent to use the specified directory as its working root" |
| `--add-dir <DIR>` | "Additional directories that should be writable alongside the primary workspace" |
| `--skip-git-repo-check` | "Allow running Codex outside a Git repository" |
| `--ephemeral` | "Run without persisting session files to disk" |
| `--ignore-user-config` | "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`" |
| `--ignore-rules` | "Do not load user or project execpolicy `.rules` files" |
| `--output-schema <FILE>` | "Path to a JSON Schema file describing the model's final response shape" |
| `--color <always\|never\|auto>` | Default `auto` |
| `--json` | "Print events to stdout as JSONL" (alias `--experimental-json`, per `cli.rs`) |
| `-o, --output-last-message <FILE>` | "Specifies file where the last message from the agent should be written" |

**Approval flags — the single most misleading area. [fast-moving]**

- **`codex exec` has no `--ask-for-approval`.** Verified empirically on 0.146.0: `codex exec --ask-for-approval never "x"` → `error: unexpected argument '--ask-for-approval' found`. In source, `--ask-for-approval` / `-a` is declared only on the interactive TUI CLI (`openai/codex codex-rs/tui/src/cli.rs`, field `approval_policy`), not on `SharedCliOptions` which `exec` flattens. The published docs list `--ask-for-approval, -a` under "Key Global Flags" without noting it is TUI-only ([Codex developer commands reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)) — treat the docs as wrong here.
- **`codex exec` hard-codes approvals off.** `openai/codex codex-rs/exec/src/lib.rs:419-421`:
  ```rust
  // Default to never ask for approvals in headless mode. Rebuild below if
  // the fully resolved reviewer is AutoReview.
  approval_policy: Some(AskForApproval::Never),
  ```
  Approval policy values are `untrusted` / `on-request` / `never` (`openai/codex codex-rs/utils/cli/src/approval_mode_cli_arg.rs`, `enum ApprovalModeCliArg`), mapping to `AskForApproval::UnlessTrusted` / `OnRequest` / `Never`.
- **`--full-auto` is deprecated, not removed.** On 0.146.0 it is hidden from `--help` but still accepted: `codex exec --full-auto "x"` prints `warning: --full-auto is deprecated; use --sandbox workspace-write instead.` The docs confirm: "**Deprecated:** `--full-auto` in `codex exec` (prefer `--sandbox workspace-write`)." ([Codex developer commands reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)) Do not use it in a plugin.
- **`--approve-for-me` exists on `main` but not in 0.146.0.** `openai/codex codex-rs/utils/cli/src/shared_options.rs` declares `--approve-for-me` (alias `--not-so-yolo`), which pushes `approvals_reviewer="auto_review"`, `approval_policy="on-request"`, `sandbox_mode="workspace-write"`. Locally, `codex exec --approve-for-me` → `error: unexpected argument`. This is a `main`-vs-release skew; expect it in a future release.

**Sandbox modes** (`openai/codex codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs`, `enum SandboxModeCliArg`): `read-only`, `workspace-write`, `danger-full-access`. The docs describe them as "Sets permissions: `workspace-write`, `danger-full-access`, or read-only (default)" ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).

**What this means for unattended invocation:** `codex exec` never blocks on a human. With the default `read-only` sandbox it can investigate and report but not edit; with `-s workspace-write` it can edit inside the workspace. `--dangerously-bypass-approvals-and-sandbox` disables both and should never be the default in a distributed plugin.

**JSON output.** `--json` emits JSONL. Event types, verbatim from `openai/codex codex-rs/exec/src/exec_events.rs` (`enum ThreadEvent` serde renames):

```
thread.started
turn.started
turn.completed
turn.failed
item.started
item.updated
item.completed
error
```

`thread.started` carries `thread_id` — "The identified of the new thread. Can be used to resume the thread later." `turn.completed` carries a `Usage` struct with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` (same file). Sample line from the docs:

```json
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```
([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode))

`item.*` events wrap a `ThreadItem` whose `details` is a tagged union (`#[serde(tag = "type", rename_all = "snake_case")]`) over: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error` (`openai/codex codex-rs/exec/src/exec_events.rs`, `enum ThreadItemDetails`). The `agent_message` item is documented in-source as: "Either a natural-language response or a JSON string when structured output is requested" — that is your structured-output return channel.

**Exit codes.** `codex exec` exits `1` when the server reported any fatal error, `0` otherwise (`openai/codex codex-rs/exec/src/lib.rs:955-1061` — `let mut error_seen = false;` … `if error_seen { std::process::exit(1); }`, with the in-source comment "Track whether a fatal error was reported by the server so we can exit with a non-zero status for automation-friendly signaling"). Config-load and auth failures also call `std::process::exit(1)` (same file, multiple sites).

**Resume / session continuation.** Documented forms ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)):

```bash
codex exec resume --last "<next_task>"
codex exec resume <SESSION_ID>
```

`ResumeArgs` accepts a session UUID *or a thread name*, `--last`, `--all` ("Show all sessions (disables cwd filtering)"), `--image`, and a prompt (`openai/codex codex-rs/exec/src/cli.rs`, `struct ResumeArgsRaw`). Sessions persist under `~/.codex/sessions` (`openai/codex sdk/typescript/README.md`: "Threads are persisted in `~/.codex/sessions`"). `--ephemeral` opts out of persistence.

There is also a top-level `codex fork` for branching a session (`codex --help`).

### 2.3 `codex review`

`codex review` runs a code review non-interactively. Target selection is mutually exclusive (`openai/codex codex-rs/exec/src/cli.rs`, `struct ReviewArgs`):

- `--uncommitted` — "Review staged, unstaged, and untracked changes."
- `--base <BRANCH>` — "Review changes against the given base branch."
- `--commit <SHA>` (+ optional `--title <TITLE>`) — "Review the changes introduced by a commit."
- a positional `PROMPT` — "Custom review instructions. If `-` is used, read from stdin."

### 2.4 MCP: Codex as server and as client

**Codex as MCP server.** `codex mcp-server` — "Start Codex as an MCP server (stdio)" (`codex --help`; `openai/codex codex-rs/cli/src/main.rs`, `Subcommand::McpServer`). Its only flag is `--strict-config` (`openai/codex codex-rs/cli/src/main.rs`, `struct McpServerCommand`).

It registers exactly two tools (`openai/codex codex-rs/mcp-server/src/message_processor.rs:341-357`):

```rust
let result = rmcp::model::ListToolsResult::with_all_items(vec![
    create_tool_for_codex_tool_call_param(),
    create_tool_for_codex_tool_call_reply_param(),
]);
...
"codex" => self.handle_tool_call_codex(id, arguments).await,
"codex-reply" => { ... }
```

The `codex` tool's input schema is derived from `CodexToolCallParam` (`openai/codex codex-rs/mcp-server/src/codex_tool_config.rs`), a kebab-case, `deny_unknown_fields` struct:

| Field | Type / values |
| :--- | :--- |
| `prompt` (required) | "The *initial user prompt* to start the Codex conversation." |
| `model` | "Optional override for the model name (e.g. 'gpt-5.2', 'gpt-5.2-codex')." |
| `cwd` | "Working directory for the session. If relative, it is resolved against the server process's current working directory." |
| `approval-policy` | `untrusted` \| `on-request` \| `never` |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `config` | "Individual config settings that will override what is in CODEX_HOME/config.toml." |
| `base-instructions` | "The set of instructions to use instead of the default ones." |
| `developer-instructions` | "Developer instructions that should be injected as a developer role message." |
| `compact-prompt` | "Prompt used when compacting the conversation." |

Tool description: `"Run a Codex session. Accepts configuration parameters matching the Codex Config struct."` Output schema (same file, `codex_tool_output_schema`):

```json
{
  "type": "object",
  "properties": {
    "threadId": { "type": "string" },
    "content": { "type": "string" }
  },
  "required": ["threadId", "content"]
}
```

`codex-reply` takes a `threadId` (with a deprecated `conversationId` alias) plus a `prompt` (`openai/codex codex-rs/mcp-server/src/codex_tool_config.rs`, `struct CodexToolCallReplyParam`).

**Confirmed empirically on 0.146.0** by piping a handshake plus `tools/list` into `codex mcp-server` over stdio. The server returned exactly two tools:

- `codex` — description `"Run a Codex session. Accepts configuration parameters matching the Codex Config struct."`; `inputSchema.properties` keys: `approval-policy`, `base-instructions`, `compact-prompt`, `config`, `cwd`, `developer-instructions`, `model`, `prompt`, `sandbox`
- `codex-reply` — description `"Continue a Codex conversation by providing the thread id and prompt."`; `inputSchema.properties` keys: `conversationId`, `prompt`, `threadId`

Both advertise the same `outputSchema`: `{"type":"object","properties":{"threadId":{"type":"string"},"content":{"type":"string"}},"required":["threadId","content"]}`. So the entire MCP surface is "start a session" and "continue it" — there is no per-capability tool (no separate review, no separate search), which is the main reason this route gives an orchestrator so little leverage over a bundled script.

**Maturity caveat.** The docs list `codex mcp-server` as Stable ([Codex developer commands reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)), but the crate's own module doc says `//! Prototype MCP server.` (`openai/codex codex-rs/mcp-server/src/lib.rs:1`). Treat that mismatch as a risk signal.

**Codex as MCP client.** `codex mcp` manages *external* MCP servers that Codex itself connects to (`codex --help`: "Manage external MCP servers for Codex"). Subcommands, from the source doc comment (`openai/codex codex-rs/cli/src/mcp_cmd.rs`):

```
- `list`   — list configured servers (with `--json`)
- `get`    — show a single server (with `--json`)
- `add`    — add a server launcher entry to `~/.codex/config.toml`
- `remove` — delete a server entry
- `login`  — authenticate with MCP server using OAuth
- `logout` — remove OAuth credentials for MCP server
```

Add usage: `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)` (same file, `#[command(override_usage = ...)]`). Both stdio and streamable-HTTP transports are supported (`struct AddMcpTransportArgs` with `AddMcpStdioArgs` and `AddMcpStreamableHttpArgs`).

### 2.5 `codex app-server`

"Codex app-server is the interface that powers rich client integrations… Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events." ([Codex app server docs](https://learn.chatgpt.com/docs/app-server))

- Protocol: **JSON-RPC 2.0**, bidirectional. "Requests include `method`, `params`, and `id`; responses echo the `id` with either `result` or `error`."
- Transports: `stdio://` (default, newline-delimited JSON), `unix://`, `ws://IP:PORT`, `off` — declared as `--listen <URL>` with `AppServerTransport::DEFAULT_LISTEN_URL` (`openai/codex codex-rs/cli/src/main.rs`, `struct AppServerCommand`). Doc comment: "Transport endpoint URL. Supported values: `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`."
- Methods: `initialize`, `initialized`, `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `turn/start`, `turn/steer`, `turn/interrupt` ([Codex app server docs](https://learn.chatgpt.com/docs/app-server)).
- Stability: "**Stable components:** Core thread/turn APIs, stdio transport, Unix sockets. **Experimental/Unsupported:** WebSocket transport, `process/*` APIs, paginated history modes." The CLI itself labels the whole subcommand `[experimental]` (`codex --help`).
- The docs explicitly steer automation elsewhere: "For automation jobs or CI environments, the Codex SDK is recommended instead."

**This is what OpenAI's own Claude Code plugin uses.** `openai/codex-plugin-cc plugins/codex/scripts/lib/app-server.mjs:190`:

```js
this.proc = spawn("codex", ["app-server"], {
  cwd: this.cwd,
  env: this.options.env ?? process.env,
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
  windowsHide: true
});
```

followed by `await this.request("initialize", { clientInfo, capabilities })` and `this.notify("initialized", {})` (same file, lines ~224-229). Its `README.md` confirms: "The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server)."

### 2.6 Authentication

Two methods ([Codex auth docs](https://learn.chatgpt.com/docs/auth)):

1. **ChatGPT sign-in** — `codex login`, browser-based OAuth.
2. **API key** — `printenv OPENAI_API_KEY | codex login --with-api-key`.

Login flags, verbatim from source (`openai/codex codex-rs/cli/src/main.rs`, `struct LoginCommand`):

| Flag | Help text |
| :--- | :--- |
| `--with-api-key` | "Read the API key from stdin (e.g. `printenv OPENAI_API_KEY \| codex login --with-api-key`)" |
| `--with-access-token` | "Read the access token from stdin (e.g. `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token`)" |
| `--api-key <API_KEY>` | "(deprecated) Previously accepted the API key directly; now exits with guidance to use `--with-api-key`" (hidden) |
| `--device-auth` | Device-code flow |
| `login status` subcommand | Show login status |

**Environment variables**, verbatim from source (`openai/codex codex-rs/login/src/auth/manager.rs:838-840`):

```rust
pub const OPENAI_API_KEY_ENV_VAR: &str = "OPENAI_API_KEY";
pub const CODEX_API_KEY_ENV_VAR: &str = "CODEX_API_KEY";
pub const CODEX_ACCESS_TOKEN_ENV_VAR: &str = "CODEX_ACCESS_TOKEN";
```

All three are read as trimmed, non-empty strings (same file, `read_openai_api_key_from_env`, `read_codex_api_key_from_env`, `read_codex_access_token_from_env`). `codex exec` honouring `CODEX_API_KEY` is covered by an integration test named `exec_uses_codex_api_key_env_var` (`openai/codex codex-rs/exec/tests/suite/auth_env.rs`). The docs show it inline for automation: `CODEX_API_KEY=<key> codex exec --json "<task>"` ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).

> **`OPENAI_API_KEY` is *not* a runtime auth variable — do not build on it.** Despite the constant existing and the docs listing it under "Environment Variables" ([Codex auth docs](https://learn.chatgpt.com/docs/auth)), `read_openai_api_key_from_env()` is never called from the auth-resolution path. Its only call site in the whole repo that affects behaviour is the interactive TUI onboarding screen, where it *prefills the API-key entry field*: `openai/codex codex-rs/tui/src/onboarding/auth.rs:780`, `let prefill_from_env = read_openai_api_key_from_env();`, assigned to `state.value` with `state.prepopulated_from_env = true`. In the docs' own example, `printenv OPENAI_API_KEY | codex login --with-api-key`, `OPENAI_API_KEY` is the variable *you pipe from*, not one Codex reads. Setting `OPENAI_API_KEY` in a plugin's subprocess environment authenticates nothing. Use `CODEX_API_KEY`.

**Auth resolution precedence**, traced through `load_auth` (`openai/codex codex-rs/login/src/auth/manager.rs:1217-1303`), in order:

1. **`CODEX_API_KEY`** env var, when the `enable_codex_api_key_env` flag is set by the caller. In-source comment: `// API key via env var takes precedence over any other auth method.`
2. **Ephemeral (in-memory) auth store.** In-source comment: `// External ChatGPT auth tokens live in the in-memory (ephemeral) store. Always check this first so external auth takes precedence over any persisted credentials.`
3. **`CODEX_ACCESS_TOKEN`** env var, classified as either a personal access token or an agent-identity JWT (`classify_codex_access_token`).
4. **The configured persistent store** (`file` / `keyring` / `auto`) → `$CODEX_HOME/auth.json`. Skipped entirely when the caller requested `AuthCredentialsStoreMode::Ephemeral`.

`OPENAI_API_KEY` appears nowhere in this chain.

**Credential storage.** `auth.json` under `$CODEX_HOME` (default `~/.codex`) — `openai/codex codex-rs/login/src/auth/storage.rs:38` (`/// Expected structure for $CODEX_HOME/auth.json.`) and line 151 (`codex_home.join("auth.json")`). The struct has a field serialized as `"OPENAI_API_KEY"` (line 44). Config option `cli_auth_credentials_store = "keyring" | "file" | "auto"` ([Codex auth docs](https://learn.chatgpt.com/docs/auth)).

**Headless / CI.** The docs list, in order: `codex login --device-auth` (preferred), copying `~/.codex/auth.json` from an authenticated machine, or SSH port forwarding `ssh -L 1455:localhost:1455 user@remote`. "API keys remain the recommended default for CI/CD automation." ([Codex auth docs](https://learn.chatgpt.com/docs/auth))

**For a Claude Code plugin, the right answer is: do not manage auth at all.** OpenAI's plugin explicitly punts: "This plugin uses your local Codex CLI authentication… If you are already signed into Codex on this machine, that account should work immediately here too." (`openai/codex-plugin-cc README.md`, FAQ). Its `/codex:setup` command just checks availability and offers `npm install -g @openai/codex`, and directs the user to `!codex login`.

### 2.7 Codex SDK

Packages ([Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk)):

- TypeScript: `@openai/codex-sdk` (`npm install @openai/codex-sdk`), Apache-2.0, `"engines": { "node": ">=18" }` (`openai/codex sdk/typescript/package.json`)
- Python: `openai-codex` (`pip install openai-codex`)

**The TS SDK is a CLI wrapper, not an independent client**: "The TypeScript SDK wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges JSONL events over stdin/stdout." (`openai/codex sdk/typescript/README.md`)

Quickstart, verbatim (same file):

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
const turn = await thread.run("Diagnose the test failure and propose a fix");

console.log(turn.finalResponse);
console.log(turn.items);
```

Streaming (same file):

```typescript
const { events } = await thread.runStreamed("Diagnose the test failure and propose a fix");

for await (const event of events) {
  switch (event.type) {
    case "item.completed":
      console.log("item", event.item);
      break;
    case "turn.completed":
      console.log("usage", event.usage);
      break;
  }
}
```

Structured output (same file):

```typescript
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["ok", "action_required"] },
  },
  required: ["summary", "status"],
  additionalProperties: false,
} as const;

const turn = await thread.run("Summarize repository status", { outputSchema: schema });
console.log(turn.finalResponse);
```

Working directory controls (same file):

```typescript
const thread = codex.startThread({
  workingDirectory: "/path/to/project",
  skipGitRepoCheck: true,
});
```

Environment control and config overrides (same file): `new Codex({ env: { PATH: "/usr/local/bin" } })` — "The SDK still injects its required variables (such as `CODEX_API_KEY`) on top of the environment you provide"; and `new Codex({ config: { show_raw_agent_reasoning: true, sandbox_workspace_write: { network_access: true } } })` — "The SDK accepts a JSON object, flattens it into dotted paths, and serializes values as TOML literals before passing them as repeated `--config key=value` flags."

Resume: `codex.resumeThread(savedThreadId)` (same file).

Python shape ([Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk)):

```python
from openai_codex import Codex, Sandbox

with Codex() as codex:
    thread = codex.thread_start(model="gpt-5.6-terra", sandbox=Sandbox.workspace_write)
    result = thread.run("Make a plan to diagnose and fix CI failures")
    print(result.final_response)
```

**Verdict for a Claude Code plugin:** the TS SDK is a thin, well-typed wrapper over the same CLI you would otherwise spawn yourself, and it adds an npm dependency your plugin must install at runtime (via the `${CLAUDE_PLUGIN_DATA}` + `SessionStart` pattern). It is a reasonable choice if you want typed events for free; spawning `codex exec --json` directly avoids the dependency entirely. Note OpenAI's own plugin does neither — it drives the app-server directly with hand-rolled JSON-RPC.

### 2.8 `config.toml`, profiles, model, reasoning effort

Location: user-level `~/.codex/config.toml`; project-level `.codex/config.toml`, which "are only loaded when the project is trusted" ([Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).

Key options, verbatim TOML from the reference:

```toml
model = "gpt-5.5"
model_context_window = 128000
model_reasoning_effort = "medium"   # minimal | low | medium | high | xhigh
approval_policy = "on-request"      # or: untrusted, never
sandbox_mode = "workspace-write"    # or: read-only, danger-full-access

[sandbox_workspace_write]
network_access = true
writable_roots = ["/path/to/project"]
exclude_slash_tmp = false

[mcp_servers.my_server]
command = "npx -y @example/mcp-server"
enabled = true
default_tools_approval_mode = "auto"
```

Profiles: `-p, --profile <NAME>` "Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config" (`openai/codex codex-rs/utils/cli/src/shared_options.rs`). Note this is the *v2* profile mechanism (`ProfileV2Name`) — a separate file per profile, not a `[profiles.x]` table.

`-c key=value` overrides parse the value as TOML with a raw-string fallback (`codex exec --help`).

**Practical consequence for a plugin:** you get user-configurable model and effort for free by *not* passing `--model`/`-c model_reasoning_effort`. OpenAI's plugin documents exactly this: "If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`" and its `codex-rescue` agent is instructed "Leave `--effort` unset unless the user explicitly requests a specific reasoning effort. Leave model unset by default." (`openai/codex-plugin-cc README.md`; `openai/codex-plugin-cc plugins/codex/agents/codex-rescue.md`)

### 2.9 Rate limits and usage — what a delegating orchestrator must know

From [Codex pricing docs](https://learn.chatgpt.com/docs/pricing):

- "The usage limits for local messages and cloud chats share a five-hour window. Additional weekly limits may apply."
- Sample Plus-tier limits per window: GPT-5.6 Sol 10–100 messages; GPT-5.6 Terra 25–200; GPT-5.6 Luna 250–2,000. Pro is 5× or 20× depending on tier.
- What counts: local Codex messages, cloud chats and integrations, GitHub code reviews, image generation (3–5× faster consumption), ChatGPT Voice tasks.
- After limits exhaust, credits: Sol 125 credits/1M input tokens, Terra 50, Luna 5.
- "For shared automation environments, the documentation recommends using 'API Key' access, which enables 'pay only for the tokens Codex uses, based on API pricing'."

**Design implications.** A single Codex delegation is a *message*, not a token bucket, against a 5-hour rolling window. An orchestrator that fires Codex on every Claude turn will burn a Plus user's window in an afternoon — which is exactly why OpenAI ships its `Stop`-hook review gate **disabled by default** and behind an explicit warning (`openai/codex-plugin-cc README.md`; the hook checks `config.stopReviewGate` and returns early when false — `openai/codex-plugin-cc plugins/codex/scripts/stop-review-gate-hook.mjs`, `if (!config.stopReviewGate) { ... return; }`). Any auto-delegating subagent you ship should default to conservative triggering and say so in its `description`.

---

## 3. Integration mechanics for the plugin

### 3.1 Subagent-shelling-out vs bundled MCP server vs skill + Bash

**Option A — subagent + bundled script (recommended).**

Shape, taken from `openai/codex-plugin-cc plugins/codex/agents/codex-rescue.md`:

```markdown
---
name: codex-rescue
description: Proactively use when Claude Code is stuck, wants a second implementation or diagnosis pass, needs a deeper root-cause investigation, or should hand a substantial coding task to Codex through the shared runtime
model: sonnet
tools: Bash
skills:
  - codex-cli-runtime
  - gpt-5-4-prompting
---

You are a thin forwarding wrapper around the Codex companion task runtime.

Your only job is to forward the user's rescue request to the Codex companion script. Do not do anything else.
...
- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...`.
...
- Return the stdout of the `codex-companion` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.
```

Note the design choices worth copying: `tools: Bash` only; `skills:` preloads the calling contract so the agent doesn't have to discover it; and the system prompt aggressively forbids the subagent from doing any work of its own ("Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own"). That is what keeps token cost at "one Bash call in, one report out".

| | Pros | Cons |
| :--- | :--- | :--- |
| **A. Subagent + Bash → bundled script** | Separate context window; verbose Codex output never touches main context. Model-driven auto-delegation via `description`. Background by default. One permission rule (`Bash(node:*)`) covers everything. Script can own job state, resume, cancellation, structured-output parsing. | Extra indirection. Cannot ship private MCP servers (`mcpServers` ignored for plugin agents). Subagent adds one model round-trip of latency. Requires Node (or whatever runtime) on the user's machine. |
| **B. Bundled MCP server wrapping Codex** | Tools callable directly from the main thread, no subagent hop. Structured tool args/results are typed. `codex mcp-server` gives you a ready-made server (`claude mcp add --transport stdio codex -- codex mcp-server`). | Tool schemas cost main-context tokens every turn. Codex's raw output lands in main context. Subagent MCP calls never auto-background, and Codex runs routinely exceed 2 minutes. `/reload-plugins` invalidates the prompt cache. `codex mcp-server` is a "Prototype" with only two coarse tools. |
| **C. Skill + Bash** | Simplest to write. Zero indirection. | No context isolation — Codex output lands in the main conversation, and the skill body itself persists for the whole session. `allowed-tools` grants clear on the user's next message, so every subsequent turn re-prompts. Wrong tool for repeated delegation. |
| **C'. Skill with `context: fork` + `agent:`** | Gets B's isolation with C's authoring simplicity. | Still an extra hop; the `agent` you name must exist. Effectively option A wearing a skill's clothes. |
| **D. Hook** | Zero model-context cost. Deterministic. Can block (`decision: block` / exit 2). Bypasses the permission system. | Not model-invocable; fires on a fixed event. Only right for policy gates, not for "do task X". |

**Recommended composition (what OpenAI ships and what this plugin should ship):** A for autonomous delegation + slash commands for explicit user-initiated flows + D (opt-in, default-off) for a review gate. Skip B.

### 3.2 Permission model implications

**A plugin cannot ship permission rules.** The plugin `settings.json` supports "Only the `agent` and `subagentStatusLine` keys" ([plugins-reference § File locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference); [plugins § Ship default settings with your plugin](https://code.claude.com/docs/en/plugins#ship-default-settings-with-your-plugin)). So the plugin cannot pre-allow `Bash(node:*)` on the user's behalf. Your two levers are per-command/per-skill `allowed-tools` (turn-scoped) and documenting a `permissions.allow` entry for users to add.

**Design for a single allowlist shape.** Bash rules match by prefix with word-boundary semantics ([permissions](https://code.claude.com/docs/en/permissions)):

- `Bash(npm run build)` — exact match
- `Bash(npm run test *)` — prefix match
- `Bash(ls *)` matches `ls -la` but not `lsof`; `Bash(ls*)` matches both
- `Bash(ls:*)` is equivalent to `Bash(ls *)`

Because the plugin routes *everything* through one script, `Bash(node:*)` is the whole surface. That is precisely why `openai/codex-plugin-cc` uses `allowed-tools: Bash(node:*)` on every command (`openai/codex-plugin-cc plugins/codex/commands/status.md`, `setup.md`, `rescue.md`, `review.md`). Compare with the alternative of allowlisting `Bash(codex *)` directly — that would need a second rule for `codex exec`, and Claude Code's operator-awareness means "a rule like `Bash(safe-cmd *)` won't give it permission to run the command `safe-cmd && other-cmd`" (recognized separators: `&&`, `||`, `;`, `|`, `|&`, `&`, newlines) ([permissions](https://code.claude.com/docs/en/permissions)).

Two more permission facts worth designing around:

- **Wrapper stripping is fixed and does not include `npx`.** "The stripped wrappers are `timeout`, `time`, `nice`, `nohup`, and `stdbuf`, plus the shell builtins `command` and `builtin`, and zsh's `noglob`… Development environment runners such as `direnv exec`, `devbox run`, `mise exec`, `npx`, and `docker exec` are not in the list." ([permissions](https://code.claude.com/docs/en/permissions)) Do not invoke Codex via `npx`.
- **Deny/ask beat allow.** "A broad deny rule like `Bash(aws *)` blocks every matching call, including calls that also match a narrower allow rule… The same precedence applies between ask and allow." ([permissions](https://code.claude.com/docs/en/permissions))

**Alternative to allowlisting entirely: `bin/`.** "Executables added to the Bash tool's `PATH`. Files here are invokable as bare commands in any Bash tool call while the plugin is enabled" ([plugins-reference § File locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)). Shipping `bin/codex-companion` would let users write `Bash(codex-companion:*)` — a tighter, more legible rule than `Bash(node:*)`. **Unverified**: whether the `bin/` shim interacts correctly with permission prefix matching (the docs don't say whether the rule matches the bare name or the resolved path).

**Sandbox interactions — Codex's sandbox inside Claude Code's sandbox.**

Claude Code's Bash sandbox uses Seatbelt on macOS and bubblewrap on Linux/WSL2; "These OS-level restrictions ensure that all child processes spawned by Claude Code's commands inherit the same security boundaries." ([sandboxing § OS-level enforcement](https://code.claude.com/docs/en/sandboxing#os-level-enforcement)) Subagents share the parent's config: "subagents run in the same process as the parent session and use the same sandbox configuration. Bash commands inside a subagent are sandboxed when sandboxing is enabled in the parent session." ([sandboxing § Scope](https://code.claude.com/docs/en/sandboxing#scope))

Codex, in turn, applies its own sandbox (Seatbelt on macOS, Landlock on Linux, native on Windows — `codex --help`, `codex sandbox` subcommand; `openai/codex codex-rs/cli/src/main.rs` selects `SeatbeltCommand` / `LandlockCommand` / `WindowsCommand` by `target_os`). So a Codex invocation from inside a sandboxed Claude Code Bash call is a **nested** sandbox.

Concrete hazards, all documented:

- **Default write scope collides.** Claude Code's sandbox gives "read and write access to the current working directory and its subdirectories, plus the session temp directory" ([sandboxing § Filesystem isolation](https://code.claude.com/docs/en/sandboxing#filesystem-isolation)). Codex writing to `~/.codex/sessions` or reading `~/.codex/auth.json` is a *read* (allowed by default) and a *write outside cwd* (blocked). A plugin that relies on Codex session persistence needs `sandbox.filesystem.allowWrite: ["~/.codex"]` — or must pass `--ephemeral`.
- **Nested bubblewrap fails in unprivileged containers.** "In an unprivileged container, bubblewrap cannot mount a fresh `/proc` filesystem. Set `enableWeakerNestedSandbox` to `true`…" ([sandboxing § Troubleshooting](https://code.claude.com/docs/en/sandboxing#troubleshooting)) The same class of failure can bite a Codex Landlock sandbox launched inside a bubblewrap sandbox. **Unverified**: whether Codex's Landlock sandbox actually initializes correctly inside Claude Code's bubblewrap sandbox.
- **Network.** Codex needs egress to the OpenAI API. Claude Code's sandbox pre-allows nothing: "no domains are pre-allowed by default. The first time a command needs a new domain, Claude Code prompts for approval." ([sandboxing § Network isolation](https://code.claude.com/docs/en/sandboxing#network-isolation)) A plugin README should tell sandboxed users to add the relevant host to `sandbox.network.allowedDomains`.
- **Credential scrubbing.** `sandbox.credentials.envVars` with `mode: deny` "are unset before each sandboxed command runs" ([sandboxing § Protect credentials](https://code.claude.com/docs/en/sandboxing#protect-credentials)). A user who denies `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` will break env-authenticated Codex runs; denying `OPENAI_API_KEY` is harmless, since Codex does not read it at runtime (see [§2.6](#26-authentication)). ChatGPT sign-in is unaffected either way, because it resolves from `$CODEX_HOME/auth.json` — which is a *read* outside cwd, allowed by the sandbox's default read policy.
- **Escape hatch exists but prompts.** "when a command fails because of sandbox restrictions, Claude analyzes the failure and may retry the command with the `dangerouslyDisableSandbox` parameter. The retried command runs outside the sandbox, so it goes through the regular permission flow." ([sandboxing § Sandbox modes](https://code.claude.com/docs/en/sandboxing#sandbox-modes))

**Avoiding a prompt storm — checklist.**

1. One entry point. Every Codex path goes through one bundled script so `Bash(node:*)` (or a `bin/` shim) is the only rule needed.
2. Put `allowed-tools` on every slash command so first use in a turn doesn't prompt (`openai/codex-plugin-cc plugins/codex/commands/*.md`).
3. Give the subagent `tools: Bash` and nothing else — fewer tools, fewer prompts, and it survives the background tool filter.
4. Document the one-line `permissions.allow` entry in the README, since the plugin can't ship it.
5. Never `cd` inside the subagent: "Within a subagent, `cd` commands don't persist between Bash or PowerShell tool calls" ([sub-agents § Write subagent files](https://code.claude.com/docs/en/sub-agents#write-subagent-files)). Pass `codex exec -C <dir>` instead.

### 3.3 Passing context between the two agents

**Working directory.** A subagent starts in the main conversation's cwd ([sub-agents](https://code.claude.com/docs/en/sub-agents)). Pass it explicitly to Codex with `-C/--cd <DIR>` and widen with `--add-dir` if needed. `openai/codex-plugin-cc` resolves a workspace root and passes it as the app-server `cwd` (`plugins/codex/scripts/lib/codex.mjs`, `buildThreadParams(cwd, options)`), and separately resolves a git repo root for review context (`collectReviewContext(request.cwd, target)` in `codex-companion.mjs`).

**Git repo requirement.** Codex "requires the working directory to be a Git repository" (`openai/codex sdk/typescript/README.md`). Escape hatches: `--skip-git-repo-check` on the CLI, `skipGitRepoCheck: true` on the SDK.

**What Codex can and cannot see.**

- **Can see:** the filesystem at its `cwd` (subject to its own `--sandbox`), git state, the prompt you pass, `AGENTS.md` files, `~/.codex/config.toml` and a trusted project `.codex/config.toml`, and any MCP servers *it* has configured via `codex mcp add`.
- **Cannot see:** Claude Code's conversation, Claude's CLAUDE.md, Claude's MCP tools, Claude's skills, or anything in Claude's context that isn't on disk. There is no shared memory.

**Prompt construction.** Everything Codex needs must be in the prompt or on disk. Three mechanisms, in increasing weight:

1. **Argv prompt** — `codex exec "..."`. Fine up to shell-arg limits.
2. **stdin** — `cat prompt.md | codex exec -`, or `... | codex exec "prompt"` which appends stdin "as a `<stdin>` block" (`openai/codex codex-rs/exec/src/cli.rs`). This is the right channel for large context: no quoting hazards, no argv limits.
3. **File-based handoff** — write a context file into the repo (or a temp dir Codex can read) and reference it by path in the prompt. `openai/codex-plugin-cc` does an in-between thing: it collects git context (`repoRoot`, `branch`, `summary`) in Node and interpolates it into a Markdown prompt template loaded from `${CLAUDE_PLUGIN_ROOT}/prompts/*.md` (`plugins/codex/scripts/lib/prompts.mjs` — `loadPromptTemplate`, `interpolateTemplate`; templates at `plugins/codex/prompts/adversarial-review.md` and `stop-review-gate.md`).

**Full session handoff.** `openai/codex-plugin-cc` ships `/codex:transfer`, which converts a Claude Code transcript into a Codex thread: "Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command… The plugin's existing `SessionStart` hook supplies the current transcript path automatically… The transfer uses Codex's external-agent session importer… The source must be under `~/.claude/projects`." (`openai/codex-plugin-cc README.md`) The implementation lives in `plugins/codex/scripts/lib/claude-session-transfer.mjs` and calls an app-server method surfaced as `externalAgentConfig/import/completed` (`plugins/codex/scripts/lib/codex.mjs:51`). This is a nice pattern but depends on an app-server API that the Codex docs don't publicly document — treat as unverified/unstable.

### 3.4 Getting structured output back, and its token cost

**Two mechanisms, both first-party:**

1. `codex exec --output-schema <FILE>` — "Path to a JSON Schema file describing the model's final response shape" (`openai/codex codex-rs/exec/src/cli.rs`). The final `agent_message` item then holds "a JSON string when structured output is requested" (`openai/codex codex-rs/exec/src/exec_events.rs`, `AgentMessageItem` doc comment).
2. `codex exec -o/--output-last-message <FILE>` — "Specifies file where the last message from the agent should be written". Combine with `--json` and the docs' description: "Writes final message to file while printing to stdout" ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).

**Verified live on 0.146.0 (this machine, 2026-08-02).** Command:

```bash
codex exec --json --ephemeral --skip-git-repo-check -s read-only \
  -C ./probe-wd --output-schema ./schema-probe.json -o ./last-msg.txt \
  'Reply with the single word ok.' < /dev/null
```

with `schema-probe.json` = `{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string"}}}`. Exit code `0`. The complete JSONL event sequence was four lines:

```
thread.started
turn.started
item.completed   -> agent_message
turn.completed
```

`thread.started` carried a real UUID even under `--ephemeral`:

```json
{"type": "thread.started", "thread_id": "019fc304-3960-79c1-acc4-93a69a677cb9"}
```

The structured payload arrives **double-encoded** — the schema-conforming JSON is a *string* in the `text` field, so a consumer must parse twice:

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_0",
    "type": "agent_message",
    "text": "{\"answer\":\"ok\"}"
  }
}
```

`-o/--output-last-message` wrote the same payload to disk already unwrapped — file contents were exactly `{"answer":"ok"}`. **This is the simpler extraction path: `--output-schema` + `-o <file>` lets you `JSON.parse(readFileSync(file))` with no JSONL parsing at all**, and it is what a plugin should use unless it also needs progress events.

`turn.completed` reported usage for this trivial one-word turn:

```json
{"type":"turn.completed","usage":{"input_tokens":14579,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":15,"reasoning_output_tokens":0}}
```

Note the ~14.6k input tokens of fixed overhead (system prompt, tool definitions, `AGENTS.md`, MCP tool schemas) on a prompt of six words. Budget for that on every delegation; it is the floor, not the average.

One more observation from the same run: `codex exec` starts the user's own configured Codex MCP clients on every invocation, and their failures land on **stderr** — this run emitted `ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(...)` from an unrelated Cloudflare MCP server configured on this machine via `codex mcp add`. A wrapper script must not treat non-empty stderr as failure; use the exit code and the `turn.failed` / `error` events instead.

**A concrete schema worth stealing.** `openai/codex-plugin-cc plugins/codex/schemas/review-output.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "summary", "findings", "next_steps"],
  "properties": {
    "verdict": { "type": "string", "enum": ["approve", "needs-attention"] },
    "summary": { "type": "string", "minLength": 1 },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity","title","body","file","line_start","line_end","confidence","recommendation"],
        "properties": {
          "severity": { "type": "string", "enum": ["critical","high","medium","low"] },
          "title": { "type": "string", "minLength": 1 },
          "body": { "type": "string", "minLength": 1 },
          "file": { "type": "string", "minLength": 1 },
          "line_start": { "type": "integer", "minimum": 1 },
          "line_end": { "type": "integer", "minimum": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "recommendation": { "type": "string" }
        }
      }
    },
    "next_steps": { "type": "array", "items": { "type": "string", "minLength": 1 } }
  }
}
```

The plugin passes it as `outputSchema: readOutputSchema(REVIEW_SCHEMA)` on the app-server turn, then `parseStructuredOutput(result.finalMessage, …)` and renders it (`openai/codex-plugin-cc plugins/codex/scripts/codex-companion.mjs`, ~lines 410-440).

**Token cost of the return value — this is the whole ballgame.** The wrapper script must be the thing that decides what enters Claude's context, not Codex. The pattern to copy:

1. Codex's JSONL stream (reasoning items, every `command_execution`, every `file_change`) stays in the script. Never echo it.
2. The script parses the structured final message and renders a compact Markdown report (`openai/codex-plugin-cc plugins/codex/scripts/lib/render.mjs`, 465 lines of pure rendering).
3. The script persists the full payload to disk under `${CLAUDE_PLUGIN_DATA}/state/<slug>-<hash>/jobs/<jobId>.json` with a sibling `<jobId>.log` (`openai/codex-plugin-cc plugins/codex/scripts/lib/state.mjs:185-190`), so `/codex:result <job-id>` can retrieve detail on demand.
4. The subagent returns *only* the script's stdout, verbatim: "Return the stdout of the `codex-companion` command exactly as-is… Do not add commentary before or after the forwarded `codex-companion` output." (`openai/codex-plugin-cc plugins/codex/agents/codex-rescue.md`)

That is progressive disclosure applied to the return path: a compact rendered summary is always paid for; the full transcript is a file path away.

**Handling the result safely.** Codex output is untrusted text. Claude Code scans subagent reports for instruction-shaped patterns but "doesn't judge whether content is malicious" ([sub-agents § Subagent output scanning](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning)). OpenAI's plugin adds a behavioral guardrail in a skill (`openai/codex-plugin-cc plugins/codex/skills/codex-result-handling/SKILL.md`):

> "CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious."

and

> "For `codex:codex-rescue`, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure and stop. … if Codex was never successfully invoked, do not generate a substitute answer at all."

Both are worth copying: they stop Claude from silently substituting its own work for a failed delegation, which is the main correctness failure mode of this architecture.

### 3.5 Prior art

**`openai/codex-plugin-cc` — first-party, active, the reference implementation.**
`https://github.com/openai/codex-plugin-cc` — 30,933 stars, 2,047 forks, 121 watchers, Apache-2.0, created 2026-03-30, last push 2026-07-08, not archived, `owner.type` = `Organization` (`GET https://api.github.com/repos/openai/codex-plugin-cc`, re-verified 2026-08-02). Description: "Use Codex from Claude Code to review code or delegate tasks." The star count is genuinely in the 31k range — it was independently re-checked because the figure looks high for a plugin repo; the 2,047 forks and 121 watchers corroborate it.

Structure (`openai/codex-plugin-cc`, tree at `db52e28`):
- `.claude-plugin/marketplace.json` — marketplace named `openai-codex`, owner `OpenAI`, one plugin entry `codex` at `"source": "./plugins/codex"`, version `1.0.6`
- `plugins/codex/.claude-plugin/plugin.json` — `{"name":"codex","version":"1.0.6","description":"Use Codex from Claude Code to review code or delegate tasks.","author":{"name":"OpenAI"}}`
- `plugins/codex/agents/codex-rescue.md` — the forwarding subagent
- `plugins/codex/commands/{review,adversarial-review,rescue,transfer,status,result,cancel,setup}.md`
- `plugins/codex/skills/{codex-cli-runtime,codex-result-handling,gpt-5-4-prompting}/SKILL.md` — all `user-invocable: false`
- `plugins/codex/hooks/hooks.json` — `SessionStart`, `SessionEnd`, `Stop`
- `plugins/codex/scripts/` — `codex-companion.mjs` (1073 lines), `app-server-broker.mjs`, `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`, plus `lib/` (~4000 lines: `codex.mjs`, `app-server.mjs`, `state.mjs`, `render.mjs`, `git.mjs`, `job-control.mjs`, `tracked-jobs.mjs`, …)
- `plugins/codex/schemas/review-output.schema.json`, `plugins/codex/prompts/*.md`
- `tests/*.test.mjs` — 8 test files including a `fake-codex-fixture.mjs`

Approach: spawns `codex app-server` and speaks JSON-RPC over stdio; runs a broker so multiple jobs share one app-server process; persists jobs under `${CLAUDE_PLUGIN_DATA}`; defaults to `sandbox: "read-only"` and `approvalPolicy: "never"` (`plugins/codex/scripts/lib/codex.mjs:63-81`), flipping to `sandbox: "workspace-write"` only when `--write` is passed (`plugins/codex/scripts/codex-companion.mjs:491`).

Install path from its README:
```bash
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

**Quality assessment: high, and it is the thing to study.** Well-tested, versioned, first-party, and its README is candid about limits (review-gate loop risk, background-run recommendation). Its main downsides as a *dependency* for your own plugin: it targets the experimental app-server, it depends on Node 18.18+, and its `--write` default in `codex-rescue` ("Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior") is more aggressive than many teams will want.

**`hampsterx/codex-mcp-bridge`** — `https://github.com/hampsterx/codex-mcp-bridge`, 3 stars, MIT, TypeScript, last push 2026-08-02 (today). "MCP server bridging Codex CLI to Claude Code, Cursor - (native) review, queries, and search with hardened subprocess management." Actively developed but very early; its README was not fetchable at the default branch path (`404` for `main/README.md`), so I could not verify its interface. **Low adoption; treat as an idea source, not a dependency.**

**`ogmios2/claude-code-codex-mcp`** — `https://github.com/ogmios2/claude-code-codex-mcp`, 2 stars, no license, last push 2026-01-26 (~6 months stale). Contents are literally two files: `README.md` and `mcp-config.json` (`GET https://api.github.com/repos/ogmios2/claude-code-codex-mcp/contents`). It is not a server at all — it is documentation for wiring Codex's own MCP server:

```bash
claude mcp add --transport stdio --scope user codex -- codex mcp-server
```
```json
{ "mcpServers": { "codex": { "type": "stdio", "command": "codex", "args": ["mcp-server"] } } }
```

**Low quality / stale, but the config snippet is the correct minimal MCP wiring** and is worth citing as the zero-code baseline.

**`sanghyun-io/codex-app-server-plugin`** — `https://github.com/sanghyun-io/codex-app-server-plugin`, 0 stars, MIT, last push 2026-07-31. "Claude Code plugin: Codex App Server integration for stateful plan validation and code review." Same architecture as OpenAI's, independently. **No adoption; unvetted.**

**`biggora/claude-code-plugin-codex`** — `https://github.com/biggora/claude-code-plugin-codex`, 0 stars, MIT, last push 2026-06-22. "Claude review plugin for Codex CLI — inverse of openai/codex-plugin-cc. Stop-time review of Codex turns by Claude." The *reverse* direction (Codex orchestrating Claude), useful only as a mirror-image reference. **No adoption.**

**What I did not find:** any widely-adopted third-party MCP server that wraps Codex for Claude Code. Searches across `gh search repos` for "codex mcp server claude", "codex mcp bridge", "claude-code-plugin codex", "codex subagent claude code", and "mcp server openai codex cli" returned nothing above 3 stars other than OpenAI's own plugin and unrelated projects (memory tools, resource monitors, IDA plugins). The ecosystem has effectively consolidated on `openai/codex-plugin-cc`.

---

## 4. Publishing a reusable plugin

### 4.1 Marketplace format

Create `.claude-plugin/marketplace.json` in your repository root ([plugin-marketplaces § Create the marketplace file](https://code.claude.com/docs/en/plugin-marketplaces#create-the-marketplace-file)). Verbatim example:

```json
{
  "name": "company-tools",
  "owner": {
    "name": "DevTools Team",
    "email": "devtools@example.com"
  },
  "plugins": [
    {
      "name": "code-formatter",
      "source": "./plugins/formatter",
      "description": "Automatic code formatting on save",
      "version": "2.1.0",
      "author": { "name": "DevTools Team" }
    },
    {
      "name": "deployment-tools",
      "source": { "source": "github", "repo": "company/deploy-plugin" },
      "description": "Deployment automation tools"
    }
  ]
}
```

**Required marketplace fields**: `name` (kebab-case, public-facing, "Each user can register only one marketplace per name"), `owner` (object, `name` required; `email`/`url` optional), `plugins` (array) ([plugin-marketplaces § Marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces#marketplace-schema)).

**Required plugin-entry fields**: `name` and `source` ([plugin-marketplaces § Plugin entries](https://code.claude.com/docs/en/plugin-marketplaces#plugin-entries)). A plugin entry can also carry any field from the plugin manifest schema plus `source`, `category`, `tags`, `strict`, `relevance`.

**Reserved marketplace names** you must avoid: `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`, `claude-plugins-community`, `claude-community`, `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`, `anthropic-agent-skills`, `knowledge-work-plugins`, `life-sciences`, `claude-for-legal`, `claude-for-financial-services`, `financial-services-plugins`, `first-party-plugins`, `healthcare` — plus "Names that impersonate official marketplaces, such as `official-claude-plugins` or `anthropic-plugins-v2`" ([plugin-marketplaces § Required fields](https://code.claude.com/docs/en/plugin-marketplaces#required-fields)).

**Source types** ([plugin-marketplaces § Plugin sources](https://code.claude.com/docs/en/plugin-marketplaces#plugin-sources)):

| Source | Type | Fields |
| :--- | :--- | :--- |
| Relative path | `string` (e.g. `"./my-plugin"`) | none — "Must start with `./`. Resolved relative to the marketplace root, not the `.claude-plugin/` directory" |
| `github` | object | `repo`, `ref?`, `sha?` |
| `url` | object | `url`, `ref?`, `sha?` |
| `git-subdir` | object | `url`, `path`, `ref?`, `sha?` — "Clones sparsely to minimize bandwidth for monorepos" |
| `npm` | object | `package`, `version?`, `registry?` |

For a single-plugin repo (this project's case), the OpenAI layout is the model: marketplace at repo root, plugin under `./plugins/<name>` referenced by relative path. Note the caveat: relative paths "won't resolve" if users add the marketplace by direct URL to the `marketplace.json` file ([plugin-marketplaces § Relative paths](https://code.claude.com/docs/en/plugin-marketplaces#relative-paths)).

### 4.2 Versioning

Resolution order ([plugins-reference § Version management](https://code.claude.com/docs/en/plugins-reference#version-management)):

1. `version` in `plugin.json`
2. `version` in the marketplace entry
3. The git commit SHA (for `github`, `url`, `git-subdir`, and relative-path sources in a git-hosted marketplace)
4. `unknown` (npm sources, or local dirs not in a git repo)

> **Warning**: "If you set `version` in `plugin.json`, you must bump it every time you want users to receive changes. Pushing new commits alone is not enough… If you're iterating quickly, leave `version` unset so the git commit SHA is used instead."

`claude plugin tag [path] [--push] [--dry-run] [-m <msg>]` creates a release git tag ([plugins-reference § plugin tag](https://code.claude.com/docs/en/plugins-reference#plugin-tag)).

Validation before publishing: `claude plugin validate ./my-plugin --strict` — "`claude plugin validate` reports unrecognized fields as warnings, not errors… Pass `--strict` to treat warnings as errors. Use it in CI" ([plugins-reference § Unrecognized fields](https://code.claude.com/docs/en/plugins-reference#unrecognized-fields)).

### 4.3 How a user installs a third-party plugin

```shell
/plugin marketplace add owner/repo
/plugin install plugin-name@marketplace-name
/reload-plugins
```
([discover-plugins § Add marketplaces](https://code.claude.com/docs/en/discover-plugins#add-marketplaces) and § Install plugins)

Other marketplace-add forms: full git URL (`/plugin marketplace add https://gitlab.com/company/plugins.git`), SSH (`git@gitlab.com:company/plugins.git`), a ref suffix (`…​.git#v1.0.0`), a local path (`./my-marketplace` or `./path/to/marketplace.json`), or a remote `marketplace.json` URL (same section).

Non-interactive equivalents ([plugins-reference § CLI commands reference](https://code.claude.com/docs/en/plugins-reference#cli-commands-reference)):

```bash
claude plugin install formatter@my-marketplace --scope project
claude plugin uninstall formatter@my-marketplace --keep-data --prune
claude plugin enable  <plugin> [--scope user|project|local]
claude plugin disable <plugin> [--all]
claude plugin update  <plugin>
claude plugin list --json --available
claude plugin details <name>
```

Scopes ([plugins-reference § Plugin installation scopes](https://code.claude.com/docs/en/plugins-reference#plugin-installation-scopes)): `user` (`~/.claude/settings.json`, default), `project` (`.claude/settings.json`), `local` (`.claude/settings.local.json`), `managed`.

`defaultEnabled: false` in `plugin.json` or the marketplace entry ships the plugin installed-but-off: "Use this for plugins that add cost or scope a user should opt into, such as one that connects to an external service." ([plugins-reference § Default enablement](https://code.claude.com/docs/en/plugins-reference#default-enablement); requires v2.1.154+). **That description is a near-exact match for a Codex-delegating plugin — consider it.**

Community submission: `/plugin marketplace add anthropics/claude-plugins-community`, install as `<name>@claude-community`. Submit via [claude.ai/admin-settings/directory/submissions/plugins/new](https://claude.ai/admin-settings/directory/submissions/plugins/new) or [platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit) ([plugins § Submit your plugin to the community marketplace](https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace)). "Approved plugins are pinned to a specific commit SHA… The public catalog syncs nightly."

### 4.4 Documented constraints on plugins that spawn external processes

I found **no rule forbidding it** — the whole plugin model assumes it. What exists is a trust posture and a set of mechanical constraints:

- **Trust statement**: "Plugins and marketplaces are highly trusted components that can execute arbitrary code on your machine with your user privileges. Only install plugins and add marketplaces from sources you trust." ([discover-plugins § Security](https://code.claude.com/docs/en/discover-plugins#security))
- **Install warning**: "Make sure you trust a plugin before installing it. Anthropic doesn't control what MCP servers, files, or other software are included in plugins and can't verify that they work as intended." ([discover-plugins § Install plugins](https://code.claude.com/docs/en/discover-plugins#install-plugins))
- **Monitors run unsandboxed**: plugin monitors "run unsandboxed at the same trust level as hooks, and are skipped on hosts where the Monitor tool is unavailable" ([plugins-reference § Monitors](https://code.claude.com/docs/en/plugins-reference#monitors)). They also "run only in interactive CLI sessions" and don't load for project-scope `@skills-dir` plugins.
- **`${user_config.*}` cannot reach a shell**: "substituting a configured value into a shell command would let the shell run whatever that value contains, so the component fails with an error instead" — this applies to shell-form hook commands, monitor commands, and MCP `headersHelper` (v2.1.207+) ([plugins-reference § User configuration](https://code.claude.com/docs/en/plugins-reference#user-configuration)). Pass values via `CLAUDE_PLUGIN_OPTION_<KEY>` env vars or exec-form `args` instead.
- **`pluginConfigs` is ignored from project settings** (v2.1.207+): "Both files live in the workspace, so a cloned repository could supply values there, and those values would flow into plugin hook commands, MCP server configs, LSP commands, and monitor commands." (same section)
- **Plugin-shipped agents can't set `hooks`, `mcpServers`, or `permissionMode`** — "For security reasons" ([plugins-reference § Agents](https://code.claude.com/docs/en/plugins-reference#agents)).
- **Plugin `settings.json` supports only `agent` and `subagentStatusLine`** ([plugins § Ship default settings with your plugin](https://code.claude.com/docs/en/plugins#ship-default-settings-with-your-plugin)) — so no shipped permission rules.
- **Marketplace review runs automated safety screening**: "The review pipeline runs the same check on every submission, along with automated safety screening." ([plugins § Submit your plugin to the community marketplace](https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace)) **Unverified**: whether a plugin that spawns an external LLM agent passes that screening — OpenAI's plugin is distributed from its own marketplace, not the community one, so it is not evidence either way.

---

## Open questions / unverified

1. **Does Codex's Landlock/Seatbelt sandbox initialize correctly inside Claude Code's bubblewrap/Seatbelt sandbox?** Both docs describe nesting hazards generically ([sandboxing § Troubleshooting](https://code.claude.com/docs/en/sandboxing#troubleshooting) mentions `enableWeakerNestedSandbox` for bubblewrap-in-container), but neither documents this specific pairing. Needs empirical testing on Linux and macOS.
2. **Does a `bin/` shim work cleanly with Bash permission prefix rules?** The docs say `bin/` executables are "invokable as bare commands" ([plugins-reference § File locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)) but do not say whether a rule like `Bash(my-tool:*)` matches the bare name or the resolved absolute path.
3. **Exact `codex app-server` request/response shapes.** The published docs list method names only ([Codex app server docs](https://learn.chatgpt.com/docs/app-server)); the full protocol lives in `openai/codex codex-rs/app-server-protocol/` and in `openai/codex-plugin-cc plugins/codex/scripts/lib/app-server-protocol.d.ts`, neither of which I read line by line. The `externalAgentConfig/import/completed` method used by `/codex:transfer` is not in the public docs at all.
4. **Whether `codex mcp-server` is genuinely production-ready.** The docs say Stable; the source says `//! Prototype MCP server.` (`openai/codex codex-rs/mcp-server/src/lib.rs:1`). Unresolved.
5. **`--approve-for-me` release timing.** Present on `openai/codex` `main` (`codex-rs/utils/cli/src/shared_options.rs`), absent from 0.146.0. Which release lands it is unknown.
6. **Whether the community-marketplace safety screening accepts external-agent-spawning plugins.** No documented policy either way.
7. **`hampsterx/codex-mcp-bridge`'s actual interface.** README not fetchable at `main/README.md` (404); repository metadata only.
8. **Codex model names.** Docs reference `gpt-5.5`, `gpt-5.6 Sol/Terra/Luna`, `gpt-5.6-terra`; `openai/codex-plugin-cc` references `gpt-5.3-codex-spark` and `gpt-5.4-mini`; `openai/codex codex-rs/mcp-server/src/codex_tool_config.rs` says "e.g. 'gpt-5.2', 'gpt-5.2-codex'". These are inconsistent across sources and clearly **[fast-moving]** — do not hard-code a model in the plugin; let `config.toml` decide.
9. **Whether `--ephemeral` prevents session resumption.** The live probe emitted a real `thread_id` under `--ephemeral`, but I did not test whether `codex exec resume <that-id>` actually works afterwards. Since `--ephemeral` means "Run without persisting session files to disk" (`openai/codex codex-rs/exec/src/cli.rs`), the id is probably not resumable — verify before pairing `--ephemeral` with a resume-based workflow.
10. **The `enable_codex_api_key_env` gate.** `CODEX_API_KEY` is only honoured when the caller passes `enable_codex_api_key_env: true` into `load_auth`; the flag is `false` at `openai/codex codex-rs/login/src/auth/manager.rs:362` and `true` at line 1070. I did not trace which entry points reach which call site, so it is unconfirmed whether `codex exec` specifically enables it — though the passing integration test `exec_uses_codex_api_key_env_var` strongly implies it does.

### Closed during verification (2026-08-02)

Two items from the original list were resolved and moved into the body:

- **Auth precedence** — resolved by reading `load_auth` (`openai/codex codex-rs/login/src/auth/manager.rs:1217-1303`). Order is `CODEX_API_KEY` → ephemeral store → `CODEX_ACCESS_TOKEN` → `$CODEX_HOME/auth.json`. This also corrected an error: **`OPENAI_API_KEY` is not read at runtime at all**. See [§2.6](#26-authentication).
- **`--json` + `--output-schema` composition** — resolved by a live `codex exec` run on 0.146.0. See [§3.4](#34-getting-structured-output-back-and-its-token-cost) for the exact event sequence, the double-encoded `agent_message.text`, and the simpler `-o <file>` extraction path.

The verification pass also produced two findings that were not previously in the document at all: `codex exec` **hangs on an inherited open stdin** ([§2.2](#22-codex-exec--non-interactive--headless)), and `codex exec` **writes unrelated MCP-client errors to stderr**, so stderr is not a failure signal ([§3.4](#34-getting-structured-output-back-and-its-token-cost)).

---

## Sources

**Anthropic / Claude Code (primary)**
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/plugin-marketplaces
- https://code.claude.com/docs/en/discover-plugins
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/agent-sdk/overview
- https://github.com/anthropics/claude-plugins-community
- https://claude.ai/admin-settings/directory/submissions/plugins/new
- https://platform.claude.com/plugins/submit

**OpenAI / Codex (primary)**
- https://github.com/openai/codex — source of record. Files cited: `codex-rs/cli/src/main.rs`, `codex-rs/cli/src/mcp_cmd.rs`, `codex-rs/exec/src/cli.rs`, `codex-rs/exec/src/lib.rs`, `codex-rs/exec/src/exec_events.rs`, `codex-rs/exec/tests/suite/approval_policy.rs`, `codex-rs/exec/tests/suite/auth_env.rs`, `codex-rs/tui/src/cli.rs`, `codex-rs/utils/cli/src/shared_options.rs`, `codex-rs/utils/cli/src/approval_mode_cli_arg.rs`, `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs`, `codex-rs/mcp-server/src/lib.rs`, `codex-rs/mcp-server/src/codex_tool_config.rs`, `codex-rs/mcp-server/src/message_processor.rs`, `codex-rs/login/src/auth/manager.rs`, `codex-rs/login/src/auth/storage.rs`, `sdk/typescript/package.json`, `sdk/typescript/README.md`, `docs/*.md`
- https://learn.chatgpt.com/docs/non-interactive-mode (was `developers.openai.com/codex/noninteractive`)
- https://learn.chatgpt.com/docs/developer-commands?surface=cli (was `developers.openai.com/codex/cli/reference`)
- https://learn.chatgpt.com/docs/config-file/config-reference (was `developers.openai.com/codex/config-reference`)
- https://learn.chatgpt.com/docs/auth (was `developers.openai.com/codex/auth`)
- https://learn.chatgpt.com/docs/app-server (was `developers.openai.com/codex/app-server`)
- https://learn.chatgpt.com/docs/codex-sdk (was `developers.openai.com/codex/sdk`)
- https://learn.chatgpt.com/docs/pricing (was `developers.openai.com/codex/pricing`)

**Prior art**
- https://github.com/openai/codex-plugin-cc — first-party, Apache-2.0, 30,933 stars / 2,047 forks, active
- https://github.com/hampsterx/codex-mcp-bridge — MIT, 3 stars, active, unverified interface
- https://github.com/sanghyun-io/codex-app-server-plugin — MIT, 0 stars, active, unvetted
- https://github.com/biggora/claude-code-plugin-codex — MIT, 0 stars, reverse direction
- https://github.com/ogmios2/claude-code-codex-mcp — no license, 2 stars, stale (2026-01-26), config-only

**Local verification (this machine, 2026-08-02)**
- `claude --version` → `2.1.220 (Claude Code)`
- `codex --version` → `codex-cli 0.146.0`
- `codex --help`, `codex exec --help`
- `codex exec --ask-for-approval never "x"` → `error: unexpected argument '--ask-for-approval' found` *(re-confirmed in verification pass)*
- `codex exec --approve-for-me "x"` → `error: unexpected argument '--approve-for-me' found` *(re-confirmed)*
- `codex exec --full-auto` → `warning: --full-auto is deprecated; use --sandbox workspace-write instead.` *(re-confirmed)*
- `codex login status` → `Logged in using ChatGPT`
- `codex mcp-server` driven over stdio with a JSON-RPC `initialize` + `notifications/initialized` + `tools/list` handshake → exactly 2 tools (`codex`, `codex-reply`) with the schemas quoted in §2.4
- Live `codex exec --json --ephemeral --skip-git-repo-check -s read-only -C ./probe-wd --output-schema … -o … 'Reply with the single word ok.' < /dev/null` → exit `0`, 4-line JSONL stream, double-encoded `agent_message.text`, unwrapped JSON in the `-o` file (§3.4)
- Same command **without** `< /dev/null` → hung until killed at 2 minutes with zero bytes on stdout (§2.2)
- `GET https://api.github.com/repos/openai/codex-plugin-cc` → 30,933 stars / 2,047 forks / 121 watchers, `owner.type` `Organization`, Apache-2.0, not archived *(star count re-verified)*
