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

/* ---- the budget + ladder helpers, lifted from js/export.js -------------- */
function budgetCtx() {
  const start = exportSrc.indexOf("var SEND_MAX_BODY_BYTES");
  const end = exportSrc.indexOf("function buildPdfPhotoMap");
  assert.notEqual(start, -1, "SEND_MAX_BODY_BYTES must exist in js/export.js");
  assert.notEqual(end, -1);
  const ctx = { Math: Math, Promise: Promise };
  vm.runInNewContext(exportSrc.slice(start, end), ctx);
  return ctx;
}

/* vm.runInNewContext gives objects a DIFFERENT realm's Object.prototype, so
   deepStrictEqual reports "same structure but not reference-equal". Compare
   the values, not the prototypes. */
const stepOf = t => ({ maxDim: t.maxDim, quality: t.quality });

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

/* ================================== the per-report photo size budget ===== */
/* The 900px/q0.72 hard cap these tests used to pin was replaced on 2026-07-31
   by a per-report TOTAL budget: pick a target size for the whole report, then
   spend it across however many photos the report has. See the long rationale
   at PDF_PHOTO_STEPS in js/export.js. */

test("the ladder descends monotonically in BOTH resolution and quality", () => {
  const c = budgetCtx();
  assert.ok(c.PDF_PHOTO_STEPS.length >= 5, "a coarse ladder cannot track a budget");
  for (let i = 1; i < c.PDF_PHOTO_STEPS.length; i++) {
    assert.ok(c.PDF_PHOTO_STEPS[i].maxDim < c.PDF_PHOTO_STEPS[i - 1].maxDim,
      "step " + i + " must be smaller than step " + (i - 1));
    assert.ok(c.PDF_PHOTO_STEPS[i].quality <= c.PDF_PHOTO_STEPS[i - 1].quality,
      "step " + i + " must not be HIGHER quality than step " + (i - 1));
  }
  // Monotonic size is what makes the search well-ordered: a softer step must
  // never be estimated as costing more than a sharper one.
  for (let i = 1; i < c.PDF_PHOTO_STEPS.length; i++) {
    assert.ok(c.estPhotoBytes(c.PDF_PHOTO_STEPS[i]) < c.estPhotoBytes(c.PDF_PHOTO_STEPS[i - 1]),
      "step " + i + " must estimate smaller than step " + (i - 1));
  }
});

test("the ceiling is well above the old 900px cap, and 900px is still on the ladder", () => {
  const c = budgetCtx();
  assert.ok(c.PDF_PHOTO_STEPS[0].maxDim >= 1600,
    "a few-photo report must be allowed to render large -- that is the whole point");
  assert.ok(c.PDF_PHOTO_STEPS[0].quality >= 0.80,
    "resolution without quality still looks soft (q0.72 on a re-encode is visible)");
  assert.ok(c.PDF_PHOTO_STEPS.some(s => s.maxDim === 900),
    "the old fixed cap must remain reachable as a middle rung");
});

test("the size model reproduces the two REAL measurements it is calibrated on", () => {
  const c = budgetCtx();
  // Anchor 1 (2026-07-30, jimp on a real capture): 900px/q0.72 -> 198KB.
  const at900 = c.estPhotoBytes({ maxDim: 900, quality: 0.72 });
  assert.ok(Math.abs(at900 - 198 * 1024) < 30 * 1024,
    "900px/q0.72 must estimate ~198KB, got " + Math.round(at900 / 1024) + "KB");
  // Anchor 2 (the field report that started this): 915 Richmond, 31 photos at
  // 900px/q0.72 came to ~6.2MB. The model must reproduce the actual bug.
  const richmond = c.estReportPhotoBytes(31, { maxDim: 900, quality: 0.72 });
  assert.ok(Math.abs(richmond - 6.2 * 1048576) < 1.2 * 1048576,
    "31 photos at the old cap must estimate ~6.2MB, got " + (richmond / 1048576).toFixed(1) + "MB");
  // ...and that is over the wall, which is why it could not be emailed.
  assert.ok(richmond > c.transmitPhotoBudget(),
    "sanity: the reported report really was over the transmit budget at the old cap");
});

test("FEW photos are rendered large and sharp -- not squeezed to 900px for nothing", () => {
  const c = budgetCtx();
  // The case Mark reported as soft: a handful of photos on a linked work
  // order, so the tightest budget in the app (it still has to reach Lambda).
  for (const n of [1, 2, 3]) {
    const step = c.photoStepFor(n, c.transmitPhotoBudget());
    assert.ok(step.maxDim >= 1600,
      n + " photos should render at >=1600px, got " + step.maxDim);
    assert.ok(step.quality >= 0.80, n + " photos should render at >=q0.80");
  }
  // A local (unlinked) download has 15MB to spend and should reach the top.
  assert.deepStrictEqual(stepOf(c.photoStepFor(3, c.localPhotoBudget())),
    stepOf(c.PDF_PHOTO_STEPS[0]));
});

