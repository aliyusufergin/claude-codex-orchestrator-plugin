#!/usr/bin/env node
// The Runner — the plugin's only executable surface. Every Forwarder, command and hook goes
// through it, invoked as `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" <subcommand>`.
//
// Exit codes and stdout are the contract; stderr is diagnostic only.
//   0  the Delegation produced a Result, printed to stdout
//   1  the Delegation failed
//   2  the invocation was wrong
//
// The Delegation Budget, dedup, the Workspace, event-stream reconciliation and the prompt
// templates land on top of this in later work. The Worker process contract — sandbox-mode
// selection (ADR-0004) and the environment allowlist — is here.
//
// Environment variables the Runner reads for itself. None reaches the Worker unless the user
// puts it on the allowlist by name.
//   DELEGATE_ENV_ALLOWLIST   extra names or `PREFIX*` globs added to the Worker's environment
//   DELEGATE_CODEX_BIN       the Codex binary, for the test seam
//   DELEGATE_SANDBOXED       `1`/`0` short-circuits outer-sandbox detection, for the test seam —
//                            detection is a measurement, and this is not a way to configure it
//   DELEGATE_TMP_DIR         the directory probed in place of `/tmp`, for the test seam

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_SCHEMA = path.join(PLUGIN_ROOT, "schemas", "skeleton.json");

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: runner.mjs delegate --kind <kind> --prompt <text|-> [--cwd <dir>]`;

/**
 * Task Kind to Delegation Class. The Class is what picks the sandbox mode, so a Task Kind that
 * cannot be placed in one is rejected rather than defaulted — a default here would silently pick
 * a Worker's write authority.
 *
 * This table arrives ahead of the effort settings, prompt templates and per-class schemas that
 * give a Task Kind the rest of its meaning. Whether it stays shaped like this is #5's call, when
 * the first Task Kind is built out.
 */
const DELEGATION_CLASS = {
  review: "advisory",
  diagnosis: "advisory",
  adversarial: "advisory",
  implementation: "verifiable",
  repro: "verifiable",
  migration: "verifiable",
};

const SANDBOX_BY_CLASS = {
  advisory: "read-only",
  verifiable: "workspace-write",
};

/** The fallback mode of ADR-0004, reached only when a precondition for nesting is missing. */
const SANDBOX_FALLBACK = "danger-full-access";

/**
 * The Worker's environment. A Worker is a third-party agent: it inherits nothing implicitly, and
 * every command it runs sees only what is listed here. Entries ending in `*` match by prefix.
 *
 * The set covers what Codex needs to start and what a build needs to run. `CODEX_API_KEY` and
 * `CODEX_ACCESS_TOKEN` are the two variables Codex's runtime auth chain actually reads;
 * `OPENAI_API_KEY` is deliberately absent, because `codex exec` never reads it — it only prefills
 * a field in the interactive TUI, so passing it would leak a secret that buys nothing.
 *
 * A user extends this through `DELEGATE_ENV_ALLOWLIST` rather than editing it.
 */
const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_*",
  "TERM",
  "TMPDIR",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
];

/** Anything that ends the run with a message on stderr and a non-zero exit code. */
class RunnerError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const usageError = (message) => new RunnerError(message, EXIT_USAGE);
const failed = (message) => new RunnerError(message, EXIT_FAILED);

/**
 * Resolve the Codex binary. Never through `npx` — Claude Code's permission wrapper-stripping
 * does not cover it, so an `npx codex` invocation prompts on a rule the user cannot write.
 */
function codexBinary() {
  return process.env.DELEGATE_CODEX_BIN || "codex";
}

/** `$CODEX_HOME`, resolved the way Codex resolves it. */
function codexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".codex");
}

/** The directory Codex's Linux sandbox helper builds its synthetic mount targets under. */
function sandboxHelperTmp() {
  return process.env.DELEGATE_TMP_DIR?.trim() || "/tmp";
}

/**
 * Create `dir` if it is missing and report whether it can be written to — a measurement, not a
 * reading of permission bits, because a sandbox denies the write without changing them.
 */
function ensureWritable(dir) {
  const probe = path.join(dir, `.delegate-write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // The probe is gone or was never created; either way there is nothing to clean up.
    }
  }
}

