// Readiness — what `runner.mjs ready` measures, and the report it writes.
//
// This is the `SessionStart` hook and the readiness half of `/delegate:setup`. Every check here is
// a failure that would otherwise surface minutes later as a Delegation that died without explaining
// itself, so the remedy is the product: the state of a check is worth a word, and what to do about
// it is worth a paragraph.
//
// It owns no state. What it owns is the questions — and it asks them of `environment.mjs`, the same
// measurements the Delegation path decides against, so that what readiness reports and what a
// Delegation then does cannot drift. Its own two probes are here because nothing else reaches for
// them: the provider's host, and the Codex binary itself.
//
// The environment variables read here:
//   CODEX_API_KEY            checked for presence only, as one of the two ways a Worker is
//   CODEX_ACCESS_TOKEN       authenticated; neither value is read, printed or otherwise touched
//   DELEGATE_API_HOST        `host[:port]` probed in place of the provider's API, for the test seam

import { spawnSync } from "node:child_process";
import net from "node:net";
import { parseArgs } from "node:util";

import { budgetState } from "./budget.mjs";
import { budgetLimits, readSettings, settingsTable } from "./config.mjs";
import {
  SANDBOX_BY_CLASS,
  SANDBOX_FALLBACK,
  WORKER_ENV_ALLOWLIST,
  codexBinary,
  codexHome,
  detectOuterSandbox,
  ensureWritable,
  platform,
  sandboxHelperReady,
  sandboxHelperTmp,
  stateRoot,
  workerEnv,
} from "./environment.mjs";
import { failed, usageError, warn } from "./errors.mjs";
import { filled, oneLine } from "./text.mjs";

/**
 * Where the Worker's provider is reached. Probed only to answer one question — whether an outer
 * sandbox is holding the connection — so it is a TCP connect and never a request: readiness is not
 * entitled to spend a token of the user's allowance finding out whether the network is there.
 */
const API_HOST = "api.openai.com";
const API_PORT = 443;

/** How long that probe waits before the host counts as unreachable. `SessionStart` is blocking. */
const API_PROBE_TIMEOUT_MS = 2500;

/**
 * How long a question put to the Codex binary may take before it counts as no answer. Small on
 * purpose: `SessionStart` blocks, two of these run in sequence, and a `codex --version` that takes
 * longer than this is a binary that is not going to carry a Delegation either.
 */
const CODEX_PROBE_TIMEOUT_MS = 5_000;

/**
 * The two Claude Code settings a sandboxed user needs, spelled as they are written there. Named
 * constants because readiness is the only place the plugin can tell them about either, and a
 * setting named approximately is one the user cannot search for.
 */
const ALLOW_WRITE = "sandbox.filesystem.allowWrite";
const ALLOWED_DOMAINS = "sandbox.network.allowedDomains";

/** The provider endpoint readiness probes, or the one `$DELEGATE_API_HOST` stands in with. */
function apiEndpoint() {
  const configured = process.env.DELEGATE_API_HOST?.trim();
  if (!configured) return { host: API_HOST, port: API_PORT };
  const [, host, port] = configured.match(/^(.*?)(?::(\d+))?$/);
  return { host: host || API_HOST, port: port ? Number(port) : API_PORT };
}

/** Whether the provider's host answers at all, and what it said if it did not. */
function probeApiHost({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (reachable, detail) => {
      socket.destroy();
      resolve({ reachable, detail });
    };
    socket.setTimeout(API_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true, "it answered"));
    socket.once("timeout", () => settle(false, `no answer within ${API_PROBE_TIMEOUT_MS}ms`));
    socket.once("error", (error) => settle(false, error.message));
  });
}

/**
 * Ask the Codex binary one question, under the same filtered environment a Worker gets. That is
 * the point of asking it here rather than reading a file: a login that exists but does not survive
 * the allowlist is a login the Worker does not have.
 */
