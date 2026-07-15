"use strict";
/* Fix for the #51 smoke-test finding: photos landed in the CompanyCam feed but
   UNPINNED. Root cause: a finding pinned on a base map is stored as x/y image
   coordinates ({x, y, lat:null, lng:null, imageFrame:"roof_base_map"}), so the
   old ccPinForFinding() (lat/lng only) produced NO coordinate for it. The fix
   georeferences a base-map x/y pin back to lat/lng using the roof's drone_ortho
   bounds. These are pure functions, extracted from js/history.js and run in a vm
   (no fdb/network) -- same technique as reportRoofPlanImageFrame.test.js. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const start = src.indexOf("function ccValidLatLng");
const end = src.indexOf("async function ccSiteLatLng", start);
assert.notEqual(start, -1, "ccValidLatLng not found");
assert.notEqual(end, -1, "end marker not found");
const ctx = {};
vm.runInNewContext(src.slice(start, end), ctx);
const { ccLatLngFromImageFramePin, ccPinForFinding, ccBestPhotoCoordinate } = ctx;

// Georeferenced drone-ortho roof. Forward projection (js/roofmapper.js):
//   x = (lng - west)/(east - west) ,  y = (north - lat)/(north - south)
const bounds = { north: 41.51, south: 41.49, east: -81.59, west: -81.61 };
const orthoRoof = { roof_base_map_url: "ortho.jpg", roof_base_map_type: "drone_ortho", roof_base_map_bounds: bounds };
const sketchRoof = { roof_base_map_url: "sketch.jpg", roof_base_map_type: "sketch", roof_base_map_synthetic: true, roof_base_map_bounds: null };

function xyFor(lat, lng){
  return { x: (lng - bounds.west) / (bounds.east - bounds.west), y: (bounds.north - lat) / (bounds.north - bounds.south),
    lat: null, lng: null, imageFrame: "roof_base_map", imageFrameUrl: "ortho.jpg" };
}

test("georeferenced x/y pin round-trips back to its lat/lng", () => {
  const pin = xyFor(41.505, -81.605);           // -> x 0.25, y 0.25
  const out = ccLatLngFromImageFramePin(pin, [orthoRoof]);
  assert.ok(out, "should resolve a coordinate");
  assert.ok(Math.abs(out.lat - 41.505) < 1e-9, "lat round-trips");
  assert.ok(Math.abs(out.lng - -81.605) < 1e-9, "lng round-trips");
});

test("a SYNTHETIC/sketch base map has no real bounds -> stays unpinned (no Null Island)", () => {
  const pin = { x: 0.3, y: 0.4, lat: null, lng: null, imageFrame: "roof_base_map", imageFrameUrl: "sketch.jpg" };
  assert.equal(ccLatLngFromImageFramePin(pin, [sketchRoof]), null);
});

test("x/y pin whose imageFrameUrl matches no georeferenced roof -> null (falls through)", () => {
  const pin = xyFor(41.5, -81.6); pin.imageFrameUrl = "different.jpg";
  assert.equal(ccLatLngFromImageFramePin(pin, [orthoRoof]), null);
  assert.equal(ccLatLngFromImageFramePin(xyFor(41.5, -81.6), []), null, "no roofs -> null");
  assert.equal(ccLatLngFromImageFramePin(xyFor(41.5, -81.6), undefined), null, "undefined roofs -> null");
});

test("a lat/lng pin is NOT touched by the image-frame path; an x/y pin needs it", () => {
  assert.equal(ccLatLngFromImageFramePin({ lat: 41.5, lng: -81.6 }, [orthoRoof]), null, "no x/y -> not an image-frame pin");
});

test("ccPinForFinding: a base-map x/y finding pin now resolves via the roof's ortho bounds", () => {
  const o = { findings: [{ id: "f1", pin: xyFor(41.505, -81.605) }], inspectionChecklist: [] };
  const out = ccPinForFinding(o, "f1", [orthoRoof]);
  assert.ok(out && Math.abs(out.lat - 41.505) < 1e-9 && Math.abs(out.lng - -81.605) < 1e-9);
  // Without roofs it still returns null (old behavior) -> this was the bug.
  assert.equal(ccPinForFinding(o, "f1", []), null, "no roofs -> unresolved, as before the fix");
});

test("ccPinForFinding: a real lat/lng finding pin still wins directly (unchanged)", () => {
  const o = { findings: [{ id: "f1", pin: { lat: 35.5, lng: -80.5, source: "tech_placed" } }], inspectionChecklist: [] };
  const out = ccPinForFinding(o, "f1", [orthoRoof]);
  assert.ok(out && out.lat === 35.5 && out.lng === -80.5);
});

test("ccBestPhotoCoordinate priority: a georeferenced finding pin beats the photo's own GPS", () => {
  const o = { findings: [{ id: "f1", pin: xyFor(41.505, -81.605) }], inspectionChecklist: [] };
  const photo = { finding_id: "f1", gps: { lat: 10, lng: 20 } };
  const out = ccBestPhotoCoordinate(photo, o, { lat: 1, lng: 2 }, [orthoRoof]);
  assert.ok(out && Math.abs(out.lat - 41.505) < 1e-9, "finding pin (georeferenced) wins over photo GPS");
});

test("ccBestPhotoCoordinate: with no resolvable pin, still falls back to site (unchanged floor)", () => {
  const o = { findings: [{ id: "f1", pin: { x: 0.3, y: 0.4, lat: null, lng: null, imageFrameUrl: "sketch.jpg" } }], inspectionChecklist: [] };
  const photo = { finding_id: "f1", gps: null };
  const out = ccBestPhotoCoordinate(photo, o, { lat: 39.1, lng: -84.5 }, [sketchRoof]);
  assert.ok(out && out.lat === 39.1 && out.lng === -84.5, "synthetic pin unresolved -> job-site floor still applies");
});
