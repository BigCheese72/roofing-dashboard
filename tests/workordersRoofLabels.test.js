const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(fields){
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service"],
    currentId: null,
    currentRoofId: null,
    currentBuildingId: null,
    currentCustomerId: null,
    currentCcDocumentId: null,
    currentCcDocumentHash: null,
    currentRoofIds: null,
    findings: [{ id: "f1", condition: "", location: "", warranty: "Warrantable", pin: null }],
    repairs: [],
    repairItems: [],
    materials: [],
    amendments: [],
    inspectionChecklist: [],
    photos: [],
    bpCache: [],
    fdnCache: [],
    ccLinkedProjectId: null,
    ccLinkedProjectName: "",
    fdnLinkedJobNo: null,
    fdnLinkedJobName: "",
    fdnLinkedCustomerNo: null,
    fdnLinkedAddress: "",
    __fdnLinks: [],
    changeOrderSignature: null,
    __refreshes: [],
    __fields: Object.assign({}, fields),
    document: { getElementById(){ return null; } },
    setTimeout(){ return 0; },
    clearTimeout(){},
    /* fill() now backfills ids onto legacy findings/repairs via genId()
       (repair-area pin contract) — the real one lives in the same file. */
    genId(prefix){ return prefix + "_t" + Math.random().toString(36).slice(2, 8); },
    formatPhoneUS(v){ return String(v == null ? "" : v); },
    renderPhoneCallLink(){},
    slugify(s){
      return String(s || "").toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
    },
    /* canonical id derivation moved to core.js (audit FIX 1) — real formula here */
    customerIdFor(billTo){ const n = (billTo || "").trim(); return n ? ("cust_" + sandbox.slugify(n)) : null; },
    buildingIdFor(billTo, jobName){
      const b = (jobName || "").trim();
      if (!b) return null;
      return "bld_" + sandbox.slugify((sandbox.customerIdFor(billTo) || "nocust") + "_" + b);
    },
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, value){ sandbox.__fields[id] = value || ""; },
    populateWoTypeSelect(){},
    populateRoofSystemSelect(){},
    renderLeakNoJobBadge(){},
    renderLocationDirectionsLink(){},
    onWoTypeChange(){},
    renderFindings(){},
    renderRepairs(){},
    renderRepairItems(){},
    renderMaterials(){},
    renderAmendments(){},
    renderAmendmentForm(){},
    renderPhotos(){},
    renderCCLinkInfo(){},
    fdnSetLinkedJob(jobNo, jobName, customerNo, address){
      sandbox.fdnLinkedJobNo = jobNo || null;
      sandbox.fdnLinkedJobName = jobName || "";
      sandbox.fdnLinkedCustomerNo = customerNo || null;
      sandbox.fdnLinkedAddress = address || "";
      sandbox.__fdnLinks.push({
        jobNo: sandbox.fdnLinkedJobNo,
        jobName: sandbox.fdnLinkedJobName,
        customerNo: sandbox.fdnLinkedCustomerNo,
        address: sandbox.fdnLinkedAddress
      });
    },
    renderChangeOrderSignature(){},
    ensureInspectionChecklist(){},
    renderInspectionChecklist(){},
    scheduleInlineBuildingHistoryRefresh(){},
    scheduleChangeOrderAutofill(){},
    closeBuildingPicker(){},
    toast(){},
    refreshInspectionRoofPickerIfNeeded(){
      sandbox.__refreshes.push({
        jobName: sandbox.__fields.jobName || "",
        billTo: sandbox.__fields.billTo || "",
        location: sandbox.__fields.location || "",
        roofSystem: sandbox.__fields.roofSystem || "",
        currentRoofId: sandbox.currentRoofId,
        currentRoofIds: sandbox.currentRoofIds
      });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between("function bpFoundationJobNameForBuilding", "/* ---- Move/reassign") +
    between("var lastLookupRoofInfo = null;", "/* ================= dynamic rows ================= */") +
    between("function rmRoofLabelFromCache", "function renderFindings") +
    between("var LEAK_NO_JOB_RE =", "/* Live re-evaluation") +
    between("var FIELD_IDS =", "function todayStr"),
    sandbox
  );
  return sandbox;
}

