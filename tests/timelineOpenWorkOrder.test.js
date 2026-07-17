const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* openTimelineSourceWorkOrder + timelineEventHtml (and the
   isBackdatedEvent/parseMDYDate helpers they lean on) with the render
   collaborators stubbed. */
function makeSandbox(opts){
  opts = opts || {};
  const sandbox = {
    __loaded: [],
    __toasts: [],
    isAdmin: opts.isAdmin === undefined ? false : opts.isAdmin,
    WORK_ORDER_TYPES: ["Leak / Service", "Change Order", "Inspection", "Repair", "Warranty"],
    esc(s){ return String(s == null ? "" : s); },
    fmtTs(ts){ return "ts:" + ts; },
    woTypeLabel(t){ return t; },
    ccUploadBadgeHtml(){ return ""; },
    loadOrder(id){ sandbox.__loaded.push(id); },
    toast(m){ sandbox.__toasts.push(m); },
    parseMDYDate(){ return 0; }, /* lives in js/workorders.js — backdating not under test here */
    Date: Date
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(historySource, "function isBackdatedEvent", "function renderTimelineList"),
    sandbox
  );
  return sandbox;
}

const EVT = {
  _id: "evt_wo_1784203041457",
  workOrderId: "wo_1784203041457",
  date: "7/15/26", createdAt: 1784203041457,
  reportType: "PDF Emailed", workOrderType: "Inspection",
  emailSent: true, workOrderNo: "17476", technician: "Mark"
};

test("a timeline card with workOrderId is clickable and shows the open affordance", () => {
  const sb = makeSandbox();
  const html = sb.timelineEventHtml(Object.assign({}, EVT), "bld_x");
  assert.match(html, /onclick="openTimelineSourceWorkOrder\('wo_1784203041457'\)"/);
  assert.match(html, /cursor:pointer/);
  assert.match(html, /title="Open the source work order"/);
  assert.match(html, /📂 Open work order ›/);
});

test("clicking opens via the SAME path the photo→pin jump uses: loadOrder(workOrderId)", () => {
  const sb = makeSandbox();
  sb.openTimelineSourceWorkOrder("wo_1784203041457");
  assert.deepStrictEqual([...sb.__loaded], ["wo_1784203041457"]);
  assert.strictEqual(sb.__toasts.length, 0);
  /* and the reference implementation really is the same call */
  const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
  assert.match(between(photosSource, "function jumpToAdjustPin", "}"), /loadOrder\(workOrderId\);/);
});

test("no workOrderId (manually logged activity / legacy): not clickable, no dead affordance, no error", () => {
  const sb = makeSandbox();
  const activity = { _id: "act_1", date: "7/15/26", createdAt: 1, reportType: "Service Call", isActivity: true };
  const html = sb.timelineEventHtml(activity, "bld_x");
  assert.ok(html.indexOf("openTimelineSourceWorkOrder") === -1);
  assert.ok(html.indexOf("📂 Open work order") === -1);
  assert.ok(html.indexOf("cursor:pointer") === -1);
  sb.openTimelineSourceWorkOrder(null); /* defensive path */
  assert.strictEqual(sb.__loaded.length, 0);
  assert.match(sb.__toasts[0], /no linked work order/);
});

test("readOnly (the inline history card on the edit form) stays non-clickable by design", () => {
  const sb = makeSandbox();
  const html = sb.timelineEventHtml(Object.assign({}, EVT), "bld_x", { readOnly: true });
  assert.ok(html.indexOf("openTimelineSourceWorkOrder") === -1, "tapping mid-edit must not swap the open order");
  assert.ok(html.indexOf("cursor:pointer") === -1);
  /* the inline card really does pass readOnly */
  assert.match(workordersSource, /timelineEventHtml\(e, ctx\.buildingId, \{ readOnly: true \}\)/);
});

test("inner controls are never hijacked: Delete(admin) and the PDF link stopPropagation", () => {
  const sb = makeSandbox({ isAdmin: true });
  const html = sb.timelineEventHtml(Object.assign({}, EVT, { pdfRef: { url: "https://x/pdf" } }), "bld_x");
  assert.match(html, /onclick="event\.stopPropagation\(\); deleteHistoryEventAdmin\('evt_wo_1784203041457', 'bld_x'\)"/);
  assert.match(html, /rel="noopener" onclick="event\.stopPropagation\(\)">View saved PDF/);
});

test("duplicate-flag styling and clickability compose on one card", () => {
  const sb = makeSandbox();
  const html = sb.timelineEventHtml(Object.assign({}, EVT, { _dup: true }), "bld_x");
  assert.match(html, /border-left-color:#D64545;cursor:pointer/);
  assert.match(html, /Possible duplicate/);
  assert.match(html, /openTimelineSourceWorkOrder/);
});