test("MANY photos dial DOWN automatically, and the total lands inside the budget", () => {
  const c = budgetCtx();
  for (const budget of [c.transmitPhotoBudget(), c.localPhotoBudget()]) {
    let prev = -1;
    for (const n of [1, 3, 6, 10, 15, 20, 31, 40, 60, 120]) {
      const i = c.photoStepIndexFor(n, budget);
      assert.ok(i >= prev, "more photos must never produce a SHARPER step (n=" + n + ")");
      prev = i;
      const total = c.estReportPhotoBytes(n, c.PDF_PHOTO_STEPS[i]);
      // The only counts allowed to exceed the budget are ones already at the
      // floor of the ladder -- there is nothing softer to fall back to.
      if (i < c.PDF_PHOTO_STEPS.length - 1) {
        assert.ok(total <= budget,
          n + " photos estimated " + (total / 1048576).toFixed(1) + "MB against a " +
          (budget / 1048576).toFixed(1) + "MB budget");
      }
    }
  }
});

test("the chosen step is the SHARPEST that fits, never a lazier one", () => {
  const c = budgetCtx();
  for (const n of [1, 4, 9, 17, 31, 55]) {
    const budget = c.transmitPhotoBudget();
    const i = c.photoStepIndexFor(n, budget);
    if (i > 0) {
      assert.ok(c.estReportPhotoBytes(n, c.PDF_PHOTO_STEPS[i - 1]) > budget,
        "step " + (i - 1) + " fit for n=" + n + " but was passed over");
    }
  }
});

test("REGRESSION: 915 Richmond (31 photos) now fits the send on the FIRST build", () => {
  const c = budgetCtx();
  const step = c.photoStepFor(31, c.transmitPhotoBudget());
  const total = c.estReportPhotoBytes(31, step);
  assert.ok(total <= c.transmitPhotoBudget(),
    "31 photos must be planned inside the transmit budget, got " + (total / 1048576).toFixed(1) + "MB");
  // And the whole PDF, base64-expanded, must clear the send guard -- the
  // number that actually bounced it.
  const base64Len = Math.ceil((total + c.PDF_NON_PHOTO_RESERVE) * 4 / 3);
  assert.strictEqual(c.pdfBase64FitsEmail(base64Len), true,
    "the planned report must pass the guard it used to fail");
  assert.ok(step.maxDim < 900, "31 photos must be dialled BELOW the old cap to fit");
});

test("NO photo count can plan a report past the send guard", () => {
  const c = budgetCtx();
  // Requirement 3, stated as the invariant that actually holds for EVERY
  // count: a planned report either clears the guard, or it is already at the
  // floor of the ladder -- which is the case the send path refuses outright
  // with oversizeReportMessage() rather than posting.
  const floor = c.PDF_PHOTO_STEPS.length - 1;
  let firstUnfittable = 0;
  for (let n = 1; n <= 300; n++) {
    const i = c.photoStepIndexFor(n, c.transmitPhotoBudget());
    const total = c.estReportPhotoBytes(n, c.PDF_PHOTO_STEPS[i]);
    const base64Len = Math.ceil((total + c.PDF_NON_PHOTO_RESERVE) * 4 / 3);
    if (c.pdfBase64FitsEmail(base64Len)) continue;
    assert.strictEqual(i, floor,
      n + " photos planned " + (base64Len / 1048576).toFixed(1) +
      "MB of base64 but was NOT at the ladder floor -- a softer step was available");
    if (!firstUnfittable) firstUnfittable = n;
  }
  // The point of the whole change: a real photo-heavy report is nowhere near
  // that cliff. 915 Richmond had 31.
  assert.ok(firstUnfittable > 60,
    "reports up to 60 photos must be emailable; the cliff starts at " + firstUnfittable);
});

test("the transmit budget really is derived from the guard, not a parallel number", () => {
  const c = budgetCtx();
  assert.ok(c.transmitPhotoBudget() < c.SEND_MAX_PDF_BASE64 * 3 / 4,
    "the photo budget must sit below the DECODED guard, with room for the pages");
  assert.strictEqual(c.transmitPhotoBudget(),
    Math.floor(c.SEND_MAX_PDF_BASE64 * 3 / 4) - c.PDF_NON_PHOTO_RESERVE);
  assert.ok(c.localPhotoBudget() > c.transmitPhotoBudget(),
    "a report that stays on the device should get more, not less");
  assert.strictEqual(c.PDF_REPORT_TARGET_BYTES, 15 * 1024 * 1024,
    "the tunable target Mark asked for");
});