test("work order roof labels ignore a stale lastLookupRoofInfo cache", () => {
  const sandbox = makeSandbox({ billTo: "Beta Customer", jobName: "South Shop" });
  const buildingA = sandbox.buildingIdFor("Alpha Customer", "North Warehouse");
  sandbox.lastLookupRoofInfo = {
    buildingId: buildingA,
    roofs: [{ id: "roof_default", label: "A - Warehouse North" }]
  };

  assert.strictEqual(sandbox.rmRoofLabelFromCache("roof_default"), null);
  assert.strictEqual(sandbox.collect().roofLabels, null);
});

test("work order roof labels still use a matching lookup cache", () => {
  const sandbox = makeSandbox({ billTo: "Alpha Customer", jobName: "North Warehouse" });
  const buildingA = sandbox.buildingIdFor("Alpha Customer", "North Warehouse");
  sandbox.lastLookupRoofInfo = {
    buildingId: buildingA,
    roofs: [{ id: "roof_default", label: "A - Warehouse North" }]
  };

  assert.strictEqual(sandbox.rmRoofLabelFromCache("roof_default"), "A - Warehouse North");
  assert.strictEqual(sandbox.collect().roofLabels.roof_default, "A - Warehouse North");
});

test("fill clears lookup roof info when loading a different building", () => {
  const sandbox = makeSandbox({ billTo: "Alpha Customer", jobName: "North Warehouse" });
  sandbox.lastLookupRoofInfo = {
    buildingId: sandbox.buildingIdFor("Alpha Customer", "North Warehouse"),
    roofs: [{ id: "roof_default", label: "A - Warehouse North" }]
  };

  sandbox.fill({
    id: "wo_beta",
    billTo: "Beta Customer",
    jobName: "South Shop",
    woType: "Leak / Service",
    findings: [{ id: "f2", condition: "", location: "", warranty: "Warrantable", pin: null }],
    photos: []
  });

  assert.strictEqual(sandbox.lastLookupRoofInfo, null);
});

test("bpSelectBuilding clears stale roof selection before refreshing Inspection picker", () => {
  const sandbox = makeSandbox({ billTo: "Alpha Customer", jobName: "North Warehouse" });
  sandbox.currentRoofId = "roof-old";
  sandbox.currentRoofIds = ["roof-old", "roof-other"];
  sandbox.bpCache = [{
    id: "bld_beta",
    name: "South Shop",
    customerName: "Beta Customer",
    location: "200 South St",
    roofSystem: "TPO"
  }];

  sandbox.bpSelectBuilding("bld_beta");

  assert.strictEqual(sandbox.currentRoofId, null);
  assert.strictEqual(sandbox.currentRoofIds, null);
  assert.deepStrictEqual(sandbox.__refreshes, [{
    jobName: "South Shop",
    billTo: "Beta Customer",
    location: "200 South St",
    roofSystem: "TPO",
    currentRoofId: null,
    currentRoofIds: null
  }]);
});

test("bpSelectBuilding inherits a building's Foundation anchor on a new work order", () => {
  const sandbox = makeSandbox({ billTo: "", jobName: "" });
  sandbox.bpCache = [{
    id: "bld_foundation",
    name: "North Warehouse",
    customerName: "Acme",
    location: "100 Main St",
    foundationJobNo: "17053",
    foundationJobName: "North Warehouse Reroof",
    foundationCustomerNo: "C-42",
    foundationAddress: "100 Main St, Springfield IL"
  }];

  sandbox.bpSelectBuilding("bld_foundation");

  assert.deepStrictEqual(sandbox.__fdnLinks, [{
    jobNo: "17053",
    jobName: "North Warehouse Reroof",
    customerNo: "C-42",
    address: "100 Main St, Springfield IL"
  }]);
  const out = sandbox.collect();
  assert.strictEqual(out.foundationJobNo, "17053");
  assert.strictEqual(out.foundationJobName, "North Warehouse Reroof");
  assert.strictEqual(out.foundationCustomerNo, "C-42");
  assert.strictEqual(out.foundationAddress, "100 Main St, Springfield IL");
});

