/* Nested-roof cutouts -- Mark's Roof 7-around-Roof 8 case.

   Two shapes of hole, and the difference between them is ACCOUNTING, not
   geometry (see rmRecomputeOutlineMetrics() in js/roofmapper.js):
     kind "roof" -- a penthouse. The area is still roof, it just belongs to
                    the nested roof. Building total is unchanged.
     kind "void" -- a courtyard. The area is not roof at all. Building total
                    genuinely drops.
   Most of what's asserted here is that those two never get conflated. */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "roofmapper.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(){
  const sandbox = {};
  vm.createContext(sandbox);
  /* One contiguous slice: the geometry utilities through the metrics helper.
     Function declarations hoist, so the assignment helpers near the top can
     call rmOutlineHoleRings() further down. */
  vm.runInContext(
    between("function rmGeomHaversineMeters", "/* ---- Split a roof outline"),
    sandbox
  );
  /* Lives in the export section, well outside this slice. Identity keeps the
     SVG assertions about hole SUBPATHS rather than about projection math. */
  sandbox.rmExportProjectPoint = function(p){ return { x: p.lng, y: p.lat }; };
  return sandbox;
}

/* ~111m per 0.001 lat; ~85m per 0.001 lng at this latitude. Big enough that
   the 6m GPS ambiguity floor is a meaningful distance inside the shape. */
function rect(latMin, latMax, lngMin, lngMax){
  return [
    { lat: latMin, lng: lngMin },
    { lat: latMin, lng: lngMax },
    { lat: latMax, lng: lngMax },
    { lat: latMax, lng: lngMin },
    { lat: latMin, lng: lngMin }
  ];
}

const OUTER = rect(40.0000, 40.0020, -80.0020, -80.0000);
const INNER = rect(40.0008, 40.0012, -80.0012, -80.0008);

function donut(kind, sourceRoofId){
  return {
    ring: OUTER.slice(),
    holes: [{
      ring: INNER.slice(),
      kind: kind,
      sourceRoofId: sourceRoofId || null,
      sourceRoofLabel: sourceRoofId ? "Roof 8" : null
    }]
  };
}

/* ---- area: net vs gross ---- */

test("a roof with no cutouts is unchanged -- net equals gross", () => {
  const s = makeSandbox();
  const o = { ring: OUTER.slice() };
  s.rmRecomputeOutlineMetrics(o);
  assert.ok(o.areaSqFt > 0);
  assert.strictEqual(o.areaSqFt, o.grossAreaSqFt);
  assert.strictEqual(s.rmFormatOutlineArea(o).includes("net"), false,
    "an ordinary roof should read as one plain number");
});

test("areaSqFt is NET and grossAreaSqFt is retained", () => {
  const s = makeSandbox();
  const o = donut("roof", "r8");
  s.rmRecomputeOutlineMetrics(o);
  const holeSqFt = s.rmGeomPolygonAreaSqMeters(INNER) * 10.7639;
  assert.ok(o.grossAreaSqFt > o.areaSqFt, "gross must exceed net once something is cut out");
  assert.ok(Math.abs(o.grossAreaSqFt - o.areaSqFt - holeSqFt) < 1,
    "net should be gross minus exactly the hole area");
  assert.match(s.rmFormatOutlineArea(o), /net.*gross/, "both numbers should be shown");
});

test("a hole bigger than its roof clamps to zero, never negative square footage", () => {
  const s = makeSandbox();
  const o = { ring: INNER.slice(), holes: [{ ring: OUTER.slice(), kind: "void" }] };
  s.rmRecomputeOutlineMetrics(o);
  assert.strictEqual(o.areaSqFt, 0, "a report must never print negative area");
});

test("a void and a nested roof subtract identically -- the difference is bookkeeping", () => {
  const s = makeSandbox();
  const penthouse = donut("roof", "r8");
  const courtyard = donut("void", null);
  s.rmRecomputeOutlineMetrics(penthouse);
  s.rmRecomputeOutlineMetrics(courtyard);
  assert.strictEqual(penthouse.areaSqFt, courtyard.areaSqFt);
  assert.strictEqual(penthouse.perimeterFt, courtyard.perimeterFt);
});

/* ---- the regression that motivated the refactor ---- */

test("net area survives a later geometry edit", () => {
  const s = makeSandbox();
  const o = donut("roof", "r8");
  s.rmRecomputeOutlineMetrics(o);
  const netAfterCut = o.areaSqFt;
  /* Stand-in for any later vertex drag / square-up / re-snap, all of which
     recompute through this same helper. Before the refactor these recomputed
     from the outer ring inline and silently reverted net back to gross --
     the donut healing itself into a solid roof with nothing visibly wrong. */
  s.rmRecomputeOutlineMetrics(o);
  s.rmRecomputeOutlineMetrics(o);
  assert.strictEqual(o.areaSqFt, netAfterCut, "recompute must not revert net to gross");
  assert.ok(o.areaSqFt < o.grossAreaSqFt);
});

/* ---- perimeter ---- */

test("perimeter sums the outer ring AND the inner edge", () => {
  const s = makeSandbox();
  const plain = { ring: OUTER.slice() };
  const cut = donut("roof", "r8");
  s.rmRecomputeOutlineMetrics(plain);
  s.rmRecomputeOutlineMetrics(cut);
  const innerFt = s.rmGeomPolygonPerimeterMeters(INNER) * 3.28084;
  assert.ok(cut.perimeterFt > plain.perimeterFt,
    "the inner edge is real edge-metal termination and has to count");
  assert.ok(Math.abs(cut.perimeterFt - plain.perimeterFt - innerFt) < 0.5);
});

/* ---- calibration must carry the holes ---- */

