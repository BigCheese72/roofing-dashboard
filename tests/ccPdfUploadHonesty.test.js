const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { uploadDocumentToCompanyCam } = require(path.join(__dirname, "..", "netlify", "functions", "lib", "companyCamDocuments.js"));
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* ---------- server lib: success REQUIRES a document id ---------- */
function withFetch(responder, fn){
  const orig = global.fetch;
  global.fetch = responder;
  const prevTok = process.env.COMPANYCAM_TOKEN;
  process.env.COMPANYCAM_TOKEN = "test-token";
  return Promise.resolve().then(fn).finally(function(){
    global.fetch = orig;
    if (prevTok === undefined) delete process.env.COMPANYCAM_TOKEN; else process.env.COMPANYCAM_TOKEN = prevTok;
  });
}
const okResp = (body) => Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve(body) });

test("lib: top-level {id} response succeeds with the id", () => withFetch(
  () => okResp(JSON.stringify({ id: 42, url: "https://cc/doc/42" })),
  async () => {
    const out = await uploadDocumentToCompanyCam("109856487", "inspection_1.pdf", "QUJD");
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.documentId, "42");
    assert.strictEqual(out.url, "https://cc/doc/42");
  }));

test("lib: nested {document:{id}} response succeeds with the id", () => withFetch(
  () => okResp(JSON.stringify({ document: { id: "77", url: "https://cc/doc/77" } })),
  async () => {
    const out = await uploadDocumentToCompanyCam("109856487", "x.pdf", "QUJD");
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.documentId, "77");
  }));

test("lib: 2xx with an UNPARSEABLE body is a FAILURE, never ok (the Flat Branch soft-fail)", () => withFetch(
  () => okResp("<html>weird gateway page</html>"),
  async () => {
    const out = await uploadDocumentToCompanyCam("109856487", "x.pdf", "QUJD");
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /no document id/i);
    assert.match(out.error, /FAILED, not saved/);
  }));

test("lib: 2xx with a parseable body but no id is a FAILURE", () => withFetch(
  () => okResp(JSON.stringify({ status: "accepted" })),
  async () => {
    const out = await uploadDocumentToCompanyCam("109856487", "x.pdf", "QUJD");
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /no document id/i);
  }));

test("lib: non-2xx still fails with the CompanyCam error", () => withFetch(
  () => Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('{"error":"bad attachment"}') }),
  async () => {
    const out = await uploadDocumentToCompanyCam("109856487", "x.pdf", "QUJD");
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /rejected the document: 422/);
  }));

/* ---------- pure status mapping: "saved" requires the artifact ---------- */
function makeStatusSandbox(){
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(between(historySource, "function ccStatusFromUploadResult", "/* ccUploadResult is the return value"), sandbox);
  return sandbox;
}

test("status: ok WITH documentId -> saved, carrying the id", () => {
  const sb = makeStatusSandbox();
  const out = sb.ccStatusFromUploadResult(null, "", null, { ok: true, documentId: "42" });
  assert.deepStrictEqual({ s: out.status, e: out.error, d: out.documentId }, { s: "saved", e: "", d: "42" });
});

test("status: ok WITHOUT documentId is FAILED, never saved (the dishonest-flag bug)", () => {
  const sb = makeStatusSandbox();
  const out = sb.ccStatusFromUploadResult(null, "", null, { ok: true, documentId: null });
  assert.strictEqual(out.status, "failed");
  assert.match(out.error, /no document id/i);
});

test("status: unchanged-skip keeps saved (id already held); plain skip is not_linked", () => {
  const sb = makeStatusSandbox();
  const unchanged = sb.ccStatusFromUploadResult("saved", "", "42", { ok: true, skipped: true, unchanged: true, documentId: "42" });
  assert.strictEqual(unchanged.status, "saved");
  assert.strictEqual(unchanged.documentId, "42");
  const skipped = sb.ccStatusFromUploadResult(null, "", null, { skipped: true });
  assert.strictEqual(skipped.status, "not_linked");
});

test("status: failure records the real error; no-attempt (undefined) carries prior state through", () => {
  const sb = makeStatusSandbox();
  const failed = sb.ccStatusFromUploadResult("saved", "", "42", { ok: false, error: "401 Unauthorized" });
  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(failed.error, "401 Unauthorized");
  assert.strictEqual(failed.documentId, "42", "a previously verified artifact id is kept for reference");
  const untouched = sb.ccStatusFromUploadResult("saved", "", "42", undefined);
  assert.deepStrictEqual({ s: untouched.status, d: untouched.documentId }, { s: "saved", d: "42" });
});

