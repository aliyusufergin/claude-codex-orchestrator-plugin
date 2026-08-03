// Test seam 1: drive the Runner CLI as a real process, in a real temporary git repository,
// against the fake Codex binary. Assertions are on stdout, exit code and filesystem state —
// never on the Runner's internals.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const RUNNER = path.join(REPO_ROOT, "scripts", "runner.mjs");
export const FAKE_CODEX = path.join(REPO_ROOT, "tests", "fixtures", "fake-codex.mjs");

const RUN_TIMEOUT_MS = 10_000;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

/**
 * A temporary git repository with one commit, plus a state directory outside it for the fake
 * Codex binary's configuration and invocation record — outside so that assertions about the
 * user's working tree are not polluted by the fake's own bookkeeping.
 */
export async function createFixtureRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "delegate-test-"));
  const repo = path.join(root, "repo");
  const fakeDir = path.join(root, "fake");
  // A fixture $CODEX_HOME and a stand-in for `/tmp`, so that the Runner's two writability
  // preconditions are measured against directories a test owns rather than the machine's.
  const codexHome = path.join(root, "codex-home");
  const tmpProbe = path.join(root, "tmp-probe");
  // Where persisted Results land. Fixed by the fixture rather than left to default, because the
  // default reads `$CLAUDE_PLUGIN_DATA` — which is set for real in the session these tests are
  // written in, and would put fixture Results in the developer's own plugin data directory.
  const stateDir = path.join(root, "state");
  mkdirSync(repo);
  mkdirSync(fakeDir);
  mkdirSync(codexHome);
  mkdirSync(tmpProbe);

  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "test"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  t.after(() => rmSync(root, { recursive: true, force: true }));

  return {
    root,
    repo,
    fakeDir,
    codexHome,
    tmpProbe,
    stateDir,
    /** Every persisted Result, newest first is not promised — there is one per Delegation. */
    persistedResults() {
      const dir = path.join(stateDir, "results");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((entry) =>
        JSON.parse(readFileSync(path.join(dir, entry), "utf8")),
      );
    },
    configureFake(config) {
      writeFileSync(path.join(fakeDir, "fake-codex.json"), `${JSON.stringify(config, null, 2)}\n`);
    },
    invocation() {
      return JSON.parse(readFileSync(path.join(fakeDir, "fake-codex-invocation.json"), "utf8"));
    },
  };
}

/**
 * Run the Runner. Resolves with { code, signal, stdout, stderr, timedOut } — never rejects on a
 * non-zero exit, because the exit code is part of the contract under test.
 *
 * `holdStdinOpen` leaves the Runner's own stdin as an open, unwritten pipe: the shape that makes
 * an inherited stdin hang `codex exec` forever.
 */
export function runRunner(fixture, args, options = {}) {
  const { cwd = fixture.repo, env = {}, stdin = null, holdStdinOpen = false } = options;

  const child = spawn(process.execPath, [RUNNER, ...args], {
    cwd,
    env: {
      ...process.env,
      DELEGATE_CODEX_BIN: FAKE_CODEX,
      DELEGATE_FAKE_CODEX_DIR: fixture.fakeDir,
      CODEX_HOME: fixture.codexHome,
      DELEGATE_STATE_DIR: fixture.stateDir,
      // Sandbox detection is a measurement of the machine the tests run on, so it is forced off
      // by default and turned on explicitly by the tests that are about it.
      DELEGATE_SANDBOXED: "0",
      DELEGATE_TMP_DIR: fixture.tmpProbe,
      // The Worker's environment is an allowlist, and the fake Codex binary finds its state
      // directory through one variable of its own. Extending the allowlist is how a user gets a
      // variable through, so the fake goes through the same door.
      DELEGATE_ENV_ALLOWLIST: "DELEGATE_FAKE_CODEX_DIR",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  if (stdin !== null) {
    child.stdin.end(stdin);
  } else if (!holdStdinOpen) {
    child.stdin.end();
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (holdStdinOpen && !child.stdin.destroyed) child.stdin.end();
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** One schema-conforming Advisory finding, with the fields a test cares about overridden. */
export function advisoryFinding(overrides = {}) {
  return {
    severity: "high",
    title: "Token expiry is compared with the wrong operator",
    body: "A token expiring exactly now is treated as valid, so the refresh never fires.",
    file: "src/auth/token.ts",
    line_start: 44,
    line_end: 45,
    evidence: "if (expiresAt < Date.now()) {\n  return refresh(token);\n}",
    confidence: 0.8,
    recommendation: "Compare with `<=`, and cover the boundary with a test.",
    ...overrides,
  };
}

/** One schema-conforming Advisory Result, with the fields a test cares about overridden. */
export function advisoryPayload(overrides = {}) {
  return {
    verdict: "concerns",
    summary: "Read the diff and the callers it touches. One boundary bug, nothing structural.",
    findings: [advisoryFinding()],
    next_steps: ["Run the auth suite once the operator is fixed."],
    ...overrides,
  };
}

/** The Result id out of a rendered Advisory Result. */
export function resultId(stdout) {
  return stdout.match(/Result `([a-z]+-[0-9a-f]{8})`/)?.[1];
}

/** The value passed to a flag in the fake's recorded argv, or undefined. */
export function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