/**
 * Whether the Runner is itself inside a sandbox, measured by attempting a write outside the
 * working directory (ADR-0004). `$HOME` is the target because that is the boundary the probe
 * measured as holding: an outer sandbox grants the working directory and its subdirectories and
 * refuses `$HOME`.
 *
 * A working directory that *is* `$HOME` reads as unsandboxed. That costs little now that the
 * sandboxed and unsandboxed paths pick the same modes.
 */
function detectOuterSandbox() {
  const forced = process.env.DELEGATE_SANDBOXED?.trim();
  if (forced === "1") return true;
  if (forced === "0") return false;

  const home = homedir();
  if (!home || path.resolve(process.cwd()) === path.resolve(home)) return false;
  return !ensureWritable(home);
}

/**
 * The `-s` mode for one Delegation, per ADR-0004. Under an outer sandbox the preference is to
 * leave Codex's own sandbox on, so that both layers enforce; `danger-full-access` is what is left
 * when the preconditions for nesting are missing, and the alternative to it is not "two layers"
 * but "nothing runs".
 *
 * The `/tmp` precondition is measured independently of the outer-sandbox probe, because Codex's
 * sandbox helper needs it either way. What a failure means differs: sandboxed, the outer jail is
 * still holding, so dropping Codex's own sandbox costs a layer and keeps the Delegation running;
 * unsandboxed there is no other boundary, and `danger-full-access` would be the only thing left
 * standing between a third-party agent and the machine. So that case refuses instead.
 *
 * Returns the mode, plus the diagnostic to print when it is not the preferred one.
 */
function selectSandbox({ delegationClass, sandboxed }) {
  const preferred = SANDBOX_BY_CLASS[delegationClass];

  // Linux only: the obstacle is an implementation detail of Codex's Linux sandbox helper, which
  // is bubblewrap-based and builds mount targets under `/tmp`. macOS pairs Seatbelt with Seatbelt
  // and is unmeasured — it takes the preferred path, on the same reasoning as ADR-0004's rule
  // applying everywhere. That is a placeholder for a measurement: #16 decides what macOS does.
  const tmp = sandboxHelperTmp();
  if (process.platform !== "linux" || ensureWritable(tmp)) return { mode: preferred };

  const cause = `${tmp} is not writable, so Codex's sandbox helper cannot start`;
  if (!sandboxed) throw failed(`${cause} — allow writes to it, or Codex runs unprotected`);
  return { mode: SANDBOX_FALLBACK, reason: `${cause}; allow writes to it to keep both sandboxes on` };
}

/**
 * The environment one Worker sees. Everything not on the allowlist is dropped, including the
 * Runner's own `DELEGATE_*` configuration. `CODEX_HOME` is passed explicitly rather than copied,
 * so that the Worker resolves the same directory the Runner checked for writability.
 */
function workerEnv() {
  const extra = (process.env.DELEGATE_ENV_ALLOWLIST ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const exact = new Set();
  const prefixes = [];
  for (const entry of [...WORKER_ENV_ALLOWLIST, ...extra]) {
    // A bare `*` is dropped rather than honoured: an empty prefix matches every name, which turns
    // the allowlist back into the inheritance it exists to replace — silently, and in the one
    // place in this plugin where a silent failure leaks the user's secrets.
    if (entry === "*") continue;
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else exact.add(entry);
  }

  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) env[name] = value;
  }
  env.CODEX_HOME = codexHome();
  return env;
}

