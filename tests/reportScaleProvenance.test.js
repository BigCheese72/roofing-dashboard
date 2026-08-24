// Regression tests for the report-side scale-provenance rendering in
// js/export.js (issue #29, and its PR #30 review follow-ups REQUIRED 20/21).
//
// THE BUG THIS FILE EXISTS TO PREVENT: rmReportAppliedScaleClause() used to
// hardcode "the edge it was taken on has since been edited" for EVERY stale
// measurement -- but a stale measurement can mean two very different things:
//   - a real geometry edit (resnap/vertex-edit/square-up/align) genuinely
//     moved the edge, so the claim is true, OR
//   - the SAME edge was simply taped again (invalidatedReason ===
//     "superseded_by_remeasure") -- nothing moved, and asserting "edited"
//     there is a fabricated claim on a customer-facing PDF.
// Re-taping an edge and picking "Record only" produced exactly that
// fabrication, and it directly contradicted the Field Measurements table's
// own (correct) status for the identical record a few lines later.
//
// This loads the REAL js/roofmapper.js + js/core.js + js/export.js source
// (via vm, with minimal DOM/browser stubs -- these files are plain browser
// globals, not Node modules) and calls the REAL functions, not a hand-copied
// mirror of the logic. A mirror could drift silently out of sync with the
// actual file exactly the way the bug's own root cause did (a code comment
// claiming a safety property the code didn't have); loading the real source
// is what makes this test a genuine regression guard rather than a second,
// independently-maintained (and possibly wrong) description of the code.
//
// Verified (manually, once, during development -- see DEV_NOTES.md/the PR
// description for this file): every "must never regress" assertion below
// FAILS against the pre-#29-fix js/export.js (commit b9a1d87, which
// hardcoded the fabricated "has since been edited" string unconditionally)
// and PASSES against the current fixed source.
//
// Run: npm test
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadRoofOpsSandbox(){
  const noop = function(){};
  const stubEl = () => ({
    style: {}, classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute: noop, getAttribute: () => null, children: []
  });
  const sandbox = {
    console,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: stubEl, addEventListener: noop, body: stubEl()
    },
    navigator: { geolocation: {}, onLine: true, userAgent: "node-test" },
    L: {
      map: noop, tileLayer: noop, marker: noop, divIcon: noop, layerGroup: noop,
      polygon: noop, polyline: noop, circle: noop, circleMarker: noop, rectangle: noop,
      point: (x, y) => ({ x: x, y: y }), latLng: (a, b) => ({ lat: a, lng: b })
    },
    URL: { createObjectURL: noop, revokeObjectURL: noop },
    Image: function(){ this.addEventListener = noop; },
    Blob: function(){},
    addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hostname: "localhost", href: "http://localhost/", search: "" },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const root = path.join(__dirname, "..");
  ["js/roofmapper.js", "js/core.js", "js/export.js"].forEach(function(rel){
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    vm.runInContext(src, sandbox, { filename: rel });
  });
  return sandbox;
}

const sb = loadRoofOpsSandbox();

// A simple closed rectangle ring -- ~598ft / ~365ft / ~598ft / ~365ft sides
// at this latitude, matching the geometry used throughout PR #17/#30's own
// manual verification, so a reader comparing this file against the PR
// history recognizes the fixture.
const RING = [
  { lat: 35.0, lng: -80.001 }, { lat: 35.0, lng: -79.999 },
  { lat: 34.999, lng: -79.999 }, { lat: 34.999, lng: -80.001 },
  { lat: 35.0, lng: -80.001 }
];

function methodLine(outline){
  const s = sb.rmReportMethodSentences(outline);
  return s.captureSentence + " " + s.scaleSentence;
}

