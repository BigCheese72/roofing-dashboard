const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Suite is a TAG on the record and its pins — never a boundary. These cover
   persistence wiring, both pin write paths' stamping, and the report rows. */

test("suite is a persisted work-order field (FIELD_IDS) with a form input", () => {
  const fieldIds = between(workordersSource, "var FIELD_IDS =", "];");
  assert.match(fieldIds, /"suite"/);
  assert.match(indexSource, /id="suite"/);
});

function makePinSandbox(fields){
  const sandbox = {
    repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }],
    __fields: Object.assign({}, fields),
    val(id){ return sandbox.__fields[id] || ""; },
    toast(){},
    renderRepairs(){}
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(workordersSource, "function currentSuiteTag", "function savePinFromModal") +
    between(workordersSource, "function repairAreaById", "/* ================= Work Order material list"),
    sandbox
  );
  return sandbox;
}

test("setRepairAreaPin stamps the WO's Suite onto a pin that doesn't specify one", () => {
  const sb = makePinSandbox({ suite: "  Suite 12 " });
  assert.strictEqual(sb.setRepairAreaPin("rep_a",
    { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed" }), true);
  assert.strictEqual(sb.repairAreaById("rep_a").pin.suite, "Suite 12");
});

test("setRepairAreaPin respects an explicit suite (including null) from the popup", () => {
  const sb = makePinSandbox({ suite: "Suite 12" });
  sb.setRepairAreaPin("rep_a", { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed", suite: "Suite 4" });
  assert.strictEqual(sb.repairAreaById("rep_a").pin.suite, "Suite 4");
  sb.setRepairAreaPin("rep_a", { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed", suite: null });
  assert.strictEqual(sb.repairAreaById("rep_a").pin.suite, null);
});

test("blank Suite field stamps null — single-tenant orders carry no tag", () => {
  const sb = makePinSandbox({});
  sb.setRepairAreaPin("rep_a", { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed" });
  assert.strictEqual(sb.repairAreaById("rep_a").pin.suite, null);
});

test("savePinFromModal stamps the suite tag on finding pins (leak tickets), both map modes", () => {
  function makeModalContext(mode, fields){
    const finding = { id: "f1", roofId: "r1", pin: null };
    const ctx = {
      pinMarker: { getLatLng(){ return { lat: 80, lng: 120 }; } },
      pinModalFindingId: "f1",
      pinMapMode: mode,
      pinXYSize: mode === "xy" ? { w: 400, h: 200, imageFrameUrl: "https://x.test/plan.jpg" } : null,
      pinDeviceGpsUsed: false,
      pinInitialSource: "tech_placed",
      pinInteracted: true,
      __fields: Object.assign({}, fields),
      val(id){ return ctx.__fields[id] || ""; },
      findingById(id){ return id === "f1" ? finding : null; },
      pinImageFrameUrlForFinding(){ return "https://x.test/plan.jpg"; },
      renderFindings(){}, closePinModal(){}, toast(){},
      __finding: finding
    };
    vm.createContext(ctx);
    vm.runInContext(between(workordersSource, "function currentSuiteTag", "function clearPinFromModal"), ctx);
    return ctx;
  }
  const xy = makeModalContext("xy", { suite: "Suite 7" });
  xy.savePinFromModal();
  assert.strictEqual(xy.__finding.pin.suite, "Suite 7");
  assert.strictEqual(xy.__finding.pin.imageFrame, "roof_base_map");
  const ll = makeModalContext("latlng", {});
  ll.savePinFromModal();
  assert.strictEqual(ll.__finding.pin.suite, null);
  assert.strictEqual(ll.__finding.pin.lat, 80);
});

test("reports print Suite when present in all templates (and kv tables drop it when blank)", () => {
  assert.match(exportSource, /if \(o\.suite\) L\.push\("Suite: " \+ o\.suite\);/);
  const textSites = exportSource.split('L.push("Suite: "').length - 1;
  assert.strictEqual(textSites, 2, "both text builders (leak template + change order)");
  const kvSites = (exportSource.match(/\["Suite",\s?o\.suite\]/g) || []).length;
  assert.strictEqual(kvSites, 4, "HTML + PDF kv tables for both templates");
});
