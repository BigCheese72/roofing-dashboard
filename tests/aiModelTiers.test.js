const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ai = require("../netlify/functions/lib/aiProvider");
const providerSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "aiProvider.js"), "utf8");

/* Model TIER routing (Mark, 2026-07-20).

   Every AI capability used to resolve the same model, because
   resolveProvider() took no argument saying how hard the job was. A photo
   classified against a 15-item list cost exactly what a customer-facing
   narrative draft cost.

   Two tiers for now -- EASY (Haiku 4.5) and MODERATE (Opus 4.8). Mark is
   holding Fable 5 for a HEAVY tier later; there is deliberately no dormant
   third tier in the table.

   The invariant worth defending: the tier is a property of the CAPABILITY, not
   of the request. If a tier ever becomes something an HTTP caller can name,
   the cost ceiling stops being a property of the code and these tests should
   fail. */

const KEY = { ANTHROPIC_API_KEY: "k" };

/* ================= the table ================= */

test("the two tiers resolve to the models Mark provisioned", () => {
  assert.equal(ai.resolveProvider(KEY, "easy").model, "claude-haiku-4-5-20251001");
  assert.equal(ai.resolveProvider(KEY, "moderate").model, "claude-opus-4-8");
});

test("there is no dormant third tier", () => {
  /* Pre-wiring an unused HEAVY tier means a half-tested code path pointing at
     a model that costs 2x, waiting for someone to typo their way into it. */
  assert.deepEqual(ai.MODEL_TIERS, ["easy", "moderate"]);
  assert.equal(ai.ANTHROPIC_TIER_MODELS.heavy, undefined);
});

test("every declared tier actually has a model on BOTH providers", () => {
  /* A tier present in the list but missing from a provider's table resolves
     to undefined, which reaches the wire as a request with no model. */
  ai.MODEL_TIERS.forEach(t => {
    assert.ok(ai.ANTHROPIC_TIER_MODELS[t], "anthropic missing tier: " + t);
    assert.ok(ai.OPENAI_TIER_MODELS[t], "openai missing tier: " + t);
  });
});

/* ================= degrading safely ================= */

test("an omitted tier resolves to moderate — every pre-tier call site is unchanged", () => {
  /* resolveProvider() gained an argument. Existing callers that never pass it
     must keep getting exactly the model they got before the tier table
     existed, or this refactor silently downgrades production. */
  assert.equal(ai.resolveProvider(KEY).model, "claude-opus-4-8");
  assert.equal(ai.resolveProvider(KEY).tier, ai.DEFAULT_TIER);
});

test("an unrecognised tier degrades to moderate rather than throwing", () => {
  /* A typo must not take a roof-side flow down, and must not fail *cheap* --
     degrading upward means a bad tier string costs money, not correctness. */
  ["heavy", "HEAVY", "", null, undefined, 42, {}].forEach(bad => {
    assert.equal(ai.resolveProvider(KEY, bad).model, "claude-opus-4-8", "tier: " + String(bad));
  });
});

test("tier is normalised for case and whitespace", () => {
  assert.equal(ai.resolveProvider(KEY, " EASY ").model, "claude-haiku-4-5-20251001");
});

test("the stub carries its tier too", () => {
  /* The keyless path still reports which tier was asked for, so a stubbed
     deploy can be checked for correct routing without provisioning a key. */
  const p = ai.resolveProvider({}, "easy");
  assert.equal(p.name, "stub");
  assert.equal(p.tier, "easy");
  assert.equal(p.model, null);
});

/* ================= overrides ================= */

test("a per-tier env var retunes ONE tier and leaves the other alone", () => {
  const env = Object.assign({ ANTHROPIC_MODEL_EASY: "claude-sonnet-5" }, KEY);
  assert.equal(ai.resolveProvider(env, "easy").model, "claude-sonnet-5");
  assert.equal(ai.resolveProvider(env, "moderate").model, "claude-opus-4-8", "moderate must be untouched");
});

test("the global override still pins EVERY tier to one model", () => {
  /* The pre-existing escape hatch, deliberately preserved: pinning all tiers
     to one model is how you find out whether a problem is the model at all. */
  const env = Object.assign({ ANTHROPIC_MODEL: "m1" }, KEY);
  assert.equal(ai.resolveProvider(env, "easy").model, "m1");
  assert.equal(ai.resolveProvider(env, "moderate").model, "m1");
});

test("the per-tier override beats the global one — most specific wins", () => {
  const env = Object.assign({ ANTHROPIC_MODEL: "m1", ANTHROPIC_MODEL_EASY: "m2" }, KEY);
  assert.equal(ai.resolveProvider(env, "easy").model, "m2");
  assert.equal(ai.resolveProvider(env, "moderate").model, "m1");
});

test("tiering applies to the OpenAI standby too", () => {
  const env = { OPENAI_API_KEY: "k" };
  assert.equal(ai.resolveProvider(env, "easy").model, "gpt-4o-mini");
  assert.equal(ai.resolveProvider(env, "moderate").model, "gpt-4o");
});

/* ================= capability -> tier ================= */

test("each capability declares its own tier at the call site", () => {
  /* Read off the source rather than the wire: exercising these for real needs
     a key, and the assignment is exactly the thing a future edit could change
     without noticing the cost. */
  const summary = between(providerSource, "async function generateSummary", "function promptProjection");
  assert.match(summary, /resolveProvider\(opts\.env \|\| process\.env, "moderate"\)/);

  const issue = between(providerSource, "async function identifyIssue", "// (c) SCOPE DRAFT");
  assert.match(issue, /resolveProvider\(opts\.env \|\| process\.env, "easy"\)/);

  const scope = between(providerSource, "async function draftScope", "module.exports");
  assert.match(scope, /resolveProvider\(opts\.env \|\| process\.env, "moderate"\)/);
});

test("no capability resolves a provider without naming a tier", () => {
  /* An untiered call silently takes the dearest tier. That is the safe
     direction for a typo, but as a standing state it means the routing was
     never actually applied to that capability. */
  const bare = providerSource.match(/resolveProvider\(opts\.env \|\| process\.env\)/g) || [];
  assert.equal(bare.length, 0, "found untiered capability call(s): " + bare.length);
});

test("the tier is never taken from a client request", () => {
  /* The cost ceiling has to be a property of the code. The moment a handler
     forwards a caller-supplied tier, anyone can ask for the expensive model
     on a cheap job. */
  const svc = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "ai-service.js"), "utf8");
  assert.doesNotMatch(svc, /body\.tier/);
  assert.doesNotMatch(svc, /tier:\s*body/);
  assert.doesNotMatch(providerSource, /opts\.tier/);
});

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}
