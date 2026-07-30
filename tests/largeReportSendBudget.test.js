"use strict";
/* Large photo-heavy reports could not be emailed (feedback fb_ms7pcf2mzi2rp /
   fb_ms7p55dz13xpp / fb_ms7p05fo4hal5, work order wo_1785424648120): a ~6.2MB
   PDF base64-expands to ~8.3MB of request body, and Netlify Functions run on
   AWS Lambda, whose 6 MiB synchronous payload limit rejects the request at the
   platform edge -- with an EMPTY body -- before netlify/functions/
   send-workorder.js is invoked at all.

   Measured live against the dev deploy on 2026-07-30 (same code and platform
   as production), POSTing to /.netlify/functions/send-workorder:
       6,000,044 bytes -> 401 {"error":"Missing Authorization bearer token"}
       6,500,044 bytes -> 413, empty body

   These tests pin the three things that fix produced:
     1. the client refuses to post an over-budget body, and progressively
        downscales photos until it fits;
     2. the client turns an unparseable platform error into an actionable
        message instead of "server error 413";
     3. the client-side and server-side budgets are the SAME number -- the two
        constants live in different files (no bundler in this repo), so this
        is what stops them drifting.

   Real source is loaded via vm, the same way companyCamPhotoFeed.test.js and
   photoExportThreeWay.test.js do -- a hand-copied mirror of the logic would
   drift out of sync with the file it claims to guard. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const exportSrc = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const historySrc = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const fnSrc = fs.readFileSync(
  path.join(__dirname, "..", "netlify", "functions", "send-workorder.js"), "utf8");

/* ---- the budget + tier helpers, lifted from js/export.js ---------------- */
function budgetCtx() {
  const start = exportSrc.indexOf("var SEND_MAX_BODY_BYTES");
  const end = exportSrc.indexOf("function buildPdfPhotoMap");
  assert.notEqual(start, -1, "SEND_MAX_BODY_BYTES must exist in js/export.js");
  assert.notEqual(end, -1);
  const ctx = { Math: Math, Promise: Promise,
    PDF_PHOTO_MAX_DIM: 900, PDF_PHOTO_QUALITY: 0.72 };
  vm.runInNewContext(exportSrc.slice(start, end), ctx);
  return ctx;
}

/* vm.runInNewContext gives objects a DIFFERENT realm's Object.prototype, so
   deepStrictEqual reports "same structure but not reference-equal". Compare
   the values, not the prototypes. */
const tierOf = t => ({ maxDim: t.maxDim, quality: t.quality });

/* ---- sendFailureMessage + pdfBase64Of, lifted from js/history.js -------- */
function historyCtx() {
  const start = historySrc.indexOf("function pdfBase64Of");
  const end = historySrc.indexOf("async function sendEmailNow");
  assert.notEqual(start, -1, "pdfBase64Of must exist in js/history.js");
  assert.notEqual(end, -1);
  const ctx = {};
  vm.runInNewContext(historySrc.slice(start, end), ctx);
  return ctx;
}

/* ================================================== the budget itself === */

test("the client budget leaves real headroom under the PROVEN-GOOD body size", () => {
  const c = budgetCtx();
  // 6,000,044 bytes was observed to reach the handler; 6,500,044 was not.
  assert.strictEqual(c.SEND_MAX_BODY_BYTES, 6000000);
  assert.ok(c.SEND_MAX_PDF_BASE64 < c.SEND_MAX_BODY_BYTES,
    "the base64 budget must leave room for the JSON envelope around it");
  assert.strictEqual(c.SEND_MAX_PDF_BASE64, 6000000 - 32768);
  // The realistic worst-case envelope: 10 addresses, a 200-char subject, the
  // 10KB body cap, a filename and a job number. Must fit in the reserve with
  // room to spare, or the reserve is a lie.
  const envelope = JSON.stringify({
    to: Array.from({ length: 10 }, (_, i) => "someone" + i + "@averylongdomainname.example.com"),
    subject: "S".repeat(200), body: "B".repeat(10000),
    filename: "F".repeat(100), jobNo: "J".repeat(30), pdfBase64: ""
  }).length;
  assert.ok(envelope < 32768 / 2,
    "envelope reserve must be at least 2x the worst realistic envelope (was " + envelope + ")");
});

test("a report at the budget fits; one byte over does not", () => {
  const c = budgetCtx();
  assert.strictEqual(c.pdfBase64FitsEmail(c.SEND_MAX_PDF_BASE64), true);
  assert.strictEqual(c.pdfBase64FitsEmail(c.SEND_MAX_PDF_BASE64 + 1), false);
  assert.strictEqual(c.pdfBase64FitsEmail(1000), true);
  // Degenerate inputs are NOT "fits" -- an empty payload must take the
  // "couldn't prepare the PDF" path, never be posted as a valid send.
  assert.strictEqual(c.pdfBase64FitsEmail(0), false);
  assert.strictEqual(c.pdfBase64FitsEmail(undefined), false);
});

