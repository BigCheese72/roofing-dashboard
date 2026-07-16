"use strict";

// DPR crew roster — per-person HOURS + live daily total + Foundation punch
// auto-fill (issue #102 follow-on: "next to each employee, write their hours;
// the report shows what each worked with a total for the day").
//
// Same VM-sandbox approach as tests/dpr.test.js: load the REAL shipped
// js/dpr.js into a sandbox with stubbed browser/Firebase globals and exercise
// the logic directly. No DOM, no network.
//
// Coverage:
//   1. crew hours round-trip: collect() carries {name, hours, hoursSource}
//      and the denormalized crewHoursTotal; fill() restores them
//   2. backward compatibility: old {name}-only crew docs load with empty hours
//   3. dprCrewHoursTotal — sums only named rows, ignores garbage, 2dp
//   4. dprDayHoursByName — folds server rows into a name-keyed hours map
//      (accumulating duplicates, dropping empty/garbage)
//   5. dprNameKey — case/spacing-insensitive, folds "Last, First"
//   6. dprCrewHoursFillValue — the manual-always-wins fill rule
//   7. auto-fill plumbing: dprAutofillCrewHours fills matching crew from the
//      day_hours endpoint, marks them "foundation", never touches manual
//      values, and fails CLOSED (denied once = stop asking) on 401/403

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

// Objects created inside the VM context carry a different Object prototype, so
// assert.deepStrictEqual on them fails despite equal values — normalize through
// JSON before comparing (same reason tests/dpr.test.js compares joined strings).
function plain(o){ return JSON.parse(JSON.stringify(o)); }

function makeSandbox(opts){
  opts = opts || {};
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById(){ return null; } },
    fdb: null,
    currentAuthClaims: null,
    currentAuthUser: null,
    slugify: realSlugify,
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){},
    esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return [{ id: "roof_default", label: "Roof 1" }]; },
    L: { latLng(lat, lng){ return { lat: lat, lng: lng }; } },
    setTimeout, clearTimeout,
    authHeaders: async () => ({ Authorization: "Bearer test" }),
    fetch: opts.fetch // undefined unless a test wires one in
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

// A fetch stub for the day_hours endpoint. Records calls; responds from `plan`.
function dayHoursFetch(plan){
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (plan.status && plan.status !== 200){
      return { ok: false, status: plan.status, json: async () => ({ error: "nope" }) };
    }
    return { ok: true, status: 200, json: async () => ({ rows: plan.rows || [] }) };
  };
  fn.calls = calls;
  return fn;
}

// ---------------- 1 + 2. round-trip & backward compatibility ----------------

test("collect() carries per-person hours + hoursSource + crewHoursTotal; fill() restores them", () => {
  const s = makeSandbox();
  s.dprFill({
    date: "2026-07-16", jobName: "North Warehouse", billTo: "Acme Roofing",
    crew: [
      { name: "Jose Garcia", hours: "8", hoursSource: "foundation" },
      { name: "Mark Sheppard", hours: "6.5", hoursSource: "" }
    ]
  });
  const out = s.dprCollect();
  assert.deepStrictEqual(plain(out.crew), [
    { name: "Jose Garcia", hours: "8", hoursSource: "foundation" },
    { name: "Mark Sheppard", hours: "6.5", hoursSource: "" }
  ]);
  assert.strictEqual(out.crewHoursTotal, 14.5);
});

test("old {name}-only crew docs (pre-hours) load with empty hours — no crash, no total", () => {
  const s = makeSandbox();
  s.dprFill({
    date: "2026-07-15", jobName: "North Warehouse", billTo: "Acme Roofing",
    crew: [{ name: "Jose" }, { name: "Mark" }]
  });
  const out = s.dprCollect();
  assert.deepStrictEqual(plain(out.crew), [
    { name: "Jose", hours: "", hoursSource: "" },
    { name: "Mark", hours: "", hoursSource: "" }
  ]);
  assert.strictEqual(out.crewHoursTotal, 0);
});

test("an unrecognized hoursSource value is normalized to manual, never invented as foundation", () => {
  const s = makeSandbox();
  s.dprFill({
    date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose", hours: "8", hoursSource: "weird-here" }]
  });
  assert.strictEqual(s.dprCollect().crew[0].hoursSource, "");
});

// ---------------- 3. dprCrewHoursTotal ----------------

test("dprCrewHoursTotal sums named rows only and survives garbage values", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [
    { name: "Jose", hours: "8" },
    { name: "Mark", hours: "7.25" },
    { name: "", hours: "99" },          // unnamed row never counts
    { name: "Bad", hours: "abc" },      // garbage ignored
    { name: "Neg", hours: "-4" },       // negative ignored
    { name: "Empty", hours: "" }
  ] });
  assert.strictEqual(s.dprCrewHoursTotal(), 15.25);
});

