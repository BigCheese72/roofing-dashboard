// Tests for the ASIL backend conversation seam
// (netlify/functions/lib/asilConversation.js).
//
// The oracle properties this pins:
//   1. NO KEY -> deterministic offline stub, llm:false, provider:"stub", and it
//      makes ZERO network calls (the injected callModel throws if touched).
//   2. KEYED  -> the model's text is returned, llm:true, and the model receives
//      the server-only system prompt + the user turn (never the client).
//   3. A keyed provider that FAILS degrades gracefully to the stub with
//      fallback:true — the user's turn never 500s.
//   4. Empty input throws EMPTY_INPUT (mapped to 400 by the HTTP layer).
//   5. Replies are clamped; history is normalized and bounded.
//
// Run: npm test
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const conv = require("../netlify/functions/lib/asilConversation");

const THROW_IF_CALLED = () => { throw new Error("callModel must not run without a provider key"); };

test("no provider key -> offline stub, llm:false, zero network", async () => {
  const out = await conv.respond({ text: "hello" }, { env: {}, callModel: THROW_IF_CALLED });
  assert.equal(out.ok, true);
  assert.equal(out.provider, "stub");
  assert.equal(out.llm, false);
  assert.equal(out.fallback, false);
  assert.equal(out.state, "speaking");
  assert.ok(out.reply && out.reply.length > 0);
});

test("keyed -> returns model text, llm:true, model sees system prompt + user turn", async () => {
  let seen = null;
  const fake = async (args) => { seen = args; return "Your next work order is at the Vandalia school."; };
  const out = await conv.respond(
    { text: "what's my next job?" },
    { env: { ANTHROPIC_API_KEY: "sk-test" }, callModel: fake }
  );
  assert.equal(out.provider, "anthropic");
  assert.equal(out.llm, true);
  assert.equal(out.fallback, false);
  assert.equal(out.reply, "Your next work order is at the Vandalia school.");
  assert.equal(seen.system, conv.SYSTEM_PROMPT);
  assert.equal(seen.messages[seen.messages.length - 1].text, "what's my next job?");
  assert.equal(seen.messages[seen.messages.length - 1].role, "user");
});

test("keyed provider that fails -> graceful stub fallback, never throws", async () => {
  const boom = async () => { throw new Error("Anthropic API error 529"); };
  const out = await conv.respond(
    { text: "hi" },
    { env: { ANTHROPIC_API_KEY: "sk-test" }, callModel: boom }
  );
  assert.equal(out.ok, true);
  assert.equal(out.fallback, true);
  assert.equal(out.provider, "stub");
  assert.equal(out.llm, false);
  assert.equal(out.state, "needs_attention");
  assert.ok(out.reply.length > 0);
});

test("empty / whitespace text throws EMPTY_INPUT", async () => {
  await assert.rejects(() => conv.respond({ text: "   " }, { env: {} }), (e) => e.code === "EMPTY_INPUT");
  await assert.rejects(() => conv.respond({}, { env: {} }), (e) => e.code === "EMPTY_INPUT");
});

test("reply is clamped to MAX_REPLY", async () => {
  const huge = "x".repeat(conv.MAX_REPLY + 500);
  const out = await conv.respond({ text: "go" }, { env: { OPENAI_API_KEY: "sk" }, callModel: async () => huge });
  assert.equal(out.provider, "openai");
  assert.ok(out.reply.length <= conv.MAX_REPLY);
});

test("history is normalized, role-clamped and bounded to MAX_HISTORY", async () => {
  const raw = [];
  for (let i = 0; i < conv.MAX_HISTORY + 8; i++) raw.push({ role: i % 2 ? "assistant" : "weird", text: "t" + i });
  raw.push({ role: "user", text: "" }); // dropped: empty
  let seen = null;
  await conv.respond(
    { text: "now", history: raw },
    { env: { ANTHROPIC_API_KEY: "k" }, callModel: async (a) => { seen = a; return "ok"; } }
  );
  // messages = bounded history + the current user turn
  assert.ok(seen.messages.length <= conv.MAX_HISTORY + 1);
  for (const m of seen.messages) assert.ok(m.role === "user" || m.role === "assistant");
});

test("resolveProvider precedence matches aiProvider", () => {
  assert.equal(conv.resolveProvider({}), "stub");
  assert.equal(conv.resolveProvider({ ANTHROPIC_API_KEY: "a" }), "anthropic");
  assert.equal(conv.resolveProvider({ OPENAI_API_KEY: "o" }), "openai");
  assert.equal(conv.resolveProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }), "anthropic");
  assert.equal(conv.resolveProvider({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }), "openai");
  assert.equal(conv.resolveProvider({ AI_PROVIDER: "anthropic" }), "stub"); // forced but unkeyed
});
