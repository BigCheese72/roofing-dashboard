const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const NARRATIVE = "ChatGPT narrative: seams along the north parapet show adhesion loss; recommend targeted re-seaming before winter.";

/* ---------- form model: summary collects and reloads (collect/fill round-trip) ---------- */
function makeFormSandbox(){
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service"],
    currentId: null, currentRoofId: null, currentRoofIds: null,
    currentBuildingId: null, currentCustomerId: null,
    currentCcDocumentId: null,
    currentCcDocumentHash: null,
    findings: [], repairs: [], repairItems: [], materials: [], amendments: [], inspectionChecklist: [], photos: [],
    ccLinkedProjectId: null, ccLinkedProjectName: "", changeOrderSignature: null,
    lastLookupRoofInfo: null, fdb: {},
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){}, console: { warn(){}, log(){} },
    buildingIdFor(){ return "bld_t"; }, lookupRoofInfoMatchesBuilding(){ return false; },
    populateWoTypeSelect(){}, populateRoofSystemSelect(){}, renderLeakNoJobBadge(){},
    renderLocationDirectionsLink(){}, onWoTypeChange(){}, renderFindings(){}, renderRepairs(){},
    renderRepairItems(){}, renderMaterials(){}, renderAmendments(){}, renderAmendmentForm(){}, renderPhotos(){}, renderCCLinkInfo(){},
    renderChangeOrderSignature(){}, ensureInspectionChecklist(){}, renderInspectionChecklist(){},
    clearStaleLookupRoofInfoForCurrentOrder(){}, scheduleInlineBuildingHistoryRefresh(){},
    scheduleResolveBuildingCCLink(){},
    genId(p){ return p + "_t"; },
    formatPhoneUS(v){ return String(v == null ? "" : v); },
    renderPhoneCallLink(){},
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(between(workordersSource, "var FIELD_IDS =", "function todayStr"), sandbox);
  return sandbox;
}

test("summary is part of the persisted model and survives a full collect→fill reload", () => {
  const sb = makeFormSandbox();
  sb.setVal("summary", NARRATIVE);
  const saved = sb.collect();
  assert.strictEqual(saved.summary, NARRATIVE, "collect() must carry the pasted summary");
  /* simulate reopening on a fresh session */
  const sb2 = makeFormSandbox();
  sb2.fill(saved);
  assert.strictEqual(sb2.val("summary"), NARRATIVE, "reloading the saved record must show the same summary");
});

/* ---------- save path: conflict blocks report actions; queued failure doesn't lose data ---------- */
function makeSaveSandbox(opts){
  opts = opts || {};
  const sandbox = {
    __fields: { summary: NARRATIVE },
    __cloudWrites: [],
    __toasts: [],
    currentId: null, currentBuildingId: null, currentCustomerId: null,
    fdb: {},
    navigator: { onLine: true },
    collect(){ return { id: "wo_t", jobName: "Flat Branch Pub", summary: sandbox.__fields.summary }; },
    loadDb(){ return { orders: {}, index: [] }; },
    saveDb(){ return true; },
    pruneCachedPhotoDrafts(){},
    drawSaved(){}, renderSaved(){},
    offloadPhotoBytesToIdb(){},
    markPendingSync(){}, markSynced(){}, markSyncFailed(){},
    ensureCustomerAndBuilding(){ return Promise.resolve({ customerId: null, buildingId: null }); },
    cloudSaveOrder(o){
      if (opts.conflict){ const e = new Error("updated on another device"); e.__conflict = true; return Promise.reject(e); }
      if (opts.transientFail) return Promise.reject(new Error("network blip"));
      sandbox.__cloudWrites.push(JSON.parse(JSON.stringify(o)));
      return Promise.resolve();
    },
    syncPinCorrectionsToHistory(){ return Promise.resolve(); },
    logReportAndHistoryEvent(){ return Promise.resolve(); },
    cloudErrMsg(e){ return e.message; },
    toast(m){ sandbox.__toasts.push(m); }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(coreSource, "async function autoSaveBeforeReport", "function loadOrder") +
    between(coreSource, "function saveOrder(opts)", "/* ================= offline-first"),
    sandbox
  );
  return sandbox;
}