/* ---------- client uploader: artifact-or-fail, never clobbers a good id ---------- */
function makeUploaderSandbox(apiResponse){
  const persisted = [];
  const sandbox = {
    __persisted: persisted,
    fdb: { collection(){ return { doc(){ return { set(data){ persisted.push(data); return Promise.resolve(); } }; } }; } },
    ccApiPost(){ return Promise.resolve(apiResponse); },
    ccDocumentName(){ return "inspection_16001.pdf"; },
    pdfFileName(){ return "x.pdf"; }
  };
  vm.createContext(sandbox);
  vm.runInContext(between(historySource, "function pdfContentHash", "/* ================= CompanyCam PHOTO FEED push"), sandbox);
  return sandbox;
}
const FAKE_DOC = { output(){ return "data:application/pdf;base64,QUJDREVG"; } };

test("uploader: response without a document id fails and leaves the stored id alone", async () => {
  const sb = makeUploaderSandbox({ ok: true }); /* server ok-envelope, no id (legacy soft-fail shape) */
  const o = { id: "wo_1", companyCamProjectId: "109856487", ccDocumentId: "old_good_id", ccDocumentHash: "different" };
  const out = await sb.uploadPdfToCompanyCam(FAKE_DOC, o);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /NOT confirmed saved/);
  assert.strictEqual(o.ccDocumentId, "old_good_id", "a previously good id must never be clobbered with null");
  assert.strictEqual(sb.__persisted.length, 0, "nothing dishonest persisted");
});

test("uploader: response with a document id succeeds and persists it", async () => {
  const sb = makeUploaderSandbox({ ok: true, documentId: "99", url: "https://cc/doc/99" });
  const o = { id: "wo_1", companyCamProjectId: "109856487" };
  const out = await sb.uploadPdfToCompanyCam(FAKE_DOC, o);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.documentId, "99");
  assert.strictEqual(o.ccDocumentId, "99");
  assert.strictEqual(sb.__persisted[0].ccDocumentId, "99");
});

test("uploader: unchanged re-send still short-circuits without an API call", async () => {
  const sb = makeUploaderSandbox(null /* ccApiPost must not be reached */);
  const o = { id: "wo_1", companyCamProjectId: "109856487" };
  /* First compute the hash the uploader would see, then pretend it's stored. */
  const hash = sb.pdfContentHash("QUJDREVG");
  o.ccDocumentId = "42"; o.ccDocumentHash = hash;
  const out = await sb.uploadPdfToCompanyCam(FAKE_DOC, o);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.unchanged, true);
  assert.strictEqual(out.documentId, "42");
});

/* ---------- retry/backfill wiring ---------- */
function makeBackfillSandbox(){
  const sandbox = { esc(s){ return String(s == null ? "" : s); } };
  vm.createContext(sandbox);
  vm.runInContext(between(historySource, "function rpNeedsCcBackfill", "/* Same load-then-act pattern"), sandbox);
  return sandbox;
}

test("backfill offered exactly when a linked report lacks a verified artifact", () => {
  const sb = makeBackfillSandbox();
  /* The Flat Branch shape: linked, status 'saved', but NO ccDocumentId. */
  assert.strictEqual(sb.rpNeedsCcBackfill({ workOrderId: "wo_1784122808661", companyCamProjectId: "109856487", companyCamUploadStatus: "saved" }), true);
  assert.strictEqual(sb.rpNeedsCcBackfill({ workOrderId: "wo_1", companyCamProjectId: "p", companyCamUploadStatus: "failed", ccDocumentId: null }), true);
  assert.strictEqual(sb.rpNeedsCcBackfill({ workOrderId: "wo_1", companyCamProjectId: "p", companyCamUploadStatus: null }), true);
  /* Honest saved (has the artifact) — no button. */
  assert.strictEqual(sb.rpNeedsCcBackfill({ workOrderId: "wo_1", companyCamProjectId: "p", companyCamUploadStatus: "saved", ccDocumentId: "42" }), false);
  /* Unlinked or activity rows — never. */
  assert.strictEqual(sb.rpNeedsCcBackfill({ workOrderId: "wo_1", companyCamUploadStatus: "failed" }), false);
  assert.strictEqual(sb.rpNeedsCcBackfill({ workOrderId: "wo_1", companyCamProjectId: "p", isActivity: true }), false);
});

test("backfill is wired: report row button, pending-load flow, showView hook", () => {
  assert.match(historySource, /rpNeedsCcBackfill\(r\) \?/);
  assert.match(historySource, /backfillReportPdfToCompanyCam\(/);
  assert.match(between(historySource, "async function runPendingCcPdfBackfill", "var ACTIVITY_TYPES"),
    /uploadLinkedPdfToCompanyCam\(d, o, "Backfill"\)/);
  assert.match(between(historySource, "async function runPendingCcPdfBackfill", "var ACTIVITY_TYPES"),
    /logReportAndHistoryEvent\(o, "Saved", null, ccUp\)/);
  assert.match(coreSource, /typeof runPendingCcPdfBackfill === "function"\) runPendingCcPdfBackfill\(\)/);
});

test("history payload records the artifact id next to the status", () => {
  const payload = between(historySource, "var payload = {", "var batch = fdb.batch();");
  assert.match(payload, /ccDocumentId: ccS\.documentId,/);
});
