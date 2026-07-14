/* Regression tests for issue #39 — the leak-investigation pin-drop map
   silently ignoring a saved base map, and (the dangerous half) destroying a
   finding's real GPS pin when a non-georeferenced drawing turned on. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");

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
  vm.runInContext(
    between("function photosRoofHasBaseMap", "async function lookupProspectiveBuildingBaseMap"),
    sandbox
  );
  return sandbox;
}

const PLAN = { roof_base_map_type: "roof_plan", roof_base_map_url: "https://x/plan.png" };
const ORTHO = {
  roof_base_map_type: "drone_ortho",
  roof_base_map_url: "https://x/ortho.png",
  roof_base_map_bounds: { north: 1, south: 0, east: 1, west: 0 }
};

test("THE BUG: a base map attached to a roof other than the selected one is still found", () => {
  const s = makeSandbox();
  /* Tri-Delta shape: 11 roofs, the ortho lives on roof 7, no roof selected.
     The old resolver read roofs[0], found no base map, and silently fell
     back to plain satellite. */
  const roofs = [];
  for (let i = 1; i <= 11; i++) roofs.push({ id: "roof" + i, label: "Roof " + i });
  Object.assign(roofs[6], ORTHO);

  const got = s.photosResolveBuildingBaseMap(roofs, null);

  assert.ok(got, "base map must be found somewhere in the building, not just on roofs[0]");
  assert.strictEqual(got.url, "https://x/ortho.png");
  assert.strictEqual(got.sourceRoofLabel, "Roof 7");
  assert.strictEqual(got.georeferenced, true);
  assert.strictEqual(got.fromSelectedRoof, false, "must admit this is not the selected roof's map");
});

test("the selected roof's own base map wins over a sibling's", () => {
  const s = makeSandbox();
  const roofs = [
    Object.assign({ id: "roof1", label: "Roof 1" }, ORTHO),
    Object.assign({ id: "roof2", label: "Roof 2" }, PLAN)
  ];

  const got = s.photosResolveBuildingBaseMap(roofs, "roof2");

  assert.strictEqual(got.sourceRoofLabel, "Roof 2");
  assert.strictEqual(got.type, "roof_plan");
  assert.strictEqual(got.fromSelectedRoof, true);
});

test("a borrowed base map is always attributed to the roof it came from", () => {
  const s = makeSandbox();
  const roofs = [
    { id: "roof1", label: "Main Roof" },
    Object.assign({ id: "roof2", label: "Boiler House" }, PLAN)
  ];

  const got = s.photosResolveBuildingBaseMap(roofs, "roof1");

  assert.strictEqual(got.fromSelectedRoof, false);
  assert.strictEqual(got.sourceRoofLabel, "Boiler House");
  assert.strictEqual(got.sourceRoofId, "roof2");
});

test("a drone_ortho with no bounds is not usable as a georeferenced base map", () => {
  const s = makeSandbox();
  /* No bounds = nothing to place the image against on a real-world map.
     It must not be reported as georeferenced, and must not be silently
     promoted into the satellite overlay path. */
  const roofs = [{ id: "roof1", label: "Roof 1", roof_base_map_type: "drone_ortho", roof_base_map_url: "https://x/o.png" }];

  assert.strictEqual(s.photosRoofHasBaseMap(roofs[0]), false);
  assert.strictEqual(s.photosResolveBuildingBaseMap(roofs, "roof1"), null);
});

test("no roof in the building has a base map -> null (satellite, as before)", () => {
  const s = makeSandbox();
  const roofs = [{ id: "roof1", label: "Roof 1" }, { id: "roof2", label: "Roof 2" }];
  assert.strictEqual(s.photosResolveBuildingBaseMap(roofs, "roof1"), null);
  assert.strictEqual(s.photosResolveBuildingBaseMap([], "roof1"), null);
  assert.strictEqual(s.photosResolveBuildingBaseMap(null, null), null);
});

test("THE DANGEROUS HALF: a GPS-only pin is recognised as unplottable on a drawing", () => {
  const s = makeSandbox();
  /* This is the guard that stops openPinModal() from switching a real GPS
     finding onto a CRS.Simple drawing, where the marker was dropped at the
     image centre and savePinFromModal() then overwrote the true coordinate
     as {lat:null, lng:null, x:0.5, y:0.5, source:"tech_placed"}. */
  assert.strictEqual(s.photosPinIsGpsOnly({ lat: 40.1, lng: -90.2, x: null, y: null, source: "photo_gps" }), true);
  assert.strictEqual(s.photosPinIsGpsOnly({ lat: 40.1, lng: -90.2 }), true);
});

test("pins that CAN be shown on a drawing are not diverted to satellite", () => {
  const s = makeSandbox();
  assert.strictEqual(s.photosPinIsGpsOnly({ x: 0.2, y: 0.3, lat: null, lng: null }), false, "x/y pin belongs on the drawing");
  assert.strictEqual(s.photosPinIsGpsOnly({ lat: 40.1, lng: -90.2, x: 0.2, y: 0.3 }), false, "dual-coordinate pin can be plotted");
  assert.strictEqual(s.photosPinIsGpsOnly(null), false, "a finding with no pin yet gets the drawing");
  assert.strictEqual(s.photosPinIsGpsOnly(undefined), false);
});

test("lat/lng of 0 is still a real coordinate, not a missing one", () => {
  const s = makeSandbox();
  /* Guards the classic falsy-zero footgun: !pin.lat would treat Null Island
     as "no GPS" and hand the pin to the overwrite path. */
  assert.strictEqual(s.photosPinIsGpsOnly({ lat: 0, lng: 0 }), true);
});
