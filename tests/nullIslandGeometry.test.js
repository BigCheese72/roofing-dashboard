const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function loadFunctionBlock(file, startMarker, endMarker, context){
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(start, -1, "missing start marker " + startMarker);
  assert.notEqual(end, -1, "missing end marker " + endMarker);
  vm.runInNewContext(src.slice(start, end), context);
  return context;
}

test("RoofMapper persists synthetic ortho outline and assets as image coordinates", () => {
  const context = {
    rmState: {
      orthoActive: true,
      orthoSynthetic: true,
      orthoBounds: { north: 0.001, south: -0.001, east: 0.002, west: -0.002 }
    },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    },
    rmGeomRingCentroid(){
      throw new Error("test outlines provide an explicit center");
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "function rmStartOrthoTrace",
    context
  );

  const ring = [
    { lat: 0.0005, lng: -0.001 },
    { lat: 0.0005, lng: 0.001 },
    { lat: -0.0005, lng: 0.001 },
    { lat: -0.0005, lng: -0.001 },
    { lat: 0.0005, lng: -0.001 }
  ];
  const stored = context.rmOutlineStorageFields({ ring, center: { lat: 0, lng: 0 }, tracedOnOrtho: true }, null);

  assert.equal(Array.isArray(stored.ring), true);
  assert.equal(stored.ring.length, 0);
  assert.equal(stored.center, null);
  assert.equal(stored.imageFrame, "roof_base_map");
  assert.equal(stored.tracedOnOrtho, true);
  assert.equal(stored.georeferencedSource, false);
  assert.equal(stored.imageRing.length, ring.length);
  assert.ok(stored.imageRing.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

  const display = context.rmOutlineDisplayGeometry({
    imageRing: stored.imageRing,
    imageCenter: stored.imageCenter
  }, context.rmState.orthoBounds);
  assert.equal(display.ring.length, ring.length);
  assert.ok(Math.abs(display.ring[0].lat - ring[0].lat) < 1e-12);
  assert.ok(Math.abs(display.ring[0].lng - ring[0].lng) < 1e-12);

  const storedAsset = context.rmAssetPersistenceFields({ lat: 0.0005, lng: 0.001 });
  assert.equal(storedAsset.lat, null);
  assert.equal(storedAsset.lng, null);
  assert.equal(storedAsset.imageFrame, "roof_base_map");
  assert.equal(storedAsset.tracedOnOrtho, true);
  assert.ok(Number.isFinite(storedAsset.x));
  assert.ok(Number.isFinite(storedAsset.y));
});

test("RoofMapper keeps real georeferenced ortho outline and assets in lat/lng", () => {
  const context = {
    rmState: {
      orthoActive: true,
      orthoSynthetic: false,
      orthoBounds: { north: 41.51, south: 41.49, east: -81.59, west: -81.61 }
    },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    },
    rmGeomRingCentroid(){
      throw new Error("test outlines provide an explicit center");
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "function rmStartOrthoTrace",
    context
  );

  const ring = [
    { lat: 41.505, lng: -81.605 },
    { lat: 41.505, lng: -81.595 },
    { lat: 41.495, lng: -81.595 },
    { lat: 41.495, lng: -81.605 },
    { lat: 41.505, lng: -81.605 }
  ];
  const stored = context.rmOutlineStorageFields(
    { ring, center: { lat: 41.5, lng: -81.6 } },
    { georeferencedSource: true }
  );

  assert.equal(stored.ring.length, ring.length);
  assert.deepEqual(stored.center, { lat: 41.5, lng: -81.6 });
  assert.equal(stored.imageRing, null);
  assert.equal(stored.imageCenter, null);
  assert.equal(stored.imageFrame, null);
  assert.equal(stored.tracedOnOrtho, null);
  assert.equal(stored.georeferencedSource, true);

  const storedAsset = context.rmAssetPersistenceFields({ lat: 41.5, lng: -81.6 });
  assert.equal(storedAsset.lat, 41.5);
  assert.equal(storedAsset.lng, -81.6);
  assert.equal(storedAsset.x, null);
  assert.equal(storedAsset.y, null);
  assert.equal(storedAsset.imageFrame, undefined);
  assert.equal(storedAsset.tracedOnOrtho, undefined);
});

test("RoofMapper carries durable synthetic base maps through split outlines", () => {
  const context = {
    rmState: {
      orthoActive: true,
      orthoSynthetic: true,
      orthoBounds: { north: 0.001, south: -0.001, east: 0.002, west: -0.002 }
    },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    },
    rmGeomRingCentroid(){
      throw new Error("test outlines provide an explicit center");
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "function rmStartOrthoTrace",
    context
  );

  const sourceRoof = {
    roof_base_map_type: "sketch",
    roof_base_map_url: "https://example.test/ortho.jpg",
    roof_base_map_synthetic: true
  };
  const ring = [
    { lat: 0.0005, lng: -0.001 },
    { lat: 0.0005, lng: 0.001 },
    { lat: -0.0005, lng: 0.001 },
    { lat: -0.0005, lng: -0.001 },
    { lat: 0.0005, lng: -0.001 }
  ];
  const splitFields = context.rmSyntheticSplitBaseMapFields(sourceRoof);
  const stored = context.rmSplitOutlineStorageFields({ ring, center: { lat: 0, lng: 0 } }, sourceRoof);
  const splitRoof = Object.assign({
    roof_base_map_type: null,
    roof_base_map_url: null,
    roof_base_map_bounds: null,
    roof_base_map_synthetic: null,
    roof_outlines: [stored]
  }, splitFields);

  assert.equal(splitRoof.roof_base_map_type, "sketch");
  assert.equal(splitRoof.roof_base_map_url, sourceRoof.roof_base_map_url);
  assert.equal(splitRoof.roof_base_map_synthetic, true);
  assert.equal(stored.ring.length, 0);
  assert.equal(stored.imageFrame, "roof_base_map");
  assert.equal(stored.imageRing.length, ring.length);

  const display = context.rmOutlineDisplayGeometry(stored, context.rmState.orthoBounds);
  assert.equal(display.ring.length, ring.length);

  const unsavedSplit = context.rmSplitOutlineStorageFields({ ring, center: { lat: 0, lng: 0 } }, null);
  assert.equal(unsavedSplit, null);
});

test("RoofMapper refuses synthetic ortho upload persistence before unsafe geometry save", async () => {
  const toasts = [];
  const apiCalls = [];
  const context = {
    isAdmin: true,
    rmState: {
      orthoDataUrl: "data:image/jpeg;base64,abc123"
    },
    toast(message){
      toasts.push(message);
    },
    fdb: {
      collection(){
        return {
          doc(){
            return {
              async get(){
                return {
                  exists: true,
                  data(){
                    return { companyCamProjectId: "cc-1" };
                  }
                };
              }
            };
          }
        };
      }
    },
    async ccApiPost(){
      return { document: { url: "https://example.test/retained-ortho.jpg" } };
    },
    async callAdminApi(body){
      apiCalls.push(body);
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmApplySyntheticOrthoBaseMap",
    "async function rmPersistKmlGroundOverlayBaseMap",
    context
  );

  const url = await context.rmPersistOrthoBaseMap("building-1", "roof-1");
  assert.equal(url, "https://example.test/retained-ortho.jpg");
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].action, "set_building_roof_map");
  assert.equal(apiCalls[0].roof_base_map_type, "sketch");
  assert.equal(apiCalls[0].roof_base_map_url, url);
  assert.equal(apiCalls[0].roof_base_map_synthetic, true);

  context.isAdmin = false;
  const refused = await context.rmUploadSyntheticOrthoBaseMap("building-1", "roof-2");
  assert.equal(refused, false);
  assert.ok(toasts.some((message) => message.includes("can't be kept with it")));
});

