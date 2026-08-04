// Seam 2 — the asset lint. The shipped markdown and JSON never pass through the Runner, so
// nothing else notices when they break. This lint grows one assertion per shipped asset; today
// the plugin ships a manifest, two output schemas, six Forwarders, seven commands, one hook
// declaration, six prompt templates and a README.
//
// Three assertions here are not bookkeeping. C1, that Repro's prompt template states its inverted
// verification semantics: a Worker following the general instruction to iterate until the build is
// green will "fix" the failing test and destroy the task, so those sentences are the task, and this
// is what stops them being tidied away by someone shortening a prompt. D15, that no `Stop` hook
// is declared: what it lints is the *absence* of an asset, which is the one thing no other test in
// this repository can notice going missing. And the README's account of `-s danger-full-access`,
// which is the one document that has to tell the truth about a frightening flag — a paragraph
// deleted for reading badly is a user who never learns what the plugin does under a sandbox.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SETTINGS } from "../scripts/config.mjs";
import { REPO_ROOT } from "./helpers/harness.mjs";

/** Directories whose contents Claude Code loads as plugin assets. */
const ASSET_DIRS = [".claude-plugin", "schemas", "agents", "commands", "skills", "hooks"];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const assetFiles = ASSET_DIRS.flatMap((dir) => walk(path.join(REPO_ROOT, dir)));

function readManifest() {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  );
}

/**
 * The frontmatter of a shipped markdown asset, as `{ frontmatter, body }`. Flat `key: value` only —
 * which is all Claude Code's own asset frontmatter is, and a real YAML parser would be a dependency
 * bought to check five lines.
 */
