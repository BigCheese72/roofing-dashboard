"use strict";

// DPR (Daily Progress Report) — Phase 1 unit tests.
//
// Same VM-sandbox approach as tests/changeOrderAutofill.test.js: load the REAL
// shipped js/dpr.js into a sandbox whose browser/Firebase globals are plain
// stubs, then exercise the pure logic directly. No build step, no DOM, no
// network — the tests bind to the actual code that ships.
//
// Coverage:
//   1. one-DPR-per-job-per-day keying (the load-bearing invariant)
//   2. collect() / fill() save-load round-trip
//   3. the create/view permission gate

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

// slugify() lives in core.js; reproduce it EXACTLY so the DPR building-id
// derivation is tested against the same rule the app uses to key buildings.
function realSlugify(s){
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

function makeSandbox(){
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById(){ return null; } },   // renderers/roof-picker early-return on null
    fdb: null,                                          // offline: fill() skips the roofs fetch
    currentAuthClaims: null,
    currentAuthUser: null,
    slugify: realSlugify,
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){},
    esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return [{ id: "roof_default", label: "Roof 1" }]; },
    L: { latLng(lat, lng){ return { lat: lat, lng: lng }; } },   // minimal Leaflet stub for coord helpers
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

// ---------------- 1. one-per-job-per-day keying ----------------

test("dprBuildingId matches the app's canonical bld_ derivation", () => {
  const s = makeSandbox();
  const custId = "cust_" + realSlugify("Acme Roofing");
  const expected = "bld_" + realSlugify(custId + "_" + "North Warehouse");
  assert.strictEqual(s.dprBuildingId("Acme Roofing", "North Warehouse"), expected);
});

test("dprBuildingId returns null without a job name (can't key a report)", () => {
  const s = makeSandbox();
  assert.strictEqual(s.dprBuildingId("Acme Roofing", ""), null);
  assert.strictEqual(s.dprBuildingId("", "   "), null);
});

test("dprDocId is deterministic — same job + same day => same id (one per day)", () => {
  const s = makeSandbox();
  const bld = s.dprBuildingId("Acme Roofing", "North Warehouse");
  const a = s.dprDocId(bld, "2026-07-15");
  const b = s.dprDocId(bld, "2026-07-15");
  assert.strictEqual(a, b);
  assert.strictEqual(a, "dpr_" + bld + "_2026-07-15");
});

test("dprDocId differs by day and by job — never collides across days/jobs", () => {
  const s = makeSandbox();
  const bldA = s.dprBuildingId("Acme Roofing", "North Warehouse");
  const bldB = s.dprBuildingId("Acme Roofing", "South Warehouse");
  assert.notStrictEqual(s.dprDocId(bldA, "2026-07-15"), s.dprDocId(bldA, "2026-07-16")); // different day
  assert.notStrictEqual(s.dprDocId(bldA, "2026-07-15"), s.dprDocId(bldB, "2026-07-15")); // different job
});

test("two crews entering the same job + date land on the SAME doc id", () => {
  const s = makeSandbox();
  // Crew A types the job; Crew B picks it from the building list — same customer,
  // same job name, same day => identical key => one shared report.
  const crewA = s.dprDocId(s.dprBuildingId("Acme Roofing", "North Warehouse"), "2026-07-15");
  const crewB = s.dprDocId(s.dprBuildingId("acme roofing", "north warehouse"), "2026-07-15");
  assert.strictEqual(crewA, crewB); // slugify normalizes case/spacing
});

// ---------------- 2. collect() / fill() round-trip ----------------

