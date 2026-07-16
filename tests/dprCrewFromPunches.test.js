"use strict";

// DPR crew + foreman auto-populate from the time clock (action=day_crew).
// Mark: "can't the DPR auto fill the foreman and the crew foundation punches"
//
// Same VM-sandbox approach as tests/dprCrewHours.test.js. Coverage:
//   1. AUTO mode fills an EMPTY roster from the day's punchers ({name, "", ""}
//      rows) — and is a strict no-op when the roster already has names
//   2. MANUAL mode ("⏱ From Time Clock") merges only who's missing, with
//      nameKey folding so "Garcia, Jose" == "Jose Garcia"
//   3. foreman auto-fill: exactly ONE roster foreman among the punchers →
//      field fills with the roster's canonical spelling; two → ambiguous,
//      untouched; a typed name is never stomped
//   4. fail-closed manners: 401/403 latches for the session, transient errors
//      don't retry-hammer, locked reports and job/date-less forms never fetch

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

// Routes day_crew from `plan`; day_hours (scheduled right after a populate)
// 400s so the hours side stays inert in these tests.
function crewFetch(plan){
  const calls = [];
  const fn = async (url) => {
    url = String(url);
    if (/action=day_crew/.test(url)){
      calls.push(url);
      if (plan.status && plan.status !== 200){
        return { ok: false, status: plan.status, json: async () => ({ error: "nope" }) };
      }
      return { ok: true, status: 200, json: async () => ({ source: "pending_timecards",
        crew: (plan.names || []).map((n, i) => ({ employee_no: "E" + i, name: n })) }) };
    }
    return { ok: false, status: 400, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function makeSandbox(opts){
  opts = opts || {};
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
    L: { latLng(lat, lng){ return { lat, lng }; } },
    setTimeout, clearTimeout,
    authHeaders: async () => ({}),
    fetch: opts.fetch
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

function fillJob(s, extra){
  s.dprFill(Object.assign({ date: "2026-07-16", jobName: "North Warehouse", billTo: "Acme",
    jobNo: "17355", foundationJobNo: "17355" }, extra || {}));
}

// ---------------- 1. auto mode ----------------

test("auto mode fills an EMPTY roster from the day's punchers", async () => {
  const fetch = crewFetch({ names: ["Christian Abernathy", "Kelly Walker"] });
  const s = makeSandbox({ fetch });
  fillJob(s);
  await s.dprPopulateCrewFromPunches(false);
  assert.deepStrictEqual(plain(s.dprCrew), [
    { name: "Christian Abernathy", hours: "", hoursSource: "" },
    { name: "Kelly Walker", hours: "", hoursSource: "" }
  ]);
  assert.strictEqual(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /job_no=17355/);
  assert.match(fetch.calls[0], /date=2026-07-16/);
});

test("auto mode is a strict no-op when the roster already has names (no fetch either)", async () => {
  const fetch = crewFetch({ names: ["Kelly Walker"] });
  const s = makeSandbox({ fetch });
  fillJob(s, { crew: [{ name: "Jose Garcia", hours: "8", hoursSource: "" }] });
  await s.dprPopulateCrewFromPunches(false);
  assert.strictEqual(s.dprCrew.length, 1);
  assert.strictEqual(fetch.calls.length, 0);
});

// ---------------- 2. manual merge ----------------

test("manual merge adds only who's missing — nameKey folds 'Garcia, Jose' onto 'Jose Garcia'", async () => {
  const fetch = crewFetch({ names: ["Garcia, Jose", "Kelly Walker", "Dale Griggs"] });
  const s = makeSandbox({ fetch });
  fillJob(s, { crew: [{ name: "Jose Garcia", hours: "8", hoursSource: "" }] });
  await s.dprPopulateCrewFromPunches(true);
  const names = plain(s.dprCrew).map((c) => c.name);
  assert.deepStrictEqual(names, ["Jose Garcia", "Kelly Walker", "Dale Griggs"]);
  assert.strictEqual(s.dprCrew[0].hours, "8", "existing rows are untouched");
});

test("manual on a job/date-less form fetches nothing (toast guidance instead)", async () => {
  const fetch = crewFetch({ names: ["Kelly Walker"] });
  const s = makeSandbox({ fetch });
  await s.dprPopulateCrewFromPunches(true);
  assert.strictEqual(fetch.calls.length, 0);
});

// ---------------- 3. foreman auto-fill ----------------

test("exactly one roster foreman among the punchers fills the empty Foreman field (canonical spelling)", async () => {
  const fetch = crewFetch({ names: ["BAGBY, CLETUS", "Dale Griggs"] });
  const s = makeSandbox({ fetch });
  fillJob(s);
  await s.dprPopulateCrewFromPunches(false);
  assert.strictEqual(s.val("dpr-foreman"), "Cletus Bagby");   // DPR_FOREMEN spelling, not the punch format
});

test("two roster foremen on the job = ambiguous — Foreman stays empty", async () => {
  const fetch = crewFetch({ names: ["Cletus Bagby", "Dax Dollens", "Dale Griggs"] });
  const s = makeSandbox({ fetch });
  fillJob(s);
  await s.dprPopulateCrewFromPunches(false);
  assert.strictEqual(s.val("dpr-foreman"), "");
});

test("a typed Foreman is never stomped", async () => {
  const fetch = crewFetch({ names: ["Cletus Bagby"] });
  const s = makeSandbox({ fetch });
  fillJob(s, { foreman: "Mark Sheppard" });
  await s.dprPopulateCrewFromPunches(false);
  assert.strictEqual(s.val("dpr-foreman"), "Mark Sheppard");
});

// ---------------- 4. fail-closed manners ----------------

test("403 latches: one denied fetch, then quiet for the session", async () => {
  const fetch = crewFetch({ status: 403 });
  const s = makeSandbox({ fetch });
  fillJob(s);
  await s.dprPopulateCrewFromPunches(false);
  await s.dprPopulateCrewFromPunches(true);
  assert.strictEqual(fetch.calls.length, 1);
  assert.strictEqual(s.dprCrew.length, 0);
});

test("a transient error doesn't retry-hammer the same job+date", async () => {
  const fetch = crewFetch({ status: 502 });
  const s = makeSandbox({ fetch });
  fillJob(s);
  await s.dprPopulateCrewFromPunches(false);
  await s.dprPopulateCrewFromPunches(false);
  assert.strictEqual(fetch.calls.length, 1);
});

test("a locked (signed) report never populates", async () => {
  const fetch = crewFetch({ names: ["Kelly Walker"] });
  const s = makeSandbox({ fetch });
  fillJob(s, { signoff: { signed: true, locked: true } });
  await s.dprPopulateCrewFromPunches(true);
  assert.strictEqual(fetch.calls.length, 0);
  assert.strictEqual(s.dprCrew.length, 0);
});
