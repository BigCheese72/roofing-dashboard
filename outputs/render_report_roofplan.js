/* Read-only render harness for verifying commit 7430957
   (report roof plan: finding/photo pins). Loads the REAL js/export.js in a VM,
   stubs only the geometry helpers that live in roofmapper.js (using their REAL
   production math, copied verbatim), feeds a representative sample work order,
   and rasterizes the exact SVG the customer preview + PDF share to PNG. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Resvg } = require("/tmp/node_modules/@resvg/resvg-js");

const repo = path.join(__dirname, "..");
const exportSource = fs.readFileSync(path.join(repo, "js", "export.js"), "utf8");

// ---- REAL roofmapper.js production math (copied verbatim from js/roofmapper.js) ----
function rmGeomToLocalXY(point, origin){
  var mPerDegLat = 111320;
  var mPerDegLng = 111320 * Math.cos(origin.lat * Math.PI / 180);
  return { x: (point.lng - origin.lng) * mPerDegLng, y: (point.lat - origin.lat) * mPerDegLat };
}
function rmExportProjectPoint(point, origin){
  var xy = rmGeomToLocalXY(point, origin);
  return { x: xy.x * 3.28084, y: xy.y * 3.28084 }; // meters -> feet
}
function rmGeomRingCentroid(ring){
  var lat = 0, lng = 0, n = ring.length;
  ring.forEach(function(p){ lat += p.lat; lng += p.lng; });
  return { lat: lat / n, lng: lng / n };
}
function rmEscXml(s){
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function makeSandbox(findings, photos){
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
  // roofmapper-owned helpers with REAL production math:
  sb.rmEscXml = rmEscXml;
  sb.rmGeomRingCentroid = rmGeomRingCentroid;
  sb.rmExportProjectPoint = rmExportProjectPoint;
  sb.rmGeomHaversineMeters = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos(a.lat*Math.PI/180));
  sb.rmOutlineHolesSvgPath = () => "";
  sb.RM_EXPORT_MAX_SCALE = 20;
  sb.RM_EXPORT_MAX_CANVAS_DIM = 2200;
  // in-memory data sources the collector reads (read-only):
  sb.filledFindings = () => findings;
  sb.filledPhotos = () => photos;
  return sb;
}

// ---- Representative sample: a rectangular commercial roof (~130ft x 90ft)
// with a few permanent assets (drains) and 4 finding/photo pins the tech
// dropped, mirroring a real leak-documentation work order. Coordinates are
// real lat/lng so the PRODUCTION projection places them exactly as the app would.
const originLat = 32.7008, originLng = -97.0995;
// ~130ft E-W, ~90ft N-S rectangle (deg offsets computed from ft)
const ftLat = 1/364567, ftLng = 1/(364567*Math.cos(originLat*Math.PI/180));
function P(eFt, nFt){ return { lat: originLat + nFt*ftLat, lng: originLng + eFt*ftLng }; }

const ring = [ P(0,0), P(130,0), P(130,90), P(0,90), P(0,0) ];
const center = { lat: originLat + 45*ftLat, lng: originLng + 65*ftLng };

const assets = [
  Object.assign({ type: "drain", label: "Drain" }, P(25, 20)),
  Object.assign({ type: "drain", label: "Drain" }, P(105, 70))
];

const findings = [
  { id: "f1", warranty: "Warrantable",     location: "NE corner splitting seam", roofId: "roof_default", pin: Object.assign({}, P(112, 78)) },
  { id: "f2", warranty: "Non-warrantable", location: "Ponding near center drain", roofId: "roof_default", pin: Object.assign({}, P(60, 45)) },
  { id: "f3", warranty: "Warrantable",     location: "SW parapet flashing",       roofId: "roof_default", pin: Object.assign({}, P(15, 12)) },
  { id: "f4", warranty: "Warrantable",     location: "Penetration boot cracked",  roofId: "roof_default", pin: Object.assign({}, P(90, 30)) }
];
const photos = [
  { finding_id: "f1" }, { finding_id: "f1" }, { finding_id: "f2" },
  { finding_id: "f3" }, { finding_id: "f4" }, { finding_id: "f4" }
];

const sb = makeSandbox(findings, photos);

// Build finding pins via the REAL collector, then assemble the roof entry the
// way rmFetchReportRoofOutlines() does, and call the REAL SVG builder.
const findingPins = sb.rmReportFindingPinsFor({ roofId: "roof_default" });
console.log("Collected finding pins:", JSON.stringify(findingPins.map(p=>({no:p.findingNo, photos:p.photoNos, loc:p.location})), null, 0));

const roofEntries = [{
  roofId: "roof_default",
  roofLabel: "Main Roof",
  outline: { ring, center, name: "Main Roof" },
  assets,
  findingPins
}];

const out = sb.rmBuildReportRoofPlanSvg(roofEntries);
console.log("SVG size:", out.width, "x", out.height);

const outDir = process.argv[2] || __dirname;
fs.writeFileSync(path.join(outDir, "RoofOps_7430957_roofplan.svg"), out.svg);

// Rasterize at high resolution (scale up for crisp text on phone)
const resvg = new Resvg(out.svg, { fitTo: { mode: "width", value: Math.round(out.width * 2.5) }, background: "#ffffff" });
const png = resvg.render().asPng();
const pngPath = path.join(outDir, "RoofOps_7430957_report_preview.png");
fs.writeFileSync(pngPath, png);
console.log("Wrote PNG:", pngPath, png.length, "bytes");
