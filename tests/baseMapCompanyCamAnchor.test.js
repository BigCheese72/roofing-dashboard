"use strict";
/* Step 1 of "base maps follow the job site": base-map resolution is anchored on
   the linked CompanyCam project, so a base map made once shows up in any form
   that resolves to the same CompanyCam project -- even when the customer or
   job-name resolves to a DIFFERENT building doc. Non-destructive (read-only
   across buildings). Functions extracted from js/photos.js, fdb/collaborators
   stubbed -- no network. See "base-map anchor" in DEV_NOTES.md. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
function slice(a, b){ const s = src.indexOf(a), e = src.indexOf(b, s); assert.ok(s !== -1 && e !== -1, "markers " + a); return src.slice(s, e); }

function orthoRoof(id, label){ return { id: id, label: label, roof_base_map_type: "drone_ortho", roof_base_map_url: "u_" + id, roof_base_map_bounds: { n: 1, s: 0, e: 1, w: 0 } }; }
function plainRoof(id, label){ return { id: id, label: label }; }

/* ---- photosResolveBuildingBaseMap (pure) ---- */
function resolveCtx(){
  const ctx = {};
  vm.runInNewContext(slice("function photosRoofHasBaseMap", "async function lookupProspectiveBuildingBaseMap"), ctx);
  return ctx;
}
test("resolve: selected roof's own base map wins (fromSelectedRoof true)", () => {
  const ctx = resolveCtx();
  const r = ctx.photosResolveBuildingBaseMap([plainRoof("r1", "A"), orthoRoof("r2", "B")], "r2");
  assert.equal(r.sourceRoofId, "r2");
  assert.equal(r.fromSelectedRoof, true);
  assert.equal(r.georeferenced, true);
});
test("resolve: falls back building-wide when the selected roof has none", () => {
  const ctx = resolveCtx();
  const r = ctx.photosResolveBuildingBaseMap([plainRoof("r1", "A"), orthoRoof("r7", "Roof 7")], "r1");
  assert.equal(r.sourceRoofId, "r7");
  assert.equal(r.fromSelectedRoof, false);
  assert.equal(r.sourceRoofLabel, "Roof 7");
});
test("resolve: null when no roof has a base map", () => {
  const ctx = resolveCtx();
  assert.equal(ctx.photosResolveBuildingBaseMap([plainRoof("r1", "A"), plainRoof("r2", "B")], "r1"), null);
});

/* ---- photosRoofsForCompanyCamProject (fdb query) ---- */
function ccQueryCtx(buildingsByCc, opts){
  opts = opts || {};
  const ctx = {
    getBuildingRoofs: (bld) => bld.roofs || [],
    fdb: opts.noFdb ? null : {
      collection: () => ({
        where: (field, op, val) => ({
          get: async () => {
            if (opts.throws) throw new Error("query failed");
            const docs = (buildingsByCc[val] || []).map((b) => ({ id: b.id, data: () => b }));
            return { forEach: (cb) => docs.forEach(cb) };
          }
        })
      })
    }
  };
  vm.runInNewContext(slice("async function photosRoofsForCompanyCamProject", "function boundsToLatLngBounds"), ctx);
  return ctx;
}
test("cc-query: gathers roofs across every linked building, excluding the primary", async () => {
  const ctx = ccQueryCtx({
    proj_1: [
      { id: "bld_primary", roofs: [plainRoof("p1", "P")] },
      { id: "bld_other", roofs: [orthoRoof("o1", "Other Roof"), plainRoof("o2", "X")] }
    ]
  });
  const roofs = await ctx.photosRoofsForCompanyCamProject("proj_1", "bld_primary");
  assert.deepEqual(roofs.map((r) => r.id), ["o1", "o2"], "excludes primary, keeps the rest");
});
test("cc-query: [] when no fdb, no ccId, or query throws", async () => {
  assert.deepEqual(await ccQueryCtx({}, { noFdb: true }).photosRoofsForCompanyCamProject("p", null), []);
  assert.deepEqual(await ccQueryCtx({}).photosRoofsForCompanyCamProject("", "b"), []);
  assert.deepEqual(await ccQueryCtx({}, { throws: true }).photosRoofsForCompanyCamProject("p", "b"), []);
});

/* ---- lookupProspectiveBuildingBaseMap (orchestration; collaborators stubbed) ---- */
function orchCtx(opts){
  const rec = { ccQueried: false };
  const ctx = {
    currentRoofId: opts.currentRoofId || null,
    lookupProspectiveBuildingRoofInfo: async () => opts.info,
    photosResolveBuildingBaseMap: (roofs) => {
      // primary vs cc distinguished by a marker on the roofs passed in
      const hit = (roofs || []).find((r) => r.__hasMap);
      return hit ? { url: hit.url || "u", sourceRoofId: hit.id, sourceRoofLabel: hit.label || "Roof", georeferenced: false, fromSelectedRoof: true } : null;
    },
    photosRoofsForCompanyCamProject: async () => { rec.ccQueried = true; return opts.ccRoofs || []; }
  };
  vm.runInNewContext(slice("async function lookupProspectiveBuildingBaseMap", "async function photosRoofsForCompanyCamProject"), ctx);
  ctx.__rec = rec;
  return ctx;
}
test("orchestration: primary building's own base map is used; CC is NOT consulted", async () => {
  const ctx = orchCtx({ info: { buildingId: "bld_a", roofs: [{ id: "r1", __hasMap: true }], companyCamProjectId: "proj_1" } });
  const r = await ctx.lookupProspectiveBuildingBaseMap();
  assert.equal(r.sourceRoofId, "r1");
  assert.equal(ctx.__rec.ccQueried, false, "short-circuits before the CC query");
});
test("orchestration: primary has none -> borrows a base map via the CompanyCam project", async () => {
  const ctx = orchCtx({
    info: { buildingId: "bld_a", roofs: [{ id: "r1" }], companyCamProjectId: "proj_1" },
    ccRoofs: [{ id: "cc1", label: "Site Ortho", __hasMap: true }]
  });
  const r = await ctx.lookupProspectiveBuildingBaseMap();
  assert.equal(ctx.__rec.ccQueried, true);
  assert.equal(r.sourceRoofId, "cc1");
  assert.equal(r.fromSelectedRoof, false, "borrowed map is honestly not the selected roof's");
  assert.equal(r.viaCompanyCam, true);
});
test("orchestration: no base map anywhere -> null", async () => {
  const ctx = orchCtx({ info: { buildingId: "bld_a", roofs: [{ id: "r1" }], companyCamProjectId: "proj_1" }, ccRoofs: [{ id: "cc1" }] });
  assert.equal(await ctx.lookupProspectiveBuildingBaseMap(), null);
});
test("orchestration: no CompanyCam link -> no cross-building search, null", async () => {
  const ctx = orchCtx({ info: { buildingId: "bld_a", roofs: [{ id: "r1" }], companyCamProjectId: null } });
  assert.equal(await ctx.lookupProspectiveBuildingBaseMap(), null);
  assert.equal(ctx.__rec.ccQueried, false);
});
