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

function makeSandbox(){
  const sandbox = {
    esc(value){
      return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch]));
    },
    getRoofById(building, roofId){
      return ((building && building.roofs) || []).find((r) => r.id === roofId) || null;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between("function inlineRoofById", "function inlineHistoryOutlines"),
    sandbox
  );
  return sandbox;
}

function keySet(items){
  return Array.from(items, (item) => String(item._inlineKey)).sort();
}

function unionKeys(left, right){
  return Array.from(new Set([...keySet(left), ...keySet(right)])).sort();
}

function intersectionKeys(left, right){
  const rightKeys = new Set(keySet(right));
  return keySet(left).filter((key) => rightKeys.has(key)).sort();
}

function assertCoverage(coverage, label){
  assert.strictEqual(
    new Set(keySet(coverage.full)).size,
    coverage.full.length,
    label + " full set keys are unique"
  );
  assert.deepStrictEqual(
    unionKeys(coverage.rendered, coverage.disclosed),
    keySet(coverage.full),
    label + " rendered plus disclosed covers the full set"
  );
  assert.deepStrictEqual(
    intersectionKeys(coverage.rendered, coverage.disclosed),
    [],
    label + " rendered and disclosed are disjoint"
  );
  assert.strictEqual(
    disclosureCount(coverage.disclosure),
    coverage.disclosed.length,
    label + " disclosure counts every disclosed item"
  );
}

function disclosureCount(disclosure){
  return Array.from(String(disclosure || "").matchAll(/(?:^|\. )(\d+) /g))
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

function mixedEvents(){
  return [{ date: "2026-07-01", pins: [
    { id: "selected-gps", roofId: "roof1", lat: 40, lng: -90 },
    { id: "selected-xy", roofId: "roof1", x: 0.3, y: 0.4 },
    { id: "other-gps", roofId: "roof2", lat: 41, lng: -91 },
    { id: "other-xy", roofId: "roof2", x: 0.7, y: 0.8 },
    { id: "legacy-gps", lat: 42, lng: -92 },
    { id: "legacy-xy", x: 0.11, y: 0.22 },
    { id: "empty", roofId: "roof1" }
  ] }];
}

function mixedRoofs(baseFields){
  return [
    Object.assign({
      id: "roof1",
      label: "Roof 1",
      roof_assets: [
        { id: "asset-selected-gps", lat: 40, lng: -90 },
        { id: "asset-selected-xy", x: 0.1, y: 0.2 },
        { id: "asset-empty" }
      ]
    }, baseFields || {}),
    {
      id: "roof2",
      label: "Roof 2",
      roof_assets: [
        { id: "asset-other-gps", lat: 41, lng: -91 },
        { id: "asset-other-xy", x: 0.6, y: 0.7 }
      ]
    }
  ];
}

function singleNamedRoof(baseFields){
  return [
    Object.assign({
      id: "roof1",
      label: "Roof 1",
      roof_assets: [
        { id: "asset-selected-gps", lat: 40, lng: -90 },
        { id: "asset-selected-xy", x: 0.1, y: 0.2 }
      ]
    }, baseFields || {})
  ];
}

function singleNamedRoofLegacyEvents(){
  return [{ date: "2026-07-01", pins: [
    { id: "selected-gps", roofId: "roof1", lat: 40, lng: -90 },
    { id: "legacy-gps", lat: 42, lng: -92 },
    { id: "legacy-xy", x: 0.11, y: 0.22 }
  ] }];
}

function syntheticOrthoComputer(bounds){
  return async function(url){
    return {
      url,
      orthoBounds: bounds || { north: 41.1, south: 41.0, east: -87.9, west: -88.0 }
    };
  };
}

test("inline history does not borrow another roof's sketch base map", async () => {
  const sandbox = makeSandbox();
  const roofs = [
    { id: "roof1", label: "Roof 1" },
    { id: "roof7", label: "Roof 7", roof_base_map_type: "sketch", roof_base_map_url: "roof7.jpg" }
  ];

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.selectedRoof.id, "roof1");
  assert.strictEqual(base.sourceRoof, null);
  assert.strictEqual(base.fromSelectedRoof, false);
  assert.strictEqual(base.customBld, null);
  assert.strictEqual(base.orthoOverlay, null);
  assert.strictEqual(base.syntheticOrtho, false);
  assert.strictEqual(
    sandbox.inlineNoBaseMapNotice(roofs, "roof1"),
    "No base map drawn for Roof 1. Roof 7 has one - switch roofs to view it."
  );
});

