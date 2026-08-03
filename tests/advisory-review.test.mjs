// Seam 1 — the first Advisory Delegation end to end: what a Review asks Codex for, what it is
// allowed to accept back, what reaches the Orchestrator, and what is kept on disk for
// `/delegate:result`. Driven as a process against the fake Codex binary.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  REPO_ROOT,
  advisoryFinding,
  advisoryPayload,
  createFixtureRepo,
  flagValue,
  resultId,
  runRunner,
} from "./helpers/harness.mjs";

/** The `-c key=value` overrides in the fake's recorded argv. */
function configOverrides(invocation) {
  return invocation.args.filter((arg, index) => invocation.args[index - 1] === "-c");
}

describe("review delegation", () => {
  it("holds the Worker to the Advisory schema, evidence and all", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: advisoryPayload() });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "review my diff"]);
    assert.equal(run.code, 0, run.stderr);

    const schemaPath = flagValue(fixture.invocation().args, "--output-schema");
    assert.equal(schemaPath, path.join(REPO_ROOT, "schemas", "advisory.json"));

    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);

    const finding = schema.properties.findings.items;
    for (const field of [
      "severity",
      "title",
      "body",
      "file",
      "line_start",
      "line_end",
      "evidence",
      "confidence",
      "recommendation",
    ]) {
      assert.ok(finding.properties[field], `the Advisory schema has no ${field}`);
      assert.ok(finding.required.includes(field), `${field} is optional in the Advisory schema`);
    }
    // Read-Before-Change acts on a finding by checking this snippet against the file it names, so
    // an absent or empty one is not a weaker finding but an unusable one.
    assert.deepEqual(finding.properties.evidence.type, "string");
    assert.equal(finding.properties.evidence.minLength, 1);
  });

  it("persists a Result that validates against the Advisory schema, with evidence on every finding", async (t) => {
    const fixture = await createFixtureRepo(t);
    const payload = advisoryPayload({
      verdict: "blocking",
      findings: [
        advisoryFinding(),
        advisoryFinding({
          severity: "critical",
          title: "The lock is not released on the error path",
          file: "src/queue/worker.ts",
          line_start: 112,
          line_end: 118,
          evidence: "} catch (error) {\n  return reject(error);\n}",
        }),
      ],
    });
    fixture.configureFake({ payload });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "review my diff"]);
    assert.equal(run.code, 0, run.stderr);

    const [record] = fixture.persistedResults();
    assert.ok(record, "the Result was not persisted");
    assert.equal(record.kind, "review");
    assert.equal(record.class, "advisory");
    assert.deepEqual(record.payload, payload, "the whole Result is what is persisted");

    const problems = validateAgainstAdvisorySchema(record.payload);
    assert.deepEqual(problems, [], problems.join("; "));
    for (const finding of record.payload.findings) {
      assert.equal(typeof finding.evidence, "string");
      assert.notEqual(finding.evidence.trim(), "", "a finding arrived without evidence");
    }
  });

  it("carries the verdict, the findings and their evidence into the Orchestrator's context", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      payload: advisoryPayload({
        verdict: "blocking",
        summary: "One boundary bug.",
        findings: [advisoryFinding({ evidence: "if (expiresAt < Date.now()) {" })],
        next_steps: ["Run the auth suite."],
      }),
    });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /blocking/);
    assert.match(run.stdout, /One boundary bug\./);
    assert.match(run.stdout, /Token expiry is compared with the wrong operator/);
    assert.match(run.stdout, /src\/auth\/token\.ts:44-45/);
    assert.match(run.stdout, /if \(expiresAt < Date\.now\(\)\) \{/);
    assert.match(run.stdout, /Run the auth suite\./);
    // Advisory blocks — what comes back is the Result, not something to poll for later.
    assert.doesNotMatch(run.stdout, /\bjob id\b/i);
  });

  it("refuses a Result whose findings have no evidence, and keeps it readable", async (t) => {
    const fixture = await createFixtureRepo(t);
    const finding = advisoryFinding();
    delete finding.evidence;
    fixture.configureFake({ payload: advisoryPayload({ findings: [finding] }) });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /evidence/);
    // The Budget is spent either way, so the payload the Runner would not render is still on disk.
    const [record] = fixture.persistedResults();
    assert.ok(record, "a rejected Result was not persisted");
    assert.match(run.stderr, new RegExp(record.id));
  });

  it("refuses a Result that is not an Advisory Result at all", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({ payload: { summary: "looks fine" } });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /verdict/);
  });

  it("renders a Result with no findings without inventing any", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({
      payload: advisoryPayload({ verdict: "pass", findings: [], next_steps: [] }),
    });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /pass/);
    assert.match(run.stdout, /No findings\./);
  });

  it("sends the Review prompt template with the request inside it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "review the auth refactor against main",
    ]);
    assert.equal(run.code, 0, run.stderr);

    const { prompt } = fixture.invocation();
    const template = readFileSync(path.join(REPO_ROOT, "prompts", "review.md"), "utf8");
    const preamble = template.split("{{REQUEST}}")[0].trim();

    assert.ok(prompt.includes(preamble), "the Review template did not reach the Worker");
    assert.ok(prompt.includes("review the auth refactor against main"), "the request did not");
    assert.ok(!prompt.includes("{{REQUEST}}"), "the placeholder was left unfilled");
  });

  it("leaves a request containing regex replacement syntax intact", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, [
      "delegate",
      "--kind",
      "review",
      "--prompt",
      "check the $& and $' handling in the sanitiser",
    ]);

    assert.equal(run.code, 0, run.stderr);
    assert.ok(
      fixture.invocation().prompt.includes("check the $& and $' handling in the sanitiser"),
      fixture.invocation().prompt,
    );
  });
});