function readAsset(...segments) {
  const contents = readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
  const match = contents.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${segments.join("/")} has no frontmatter block`);

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([\w-]+):\s*(.*)$/);
    if (field) frontmatter[field[1]] = field[2].trim();
  }
  return { frontmatter, body: match[2] };
}

/**
 * A shipped asset as one flowed line — every run of whitespace collapsed to a single space. The
 * templates are hard-wrapped prose, so a sentence a lint asks for is as likely to be split across
 * two lines as not, and a regexp that fails on the wrap is a lint that fires on reformatting.
 */
function flowed(...segments) {
  return readFileSync(path.join(REPO_ROOT, ...segments), "utf8").replace(/\s+/g, " ");
}

describe("plugin manifest", () => {
  it("exists at .claude-plugin/plugin.json", () => {
    assert.ok(existsSync(path.join(REPO_ROOT, ".claude-plugin", "plugin.json")));
  });

  it("names the plugin delegate", () => {
    assert.equal(readManifest().name, "delegate");
  });

  it("ships installed but off", () => {
    assert.equal(readManifest().defaultEnabled, false);
  });

  it("is Apache-2.0", () => {
    assert.equal(readManifest().license, "Apache-2.0");
    assert.ok(existsSync(path.join(REPO_ROOT, "LICENSE")), "Apache-2.0 declared with no LICENSE");
  });

  it("leaves version unset so the git SHA drives updates", () => {
    assert.ok(
      !Object.hasOwn(readManifest(), "version"),
      "version must stay unset — pushing commits would no longer reach users",
    );
  });
});

describe("shipped assets", () => {
  it("ships at least the manifest and the output schema", () => {
    assert.ok(assetFiles.length >= 2, assetFiles.join(", "));
  });

  for (const file of assetFiles.filter((f) => f.endsWith(".json"))) {
    it(`${path.relative(REPO_ROOT, file)} is valid JSON`, () => {
      assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")));
    });
  }

  for (const file of assetFiles.filter((f) => f.endsWith(".md"))) {
    it(`${path.relative(REPO_ROOT, file)} opens with YAML frontmatter`, () => {
      const contents = readFileSync(file, "utf8");
      assert.match(contents, /^---\n[\s\S]*?\n---\n/, "missing frontmatter block");
    });
  }
});

describe("output schemas", () => {
  for (const file of walk(path.join(REPO_ROOT, "schemas"))) {
    it(`${path.relative(REPO_ROOT, file)} is a JSON Schema object the Runner can pass to --output-schema`, () => {
      const schema = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(schema.type, "object");
      assert.ok(schema.$schema, "declare the JSON Schema dialect");
      assert.equal(schema.additionalProperties, false, "structured output requires a closed schema");
    });
  }

  it("makes the Verification Signal mandatory on every Verifiable Result", () => {
    const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, "schemas", "verifiable.json"), "utf8"));

    // The Class is defined by carrying a mechanical pass/fail signal (D3). A Result that can omit
    // one is an Advisory Result with a diff attached, and nothing downstream would notice.
    assert.ok(schema.required.includes("verification"), "verification is optional");
    const signal = schema.properties.verification;
    for (const field of ["command", "exit_code", "passed"]) {
      assert.ok(signal.required.includes(field), `${field} is optional`);
    }
    assert.equal(signal.properties.passed.type, "boolean");
    // The command has to be one a reader can run again, which a description of it is not.
    assert.equal(signal.properties.command.minLength, 1);
    // C1: Repro's signal is inverted, and the field that says so has to be representable without a
    // Worker being able to leave it out.
    assert.ok(schema.required.includes("expected_failure"));
    assert.deepEqual(schema.properties.expected_failure.type, ["boolean", "null"]);
  });

  it("makes evidence mandatory on every Advisory finding", () => {
    const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, "schemas", "advisory.json"), "utf8"));
    const finding = schema.properties.findings.items;

    // Read-Before-Change (ADR-0003) acts on a finding only once this snippet has been checked
    // against the file it names, so an optional `evidence` disables every autonomous use of a
    // Result without failing anywhere visible.
    assert.ok(finding.required.includes("evidence"), "evidence is optional");
    assert.equal(finding.properties.evidence.type, "string");
    assert.equal(finding.properties.evidence.minLength, 1, "an empty evidence string is no evidence");
  });
});

/** The three Advisory Task Kinds. */
const ADVISORY_KINDS = ["review", "diagnosis", "adversarial"];

/** The three Verifiable Task Kinds. */
const VERIFIABLE_KINDS = ["implementation", "repro", "migration"];

/** All six Task Kinds (D3). Every one of them ships a prompt template and a Forwarder. */
const ALL_KINDS = [...ADVISORY_KINDS, ...VERIFIABLE_KINDS];

describe("the Task Kinds", () => {
  it("are the six of D3, and each ships one Forwarder and nothing else does", () => {
    // A seventh Forwarder, or a Forwarder for a Task Kind the Runner does not know, is a routing
    // target the Orchestrator can reach and the Runner rejects as a usage error.
    assert.equal(ALL_KINDS.length, 6, ALL_KINDS.join(", "));
    assert.deepEqual(
      readdirSync(path.join(REPO_ROOT, "agents")).sort(),
      ALL_KINDS.map((kind) => `${kind}.md`).sort(),
    );
  });
});

for (const kind of ALL_KINDS) {
  const advisory = ADVISORY_KINDS.includes(kind);

  describe(`the ${kind} Forwarder`, () => {
    const { frontmatter, body } = readAsset("agents", `${kind}.md`);

    it("has Bash and nothing else", () => {
      // A Forwarder that could read files would start doing the work itself, and its findings would
      // arrive indistinguishable from the Worker's.
      assert.equal(frontmatter.tools, "Bash");
    });

    it("runs at low effort — it is a dumb shell", () => {
      // Not Codex's reasoning effort (C4): that is `-c model_reasoning_effort` from the Runner's
      // table, and this is the Orchestrator-side level for a subagent that runs one command.
      assert.equal(frontmatter.effort, "low");
    });

    it("invites proactive use, so no user trigger is required", () => {
      assert.match(frontmatter.description, /proactive/i);
    });

    it("is named after the Task Kind the Orchestrator routes to", () => {
      assert.equal(frontmatter.name, kind);
    });

    it("names exactly one Task Kind", () => {
      // Routing happens in the main thread (D9), one Forwarder per Task Kind. A Forwarder that
      // could pass a second `--kind` would be routing, with only a handoff paragraph to route on.
      const passed = [...body.matchAll(/--kind\s+(\w+)/g)].map((match) => match[1]);
      assert.deepEqual([...new Set(passed)], [kind], passed.join(", "));
    });

    it("carries no schema, prompt or Codex effort of its own", () => {
      // C2: all three moved into the Runner. `--thread` is the one other flag a Forwarder passes,
      // and it is a continuation id rather than a setting.
      for (const flag of ["--output-schema", "model_reasoning_effort", "--model", "--sandbox", "-s "]) {
        assert.ok(!body.includes(flag), `the Forwarder passes ${flag}`);
      }
    });

    if (advisory) {
      it("knows how to continue a thread rather than paying for a fresh Delegation", () => {
        // D11. Without this the thread id in a Result reaches an Orchestrator with nothing to do
        // with it, and every follow-up costs a whole Delegation.
        assert.match(body, /--thread/);
      });
    } else {
      it("never passes a thread, because a Verifiable Delegation always starts clean", () => {
        // D11's other half, and the Runner refuses `--thread` on a Verifiable Kind outright — so a
        // Forwarder that passed one would turn every Delegation into a usage error.
        assert.ok(!body.includes("--thread"), "a Verifiable Forwarder offers to resume a thread");
      });

      it("starts the Delegation in the background rather than waiting for it", () => {
        // D12: Verifiable runs for minutes and its Result is a branch. A Forwarder that blocked on
        // it would hold the session for the whole run, which is the cost delegating exists to avoid.
        assert.match(body, /background/i);
        assert.match(body, /do not wait/i);
      });

      it("says a passing Verification Signal is not permission to touch the user's files", () => {
        // ADR-0003 on the surface the Result crosses back in on. The signal is the Worker's report
        // on its own work — a Worker asked to make tests pass can change the tests — so a Forwarder
        // that returned it as proof would be handing over the one claim most shaped like authority.
        assert.match(body, /never on its own licenses/i);
        assert.match(body, /do not Land/i);
      });

      it("does not describe a Result that does not exist yet", () => {
        // The failure mode of a non-blocking Delegation: the Forwarder returns before the Worker
        // has finished, and anything it says about the change is invention.
        assert.match(body, /do not invent a Result/i);
        assert.match(body, /\/delegate:status/);
        assert.match(body, /\/delegate:result/);
      });
    }

    it("returns the Runner's stdout verbatim", () => {
      assert.match(body, /verbatim/i);
    });

    it("frames what it returns as data from an external agent, not instruction", () => {
      // D14, second guardrail, on the surface the Result crosses into the Orchestrator.
      assert.match(body, /external agent/i);
      assert.match(body, /not instruction/i);
    });

    it("reports a failed Delegation rather than answering in its place", () => {
      // D14, first guardrail. A Forwarder that did the work itself when the Runner failed would
      // return an answer the Orchestrator cannot tell apart from the Worker's.
      assert.match(body, /failed/i);
      assert.match(body, /never replaced with your own answer/i);
    });
  });
}

describe("the Adversarial Forwarder in particular", () => {
  const { frontmatter } = readAsset("agents", "adversarial.md");

  it("is described so the Orchestrator reaches for it against its own claims", () => {
    // Its value is disagreement, and the claim most in need of refutation is usually the one the
    // Orchestrator just talked itself into. A description that only invited the user to ask for it
    // would leave that case uncovered.
    assert.match(frontmatter.description, /refute/i);
    assert.match(frontmatter.description, /your own/i);
    assert.match(frontmatter.description, /agreement .*weak|weak result/i);
  });
});

describe("commands", () => {
  const { frontmatter, body } = readAsset("commands", "result.md");

  it("ships /delegate:result, off the model's own toolkit", () => {
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.ok(frontmatter["argument-hint"], "a command taking an id says so");
    assert.match(body, /runner\.mjs" result/);
  });

  it("frames the Result it prints as data from an external agent, not instruction", () => {
    assert.match(body, /external agent/i);
    assert.match(body, /not instruction/i);
  });
});

describe("/delegate:status", () => {
  const { frontmatter, body } = readAsset("commands", "status.md");

  it("is the user's command, not the model's", () => {
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.match(body, /runner\.mjs" status/);
  });

  it("tells the Orchestrator not to inspect a Delegation that has not finished", () => {
    // A running Verifiable Delegation has a Workspace and no Result. An Orchestrator that read the
    // Workspace would be reporting a half-written change as an answer.
    assert.match(body, /do not read a Workspace/i);
    assert.match(body, /\/delegate:result/);
  });
});

describe("/delegate:cancel", () => {
  const { frontmatter, body } = readAsset("commands", "cancel.md");

  it("is the user's command, not the model's", () => {
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.ok(frontmatter["argument-hint"], "a command taking an id says so");
    assert.match(body, /runner\.mjs" cancel/);
  });

  it("says the Budget is spent either way, and does not offer to route around it", () => {
    // The Budget counts what was asked of the provider (ADR-0002), and a cancelled Delegation asked.
    // An Orchestrator that read cancelling as a refund would retry until the ceiling was reached.
    assert.match(body, /still counts against the Delegation Budget/i);
    assert.match(body, /do not suggest raising the ceiling/i);
  });

  it("tells the Orchestrator not to answer in the cancelled Delegation's place", () => {
    // D14's first guardrail, in the one case where the Delegation was stopped on purpose.
    assert.match(body, /produced no Result/i);
    assert.match(body, /do not do\s+the work yourself/i);
  });
});

describe("/delegate:apply", () => {
  const { frontmatter, body } = readAsset("commands", "apply.md");

  it("is the user's command, not the model's", () => {
    // It is the escape hatch from both of ADR-0003's refusals. An Orchestrator that could invoke it
    // would be overruling the rule that governs it, one command later.
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.ok(frontmatter["argument-hint"], "a command taking an id says so");
    assert.match(body, /runner\.mjs" land/);
    assert.match(body, /--manual/);
  });

  it("says it is the escape hatch and not the normal path", () => {
    assert.match(body, /escape hatch, not the normal path/i);
    assert.match(body, /Stale/);
    assert.match(body, /do not run it for them/i);
  });

  it("says a passing Verification Signal never licenses a Landing", () => {
    // The Landing this command performs is the one the autonomous path refused, so the reason the
    // signal is not authority has to be here rather than only where the Result was rendered.
    assert.match(body, /never on its own licenses a Landing/i);
  });
});

describe("/delegate:quota", () => {
  const { frontmatter, body } = readAsset("commands", "quota.md");

  it("is the user's command, not the model's", () => {
    // Raising the ceiling is the one place the bound of ADR-0002 is negotiable, and an
    // Orchestrator that could invoke this would be negotiating with itself.
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.ok(frontmatter["argument-hint"], "a command taking a ceiling says so");
    assert.match(body, /runner\.mjs" quota/);
  });

  it("carries no ceiling, window or TTL of its own", () => {
    // The numbers live in `scripts/config.mjs` and are enforced in the Runner. A command prompt
    // that named one would be a second copy of the bound, and the wrong one.
    for (const flag of ["DELEGATE_BUDGET_CEILING", "DELEGATE_DEDUP_TTL", "--ceiling"]) {
      assert.ok(!body.includes(flag), `the command carries ${flag}`);
    }
  });

  it("tells the Orchestrator not to raise the ceiling or route around the Budget", () => {
    assert.match(body, /negotiable by the user/i);
    assert.match(body, /do not raise the ceiling/i);
    assert.match(body, /do not suggest working around the Budget/i);
  });
});

describe("/delegate:clean", () => {
  const { frontmatter, body } = readAsset("commands", "clean.md");

  it("is the user's command, not the model's", () => {
    // It is the one thing that collects unlanded work, and unlanded work is the user's (D22). An
    // Orchestrator that could invoke it could delete a Worker's diff it would rather not explain.
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.match(body, /runner\.mjs" clean/);
    assert.match(body, /do not run this for them/i);
  });

  it("says what collecting destroys and what survives it", () => {
    assert.match(body, /gone/i);
    assert.match(body, /\/delegate:result/);
  });
});

describe("/delegate:setup", () => {
  const { frontmatter, body } = readAsset("commands", "setup.md");

  it("is the user's command, not the model's", () => {
    // What it reports is a list of things for the user to decide: a login, two sandbox allowances,
    // a Budget ceiling. An Orchestrator that could invoke it would be reading its own permissions.
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.match(body, /runner\.mjs" ready --setup/);
  });

  it("runs the same readiness check the session-start hook does", () => {
    // D15: one check, two callers. A `/delegate:setup` with its own idea of what readiness means
    // would pass a session the hook had already failed, or the reverse.
    assert.match(body, /session start/i);
  });

  it("tells the Orchestrator not to carry out the remedies itself", () => {
    // Every remedy is a decision about what a third-party agent may see or spend. An Orchestrator
    // that added the write allowance or raised the ceiling would be answering for the user.
    const prose = flowed("commands", "setup.md");
    assert.match(prose, /do not run `codex login` for them/i);
    assert.match(prose, /do not edit their Claude Code settings/i);
    assert.match(prose, /do not raise the Delegation Budget ceiling/i);
  });
});

describe("the hooks", () => {
  /** Every hook declaration the plugin ships, by the file it is declared in. */
  const declarations = assetFiles
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file, JSON.parse(readFileSync(file, "utf8")).hooks])
    .filter(([, hooks]) => hooks !== undefined);

  it("declare their hooks inline, where this file can read them", () => {
    // A manifest may point `hooks` at another file by path instead of declaring the object. Nothing
    // is wrong with that — but the lint below asserts an *absence*, and a declaration it silently
    // skipped would pass while a `Stop` hook shipped in the file it pointed at.
    for (const [file, hooks] of declarations) {
      assert.ok(
        hooks !== null && typeof hooks === "object" && !Array.isArray(hooks),
        `${path.relative(REPO_ROOT, file)} declares hooks as ${JSON.stringify(hooks)}, which this` +
          " lint cannot look inside — declare them inline, or teach it to follow the path",
      );
    }
  });

  it("check readiness at session start, and nothing else", () => {
    // D15's other half. Readiness is what turns "the Delegation died and said nothing useful" into
    // a message before anything was delegated, and it is the only thing this plugin does unasked
    // at the start of a session.
    const commands = declarations.flatMap(([, hooks]) =>
      (hooks.SessionStart ?? []).flatMap((matcher) =>
        (matcher.hooks ?? []).map((hook) => hook.command),
      ),
    );
    assert.equal(commands.length, 1, commands.join(", "));
    assert.match(commands[0], /runner\.mjs" ready/);
  });

  it("run the narrow session-end collection of D22, and nothing else at session end", () => {
    const commands = declarations.flatMap(([, hooks]) =>
      (hooks.SessionEnd ?? []).flatMap((matcher) =>
        (matcher.hooks ?? []).map((hook) => hook.command),
      ),
    );
    assert.equal(commands.length, 1, commands.join(", "));
    assert.match(commands[0], /runner\.mjs" sweep/);
  });

  it("declare no `Stop` hook, not even a disabled one", () => {
    // D15. Full autonomy already covers what a stop-time review gate would do, and the gate would
    // compete with the Delegation Budget for the same window — a review at every stop is spent
    // Budget the Orchestrator never asked for. A disabled one is not a compromise: it is the same
    // decision made in a file the user is invited to flip.
    for (const [file, hooks] of declarations) {
      assert.ok(
        hooks !== null && typeof hooks === "object" && !Object.hasOwn(hooks, "Stop"),
        `${path.relative(REPO_ROOT, file)} declares a Stop hook`,
      );
    }
    assert.ok(declarations.length > 0, "no hook declaration was found to check at all");
  });
});

describe("the README", () => {
  // Read as one flowed line: it is hard-wrapped prose, and a sentence this lint asks for is as
  // likely to be split across two lines as not.
  const readme = flowed("README.md");

  it("explains `-s danger-full-access` rather than hiding it", () => {
    // The one thing in this plugin that cannot be documented by omission. Each clause is asserted
    // separately because each is a different half of the truth, and dropping any one of them
    // leaves a paragraph that is honest-sounding and misleading.
    assert.match(readme, /danger-full-access/);
    // Why it is reached at all: with the helper's precondition missing it is what runs.
    assert.match(readme, /only configuration that \*?runs\*?|only configuration that works/i);
    // Why it is not the widening it looks like.
    assert.match(readme, /widens nothing/i);
    assert.match(readme, /outer jail is enforcing the boundary either way/i);
    // And the corollary, which is the opposite of what the flag name suggests.
    assert.match(readme, /own\*{0,2} sandbox on/i);
    assert.match(readme, /safe case/i);
    assert.match(readme, /conditional, never a default/i);
  });

  it("names the two write allowances and the domain allowance a sandboxed user needs", () => {
    // C5 and O2. Both are preconditions nobody told the user about, and both otherwise arrive as
    // a Delegation that fails in a way that names neither.
    assert.match(readme, /sandbox\.filesystem\.allowWrite/);
    assert.match(readme, /sandbox\.network\.allowedDomains/);
    assert.match(readme, /\$?CODEX_HOME/);
    assert.match(readme, /\/tmp/);
  });

  it("documents the environment allowlist and how to extend it", () => {
    // O5. A user who cannot see the list cannot tell a build failing for want of a variable from
    // one failing for any other reason.
    assert.match(readme, /DELEGATE_ENV_ALLOWLIST/);
    assert.match(readme, /CODEX_API_KEY/);
    assert.match(readme, /OPENAI_API_KEY/);
  });

  it("says the numeric defaults are provisional and pending calibration", () => {
    // O3. Every one of them is a first guess, and a README that printed them as settings would be
    // handing over a measurement nobody took.
    assert.match(readme, /provisional/i);
    assert.match(readme, /calibrat/i);
    for (const spec of Object.values(SETTINGS)) assert.match(readme, new RegExp(spec.env));
  });

  it("states how the Runner is invoked, and that no shim or permission rule ships", () => {
    assert.match(readme, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/runner\.mjs"/);
    assert.match(readme, /no `bin\/` shim and no permission-rule strategy/i);
    assert.match(readme, /harness's concern/i);
  });

  it("says the plugin ships off, and why installing is not consenting", () => {
    assert.match(readme, /defaultEnabled: false/);
    assert.match(readme, /installing.{0,200}not the same act/i);
  });
});

describe("prompt templates", () => {
  for (const file of walk(path.join(REPO_ROOT, "prompts"))) {
    it(`${path.relative(REPO_ROOT, file)} has exactly one place for the request`, () => {
      const occurrences = readFileSync(file, "utf8").split("{{REQUEST}}").length - 1;
      assert.equal(occurrences, 1, "the Runner fills {{REQUEST}} once");
    });
  }

  for (const kind of ALL_KINDS) {
    it(`ships one for ${kind}`, () => {
      // A Task Kind with no template still runs — the Runner sends the request on its own and says
      // so — which is exactly the silent-ish degradation this lint exists to catch before release.
      assert.ok(existsSync(path.join(REPO_ROOT, "prompts", `${kind}.md`)));
    });
  }

  it("tells every Verifiable Worker where it is and that it produces its own signal", () => {
    for (const kind of VERIFIABLE_KINDS) {
      const template = readFileSync(path.join(REPO_ROOT, "prompts", `${kind}.md`), "utf8");
      // D5: a Worker that thinks it is in the user's checkout will reach outside the Workspace for
      // the uncommitted work that is already under its feet.
      assert.match(template, /Workspace/, `${kind} does not say where it is`);
      assert.match(template, /not their working tree/i, `${kind} does not say whose tree it is in`);
      // D6: the Runner never re-runs the command, so a Worker that does not run one leaves the
      // Result with no signal at all — and the Runner then fails it, having spent the Budget.
      assert.match(template, /run it again/i, `${kind} does not ask for iteration against the signal`);
      assert.match(template, /verification\.command/, `${kind} never says what to report`);
    }
  });

  it("tells the Implementation Worker not to weaken the test it is verifying against", () => {
    // The one way a Verification Signal lies without anybody lying: the Worker makes the command
    // pass by changing what the command checks. Nothing downstream can tell that from a real pass.
    const template = readFileSync(path.join(REPO_ROOT, "prompts", "implementation.md"), "utf8");
    assert.match(template, /weakened, skipped, or deleted/i);
  });

  it("states Repro's inverted verification semantics, which is the point of this lint", () => {
    // C1, and the one sentence in this plugin that cannot be allowed to erode. Every other
    // Verifiable prompt tells the Worker to iterate until the command passes; a Repro Worker
    // carrying that instruction "fixes" its own failing test, or edits the code until it fails, and
    // either way the Delegation is spent producing the opposite of what was asked for.
    // Read as one flowed line: these templates are hard-wrapped prose, and a sentence that is
    // present but broken across two lines is still the sentence this lint is asking for.
    const template = flowed("prompts", "repro.md");

    // The inversion itself: correct when it fails, and what a pass therefore means.
    assert.match(template, /correct precisely when it fails/i, "repro does not state the inversion");
    assert.match(
      template,
      /passing test means the test is wrong/i,
      "repro does not say what a passing test means",
    );
    // The half that stops the repair going the wrong way. "The test is wrong" without this reads as
    // an invitation to make the code wrong instead, which is the more expensive of the two mistakes.
    assert.match(
      template,
      /never that the code needs changing/i,
      "repro does not rule out changing the code",
    );
    assert.match(
      template,
      /do not change the code under test to make it fail/i,
      "repro does not forbid sabotaging the code to manufacture a failure",
    );
    // The field the inversion travels back in, so the Runner and the reader see the same thing.
    assert.match(template, /expected_failure/, "repro never says which field carries the inversion");
    assert.match(
      template,
      /not fixing the bug|do not fix the bug/i,
      "repro does not say the bug is left unfixed",
    );
  });

  it("frames Migration's correctness as the build or the test suite across many files", () => {
    // D3's definition of the Kind: nobody reads a thousand-line diff, so what establishes the change
    // is the suite plus the uniformity a reader can sample for (ADR-0003).
    const template = flowed("prompts", "migration.md");
    assert.match(template, /many files/i);
    assert.match(template, /build or the test suite/i);
    assert.match(template, /sample/i, "migration never says how its diff gets read");
  });

  it("frames Implementation by intent rather than by mechanism", () => {
    // D3's definition of the Kind, and the reason it is worth delegating at all: a request that
    // named the lines to edit would be cheaper to carry out than to write down.
    const template = readFileSync(path.join(REPO_ROOT, "prompts", "implementation.md"), "utf8");
    assert.match(template, /outcome, not a patch/i);
  });

  it("tells every Advisory Worker that it changes nothing and that evidence is verbatim", () => {
    // Both are load-bearing beyond the individual Kind: `read-only` is what the Class asks Codex
    // for, and Read-Before-Change (ADR-0003) acts on a finding by checking its snippet against the
    // file it names.
    for (const kind of ADVISORY_KINDS) {
      const template = readFileSync(path.join(REPO_ROOT, "prompts", `${kind}.md`), "utf8");
      assert.match(template, /read-only/i, `${kind} does not say it is read-only`);
      assert.match(template, /verbatim/i, `${kind} does not ask for verbatim evidence`);
      assert.match(template, /change nothing/i, `${kind} does not say it changes nothing`);
    }
  });

  it("tells every Advisory Worker what its verdict means for its own question", () => {
    // One schema per Delegation Class (D20), so all three share a `verdict` vocabulary that was
    // written for Review. The Runner headlines that word, and a Diagnosis headlined `pass` for
    // reasons nobody stated mislabels the whole Result.
    const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, "schemas", "advisory.json"), "utf8"));
    for (const kind of ADVISORY_KINDS) {
      const heading = `${kind[0].toUpperCase()}${kind.slice(1)}`;
      assert.match(schema.properties.verdict.description, new RegExp(`For ${heading}:`), kind);
      assert.match(
        readFileSync(path.join(REPO_ROOT, "prompts", `${kind}.md`), "utf8"),
        /`?verdict`?/i,
        `${kind} never says which verdict to give`,
      );
    }
  });
});