test("inline history shows sibling base-map notice instead of empty state", async () => {
  const sandbox = makeSandbox();
  const roofs = [
    { id: "roof1", label: "Roof 1" },
    { id: "roof7", label: "Roof 7", roof_base_map_type: "sketch", roof_base_map_url: "roof7.jpg" }
  ];
  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");
  const html = sandbox.inlineHistoryMapHtml(
    false,
    sandbox.inlineHistoryMapLabel(false, null, base, base.selectedRoof),
    sandbox.inlineNoBaseMapNotice(roofs, "roof1", base.selectedRoof),
    ""
  );

  assert.match(html, /No base map drawn for Roof 1\. Roof 7 has one - switch roofs to view it\./);
  assert.doesNotMatch(
    html,
    /No saved roof base map, outline, feature, or pin is available for this building yet\./
  );
  assert.doesNotMatch(html, /wo-inline-building-map/);
});

test("inline history falls back to a sibling drone ortho with real bounds", async () => {
  const sandbox = makeSandbox();
  const bounds = { north: 41.1, south: 41.0, east: -87.9, west: -88.0 };
  const roofs = [
    { id: "roof1", label: "Roof 1" },
    { id: "roof7", label: "Roof 7", roof_base_map_type: "drone_ortho", roof_base_map_url: "roof7-ortho.jpg", roof_base_map_bounds: bounds }
  ];

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.selectedRoof.id, "roof1");
  assert.strictEqual(base.sourceRoof.id, "roof7");
  assert.strictEqual(base.fromSelectedRoof, false);
  assert.strictEqual(base.customBld, null);
  assert.strictEqual(base.orthoOverlay.url, "roof7-ortho.jpg");
  assert.strictEqual(base.orthoOverlay.bounds.north, bounds.north);
  assert.strictEqual(base.orthoOverlay.bounds.south, bounds.south);
  assert.strictEqual(base.orthoOverlay.bounds.east, bounds.east);
  assert.strictEqual(base.orthoOverlay.bounds.west, bounds.west);
  assert.strictEqual(sandbox.inlineNoBaseMapNotice(roofs, "roof1", base.selectedRoof), "No base map drawn for Roof 1. Roof 7 has one - switch roofs to view it.");
  assert.strictEqual(
    sandbox.inlineHistoryMapLabel(false, base.orthoOverlay, base, base.selectedRoof),
    "Base map from <b>Roof 7</b> (building-wide)."
  );
});

test("inline history distinguishes buildings with no base map anywhere", () => {
  const sandbox = makeSandbox();
  const roofs = [
    { id: "roof1", label: "Roof 1" },
    { id: "roof2", label: "Roof 2" }
  ];

  assert.strictEqual(
    sandbox.inlineNoBaseMapNotice(roofs, "roof1"),
    "No base map has been drawn for this building yet."
  );
});

test("synthetic RoofMapper orthos use computed georeferenced overlay bounds", async () => {
  const sandbox = makeSandbox();
  const bounds = { north: 41.15, south: 41.05, east: -87.85, west: -87.95 };
  sandbox.rmComputeOrthoBoundsForImageUrl = syntheticOrthoComputer(bounds);
  const roofs = mixedRoofs({
    roof_base_map_type: "sketch",
    roof_base_map_url: "synthetic.jpg",
    roof_base_map_synthetic: true
  });

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.customBld, null);
  assert.strictEqual(base.syntheticOrtho, false);
  assert.strictEqual(base.orthoOverlay.url, "synthetic.jpg");
  assert.deepStrictEqual(base.orthoOverlay.bounds, bounds);
  assert.strictEqual(
    sandbox.inlineHistoryMapLabel(false, base.orthoOverlay, base, roofs[0]),
    "Building-wide roof map on the saved drone orthophoto."
  );
});

