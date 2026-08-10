"use strict";
/* "Send Now says it's sending but nothing happens" — reproduced live on prod
   2026-08-10 (Schneider Warehouse Expansion #16764, Mark in the field): the
   POST to /.netlify/functions/send-workorder sat "pending" for 50s+ with the
   UI stuck on "Sending email…". Root cause: NEITHER side had a timeout. The
   client fetch had no AbortController, so a slow/stalled send (cold function,
   Resend latency, or a multi-MB PDF crawling up weak field cellular) left the
   app hanging forever with no error, no retry, and no hint that the Share /
   Download backups exist. The server's Resend call had no timeout either, so
   it could ride all the way to the Lambda wall.

   These tests pin the fix on BOTH sides:
     1. the server aborts the Resend call after RESEND_TIMEOUT_MS and turns an
        abort into an actionable JSON error, not a hang;
     2. the client wraps its send in an AbortController + SEND_REQUEST_TIMEOUT_MS
        and, on timeout, routes the tech to the backups.

   Handler is exercised with firebase-admin stubbed and global.fetch mocked,
   the same way largeReportSendBudget.test.js does. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const fnPath = path.join(__dirname, "..", "netlify", "functions", "send-workorder.js");
const fnSrc = fs.readFileSync(fnPath, "utf8");
const historySrc = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");

/* ---- load the real handler with authGuard stubbed (owner passes) -------- */
function loadHandler() {
  const Module = require("module");
  const realResolve = Module._resolveFilename;
  const stub = { requirePermission: async () => ({ uid: "u1", owner: true, role: null }) };
  const key = require.resolve(fnPath);
  delete require.cache[key];
  Module._resolveFilename = function (request, ...rest) {
    if (request === "./lib/authGuard") return "__authGuard_stub__";
    return realResolve.call(this, request, ...rest);
  };
  require.cache["__authGuard_stub__"] = { id: "__authGuard_stub__", filename: "__authGuard_stub__",
    loaded: true, exports: stub };
  try { return require(key); }
  finally { Module._resolveFilename = realResolve; delete require.cache["__authGuard_stub__"]; }
}

const goodEvent = () => ({
  httpMethod: "POST", headers: { host: "dev--leak-work-orders.netlify.app" },
  body: JSON.stringify({ to: ["marks@watkinsroofing.net"], pdfBase64: "QUJD", filename: "wo.pdf" })
});

/* ================================================== server: the timeout == */

test("REGRESSION: the Resend call is given an abort signal (was un-timed)", async () => {
  process.env.RESEND_API_KEY = "test_key";
  const { handler } = loadHandler();
  let seen = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { seen = opts; return { ok: true, text: async () => "{\"id\":\"em_1\"}" }; };
  try {
    const res = await handler(goodEvent());
    assert.strictEqual(res.statusCode, 200, "a normal send must still succeed");
    assert.ok(seen && seen.signal, "the Resend fetch must be passed an AbortSignal");
    assert.strictEqual(typeof seen.signal.aborted, "boolean", "and it must be a real AbortSignal");
  } finally { global.fetch = realFetch; }
});

test("an aborted (timed-out) Resend call becomes an actionable error, not a hang", async () => {
  process.env.RESEND_API_KEY = "test_key";
  const { handler } = loadHandler();
  const realFetch = global.fetch;
  // Mimic what fetch(signal) throws once the timeout fires.
  global.fetch = async () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; };
  try {
    const res = await handler(goodEvent());
    assert.strictEqual(res.statusCode, 504, "an aborted upstream must surface as a bounded 504");
    const out = JSON.parse(res.body); // must be parseable JSON, not an opaque platform body
    assert.match(out.error, /didn.t respond in time/i);
    assert.match(out.error, /Download PDF/, "must name a route that actually works");
  } finally { global.fetch = realFetch; }
});

test("a generic network failure is a clean 502, still not a hang", async () => {
  process.env.RESEND_API_KEY = "test_key";
  const { handler } = loadHandler();
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error("ECONNRESET"); };
  try {
    const res = await handler(goodEvent());
    assert.strictEqual(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /Couldn.t reach the email service/i);
  } finally { global.fetch = realFetch; }
});

test("the server defines a finite Resend timeout well under the Lambda wall", () => {
  const m = /const RESEND_TIMEOUT_MS = (\d+);/.exec(fnSrc);
  assert.ok(m, "RESEND_TIMEOUT_MS must be defined in send-workorder.js");
  const ms = Number(m[1]);
  assert.ok(ms > 0 && ms <= 26000, "must be finite and under Netlify's synchronous ceiling, got " + ms);
});

/* ================================================== client: the timeout == */

function sendEmailNowBody() {
  const start = historySrc.indexOf("async function sendEmailNow");
  const end = historySrc.indexOf("async function sharePdf", start);
  assert.notEqual(start, -1, "sendEmailNow must exist");
  assert.notEqual(end, -1, "sharePdf must follow it");
  return historySrc.slice(start, end);
}

test("REGRESSION: the client send fetch is wrapped in an AbortController + timeout", () => {
  const body = sendEmailNowBody();
  assert.match(body, /new AbortController\(\)/, "the send must set up an AbortController");
  assert.match(body, /setTimeout\([\s\S]*?\.abort\(\)/, "a timer must abort the send");
  assert.match(body, /SEND_REQUEST_TIMEOUT_MS/, "the timeout must use the named budget");
  // The exact regression: the POST to send-workorder must carry a signal.
  const fetchCall = /fetch\("\/\.netlify\/functions\/send-workorder"[\s\S]*?\}\);/.exec(body);
  assert.ok(fetchCall, "the send-workorder fetch must be present");
  assert.match(fetchCall[0], /signal:/, "the send fetch must pass an abort signal (or it can hang forever)");
});

test("a timed-out send tells the tech to use the backups, not just silence", () => {
  const body = sendEmailNowBody();
  assert.match(body, /sendTimedOut\s*\|\|\s*\(e && e\.name === "AbortError"\)/,
    "the catch must distinguish a timeout/abort from a generic failure");
  assert.match(body, /taking too long[\s\S]*Download PDF/,
    "the timeout message must point at a route that works");
});

test("the client timeout is finite and generous enough for a real field upload", () => {
  const m = /var SEND_REQUEST_TIMEOUT_MS = (\d+);/.exec(historySrc);
  assert.ok(m, "SEND_REQUEST_TIMEOUT_MS must be defined in js/history.js");
  const ms = Number(m[1]);
  assert.ok(ms >= 30000, "a large PDF over cellular is slow — don't abort a legitimate send too early");
  assert.ok(ms <= 180000, "but it must be bounded, not effectively infinite");
});
