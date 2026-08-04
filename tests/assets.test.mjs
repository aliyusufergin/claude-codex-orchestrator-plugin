// Seam 2 — the asset lint. The shipped markdown and JSON never pass through the Runner, so
// nothing else notices when they break. This lint grows one assertion per shipped asset; today
// the plugin ships a manifest, two output schemas, four Forwarders, five commands and four prompt
// templates.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
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

/** The Verifiable Task Kinds that ship a Forwarder. Repro and Migration follow Implementation. */
const VERIFIABLE_KINDS = ["implementation"];

for (const kind of [...ADVISORY_KINDS, ...VERIFIABLE_KINDS]) {
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

describe("prompt templates", () => {
  for (const file of walk(path.join(REPO_ROOT, "prompts"))) {
    it(`${path.relative(REPO_ROOT, file)} has exactly one place for the request`, () => {
      const occurrences = readFileSync(file, "utf8").split("{{REQUEST}}").length - 1;
      assert.equal(occurrences, 1, "the Runner fills {{REQUEST}} once");
    });
  }

  for (const kind of [...ADVISORY_KINDS, ...VERIFIABLE_KINDS]) {
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