test("scaling a roof scales its cutouts about the same centroid", () => {
  const s = makeSandbox();
  const o = donut("roof", "r8");
  s.rmRecomputeOutlineMetrics(o);
  const netBefore = o.areaSqFt, grossBefore = o.grossAreaSqFt;
  const centroid = s.rmGeomRingCentroid(o.ring);
  o.ring = o.ring.map((p) => s.rmGeomScalePoint(p, centroid, 2));
  s.rmScaleOutlineHoles(o, centroid, 2);
  s.rmRecomputeOutlineMetrics(o);
  /* Doubling every dimension quadruples both areas. If holes did NOT scale,
     net would come out too large -- the penthouse left at its old size while
     the roof around it grew. */
  assert.ok(Math.abs(o.grossAreaSqFt / grossBefore - 4) < 0.01);
  assert.ok(Math.abs(o.areaSqFt / netBefore - 4) < 0.01,
    "net must scale with the roof, meaning the hole scaled too");
});

/* ---- containment ---- */

test("a point inside the cutout is not on the donut", () => {
  const s = makeSandbox();
  const o = donut("roof", "r8");
  assert.strictEqual(s.rmOutlineContainsPoint(40.0010, -80.0010, o), false,
    "dead centre of the hole");
  assert.strictEqual(s.rmOutlineContainsPoint(40.0002, -80.0002, o), true,
    "out on the donut itself");
});

/* ---- GPS auto-assign ---- */

function roof(id, label, outline){
  return { id: id, label: label, roof_outlines: [outline] };
}

test("penthouse: a point in the hole assigns to the nested roof, confidently", () => {
  const s = makeSandbox();
  const roofs = [
    roof("r7", "Roof 7", donut("roof", "r8")),
    roof("r8", "Roof 8", { ring: INNER.slice() })
  ];
  const got = s.rmAssignPointToRoof(40.0010, -80.0010, roofs);
  assert.strictEqual(got.roofId, "r8", "the penthouse owns its own footprint");
  assert.strictEqual(got.ambiguous, false,
    "this used to match both roofs and come back ambiguous");
});

test("penthouse: standing near the shared wall is not flagged forever", () => {
  const s = makeSandbox();
  const roofs = [
    roof("r7", "Roof 7", donut("roof", "r8")),
    roof("r8", "Roof 8", { ring: INNER.slice() })
  ];
  /* ~4m outside the penthouse wall, on Roof 7 -- inside the 6m GPS floor. */
  const got = s.rmAssignPointToRoof(40.0010, -80.00075, roofs);
  assert.strictEqual(got.roofId, "r7");
  assert.strictEqual(got.ambiguous, false,
    "the shared edge is shared by construction, not a GPS question");
});

test("courtyard: a point in the void is not credited to the surrounding roof", () => {
  const s = makeSandbox();
  const roofs = [roof("r7", "Roof 7", donut("void", null))];
  const got = s.rmAssignPointToRoof(40.0010, -80.0010, roofs);
  assert.notStrictEqual(got.roofId, "r7",
    "a courtyard leak photo must not land on the surrounding roof's record");
  assert.strictEqual(got.outsideAll, true);
});

test("unrelated overlap is still flagged ambiguous", () => {
  const s = makeSandbox();
  /* Two roofs genuinely on top of each other, with no cutout relationship --
     the accidental-overlap case the ambiguity flag exists to catch. */
  const roofs = [
    roof("rA", "Roof A", { ring: OUTER.slice() }),
    roof("rB", "Roof B", { ring: rect(40.0005, 40.0025, -80.0015, -80.0005) })
  ];
  const got = s.rmAssignPointToRoof(40.0010, -80.0010, roofs);
  assert.strictEqual(got.ambiguous, true,
    "exempting nested roofs must not silence real overlap");
});

/* ---- rendering ---- */

test("SVG emits one subpath per hole so evenodd can punch it out", () => {
  const s = makeSandbox();
  const o = donut("roof", "r8");
  const d = s.rmOutlineHolesSvgPath(o, { lat: 40, lng: -80 }, (p) => p);
  assert.strictEqual((d.match(/M /g) || []).length, 1, "one subpath for one hole");
  assert.match(d, /Z$/, "the hole subpath has to close");
});

test("no cutouts means no extra subpath -- ordinary roofs render as before", () => {
  const s = makeSandbox();
  const d = s.rmOutlineHolesSvgPath({ ring: OUTER.slice() }, { lat: 40, lng: -80 }, (p) => p);
  assert.strictEqual(d, "");
});

test("Leaflet gets [outer, ...holes] so the live map draws a donut", () => {
  const s = makeSandbox();
  assert.strictEqual(s.rmOutlineLatLngRings(donut("roof", "r8")).length, 2);
  assert.strictEqual(s.rmOutlineLatLngRings({ ring: OUTER.slice() }).length, 1);
});

test("cutouts are described in words, by kind", () => {
  const s = makeSandbox();
  assert.match(s.rmDescribeOutlineHoles(donut("roof", "r8")), /Roof 8 cut out/);
  assert.match(s.rmDescribeOutlineHoles(donut("void", null)), /1 open area/);
  assert.strictEqual(s.rmDescribeOutlineHoles({ ring: OUTER.slice() }), "");
});

/* ---- malformed input ---- */

test("a degenerate hole ring is ignored rather than corrupting the area", () => {
  const s = makeSandbox();
  const o = { ring: OUTER.slice(), holes: [{ ring: [{ lat: 40, lng: -80 }], kind: "void" }] };
  s.rmRecomputeOutlineMetrics(o);
  assert.strictEqual(o.areaSqFt, o.grossAreaSqFt,
    "a two-point 'hole' has no area and must not change the number");
});