test("collect() -> fill() -> collect() preserves the core report fields", () => {
  const s = makeSandbox();
  const original = {
    id: null, buildingId: null, roofId: "roof_default",
    date: "2026-07-15", foreman: "Jose Garcia",
    jobName: "North Warehouse", billTo: "Acme Roofing", location: "123 Main St",
    jobNo: "16153", roofSystem: "FA TPO",
    crew: [{ name: "Jose" }, { name: "Mark" }],
    headcount: "2", hoursWorked: "16", squares: "12.5",
    summary: "Tore off north bay, dried in.",
    photos: [{ caption: "north bay", storageRef: "workorders/x/0.jpg" }]
  };
  s.dprFill(original);
  const out = s.dprCollect();

  ["date", "foreman", "jobName", "billTo", "location", "jobNo", "roofSystem",
   "headcount", "hoursWorked", "squares", "summary"].forEach((k) => {
    assert.strictEqual(out[k], original[k], "field mismatch: " + k);
  });
  assert.strictEqual(out.crew.map((c) => c.name).join("|"), "Jose|Mark");
  assert.strictEqual(out.photos.length, 1);
  assert.strictEqual(out.photos[0].caption, "north bay");
  // id is derived from building + date so the report re-keys to the same doc.
  assert.strictEqual(out.id, s.dprDocId(s.dprBuildingId("Acme Roofing", "North Warehouse"), "2026-07-15"));
});

test("collect() only counts named crew toward the roster", () => {
  const s = makeSandbox();
  s.setVal("dpr-jobName", "North Warehouse");
  s.setVal("dpr-billTo", "Acme");
  s.setVal("dpr-date", "2026-07-15");
  s.dprCrew.length = 0;
  s.dprCrew.push({ name: "Jose" }, { name: "   " }, { name: "Mark" });
  const out = s.dprCollect();
  assert.strictEqual(out.crew.length, 2);
  assert.strictEqual(out.crew.map((c) => c.name).join("|"), "Jose|Mark");
});

test("dprValidate blocks a report with no job name or no date", () => {
  const s = makeSandbox();
  assert.ok(s.dprValidate({ jobName: "", date: "2026-07-15", buildingId: "b", id: "d" }));
  assert.ok(s.dprValidate({ jobName: "X", date: "", buildingId: "b", id: "d" }));
  assert.strictEqual(
    s.dprValidate({ jobName: "X", date: "2026-07-15", buildingId: "bld_x", id: "dpr_bld_x_2026-07-15" }),
    null
  );
});

// ---------------- 3. permission gate ----------------

test("view gate: only a signed-in user can view", () => {
  const s = makeSandbox();
  s.currentAuthClaims = null;
  assert.strictEqual(s.dprCanView(), false);
  s.currentAuthClaims = { role: "field_tech" };
  assert.strictEqual(s.dprCanView(), true);
});

test("create gate: owner and field/foreman roles can submit; office-only roles cannot", () => {
  const s = makeSandbox();

  s.currentAuthClaims = null;
  assert.strictEqual(s.dprCanCreate(), false, "signed-out");

  s.currentAuthClaims = { owner: true };
  assert.strictEqual(s.dprCanCreate(), true, "owner");

  ["field_tech", "service_manager", "superintendent", "ops_manager", "project_manager", "admin"].forEach((role) => {
    s.currentAuthClaims = { role: role };
    assert.strictEqual(s.dprCanCreate(), true, "should create: " + role);
  });

  ["estimator", "billing"].forEach((role) => {
    s.currentAuthClaims = { role: role };
    assert.strictEqual(s.dprCanCreate(), false, "should NOT create: " + role);
    assert.strictEqual(s.dprCanView(), true, "should still view: " + role);
  });
});

// ---------------- 4. roof section geometry ----------------

test("dprRingAreaSqFt estimates a real-world square within tolerance", () => {
  const s = makeSandbox();
  // ~30.9m per 0.000278° lat; build a small square near 40°N and check ft² order.
  const d = 0.000278; // ~30.9 m
  const ring = [
    { lat: 40.0, lng: -80.0 }, { lat: 40.0 + d, lng: -80.0 },
    { lat: 40.0 + d, lng: -80.0 + d }, { lat: 40.0, lng: -80.0 + d },
    { lat: 40.0, lng: -80.0 } // closed
  ];
  const area = s.dprRingAreaSqFt(ring);
  // ~30.9m x ~23.7m (lng compressed by cos40) ≈ 730 m² ≈ 7800 ft²; assert sane band.
  assert.ok(area > 4000 && area < 12000, "area out of expected band: " + area);
});

