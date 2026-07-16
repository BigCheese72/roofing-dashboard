"use strict";
/* Foundation job -> app building matcher (#97). Extracted from js/foundation.js
   with globals stubbed so the client-side matcher and select carry-over can be
   checked without a DOM or Firestore. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");

function slice(a, b) {
  const s = src.indexOf(a), e = src.indexOf(b, s);
  assert.ok(s !== -1 && e !== -1, "markers " + a + " -> " + b);
  return src.slice(s, e);
}

const matcherBlock =
  slice("function fdnEsc", "// On select: auto-fill") +
  slice("function fdnSelectJob", "// GET the linked job");

function makeCtx(opts) {
  const rec = { setVals: {}, ccRenders: 0, closed: 0, toasts: [] };
  const ctx = {
    String, Number, Array, Object, JSON, RegExp,
    isFinite,
    bpCache: opts.bpCache || [],
    fdnCache: opts.fdnCache || [],
    ccLinkedProjectId: opts.ccLinkedProjectId || null,
    ccLinkedProjectName: "",
    setVal: (k, v) => { rec.setVals[k] = v; },
    renderCCLinkInfo: () => { rec.ccRenders += 1; },
    closeBuildingPicker: () => { rec.closed += 1; },
    toast: (m) => rec.toasts.push(m),
    document: { getElementById: () => null },
    renderFdnLinkInfo: () => {},
    fdnRefreshLaborCard: () => {}
  };
  vm.runInNewContext(matcherBlock, ctx);
  ctx.__rec = rec;
  return ctx;
}

test("address match carries existing building context when job and building names differ", () => {
  const ctx = makeCtx({
    bpCache: [{ name: "West Middle School", location: "1200 Main Street, Springfield, IL", roofSystem: "TPO", companyCamProjectId: "ccp_1", companyCamProjectName: "West Middle" }],
    fdnCache: [{ job_no: "17053", name: "CPS West Middle RTU replacement", customer_no: "C-42", address: "1200 Main St", city: "Springfield", state: "IL", zip: "62701" }]
  });
  const building = ctx.fdnFindMatchingBuilding(ctx.fdnCache[0]);
  assert.equal(building.name, "West Middle School");

  ctx.fdnSelectJob("17053");
  assert.equal(ctx.__rec.setVals.roofSystem, "TPO");
  assert.equal(ctx.ccLinkedProjectId, "ccp_1");
  assert.equal(ctx.__rec.ccRenders, 1);
});

test("exact name still matches when no address is available", () => {
  const ctx = makeCtx({
    bpCache: [{ name: "North Warehouse", location: "", companyCamProjectId: "ccp_2" }],
    fdnCache: [{ job_no: "17054", name: "North Warehouse" }]
  });
  assert.equal(ctx.fdnFindMatchingBuilding(ctx.fdnCache[0]).companyCamProjectId, "ccp_2");
});

test("ambiguous address or name refuses to auto-link", () => {
  const ctx = makeCtx({
    bpCache: [
      { name: "West Middle School A", location: "1200 Main St, Springfield, IL" },
      { name: "West Middle School B", location: "1200 Main Street, Springfield, IL" },
      { name: "Duplicate", location: "" },
      { name: "Duplicate", location: "" }
    ],
    fdnCache: []
  });
  assert.equal(ctx.fdnFindMatchingBuilding({ name: "Different", address: "1200 Main St", city: "Springfield", state: "IL" }), null);
  assert.equal(ctx.fdnFindMatchingBuilding({ name: "Duplicate" }), null);
});

test("different street number is not an address match", () => {
  const ctx = makeCtx({
    bpCache: [{ name: "West Middle School", location: "1230 Main St, Springfield, IL", companyCamProjectId: "ccp_3" }],
    fdnCache: []
  });
  assert.equal(ctx.fdnFindMatchingBuilding({ name: "CPS West Middle RTU replacement", address: "1200 Main St", city: "Springfield", state: "IL" }), null);
});

test("same street in a different city is not a lone address match", () => {
  const ctx = makeCtx({
    bpCache: [{ name: "Decatur Main Office", location: "1200 Main Street, Decatur, IL", companyCamProjectId: "ccp_4" }],
    fdnCache: []
  });
  assert.equal(ctx.fdnFindMatchingBuilding({ name: "Springfield Main Office", address: "1200 Main St", city: "Springfield", state: "IL" }), null);
});

test("empty job name, empty cache, or explicit session CompanyCam link stay safe", () => {
  const empty = makeCtx({ bpCache: [] });
  assert.equal(empty.fdnFindMatchingBuilding({ name: "", address: "1200 Main St" }), null);

  const linked = makeCtx({
    ccLinkedProjectId: "already_linked",
    bpCache: [{ name: "West Middle School", location: "1200 Main St, Springfield, IL", companyCamProjectId: "ccp_1" }],
    fdnCache: [{ job_no: "17053", name: "CPS West Middle RTU replacement", address: "1200 Main St" }]
  });
  linked.fdnSelectJob("17053");
  assert.equal(linked.ccLinkedProjectId, "already_linked");
  assert.equal(linked.__rec.ccRenders, 0);
});