test("REGRESSION: the exact reported payload (~6.2MB PDF) is refused, not posted", () => {
  const c = budgetCtx();
  const base64Len = Math.ceil(6.2 * 1048576 * 4 / 3); // ~8.67M chars
  assert.strictEqual(c.pdfBase64FitsEmail(base64Len), false,
    "the payload from wo_1785424648120 must never be posted -- the edge would 413 it");
  assert.ok(base64Len > c.SEND_MAX_BODY_BYTES,
    "sanity: this payload really is past the platform wall, not merely past our budget");
});

/* ============================================= progressive downscaling === */

test("tier 0 is byte-for-byte the pre-fix behaviour -- a fitting report pays nothing", () => {
  const c = budgetCtx();
  assert.deepStrictEqual(tierOf(c.PDF_PHOTO_TIERS[0]), { maxDim: 900, quality: 0.72 });
  assert.strictEqual(c.pdfPhotoTierCount(), 3);
});

test("tiers shrink monotonically, so each rebuild is guaranteed to make progress", () => {
  const c = budgetCtx();
  for (let i = 1; i < c.PDF_PHOTO_TIERS.length; i++) {
    assert.ok(c.PDF_PHOTO_TIERS[i].maxDim < c.PDF_PHOTO_TIERS[i - 1].maxDim,
      "tier " + i + " must be smaller than tier " + (i - 1));
    assert.ok(c.PDF_PHOTO_TIERS[i].quality < c.PDF_PHOTO_TIERS[i - 1].quality,
      "tier " + i + " must be lower quality than tier " + (i - 1));
  }
});

test("setPdfPhotoTier clamps garbage back to tier 0 rather than corrupting an export", () => {
  const c = budgetCtx();
  const t0 = tierOf(c.PDF_PHOTO_TIERS[0]);
  assert.deepStrictEqual(tierOf(c.setPdfPhotoTier(2)), { maxDim: 520, quality: 0.50 });
  assert.deepStrictEqual(tierOf(c.setPdfPhotoTier(99)), t0);
  assert.deepStrictEqual(tierOf(c.setPdfPhotoTier(-1)), t0);
  assert.deepStrictEqual(tierOf(c.setPdfPhotoTier("2")), t0);
  assert.deepStrictEqual(tierOf(c.setPdfPhotoTier()), t0);
});

test("the fitting loop terminates at the last tier instead of spinning forever", () => {
  const c = budgetCtx();
  // Mirrors sendEmailNow()'s loop condition against a payload that NEVER
  // shrinks -- the pathological case (e.g. a report whose bulk is vector text,
  // not photos). It must stop, not hang a phone.
  let tier = 0, rebuilds = 0;
  const neverShrinks = c.SEND_MAX_PDF_BASE64 * 4;
  while (!c.pdfBase64FitsEmail(neverShrinks) && tier + 1 < c.pdfPhotoTierCount()) {
    tier++; rebuilds++;
  }
  assert.strictEqual(rebuilds, 2, "at most one rebuild per remaining tier");
  assert.strictEqual(tier, c.pdfPhotoTierCount() - 1);
  assert.strictEqual(c.pdfBase64FitsEmail(neverShrinks), false,
    "and it still doesn't fit -- so the caller must show oversizeReportMessage()");
});

test("the give-up message names the real size and a route that actually works", () => {
  const c = budgetCtx();
  const msg = c.oversizeReportMessage(Math.ceil(6.2 * 1048576 * 4 / 3));
  assert.match(msg, /6\.2 MB/, "must state the actual size the tech is looking at");
  assert.match(msg, /Download PDF/, "must name the workaround that works");
  assert.match(msg, /CompanyCam/, "must reassure that no photo is lost");
  assert.doesNotMatch(msg, /\b(413|403|error \d)/, "a status code is not an instruction");
});

/* ================================================== failure messaging === */

test("an EMPTY platform 413 becomes an actionable message, not \"server error 413\"", () => {
  const h = historyCtx();
  // This is exactly the reported shape: the edge rejected the body, so
  // resp.json() threw and `out` is null.
  const msg = h.sendFailureMessage(413, null);
  assert.match(msg, /too big/i);
  assert.match(msg, /Download PDF/);
  assert.doesNotMatch(msg, /server error/);
});

test("the function's OWN JSON error always wins over the generic mapping", () => {
  const h = historyCtx();
  assert.strictEqual(
    h.sendFailureMessage(403, { error: "Forbidden: missing permission doc.email_customer" }),
    "Forbidden: missing permission doc.email_customer",
    "a specific server message must never be replaced by a generic one");
  assert.strictEqual(
    h.sendFailureMessage(400, { error: "No valid recipients" }), "No valid recipients");
});