test("dprRingAreaSqFt returns null for a degenerate ring", () => {
  const s = makeSandbox();
  assert.strictEqual(s.dprRingAreaSqFt([{ lat: 1, lng: 1 }, { lat: 1, lng: 1 }]), null);
  assert.strictEqual(s.dprRingAreaSqFt(null), null);
});

test("image-mode fraction round-trips through the base-map coordinate helpers", () => {
  const s = makeSandbox();
  const ctx = { w: 1000, h: 600 };
  const latlng = { lat: 300, lng: 250 };            // a click on the flat image (lat=y px, lng=x px)
  const f = s.dprLatLngToFraction(latlng, ctx);
  assert.deepStrictEqual([f.x, f.y], [0.25, 0.5]);   // fractions 0..1
  const back = s.dprFractionToLatLng(f, ctx);
  assert.deepStrictEqual([back.lat, back.lng], [300, 250]); // same pixel
});

test("dprResolveJobCenter prefers a photo's on-site GPS", async () => {
  const s = makeSandbox();
  s.dprPhotos.push({ caption: "x", gps: { lat: 41.23, lng: -81.55 } });
  const c = await s.dprResolveJobCenter(null);
  assert.deepStrictEqual([c.lat, c.lng], [41.23, -81.55]);
});

test("dprSectionCentroid averages a geo ring; null for image/degenerate", () => {
  const s = makeSandbox();
  const c = s.dprSectionCentroid({ mode: "geo", ring: [
    { lat: 40, lng: -80 }, { lat: 42, lng: -80 }, { lat: 42, lng: -78 }, { lat: 40, lng: -78 }, { lat: 40, lng: -80 }
  ] });
  assert.deepStrictEqual([c.lat, c.lng], [41, -79]); // closing dup dropped, averaged
  assert.strictEqual(s.dprSectionCentroid({ mode: "image", imageRing: [{ x: 0, y: 0 }] }), null);
  assert.strictEqual(s.dprSectionCentroid(null), null);
});

test("dprResolveJobCenter falls back to the current report's traced section", async () => {
  const s = makeSandbox();
  s.dprState.section = { mode: "geo", ring: [
    { lat: 40, lng: -80 }, { lat: 40.3, lng: -80 }, { lat: 40.3, lng: -79.7 }, { lat: 40, lng: -80 }
  ] };
  const c = await s.dprResolveJobCenter(null);
  assert.ok(Math.abs(c.lat - 40.2) < 0.001 && Math.abs(c.lng + 79.9) < 0.001, JSON.stringify(c));
});

test("dprResolveJobCenter falls back to an existing roof outline centroid", async () => {
  const s = makeSandbox();
  const roof = { id: "roof_default", roof_outlines: [{ center: { lat: 40.5, lng: -80.2 } }] };
  const c = await s.dprResolveJobCenter(roof);
  assert.deepStrictEqual([c.lat, c.lng], [40.5, -80.2]);
});

test("a traced section survives collect() and fill()", () => {
  const s = makeSandbox();
  s.setVal("dpr-jobName", "North Warehouse");
  s.setVal("dpr-billTo", "Acme");
  s.setVal("dpr-date", "2026-07-15");
  s.dprState.section = { roofId: "roof_default", mode: "geo",
    ring: [{ lat: 40, lng: -80 }, { lat: 40.1, lng: -80 }, { lat: 40.1, lng: -79.9 }, { lat: 40, lng: -80 }],
    areaSqFt: 1234, createdAt: 111 };
  const out = s.dprCollect();
  assert.strictEqual(out.section.mode, "geo");
  assert.strictEqual(out.section.areaSqFt, 1234);
  assert.strictEqual(out.section.ring.length, 4);

  // round-trips through fill (o.section -> dprState.section -> collect)
  const s2 = makeSandbox();
  s2.setVal("dpr-jobName", "North Warehouse"); s2.setVal("dpr-billTo", "Acme"); s2.setVal("dpr-date", "2026-07-15");
  s2.dprFill(out);
  assert.strictEqual(s2.dprCollect().section.areaSqFt, 1234);
});

