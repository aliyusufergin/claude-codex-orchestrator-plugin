// Seam 2 — the asset lint. The shipped markdown and JSON never pass through the Runner, so
// nothing else notices when they break. This lint grows one assertion per shipped asset; today
// the plugin ships a manifest and one output schema.

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

describe("output schema", () => {
  it("is a JSON Schema object the Runner can pass to --output-schema", () => {
    const schema = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "schemas", "skeleton.json"), "utf8"),
    );
    assert.equal(schema.type, "object");
    assert.ok(schema.$schema, "declare the JSON Schema dialect");
    assert.equal(schema.additionalProperties, false, "structured output requires a closed schema");
  });
});
