"use strict";
/* Step 2 data layer (my lane) for the Foundation job -> WO link (issue #76):
   - ensureCustomerAndBuilding persists foundationJobNo/customerNo/address onto
     the building doc, exactly like companyCamProjectId (inert until the picker
     in js/workorders.js sets them via collect()).
   - fetchFoundationJobs is a read-only client helper that degrades to [] on any
     failure. Both extracted from js/core.js, fdb/fetch stubbed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
function slice(a, b){ const s = src.indexOf(a), e = src.indexOf(b, s); assert.ok(s !== -1 && e !== -1, "markers " + a); return src.slice(s, e); }

/* ---------- ensureCustomerAndBuilding: building persistence ---------- */
function buildingCtx(exists){
  const rec = { buildingPatch: null, buildingOpts: null };
  const ctx = {
    console: { warn(){}, log(){} },
    Date: { now: () => 1700000000000 },
    slugify: (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
    getBuildingRoofs: () => [{ id: "r1", roofSystem: "" }],
    saveBuildingRoofs: async () => {},
    fdb: {
      collection: (name) => ({
        doc: () => ({
          get: async () => ({ exists: !!exists, data: () => ({}) }),
          set: async (patch, opts) => {
            if (name === "buildings"){ rec.buildingPatch = patch; rec.buildingOpts = opts; }
          }
        })
      })
    }
  };
  vm.runInNewContext(slice("function customerIdFor", "/* ================= building roofs data layer"), ctx);
  ctx.__rec = rec;
  return ctx;
}

test("building patch carries the Foundation link when the WO has one", async () => {
  const ctx = buildingCtx(false);
  const res = await ctx.ensureCustomerAndBuilding({
    billTo: "Acme Roofing", jobName: "North Warehouse", location: "100 Main St",
    foundationJobNo: "17053", foundationCustomerNo: "C-42", foundationAddress: "100 Main St, Springfield IL"
  });
  const p = ctx.__rec.buildingPatch;
  assert.equal(p.foundationJobNo, "17053");
  assert.equal(p.foundationCustomerNo, "C-42");
  assert.equal(p.foundationAddress, "100 Main St, Springfield IL");
  assert.equal(ctx.__rec.buildingOpts && ctx.__rec.buildingOpts.merge, true, "always a merge write");
  assert.ok(res.buildingId, "returns the building id");
});

test("no Foundation link -> those keys are absent (no accidental nulls written)", async () => {
  const ctx = buildingCtx(true);
  await ctx.ensureCustomerAndBuilding({ billTo: "Acme", jobName: "North Warehouse", location: "100 Main St" });
  const p = ctx.__rec.buildingPatch;
  assert.equal(Object.prototype.hasOwnProperty.call(p, "foundationJobNo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, "foundationCustomerNo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, "foundationAddress"), false);
});

test("companyCamProjectId persistence still works alongside (regression)", async () => {
  const ctx = buildingCtx(true);
  await ctx.ensureCustomerAndBuilding({ billTo: "Acme", jobName: "North Warehouse", companyCamProjectId: "proj_9" });
  assert.equal(ctx.__rec.buildingPatch.companyCamProjectId, "proj_9");
});

test("only the Foundation fields present are written (customerNo/address optional)", async () => {
  const ctx = buildingCtx(false);
  await ctx.ensureCustomerAndBuilding({ billTo: "Acme", jobName: "North Warehouse", foundationJobNo: "17053" });
  const p = ctx.__rec.buildingPatch;
  assert.equal(p.foundationJobNo, "17053");
  assert.equal(Object.prototype.hasOwnProperty.call(p, "foundationCustomerNo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, "foundationAddress"), false);
});

/* ---------- fetchFoundationJobs: client helper ---------- */
function jobsCtx(impl){
  const rec = { url: null };
  const ctx = {
    console: { warn(){}, log(){} },
    String, Array, encodeURIComponent,
    authHeaders: async () => ({ "Content-Type": "application/json" }),
    fetch: async (url) => { rec.url = url; return impl(url); }
  };
  vm.runInNewContext(slice("async function fetchFoundationJobs", "async function callAdminApi"), ctx);
  ctx.__rec = rec;
  return ctx;
}

test("fetchFoundationJobs returns the jobs array and encodes the search term", async () => {
  const ctx = jobsCtx(() => ({ ok: true, json: async () => ({ jobs: [{ job_no: "17053", name: "North Warehouse" }] }) }));
  const jobs = await ctx.fetchFoundationJobs("north & main");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_no, "17053");
  assert.match(ctx.__rec.url, /action=jobs&search=north%20%26%20main/);
});

test("fetchFoundationJobs -> [] on non-ok response", async () => {
  const ctx = jobsCtx(() => ({ ok: false, json: async () => ({}) }));
  assert.deepEqual(await ctx.fetchFoundationJobs("x"), []);
});

test("fetchFoundationJobs -> [] when fetch throws (offline)", async () => {
  const ctx = jobsCtx(() => { throw new Error("offline"); });
  assert.deepEqual(await ctx.fetchFoundationJobs("x"), []);
});

test("fetchFoundationJobs -> [] when body has no jobs array; no search omits the param", async () => {
  const ctx = jobsCtx(() => ({ ok: true, json: async () => ({ notjobs: 1 }) }));
  assert.deepEqual(await ctx.fetchFoundationJobs(), []);
  assert.doesNotMatch(ctx.__rec.url, /search=/);
});
