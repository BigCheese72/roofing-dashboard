const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Feedback fb_msdlj2bco8igq (prod, Report Preview on the Taco Bell On Stadium
   job): "photos don't show up on the base map where they were taken, where the
   pin was dropped."

   Root cause: the customer report's Roof Plan (rmBuildReportRoofPlanSvg) drew
   the outline + permanent roof_assets, but NEVER the finding pins the tech
   drops when documenting a leak/photo — and rmFetchReportRoofOutlines never
   gathered them. Every other view (Building History renderBuildingMap,
   RoofMapper's own export) already plots those pins; the report was the one
   place that didn't. This is separate from the #45 image-frame stamp (already
   in prod), which is about x/y pins on the INTERACTIVE base map.

   These tests load the REAL export.js and exercise the two new/changed pieces:
   rmReportFindingPinsFor() (pure collector) and rmBuildReportRoofPlanSvg()
   (the drawing). Only the geometry helpers that actually live in
   roofmapper.js are stubbed. */

const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

/* One sandbox with export.js loaded and roofmapper-owned geometry helpers
   stubbed. rmReportMethodSentences/rmReportEdgeMeta/rmFormatEdgeFeet all guard
   their roofmapper accessors and degrade, so only the hard geometry deps need
   stubbing. */
function makeSandbox(){
  const sb = { console, Math, Date, JSON, isFinite, parseFloat, parseInt, isNaN,
    String, Number, Array, Object, Boolean, RegExp };
  sb.window = sb; sb.globalThis = sb;
  sb.document = {
    getElementById(){ return null; },
    createElement(){ return { getContext(){ return {}; }, style: {}, appendChild(){} }; },
    body: { appendChild(){}, removeChild(){} }
  };
  vm.createContext(sb);
  vm.runInContext(exportSource, sb, { filename: "export.js" });

  // roofmapper.js-provided helpers (undefined in an export-only sandbox):
  sb.rmEscXml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  sb.rmGeomRingCentroid = (pts) => {
    const p = (pts || []).filter(Boolean);
    if (!p.length) return { lat: 0, lng: 0 };
    return { lat: p.reduce((a, q) => a + q.lat, 0) / p.length,
             lng: p.reduce((a, q) => a + q.lng, 0) / p.length };
  };
  // Simple equirectangular projection to feet-ish units — only relative
  // positions matter for these assertions.
  sb.rmExportProjectPoint = (pt, origin) => ({
    x: (pt.lng - origin.lng) * 300000,
    y: (pt.lat - origin.lat) * 364000
  });
  sb.rmGeomHaversineMeters = (a, b) =>
    Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 94000);
  sb.rmOutlineHolesSvgPath = () => "";
  // export-size constants that live in roofmapper.js
  sb.RM_EXPORT_MAX_SCALE = 20;
  sb.RM_EXPORT_MAX_CANVAS_DIM = 2200;
  return sb;
}

const worldRing = [
  { lat: 32.7000, lng: -97.1000 },
  { lat: 32.7000, lng: -97.0980 },
  { lat: 32.7015, lng: -97.0980 },
  { lat: 32.7015, lng: -97.1000 },
  { lat: 32.7000, lng: -97.1000 }
];

/* ===================== rmReportFindingPinsFor ===================== */

function collectorSandbox(findings, photos){
  const sb = makeSandbox();
  sb.filledFindings = () => findings;
  sb.filledPhotos = () => photos;
  return sb;
}

test("collects world-coordinate finding pins with global finding numbers + photo refs", () => {
  const findings = [
    { id: "f1", warranty: "Warrantable", location: "NE corner",
      pin: { lat: 32.7005, lng: -97.0990, x: null, y: null } },
    { id: "f2", warranty: "Non-warrantable", location: "drain",
      pin: { lat: 32.7010, lng: -97.0985, x: null, y: null } }
  ];
  const photos = [
    { finding_id: "f1" }, { finding_id: "f1" }, { finding_id: "f2" }
  ];
  const sb = collectorSandbox(findings, photos);
  const pins = sb.rmReportFindingPinsFor({ roofId: "roof_default" });
  assert.equal(pins.length, 2);
  assert.equal(pins[0].findingNo, 1);
  // arrays come from the vm realm — compare by value, not cross-realm identity
  assert.equal(JSON.stringify(pins[0].photoNos), "[1,2]");
  assert.equal(pins[1].findingNo, 2);
  assert.equal(JSON.stringify(pins[1].photoNos), "[3]");
  assert.equal(pins[0].roofId, "roof_default"); // fell back to o.roofId
});

