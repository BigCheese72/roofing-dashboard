const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Material-list surface: addMaterial / removeMaterial /
   materialRepairAreaOptionsHtml / renderMaterials (js/workorders.js),
   removeRepair's link-nulling (js/photos.js), and the report helpers
   filledMaterials / materialRepairRefLabel (js/export.js). */
function makeSandbox(opts){
  opts = opts || {};
  const hosts = { "materials-list": fakeHost(), "repairs-list": fakeHost() };
  function fakeHost(){
    return { innerHTML: "", children: [], appendChild(el){ this.children.push(el); }, querySelectorAll(){ return []; } };
  }
  const sandbox = {
    repairs: opts.repairs ? opts.repairs.slice() : [],
    materials: opts.materials ? opts.materials.slice() : [],
    repairItems: [],
    __fields: { woType: "Repair" },
    __genIdCounter: 0,
    genId(prefix){ return prefix + "_t" + (sandbox.__genIdCounter++); },
    val(id){ return sandbox.__fields[id] || ""; },
    esc(s){ return String(s == null ? "" : s); },
    toast(){},
    rememberFieldValue(){},
    renderRepairs(){},
    repairScopeLineFor(){ return ""; },
    syncRepairScopeLine(){},
    document: {
      getElementById(id){ return hosts[id] || null; },
      createElement(){ return { className: "", style: {}, innerHTML: "" }; }
    },
    __hosts: hosts
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(workordersSource, "function addMaterial", "var FIELD_IDS =") +
    between(photosSource, "function removeRepair", "function renderRepairs") +
    between(exportSource, "function filledRepairs", "function filledPhotos"),
    sandbox
  );
  return sandbox;
}

test("addMaterial creates a row with stable id, empty fields, null repair link", () => {
  const sb = makeSandbox();
  sb.addMaterial();
  const m = sb.materials[0];
  assert.ok(m.id.startsWith("mat_"));
  assert.deepStrictEqual(
    { material: m.material, qty: m.qty, unit: m.unit, notes: m.notes, repair_id: m.repair_id },
    { material: "", qty: "", unit: "", notes: "", repair_id: null });
});

test("removeMaterial removes exactly that row", () => {
  const sb = makeSandbox({ materials: [
    { id: "mat_a", material: "EPDM patch", qty: "2", unit: "", notes: "", repair_id: null },
    { id: "mat_b", material: "Lap sealant", qty: "1", unit: "tubes", notes: "", repair_id: null }
  ]});
  sb.removeMaterial(0);
  assert.strictEqual(sb.materials.length, 1);
  assert.strictEqual(sb.materials[0].id, "mat_b");
});

