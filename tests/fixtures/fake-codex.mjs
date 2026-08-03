#!/usr/bin/env node
// Fake Codex binary for the Runner CLI test seam.
//
// The Runner resolves the Codex binary from $DELEGATE_CODEX_BIN, so tests point that at this
// file and get a deterministic, free, offline Codex that can reproduce the transport's
// pathological cases (stdin hang, stderr noise, success-with-nothing-written).
//
// Configuration is read from `fake-codex.json` in $DELEGATE_FAKE_CODEX_DIR, falling back to the
// process's own working directory. It is deliberately not read from the environment: the Runner
// will eventually hand the Worker a filtered environment, and the fake has to keep working when
// it does.
//
// Recognised config keys, all optional:
//   readStdin       read stdin to EOF before doing anything (default true — real `codex exec`
//                   does this, and it is what hangs forever on an inherited open stdin)
//   events          array of objects emitted as JSONL on stdout (default: a canned turn)
//   streamPayload   payload embedded double-encoded in the default stream's agent_message.text
//   streamTail      text written to stdout after the events, verbatim and with no trailing
//                   newline — for a stream cut off mid-record
//   payload         payload written unwrapped to the `-o` file (default: a minimal Advisory
//                   Result, so that a test which is not about the payload still gets one the
//                   Runner will render)
//   rawPayload      text written to the `-o` file verbatim, in place of `payload` — for the shapes
//                   a JSON-encoded payload cannot express, such as a turn cut off mid-write
//   writePayload    set false to exit successfully having written no payload (probe case C)
//   writeFiles      { relativePath: contents } written under the `-C` directory
//   refuseWrites    set true to write nothing at all — no payload, no files — while still
//                   emitting a stream and exiting with `exitCode`
//   threadId        the id emitted in `thread.started` (default: a fixed UUID)
//   refuseResume    set true to reproduce a refused `codex exec resume`: nothing on stdout at all,
//                   the measured `thread/resume` error on stderr, exit 1. Ignored by a fresh run,
//                   so one configuration covers both halves of the fallback
//   stderr          text written to stderr
//   exitCode        process exit code (default 0)
//
// Every run records what it saw to `fake-codex-invocation.json` in the same directory:
// argv, environment, working directory, parsed flags, and how many bytes of stdin it read. The
// same record is appended to `fake-codex-invocations.jsonl`, so that a test about dedup can ask
// how many times Codex was invoked rather than only what the last invocation looked like.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const VALUE_FLAGS = new Set([
  "-o",
  "--output-last-message",
  "--output-schema",
  "-C",
  "--cd",
  "-c",
  "--config",
  "-s",
  "--sandbox",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-i",
  "--image",
  "--add-dir",
]);

const stateDir = process.env.DELEGATE_FAKE_CODEX_DIR ?? process.cwd();

function readConfig() {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, "fake-codex.json"), "utf8"));
  } catch {
    return {};
  }
}

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  // The subcommand chain and the operands are both positionals to clap, and only their position
  // relative to `--` tells them apart. `codex exec resume -- <thread> <prompt>` needs both halves
  // read separately, so they are kept apart here rather than reconstructed by guessing.
  const command = [];
  const operands = [];
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (onlyPositionals) {
      positionals.push(arg);
      operands.push(arg);
    } else if (arg === "--") {
      // Everything after `--` is a positional, as clap does it.
      onlyPositionals = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (arg === "-c" || arg === "--config") {
        (flags.config ??= []).push(value);
      } else {
        flags[arg] = value;
      }
    } else if (arg.startsWith("-")) {
      flags[arg] = true;
    } else {
      positionals.push(arg);
      command.push(arg);
    }
  }
  return { flags, positionals, command, operands };
}

async function readStdinBytes() {
  let bytes = 0;
  for await (const chunk of process.stdin) bytes += chunk.length;
  return bytes;
}

const config = readConfig();
const argv = process.argv.slice(2);
const { flags, positionals, command, operands } = parseArgv(argv);

const stdinBytes = config.readStdin === false ? null : await readStdinBytes();

// `codex exec resume [SESSION_ID] [PROMPT]` takes the thread as its first operand and the prompt as
// its second; `codex exec [PROMPT]` takes only the prompt.
const resuming = command[1] === "resume";

const invocation = {
  argv: process.argv,
  args: argv,
  flags,
  positionals,
  subcommand: command.join(" ") || null,
  thread: resuming ? operands[0] ?? null : null,
  prompt: (resuming ? operands.slice(1) : operands).join(" ") || null,
  cwd: process.cwd(),
  env: process.env,
  stdinBytes,
};

writeFileSync(
  path.join(stateDir, "fake-codex-invocation.json"),
  `${JSON.stringify(invocation, null, 2)}\n`,
);
appendFileSync(
  path.join(stateDir, "fake-codex-invocations.jsonl"),
  `${JSON.stringify(invocation)}\n`,
);

// A resume Codex will not honour, exactly as 0.146.0 does it: not one byte on stdout — no
// `thread.started`, no events at all — the error on stderr, and exit 1. The fresh Delegation the
// Runner falls back to is a different invocation and is unaffected by this.
if (resuming && config.refuseResume === true) {
  const thread = invocation.thread ?? "";
  process.stderr.write(
    `Error: thread/resume: thread/resume failed: no rollout found for thread id ${thread} (code -32600)\n`,
  );
  process.exit(1);
}

const DEFAULT_PAYLOAD = {
  verdict: "pass",
  summary: "ok",
  findings: [],
  next_steps: [],
};

const payload = config.payload ?? DEFAULT_PAYLOAD;
const streamPayload = config.streamPayload ?? payload;
// A resumed run reports the thread it was handed; a fresh one reports the thread it opened.
const threadId = invocation.thread ?? config.threadId ?? "00000000-0000-4000-8000-000000000000";
const events = config.events ?? [
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: JSON.stringify(streamPayload) },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  },
];

for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
if (config.streamTail) process.stdout.write(config.streamTail);

const refuseWrites = config.refuseWrites === true;

const workingRoot = flags["-C"] ?? flags["--cd"] ?? process.cwd();
if (!refuseWrites) {
  for (const [relative, contents] of Object.entries(config.writeFiles ?? {})) {
    const target = path.resolve(workingRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

const outputFile = flags["-o"] ?? flags["--output-last-message"];
if (outputFile && !refuseWrites && config.writePayload !== false) {
  writeFileSync(outputFile, config.rawPayload ?? `${JSON.stringify(payload)}\n`);
}

if (config.stderr) process.stderr.write(config.stderr);

process.exit(config.exitCode ?? 0);
