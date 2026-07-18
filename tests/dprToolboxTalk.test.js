"use strict";

// DPR toolbox-talk tracking — which safety talk was given + a crew sign-in
// (each crew member acknowledges), captured on the daily so a SIGNED report
// carries the signed toolbox talk as part of its record (Mark).
//
// Same VM-sandbox approach as tests/dpr.test.js. Coverage:
//   1. collect(): Yes-gated {talk, signedBy}; who signed comes from the crew
//      roster's acknowledgements; No -> null; empty (no talk, nobody) -> null
//   2. fill(): restores toggle + talk + sign-in checks; ack state keyed by
//      name so it survives crew reorder; old docs (no toolbox) stay null
//   3. sign-in tracks the crew roster (a name change/removal is reflected)
//   4. a locked report blocks toggling the talk on
//   5. the datalist constant is non-empty and seedable

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

// Element stubs so the sign-in render (which reads/writes DOM) can run.
function makeSandbox(){
  const els = {};
  function el(id){
    if (!els[id]) els[id] = { id, style: { display: "" }, innerHTML: "", value: "",
      _checks: [],
      querySelectorAll(){ return []; }, querySelector(){ return null; },
      addEventListener(){}, scrollIntoView(){} };
    return els[id];
  }
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById: (id) => el(id) },
    __els: els,
    fdb: null, currentAuthClaims: null, currentAuthUser: null,
    slugify: realSlugify,
    customerIdFor(b){ const n=(b||"").trim(); return n?("cust_"+realSlugify(n)):null; },
    buildingIdFor(b,j){ const bn=(j||"").trim(); if(!bn) return null; const c=(b||"").trim()?("cust_"+realSlugify(b.trim())):null; return "bld_"+realSlugify((c||"nocust")+"_"+bn); },
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){}, esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return [{ id: "roof_default", label: "Roof 1" }]; },
    L: { latLng(a,b){ return { lat:a, lng:b }; } },
    setTimeout, clearTimeout, authHeaders: async () => ({})
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

// The sandbox's getElementById returns a stub whose querySelectorAll is empty,
// so the checkbox listeners never bind — drive ack state directly via the
// module's dprToolboxSigned map (that IS the source of truth collect reads).
function ackByName(s, names){
  names.forEach((n) => { s.dprToolboxSigned[s.dprNameKey(n)] = true; });
}

// ---------------- 1. collect ----------------

test("collect(): Yes-gated toolbox captures the talk + who acknowledged (roster order)", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose Garcia", hours: "" }, { name: "Kelly Walker", hours: "" }, { name: "Dale Griggs", hours: "" }] });
  s.setVal("dpr-toolbox-toggle", "Yes");
  s.setVal("dpr-toolbox-talk", "Fall Protection");
  ackByName(s, ["Jose Garcia", "Dale Griggs"]);   // Kelly did NOT sign
  const out = s.dprCollect();
  assert.deepStrictEqual(plain(out.toolbox), { talk: "Fall Protection", signedBy: ["Jose Garcia", "Dale Griggs"] });
});

test("collect(): toggle No -> toolbox null even with leftover ack state", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [{ name: "Jose Garcia", hours: "" }] });
  ackByName(s, ["Jose Garcia"]);
  s.setVal("dpr-toolbox-toggle", "No");
  assert.strictEqual(s.dprCollect().toolbox, null);
});

test("collect(): Yes but nothing entered (no talk, nobody signed) -> null", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [{ name: "Jose Garcia", hours: "" }] });
  s.setVal("dpr-toolbox-toggle", "Yes");
  assert.strictEqual(s.dprCollect().toolbox, null);
});

test("only NAMED crew who acknowledged are recorded; a blank crew row never counts", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose Garcia", hours: "" }, { name: "", hours: "" }] });
  s.setVal("dpr-toolbox-toggle", "Yes");
  s.setVal("dpr-toolbox-talk", "PPE");
  s.dprToolboxSigned[s.dprNameKey("Jose Garcia")] = true;
  s.dprToolboxSigned[s.dprNameKey("")] = true;   // blank — must be ignored
  assert.deepStrictEqual(plain(s.dprCollect().toolbox), { talk: "PPE", signedBy: ["Jose Garcia"] });
});

// ---------------- 2. fill round-trip ----------------

test("fill() restores toggle + talk + who signed; ack keyed by name survives reorder", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose Garcia", hours: "" }, { name: "Kelly Walker", hours: "" }],
    toolbox: { talk: "Ladder Safety", signedBy: ["Kelly Walker"] } });
  assert.strictEqual(s.val("dpr-toolbox-toggle"), "Yes");
  assert.strictEqual(s.val("dpr-toolbox-talk"), "Ladder Safety");
  assert.strictEqual(s.dprToolboxSigned[s.dprNameKey("Kelly Walker")], true);
  assert.ok(!s.dprToolboxSigned[s.dprNameKey("Jose Garcia")]);
  // reorder the crew — ack is by name, so who-signed is unchanged
  s.dprCrew = [{ name: "Kelly Walker", hours: "" }, { name: "Jose Garcia", hours: "" }];
  assert.deepStrictEqual(plain(s.dprCollect().toolbox), { talk: "Ladder Safety", signedBy: ["Kelly Walker"] });
});

test("a report with no toolbox stays null/No (older docs unchanged)", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-15", jobName: "N", billTo: "A", crew: [{ name: "Jose Garcia", hours: "" }] });
  assert.strictEqual(s.val("dpr-toolbox-toggle"), "No");
  assert.strictEqual(s.dprCollect().toolbox, null);
});

// ---------------- 3. sign-in tracks the roster ----------------

test("removing a crew member drops them from the recorded sign-in", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose Garcia", hours: "" }, { name: "Kelly Walker", hours: "" }],
    toolbox: { talk: "Heat Illness Prevention", signedBy: ["Jose Garcia", "Kelly Walker"] } });
  s.dprCrew = s.dprCrew.filter((c) => c.name !== "Kelly Walker");   // Kelly leaves
  assert.deepStrictEqual(plain(s.dprCollect().toolbox), { talk: "Heat Illness Prevention", signedBy: ["Jose Garcia"] });
});

// ---------------- 4. lock ----------------

test("a locked report refuses toggling the toolbox on", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose Garcia", hours: "" }],
    signoff: { signed: true, locked: true } });
  // dprToggleSection/dprGate is UI; the lock guard lives in the save path and
  // the render disables inputs. Assert dprIsLocked so a signed toolbox record
  // can't be edited by the entry points.
  assert.strictEqual(s.dprIsLocked(), true);
  // a signed report that HAD a toolbox still round-trips it read-only
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose Garcia", hours: "" }],
    toolbox: { talk: "PPE", signedBy: ["Jose Garcia"] },
    signoff: { signed: true, locked: true } });
  assert.deepStrictEqual(plain(s.dprCollect().toolbox), { talk: "PPE", signedBy: ["Jose Garcia"] });
});

// ---------------- 5. talk list ----------------

test("DPR_TOOLBOX_TALKS seeds a non-empty, roofing-relevant pick-list", () => {
  const s = makeSandbox();
  const talks = plain(s.DPR_TOOLBOX_TALKS);
  assert.ok(talks.length >= 8);
  assert.ok(talks.includes("Fall Protection"), "fall protection is the #1 roofing hazard");
  talks.forEach((t) => assert.ok(typeof t === "string" && t.length > 2));
});
