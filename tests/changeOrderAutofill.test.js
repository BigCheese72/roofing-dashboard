const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Same slicing pattern as tests/workordersRoofLabels.test.js: pull the real
   source region out of js/workorders.js (no build step, no bundler in this
   app) and run it in a sandbox with the browser bits stubbed. The region
   below spans FIELD_IDS -> todayStr(), which contains collect(), fill(), and
   the Change Order autofill block under test. */
const source = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(opts){
  opts = opts || {};
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service", "Change Order"],
    currentId: null,
    currentRoofId: null,
    currentRoofIds: null,
    findings: [],
    repairs: [],
    repairItems: [],
    inspectionChecklist: [],
    photos: [],
    ccLinkedProjectId: null,
    ccLinkedProjectName: "",
    changeOrderSignature: null,
    lastLookupRoofInfo: null,
    fdb: opts.fdb === undefined ? {} : opts.fdb, /* truthy = "cloud available" */
    __fields: Object.assign({}, opts.fields),
    __toasts: [],
    __historyEvents: opts.events || [],
    console: { warn(){}, log(){} },
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, value){ sandbox.__fields[id] = value == null ? "" : String(value); },
    toast(msg){ sandbox.__toasts.push(msg); },
    currentWorkOrderBuildingId(){ return opts.buildingId === undefined ? "bld_acme_north" : opts.buildingId; },
    async loadBuildingHistoryEvents(){ return sandbox.__historyEvents; },
    buildingIdFor(){ return "bld_acme_north"; },
    lookupRoofInfoMatchesBuilding(){ return false; },
    populateWoTypeSelect(){},
    onWoTypeChange(){},
    renderFindings(){},
    renderRepairs(){},
    renderRepairItems(){},
    renderPhotos(){},
    renderCCLinkInfo(){},
    renderChangeOrderSignature(){},
    ensureInspectionChecklist(){},
    renderInspectionChecklist(){},
    clearStaleLookupRoofInfoForCurrentOrder(){},
    scheduleInlineBuildingHistoryRefresh(){},
    genId(p){ return p + "_test"; },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(between("var FIELD_IDS =", "function todayStr"), sandbox);
  return sandbox;
}

test('changeOrderJobNo() appends " CO" to the parent job number', () => {
  const s = makeSandbox({});
  assert.strictEqual(s.changeOrderJobNo("16153"), "16153 CO");
  assert.strictEqual(s.changeOrderJobNo("  16153  "), "16153 CO");
});

test("changeOrderJobNo() is idempotent — never 16153 CO CO", () => {
  const s = makeSandbox({});
  assert.strictEqual(s.changeOrderJobNo("16153 CO"), "16153 CO");
  assert.strictEqual(s.changeOrderJobNo("16153 co"), "16153 CO");
  assert.strictEqual(s.changeOrderJobNo(s.changeOrderJobNo("16153")), "16153 CO");
  assert.strictEqual(s.changeOrderJobNo(""), "");
  assert.strictEqual(s.changeOrderJobNo(null), "");
});

test("parentJobNoFromHistoryEvents() prefers the newest non-Change-Order entry", () => {
  const s = makeSandbox({});
  const base = s.parentJobNoFromHistoryEvents([
    { workOrderNo: "", workOrderType: "Repair" },
    { workOrderNo: "16153", workOrderType: "Leak / Service" },
    { workOrderNo: "15022", workOrderType: "Inspection" }
  ]);
  assert.strictEqual(base, "16153");
});

test("parentJobNoFromHistoryEvents() recovers the base number from a prior change order", () => {
  const s = makeSandbox({});
  assert.strictEqual(s.parentJobNoFromHistoryEvents([{ workOrderNo: "16153 CO", workOrderType: "Change Order" }]), "16153");
  assert.strictEqual(s.parentJobNoFromHistoryEvents([]), "");
});

test("a Change Order on a building with a parent job gets that job number + CO", async () => {
  const s = makeSandbox({
    fields: { woType: "Change Order", jobNo: "", jobName: "North Warehouse", billTo: "Acme" },
    events: [{ workOrderNo: "16153", workOrderType: "Leak / Service" }]
  });
  const out = await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(s.val("jobNo"), "16153 CO");
});

test("a job number the tech typed is never overwritten", async () => {
  const s = makeSandbox({
    fields: { woType: "Change Order", jobNo: "99999-B", jobName: "North Warehouse", billTo: "Acme" },
    events: [{ workOrderNo: "16153", workOrderType: "Leak / Service" }]
  });
  const out = await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, "user-entered");
  assert.strictEqual(s.val("jobNo"), "99999-B");
});

test("other work order types are left completely alone", async () => {
  for (const woType of ["Leak / Service", "Repair", "Inspection", "Warranty"]){
    const s = makeSandbox({
      fields: { woType: woType, jobNo: "", jobName: "North Warehouse", billTo: "Acme" },
      events: [{ workOrderNo: "16153", workOrderType: "Leak / Service" }]
    });
    const out = await s.maybeApplyChangeOrderJobNo();
    assert.strictEqual(out.skipped, true, woType + " must be skipped");
    assert.strictEqual(out.reason, "not-a-change-order");
    assert.strictEqual(s.val("jobNo"), "", woType + " job number must stay untouched");
  }
});

test("no parent job number on the building means no autofill (and no invented number)", async () => {
  const s = makeSandbox({
    fields: { woType: "Change Order", jobNo: "", jobName: "New Building", billTo: "Acme" },
    events: [{ workOrderNo: "", workOrderType: "Inspection" }]
  });
  const out = await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, "no-parent-job-no");
  assert.strictEqual(s.val("jobNo"), "");
});

test("offline: autofill is skipped, nothing is guessed", async () => {
  const s = makeSandbox({
    fdb: null,
    fields: { woType: "Change Order", jobNo: "", jobName: "North Warehouse", billTo: "Acme" },
    events: [{ workOrderNo: "16153", workOrderType: "Leak / Service" }]
  });
  const out = await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, "offline");
  assert.strictEqual(s.val("jobNo"), "");
});

test("re-running autofill refreshes its own value but still yields to a later manual edit", async () => {
  const s = makeSandbox({
    fields: { woType: "Change Order", jobNo: "", jobName: "North Warehouse", billTo: "Acme" },
    events: [{ workOrderNo: "16153", workOrderType: "Leak / Service" }]
  });
  await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(s.val("jobNo"), "16153 CO");

  /* Building corrected to a different parent job -> our own auto value may be
     replaced, because it was ours, not the tech's. */
  s.__historyEvents = [{ workOrderNo: "16200", workOrderType: "Repair" }];
  await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(s.val("jobNo"), "16200 CO");

  /* Tech overrides it -> autofill must never touch it again. */
  s.setVal("jobNo", "16200 CO-2");
  s.__historyEvents = [{ workOrderNo: "16999", workOrderType: "Repair" }];
  const out = await s.maybeApplyChangeOrderJobNo();
  assert.strictEqual(out.reason, "user-entered");
  assert.strictEqual(s.val("jobNo"), "16200 CO-2");
});

test("collect() still writes companyCamProjectId for a Change Order (the CC push depends on it)", () => {
  const s = makeSandbox({ fields: { woType: "Change Order", jobNo: "16153 CO", jobName: "North Warehouse", billTo: "Acme" } });
  s.ccLinkedProjectId = "ccp_123";
  s.ccLinkedProjectName = "Acme — North Warehouse";
  const o = s.collect();
  assert.strictEqual(o.woType, "Change Order");
  assert.strictEqual(o.companyCamProjectId, "ccp_123");
  assert.strictEqual(o.jobNo, "16153 CO");
});