// =====================================================================
// (a) A real geometry edit (resnap) -- the edit claim is TRUE here, and
//     REQUIRED 4 (PR #17 review): a stale-but-still-applied tape must
//     disclose BOTH its staleness AND its real number -- never just one.
// =====================================================================
test("(a) resnap_neighbors: still discloses 'edge since edited', AND the real number via Field Measurements", () => {
  const now = Date.now();
  const outline = {
    id: "case-a", ring: RING, source: "geotiff_trace",
    edgeMeasurements: [{
      id: "m1", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use",
      source: "measured", measuredAt: now - 86400000, invalidatedAt: now, invalidatedReason: "resnap_neighbors"
    }]
  };
  const line = methodLine(outline);
  assert.match(line, /still applied; edge since edited by resnap neighbors/,
    "a genuine geometry edit must still say the edge was edited -- that claim is true here");
  // REQUIRED 4: staleness alone is not enough -- the real historical number
  // must still reach the reader (via the Field Measurements disclosure),
  // not just an abstract "it's stale" status.
  assert.match(line, /42\.5 ft on edge 1/,
    "REQUIRED 4: a stale-but-applied tape must disclose its real number, not just its staleness");
  assert.doesNotMatch(line, /not verified against a physical measurement/,
    "a measured roof (even a stale one) must never claim to be unverified");
});

test("(a2) vertex_edit: same geometry-edit family, same disclosure shape", () => {
  const now = Date.now();
  const outline = {
    id: "case-a2", ring: RING, source: "geotiff_trace",
    edgeMeasurements: [{
      id: "m1", edgeIndex: 2, measuredFt: 18.75, rescaleApplied: true, decision: "use",
      source: "measured", measuredAt: now - 86400000, invalidatedAt: now, invalidatedReason: "vertex_edit"
    }]
  };
  const line = methodLine(outline);
  assert.match(line, /still applied; edge since edited by vertex edit/);
  assert.match(line, /18\.8 ft on edge 3|18\.7 ft on edge 3/, "the real historical number must still surface");
});

// =====================================================================
// (b) THE #29 REPRO -- re-tape the SAME edge, pick "Record only". This is
//     the exact scenario that must never regress: nothing moved, so the
//     report must never claim the edge "has since been edited", and the
//     tape that's actually setting the scale must be named, not buried.
// =====================================================================
test("(b) #29 repro -- re-tape same edge + Record only: NO fabricated edit claim, ever", () => {
  const now = Date.now();
  const outline = {
    id: "case-b", ring: RING, source: "geotiff_trace",
    edgeMeasurements: [
      {
        id: "mOld", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use", source: "measured",
        measuredAt: now - 86400000, invalidatedAt: now, invalidatedReason: "superseded_by_remeasure"
      },
      {
        id: "mNew", edgeIndex: 0, measuredFt: 40, rescaleApplied: false, decision: "record_only",
        source: "measured", measuredAt: now
      }
    ]
  };
  const line = methodLine(outline);
  // THE regression this file exists to catch:
  assert.doesNotMatch(line, /has since been edited/i,
    "#29 REGRESSION: a re-tape (superseded_by_remeasure) must NEVER claim the edge was edited -- nothing moved");
  assert.doesNotMatch(line, /edge since edited/i,
    "#29 REGRESSION (alternate wording): same fabricated claim, must never appear for a plain re-tape");
  // REQUIRED 21: the tape that actually set the scale must be NAMED, not
  // just described abstractly and buried in a list.
  assert.match(line, /Scale set by field measurement \(42\.5 ft on edge 1\)/,
    "REQUIRED 21: the applied 42.5ft reading must be named directly in the applied-scale clause");
  // The unapplied "Record only" reading must still surface -- but as
  // genuinely ADDITIONAL information, not a duplicate of the applied one.
  assert.match(line, /40 ft on edge 1 \(recorded only\)/,
    "the declined re-tape must still be disclosed, distinctly");
  // REQUIRED 20: no verbatim duplication of the same record's status.
  const supersedeOccurrences = (line.match(/superseded by a later re-measurement/g) || []).length;
  assert.ok(supersedeOccurrences <= 1,
    "REQUIRED 20: the same record's status must not be printed twice in one method line");
});

