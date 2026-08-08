// The environment — what this plugin measures about the machine it is running on, and the Worker
// process contract it decides from those measurements.
//
// Most of what is here is a measurement rather than a setting: whether a directory can actually be
// written to, whether something outside is already jailing this process, which platform the sandbox
// rules are being decided against, where the machine will let state outlive a run. None of those is
// read from a permission bit or a config file, because a sandbox denies a write without changing
// either. The two that are not measurements — the sandbox mode a Delegation Class gets, and the
// allowlist a Worker's environment is filtered to — are here because they are what the measurements
// are taken *for*: together they are the whole of what one Worker process is allowed to see and do,
// and splitting the rule from the evidence it rests on would put the two out of reach of each other.
//
// It is one module because it has two readers with nothing else in common. The Delegation path uses
// it to decide what a Worker is allowed to do; readiness uses the same measurements to say what
// would go wrong before anything is delegated. Either one reaching into the other's file would put
// an import back the other way, and exporting them from `runner.mjs` would turn a CLI entry point
// into a library.
//
// ADR-0004 governs the sandbox half: why nesting Codex's own sandbox inside an outer one is
// preferred, what precondition that nesting has, and what is left when the precondition is missing.
//
// The environment variables read here. None of them reaches a Worker unless the user puts it on the
// allowlist by name. The four numbers the plugin enforces have their own environment variables,
// listed in `config.mjs`.
//   CODEX_HOME               Codex's own state directory, resolved the way Codex resolves it
//   CLAUDE_PLUGIN_DATA       the harness's persistent directory, where state lives when it exists
//   DELEGATE_ENV_ALLOWLIST   extra names or `PREFIX*` globs added to the Worker's environment
//   DELEGATE_STATE_DIR       where Results, the Budget ledger and the dedup cache live
//   DELEGATE_CODEX_BIN       the Codex binary, for the test seam
//   DELEGATE_SANDBOXED       `1`/`0` short-circuits outer-sandbox detection, for the test seam —
//                            detection is a measurement, and this is not a way to configure it
//   DELEGATE_TMP_DIR         the directory probed in place of `/tmp`, for the test seam
//   DELEGATE_PLATFORM        the platform the sandbox rules are decided against, for the test seam

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { failed } from "./errors.mjs";

/**
 * The `-s` mode each Delegation Class asks for. Exported because readiness names these modes to
 * the user, and a mode named in a report that is not the mode a Delegation is invoked with is the
 * user being told the enforcement is something it is not.
 */
export const SANDBOX_BY_CLASS = {
  advisory: "read-only",
  verifiable: "workspace-write",
};

/** The fallback mode of ADR-0004, reached only when a precondition for nesting is missing. */
export const SANDBOX_FALLBACK = "danger-full-access";

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
export const WORKER_ENV_ALLOWLIST = [
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

/**
 * Resolve the Codex binary. Never through `npx` — Claude Code's permission wrapper-stripping
 * does not cover it, so an `npx codex` invocation prompts on a rule the user cannot write.
 */
export function codexBinary() {
  return process.env.DELEGATE_CODEX_BIN || "codex";
}

/** `$CODEX_HOME`, resolved the way Codex resolves it. */
export function codexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".codex");
}

/**
 * Where the plugin's own state lives: Results, the Budget ledger, the dedup cache and the user's
 * settings. `$CLAUDE_PLUGIN_DATA` is the harness's persistent directory and survives plugin
 * updates, which `${CLAUDE_PLUGIN_ROOT}` explicitly does not — but the Runner is also invoked
 * outside a plugin install, and under an outer sandbox `$HOME` is not writable. `$CODEX_HOME` is,
 * because a Delegation has already failed by then if it is not, so it is the fallback.
 *
 * All of it is outside any repository. That is required of the Budget, which is the Worker's
 * provider's and spans every repository the user works in, and it is what keeps a Worker's Result
 * out of the user's source tree.
 */