test("dprCrewHoursTotal rounds float noise to 2dp", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [
    { name: "A", hours: "0.1" }, { name: "B", hours: "0.2" }
  ] });
  assert.strictEqual(s.dprCrewHoursTotal(), 0.3);
});

// ---------------- 4 + 5. server-row folding + name keys ----------------

test("dprNameKey normalizes case/spacing and folds 'Last, First'", () => {
  const s = makeSandbox();
  assert.strictEqual(s.dprNameKey("  Jose   GARCIA "), "jose garcia");
  assert.strictEqual(s.dprNameKey("Garcia, Jose"), "jose garcia");
  assert.strictEqual(s.dprNameKey("O'Brien, Mary-Ann"), "mary ann o brien");
  assert.strictEqual(s.dprNameKey(null), "");
});

test("dprDayHoursByName folds rows, accumulates same-person rows, drops garbage", () => {
  const s = makeSandbox();
  const byName = s.dprDayHoursByName([
    { name: "Jose Garcia", hours: 4 },
    { name: "GARCIA, JOSE", hours: 3.5 },   // same person, other format — accumulates
    { name: "Mark Sheppard", hours: "8" },
    { name: "", hours: 5 },                  // nameless dropped
    { name: "Zero Person", hours: 0 },       // non-positive dropped
    { name: "Bad Person", hours: "x" }       // garbage dropped
  ]);
  assert.deepStrictEqual(plain(byName), { "jose garcia": 7.5, "mark sheppard": 8 });
});

// ---------------- 6. the fill rule ----------------

test("dprCrewHoursFillValue: empty fills, manual never overwritten, stale auto refreshes", () => {
  const s = makeSandbox();
  // empty -> fill
  assert.strictEqual(s.dprCrewHoursFillValue({ hours: "", hoursSource: "" }, 8), "8");
  // typed by hand -> never touched
  assert.strictEqual(s.dprCrewHoursFillValue({ hours: "6", hoursSource: "" }, 8), null);
  // previous auto-fill, new punch total -> refresh
  assert.strictEqual(s.dprCrewHoursFillValue({ hours: "4", hoursSource: "foundation" }, 8), "8");
  // already current -> no-op
  assert.strictEqual(s.dprCrewHoursFillValue({ hours: "8", hoursSource: "foundation" }, 8), null);
  // no punch data -> leave alone
  assert.strictEqual(s.dprCrewHoursFillValue({ hours: "", hoursSource: "" }, null), null);
});

// ---------------- 7. auto-fill plumbing ----------------

function fillReport(s){
  s.dprFill({
    date: "2026-07-16", jobName: "North Warehouse", billTo: "Acme Roofing",
    jobNo: "17053", foundationJobNo: "17053",
    crew: [
      { name: "Jose Garcia", hours: "", hoursSource: "" },
      { name: "Mark Sheppard", hours: "5", hoursSource: "" }   // manual — must survive
    ]
  });
}

test("dprAutofillCrewHours fills matching crew from day_hours and marks them foundation", async () => {
  const fetch = dayHoursFetch({ rows: [
    { employee_no: "123", name: "Garcia, Jose", hours: 8 },
    { employee_no: "456", name: "Mark Sheppard", hours: 7 }
  ] });
  const s = makeSandbox({ fetch });
  fillReport(s);
  await s.dprAutofillCrewHours();
  const crew = s.dprCollect().crew;
  assert.deepStrictEqual(plain(crew[0]), { name: "Jose Garcia", hours: "8", hoursSource: "foundation" });
  // manual entry survives even though the server had 7 hours for Mark
  assert.deepStrictEqual(plain(crew[1]), { name: "Mark Sheppard", hours: "5", hoursSource: "" });
  assert.strictEqual(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /action=day_hours/);
  assert.match(fetch.calls[0], /job_no=17053/);
  assert.match(fetch.calls[0], /date=2026-07-16/);
});

test("results are cached per job+date — a second run does not refetch", async () => {
  const fetch = dayHoursFetch({ rows: [{ name: "Jose Garcia", hours: 8 }] });
  const s = makeSandbox({ fetch });
  fillReport(s);
  await s.dprAutofillCrewHours();
  await s.dprAutofillCrewHours();
  assert.strictEqual(fetch.calls.length, 1);
});