test("inline history can use a sibling synthetic RoofMapper ortho as a georeferenced fallback", async () => {
  const sandbox = makeSandbox();
  const bounds = { north: 41.2, south: 41.1, east: -87.7, west: -87.8 };
  sandbox.rmComputeOrthoBoundsForImageUrl = syntheticOrthoComputer(bounds);
  const roofs = [
    { id: "roof1", label: "Roof 1" },
    {
      id: "roof7",
      label: "Roof 7",
      roof_base_map_type: "sketch",
      roof_base_map_url: "roof7-synthetic.jpg",
      roof_base_map_synthetic: true
    }
  ];

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.selectedRoof.id, "roof1");
  assert.strictEqual(base.sourceRoof.id, "roof7");
  assert.strictEqual(base.fromSelectedRoof, false);
  assert.strictEqual(base.customBld, null);
  assert.strictEqual(base.syntheticOrtho, false);
  assert.strictEqual(base.orthoOverlay.url, "roof7-synthetic.jpg");
  assert.deepStrictEqual(base.orthoOverlay.bounds, bounds);
  assert.strictEqual(
    sandbox.inlineHistoryMapLabel(false, base.orthoOverlay, base, base.selectedRoof),
    "Base map from <b>Roof 7</b> (building-wide)."
  );
});

test("genuine drone orthos use their persisted real-world bounds", async () => {
  const sandbox = makeSandbox();
  const roofs = mixedRoofs({
    roof_base_map_type: "drone_ortho",
    roof_base_map_url: "ortho.jpg",
    roof_base_map_bounds: { north: 41.1, south: 41.0, east: -87.9, west: -88.0 }
  });

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.customBld, null);
  assert.deepStrictEqual(base.orthoOverlay.bounds, roofs[0].roof_base_map_bounds);
  assert.ok(Math.abs(base.orthoOverlay.bounds.north) > 1);
  assert.ok(Math.abs(base.orthoOverlay.bounds.east) > 1);
  assert.strictEqual(
    sandbox.inlineHistoryMapLabel(false, base.orthoOverlay, base, roofs[0]),
    "Building-wide roof map on the saved drone orthophoto."
  );
});

test("plain satellite label does not attribute building-wide GPS pins to one roof", () => {
  const sandbox = makeSandbox();

  assert.strictEqual(
    sandbox.inlineHistoryMapLabel(false, null, { sourceRoof: null, fromSelectedRoof: false }, { id: "roof3", label: "Roof 3" }),
    "Building-wide roof map."
  );
});

