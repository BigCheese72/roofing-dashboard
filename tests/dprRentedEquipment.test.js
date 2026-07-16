"use strict";

// DPR Rented Equipment — gated structured rows (type / rental company /
// unit # / note) + the pre-use safety checklist SCAFFOLD (items pending
// Mark's OSHA 1910.178 / ANSI A92 list; the mechanism must be live now).
//
// Same VM-sandbox approach as tests/dpr.test.js. Coverage:
//   1. collect(): Yes-gated rows, trimmed, empty rows dropped; No -> null
//   2. fill(): restores rows + gate; old docs (no rentedEquipment) stay null
//   3. lift detection (DPR_RENTED_LIFT_RX): telehandler/boom/scissor/etc.
//      are lifts, generators/dumpsters aren't
//   4. checklist scaffold: with items INJECTED the checklist collects
//      {completedBy, items[{id,label,ok}]}; with the list empty a previously
//      SAVED checklist rides through a re-save untouched
//   5. a locked report blocks add/remove

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

function realSlugify(s){
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}
function plain(o){ return JSON.parse(JSON.stringify(o)); }

function makeSandbox(){
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById(){ return null; } },
    fdb: null,
    currentAuthClaims: null,
    currentAuthUser: null,
    slugify: realSlugify,
    customerIdFor(billTo){ const n = (billTo || "").trim(); return n ? ("cust_" + realSlugify(n)) : null; },
    buildingIdFor(billTo, jobName){
      const b = (jobName || "").trim();
      if (!b) return null;
      const c = (billTo || "").trim() ? ("cust_" + realSlugify(billTo.trim())) : null;
      return "bld_" + realSlugify((c || "nocust") + "_" + b);
    },
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){},
    esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return [{ id: "roof_default", label: "Roof 1" }]; },
    L: { latLng(lat, lng){ return { lat: lat, lng: lng }; } },
    setTimeout, clearTimeout,
    authHeaders: async () => ({})
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

const ROWS = [
  { type: " SkyTrak / Telehandler ", company: " United Rentals ", unitId: " 8842 ", note: "" },
  { type: "Boom Lift", company: "Sunbelt", unitId: "", note: "60' articulating" }
];

// ---------------- 1 + 2. round-trip ----------------

test("collect(): Yes-gated rented rows are trimmed, empty rows dropped", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    rentedEquipment: [{ type: "SkyTrak / Telehandler", company: "United Rentals", unitId: "8842", note: "" }] });
  // gate is Yes (fill saw rows); add a fully-empty row that must be dropped
  s.dprRented.push({ type: "  ", company: "", unitId: "", note: "" });
  const out = s.dprCollect();
  assert.deepStrictEqual(plain(out.rentedEquipment), [
    { type: "SkyTrak / Telehandler", company: "United Rentals", unitId: "8842", note: "" }
  ]);
});

test("collect(): toggle No -> rentedEquipment null even if rows linger in memory", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A" });   // gate defaults No
  s.dprRented.push({ type: "Boom Lift", company: "Sunbelt", unitId: "", note: "" });
  const out = s.dprCollect();
  assert.strictEqual(out.rentedEquipment, null);
  assert.strictEqual(out.preUseChecklist, null);
});

test("fill() restores rows + gate; old docs without rentedEquipment stay null/No", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", rentedEquipment: plain(ROWS).map(r => ({
    type: r.type.trim(), company: r.company.trim(), unitId: r.unitId.trim(), note: r.note.trim() })) });
  assert.strictEqual(s.__fields["dpr-rented-toggle"], "Yes");
  assert.strictEqual(s.dprRented.length, 2);
  const out = s.dprCollect();
  assert.strictEqual(out.rentedEquipment.length, 2);
  assert.strictEqual(out.rentedEquipment[1].note, "60' articulating");

  const s2 = makeSandbox();
  s2.dprFill({ date: "2026-07-15", jobName: "N", billTo: "A" });   // pre-feature doc
  assert.strictEqual(s2.__fields["dpr-rented-toggle"], "No");
  assert.strictEqual(s2.dprCollect().rentedEquipment, null);
});

// ---------------- 3. lift detection ----------------

test("lift detection: telehandlers/boom/scissor/aerial/forklift are lifts; generators etc. aren't", () => {
  const s = makeSandbox();
  const lift = (type) => { s.dprRented = [{ type }]; return s.dprRentedHasLift(); };
  ["SkyTrak / Telehandler", "60' Boom Lift", "scissor lift", "Aerial Lift", "Forklift", "JLG 450AJ", "Genie Z-45", "Lull 944E"]
    .forEach((t) => assert.strictEqual(lift(t), true, t + " must count as a lift"));
  ["Generator", "Air Compressor", "Dumpster", "Kettle", "Welder", ""]
    .forEach((t) => assert.strictEqual(lift(t), false, t + " must NOT count as a lift"));
});

// ---------------- 4. checklist scaffold ----------------

test("with items injected, a lift's checklist collects {completedBy, items[{id,label,ok}]}", () => {
  const s = makeSandbox();
  s.DPR_PREUSE_CHECKLIST.push({ id: "tires", label: "Tires/wheels condition" }, { id: "horn", label: "Horn works" });
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    rentedEquipment: [{ type: "Boom Lift", company: "Sunbelt", unitId: "", note: "" }],
    preUseChecklist: { completedBy: "Cletus Bagby", items: [
      { id: "tires", label: "Tires/wheels condition", ok: true },
      { id: "horn", label: "Horn works", ok: false }
    ] } });
  const out = s.dprCollect();
  // no DOM in the sandbox -> dprCollectPreUse falls back to the saved state
  assert.deepStrictEqual(plain(out.preUseChecklist), {
    completedBy: "Cletus Bagby",
    items: [
      { id: "tires", label: "Tires/wheels condition", ok: true },
      { id: "horn", label: "Horn works", ok: false }
    ]
  });
});

test("scaffold phase (empty item list): a previously SAVED checklist survives a re-save untouched", () => {
  const s = makeSandbox();   // DPR_PREUSE_CHECKLIST is empty
  const saved = { completedBy: "Dax Dollens", items: [{ id: "x", label: "Old item", ok: true }] };
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    rentedEquipment: [{ type: "Scissor Lift", company: "United", unitId: "", note: "" }],
    preUseChecklist: saved });
  assert.deepStrictEqual(plain(s.dprCollect().preUseChecklist), saved);
});

test("no rented rows -> checklist collects null regardless of any leftover state", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A" });
  s.dprPreUse = { completedBy: "X", items: [] };
  assert.strictEqual(s.dprCollect().preUseChecklist, null);
});

// ---------------- 5. lock ----------------

test("a locked report blocks rented-row add/remove", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    rentedEquipment: [{ type: "Boom Lift", company: "Sunbelt", unitId: "", note: "" }],
    signoff: { signed: true, locked: true } });
  s.dprAddRentedRow({ type: "Forklift", company: "", unitId: "", note: "" });
  assert.strictEqual(s.dprRented.length, 1, "add must be refused while locked");
  s.dprRemoveRentedRow(0);
  assert.strictEqual(s.dprRented.length, 1, "remove must be refused while locked");
});