// ---------------- 5. sign-off + lock hooks ----------------

test("sign-off state round-trips through collect/fill and drives dprIsLocked", () => {
  const s = makeSandbox();
  assert.strictEqual(s.dprIsLocked(), false, "fresh report is unlocked");
  s.setVal("dpr-jobName", "North"); s.setVal("dpr-billTo", "Acme"); s.setVal("dpr-date", "2026-07-15");
  s.dprState.signoff = { signed: true, locked: true, signedByName: "Jose Garcia", signedAt: 111 };
  const o = s.dprCollect();
  assert.strictEqual(o.signoff.locked, true);
  assert.strictEqual(o.signoff.signedByName, "Jose Garcia");
  assert.strictEqual(s.dprIsLocked(), true);

  // loading a signed doc into a fresh module locks it; loading an unsigned one unlocks it
  const s2 = makeSandbox();
  s2.setVal("dpr-jobName", "North"); s2.setVal("dpr-billTo", "Acme"); s2.setVal("dpr-date", "2026-07-15");
  s2.dprFill(o);
  assert.strictEqual(s2.dprIsLocked(), true);
  s2.dprFill(Object.assign({}, o, { signoff: null }));
  assert.strictEqual(s2.dprIsLocked(), false);
});

test("a locked report blocks edits at the entry points", () => {
  const s = makeSandbox();
  s.dprState.signoff = { locked: true };
  const beforeCrew = s.dprCrew.length;
  s.dprAddCrewRow("Nope");
  assert.strictEqual(s.dprCrew.length, beforeCrew, "crew add is blocked when locked");
  s.dprState.section = { mode: "geo", ring: [{ lat: 1, lng: 1 }] };
  s.dprClearSection();
  assert.ok(s.dprState.section, "section clear is blocked when locked");
});

// ---------------- 6. Foundation job autofill ----------------

test("dprApplyFoundationJobNo fills Job No. from the building's Foundation link", () => {
  const s = makeSandbox();
  // building with a Foundation job number -> returns true, sets the field
  assert.strictEqual(s.dprApplyFoundationJobNo({ foundationJobNo: "24-1053", foundationCustomerNo: 771 }), true);
  assert.strictEqual(s.val("dpr-jobNo"), "24-1053");
  assert.strictEqual(s.dprState.foundationJobNo, "24-1053");
  assert.strictEqual(s.dprState.foundationCustomerNo, "771");
  // a building with no Foundation link -> false (caller falls back to history)
  const s2 = makeSandbox();
  assert.strictEqual(s2.dprApplyFoundationJobNo({ name: "X" }), false);
  assert.strictEqual(s2.val("dpr-jobNo"), "");
});

test("dprApplyFoundationJobNo never stomps a foreman-typed Job No.", () => {
  const s = makeSandbox();
  s.setVal("dpr-jobNo", "MINE");
  s.dprJobNoAutoVal = "";            // the typed value is not an auto value
  const linked = s.dprApplyFoundationJobNo({ foundationJobNo: "24-1053" });
  assert.strictEqual(linked, true);  // building is linked...
  assert.strictEqual(s.val("dpr-jobNo"), "MINE"); // ...but the typed value stands
});

test("dprPickFoundationJob fills job name/location/number and stamps the link", () => {
  const s = makeSandbox();
  s.dprFdnJobsCache = [{ job_no: "24-1053", name: "Acme Roof Replacement", address: "123 Main St", city: "Cleveland", state: "OH", zip: "44101", customer_no: 771 }];
  s.dprPickFoundationJob("24-1053");
  assert.strictEqual(s.val("dpr-jobName"), "Acme Roof Replacement");
  assert.strictEqual(s.val("dpr-location"), "123 Main St, Cleveland, OH, 44101");
  assert.strictEqual(s.val("dpr-jobNo"), "24-1053");
  assert.strictEqual(s.dprState.foundationJobNo, "24-1053");
  const out = s.dprCollect();
  assert.strictEqual(out.foundationJobNo, "24-1053");   // saved on the DPR -> stamps the building
  assert.strictEqual(out.foundationCustomerNo, "771");
});