test("email cycle persists the summary to the cloud doc (the Flat Branch guarantee)", async () => {
  const sb = makeSaveSandbox();
  const ok = await sb.autoSaveBeforeReport("sending email");
  assert.strictEqual(ok, true);
  assert.strictEqual(sb.__cloudWrites.length, 1);
  assert.strictEqual(sb.__cloudWrites[0].summary, NARRATIVE,
    "what goes into the emailed PDF must be exactly what lands in the cloud doc");
});

test("multi-device CONFLICT now BLOCKS the report action (was: emailed anyway, edits silently dropped)", async () => {
  const sb = makeSaveSandbox({ conflict: true });
  const ok = await sb.autoSaveBeforeReport("sending email");
  assert.strictEqual(ok, false, "a refused, un-queued save must not let the email proceed");
  assert.ok(sb.__toasts.some(function(m){ return /NOT sending email/.test(m); }),
    "the tech is told the action was blocked");
  assert.strictEqual(sb.__cloudWrites.length, 0);
});

test("a TRANSIENT cloud failure still proceeds — the copy is queued and durable, not lost", async () => {
  const sb = makeSaveSandbox({ transientFail: true });
  const ok = await sb.autoSaveBeforeReport("sending email");
  assert.strictEqual(ok, true, "queued-retry is eventual consistency, not data loss — don't block field work on a blip");
});

/* ---------- wiring guards ---------- */
test("every send path gates on autoSaveBeforeReport", () => {
  assert.match(between(historySource, "async function sendEmailNow", "async function sharePdf"),
    /if \(!\(await autoSaveBeforeReport\("sending email"\)\)\) return;/);
  assert.match(historySource.slice(historySource.indexOf("async function sharePdf")),
    /if \(!\(await autoSaveBeforeReport\("sharing email"\)\)\) return;/);
  assert.match(between(exportSource, "async function emailDoc", "function copyDoc"),
    /if \(!\(await autoSaveBeforeReport\("opening email"\)\)\) return;/);
});

test("the report/history event durably records the summary that was sent", () => {
  const payload = between(historySource, "var payload = {", "var batch = fdb.batch();");
  assert.match(payload, /summary: o\.summary \|\| "",/);
});

test("conflict path resolves false and stays un-queued; transient path keeps localOk", () => {
  const catchBlock = between(coreSource, "if (e && e.__conflict){", "markSyncFailed(o.id, e);");
  assert.match(catchBlock, /markSynced\(o\.id\);/);
  assert.match(catchBlock, /return false;/);
  assert.ok(catchBlock.indexOf("return localOk;") === -1, "conflict must never report success");
});

/* ---------- captions are OPTIONAL: Save must never be blocked by photo fields ----------
   Mark was stuck unable to save an edited leak report whose photos had no
   captions. The explicit Save used to reject a findings-type report with any
   un-captioned/un-assigned photo — while the quiet auto-saves behind
   Email/Share let the same report go out. Save must always succeed. */
test("explicit Save proceeds with un-captioned, un-assigned photos on a findings-type report", async () => {
  const sb = makeSaveSandbox();
  sb.collect = function(){
    return { id: "wo_cap", jobName: "Uncaptioned Job", woType: "Leak / Service", summary: "",
      photos: [ { caption: "", finding_id: null }, { caption: "   ", finding_id: null } ] };
  };
  const ok = await sb.saveOrder({});   // explicit, non-quiet Save
  assert.strictEqual(ok, true, "an edited report must save even with un-captioned, un-assigned photos");
  assert.strictEqual(sb.__cloudWrites.length, 1, "the save actually reached the cloud write");
  assert.ok(!sb.__toasts.some(function(m){ return /Fix before saving/.test(m); }),
    "there must be no 'Fix before saving' block");
});

test("saveOrder carries no photo-field pre-save gate (guards against reintroduction)", () => {
  const src = between(coreSource, "function saveOrder(opts)", "/* ================= offline-first");
  assert.ok(src.indexOf("Fix before saving") === -1, "no caption/finding block toast in saveOrder");
  assert.ok(src.indexOf("findingsPhotoIssues") === -1, "no findingsPhotoIssues gate in saveOrder");
});
