"use strict";
/* AI scope-prefill (Service Manager) — lib/aiProvider.draftScope() + the
 * generate-scope.js endpoint contract. Same stub-until-keyed guarantees as the
 * other AI capabilities: no key => deterministic stub, ZERO external calls; a
 * key => the model drafts, with fallback to the stub on failure. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ai = require(path.join(__dirname, "..", "netlify", "functions", "lib", "aiProvider.js"));

function withEnvFetch(fn) {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedOpenAi = process.env.OPENAI_API_KEY;
  const savedFetch = global.fetch;
  return async () => {
    try { await fn(); }
    finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenAi;
      global.fetch = savedFetch;
    }
  };
}

test("draftScope: no key -> deterministic stub, llm:false, makes no network call", withEnvFetch(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await ai.draftScope({ proposalText: "Reroof the east internal gutter; grease damage.", context: { jobName: "Flat Branch Pub", location: "123 S 9th St" } }, { env: process.env });
  assert.strictEqual(r.llm, false);
  assert.strictEqual(r.provider, "stub");
  assert.match(r.text, /Flat Branch Pub/);
  assert.match(r.text, /east internal gutter/);
  assert.strictEqual(called, false, "stub path must not hit the network");
}));

test("draftScope: with a key, the model text is returned (llm:true)", withEnvFetch(async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  global.fetch = async (url) => {
    assert.match(String(url), /anthropic\.com/);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "Remove failed neoprene; replace EPDM at east gutter." }] }) };
  };
  const r = await ai.draftScope({ proposalText: "east gutter neoprene failure", context: {} }, { env: process.env });
  assert.strictEqual(r.llm, true);
  assert.strictEqual(r.provider, "anthropic");
  assert.match(r.text, /Remove failed neoprene/);
}));

test("draftScope: key present but provider fails -> stub fallback (never dead-ends)", withEnvFetch(async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  global.fetch = async () => { throw new Error("network down"); };
  const r = await ai.draftScope({ proposalText: "patch two leaks over kitchen", context: { jobName: "Broadway Diner" } }, { env: process.env });
  assert.strictEqual(r.llm, false);
  assert.strictEqual(r.fallback, true);
  assert.match(r.text, /Broadway Diner/);
  assert.match(r.text, /patch two leaks/);
}));

test("composeStubScope / sanitizeProposalText behave", () => {
  assert.match(ai.composeStubScope("do the thing", { jobName: "X", location: "Y" }), /X at Y/);
  assert.match(ai.composeStubScope("", { jobName: "X" }), /enter the scope/);
  assert.strictEqual(ai.sanitizeProposalText("a".repeat(9000)).length, 6000);
});

// ---------------------------------------------------------------------------
// Endpoint contract (static): doc.generate gate, capability probe, draft_scope.
// ---------------------------------------------------------------------------
test("generate-scope.js: doc.generate-gated, capability probe, draft_scope action", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "generate-scope.js"), "utf8");
  assert.match(src, /requirePermission\(event,\s*"doc\.generate"\)/, "must gate on doc.generate");
  assert.match(src, /action === "capability"/, "must expose a capability probe");
  assert.match(src, /action !== "draft_scope"/, "must handle the draft_scope action");
  assert.match(src, /resolveProvider\(process\.env\)\.name !== "stub"/, "capability reflects whether a key is configured");
});