[
  {
    name: "roof plan custom base map",
    baseFields: { roof_base_map_type: "roof_plan", roof_base_map_url: "plan.jpg" },
    hasCustomBaseMap: true,
    expectedPinIds: ["selected-xy"],
    expectedAssetIds: ["asset-selected-xy"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /GPS-placed finding/],
    assetDisclosure: [/features from other roofs/, /GPS-placed feature/]
  },
  {
    name: "sketch custom base map",
    baseFields: { roof_base_map_type: "sketch", roof_base_map_url: "sketch.jpg" },
    hasCustomBaseMap: true,
    expectedPinIds: ["selected-xy"],
    expectedAssetIds: ["asset-selected-xy"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /GPS-placed finding/],
    assetDisclosure: [/features from other roofs/, /GPS-placed feature/]
  },
  {
    name: "synthetic RoofMapper ortho as georeferenced overlay",
    baseFields: { roof_base_map_type: "sketch", roof_base_map_url: "synthetic.jpg", roof_base_map_synthetic: true },
    computeSyntheticBounds: true,
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps", "other-gps", "legacy-gps"],
    expectedAssetIds: ["asset-selected-gps", "asset-other-gps"],
    pinDisclosure: [/image-placed finding/],
    pinDisclosureAbsent: [/pinned to other roofs/, /legacy unassigned findings/],
    assetDisclosure: [/image-placed feature/],
    assetDisclosureAbsent: [/features from other roofs/]
  },
  {
    name: "genuine drone ortho satellite overlay",
    baseFields: {
      roof_base_map_type: "drone_ortho",
      roof_base_map_url: "ortho.jpg",
      roof_base_map_bounds: { north: 41.1, south: 41.0, east: -87.9, west: -88.0 }
    },
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps", "other-gps", "legacy-gps"],
    expectedAssetIds: ["asset-selected-gps", "asset-other-gps"],
    pinDisclosure: [/image-placed finding/],
    pinDisclosureAbsent: [/pinned to other roofs/, /legacy unassigned findings/],
    assetDisclosure: [/image-placed feature/],
    assetDisclosureAbsent: [/features from other roofs/]
  },
  {
    name: "plain satellite with no base map",
    baseFields: {},
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps", "other-gps", "legacy-gps"],
    expectedAssetIds: ["asset-selected-gps", "asset-other-gps"],
    pinDisclosure: [/image-placed finding/],
    pinDisclosureAbsent: [/pinned to other roofs/, /legacy unassigned findings/],
    assetDisclosure: [/image-placed feature/],
    assetDisclosureAbsent: [/features from other roofs/]
  },
  {
    name: "plain satellite when only a sibling roof has a base map",
    baseFields: {},
    roofs: function(){
      return [
        { id: "roof1", label: "Roof 1", roof_assets: [
          { id: "asset-selected-gps", lat: 40, lng: -90 },
          { id: "asset-selected-xy", x: 0.1, y: 0.2 }
        ] },
        { id: "roof7", label: "Roof 7", roof_base_map_type: "sketch", roof_base_map_url: "roof7.jpg", roof_assets: [
          { id: "asset-other-gps", lat: 41, lng: -91 },
          { id: "asset-other-xy", x: 0.6, y: 0.7 }
        ] }
      ];
    },
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps", "other-gps", "legacy-gps"],
    expectedAssetIds: ["asset-selected-gps", "asset-other-gps"],
    pinDisclosure: [/image-placed finding/],
    pinDisclosureAbsent: [/pinned to other roofs/, /legacy unassigned findings/],
    assetDisclosure: [/image-placed feature/],
    assetDisclosureAbsent: [/features from other roofs/]
  },
  {
    name: "plain satellite with one named roof and legacy pins",
    baseFields: {},
    roofs: singleNamedRoof,
    events: singleNamedRoofLegacyEvents,
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps", "legacy-gps"],
    expectedAssetIds: ["asset-selected-gps"],
    pinDisclosure: [/image-placed finding/],
    pinDisclosureAbsent: [/pinned to other roofs/, /legacy unassigned findings/],
    assetDisclosure: [/image-placed feature/]
  }
].forEach((mode) => {
  test("coverage invariant holds for " + mode.name, async () => {
    const sandbox = makeSandbox();
    if (mode.computeSyntheticBounds) sandbox.rmComputeOrthoBoundsForImageUrl = syntheticOrthoComputer();
    const roofs = mode.roofs ? mode.roofs(mode.baseFields) : mixedRoofs(mode.baseFields);
    const events = mode.events ? mode.events() : mixedEvents();
    const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");
    const hasCustomBaseMap = !!base.customBld;

    assert.strictEqual(hasCustomBaseMap, mode.hasCustomBaseMap);

    const pinCoverage = sandbox.inlineHistoryPinCoverage(events, "roof1", hasCustomBaseMap);
    const assetCoverage = sandbox.inlineHistoryAssetCoverage(roofs, roofs[0], hasCustomBaseMap);

    assertCoverage(pinCoverage, mode.name + " pins");
    assertCoverage(assetCoverage, mode.name + " assets");
    assert.deepStrictEqual(Array.from(pinCoverage.rendered, (p) => p.id).sort(), mode.expectedPinIds.slice().sort());
    assert.deepStrictEqual(Array.from(assetCoverage.rendered, (a) => a.id).sort(), mode.expectedAssetIds.slice().sort());
    mode.pinDisclosure.forEach((pattern) => assert.match(pinCoverage.disclosure, pattern));
    (mode.pinDisclosureAbsent || []).forEach((pattern) => assert.doesNotMatch(pinCoverage.disclosure, pattern));
    mode.assetDisclosure.forEach((pattern) => assert.match(assetCoverage.disclosure, pattern));
    (mode.assetDisclosureAbsent || []).forEach((pattern) => assert.doesNotMatch(assetCoverage.disclosure, pattern));
  });
});

