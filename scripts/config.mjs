// The plugin's numbers, in one place.
//
// Every value here is **provisional** (O3). None of them is measured: the Budget ceiling per
// window, the dedup TTL and the diff-size threshold above which the Orchestrator stops reading and
// asks the user are all to be calibrated against real runs, and the Runner's ledger records what
// that calibration will need. Gathering them here rather than spreading them through the Runner is
// what makes calibration an edit to one file — and what makes "what does this plugin allow"
// answerable without reading the enforcement.
//
// Every number is user-overridable, twice over:
//   - an environment variable, for one session or one invocation
//   - `settings.json` in the state directory, written by `/delegate:quota` and durable
// The environment wins, because it is the more specific of the two and the easier to undo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Where the user's own numbers are persisted — beside the Budget ledger, and as provider-wide. */
export const SETTINGS_FILE = "settings.json";

/**
 * A setting as a number, or `NaN`. Not `Number(raw)`: that reads `""`, `null`, `[]` and `false` as
 * `0` — and a `/delegate:quota` invocation whose empty argument silently set the ceiling to zero
 * would refuse every Delegation from then on, for a command the user ran to *look* at the Budget.
 */
function toNumber(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return Number.NaN;
}

const wholeNumber = (raw) => {
  const value = toNumber(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

const positive = (raw) => {
  const value = toNumber(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const atLeastZero = (raw) => {
  const value = toNumber(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * One row per number, carrying its own name, its provisional default, how to read a user's version
 * of it and how to show it. A table rather than four constants so that `/delegate:quota` can print
 * the whole configuration without a second list to keep in step with this one.
 */
export const SETTINGS = {
  budget_ceiling: {
    env: "DELEGATE_BUDGET_CEILING",
    fallback: 20,
    label: "Delegations per window",
    format: (value) => `${value}`,
    // Zero is a legitimate setting: it refuses every Delegation, which is how a user turns
    // delegation off without uninstalling the plugin.
    parse: wholeNumber,
    expects: "a whole number of Delegations, 0 or more",
  },
  budget_window_hours: {
    env: "DELEGATE_BUDGET_WINDOW_HOURS",
    fallback: 5,
    label: "Rolling window",
    format: (value) => `${value}h`,
    parse: positive,
    expects: "a number of hours greater than 0",
  },
  dedup_ttl_minutes: {
    env: "DELEGATE_DEDUP_TTL_MINUTES",
    fallback: 15,
    label: "Dedup TTL",
    format: (value) => `${value}m`,
    // Zero disables the cache, which is what a user reaches for when they want every Delegation
    // to actually run.
    parse: atLeastZero,
    expects: "a number of minutes, 0 or more",
  },
  diff_max_lines: {
    env: "DELEGATE_DIFF_MAX_LINES",
    fallback: 400,
    label: "Diff read threshold",
    format: (value) => `${value} lines`,
    parse: wholeNumber,
    expects: "a whole number of lines, 0 or more",
  },
};

function settingsFile(stateRoot) {
  return path.join(stateRoot, SETTINGS_FILE);
}

/** The user's persisted numbers, or nothing at all — an unreadable file is not a reason to refuse. */
function readStored(stateRoot, warn) {
  const file = settingsFile(stateRoot);
  if (!existsSync(file)) return {};
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    return stored !== null && typeof stored === "object" ? stored : {};
  } catch (error) {
    warn(`ignoring ${file}: ${error.message}`);
    return {};
  }
}

/**
 * Every number the plugin enforces, with where each one came from. `sources` is for
 * `/delegate:quota`: a user who has raised a ceiling is entitled to see that it took.
 *
 * A value that cannot be read is reported and skipped rather than thrown on. A typo in one
 * environment variable should cost the user that setting, not every Delegation.
 */
export function readSettings(stateRoot, { warn = () => {} } = {}) {
  const stored = readStored(stateRoot, warn);
  const values = {};
  const sources = {};

  for (const [key, spec] of Object.entries(SETTINGS)) {
    values[key] = spec.fallback;
    sources[key] = "default";

    if (Object.hasOwn(stored, key)) {
      const parsed = spec.parse(stored[key]);
      if (parsed === null) warn(`ignoring ${key} in ${SETTINGS_FILE}: expected ${spec.expects}`);
      else {
        values[key] = parsed;
        sources[key] = SETTINGS_FILE;
      }
    }

    const raw = process.env[spec.env];
    if (raw !== undefined && raw.trim() !== "") {
      const parsed = spec.parse(raw.trim());
      if (parsed === null) warn(`ignoring $${spec.env}: expected ${spec.expects}`);
      else {
        values[key] = parsed;
        sources[key] = `$${spec.env}`;
      }
    }
  }

  return { values, sources };
}

/**
 * Persist one number. This is the only place the plugin writes its own configuration, and
 * `/delegate:quota` is the only caller — the ceiling is the one place the bound is negotiable, and
 * negotiating it is the user's act, never the Orchestrator's.
 */
export function writeSetting(stateRoot, key, value) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`no such setting: ${key}`);
  const parsed = spec.parse(value);
  if (parsed === null) throw new Error(`${key} expects ${spec.expects}`);

  const file = settingsFile(stateRoot);
  const stored = readStored(stateRoot, () => {});
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...stored, [key]: parsed }, null, 2)}\n`);
  return parsed;
}
