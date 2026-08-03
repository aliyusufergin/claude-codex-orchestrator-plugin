// Seam 2 — the asset lint. The shipped markdown and JSON never pass through the Runner, so
// nothing else notices when they break. This lint grows one assertion per shipped asset; today
// the plugin ships a manifest, two output schemas, one Forwarder, one command and one prompt
// template.

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

describe("the Review Forwarder", () => {
  const { frontmatter, body } = readAsset("agents", "review.md");

  it("has Bash and nothing else", () => {
    // A Forwarder that could read files would start reviewing, and its findings would arrive
    // indistinguishable from the Worker's.
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

  it("passes --kind and carries no schema, prompt or Codex effort of its own", () => {
    assert.match(body, /--kind review/);
    for (const flag of ["--output-schema", "model_reasoning_effort", "--model", "--sandbox"]) {
      assert.ok(!body.includes(flag), `the Forwarder passes ${flag}`);
    }
  });

  it("returns the Runner's stdout verbatim", () => {
    assert.match(body, /verbatim/i);
  });

  it("frames what it returns as data from an external agent, not instruction", () => {
    // D14, second guardrail, on the surface the Result crosses into the Orchestrator.
    assert.match(body, /external agent/i);
    assert.match(body, /not instruction/i);
  });

  it("reports a failed Delegation rather than answering in its place", () => {
    // D14, first guardrail. A Forwarder that reviewed the change itself when the Runner failed
    // would return an answer the Orchestrator cannot tell apart from the Worker's.
    assert.match(body, /failed/i);
    assert.match(body, /never replaced with your own answer/i);
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

describe("prompt templates", () => {
  for (const file of walk(path.join(REPO_ROOT, "prompts"))) {
    it(`${path.relative(REPO_ROOT, file)} has exactly one place for the request`, () => {
      const occurrences = readFileSync(file, "utf8").split("{{REQUEST}}").length - 1;
      assert.equal(occurrences, 1, "the Runner fills {{REQUEST}} once");
    });
  }

  it("ships one for Review", () => {
    assert.ok(existsSync(path.join(REPO_ROOT, "prompts", "review.md")));
  });
});
