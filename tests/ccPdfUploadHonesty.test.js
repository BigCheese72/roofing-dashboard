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

test("status: failure with NO known artifact records the real error as failed", () => {
  const sb = makeStatusSandbox();
  const failed = sb.ccStatusFromUploadResult(null, "", null, { ok: false, error: "401 Unauthorized" });
  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(failed.error, "401 Unauthorized");
  const untouched = sb.ccStatusFromUploadResult("saved", "", "42", undefined);
  assert.deepStrictEqual({ s: untouched.status, d: untouched.documentId }, { s: "saved", d: "42" });
});

/* THE OTHER DIRECTION (Sophia's Curb Flashing, Job 17476 / wo_1784203041457):
   a transient "Load failed" during a re-send was recorded as a FINAL
   "failed" while the work order held the uploaded document's id — the
   timeline alarmed "NOT SAVED TO COMPANYCAM" about a report that was
   demonstrably on CompanyCam. Artifact truth: a known doc id means saved. */
test("status: transient failure with a KNOWN document id reconciles to saved — never a false 'not saved' alarm", () => {
  const sb = makeStatusSandbox();
  const sophia = sb.ccStatusFromUploadResult("failed", "Load failed", "cc_doc_sophia", { ok: false, error: "Load failed" });
  assert.strictEqual(sophia.status, "saved", "a known uploaded artifact must never show as not-saved");
  assert.strictEqual(sophia.error, "", "no alarm error alongside a verified artifact");
  assert.strictEqual(sophia.documentId, "cc_doc_sophia");
  /* Same rule when the id comes from the WORK ORDER rather than the event
     (Sophia's event predates ccDocumentId; her WO doc holds it — the call
     site passes existing.ccDocumentId || o.ccDocumentId). */
  const viaOrder = sb.ccStatusFromUploadResult(null, "", "cc_doc_from_wo", { ok: false, error: "network blip" });
  assert.strictEqual(viaOrder.status, "saved");
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

/* ---------- server-side artifact verification (verifyDocumentOnCompanyCam) ---------- */
const { verifyDocumentOnCompanyCam } = require(path.join(__dirname, "..", "netlify", "functions", "lib", "companyCamDocuments.js"));

test("verify: existing document reports exists:true; 404 reports exists:false", () => withFetch(
  (url) => Promise.resolve(url.indexOf("/documents/present_1") !== -1
    ? { ok: true, status: 200, text: () => Promise.resolve("{}") }
    : { ok: false, status: 404, text: () => Promise.resolve("") }),
  async () => {
    const there = await verifyDocumentOnCompanyCam("present_1");
    assert.deepStrictEqual({ ok: there.ok, exists: there.exists }, { ok: true, exists: true });
    const gone = await verifyDocumentOnCompanyCam("gone_2");
    assert.deepStrictEqual({ ok: gone.ok, exists: gone.exists }, { ok: true, exists: false });
  }));

test("verify: transient API errors are NOT treated as 'document gone'", () => withFetch(
  () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("busy") }),
  async () => {
    const out = await verifyDocumentOnCompanyCam("cc_doc_sophia");
    assert.strictEqual(out.ok, false, "a flaky check must not report a verdict");
    assert.strictEqual(out.exists, undefined);
  }));

test("server handler forwards documentId/url and exposes verify_document", () => {
  const fnSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "companycam.js"), "utf8");
  assert.match(fnSource, /documentId: result\.documentId/,
    "upload_document response must carry the extracted id (it used to be dropped)");
  assert.match(fnSource, /body\.action === "verify_document"/);
  assert.match(fnSource, /verifyDocumentOnCompanyCam\(body\.document_id\)/);
});

/* ---------- the artifact survives collect()/fill() (the WO always knows its own upload) ---------- */
function makeArtifactFormSandbox(){
  const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service"],
    currentId: null, currentRoofId: null, currentRoofIds: null,
    currentBuildingId: null, currentCustomerId: null,
    currentCcDocumentId: null, currentCcDocumentHash: null,
    findings: [], repairs: [], repairItems: [], materials: [], inspectionChecklist: [], photos: [],
    ccLinkedProjectId: null, ccLinkedProjectName: "", changeOrderSignature: null,
    lastLookupRoofInfo: null, fdb: {},
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){}, console: { warn(){}, log(){} },
    buildingIdFor(){ return "bld_t"; }, lookupRoofInfoMatchesBuilding(){ return false; },
    populateWoTypeSelect(){}, populateRoofSystemSelect(){}, renderLeakNoJobBadge(){},
    renderLocationDirectionsLink(){}, onWoTypeChange(){}, renderFindings(){}, renderRepairs(){},
    renderRepairItems(){}, renderMaterials(){}, renderPhotos(){}, renderCCLinkInfo(){},
    renderChangeOrderSignature(){}, ensureInspectionChecklist(){}, renderInspectionChecklist(){},
    clearStaleLookupRoofInfoForCurrentOrder(){}, scheduleInlineBuildingHistoryRefresh(){},
    scheduleResolveBuildingCCLink(){},
    genId(p){ return p + "_t"; },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  const src = between(workordersSource, "var FIELD_IDS =", "function todayStr");
  vm.runInContext(src, sandbox);
  return sandbox;
}

