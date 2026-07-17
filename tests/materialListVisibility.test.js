const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Runs the real onWoTypeChange() with every element stubbed as a fresh
   {style:{display}} object — visibility gates are asserted straight off the
   ids they set. Mark's prod report: the Material List card was Repair-only
   and looked "missing" on the Leak form. */
function runTypeChange(woType){
  const els = {};
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service", "Change Order", "Inspection", "Repair", "Warranty"],
    __els: els,
    val(id){ return id === "woType" ? woType : ""; },
    document: {
      getElementById(id){
        if (!els[id]) els[id] = { style: { display: "unset" }, textContent: "" };
        return els[id];
      }
    },
    renderChangeOrderPhotos(){},
    ensureInspectionChecklist(){},
    renderInspectionChecklist(){},
    renderInspectionRoofPicker(){}
    /* scheduleChangeOrderAutofill / ccBuildingLinkControlVisible are
       typeof-guarded in the source — deliberately not stubbed. */
  };
  vm.createContext(sandbox);
  vm.runInContext(between(coreSource, "function onWoTypeChange()", "/* ================= storage"), sandbox);
  sandbox.onWoTypeChange();
  return els;
}

test("Material List shows on the Work Order (Repair) form", () => {
  assert.strictEqual(runTypeChange("Repair")["wo-materials-card"].style.display, "");
});

test("Material List shows on the Leak / Service form (Mark's prod fix — was hidden)", () => {
  assert.strictEqual(runTypeChange("Leak / Service")["wo-materials-card"].style.display, "");
});

test("Change Order and Inspection stay OUT; Warranty stays out pending Mark's decision", () => {
  assert.strictEqual(runTypeChange("Change Order")["wo-materials-card"].style.display, "none",
    "Change Order has its own #woMaterials textarea");
  assert.strictEqual(runTypeChange("Inspection")["wo-materials-card"].style.display, "none");
  assert.strictEqual(runTypeChange("Warranty")["wo-materials-card"].style.display, "none",
    "Warranty is a pending decision — deliberately not added yet");
});

test("neighbor gates unchanged by this fix (regression): Repair Scope card still Repair-only", () => {
  assert.strictEqual(runTypeChange("Repair")["wo-repair-card"].style.display, "");
  assert.strictEqual(runTypeChange("Leak / Service")["wo-repair-card"].style.display, "none");
  /* Leak also keeps its pure-investigation shape: no Work Performed card. */
  assert.strictEqual(runTypeChange("Leak / Service")["wo-repairsperformed-card"].style.display, "none");
  assert.strictEqual(runTypeChange("Repair")["wo-repairsperformed-card"].style.display, "");
});
