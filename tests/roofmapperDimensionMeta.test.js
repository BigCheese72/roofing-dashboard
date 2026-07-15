const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "roofmapper.js"), "utf8");

function loadFunctionBlock(startMarker, endMarker, context){
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, "missing start marker " + startMarker);
  assert.notEqual(end, -1, "missing end marker " + endMarker);
  vm.runInNewContext(source.slice(start, end), context);
  return context;
}

function makeContext(){
  const context = {
    RM_EDGE_MEASURE_LABEL_TOLERANCE_FT: 0.25,
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    },
    rmActiveEdgeMeasurements(outline){
      return (outline && outline.edgeMeasurements) || [];
    },
    rmLegacyCalibrationMeasurement(){
      return null;
    }
  };
  loadFunctionBlock("function rmActiveMeasuredEdges", "function rmBuildCaptureSource", context);
  return context;
}

test("rmEdgeDimensionMeta uses a neutral badge when drawn distance is unknown", () => {
  const context = makeContext();
  const outline = {
    edgeMeasurements: [{ edgeIndex: 0, measuredFt: 42.5, source: "measured" }]
  };

  const meta = context.rmEdgeDimensionMeta(outline, 0, NaN);

  assert.equal(meta.measured, true);
  assert.equal(meta.conflict, false);
  assert.equal(meta.bg, "#263238");
  assert.equal(meta.prefix, "");
  assert.equal(meta.border, true);
  assert.equal(meta.labelFt, 42.5);
  assert.equal(meta.measuredFt, 42.5);
  assert.equal(Number.isNaN(meta.derivedFt), true);
  assert.equal(meta.labelIsMeasured, true);
  assert.equal(meta.agreementUnknown, true);
});

test("rmEdgeDimensionMeta still marks finite matching measurements as agreement", () => {
  const context = makeContext();
  const outline = {
    edgeMeasurements: [{ edgeIndex: 0, measuredFt: 42.5, source: "measured" }]
  };

  const meta = context.rmEdgeDimensionMeta(outline, 0, 42.55);

  assert.equal(meta.conflict, false);
  assert.equal(meta.bg, "#2E7D32");
  assert.equal(meta.prefix, "\u2713 ");
  assert.equal(meta.agreementUnknown, undefined);
});

test("rmEdgeDimensionMeta still marks finite mismatches as conflicts", () => {
  const context = makeContext();
  const outline = {
    edgeMeasurements: [{ edgeIndex: 0, measuredFt: 42.5, source: "measured" }]
  };

  const meta = context.rmEdgeDimensionMeta(outline, 0, 48);

  assert.equal(meta.conflict, true);
  assert.equal(meta.bg, "#F57C00");
  assert.equal(meta.prefix, "! ");
  assert.equal(meta.agreementUnknown, undefined);
});