test("drops x/y-only (non-georeferenced base map) pins — cannot be projected here", () => {
  const findings = [
    { id: "f1", pin: { lat: null, lng: null, x: 0.5, y: 0.5, imageFrame: "roof_base_map", imageFrameUrl: "u" } },
    { id: "f2", pin: { lat: 32.7005, lng: -97.099, x: null, y: null } }
  ];
  const sb = collectorSandbox(findings, []);
  const pins = sb.rmReportFindingPinsFor({});
  assert.equal(pins.length, 1);
  assert.equal(pins[0].findingNo, 2); // numbering stays GLOBAL, not re-indexed
});

test("drops findings with no pin and Null Island (0,0) placeholder pins", () => {
  const findings = [
    { id: "f1" },
    { id: "f2", pin: null },
    { id: "f3", pin: { lat: 0, lng: 0, x: null, y: null } },
    { id: "f4", pin: { lat: 32.7005, lng: -97.099, x: null, y: null } }
  ];
  const sb = collectorSandbox(findings, []);
  const pins = sb.rmReportFindingPinsFor({});
  assert.equal(pins.length, 1);
  assert.equal(pins[0].findingNo, 4);
});

test("a finding's own roofId is preferred over the work order's", () => {
  const findings = [
    { id: "f1", roofId: "roof_B", pin: { lat: 32.7005, lng: -97.099, x: null, y: null } }
  ];
  const sb = collectorSandbox(findings, []);
  const pins = sb.rmReportFindingPinsFor({ roofId: "roof_A" });
  assert.equal(pins[0].roofId, "roof_B");
});

test("returns [] when filledFindings is unavailable (never throws)", () => {
  const sb = makeSandbox();
  sb.filledFindings = undefined;
  assert.equal(sb.rmReportFindingPinsFor({}).length, 0);
});

/* ===================== rmBuildReportRoofPlanSvg ===================== */

const FINDING_PIN_FILL = "#1565C0";

test("finding pins are drawn as numbered markers on the roof plan", () => {
  const sb = makeSandbox();
  const roofEntries = [{
    roofId: "roof_default", roofLabel: "Main Roof",
    outline: { ring: worldRing, center: { lat: 32.70075, lng: -97.099 } },
    assets: [],
    findingPins: [
      { lat: 32.7005, lng: -97.0990, findingNo: 1, photoNos: [1], warranty: "Warrantable" },
      { lat: 32.7010, lng: -97.0985, findingNo: 2, photoNos: [], warranty: "Non-warrantable" }
    ]
  }];
  const out = sb.rmBuildReportRoofPlanSvg(roofEntries);
  assert.equal(typeof out.svg, "string");
  // two accent-colored discs, one per finding pin
  const discs = (out.svg.match(new RegExp('fill="' + FINDING_PIN_FILL + '"', "g")) || []).length;
  assert.ok(discs >= 2, "expected >=2 finding-pin discs, got " + discs);
  // the finding numbers are rendered as label text inside the discs
  assert.match(out.svg, />1</);
  assert.match(out.svg, />2</);
  // legend gains the marker row only now that markers exist
  assert.match(out.svg, /Finding \/ photo location/);
});

test("no finding pins => no accent markers and no marker legend row (unchanged report)", () => {
  const sb = makeSandbox();
  const roofEntries = [{
    roofId: "roof_default", roofLabel: "Main Roof",
    outline: { ring: worldRing, center: { lat: 32.70075, lng: -97.099 } },
    assets: [{ lat: 32.7006, lng: -97.0990, type: "drain" }],
    findingPins: []
  }];
  const out = sb.rmBuildReportRoofPlanSvg(roofEntries);
  assert.doesNotMatch(out.svg, new RegExp('fill="' + FINDING_PIN_FILL + '"'));
  assert.doesNotMatch(out.svg, /Finding \/ photo location/);
  // the asset circle is still drawn — existing behavior intact
  assert.match(out.svg, /fill="#455A64"/);
});

test("a finding pin outside the outline's bounding box still lands inside the canvas", () => {
  const sb = makeSandbox();
  // pin well north-east of the roof outline
  const roofEntries = [{
    roofId: "roof_default", roofLabel: "Main Roof",
    outline: { ring: worldRing, center: { lat: 32.70075, lng: -97.099 } },
    assets: [],
    findingPins: [{ lat: 32.7030, lng: -97.0950, findingNo: 1, photoNos: [1] }]
  }];
  const out = sb.rmBuildReportRoofPlanSvg(roofEntries);
  // extract the disc center and confirm it is within [0,width]x[0,height]
  const m = out.svg.match(new RegExp('<circle cx="([0-9.]+)" cy="([0-9.]+)" r="9" fill="' + FINDING_PIN_FILL + '"'));
  assert.ok(m, "finding-pin disc not found");
  const cx = parseFloat(m[1]), cy = parseFloat(m[2]);
  assert.ok(cx >= 0 && cx <= out.width, "cx " + cx + " within 0.." + out.width);
  assert.ok(cy >= 0 && cy <= out.height, "cy " + cy + " within 0.." + out.height);
});