test("bodyless 401/403/5xx each get their own next step", () => {
  const h = historyCtx();
  assert.match(h.sendFailureMessage(401, null), /sign in again/i);
  assert.match(h.sendFailureMessage(403, null), /permission/i);
  assert.match(h.sendFailureMessage(500, null), /Download PDF/);
  assert.match(h.sendFailureMessage(502, null), /try again/i);
  // An unmapped status still degrades to the old string rather than "undefined".
  assert.strictEqual(h.sendFailureMessage(418, null), "server error 418");
});

test("pdfBase64Of returns \"\" (never throws) when jsPDF can't produce output", () => {
  const h = historyCtx();
  assert.strictEqual(h.pdfBase64Of({ output: () => "data:application/pdf;base64,QUJD" }), "QUJD");
  assert.strictEqual(h.pdfBase64Of({ output: () => { throw new Error("boom"); } }), "");
  assert.strictEqual(h.pdfBase64Of({ output: () => "not-a-data-uri" }), "");
  assert.strictEqual(h.pdfBase64Of({}), "");
});

/* ======================================== client/server budget parity === */

test("PARITY: server-side guard is the same number as the client budget", () => {
  const c = budgetCtx();
  const body = Number(/const SEND_MAX_BODY_BYTES = (\d+);/.exec(fnSrc)[1]);
  const reserve = Number(/const SEND_ENVELOPE_RESERVE = (\d+);/.exec(fnSrc)[1]);
  assert.strictEqual(body, c.SEND_MAX_BODY_BYTES,
    "send-workorder.js and js/export.js must agree on the body ceiling");
  assert.strictEqual(body - reserve, c.SEND_MAX_PDF_BASE64,
    "send-workorder.js and js/export.js must agree on the base64 budget");
});

test("REGRESSION: the server guard is no longer the unreachable 8,000,000", () => {
  // The old value could never fire -- a body that large is already past the
  // platform's 6 MiB wall, so the handler was never invoked to check it.
  assert.doesNotMatch(fnSrc, /pdfBase64\.length > 8000000/,
    "the dead 8MB guard must not come back");
  const c = budgetCtx();
  assert.ok(c.SEND_MAX_PDF_BASE64 < 6291456,
    "the guard must sit BELOW the 6 MiB Lambda limit to be reachable at all");
});

/* =============================================== the function's 400 ===== */

/* Exercises the real handler with firebase-admin stubbed out, to prove the
   oversize rejection is a parseable JSON 400 (the client's `out.error` path)
   rather than anything the browser would have to guess at. */
function loadHandler() {
  const Module = require("module");
  const realResolve = Module._resolveFilename;
  const stub = {
    requirePermission: async () => ({ uid: "u1", owner: true, role: null })
  };
  const key = require.resolve(path.join(__dirname, "..", "netlify", "functions", "send-workorder.js"));
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

test("an over-budget body that DOES reach the handler gets a parseable JSON 400", async () => {
  process.env.RESEND_API_KEY = "test_key";
  const { handler } = loadHandler();
  const c = budgetCtx();
  const res = await handler({
    httpMethod: "POST", headers: { host: "dev--leak-work-orders.netlify.app" },
    body: JSON.stringify({ to: ["a@b.com"], pdfBase64: "A".repeat(c.SEND_MAX_PDF_BASE64 + 1) })
  });
  assert.strictEqual(res.statusCode, 400);
  const out = JSON.parse(res.body); // must not throw -- this is the whole point
  assert.match(out.error, /too big to email/);
  assert.match(out.error, /Download PDF/);
});

test("a body at exactly the budget is NOT rejected for size", async () => {
  process.env.RESEND_API_KEY = "test_key";
  const { handler } = loadHandler();
  const c = budgetCtx();
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, text: async () => "{\"id\":\"em_1\"}" };
  };
  try {
    const res = await handler({
      httpMethod: "POST", headers: { host: "dev--leak-work-orders.netlify.app" },
      body: JSON.stringify({ to: ["a@b.com"], pdfBase64: "A".repeat(c.SEND_MAX_PDF_BASE64) })
    });
    assert.strictEqual(res.statusCode, 200, "the boundary value must be accepted, not rejected");
    assert.strictEqual(calls.length, 1, "and must actually reach Resend");
  } finally { global.fetch = realFetch; }
});

test("a missing PDF still says \"PDF missing\", not a bogus size", async () => {
  process.env.RESEND_API_KEY = "test_key";
  const { handler } = loadHandler();
  const res = await handler({
    httpMethod: "POST", headers: { host: "dev--leak-work-orders.netlify.app" },
    body: JSON.stringify({ to: ["a@b.com"] })
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.body).error, "PDF missing");
});