test("building maps reject synthetic Null Island geometry without rejecting valid zero latitude", () => {
  const context = { Number };
  loadFunctionBlock(
    "js/workorders.js",
    "function buildingMapIsFiniteNumber",
    "function renderBuildingMap",
    context
  );

  const corruptSyntheticOutline = {
    tracedOnOrtho: true,
    ring: [
      { lat: 0.00001, lng: 0.00001 },
      { lat: 0.00001, lng: 0.00002 },
      { lat: 0.00002, lng: 0.00002 },
      { lat: 0.00001, lng: 0.00001 }
    ]
  };
  const realEquatorOutline = {
    ring: [
      { lat: 0, lng: 10 },
      { lat: 0, lng: 10.001 },
      { lat: 0.001, lng: 10.001 }
    ]
  };

  assert.equal(context.buildingMapRenderableOutline(corruptSyntheticOutline), false);
  assert.equal(context.buildingMapRenderableOutline(realEquatorOutline), true);
  assert.equal(context.buildingMapShouldUseWorldPoint({ lat: 0, lng: 10 }, {}), true);
  assert.equal(context.buildingMapShouldUseWorldPoint({ lat: 0, lng: 0 }, { tracedOnOrtho: true }), false);
  assert.equal(context.buildingMapShouldUseWorldPoint({ lat: null, lng: 0 }, {}), false);
});
