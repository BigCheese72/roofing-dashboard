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
    },
    rmComputeOrthoBoundsForImageUrl: async () => ({
      orthoBounds: { north: 1, south: 0, east: 1, west: 0 }
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between("function inlineRoofById", "function inlineHistoryOutlines"),
    sandbox
  );
  return sandbox;
}

test("inline history falls back to the first roof with a base map", async () => {
  const sandbox = makeSandbox();
  const roofs = [
    { id: "roof1", label: "Roof 1" },
    { id: "roof7", label: "Roof 7", roof_base_map_type: "sketch", roof_base_map_url: "roof7.jpg" }
  ];

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.selectedRoof.id, "roof1");
  assert.strictEqual(base.sourceRoof.id, "roof7");
  assert.strictEqual(base.fromSelectedRoof, false);
  assert.strictEqual(base.customBld.id, "roof7");
});

test("synthetic RoofMapper orthos resolve as georeferenced overlays", async () => {
  const sandbox = makeSandbox();
  const roofs = [
    {
      id: "roof1",
      label: "Roof 1",
      roof_base_map_type: "sketch",
      roof_base_map_url: "synthetic.jpg",
      roof_base_map_synthetic: true
    }
  ];

  const base = await sandbox.inlineResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(base.customBld, null);
  assert.strictEqual(base.syntheticOrtho, true);
  assert.strictEqual(base.orthoOverlay.url, "synthetic.jpg");
  assert.strictEqual(base.orthoOverlay.bounds.north, 1);
  assert.strictEqual(base.orthoOverlay.bounds.south, 0);
  assert.strictEqual(base.orthoOverlay.bounds.east, 1);
  assert.strictEqual(base.orthoOverlay.bounds.west, 0);
});

test("synthetic ortho map path keeps GPS pins because it is not custom x/y mode", () => {
  const sandbox = makeSandbox();
  const events = [{ pins: [
    { roofId: "roof1", lat: 40, lng: -90 },
    { roofId: "roof2", lat: 41, lng: -91 },
    { roofId: "roof1", x: 0.3, y: 0.4 }
  ] }];

  const pins = sandbox.inlineHistoryPinsForMap(events, "roof1", false);

  assert.strictEqual(pins.length, 2);
  assert.ok(pins.every((p) => typeof p.lat === "number" && typeof p.lng === "number"));
});

test("non-georeferenced drawings disclose GPS and other-roof pins they cannot show", () => {
  const sandbox = makeSandbox();
  const events = [{ pins: [
    { roofId: "roof1", x: 0.2, y: 0.3 },
    { roofId: "roof1", lat: 40, lng: -90 },
    { roofId: "roof2", x: 0.7, y: 0.8 },
    { roofId: "roof2", lat: 41, lng: -91 }
  ] }];

  const visible = sandbox.inlineHistoryPinsForMap(events, "roof1", true);
  const disclosure = sandbox.inlineHiddenPinDisclosure(events, "roof1", true);

  assert.strictEqual(visible.length, 1);
  assert.match(disclosure, /2 GPS-placed findings can't be shown/);
  assert.match(disclosure, /1 finding pinned to other roof drawings is not shown here/);
});
