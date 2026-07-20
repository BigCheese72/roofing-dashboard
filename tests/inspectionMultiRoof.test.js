const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Multi-roof inspections (Mark, field gap 2026-07-19).

   A facility routinely has several roofs of different systems -- EPDM here,
   TPO there, mod-bit over the old wing -- and one flat 8-row checklist could
   not say which roof a rating was about. Checklist items are now keyed by
   (roofId, key).

   The invariant these tests exist to protect: a SINGLE-roof inspection must
   behave exactly as it did before any of this existed, storing no roofId at
   all. tests/inspectionChecklistRules.test.js (the characterization suite)
   covers that side; this file covers the multi-roof side and the boundary
   between them. */

const inspectionsSource = fs.readFileSync(path.join(__dirname, "..", "js", "inspections.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const COMPONENTS_SRC = between(workordersSource,
  "var INSPECTION_CHECKLIST_COMPONENTS", "var inspectionChecklist");
const ENGINE_BLOCK =
  between(photosSource, "function findingById", "/* Read-only lookup of the prospective building") +
  between(inspectionsSource, "function inspectionChecklistItemById", "function renderInspectionChecklist");

function makeSandbox(opts){
  opts = opts || {};
  let seq = 0;
  const sandbox = {
    findings: opts.findings ? opts.findings.slice() : [],
    photos: [],
    inspectionChecklist: opts.inspectionChecklist ? opts.inspectionChecklist.slice() : [],
    genId(prefix){ seq += 1; return prefix + "_" + seq; },
    renderFindings(){},
    renderInspectionChecklist(){},
    toast(){},
    currentRoofIds: opts.roofIds || null,
    currentRoofId: opts.roofId || null,
    inspectionRoofLabelCache: opts.roofLabels || {},
    inspectionRoofSystemCache: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(COMPONENTS_SRC, sandbox);
  vm.runInContext(ENGINE_BLOCK, sandbox);
  /* The engine block itself declares `var inspectionRoofLabelCache = {}`, which
     re-initialises it -- so seed the labels AFTER the block runs, not before,
     or they are silently wiped. In the app this cache is filled by
     renderInspectionRoofPicker() from the building's real roofs[]. */
  if (opts.roofLabels) Object.assign(sandbox.inspectionRoofLabelCache, opts.roofLabels);
  return sandbox;
}

const KEYS = ["membrane","flashings","penetrations","drainage","equipment","perimeter","interior","safety"];

/* ================= the single-roof boundary ================= */

test("single-roof inspection stores NO roofId at all", () => {
  /* The regression this file was written after: an earlier revision defaulted
     the roof list to ["roof_default"], which stamped every item with a roof
     the user never picked and made a parking-lot pin claim a roof. */
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  assert.equal(sb.inspectionChecklist.length, 8);
  sb.inspectionChecklist.forEach(item => {
    assert.equal(item.roofId, undefined, item.key + " must carry no roofId on a single-roof job");
  });
});

test("single-roof stays 8 rows however many times ensure runs", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  sb.ensureInspectionChecklist();
  sb.ensureInspectionChecklist();
  assert.equal(sb.inspectionChecklist.length, 8);
});

/* ================= multi-roof ================= */

test("three roofs produce a full 8-row checklist EACH", () => {
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b", "roof_c"] });
  sb.ensureInspectionChecklist();
  assert.equal(sb.inspectionChecklist.length, 24, "3 roofs x 8 components");
  ["roof_a","roof_b","roof_c"].forEach(rid => {
    const forRoof = sb.inspectionChecklist.filter(i => i.roofId === rid);
    assert.equal(forRoof.length, 8, rid + " should have all 8 components");
    assert.deepEqual(forRoof.map(i => i.key).sort(), KEYS.slice().sort());
  });
});

test("ratings on one roof never bleed into another", () => {
  /* The whole point of the feature: "Critical drainage" on the TPO roof must
     not read as Critical on the EPDM roof. */
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  const aDrain = sb.inspectionChecklist.find(i => i.roofId === "roof_a" && i.key === "drainage");
  aDrain.rating = "Critical";
  const bDrain = sb.inspectionChecklist.find(i => i.roofId === "roof_b" && i.key === "drainage");
  assert.equal(bDrain.rating, "N/A", "roof_b drainage must be untouched");
});

test("multi-roof ordering is roof-major, then canonical component order", () => {
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  const ids = sb.inspectionChecklist.map(i => i.roofId);
  assert.deepEqual(ids.slice(0, 8), new Array(8).fill("roof_a"));
  assert.deepEqual(ids.slice(8), new Array(8).fill("roof_b"));
  assert.deepEqual(sb.inspectionChecklist.slice(0, 8).map(i => i.key), KEYS);
});

test("ensure is idempotent per roof -- ids are reused, rows are not duplicated", () => {
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  const before = sb.inspectionChecklist.map(i => i.id);
  sb.ensureInspectionChecklist();
  assert.equal(sb.inspectionChecklist.length, 16);
  assert.deepEqual(sb.inspectionChecklist.map(i => i.id), before);
});

/* ================= legacy data ================= */

test("legacy roofless rows are adopted by the first covered roof, not duplicated", () => {
  /* An inspection saved before multi-roof existed was single-roof by
     construction, so its ratings genuinely describe one roof. Adopting them
     preserves the tech's work; dropping or fanning them out across every roof
     would either lose data or invent it. */
  const legacy = KEYS.map((k, i) => ({
    id: "old_" + i, key: k, rating: k === "drainage" ? "Poor" : "Good",
    notes: k === "drainage" ? "ponding at the north drain" : "", linkedFindingId: null, pin: null
  }));
  const sb = makeSandbox({ inspectionChecklist: legacy, roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  assert.equal(sb.inspectionChecklist.length, 16, "8 adopted + 8 new for roof_b");
  const adopted = sb.inspectionChecklist.filter(i => i.roofId === "roof_a");
  assert.equal(adopted.length, 8);
  const drain = adopted.find(i => i.key === "drainage");
  assert.equal(drain.rating, "Poor", "the legacy rating must survive");
  assert.equal(drain.notes, "ponding at the north drain", "the legacy note must survive");
  assert.equal(drain.id, "old_3", "adopted in place -- same row, not a replacement");
});

test("deselecting a roof keeps its ratings rather than binning them", () => {
  /* Unchecking a roof mid-inspection must not destroy what was already
     recorded for it -- the tech may be correcting a mis-tap. */
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  sb.inspectionChecklist.find(i => i.roofId === "roof_b" && i.key === "safety").rating = "Critical";
  sb.currentRoofIds = ["roof_a"];
  sb.ensureInspectionChecklist();
  const orphan = sb.inspectionChecklist.find(i => i.roofId === "roof_b" && i.key === "safety");
  assert.ok(orphan, "the deselected roof's rows must still exist");
  assert.equal(orphan.rating, "Critical");
  const ids = sb.inspectionChecklist.map(i => i.roofId);
  assert.equal(ids.indexOf("roof_a") < ids.indexOf("roof_b"), true,
    "covered roofs sort ahead of deselected ones");
});

/* ================= findings inherit the roof ================= */

test("an auto-created finding inherits its checklist item's roof", () => {
  /* Findings already carried roofId (the pin picker and the report's roof
     grouping both use it); before multi-roof there was nothing to inherit it
     FROM, so a below-Good rating produced a roofless finding that fell back to
     the work order's single roof -- silently mislabelling which roof a
     Critical came from on a multi-roof job. */
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.roofId === "roof_b" && i.key === "membrane");
  item.rating = "Critical";
  sb.syncInspectionFinding(item);
  assert.equal(sb.findings.length, 1);
  assert.equal(sb.findings[0].roofId, "roof_b");
});

test("a single-roof auto-finding carries no roofId, exactly as before", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "membrane");
  item.rating = "Poor";
  sb.syncInspectionFinding(item);
  assert.equal(sb.findings.length, 1);
  assert.equal(sb.findings[0].roofId, undefined);
});