test("asset coverage keys are positional so roof ids cannot collide with indexes", () => {
  const sandbox = makeSandbox();
  const roofs = [
    { label: "No id", roof_assets: [{ id: "A-xy", x: 0.2, y: 0.3 }] },
    { id: "0", label: "String zero", roof_assets: [{ id: "B-gps", lat: 40, lng: -90 }] }
  ];

  const coverage = sandbox.inlineHistoryAssetCoverage(roofs, roofs[1], false);

  assertCoverage(coverage, "asset key collision guard");
  assert.deepStrictEqual(Array.from(coverage.rendered, (a) => a.id), ["B-gps"]);
  assert.deepStrictEqual(Array.from(coverage.disclosed, (a) => a.id), ["A-xy"]);
});

test("dual-coordinate pins on another roof disclose the roof mismatch first", () => {
  const sandbox = makeSandbox();
  const events = [{ pins: [
    { id: "selected-xy", roofId: "roof1", x: 0.2, y: 0.3 },
    { id: "other-both", roofId: "roof2", x: 0.7, y: 0.8, lat: 41, lng: -91 }
  ] }];
  const roofs = mixedRoofs({ roof_base_map_type: "roof_plan", roof_base_map_url: "plan.jpg" });

  const coverage = sandbox.inlineHistoryPinCoverage(events, "roof1", true);

  assertCoverage(coverage, "dual-coordinate pins");
  assert.doesNotMatch(coverage.disclosure, /GPS-placed/);
  assert.match(coverage.disclosure, /1 finding pinned to other roofs is not shown here/);
});

test("location-less pins and assets are disclosed instead of dropped from coverage", () => {
  const sandbox = makeSandbox();
  const events = [{ pins: [
    { id: "selected-gps", roofId: "roof1", lat: 40, lng: -90 },
    { id: "missing-location", roofId: "roof1" }
  ] }];
  const roofs = [{
    id: "roof1",
    label: "Roof 1",
    roof_assets: [
      { id: "asset-gps", lat: 40, lng: -90 },
      { id: "asset-missing-location" }
    ]
  }];

  const pinCoverage = sandbox.inlineHistoryPinCoverage(events, "roof1", false);
  const assetCoverage = sandbox.inlineHistoryAssetCoverage(roofs, roofs[0], false);

  assertCoverage(pinCoverage, "location-less pins");
  assertCoverage(assetCoverage, "location-less assets");
  assert.deepStrictEqual(Array.from(pinCoverage.rendered, (p) => p.id), ["selected-gps"]);
  assert.deepStrictEqual(Array.from(pinCoverage.disclosed, (p) => p.id), ["missing-location"]);
  assert.deepStrictEqual(Array.from(assetCoverage.rendered, (a) => a.id), ["asset-gps"]);
  assert.deepStrictEqual(Array.from(assetCoverage.disclosed, (a) => a.id), ["asset-missing-location"]);
  assert.match(pinCoverage.disclosure, /1 finding has no saved location/);
  assert.match(assetCoverage.disclosure, /1 feature has no saved location/);
});

test("Inspection hide-existing-pins toggle is display-only coverage", () => {
  const sandbox = makeSandbox();
  const fullPins = sandbox.inlineAllHistoryPins(mixedEvents());
  const coverage = sandbox.inlineHistoryHiddenSessionPinCoverage(fullPins);

  assert.strictEqual(coverage.rendered.length, 0);
  assert.deepStrictEqual(keySet(coverage.disclosed), keySet(fullPins));
  assert.match(coverage.disclosure, /7 existing pins hidden for this Inspection session/);
  assertCoverage(coverage, "hidden Inspection pins");
});

test("hide-existing-pins control only appears for Inspection history with pins", () => {
  const sandbox = makeSandbox();

  assert.match(
    sandbox.inlineHistoryPinToggleHtml(true, 2, false),
    /type="checkbox"[^>]*>Hide existing pins/
  );
  assert.match(sandbox.inlineHistoryPinToggleHtml(true, 2, true), /checked/);
  assert.strictEqual(sandbox.inlineHistoryPinToggleHtml(false, 2, false), "");
  assert.strictEqual(sandbox.inlineHistoryPinToggleHtml(true, 0, false), "");
});
