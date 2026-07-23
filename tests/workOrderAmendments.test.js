const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Work-order AMENDMENTS / return visits (Mark, 2026-07-23: he reopens an
   existing work order — #17456 — and goes back days or weeks later; it stays
   the SAME work order but has to show it's amended and record what was
   completed each visit).

   What these tests pin, in the order the data actually flows:
     1. the append-only contract — saveAmendment() only ever pushes, and never
        touches the original work order or a prior amendment;
     2. the collect()/fill() round trip — cloudSaveOrder() does a FULL
        ref.set(), so an amendments[] that collect() forgets is erased from
        the cloud on the very next save. This is the regression that would
        silently destroy a tech's return-visit records;
     3. photo.amendment_id surviving the same full-overwrite save and the
        fetch that hydrates it back;
     4. the report builders (text / HTML / PDF) printing each visit, and
        printing nothing at all when a work order has no return visits. */

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

/* Values built inside a vm context carry that realm's prototypes, so
   deepStrictEqual against a host-realm literal fails on identity alone.
   Compare the data, not the realm. */
function sameData(actual, expected, message){
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* ---------------- minimal DOM shim ----------------
   Just enough for renderAmendments()/renderAmendmentForm(): elements with
   innerHTML/style/value and a querySelectorAll that returns nothing (the only
   listeners wired are caption inputs, which the form tests don't exercise). */
function makeDom(fieldValues){
  const els = {};
  function el(id){
    if (!els[id]){
      els[id] = { id, innerHTML: "", style: {}, value: (fieldValues && fieldValues[id]) || "",
        textContent: "", focus(){}, querySelectorAll(){ return []; } };
    }
    return els[id];
  }
  return {
    els,
    document: {
      getElementById(id){
        /* Form field ids only exist once the form has been rendered — before
           that, keep() must see null and fall back to its defaults. */
        if (/^amd-/.test(id) && !els.__formOpen) return null;
        return el(id);
      }
    },
    el
  };
}

function makeAmendmentSandbox(opts){
  opts = opts || {};
  const dom = makeDom(opts.fields);
  const sandbox = {
    photos: opts.photos || [],
    currentId: opts.currentId || "wo_17456",
    currentAuthUser: opts.user === undefined ? { uid: "uid_mark", displayName: "Mark Sheppard" } : opts.user,
    __toasts: [],
    __saves: 0,
    __fields: Object.assign({ serviceDate: "6/2/26", technician: "Dave" }, opts.fields),
    __db: opts.db || { orders: {} },
    document: dom.document,
    console: { warn(){}, log(){} },
    val(id){ return sandbox.__fields[id] || ""; },
    esc(s){
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    },
    toast(m){ sandbox.__toasts.push(m); },
    genId(prefix){ return prefix + "_t" + (sandbox.__seq = (sandbox.__seq || 0) + 1); },
    todayStr(){ return "7/23/26"; },
    loadDb(){ return sandbox.__db; },
    saveOrder(){ sandbox.__saves++; return Promise.resolve(true); },
    openPhotoLightbox(){}, removePhoto(){},
    __dom: dom
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(workordersSource, "/* ================= amendments / return visits =================",
      "function populateWarrantyGuidelines(){"),
    sandbox
  );
  return sandbox;
}

/* Fills the open form's inputs, the way a tech typing into them would. */
function typeAmendment(sb, values){
  sb.__dom.els.__formOpen = true;
  Object.keys(values).forEach(function(k){ sb.__dom.el(k).value = values[k]; });
}

function openAndSave(sb, values){
  sb.openAmendmentForm();
  sb.__dom.els.__formOpen = true;
  typeAmendment(sb, values);
  sb.saveAmendment();
}

/* ================= 1. append-only contract ================= */

test("saveAmendment appends a visit with date, work completed, and who logged it", () => {
  const sb = makeAmendmentSandbox();
  openAndSave(sb, { "amd-date": "7/23/26", "amd-work": "Re-sealed the north parapet seam", "amd-hours": "6", "amd-crew": "Dave, Jim" });
  assert.strictEqual(sb.amendments.length, 1);
  const a = sb.amendments[0];
  assert.strictEqual(a.date, "7/23/26");
  assert.strictEqual(a.workCompleted, "Re-sealed the north parapet seam");
  assert.strictEqual(a.hours, "6");
  assert.strictEqual(a.crew, "Dave, Jim");
  assert.strictEqual(a.createdBy, "Mark Sheppard", "the signed-in user is recorded, not the technician field");
  assert.strictEqual(a.createdByUid, "uid_mark");
  assert.ok(a.createdAt > 0, "createdAt is stamped — the partial audit trail");
  assert.ok(a.id, "every amendment carries a stable id (photos reference it)");
  assert.strictEqual(sb.__saves, 1, "logging a visit saves the work order");
});

test("a second amendment stacks on — it never overwrites the first", () => {
  const sb = makeAmendmentSandbox();
  openAndSave(sb, { "amd-work": "Visit two work" });
  const first = JSON.stringify(sb.amendments[0]);
  openAndSave(sb, { "amd-date": "8/4/26", "amd-work": "Visit three work" });
  assert.strictEqual(sb.amendments.length, 2);
  assert.strictEqual(JSON.stringify(sb.amendments[0]), first, "the earlier amendment is byte-for-byte unchanged");
  assert.strictEqual(sb.amendments[1].workCompleted, "Visit three work");
  assert.notStrictEqual(sb.amendments[0].id, sb.amendments[1].id, "each visit gets its own id");
});

test("the amendments module exposes no way to edit or delete a logged visit", () => {
  const slab = between(workordersSource, "/* ================= amendments / return visits =================",
    "function populateWarrantyGuidelines(){");
  assert.doesNotMatch(slab, /amendments\.splice\(/, "append-only: nothing removes an amendment");
  assert.doesNotMatch(slab, /function\s+(editAmendment|removeAmendment|deleteAmendment)/,
    "append-only: no edit/delete entry point");
  const pushes = slab.match(/amendments\.push\(/g) || [];
  assert.strictEqual(pushes.length, 1, "exactly one writer appends to amendments[]");
});

test("an empty amendment is refused rather than logged as a blank visit", () => {
  const sb = makeAmendmentSandbox();
  sb.openAmendmentForm();
  sb.__dom.els.__formOpen = true;
  typeAmendment(sb, { "amd-work": "   " });
  sb.saveAmendment();
  assert.strictEqual(sb.amendments.length, 0);
  assert.strictEqual(sb.__saves, 0, "a refused amendment doesn't trigger a save");
  assert.match(sb.__toasts.join(" "), /work was completed/i);
});

test("a photo-only visit is allowed (a tech who shoots the repair but types nothing)", () => {
  const sb = makeAmendmentSandbox();
  sb.openAmendmentForm();
  const draftId = sb.amendmentDraftId;
  sb.photos.push({ caption: "", amendment_id: draftId });
  sb.__dom.els.__formOpen = true;
  typeAmendment(sb, { "amd-work": "" });
  sb.saveAmendment();
  assert.strictEqual(sb.amendments.length, 1);
  assert.strictEqual(sb.amendments[0].id, draftId, "the photos captured in the form belong to the saved visit");
});

test("cancelling keeps the captured photos on the work order but un-tags them", () => {
  const sb = makeAmendmentSandbox();
  sb.openAmendmentForm();
  const draftId = sb.amendmentDraftId;
  sb.photos.push({ caption: "roof edge", amendment_id: draftId });
  sb.cancelAmendmentForm();
  assert.strictEqual(sb.amendments.length, 0);
  assert.strictEqual(sb.photos.length, 1, "the photo itself is never deleted — the bytes may be the only copy");
  assert.strictEqual(sb.photos[0].amendment_id, null, "but it isn't attributed to a visit that was never logged");
  assert.match(sb.__toasts.join(" "), /kept on the work order/i);
});

test("the signed-in user is preferred, but a shared device falls back to the Technician field", () => {
  const sb = makeAmendmentSandbox({ user: null, fields: { technician: "Jim Reeves" } });
  openAndSave(sb, { "amd-work": "patched drain" });
  assert.strictEqual(sb.amendments[0].createdBy, "Jim Reeves");
  assert.strictEqual(sb.amendments[0].createdByUid, null);
  const sb2 = makeAmendmentSandbox({ user: null, fields: { technician: "" } });
  openAndSave(sb2, { "amd-work": "patched drain" });
  assert.strictEqual(sb2.amendments[0].createdBy, "Unknown", "an entry always says something");
});

/* ================= 2. card visibility + badge ================= */

test("the card stays hidden on a first-visit draft that never reached the cloud", () => {
  const sb = makeAmendmentSandbox({ db: { orders: { wo_17456: { _cloudBaseSavedAt: 0 } } } });
  sb.renderAmendments();
  assert.strictEqual(sb.__dom.el("wo-amendments-card").style.display, "none");
});

test("the card appears once the work order exists in the cloud, badge only once amended", () => {
  const sb = makeAmendmentSandbox({ db: { orders: { wo_17456: { _cloudBaseSavedAt: 1690000000000 } } } });
  sb.renderAmendments();
  assert.strictEqual(sb.__dom.el("wo-amendments-card").style.display, "");
  assert.strictEqual(sb.__dom.el("wo-amended-badge").style.display, "none", "no badge until there's a return visit");
  openAndSave(sb, { "amd-work": "second visit" });
  assert.strictEqual(sb.__dom.el("wo-amended-badge").style.display, "");
  assert.strictEqual(sb.__dom.el("wo-amended-badge").textContent, "Amended (1)");
  openAndSave(sb, { "amd-work": "third visit" });
  assert.strictEqual(sb.__dom.el("wo-amended-badge").textContent, "Amended (2)");
});

test("the visit list shows the original as Visit 1 and each amendment after it", () => {
  const sb = makeAmendmentSandbox({ db: { orders: { wo_17456: { _cloudBaseSavedAt: 1 } } },
    fields: { serviceDate: "6/2/26" } });
  openAndSave(sb, { "amd-date": "7/23/26", "amd-work": "Re-sealed the seam" });
  const html = sb.__dom.el("amendments-list").innerHTML;
  assert.match(html, /Visit 1 — Original/);
  assert.match(html, /6\/2\/26/, "the original visit shows the work order's own service date");
  assert.match(html, /Visit 2/);
  assert.match(html, /7\/23\/26/);
  assert.match(html, /Re-sealed the seam/);
  assert.match(html, /logged by Mark Sheppard/);
});

test("re-rendering the list never disturbs a half-typed amendment form", () => {
  const sb = makeAmendmentSandbox({ db: { orders: { wo_17456: { _cloudBaseSavedAt: 1 } } } });
  sb.openAmendmentForm();
  sb.__dom.els.__formOpen = true;
  typeAmendment(sb, { "amd-work": "half a sentence" });
  const before = sb.__dom.el("amendment-form").innerHTML;
  sb.renderAmendments(); /* what the 4s local autosave triggers while typing */
  assert.strictEqual(sb.__dom.el("amendment-form").innerHTML, before,
    "renderAmendments() owns the list + badge only, never the open form");
  assert.strictEqual(sb.__dom.el("amd-work").value, "half a sentence");
});

/* ================= 3. persistence: collect/fill + the full-overwrite save ================= */

function makeFormSandbox(){
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service"],
    currentId: null, currentRoofId: null, currentRoofIds: null,
    currentBuildingId: null, currentCustomerId: null,
    currentCcDocumentId: null, currentCcDocumentHash: null,
    findings: [], repairs: [], repairItems: [], materials: [], amendments: [],
    inspectionChecklist: [], photos: [],
    ccLinkedProjectId: null, ccLinkedProjectName: "", changeOrderSignature: null,
    lastLookupRoofInfo: null, fdb: {},
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){}, console: { warn(){}, log(){} },
    buildingIdFor(){ return "bld_t"; }, lookupRoofInfoMatchesBuilding(){ return false; },
    populateWoTypeSelect(){}, populateRoofSystemSelect(){}, renderLeakNoJobBadge(){},
    renderLocationDirectionsLink(){}, onWoTypeChange(){}, renderFindings(){}, renderRepairs(){},
    renderRepairItems(){}, renderMaterials(){}, renderAmendments(){}, renderAmendmentForm(){},
    renderPhotos(){}, renderCCLinkInfo(){},
    renderChangeOrderSignature(){}, ensureInspectionChecklist(){}, renderInspectionChecklist(){},
    clearStaleLookupRoofInfoForCurrentOrder(){}, scheduleInlineBuildingHistoryRefresh(){},
    scheduleResolveBuildingCCLink(){},
    genId(p){ return p + "_t" + (sandbox.__seq = (sandbox.__seq || 0) + 1); },
    formatPhoneUS(v){ return String(v == null ? "" : v); },
    renderPhoneCallLink(){},
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(between(workordersSource, "var FIELD_IDS =", "function todayStr"), sandbox);
  return sandbox;
}

test("amendments survive a full collect→fill→collect reload (cloudSaveOrder does a full ref.set)", () => {
  const sb = makeFormSandbox();
  sb.currentId = "wo_17456";
  sb.amendments = [{ id: "amd_1", date: "7/23/26", workCompleted: "Re-sealed seam",
    hours: "6", crew: "Dave", createdAt: 111, createdBy: "Mark Sheppard", createdByUid: "uid_mark" }];
  const saved = sb.collect();
  assert.strictEqual(saved.amendments.length, 1, "collect() must carry amendments — anything it omits is erased on the next save");
  /* reopening on a fresh session, exactly what loadOrder()→fill() does */
  const sb2 = makeFormSandbox();
  sb2.fill(saved);
  sameData(sb2.amendments, saved.amendments);
  const resaved = sb2.collect();
  sameData(resaved.amendments, saved.amendments, "a second round trip is lossless too");
});

test("reopening an amended work order does not disturb the original first-visit fields", () => {
  const sb = makeFormSandbox();
  sb.currentId = "wo_17456";
  sb.setVal("jobName", "Flat Branch Pub");
  sb.setVal("serviceDate", "6/2/26");
  sb.setVal("summary", "Original summary");
  sb.amendments = [{ id: "amd_1", date: "7/23/26", workCompleted: "return visit" }];
  const saved = sb.collect();
  const sb2 = makeFormSandbox();
  sb2.fill(saved);
  assert.strictEqual(sb2.val("serviceDate"), "6/2/26", "the original service date is never moved to the amendment's date");
  assert.strictEqual(sb2.val("summary"), "Original summary");
  assert.strictEqual(sb2.val("jobName"), "Flat Branch Pub");
});

test("fill() drops a draft-form id from a previously open order and self-heals a missing amendment id", () => {
  const sb = makeFormSandbox();
  sb.amendmentDraftId = "amd_from_another_order";
  sb.fill({ id: "wo_b", amendments: [{ date: "7/1/26", workCompleted: "legacy entry with no id" }] });
  assert.strictEqual(sb.amendmentDraftId, null);
  assert.ok(sb.amendments[0].id, "an id is backfilled so photos can reference the row");
});

test("a work order with no amendments collects an empty array, not undefined", () => {
  const sb = makeFormSandbox();
  const saved = sb.collect();
  assert.ok(Array.isArray(saved.amendments));
  assert.strictEqual(saved.amendments.length, 0);
});

test("fill() gives every photo an explicit amendment_id (legacy photos self-heal to null)", () => {
  const sb = makeFormSandbox();
  sb.fill({ id: "wo_c", photos: [{ caption: "old photo saved before return visits existed" }] });
  assert.strictEqual(sb.photos[0].amendment_id, null);
});

test("cloudSaveOrder writes amendment_id and cloudFetchOrder hydrates it back", () => {
  /* Both halves matter: the photo doc .set() is a FULL overwrite, so omitting
     amendment_id there would strip a return visit's photos of their visit on
     the very next save of the work order — the same trap ccFeedPhotoId hit. */
  const writeBlock = between(coreSource, "var photoDoc = {", "if (existingImg) photoDoc.img");
  assert.match(writeBlock, /amendment_id:\s*p\.amendment_id \|\| null/);
  const readBlock = between(coreSource, "photosArr[v.i] = {", "});");
  assert.match(readBlock, /amendment_id:\s*v\.amendment_id \|\| null/);
});

test("both photo capture paths can tag a photo to a return visit", () => {
  assert.match(photosSource, /function addPhotosFromFiles\(files, findingId, amendmentId\)/);
  assert.match(photosSource, /function addPhotosFromCamera\(files, findingId, amendmentId\)/);
  /* Both capture paths build their photo literal with the tag on it — a
     library add and a live camera capture must behave identically here. */
  const tagged = photosSource.match(/amendment_id: amendmentId \|\| null/g) || [];
  assert.strictEqual(tagged.length, 2, "addPhotosFromFiles and addPhotosFromCamera both tag the photo");
  const rerenders = photosSource.match(/if \(amendmentId && typeof renderAmendmentForm === "function"\) renderAmendmentForm\(\);/g) || [];
  assert.strictEqual(rerenders.length, 2, "both paths refresh the open amendment form so the new thumbnail shows");
});

test("replacing a return visit's photo keeps it on that visit", () => {
  /* Same reason the replacement already carries finding_id: re-shooting a bad
     photo must not quietly move it back to the original visit. */
  const replace = between(photosSource, "function processReplacementPhoto(i, file){", "function movePhoto(i, dir){");
  assert.match(replace, /amendment_id: old\.amendment_id \|\| null/);
});

test("the return-visits card exists in the edit view and starts hidden", () => {
  assert.match(indexHtml, /id="wo-amendments-card"[^>]*style="display:none"/);
  assert.match(indexHtml, /id="wo-amended-badge"/);
  assert.match(indexHtml, /id="amendments-list"/);
  assert.match(indexHtml, /id="amendment-form"/);
  assert.match(indexHtml, /openAmendmentForm\(\)/);
});

/* ================= 4. the report ================= */

function makeReportSandbox(o, photos){
  const sandbox = {
    photos: photos || [],
    findings: [], repairs: [], repairItems: [], materials: [],
    esc(s){
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(exportSource, "function filledPhotos()", "/* Routes by work order type"),
    sandbox
  );
  sandbox.__o = o;
  return sandbox;
}

const AMENDED = {
  serviceDate: "6/2/26",
  technician: "Dave",
  amendments: [
    { id: "amd_1", date: "7/23/26", workCompleted: "Re-sealed the north parapet seam", hours: "6",
      crew: "Dave, Jim", createdBy: "Mark Sheppard" },
    { id: "amd_2", date: "8/4/26", workCompleted: "Replaced the drain boot", hours: "", crew: "",
      createdBy: "Charlotte Washburn" }
  ]
};

test("filledAmendments drops an entry with nothing in it and keeps one with only photos", () => {
  const sb = makeReportSandbox(null, [{ img: "x", amendment_id: "amd_photoonly" }]);
  const o = { amendments: [
    { id: "amd_blank", workCompleted: "", hours: "", crew: "" },
    { id: "amd_photoonly", workCompleted: "", hours: "", crew: "" },
    { id: "amd_real", workCompleted: "did work" }
  ] };
  const kept = sb.filledAmendments(o).map(function(a){ return a.id; });
  sameData(kept, ["amd_photoonly", "amd_real"]);
});

test("the Job Information line states the work order was returned to", () => {
  const sb = makeReportSandbox();
  assert.strictEqual(sb.amendmentSummaryLine(AMENDED), "2 return visits (latest 8/4/26)");
  assert.strictEqual(sb.amendmentSummaryLine({ amendments: [] }), "",
    "an unamended report prints no such row at all");
});

test("the text report prints each return visit with its date, author and work", () => {
  const sb = makeReportSandbox();
  const out = sb.amendmentReportTextLines(AMENDED).join("\n");
  assert.match(out, /RETURN VISITS \(AMENDMENTS\)/);
  assert.match(out, /Visit 1 — 6\/2\/26 — original work order/);
  assert.match(out, /Visit 2 — 7\/23\/26 — logged by Mark Sheppard/);
  assert.match(out, /Re-sealed the north parapet seam/);
  assert.match(out, /Hours: 6\s+\|\s+Crew: Dave, Jim/);
  assert.match(out, /Visit 3 — 8\/4\/26 — logged by Charlotte Washburn/);
  assert.match(out, /Replaced the drain boot/);
});

test("the HTML and PDF builders render the same visits, from the same shared row", () => {
  const sb = makeReportSandbox();
  const html = sb.amendmentReportTableHtml(AMENDED);
  assert.match(html, /Return Visits \(Amendments\)/);
  assert.match(html, /Visit 1/);
  assert.match(html, /Original work order/);
  assert.match(html, /Visit 2/);
  assert.match(html, /Re-sealed the north parapet seam/);
  assert.match(html, /Logged by Mark Sheppard/);
  const body = sb.amendmentReportPdfBody(AMENDED);
  assert.strictEqual(body.length, 3, "Visit 1 (original) plus the two return visits");
  assert.strictEqual(body[0][0], "Visit 1");
  assert.strictEqual(body[1][0], "Visit 2");
  assert.strictEqual(body[1][2], "Re-sealed the north parapet seam\n(logged by Mark Sheppard)");
  assert.strictEqual(body[2][3], "—", "an empty optional field prints a dash, not blank");
});

test("an unamended work order prints no return-visits section anywhere", () => {
  const sb = makeReportSandbox();
  const plain = { serviceDate: "6/2/26", amendments: [] };
  assert.strictEqual(sb.amendmentReportTextLines(plain).length, 0);
  assert.strictEqual(sb.amendmentReportTableHtml(plain), "");
  assert.strictEqual(sb.amendmentSummaryLine(plain), "");
  assert.strictEqual(sb.amendmentReportTextLines({}).length, 0, "a legacy record with no amendments field at all");
});

test("a return visit's photos are cross-referenced by number, not re-embedded", () => {
  /* The images print exactly once, in the report's own photo grid, through the
     thumbnail path that keeps a photo-heavy preview from freezing the tab
     (ece2568). This section only names their numbers. */
  const sb = makeReportSandbox(null, [
    { img: "a", caption: "original" },
    { img: "b", caption: "return visit shot", amendment_id: "amd_1" },
    { img: "c", caption: "another return shot", amendment_id: "amd_1" }
  ]);
  sameData(sb.amendmentPhotoNos(AMENDED, "amd_1"), [2, 3]);
  const html = sb.amendmentReportTableHtml(AMENDED);
  assert.match(html, /#2, #3/);
  assert.doesNotMatch(html, /<img/, "no image bytes are embedded in the amendments table");
  const body = sb.amendmentReportPdfBody(AMENDED);
  assert.strictEqual(body[1][5], "#2, #3");
  assert.strictEqual(body[2][5], "—", "a visit with no photos prints a dash");
});

test("a photo shot on a return visit is labelled with its visit in the photo grid", () => {
  const sb = makeReportSandbox(null, [
    { img: "a", caption: "original" },
    { img: "b", caption: "return", amendment_id: "amd_2" }
  ]);
  assert.strictEqual(sb.amendmentVisitLabelForPhoto(AMENDED, { amendment_id: "amd_2" }), "Visit 3");
  assert.strictEqual(sb.amendmentVisitLabelForPhoto(AMENDED, { amendment_id: null }), "",
    "an ordinary first-visit photo is untouched");
  assert.strictEqual(sb.amendmentVisitLabelForPhoto(AMENDED, { amendment_id: "amd_gone" }), "",
    "a dangling reference prints nothing rather than a wrong visit number");
});

test("both report templates print the section — the leak/work-order one and the change order", () => {
  /* Print-if-present: a Change Order returned to on a later day must not lose
     those records just because it uses a different template. */
  const leakDoc = between(exportSource, "function renderLeakReportDoc(o){", "function renderChangeOrderDoc(o){");
  assert.match(leakDoc, /amendmentReportTableHtml\(o\)/);
  assert.match(leakDoc, /\["Return Visits",amendmentSummaryLine\(o\)\]/);
  const coDoc = between(exportSource, "function renderChangeOrderDoc(o){", "/* ================= email / copy");
  assert.match(coDoc, /amendmentReportTableHtml\(o\)/);
  const leakText = between(exportSource, "function buildLeakReportText(o){", "function buildChangeOrderText(o){");
  assert.match(leakText, /amendmentReportTextLines\(o\)/);
  const coText = between(exportSource, "function buildChangeOrderText(o){", "function kvTable(rows){");
  assert.match(coText, /amendmentReportTextLines\(o\)/);
  const leakPdf = between(exportSource, "async function generateLeakReportPdf(o, roofPlanData){", "async function generateChangeOrderPdf(o){");
  assert.match(leakPdf, /amendmentReportPdfBody\(o\)/);
  assert.match(leakPdf, /\["Return Visits", amendmentSummaryLine\(o\)\]/);
  const coPdf = exportSource.slice(exportSource.indexOf("async function generateChangeOrderPdf(o){"));
  assert.match(coPdf, /amendmentReportPdfBody\(o\)/);
});