test("re-rating an item updates its finding without changing the roof", () => {
  const sb = makeSandbox({ roofIds: ["roof_a", "roof_b"] });
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.roofId === "roof_b" && i.key === "drainage");
  item.rating = "Fair";
  sb.syncInspectionFinding(item);
  item.rating = "Critical";
  sb.syncInspectionFinding(item);
  assert.equal(sb.findings.length, 1, "still exactly one auto-finding");
  assert.equal(sb.findings[0].roofId, "roof_b");
  assert.match(sb.findings[0].condition, /Critical/);
});

/* ================= grouping for UI + report ================= */

test("inspectionChecklistByRoof groups in list order and names each roof", () => {
  const sb = makeSandbox({
    roofIds: ["roof_a", "roof_b"],
    roofLabels: { roof_a: "North EPDM", roof_b: "South TPO" }
  });
  sb.ensureInspectionChecklist();
  const groups = sb.inspectionChecklistByRoof(sb.inspectionChecklist, sb.inspectionRoofLabelCache);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.label), ["North EPDM", "South TPO"]);
  assert.deepEqual(groups.map(g => g.items.length), [8, 8]);
});

test("grouping a single-roof checklist yields exactly one group", () => {
  /* Report and UI both branch on groups.length > 1 to decide whether to show
     any roof chrome at all, so a single-roof job must produce one group. */
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const groups = sb.inspectionChecklistByRoof(sb.inspectionChecklist, {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 8);
});

test("grouping tolerates an unknown roofId rather than dropping its rows", () => {
  /* A roof deleted from the building after an inspection was written must not
     make those ratings vanish from the report. */
  const sb = makeSandbox({ roofIds: ["roof_a"] });
  sb.ensureInspectionChecklist();
  sb.inspectionChecklist.push({ id: "x1", key: "membrane", roofId: "roof_gone",
    rating: "Poor", notes: "", linkedFindingId: null, pin: null });
  const groups = sb.inspectionChecklistByRoof(sb.inspectionChecklist, { roof_a: "Roof A" });
  assert.equal(groups.length, 2);
  const ghost = groups.find(g => g.roofId === "roof_gone");
  assert.ok(ghost, "rows for a removed roof must still be printed");
  assert.equal(ghost.items.length, 1);
});