test("401/403 fails closed: denied once, never asks again this session, manual entry untouched", async () => {
  const fetch = dayHoursFetch({ status: 403 });
  const s = makeSandbox({ fetch });
  fillReport(s);
  await s.dprAutofillCrewHours();
  await s.dprAutofillCrewHours();
  assert.strictEqual(fetch.calls.length, 1);            // denied -> stop asking
  const crew = s.dprCollect().crew;
  assert.strictEqual(crew[0].hours, "");                 // nothing filled
  assert.strictEqual(crew[1].hours, "5");                // manual survives
});

test("a transient server error skips that job+date pair without retry-hammering", async () => {
  const fetch = dayHoursFetch({ status: 502 });
  const s = makeSandbox({ fetch });
  fillReport(s);
  await s.dprAutofillCrewHours();
  await s.dprAutofillCrewHours();
  assert.strictEqual(fetch.calls.length, 1);
});

test("no job number or no date = no fetch at all (nothing to look up)", async () => {
  const fetch = dayHoursFetch({ rows: [] });
  const s = makeSandbox({ fetch });
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    crew: [{ name: "Jose", hours: "", hoursSource: "" }] });
  await s.dprAutofillCrewHours();   // no jobNo
  assert.strictEqual(fetch.calls.length, 0);
});

test("a locked (signed) report never auto-fills", async () => {
  const fetch = dayHoursFetch({ rows: [{ name: "Jose Garcia", hours: 8 }] });
  const s = makeSandbox({ fetch });
  s.dprFill({
    date: "2026-07-16", jobName: "N", billTo: "A", jobNo: "17053", foundationJobNo: "17053",
    crew: [{ name: "Jose Garcia", hours: "", hoursSource: "" }],
    signoff: { signed: true, locked: true }
  });
  await s.dprAutofillCrewHours();
  assert.strictEqual(fetch.calls.length, 0);
});

// ---------------- hours roll up into the day's "Hours Worked" ----------------

// Give the sandbox a real-ish #dpr-hours element: the app's setVal() writes the
// DOM element, so the stubbed setVal must write through to it too — otherwise
// dprSyncHours (which reads el.value directly) sees "" where the app sees the
// loaded total.
function hookHoursEl(s){
  const el = { value: "" };
  s.document.getElementById = (id) => (id === "dpr-hours" ? el : null);
  const origSetVal = s.setVal;
  s.setVal = (id, v) => { origSetVal(id, v); if (id === "dpr-hours") el.value = v == null ? "" : String(v); };
  return el;
}

test("reopening a report with a hand-typed total (≠ crew sum) does NOT rewrite it to the sum", () => {
  const s = makeSandbox();
  const el = hookHoursEl(s);
  // foreman saved 20 hours (e.g. drive time on top of 14.5 roof hours)
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", hoursWorked: "20", crew: [
    { name: "A", hours: "8" }, { name: "B", hours: "6.5" }
  ] });
  assert.strictEqual(el.value, "20");   // reopen must not stomp the deliberate total
});

test("reopening a report whose total WAS the crew sum keeps it live (updates when crew changes)", () => {
  const s = makeSandbox();
  const el = hookHoursEl(s);
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", hoursWorked: "14.5", crew: [
    { name: "A", hours: "8" }, { name: "B", hours: "6.5" }
  ] });
  assert.strictEqual(el.value, "14.5");
  s.dprCrew[1].hours = "8";             // second crew's hours corrected
  s.dprSyncHours();
  assert.strictEqual(el.value, "16");   // derived total stays in sync
});

test("clearing all crew hours clears an auto-filled total (but never a hand-typed one)", () => {
  const s = makeSandbox();
  const el = hookHoursEl(s);
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [{ name: "A", hours: "8" }] });
  s.dprSyncHours();
  assert.strictEqual(el.value, "8");    // auto-filled from the one row
  s.dprCrew[0].hours = "";
  s.dprSyncHours();
  assert.strictEqual(el.value, "");     // our own auto-fill is cleaned up
  el.value = "12";                       // now a hand-typed total…
  s.dprSyncHours();
  assert.strictEqual(el.value, "12");   // …survives a zero-sum sync
});

test("dprSyncHours auto-fills the Hours Worked total from crew hours but never stomps a manual value", () => {
  const s = makeSandbox();
  // dpr-hours needs a real-ish element for this one
  const el = { value: "" };
  s.document.getElementById = (id) => (id === "dpr-hours" ? el : null);
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [
    { name: "A", hours: "8" }, { name: "B", hours: "6.5" }
  ] });
  s.dprSyncHours();
  assert.strictEqual(el.value, "14.5");
  // foreman types their own total — the next sync must not stomp it
  el.value = "20";
  s.dprSyncHours();
  assert.strictEqual(el.value, "20");
});
