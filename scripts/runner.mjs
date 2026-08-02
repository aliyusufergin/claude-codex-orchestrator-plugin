#!/usr/bin/env node
// The Runner — the plugin's only executable surface. Every Forwarder, command and hook goes
// through it, invoked as `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" <subcommand>`.
//
// Exit codes and stdout are the contract; stderr is diagnostic only.
//   0  the Delegation produced a Result, printed to stdout
//   1  the Delegation failed
//   2  the invocation was wrong
//
// This is the walking skeleton: it carries the transport and nothing else. Task Kinds, the
// Delegation Budget, dedup, the Workspace, event-stream reconciliation, sandbox-mode selection
// (ADR-0004) and the Worker's environment allowlist all land on top of it in later work.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_SCHEMA = path.join(PLUGIN_ROOT, "schemas", "skeleton.json");

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: runner.mjs delegate --kind <kind> --prompt <text|-> [--cwd <dir>]`;

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

function spawnCodex(args) {
  return new Promise((resolve) => {
    const child = spawn(codexBinary(), args, {
      cwd: process.cwd(),
      // TODO(#4): hand the Worker an explicit environment allowlist rather than this inheritance.
      env: process.env,
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
async function runCodex({ prompt, cwd }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "delegate-"));
  const outputFile = path.join(scratch, "payload.json");

  const args = [
    "exec",
    "--json",
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
    rmSync(scratch, { recursive: true, force: true });
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

  // The Task Kind is required but not yet interpreted: the effort table, prompt templates and
  // per-class schemas that give it meaning are later work.
  if (!values.kind) throw usageError("delegate requires --kind");
  if (values.prompt === undefined) throw usageError("delegate requires --prompt");

  const prompt = readPrompt(values.prompt);
  const cwd = path.resolve(values.cwd ?? process.cwd());
  if (!existsSync(cwd)) throw usageError(`--cwd is not a directory: ${cwd}`);

  const payload = await runCodex({ prompt, cwd });
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