test("repair-area dropdown offers General plus one labeled option per repair row, selected sticks", () => {
  const sb = makeSandbox({ repairs: [
    { id: "rep_1", repair: "Replaced pipe boot", location: "NW", pin: null },
    { id: "rep_2", repair: "", location: "SE corner", pin: null }
  ]});
  const html = sb.materialRepairAreaOptionsHtml("rep_2");
  assert.match(html, /General \/ whole job/);
  assert.match(html, /Repair #1 — Replaced pipe boot/);
  assert.match(html, /value="rep_2" selected>Repair #2 — SE corner/);
});

test("fill() self-heal backfills id + null repair_id onto material rows", () => {
  const sb = makeSandbox();
  vm.runInContext(
    "var o = { materials: [{ material: \"Old row\", qty: \"3\" }] };" +
    between(workordersSource, "materials = (o.materials", "ccLinkedProjectId ="),
    sb
  );
  assert.ok(sb.materials[0].id.startsWith("mat_"));
  assert.strictEqual(sb.materials[0].repair_id, null);
  assert.strictEqual(sb.materials[0].material, "Old row");
});

test("collect() persists materials on the work-order record", () => {
  /* Shape guard on the source: o.materials must be written next to
     o.repairs/o.repairItems in collect(). */
  assert.match(workordersSource, /o\.materials = materials\.slice\(\);/);
});

test("removing a repair area re-homes its linked materials to General (row survives)", () => {
  const sb = makeSandbox({
    repairs: [{ id: "rep_1", repair: "Replaced boot", location: "", pin: null }],
    materials: [
      { id: "mat_a", material: "Pipe boot", qty: "1", unit: "", notes: "", repair_id: "rep_1" },
      { id: "mat_b", material: "Cleaner", qty: "1", unit: "", notes: "", repair_id: null }
    ]
  });
  sb.removeRepair(0);
  assert.strictEqual(sb.repairs.length, 0);
  assert.strictEqual(sb.materials.length, 2, "material rows are never deleted with the repair");
  assert.strictEqual(sb.materials[0].repair_id, null);
});

test("filledMaterials skips blank rows; report ref label matches Work Performed numbering", () => {
  const sb = makeSandbox({
    repairs: [
      { id: "rep_empty", repair: "", location: "", pin: null },   /* not printed */
      { id: "rep_1", repair: "Sealed seam", location: "", pin: null }
    ],
    materials: [
      { id: "mat_a", material: "", qty: "", unit: "", notes: "", repair_id: null },  /* blank — skipped */
      { id: "mat_b", material: "Lap sealant", qty: "2", unit: "tubes", notes: "", repair_id: "rep_1" }
    ]
  });
  const fm = sb.filledMaterials();
  assert.strictEqual(fm.length, 1);
  /* rep_1 is the FIRST printed repair (the empty row doesn't print), so the
     label must be "Repair #1" — not #2 from raw array position. */
  assert.strictEqual(sb.materialRepairRefLabel("rep_1"), "Repair #1");
  assert.strictEqual(sb.materialRepairRefLabel("rep_empty"), "", "emptied-out repair must not get a dangling number");
  assert.strictEqual(sb.materialRepairRefLabel(null), "");
});

test("renderMaterials binds inputs; repair_id select stores null for the General option", () => {
  const sb = makeSandbox({
    repairs: [{ id: "rep_1", repair: "Replaced boot", location: "", pin: null }],
    materials: [{ id: "mat_a", material: "", qty: "", unit: "", notes: "", repair_id: "rep_1" }]
  });
  const bound = [];
  sb.__hosts["materials-list"].querySelectorAll = function(sel){
    if (sel !== "[data-f]") return [];
    return ["material", "qty", "unit", "notes", "repair_id"].map(function(f){
      const el = { dataset: { i: "0", f: f }, value: "" };
      el.addEventListener = function(type, fn){ bound.push({ type: type, f: f, el: el, fn: fn }); };
      return el;
    });
  };
  sb.renderMaterials();
  const input = (f) => bound.find(function(h){ return h.type === "input" && h.f === f; });
  input("material").el.value = "EPDM patch"; input("material").fn();
  assert.strictEqual(sb.materials[0].material, "EPDM patch");
  input("repair_id").el.value = ""; input("repair_id").fn();
  assert.strictEqual(sb.materials[0].repair_id, null, "General option stores null, not empty string");
  input("repair_id").el.value = "rep_1"; input("repair_id").fn();
  assert.strictEqual(sb.materials[0].repair_id, "rep_1");
});

test("text report prints MATERIAL LIST with qty/unit/notes and the repair ref", () => {
  /* Shape guard on the text builder source — the block is print-if-present
     and formats "N. material xQty unit — notes [Repair #N]". */
  const block = between(exportSource, "MATERIAL LIST", "if (!isInspection){");
  assert.match(block, /materialRepairRefLabel\(m\.repair_id\)/);
  assert.match(block, /m\.qty \? " x" \+ m\.qty : ""/);
  assert.match(exportSource, /var fmat = filledMaterials\(\);\s*\n\s*if \(fmat\.length\)\{\s*\n\s*L\.push\("MATERIAL LIST"\);/);
});
