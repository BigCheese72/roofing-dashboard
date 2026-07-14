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
    inspectionChecklist: [],
    photos: [],
    ccLinkedProjectId: null,
    ccLinkedProjectName: "",
    changeOrderSignature: null,
    __fields: Object.assign({}, fields),
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
    renderPhotos(){},
    renderCCLinkInfo(){},
    renderChangeOrderSignature(){},
    ensureInspectionChecklist(){},
    renderInspectionChecklist(){},
    scheduleInlineBuildingHistoryRefresh(){}
  };
  vm.createContext(sandbox);
  vm.runInContext(
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
