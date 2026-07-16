"use strict";

// DPR "From Foundation" job list — NEWEST job first (Mark: the picker listed
// old→new; the recent jobs are the ones a foreman actually wants).
//
// Ordering: job_start_date DESC (the cache's ISO string), undated jobs sink;
// tie/fallback = numeric-aware job_no DESC (the WO picker's existing proxy).
// Same VM-sandbox approach as tests/dpr.test.js, with a tiny fdb stub feeding
// dprLoadFoundationJobs an UNSORTED collection.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

function makeSandbox(docs){
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById(){ return null; } },
    fdb: {
      collection: () => ({ limit: () => ({ get: async () => ({
        forEach: (cb) => docs.forEach((d, i) => cb({ id: "j" + i, data: () => d }))
      }) }) })
    },
    currentAuthClaims: null,
    currentAuthUser: null,
    slugify: (s) => String(s || "").toLowerCase(),
    customerIdFor: () => null,
    buildingIdFor: () => null,
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){},
    esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return []; },
    L: { latLng(lat, lng){ return { lat, lng }; } },
    setTimeout, clearTimeout,
    authHeaders: async () => ({})
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test("dprLoadFoundationJobs sorts newest job_start_date first; undated jobs sink", async () => {
  const s = makeSandbox([
    { job_no: "16153", name: "Old", job_start_date: "2025-02-01T00:00:00.000Z" },
    { job_no: "17476", name: "Newest", job_start_date: "2026-07-01T00:00:00.000Z" },
    { job_no: "99999", name: "Undated", job_start_date: null },
    { job_no: "17053", name: "Recent", job_start_date: "2026-01-02T00:00:00.000Z" }
  ]);
  await s.dprLoadFoundationJobs();
  // JSON-normalize: the cache is a VM-context array whose prototype differs
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.dprFdnJobsCache.map((j) => j.job_no))), ["17476", "17053", "16153", "99999"]);
});

test("same start date falls back to job NUMBER descending, numeric-aware (17476 above 9999)", () => {
  const s = makeSandbox([]);
  const d = "2026-07-01T00:00:00.000Z";
  const jobs = [
    { job_no: "9999", job_start_date: d },
    { job_no: "17476", job_start_date: d },
    { job_no: "17053", job_start_date: d }
  ];
  jobs.sort(s.dprFdnJobCompare);
  assert.deepStrictEqual(jobs.map((j) => j.job_no), ["17476", "17053", "9999"]);
});

test("all undated degrades cleanly to job number descending", () => {
  const s = makeSandbox([]);
  const jobs = [{ job_no: "2" }, { job_no: "17300" }, { job_no: "16681" }];
  jobs.sort(s.dprFdnJobCompare);
  assert.deepStrictEqual(jobs.map((j) => j.job_no), ["17300", "16681", "2"]);
});