describe("reasoning effort", () => {
  it("asks for medium effort on a Review and never names a model", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);
    assert.equal(run.code, 0, run.stderr);

    const invocation = fixture.invocation();
    assert.deepEqual(configOverrides(invocation), ["model_reasoning_effort=medium"]);

    // Published model names churn, and one pinned here silently overrides the user's own choice.
    assert.equal(flagValue(invocation.args, "-m"), undefined);
    assert.equal(flagValue(invocation.args, "--model"), undefined);
    for (const arg of invocation.args) {
      assert.ok(!/^-c\s*model=/.test(arg), `a model reached Codex: ${arg}`);
      assert.ok(!arg.startsWith("model="), `a model reached Codex: ${arg}`);
    }
  });

  it("spends the effort each Task Kind is worth", async (t) => {
    const fixture = await createFixtureRepo(t);
    const expected = {
      review: "medium",
      diagnosis: "high",
      adversarial: "high",
      repro: "low",
      migration: "low",
    };

    for (const [kind, level] of Object.entries(expected)) {
      fixture.configureFake({});
      const run = await runRunner(fixture, ["delegate", "--kind", kind, "--prompt", "hello"]);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(configOverrides(fixture.invocation()), [`model_reasoning_effort=${level}`], kind);
    }
  });

  it("leaves the effort alone when the user's config.toml sets it", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    writeFileSync(
      path.join(fixture.codexHome, "config.toml"),
      'model_reasoning_effort = "xhigh"\n\n[sandbox_workspace_write]\nnetwork_access = true\n',
    );

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(configOverrides(fixture.invocation()), []);
  });

  it("keeps the table when config.toml only sets the key inside a table", async (t) => {
    const fixture = await createFixtureRepo(t);
    fixture.configureFake({});
    writeFileSync(
      path.join(fixture.codexHome, "config.toml"),
      '[some_table]\nmodel_reasoning_effort = "xhigh"\n',
    );

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(configOverrides(fixture.invocation()), ["model_reasoning_effort=medium"]);
  });
});

