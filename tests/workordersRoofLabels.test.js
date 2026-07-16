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
    currentRoofIds: null,
    findings: [{ id: "f1", condition: "", location: "", warranty: "Warrantable", pin: null }],
    repairs: [],
    repairItems: [],
    materials: [],
    inspectionChecklist: [],
    photos: [],
    bpCache: [],
    ccLinkedProjectId: null,
    ccLinkedProjectName: "",
    changeOrderSignature: null,
    __refreshes: [],
    __fields: Object.assign({}, fields),
    document: { getElementById(){ return null; } },
    setTimeout(){ return 0; },
    clearTimeout(){},
    /* fill() now backfills ids onto legacy findings/repairs via genId()
       (repair-area pin contract) — the real one lives in the same file. */
    genId(prefix){ return prefix + "_t" + Math.random().toString(36).slice(2, 8); },
    slugify(s){
      return String(s || "").toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
    },
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, value){ sandbox.__fields[id] = value || ""; },
    populateWoTypeSelect(){},
    onWoTypeChange(){},
    renderFindings(){},
    renderRepairs(){},
    renderRepairItems(){},
    renderMaterials(){},
    renderPhotos(){},
    renderCCLinkInfo(){},
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
    between("function bpSelectBuilding", "/* ---- Move/reassign") +
    between("var lastLookupRoofInfo = null;", "/* ================= dynamic rows ================= */") +
    between("function rmRoofLabelFromCache", "function renderFindings") +
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