test("ccDocumentId/ccDocumentHash survive a fill()→collect() reload (the #54 guard now outlives the session)", () => {
  const sb = makeArtifactFormSandbox();
  sb.fill({ id: "wo_1784203041457", jobName: "Sophia's Curb Flashing",
    ccDocumentId: "cc_doc_sophia", ccDocumentHash: "abc123:42", findings: [], photos: [] });
  const rebuilt = sb.collect();
  assert.strictEqual(rebuilt.ccDocumentId, "cc_doc_sophia");
  assert.strictEqual(rebuilt.ccDocumentHash, "abc123:42");
  /* And an order that never uploaded carries explicit nulls, not garbage. */
  const sb2 = makeArtifactFormSandbox();
  sb2.fill({ id: "wo_new", findings: [], photos: [] });
  assert.strictEqual(sb2.collect().ccDocumentId, null);
});

/* ---------- ⟳ re-sync verifies BEFORE re-uploading ---------- */
function makeResyncSandbox(opts){
  opts = opts || {};
  const calls = { verify: 0, generate: 0, upload: 0, logged: [] };
  const sandbox = {
    __calls: calls,
    currentId: "wo_1784203041457",
    collect(){ return Object.assign({ id: "wo_1784203041457", companyCamProjectId: "109" }, opts.order); },
    toast(){},
    loadOrder(){},
    ccApiPost(body){
      calls.verify++;
      if (opts.verifyThrows) return Promise.reject(new Error("offline"));
      return Promise.resolve({ ok: true, exists: !!opts.exists });
    },
    generatePdf(){ calls.generate++; return Promise.resolve({ fake: true }); },
    uploadLinkedPdfToCompanyCam(){ calls.upload++; return Promise.resolve({ ok: true, documentId: "new_99" }); },
    logReportAndHistoryEvent(o, kind, emailInfo, ccUp){ calls.logged.push(ccUp); return Promise.resolve(); },
    esc(s){ return String(s == null ? "" : s); }
  };
  vm.createContext(sandbox);
  vm.runInContext(between(historySource, "var pendingCcPdfBackfillOrderId", "function rpRenderList"), sandbox);
  return sandbox;
}

test("re-sync: doc verified on CompanyCam -> status corrected to saved, NOTHING re-uploaded (Sophia's safe fix)", async () => {
  const sb = makeResyncSandbox({ order: { ccDocumentId: "cc_doc_sophia" }, exists: true });
  sb.pendingCcPdfBackfillOrderId = "wo_1784203041457";
  await sb.runPendingCcPdfBackfill();
  assert.strictEqual(sb.__calls.verify, 1);
  assert.strictEqual(sb.__calls.generate, 0, "no PDF rebuild when the doc is verified present");
  assert.strictEqual(sb.__calls.upload, 0, "no duplicate document pushed");
  assert.strictEqual(sb.__calls.logged.length, 1);
  assert.deepStrictEqual(
    { ok: sb.__calls.logged[0].ok, id: sb.__calls.logged[0].documentId, v: sb.__calls.logged[0].verified },
    { ok: true, id: "cc_doc_sophia", v: true });
});

test("re-sync: doc genuinely gone -> falls through to regenerate + upload", async () => {
  const sb = makeResyncSandbox({ order: { ccDocumentId: "cc_doc_gone" }, exists: false });
  sb.pendingCcPdfBackfillOrderId = "wo_1784203041457";
  await sb.runPendingCcPdfBackfill();
  assert.strictEqual(sb.__calls.generate, 1);
  assert.strictEqual(sb.__calls.upload, 1);
});

test("re-sync: verification unreachable -> upload path is the honest fallback; no id -> straight to upload", async () => {
  const flaky = makeResyncSandbox({ order: { ccDocumentId: "cc_doc_sophia" }, verifyThrows: true });
  flaky.pendingCcPdfBackfillOrderId = "wo_1784203041457";
  await flaky.runPendingCcPdfBackfill();
  assert.strictEqual(flaky.__calls.upload, 1);
  const noId = makeResyncSandbox({ order: {} });
  noId.pendingCcPdfBackfillOrderId = "wo_1784203041457";
  await noId.runPendingCcPdfBackfill();
  assert.strictEqual(noId.__calls.verify, 0, "nothing to verify without a stored id");
  assert.strictEqual(noId.__calls.upload, 1);
});