describe("delegate result", () => {
  it("returns the whole persisted Result after the Delegation's process has exited", async (t) => {
    const fixture = await createFixtureRepo(t);
    const payload = advisoryPayload({
      findings: [advisoryFinding({ body: "A".repeat(4000) })],
    });
    fixture.configureFake({ payload });

    const delegation = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);
    assert.equal(delegation.code, 0, delegation.stderr);

    const id = resultId(delegation.stdout);
    assert.ok(id, `no Result id in the rendering:\n${delegation.stdout}`);

    // A separate process, after the first one has gone.
    const lookup = await runRunner(fixture, ["result", id]);

    assert.equal(lookup.code, 0, lookup.stderr);
    const record = JSON.parse(lookup.stdout);
    assert.equal(record.id, id);
    assert.equal(record.kind, "review");
    assert.deepEqual(record.payload, payload);
    assert.equal(record.request, "hello");
  });

  it("fails on an id it has no Result for", async (t) => {
    const fixture = await createFixtureRepo(t);

    const run = await runRunner(fixture, ["result", "review-deadbeef"]);

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /review-deadbeef/);
  });

  it("rejects an id that is not one", async (t) => {
    const fixture = await createFixtureRepo(t);

    const traversal = await runRunner(fixture, ["result", "../../etc/passwd"]);
    assert.equal(traversal.code, 2);
    assert.equal(traversal.stdout, "");

    const missing = await runRunner(fixture, ["result"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /id/);
  });

  it("truncates long evidence in the rendering and says where the rest is", async (t) => {
    const fixture = await createFixtureRepo(t);
    const evidence = Array.from({ length: 120 }, (_, line) => `line ${line + 1}`).join("\n");
    fixture.configureFake({ payload: advisoryPayload({ findings: [advisoryFinding({ evidence })] }) });

    const run = await runRunner(fixture, ["delegate", "--kind", "review", "--prompt", "hello"]);
    assert.equal(run.code, 0, run.stderr);

    assert.match(run.stdout, /line 1\b/);
    assert.doesNotMatch(run.stdout, /line 120\b/);
    assert.match(run.stdout, /further lines of evidence/);

    // The rendering is the Runner's choice about context; the Result itself keeps everything.
    const id = resultId(run.stdout);
    const lookup = await runRunner(fixture, ["result", id]);
    assert.match(lookup.stdout, /line 120/);
  });
});

/**
 * A JSON Schema check narrow enough to be worth having in a test: the Advisory schema uses type,
 * enum, required and additionalProperties, and nothing else that changes whether a Result conforms.
 */
function validateAgainstAdvisorySchema(payload) {
  const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, "schemas", "advisory.json"), "utf8"));
  return check(payload, schema, "");

  function check(value, node, at) {
    const problems = [];
    const types = [node.type].flat();
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const matches = types.some((type) => type === actual || (type === "number" && actual === "integer"));
    if (!matches) return [`${at || "payload"} is ${actual}, not ${types.join(" or ")}`];

    if (node.enum && !node.enum.includes(value)) {
      problems.push(`${at} is not one of ${node.enum.join(", ")}`);
    }
    if (actual === "string" && node.minLength && value.length < node.minLength) {
      problems.push(`${at} is shorter than ${node.minLength}`);
    }
    if (actual === "integer" && node.minimum !== undefined && value < node.minimum) {
      problems.push(`${at} is below ${node.minimum}`);
    }
    if (actual === "array") {
      value.forEach((entry, index) => problems.push(...check(entry, node.items, `${at}[${index}]`)));
    }
    if (actual === "object") {
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key)) problems.push(`${at}.${key} is missing`);
      }
      for (const [key, entry] of Object.entries(value)) {
        const child = node.properties?.[key];
        if (!child) {
          if (node.additionalProperties === false) problems.push(`${at}.${key} is not in the schema`);
          continue;
        }
        problems.push(...check(entry, child, `${at}.${key}`));
      }
    }
    return problems;
  }
}