test("#28 rmBuildScaleSource: record-only remeasure does not make the applied scale stale", () => {
  const now = Date.now();
  const outline = {
    id: "case-b-scale-source", ring: RING, source: "geotiff_trace",
    edgeMeasurements: [
      {
        id: "mOld", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use", source: "measured",
        measuredAt: now - 86400000, invalidatedAt: now, invalidatedReason: "superseded_by_remeasure"
      },
      {
        id: "mNew", edgeIndex: 0, measuredFt: 40, rescaleApplied: false, decision: "record_only",
        source: "measured", measuredAt: now
      }
    ]
  };

  const scaleSource = sb.rmBuildScaleSource(outline, sb.rmBuildCaptureSource(outline));

  assert.strictEqual(scaleSource.kind, "measured");
  assert.strictEqual(scaleSource.measurementStale, false,
    "#28: a newer record-only reading must not mean the applied edge moved");
  assert.strictEqual(scaleSource.edgeIndex, 0);
  assert.strictEqual(scaleSource.measuredFt, 42.5);
  assert.strictEqual(scaleSource.measurementId, "mOld");
  assert.strictEqual(scaleSource.measurementInvalidatedReason, null);
  assert.doesNotMatch(scaleSource.label, /edited|stale/i);
});

// =====================================================================
// (c) A clean, never-stale tape -- the ordinary case, must stay exactly
//     as simple as it always was.
// =====================================================================
test("(c) untouched measured edge: clean sentence, no staleness caveat at all", () => {
  const now = Date.now();
  const outline = {
    id: "case-c", ring: RING, source: "geotiff_trace",
    edgeMeasurements: [{
      id: "m1", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use",
      source: "measured", measuredAt: now
    }]
  };
  const line = methodLine(outline);
  assert.match(line, /^Traced from an RTK orthomosaic \(survey-grade\)\. Scale set by field measurement \(42\.5 ft on edge 1\)\.$/,
    "an untouched applied tape must render with no staleness/edit language whatsoever");
  assert.doesNotMatch(line, /edited|superseded|stale/i);
});

// =====================================================================
// "Not verified" must be reachable, but ONLY for a genuinely unmeasured
// roof -- never alongside any real measurement (REQUIRED 6, PR #17 review).
// =====================================================================
test("'not verified' appears for a genuinely unmeasured roof", () => {
  const outline = { id: "case-none", ring: RING, source: "manual_trace", edgeMeasurements: [] };
  const line = methodLine(outline);
  assert.match(line, /not verified against a physical measurement/);
});

test("'not verified' NEVER appears alongside a real measurement, in any case above", () => {
  const now = Date.now();
  const cases = [
    { id: "re-a", ring: RING, source: "geotiff_trace", edgeMeasurements: [
      { id: "m1", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use", source: "measured",
        measuredAt: now - 86400000, invalidatedAt: now, invalidatedReason: "resnap_neighbors" } ] },
    { id: "re-b", ring: RING, source: "geotiff_trace", edgeMeasurements: [
      { id: "mOld", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use", source: "measured",
        measuredAt: now - 86400000, invalidatedAt: now, invalidatedReason: "superseded_by_remeasure" },
      { id: "mNew", edgeIndex: 0, measuredFt: 40, rescaleApplied: false, decision: "record_only", source: "measured", measuredAt: now } ] },
    { id: "re-c", ring: RING, source: "geotiff_trace", edgeMeasurements: [
      { id: "m1", edgeIndex: 0, measuredFt: 42.5, rescaleApplied: true, decision: "use", source: "measured", measuredAt: now } ] }
  ];
  cases.forEach(function(outline){
    const line = methodLine(outline);
    assert.doesNotMatch(line, /not verified against a physical measurement/,
      "outline " + outline.id + ": a real measurement exists, 'not verified' must not appear");
  });
});

// =====================================================================
// The "(applied)" leak (PR #30 review, first REQUIRED): ss.measurementStale
// true but the freshly re-derived record has no invalidatedAt must fall
// back to honest silence, never a confident, contentless "(applied)".
// =====================================================================
test("stale flag with no corroborating invalidated record: honest silence, never a fabricated '(applied)'", () => {
  const ss = { kind: "measured", measurementStale: true, measurementInvalidatedReason: null };
  const outline = { edgeMeasurements: [] }; // rmLatestAppliedMeasuredEdge() finds nothing
  const clause = sb.rmReportAppliedScaleClause(ss, outline);
  assert.doesNotMatch(clause.text, /\(applied\)/,
    "a disagreement between the stale flag and the live record must never render a bare '(applied)'");
  assert.strictEqual(clause.text, "Scale set by a field measurement on this roof.");
});
