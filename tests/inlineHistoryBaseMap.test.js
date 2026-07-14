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
  assert.strictEqual(base.syntheticOrthoError, "");
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
    assetDisclosure: [/features from other roof drawings/, /GPS-placed feature/]
  },
  {
    name: "sketch custom base map",
    baseFields: { roof_base_map_type: "sketch", roof_base_map_url: "sketch.jpg" },
    hasCustomBaseMap: true,
    expectedPinIds: ["selected-xy"],
    expectedAssetIds: ["asset-selected-xy"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /GPS-placed finding/],
    assetDisclosure: [/features from other roof drawings/, /GPS-placed feature/]
  },
  {
    name: "synthetic RoofMapper ortho as custom base map",
    baseFields: { roof_base_map_type: "sketch", roof_base_map_url: "synthetic.jpg", roof_base_map_synthetic: true },
    hasCustomBaseMap: true,
    expectedPinIds: ["selected-xy"],
    expectedAssetIds: ["asset-selected-xy"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /GPS-placed finding/],
    assetDisclosure: [/features from other roof drawings/, /GPS-placed feature/]
  },
  {
    name: "genuine drone ortho satellite overlay",
    baseFields: {
      roof_base_map_type: "drone_ortho",
      roof_base_map_url: "ortho.jpg",
      roof_base_map_bounds: { north: 41.1, south: 41.0, east: -87.9, west: -88.0 }
    },
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps"],
    expectedAssetIds: ["asset-selected-gps", "asset-other-gps"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /image-placed finding/],
    assetDisclosure: [/image-placed features/]
  },
  {
    name: "plain satellite with no base map",
    baseFields: {},
    hasCustomBaseMap: false,
    expectedPinIds: ["selected-gps"],
    expectedAssetIds: ["asset-selected-gps", "asset-other-gps"],
    pinDisclosure: [/pinned to other roofs/, /legacy unassigned findings/, /image-placed finding/],
    assetDisclosure: [/image-placed features/]
  }
].forEach((mode) => {
  test("coverage invariant holds for " + mode.name, async () => {
    const sandbox = makeSandbox();
    const roofs = mixedRoofs(mode.baseFields);
    const events = mixedEvents();
    const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");
    const hasCustomBaseMap = !!base.customBld;

    assert.strictEqual(hasCustomBaseMap, mode.hasCustomBaseMap);

    const pinCoverage = sandbox.inlineHistoryPinCoverage(events, "roof1", hasCustomBaseMap, roofs);
    const assetCoverage = sandbox.inlineHistoryAssetCoverage(roofs, roofs[0], hasCustomBaseMap);

    assertCoverage(pinCoverage, mode.name + " pins");
    assertCoverage(assetCoverage, mode.name + " assets");
    assert.deepStrictEqual(Array.from(pinCoverage.rendered, (p) => p.id).sort(), mode.expectedPinIds.slice().sort());
    assert.deepStrictEqual(Array.from(assetCoverage.rendered, (a) => a.id).sort(), mode.expectedAssetIds.slice().sort());
    mode.pinDisclosure.forEach((pattern) => assert.match(pinCoverage.disclosure, pattern));
    mode.assetDisclosure.forEach((pattern) => assert.match(assetCoverage.disclosure, pattern));
  });
});

test("dual-coordinate pins on another roof disclose the roof mismatch first", () => {
  const sandbox = makeSandbox();
  const events = [{ pins: [
    { id: "selected-xy", roofId: "roof1", x: 0.2, y: 0.3 },
    { id: "other-both", roofId: "roof2", x: 0.7, y: 0.8, lat: 41, lng: -91 }
  ] }];
  const roofs = mixedRoofs({ roof_base_map_type: "roof_plan", roof_base_map_url: "plan.jpg" });

  const coverage = sandbox.inlineHistoryPinCoverage(events, "roof1", true, roofs);

  assertCoverage(coverage, "dual-coordinate pins");
  assert.doesNotMatch(coverage.disclosure, /GPS-placed/);
  assert.match(coverage.disclosure, /1 finding pinned to other roofs is not shown here/);
});