test("bpSelectBuilding resolves Foundation job name from cache for production-shaped building docs", () => {
  const sandbox = makeSandbox({ billTo: "", jobName: "" });
  sandbox.fdnCache = [{
    job_no: "17053",
    name: "North Warehouse Reroof",
    customer_no: "C-42"
  }];
  sandbox.bpCache = [{
    id: "bld_foundation",
    name: "North Warehouse",
    customerName: "Acme",
    location: "100 Main St",
    foundationJobNo: "17053",
    foundationCustomerNo: "C-42",
    foundationAddress: "100 Main St, Springfield IL"
  }];

  sandbox.bpSelectBuilding("bld_foundation");

  assert.deepStrictEqual(sandbox.__fdnLinks, [{
    jobNo: "17053",
    jobName: "North Warehouse Reroof",
    customerNo: "C-42",
    address: "100 Main St, Springfield IL"
  }]);
  const out = sandbox.collect();
  assert.strictEqual(out.foundationJobNo, "17053");
  assert.strictEqual(out.foundationJobName, "North Warehouse Reroof");
  assert.strictEqual(sandbox.isLeakNoJobOrder({
    jobName: "Leak - No Job",
    foundationJobNo: out.foundationJobNo,
    foundationJobName: out.foundationJobName
  }), false);
});

test("bpSelectBuilding does not clobber a Foundation job already selected this session", () => {
  const sandbox = makeSandbox({ billTo: "", jobName: "" });
  sandbox.fdnLinkedJobNo = "99999";
  sandbox.fdnLinkedJobName = "Explicit Job";
  sandbox.fdnLinkedCustomerNo = "C-99";
  sandbox.fdnLinkedAddress = "999 Chosen Ave";
  sandbox.bpCache = [{
    id: "bld_foundation",
    name: "North Warehouse",
    customerName: "Acme",
    location: "100 Main St",
    foundationJobNo: "17053",
    foundationJobName: "North Warehouse Reroof",
    foundationCustomerNo: "C-42",
    foundationAddress: "100 Main St, Springfield IL"
  }];

  sandbox.bpSelectBuilding("bld_foundation");

  assert.deepStrictEqual(sandbox.__fdnLinks, []);
  const out = sandbox.collect();
  assert.strictEqual(out.foundationJobNo, "99999");
  assert.strictEqual(out.foundationJobName, "Explicit Job");
  assert.strictEqual(out.foundationCustomerNo, "C-99");
  assert.strictEqual(out.foundationAddress, "999 Chosen Ave");
});

test("fill refreshes Inspection roof picker with loaded fields and roof selection", () => {
  const sandbox = makeSandbox({ billTo: "Alpha Customer", jobName: "North Warehouse" });

  sandbox.fill({
    id: "wo_inspection",
    billTo: "Beta Customer",
    jobName: "South Shop",
    location: "200 South St",
    roofSystem: "TPO",
    woType: "Inspection",
    roofId: "roof-main",
    roofIds: ["roof-main", "roof-west"],
    inspectionChecklist: [],
    findings: [{ id: "f2", condition: "", location: "", warranty: "Warrantable", pin: null }],
    photos: []
  });

  assert.deepStrictEqual(sandbox.__refreshes, [{
    jobName: "South Shop",
    billTo: "Beta Customer",
    location: "200 South St",
    roofSystem: "TPO",
    currentRoofId: "roof-main",
    currentRoofIds: ["roof-main", "roof-west"]
  }]);
});