export function stateRoot() {
  const configured = process.env.DELEGATE_STATE_DIR?.trim() || process.env.CLAUDE_PLUGIN_DATA?.trim();
  return configured ? path.resolve(configured) : path.join(codexHome(), "delegate");
}

/**
 * The directories Codex's sandbox helper may be handed as writable and build its synthetic mount
 * targets under: `/tmp`, and `$TMPDIR` where the machine puts that somewhere else. Nothing the
 * Runner depends on outliving a run may live under either — a path there is mounted over, and the
 * Worker's writes into it are reported as successful and are gone afterwards (C6, ADR-0004).
 *
 * `$DELEGATE_TMP_DIR` *replaces* the set rather than joining it. It is the seam that stands in for
 * `/tmp`, and a test that could not move the machine's own `/tmp` out of the way could not exercise
 * this rule at all — every fixture directory it owns is under it.
 */
export function sandboxWritableRoots() {
  const seam = process.env.DELEGATE_TMP_DIR?.trim();
  if (seam) return [seam];
  return [...new Set(["/tmp", tmpdir()])];
}

/** The directory Codex's Linux sandbox helper builds its synthetic mount targets under. */
export function sandboxHelperTmp() {
  return sandboxWritableRoots()[0];
}

/**
 * The platform the sandbox rules are decided against. Everything ADR-0004 measured is Linux, and
 * two of its rules ask what platform this is — the `/tmp` precondition, which is an implementation
 * detail of Codex's Linux sandbox helper, and readiness saying so on the platform where the
 * conclusion is unverified.
 *
 * `$DELEGATE_PLATFORM` is the test seam. Like `$DELEGATE_SANDBOXED` it stands in for a measurement
 * rather than configuring one: a mac user cannot make the Linux conclusion apply by setting it.
 */
export function platform() {
  return process.env.DELEGATE_PLATFORM?.trim() || process.platform;
}

/**
 * Create `dir` if it is missing and report whether it can be written to — a measurement, not a
 * reading of permission bits, because a sandbox denies the write without changing them.
 */
export function ensureWritable(dir) {
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
 * Whether Codex's own sandbox helper can start here — the one precondition of ADR-0004's nesting
 * whose absence is survivable. The other, a writable `$CODEX_HOME`, is not asked here because it
 * has no mode to choose between: it kills `codex exec` under every one of them, so it is a hard
 * failure both for readiness and for the Runner, never a fallback trigger.
 *
 * Linux only: the obstacle is an implementation detail of Codex's Linux sandbox helper, which is
 * bubblewrap-based and builds its mount targets under `/tmp`. macOS pairs Seatbelt with Seatbelt
 * and is unmeasured — it reads ready without being probed, on the same reasoning as ADR-0004's
 * rule applying everywhere. That is a placeholder for a measurement: #16 decides what macOS does.
 *
 * A predicate and nothing else, because its two callers want different things from the one answer:
 * `selectSandbox` wants a mode and refuses the Delegation unsandboxed, readiness wants a state and
 * a remedy and never refuses. What they share is the measurement, not what either does about it.
 */
export function sandboxHelperReady() {
  return platform() !== "linux" || ensureWritable(sandboxHelperTmp());
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
export function detectOuterSandbox() {
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
export function selectSandbox({ delegationClass, sandboxed }) {
  const preferred = SANDBOX_BY_CLASS[delegationClass];
  if (sandboxHelperReady()) return { mode: preferred };

  const tmp = sandboxHelperTmp();
  const cause = `${tmp} is not writable, so Codex's sandbox helper cannot start`;
  if (!sandboxed) throw failed(`${cause} — allow writes to it, or Codex runs unprotected`);
  return { mode: SANDBOX_FALLBACK, reason: `${cause}; allow writes to it to keep both sandboxes on` };
}

/**
 * The environment one Worker sees. Everything not on the allowlist is dropped, including the
 * Runner's own `DELEGATE_*` configuration. `CODEX_HOME` is passed explicitly rather than copied,
 * so that the Worker resolves the same directory the Runner checked for writability.
 */
export function workerEnv() {
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