test("pinning wins over the automatic budget, and releasing restores it", () => {
  const c = budgetCtx();
  // A Download on an unlinked work order: full local budget.
  assert.strictEqual(c.autoPdfPhotoBudget(false), c.localPhotoBudget());
  // A Download on a CompanyCam-LINKED work order still POSTs the PDF, so it
  // gets the transmit budget -- the bug this would otherwise reintroduce.
  assert.strictEqual(c.autoPdfPhotoBudget(true), c.transmitPhotoBudget());
  // A send pins its own, and generatePdf() must not be able to overwrite it.
  c.pinPdfPhotoBudget(1000000);
  assert.strictEqual(c.autoPdfPhotoBudget(false), 1000000,
    "a pinned budget must survive generatePdf()'s automatic decision");
  assert.strictEqual(c.currentPhotoStepFor(4).maxDim, c.photoStepFor(4, 1000000).maxDim);
  c.releasePdfPhotoBudget();
  assert.strictEqual(c.autoPdfPhotoBudget(false), c.localPhotoBudget(),
    "releasing must hand control back, or every later Download stays degraded");
  // Garbage pins fall back to the transmit budget rather than corrupting an
  // export with a zero or negative budget.
  assert.strictEqual(c.pinPdfPhotoBudget(0), c.transmitPhotoBudget());
  assert.strictEqual(c.pinPdfPhotoBudget("big"), c.transmitPhotoBudget());
  assert.strictEqual(c.pinPdfPhotoBudget(-5), c.transmitPhotoBudget());
  c.releasePdfPhotoBudget();
});

test("REGRESSION: every rebuild moves a rung -- a % budget cut did not", () => {
  const c = budgetCtx();
  /* The bug this pins: shrinking the BUDGET by 30% per rebuild landed on the
     same rung twice for 20 photos (the lower rungs are only ~30% apart), so a
     rebuild re-rendered the whole PDF on a phone and changed nothing. The
     backstop counts rungs instead. Checked for every photo count, not just
     the one that happened to fail. */
  const floor = c.PDF_PHOTO_STEPS.length - 1;
  for (const n of [1, 3, 5, 10, 20, 31, 40, 60, 87]) {
    c.pinPdfPhotoBudget(c.transmitPhotoBudget());
    let prev = c.currentPhotoStepIndexFor(n);
    for (let r = 1; r <= c.PDF_PHOTO_MAX_REBUILDS; r++) {
      c.softenPdfPhotoPlan();
      const i = c.currentPhotoStepIndexFor(n);
      assert.ok(i > prev || i === floor,
        "n=" + n + " rebuild " + r + " did not soften the plan (stuck at step " + i + ")");
      prev = i;
    }
    c.releasePdfPhotoBudget();
  }
});

test("the rebuild loop terminates instead of spinning forever on a phone", () => {
  const c = budgetCtx();
  // Mirrors sendEmailNow()'s backstop against a payload that NEVER shrinks --
  // the pathological case (e.g. a report whose bulk is vector text, not
  // photos, so softening the photos cannot help).
  c.pinPdfPhotoBudget(c.transmitPhotoBudget());
  let rebuilds = 0;
  const neverShrinks = c.SEND_MAX_PDF_BASE64 * 4;
  while (!c.pdfBase64FitsEmail(neverShrinks) && rebuilds < c.PDF_PHOTO_MAX_REBUILDS) {
    rebuilds++;
    c.softenPdfPhotoPlan();
  }
  assert.strictEqual(rebuilds, c.PDF_PHOTO_MAX_REBUILDS, "bounded, not unbounded");
  assert.strictEqual(c.pdfBase64FitsEmail(neverShrinks), false,
    "and it still doesn't fit -- so the caller must show oversizeReportMessage()");
  c.releasePdfPhotoBudget();
  // With nothing pinned the fallback is deliberately the SAFE budget, and the
  // forced softening must be gone -- otherwise the NEXT report in the session
  // is silently degraded by this one's failure.
  assert.strictEqual(c.currentPhotoStepIndexFor(20), c.photoStepIndexFor(20, c.transmitPhotoBudget()),
    "releasing must clear the softening too, or the NEXT report stays degraded");
});

test("exhausting the rebuilds leaves nothing on the table", () => {
  const c = budgetCtx();
  /* Justifies PDF_PHOTO_MAX_REBUILDS = 4: when the loop gives up, the report
     must EITHER have been cut hard (the estimator was badly out and we made a
     real attempt) OR already be at the softest the app is willing to render.
     Either way oversizeReportMessage() is honest -- there was nothing left to
     try.

     2.5x, not 4x: the ladder's lower rungs are close together on purpose (see
     PDF_PHOTO_STEPS), so four rungs buy less size down there. That trade is
     deliberate -- the fine rungs improve every storm report, while this loop
     only runs when the estimate was beaten, and 2.5x is far more estimator
     error than the two real calibration anchors suggest is possible. */
  const floor = c.PDF_PHOTO_STEPS.length - 1;
  for (const n of [3, 10, 20, 31, 60]) {
    c.pinPdfPhotoBudget(c.transmitPhotoBudget());
    const before = c.estReportPhotoBytes(n, c.currentPhotoStepFor(n));
    for (let r = 0; r < c.PDF_PHOTO_MAX_REBUILDS; r++) c.softenPdfPhotoPlan();
    const after = c.estReportPhotoBytes(n, c.currentPhotoStepFor(n));
    const atFloor = c.currentPhotoStepIndexFor(n) === floor;
    c.releasePdfPhotoBudget();
    assert.ok(atFloor || before / after >= 2.5,
      "n=" + n + ": gave up after only a " + (before / after).toFixed(1) +
      "x cut without reaching the ladder floor");
  }
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