function askCodex(args) {
  const run = spawnSync(codexBinary(), args, {
    env: workerEnv(),
    encoding: "utf8",
    timeout: CODEX_PROBE_TIMEOUT_MS,
    // stdin is /dev/null for the same reason every other invocation's is.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const said = oneLine([run.stdout, run.stderr].filter((stream) => filled(stream)).join(" "));
  return {
    ran: !run.error,
    ok: !run.error && run.status === 0,
    // A run killed by the timeout has no exit code at all, so how it ended is described rather than
    // numbered — `exited null` is the shape of a report that stopped short of saying anything.
    ended: run.status === null ? `did not answer within ${CODEX_PROBE_TIMEOUT_MS}ms` : `exited ${run.status}`,
    said,
    error: run.error,
  };
}

/** `1 problem` / `2 problems`, because a readiness headline that says `1 problems` reads as a bug. */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The readiness report. One line per check with its state, then what to do about anything that is
 * not `ok` — the remedy is the whole product here, because every one of these failures otherwise
 * arrives minutes later as a Delegation that died without saying why.
 */
function renderReadiness({ checks, setup, root, settings, sources }) {
  const failures = checks.filter((check) => check.state === "fail");
  const warnings = checks.filter((check) => check.state === "warn");
  const headline =
    failures.length > 0
      ? `Delegation readiness — **not ready**: ${plural(failures.length, "problem")}` +
        `${warnings.length > 0 ? `, ${plural(warnings.length, "warning")}` : ""}.`
      : warnings.length > 0
        ? `Delegation readiness — ready, with ${plural(warnings.length, "warning")}.`
        : "Delegation readiness — ready.";

  const badge = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const width = Math.max(...checks.map((check) => check.label.length));
  const out = [headline, ""];
  for (const check of checks) {
    out.push(`  ${badge[check.state]}  ${check.label.padEnd(width)}  ${check.detail}`);
  }

  const actionable = [...failures, ...warnings].filter((check) => check.remedy !== null);
  if (actionable.length > 0) {
    out.push("", "### What to do", "");
    for (const check of actionable) out.push(`- **${check.label}** — ${check.remedy}`);
  }

  if (setup) {
    out.push(
      "",
      "### The numbers in force",
      "",
    );
    out.push(...settingsTable(settings, sources));
    out.push(
      "",
      "Every one of them is **provisional**: none has been calibrated against real runs, and the" +
        " Ledger records what that calibration will need. Each is overridable by its environment" +
        " variable and by `settings.json` in the state directory, the environment winning." +
        " `/delegate:quota <n>` is the one that is negotiated rather than edited.",
      "",
      "### What a Worker can see",
      "",
      `A Worker is a third-party agent, so its environment is an allowlist and not an inheritance:` +
        ` ${WORKER_ENV_ALLOWLIST.join(", ")}. Everything else — every API token and cloud` +
        " credential in this shell — is dropped, including the Runner's own `DELEGATE_*` settings." +
        " Add a name or a `PREFIX*` glob to `$DELEGATE_ENV_ALLOWLIST` to extend it for a project" +
        " that needs one.",
      "",
      `State lives at ${root}, outside every repository: Results, the Ledger the Budget is counted` +
        " from, the dedup cache and your own numbers. Workspaces live beside it, never under `/tmp`.",
      "",
      "The plugin ships `defaultEnabled: false`, because installing it is not the same act as" +
        " consenting to autonomous delegation. Enable it in `/plugin` when you mean it; the six" +
        " Forwarders then invite proactive use, bounded by the Delegation Budget above.",
    );
  } else {
    out.push(
      "",
      "`/delegate:setup` runs this same check and shows the configuration behind it;" +
        " `/delegate:quota` shows the Budget on its own.",
    );
  }
  return `${out.join("\n")}\n`;
}

/**
 * `runner.mjs ready` — the `SessionStart` hook, and the readiness half of `/delegate:setup`.
 *
 * Every check here is a failure that would otherwise surface minutes later as confusing behaviour:
 * no binary, no login, a Budget already spent, a `$CODEX_HOME` that cannot be written — which kills
 * `codex exec` before it emits a single event, `--ephemeral` or not. Two of them exist because a
 * sandboxed user has preconditions nobody told them about, and both are named as the settings they
 * are: the write allowances of ADR-0004's consequences, and the API host Claude Code does not
 * pre-allow.
 *
 * The report goes to stdout whether or not anything failed, because that is the channel
 * `SessionStart` carries into the session, and a hard failure additionally exits `1` naming what
 * failed. A warning never does: a spent Budget, an unreachable host behind a proxy this cannot see,
 * and an unmeasured platform are all states the user can weigh, not broken installations.
 */
export async function ready(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { setup: { type: "boolean" } },
    }));
  } catch (error) {
    throw usageError(error.message);
  }
  const setup = values.setup === true;

  const checks = [];
  const add = (label, state, detail, remedy = null) => checks.push({ label, state, detail, remedy });

  const sandboxed = detectOuterSandbox();
  const home = codexHome();
  const root = stateRoot();
  const { values: settings, sources } = readSettings(root, { warn });

  // The binary, first: everything below it is a question about a Codex that is there.
  const bin = codexBinary();
  const version = askCodex(["--version"]);
  if (version.ok) {
    add("Codex binary", "ok", `${version.said || "present"} at ${bin}`);
  } else if (!version.ran) {
    add(
      "Codex binary",
      "fail",
      `${bin} could not be run: ${version.error.message}`,
      `install the Codex CLI and put it on \`$PATH\`, or point \`$DELEGATE_CODEX_BIN\` at it.` +
        " Every Delegation runs `codex exec`, so nothing can be delegated until it is there.",
    );
  } else {
    add(
      "Codex binary",
      "fail",
      `${bin} ${version.ended}: ${version.said}`,
      `\`${bin} --version\` does not answer, so the binary is there and will not run. Reinstall the` +
        " Codex CLI, or point `$DELEGATE_CODEX_BIN` at one that does.",
    );
  }

  // The login, and what it is measured through: the Worker's filtered environment, because a
  // credential that does not survive the allowlist is one the Worker does not have.
  const keyName = ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].find((name) => filled(process.env[name]));
  if (!version.ran) {
    add("Authentication", "warn", "not asked — there is no Codex binary to ask");
  } else if (keyName) {
    // Asking `codex login status` here would report no login and be beside the point: the key is
    // what `codex exec` authenticates with, and it is on the allowlist, so the Worker has it.
    add("Authentication", "ok", `$${keyName} is set and reaches the Worker`);
  } else {
    const login = askCodex(["login", "status"]);
    if (login.ok) {
      add("Authentication", "ok", login.said || "logged in");
    } else {
      add(
        "Authentication",
        "fail",
        login.said || `codex login status ${login.ended}`,
        "run `codex login` in a terminal, or set `$CODEX_API_KEY`. A Delegation with no login" +
          " behind it fails at the provider — after the Budget was counted, because the Budget" +
          " counts what was asked of it.",
      );
    }
  }

  // The precondition that kills `codex exec` at app-server startup, before any event and under
  // every sandbox mode. Measured for every Delegation rather than only for a resumed one.
  if (ensureWritable(home)) {
    add("$CODEX_HOME", "ok", `${home} is writable`);
  } else {
    add(
      "$CODEX_HOME",
      "fail",
      `$CODEX_HOME cannot be written to: ${home}`,
      `add \`${home}\` to \`${ALLOW_WRITE}\` in your Claude Code settings. \`codex exec\` dies at` +
        " app-server startup without it, before it emits a single event, `--ephemeral` or not — so" +
        " no sandbox mode rescues it and it is a precondition for every Delegation, not only a" +
        " resumed one.",
    );
  }

  // The Ledger's directory. A Budget that cannot be counted cannot be enforced, and the Runner
  // refuses every Delegation rather than running unbounded — so this is a hard failure here too.
  if (ensureWritable(root)) {
    add("State directory", "ok", `${root}, outside every repository`);
  } else {
    add(
      "State directory",
      "fail",
      `the state directory cannot be written to: ${root}`,
      `point \`$DELEGATE_STATE_DIR\` somewhere writable, or add \`${root}\` to \`${ALLOW_WRITE}\`.` +
        " The Ledger is what the Delegation Budget is counted from, so the Runner refuses every" +
        " Delegation rather than delegate unbounded.",
    );
  }

  // Codex's own sandbox helper. Whether it can start is `environment.mjs`'s to say — the same
  // predicate a Delegation's mode is chosen by — so this asks it rather than restating it. The
  // platform is still read here, because the answer on a platform that was never probed is worth
  // less to a reader than the name of the platform that was not probed.
  const platformName = platform();
  const tmp = sandboxHelperTmp();
  const helperReady = sandboxHelperReady();
  if (platformName !== "linux") {
    add(
      "Codex sandbox helper",
      "ok",
      `${tmp} is not probed on ${platformName} — the precondition is a Linux implementation detail`,
    );
  } else if (helperReady) {
    add("Codex sandbox helper", "ok", `${tmp} is writable, so Codex's own sandbox can start`);
  } else if (sandboxed) {
    add(
      "Codex sandbox helper",
      "warn",
      `${tmp} cannot be written to, so Delegations run \`-s ${SANDBOX_FALLBACK}\``,
      `add \`${tmp}\` to \`${ALLOW_WRITE}\` to keep both sandboxes on. Codex's sandbox helper` +
        " builds its mount targets there and panics without it, so the fallback is the only mode" +
        " that runs — the outer sandbox is then the only layer enforcing anything, where two were" +
        " available.",
    );
  } else {
    add(
      "Codex sandbox helper",
      "fail",
      `${tmp} cannot be written to, and no outer sandbox is holding anything`,
      `allow writes to \`${tmp}\`. Codex's sandbox helper cannot start without it, and unsandboxed` +
        ` \`-s ${SANDBOX_FALLBACK}\` would be the only thing between a third-party agent and this` +
        " machine — so the Runner refuses the Delegation instead of taking that trade.",
    );
  }

  // What a Delegation will actually be invoked with, said plainly: this is the flag the README has
  // to explain, and a user reading a readiness report is owed the same honesty. The modes come
  // from the map `selectSandbox` returns them from, so the report cannot name one it would not
  // pass; the Classes are named here rather than generated from that map's keys, because this is a
  // sentence written for a person and a sentence assembled from keys reads like a map.
  const modes = helperReady
    ? `\`${SANDBOX_BY_CLASS.advisory}\` for Advisory, \`${SANDBOX_BY_CLASS.verifiable}\` for Verifiable`
    : `\`${SANDBOX_FALLBACK}\``;
  if (!sandboxed) {
    add("Outer sandbox", "ok", `none detected — Codex runs under its own sandbox: ${modes}`);
  } else if (platformName === "darwin") {
    add(
      "Outer sandbox",
      "warn",
      `detected, and ADR-0004's conclusion is **unverified on this platform**`,
      "ADR-0004 measured nesting on Linux and bubblewrap only, and the obstacle it found is an" +
        " implementation detail of Codex's Linux sandbox helper — macOS pairs Seatbelt with" +
        " Seatbelt, a different collision with no reason to behave alike. Delegations here take" +
        ` the preferred path (${modes}), because two enforcing layers is the better guess to hold` +
        " until it is measured, but it is a guess: watch for a Worker that reports success and" +
        " writes nothing, and see issue #16.",
    );
  } else {
    add(
      "Outer sandbox",
      "ok",
      helperReady
        ? `detected — Codex keeps its own sandbox as a second layer: ${modes}`
        : `detected — it is the only layer, and Codex runs ${modes}`,
    );
  }

  // The network, and only under an outer sandbox. Claude Code pre-allows no domains, so this is
  // the precondition that turns into a timeout nobody can read. Unsandboxed there is nothing
  // holding the connection, and telling an offline user to edit a sandbox setting would be wrong.
  if (sandboxed) {
    const endpoint = apiEndpoint();
    const where = `${endpoint.host}:${endpoint.port}`;
    const probe = await probeApiHost(endpoint);
    if (probe.reachable) {
      add("Provider network", "ok", `${where} answered`);
    } else {
      add(
        "Provider network",
        "warn",
        `${where} did not answer: ${probe.detail}`,
        `add \`${endpoint.host}\` to \`${ALLOWED_DOMAINS}\` in your Claude Code settings — it` +
          " pre-allows no domains, so a sandboxed session reaches nothing it was not given. If" +
          " your Codex config points at another provider, allow that host instead. Reported rather" +
          " than failed: this probe is not the Worker, and a proxy it cannot see may still carry it.",
      );
    }
  }

  const state = budgetState(root, budgetLimits(settings));
  if (state.exhausted) {
    add(
      "Delegation Budget",
      "warn",
      `spent: ${state.count} of ${state.ceiling} Delegations in the last ${state.windowHours}h`,
      `nothing will be delegated until the window frees up${state.resets_at === null ? "" : ` at ${state.resets_at}`}.` +
        " `/delegate:quota <n>` raises the ceiling if this window's work is worth it — that is the" +
        " one place this bound is negotiable, and it is the user's to negotiate.",
    );
  } else {
    add(
      "Delegation Budget",
      "ok",
      `${state.count} of ${state.ceiling} in the last ${state.windowHours}h, ${state.remaining} left`,
    );
  }

  process.stdout.write(renderReadiness({ checks, setup, root, settings, sources }));

  const failures = checks.filter((check) => check.state === "fail");
  if (failures.length > 0) {
    // The whole report again, on stderr, remedies included. A harness may carry only one of the two
    // channels — and the one this exists for is not the verdict but what to do about it, so the
    // failing checks are repeated whole rather than named. Duplicated on purpose: a message
    // printed twice costs a reader a second look, and a message printed on the channel nobody
    // reads costs them the fix.
    throw failed(
      `delegation is not ready.\n${failures
        .map((check) => `  ${check.label} — ${check.detail}${check.remedy === null ? "" : `\n    ${check.remedy}`}`)
        .join("\n")}`,
    );
  }
}
