// Tests for the browser ASIL backend adapter (js/asil-agent-adapter.js).
//
// The oracle properties this pins:
//   1. On a command it POSTs the text to the agent endpoint and speaks the
//      reply back through the EVENT's own detail.respond — it never reaches into
//      the face renderer.
//   2. It attaches the Firebase bearer token when getToken supplies one.
//   3. A non-speaking state from the server is applied via detail.setState;
//      a "speaking" reply is delivered via respond only (no redundant setState).
//   4. Any transport failure becomes a spoken apology + needs_attention, and
//      never throws — the face is never left stuck in "thinking".
//
// Run: npm test
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createAsilAgentAdapter } = require("../js/asil-agent-adapter");

function spyDetail(text) {
  const calls = { respond: [], setState: [] };
  return {
    detail: {
      text,
      respond: (t) => calls.respond.push(t),
      setState: (s, d) => calls.setState.push([s, d])
    },
    calls
  };
}

function okFetch(payload, capture) {
  return async (url, opts) => {
    if (capture) { capture.url = url; capture.opts = opts; }
    return { ok: true, status: 200, json: async () => payload };
  };
}

test("posts text to endpoint and speaks reply via event callbacks", async () => {
  const cap = {};
  const adapter = createAsilAgentAdapter({ fetch: okFetch({ ok: true, reply: "On it.", state: "speaking" }, cap) });
  const { detail, calls } = spyDetail("what's next?");
  await adapter.onCommand(detail);
  assert.equal(cap.url, "/.netlify/functions/asil-agent");
  assert.equal(cap.opts.method, "POST");
  const body = JSON.parse(cap.opts.body);
  assert.equal(body.text, "what's next?");
  assert.deepEqual(calls.respond, ["On it."]);
  assert.equal(calls.setState.length, 0); // speaking => respond only
  assert.deepEqual(adapter.getHistory().map((h) => h.role), ["user", "assistant"]);
});

test("attaches Firebase bearer token when getToken supplies one", async () => {
  const cap = {};
  const adapter = createAsilAgentAdapter({
    fetch: okFetch({ ok: true, reply: "hi", state: "speaking" }, cap),
    getToken: async () => "tok-123"
  });
  const { detail } = spyDetail("hello");
  await adapter.onCommand(detail);
  assert.equal(cap.opts.headers["Authorization"], "Bearer tok-123");
});

test("non-speaking server state is applied via setState, then reply spoken", async () => {
  const adapter = createAsilAgentAdapter({ fetch: okFetch({ ok: true, reply: "Which building?", state: "needs_attention" }) });
  const { detail, calls } = spyDetail("open the report");
  await adapter.onCommand(detail);
  assert.equal(calls.setState.length, 1);
  assert.equal(calls.setState[0][0], "needs_attention");
  assert.deepEqual(calls.respond, ["Which building?"]);
});

test("transport failure -> spoken apology + needs_attention, never throws", async () => {
  const adapter = createAsilAgentAdapter({ fetch: async () => { throw new Error("network down"); } });
  const { detail, calls } = spyDetail("status?");
  await adapter.onCommand(detail); // must resolve
  assert.equal(calls.setState.length, 1);
  assert.equal(calls.setState[0][0], "needs_attention");
  assert.equal(calls.respond.length, 1);
  assert.ok(calls.respond[0].length > 0);
});

test("HTTP error response is treated as a failure and handled gracefully", async () => {
  const adapter = createAsilAgentAdapter({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const { detail, calls } = spyDetail("hi");
  await adapter.onCommand(detail);
  assert.equal(calls.setState[0][0], "needs_attention");
  assert.equal(calls.respond.length, 1);
});

test("blank command is ignored (no fetch, no callbacks)", async () => {
  let fetched = false;
  const adapter = createAsilAgentAdapter({ fetch: async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; } });
  const { detail, calls } = spyDetail("   ");
  await adapter.onCommand(detail);
  assert.equal(fetched, false);
  assert.equal(calls.respond.length, 0);
  assert.equal(calls.setState.length, 0);
});
