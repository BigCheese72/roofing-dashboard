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

test("inline history does not borrow another roof's base map", async () => {
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

test("synthetic RoofMapper orthos stay in the local image frame", async () => {
  const sandbox = makeSandbox();
  const roofs = mixedRoofs({
    roof_base_map_type: "sketch",
    roof_base_map_url: "synthetic.jpg",
    roof_base_map_synthetic: true
  });

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.customBld.id, "roof1");
  assert.strictEqual(base.syntheticOrtho, true);
  assert.strictEqual(base.orthoOverlay, null);
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
    name: "synthetic RoofMapper ortho as custom base map",
    baseFields: { roof_base_map_type: "sketch", roof_base_map_url: "synthetic.jpg", roof_base_map_synthetic: true },
    hasCustomBaseMap: true,
    expectedPinIds: ["selected-xy"],
    expectedAssetIds: ["asset-selected-xy"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /GPS-placed finding/],
    assetDisclosure: [/features from other roofs/, /GPS-placed feature/]
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
