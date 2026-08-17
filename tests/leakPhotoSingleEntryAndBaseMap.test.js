const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Pins Mark's two Leak Work Order field-feedback fixes:
   1) Photo single-entry — the Photo Documentation card no longer re-lists
      finding photos as a second open gallery (collapsed behind an "Arrange
      photo order" toggle on the findings types; Repair keeps its open gallery).
   2) Roof Base Map quick-attach — a Leak-only card that resolves the job's map
      and routes into RoofMapper to draw one.
   Same vm-slice harness the other core.js gating tests use. */

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const leakSource = fs.readFileSync(path.join(__dirname, "..", "js", "leakbasemap.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function stubEl(){
  return {
    style: { display: "unset" }, textContent: "", innerHTML: "", _attr: {},
    setAttribute(k, v){ this._attr[k] = String(v); },
    getAttribute(k){ return this._attr[k]; }
  };
}

/* ---- 1. onWoTypeChange gating: arrange-row visibility + base-map card ---- */

function runTypeChange(woType, opts){
  opts = opts || {};
  const els = {};
  const vals = Object.assign({ woType }, opts.fieldVals || {});
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service", "Change Order", "Inspection", "Repair", "Warranty"],
    photos: opts.photos || [],
    val(id){ return Object.prototype.hasOwnProperty.call(vals, id) ? vals[id] : ""; },
    document: { getElementById(id){ if (!els[id]) els[id] = stubEl(); return els[id]; } },
    renderChangeOrderPhotos(){}, ensureInspectionChecklist(){},
    renderInspectionChecklist(){}, renderInspectionRoofPicker(){}
    /* setGlobalPhotosArrangeCollapsed / renderLeakBaseMap are typeof-guarded in
       the source — intentionally NOT stubbed, proving onWoTypeChange survives
       their absence (load order / keyless deploy). */
  };
  vm.createContext(sandbox);
  vm.runInContext(between(coreSource, "function onWoTypeChange()", "/* ================= storage"), sandbox);
  sandbox.onWoTypeChange();
  return els;
}

test("Leak with photos: Arrange-order toggle shown, base-map card shown", () => {
  const els = runTypeChange("Leak / Service", { photos: [{ img: "a" }, { img: "b" }] });
  assert.strictEqual(els["wo-globalphotos-arrange"].style.display, "");
  assert.strictEqual(els["wo-globalphotos-card"].style.display, "");   // card itself never hidden on leak
  assert.strictEqual(els["wo-basemap-card"].style.display, "");
});

test("Leak with NO photos: Arrange-order toggle hidden (nothing to arrange)", () => {
  const els = runTypeChange("Leak / Service", { photos: [] });
  assert.strictEqual(els["wo-globalphotos-arrange"].style.display, "none");
  assert.strictEqual(els["wo-basemap-card"].style.display, "");        // card shows regardless; status handles empty
});

test("Repair keeps its open gallery: Arrange toggle hidden, base-map card hidden", () => {
  const els = runTypeChange("Repair", { photos: [{ img: "a" }] });
  assert.strictEqual(els["wo-globalphotos-arrange"].style.display, "none");
  assert.strictEqual(els["wo-basemap-card"].style.display, "none");
});

test("Inspection & Warranty (also findings types) collapse the re-list, but no base-map card (leak-only)", () => {
  const insp = runTypeChange("Inspection", { photos: [{ img: "a" }] });
  assert.strictEqual(insp["wo-globalphotos-arrange"].style.display, "");
  assert.strictEqual(insp["wo-basemap-card"].style.display, "none");
  const war = runTypeChange("Warranty", { photos: [{ img: "a" }] });
  assert.strictEqual(war["wo-globalphotos-arrange"].style.display, "");
  assert.strictEqual(war["wo-basemap-card"].style.display, "none");
});

test("Change Order: no arrange toggle, no base-map card (its photos live in its own card)", () => {
  const els = runTypeChange("Change Order", { photos: [{ img: "a" }] });
  assert.strictEqual(els["wo-globalphotos-arrange"].style.display, "none");
  assert.strictEqual(els["wo-basemap-card"].style.display, "none");
});

/* ---- 2. Collapse helpers (setGlobalPhotosArrangeCollapsed / toggle) ---- */

function loadCollapseHelpers(){
  const els = {};
  const sandbox = { document: { getElementById(id){ if (!els[id]) els[id] = stubEl(); return els[id]; } } };
  vm.createContext(sandbox);
  vm.runInContext(between(coreSource, "function setGlobalPhotosArrangeCollapsed", "function renderPhotos()"), sandbox);
  return { sandbox, els };
}

test("setGlobalPhotosArrangeCollapsed(true) collapses list, sets caret ▸ and aria-expanded=false", () => {
  const { sandbox, els } = loadCollapseHelpers();
  sandbox.setGlobalPhotosArrangeCollapsed(true);
  assert.strictEqual(els["wo-globalphotos-collapsible"].style.display, "none");
  assert.strictEqual(els["wo-globalphotos-arrange-caret"].textContent, "▸");
  assert.strictEqual(els["wo-globalphotos-arrange-btn"].getAttribute("aria-expanded"), "false");
});