// ---------------- 7. Phase-2 gated sections ----------------

function fillJobBasics(s){
  s.setVal("dpr-jobName", "North Warehouse");
  s.setVal("dpr-billTo", "Acme");
  s.setVal("dpr-date", "2026-07-16");
}

test("gated sections collect null when their toggle is No (the default)", () => {
  const s = makeSandbox();
  fillJobBasics(s);
  const o = s.dprCollect();
  ["delays", "quantities", "jsa", "incidents", "equipment", "visitors"].forEach((k) => {
    assert.strictEqual(o[k], null, k + " should be null when toggled No");
  });
});

test("a Yes toggle collects its block; quantities keep only real rows", () => {
  const s = makeSandbox();
  fillJobBasics(s);
  s.setVal("dpr-delays-toggle", "Yes");
  s.setVal("dpr-delays-cause", "Weather");
  s.setVal("dpr-delays-hours", "2.5");
  s.setVal("dpr-delays-notes", "Rain until 10am");
  s.setVal("dpr-quantities-toggle", "Yes");
  s.dprQuantities.push({ item: "TPO 60mil", qty: "24", unit: "sq" }, { item: "  ", qty: "", unit: "rolls" });
  s.setVal("dpr-jsa-toggle", "Yes");
  s.setVal("dpr-jsa-by", "Jose Garcia");
  s.setVal("dpr-jsa-crewpresent", "Yes");
  s.setVal("dpr-jsa-topics", "Fall protection, hot work");
  const o = s.dprCollect();
  assert.strictEqual(o.delays.cause, "Weather");
  assert.strictEqual(o.delays.hoursLost, "2.5");
  assert.strictEqual(o.quantities.length, 1, "empty quantity row dropped");
  assert.strictEqual(o.quantities[0].item, "TPO 60mil");
  assert.strictEqual(o.jsa.conductedBy, "Jose Garcia");
  assert.strictEqual(o.incidents, null, "untouched section stays null");
});

test("gated sections round-trip through fill() (Yes blocks restore; No stays No)", () => {
  const s = makeSandbox();
  fillJobBasics(s);
  s.setVal("dpr-incidents-toggle", "Yes");
  s.setVal("dpr-incidents-type", "Near Miss");
  s.setVal("dpr-incidents-reportedto", "Mark");
  s.setVal("dpr-incidents-desc", "Dropped hammer off edge, no one below");
  s.setVal("dpr-visitors-toggle", "Yes");
  s.setVal("dpr-visitors-notes", "GC superintendent (walkthrough)");
  const o = s.dprCollect();

  const s2 = makeSandbox();
  fillJobBasics(s2);
  s2.dprFill(o);
  const o2 = s2.dprCollect();
  assert.strictEqual(o2.incidents.type, "Near Miss");
  assert.strictEqual(o2.incidents.description, "Dropped hammer off edge, no one below");
  assert.strictEqual(o2.visitors.notes, "GC superintendent (walkthrough)");
  assert.strictEqual(o2.delays, null);
  assert.strictEqual(o2.equipment, null);
  // Firestore null-coercion ("" instead of null) still reads as No
  const s3 = makeSandbox();
  fillJobBasics(s3);
  s3.dprFill(Object.assign({}, o, { incidents: "", visitors: "" }));
  const o3 = s3.dprCollect();
  assert.strictEqual(o3.incidents, null);
  assert.strictEqual(o3.visitors, null);
});

test("a locked report blocks quantity-row edits", () => {
  const s = makeSandbox();
  s.dprState.signoff = { locked: true };
  const before = s.dprQuantities.length;
  s.dprAddQuantityRow({ item: "X", qty: "1", unit: "sq" });
  assert.strictEqual(s.dprQuantities.length, before);
});