function spawnCodex(args) {
  return new Promise((resolve) => {
    const child = spawn(codexBinary(), args, {
      cwd: process.cwd(),
      env: workerEnv(),
      // stdin is /dev/null: `codex exec` reads it to EOF before starting the turn, so an
      // inherited open stdin hangs it forever. stderr passes straight through as diagnostic
      // output — unrelated MCP client errors land there on every run, so it is never read as a
      // failure signal. stdout carries the JSONL event stream, which nothing consumes yet.
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", (error) => resolve({ spawnError: error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Run one `codex exec` and return the payload it wrote, or the reason it produced none.
 *
 * `--output-schema` plus `-o <file>` writes the payload already unwrapped, while the copy in the
 * event stream's `agent_message.text` is double-encoded — so the file is the source.
 */
async function runCodex({ prompt, cwd, sandbox }) {
  // The payload directory is not under `/tmp`: Codex's sandbox helper mounts over paths there,
  // and a file it shadows is written, reported as written, and absent afterwards (ADR-0004).
  // `$CODEX_HOME` is the one directory the Runner has already established is writable.
  const payloadDir = mkdtempSync(path.join(codexHome(), "delegate-"));
  const outputFile = path.join(payloadDir, "payload.json");

  const args = [
    "exec",
    "--json",
    "-s",
    sandbox,
    "--output-schema",
    OUTPUT_SCHEMA,
    "-o",
    outputFile,
    // The working directory travels as a flag. The Runner never cd's: a subagent's cwd is not
    // the Runner's to move.
    "-C",
    cwd,
    // Everything after `--` is the prompt, so a prompt that opens with a dash is a prompt and
    // not a flag.
    "--",
    prompt,
  ];

  try {
    const { code, signal, spawnError } = await spawnCodex(args);

    if (spawnError) throw failed(`could not run ${codexBinary()}: ${spawnError.message}`);
    if (signal) throw failed(`codex exec was killed by ${signal}`);
    if (code !== 0) throw failed(`codex exec exited ${code}`);
    if (!existsSync(outputFile)) throw failed("codex exec wrote no payload");

    const payload = readFileSync(outputFile, "utf8");
    if (payload.trim() === "") throw failed("codex exec wrote an empty payload");

    return payload;
  } finally {
    rmSync(payloadDir, { recursive: true, force: true });
  }
}

function readPrompt(value) {
  // `-` means the prompt is on stdin, which is how a caller passes text it would rather not
  // quote into argv.
  const prompt = value === "-" ? readFileSync(0, "utf8") : value;
  const trimmed = prompt.trim();
  if (trimmed === "") throw usageError("--prompt is empty");
  return trimmed;
}

async function delegate(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        kind: { type: "string" },
        prompt: { type: "string" },
        cwd: { type: "string" },
      },
    }));
  } catch (error) {
    throw usageError(error.message);
  }

  // The Task Kind's effort table, prompt templates and per-class schemas are later work; its
  // Delegation Class is not, because that is what selects the Worker's sandbox mode.
  if (!values.kind) throw usageError("delegate requires --kind");
  if (values.prompt === undefined) throw usageError("delegate requires --prompt");

  const delegationClass = DELEGATION_CLASS[values.kind];
  if (!delegationClass) {
    throw usageError(
      `unknown --kind: ${values.kind} (one of ${Object.keys(DELEGATION_CLASS).join(", ")})`,
    );
  }

  const prompt = readPrompt(values.prompt);
  const cwd = path.resolve(values.cwd ?? process.cwd());
  if (!existsSync(cwd)) throw usageError(`--cwd is not a directory: ${cwd}`);

  // A precondition for every Delegation, `--ephemeral` or not: with `$CODEX_HOME` read-only,
  // `codex exec` dies at app-server startup before emitting a single event. It fails at a
  // different layer from the sandbox helper's `/tmp`, so it is reported separately and no sandbox
  // mode rescues it.
  const home = codexHome();
  if (!ensureWritable(home)) {
    throw failed(`$CODEX_HOME is not writable: ${home} — codex exec cannot start without it`);
  }

  const { mode, reason } = selectSandbox({ delegationClass, sandboxed: detectOuterSandbox() });
  if (reason) process.stderr.write(`running Codex with -s ${mode}: ${reason}\n`);

  const payload = await runCodex({ prompt, cwd, sandbox: mode });
  process.stdout.write(payload.endsWith("\n") ? payload : `${payload}\n`);
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  switch (subcommand) {
    case "delegate":
      return delegate(rest);
    case undefined:
      throw usageError("no subcommand given");
    default:
      throw usageError(`unknown subcommand: ${subcommand}`);
  }
}

try {
  await main();
  process.exitCode = EXIT_OK;
} catch (error) {
  if (!(error instanceof RunnerError)) throw error;
  process.stderr.write(error.code === EXIT_USAGE ? `${error.message}\n${USAGE}\n` : `${error.message}\n`);
  process.exitCode = error.code;
}