test("setGlobalPhotosArrangeCollapsed(false) expands list, sets caret ▾ and aria-expanded=true", () => {
  const { sandbox, els } = loadCollapseHelpers();
  sandbox.setGlobalPhotosArrangeCollapsed(false);
  assert.strictEqual(els["wo-globalphotos-collapsible"].style.display, "");
  assert.strictEqual(els["wo-globalphotos-arrange-caret"].textContent, "▾");
  assert.strictEqual(els["wo-globalphotos-arrange-btn"].getAttribute("aria-expanded"), "true");
});

test("toggleGlobalPhotosArrange flips collapsed<->expanded", () => {
  const { sandbox, els } = loadCollapseHelpers();
  els["wo-globalphotos-collapsible"] = stubEl();
  els["wo-globalphotos-collapsible"].style.display = "none"; // start collapsed
  sandbox.toggleGlobalPhotosArrange();
  assert.strictEqual(els["wo-globalphotos-collapsible"].style.display, "", "collapsed -> expanded");
  sandbox.toggleGlobalPhotosArrange();
  assert.strictEqual(els["wo-globalphotos-collapsible"].style.display, "none", "expanded -> collapsed");
});

/* ---- 3. Leak base-map card: status paint + routing ---- */

function loadLeakBaseMap(stubs){
  const els = {};
  const calls = [];
  const sandbox = Object.assign({
    esc(s){ return String(s == null ? "" : s); },
    toast(){},
    setTimeout(){ return 0; }, clearTimeout(){},
    document: {
      addEventListener(){},
      getElementById(id){ if (!(id in els)) els[id] = stubEl(); return els[id]; }
    },
    currentWorkOrderBuildingId(){ return null; },
    async resolveMergedBuildingId(id){ return id; },
    rmEnterMultiRoofCapture(id){ calls.push(["capture", id]); },
    rmOpenJobPicker(){ calls.push(["jobpicker"]); },
    rmOpenRoofInMapper(b, r){ calls.push(["roofinmapper", b, r]); },
    async lookupProspectiveBuildingBaseMap(){ return null; },
    __els: els, __calls: calls
  }, stubs || {});
  vm.createContext(sandbox);
  vm.runInContext(leakSource, sandbox);
  return sandbox;
}

test("renderLeakBaseMap: map found -> 'Roof map ready', View button shown, Draw becomes Edit", async () => {
  const sb = loadLeakBaseMap({
    async lookupProspectiveBuildingBaseMap(){ return { url: "u", fromSelectedRoof: true, sourceRoofLabel: "Roof 1" }; }
  });
  sb.document.getElementById("wo-basemap-card").style.display = "";  // card visible (leak)
  await sb.renderLeakBaseMap();
  assert.match(sb.document.getElementById("wo-basemap-status").innerHTML, /Roof map ready/);
  assert.strictEqual(sb.document.getElementById("wo-basemap-view-btn").style.display, "");
  assert.strictEqual(sb.document.getElementById("wo-basemap-draw-btn").textContent, "✏️ Edit roof map");
});

test("renderLeakBaseMap: no map -> 'No roof map for this job yet', Draw stays Draw, View hidden", async () => {
  const sb = loadLeakBaseMap({ async lookupProspectiveBuildingBaseMap(){ return null; } });
  sb.document.getElementById("wo-basemap-card").style.display = "";
  await sb.renderLeakBaseMap();
  assert.match(sb.document.getElementById("wo-basemap-status").innerHTML, /No roof map for this job yet/);
  assert.strictEqual(sb.document.getElementById("wo-basemap-view-btn").style.display, "none");
  assert.strictEqual(sb.document.getElementById("wo-basemap-draw-btn").textContent, "✏️ Draw roof map");
});

test("renderLeakBaseMap: hidden card no-ops (non-leak type) without throwing", async () => {
  const sb = loadLeakBaseMap({
    async lookupProspectiveBuildingBaseMap(){ throw new Error("should not be called"); }
  });
  sb.document.getElementById("wo-basemap-card").style.display = "none";
  await sb.renderLeakBaseMap();
  assert.strictEqual(sb.leakBaseMapResolved, null);
});

test("leakBaseMapDraw: with a building -> RoofMapper multi-roof capture for that building", async () => {
  const sb = loadLeakBaseMap({ currentWorkOrderBuildingId(){ return "bld_123"; } });
  await sb.leakBaseMapDraw();
  assert.deepStrictEqual(sb.__calls, [["capture", "bld_123"]]);
});

test("leakBaseMapDraw: no building yet -> falls back to the mapper job picker", async () => {
  const sb = loadLeakBaseMap({ currentWorkOrderBuildingId(){ return null; } });
  await sb.leakBaseMapDraw();
  assert.deepStrictEqual(sb.__calls, [["jobpicker"]]);
});

test("leakBaseMapView: resolved map with a source roof -> opens that roof in RoofMapper", async () => {
  const sb = loadLeakBaseMap({ currentWorkOrderBuildingId(){ return "bld_9"; } });
  sb.leakBaseMapResolved = { url: "u", sourceRoofId: "roof_7" };
  await sb.leakBaseMapView();
  assert.deepStrictEqual(sb.__calls, [["roofinmapper", "bld_9", "roof_7"]]);
});
