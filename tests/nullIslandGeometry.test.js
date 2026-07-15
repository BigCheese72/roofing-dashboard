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
      orthoFrameUrl: "https://example.test/ortho.jpg",
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
  assert.equal(stored.imageFrameUrl, "https://example.test/ortho.jpg");
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
  assert.equal(storedAsset.imageFrameUrl, "https://example.test/ortho.jpg");
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
      orthoFrameUrl: "https://example.test/ortho.jpg",
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
  assert.equal(stored.imageFrameUrl, sourceRoof.roof_base_map_url);
  assert.equal(stored.imageRing.length, ring.length);

  const display = context.rmOutlineDisplayGeometry(stored, context.rmState.orthoBounds);
  assert.equal(display.ring.length, ring.length);
  assert.equal(context.rmOutlineDisplayGeometry(stored, context.rmState.orthoBounds, "https://example.test/other.jpg"), null);

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
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
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

test("RoofMapper does not reuse a different synthetic base-map image for new image geometry", async () => {
  let uploads = 0;
  const context = {
    isAdmin: true,
    rmState: {
      orthoActive: true,
      orthoSynthetic: true,
      orthoDataUrl: "data:image/jpeg;base64,new-image",
      orthoBounds: { north: 0.001, south: -0.001, east: 0.002, west: -0.002 }
    },
    toast(){},
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
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
      uploads++;
      return { document: { url: "https://example.test/new-image.jpg" } };
    },
    async callAdminApi(){}
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "async function rmPersistKmlGroundOverlayBaseMap",
    context
  );

  const roof = {
    id: "roof-1",
    roof_base_map_type: "sketch",
    roof_base_map_url: "https://example.test/old-image.jpg",
    roof_base_map_synthetic: true
  };
  const retainedUrl = await context.rmEnsureSyntheticOrthoFrameForSave("building-1", roof, false);

  assert.equal(retainedUrl, "https://example.test/new-image.jpg");
  assert.equal(roof.roof_base_map_url, "https://example.test/new-image.jpg");
  assert.equal(uploads, 1);

  context.rmState.orthoDataUrl = roof.roof_base_map_url;
  const reusedUrl = await context.rmEnsureSyntheticOrthoFrameForSave("building-1", roof, false);

  assert.equal(reusedUrl, "https://example.test/new-image.jpg");
  assert.equal(uploads, 1);
});

test("RoofMapper refuses to re-anchor existing image-frame geometry to a different base map", async () => {
  let uploads = 0;
  const toasts = [];
  const context = {
    isAdmin: true,
    rmState: {
      orthoActive: true,
      orthoSynthetic: true,
      orthoDataUrl: "data:image/jpeg;base64,new-image",
      orthoBounds: { north: 0.001, south: -0.001, east: 0.002, west: -0.002 }
    },
    toast(message){ toasts.push(message); },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
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
      uploads++;
      return { document: { url: "https://example.test/new-image.jpg" } };
    },
    async callAdminApi(){}
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "async function rmPersistKmlGroundOverlayBaseMap",
    context
  );

  const roof = {
    id: "roof-1",
    roof_base_map_type: "sketch",
    roof_base_map_url: "https://example.test/old-image.jpg",
    roof_base_map_synthetic: true,
    roof_outlines: [{
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/old-image.jpg",
      imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    }],
    roof_assets: [{
      x: 0.5,
      y: 0.5,
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/old-image.jpg"
    }]
  };

  const refused = await context.rmEnsureSyntheticOrthoFrameForSave("building-1", roof, false);

  assert.equal(refused, false);
  assert.equal(roof.roof_base_map_url, "https://example.test/old-image.jpg");
  assert.equal(uploads, 0);
  assert.ok(toasts.some((message) => message.includes("different uploaded image")));
});

test("RoofMapper refuses base-map clear or replacement when image-frame geometry exists", () => {
  const toasts = [];
  const context = {
    toast(message){ toasts.push(message); },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "function rmStartOrthoTrace",
    context
  );

  const roof = {
    roof_base_map_url: "https://example.test/base-1.jpg",
    roof_outlines: [{
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/base-1.jpg",
      imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    }]
  };

  assert.equal(context.rmRefuseImageFrameBaseMapChange(roof, "Clearing this base map"), true);
  assert.ok(toasts[0].includes("was refused"));
  assert.equal(context.rmRefuseImageFrameBaseMapChange({ roof_outlines: [], roof_assets: [] }, "Changing this base map"), false);
});

test("RoofMapper refuses KMZ/KML base-map replacement when image-frame geometry exists", async () => {
  const toasts = [];
  const apiCalls = [];
  const uploads = [];
  const roof = {
    id: "roof-1",
    roof_base_map_type: "sketch",
    roof_base_map_url: "https://example.test/base-1.jpg",
    roof_base_map_synthetic: true,
    roof_outlines: [{
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/base-1.jpg",
      imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    }],
    roof_assets: [{
      x: 0.5,
      y: 0.5,
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/base-1.jpg"
    }]
  };
  const context = {
    isAdmin: true,
    rmState: {
      kmlOverlayMeta: {
        bounds: { north: 41.51, south: 41.49, east: -81.59, west: -81.61 },
        imageFileName: "ortho.jpg"
      },
      kmlOverlayDataUrl: "data:image/jpeg;base64,kml-image"
    },
    toast(message){ toasts.push(message); },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    },
    getRoofById(building, roofId){
      return (building.roofs || []).find((r) => r.id === roofId) || null;
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
                    return { companyCamProjectId: "cc-1", roofs: [roof] };
                  }
                };
              }
            };
          }
        };
      }
    },
    async ccApiPost(body){
      uploads.push(body);
      return { document: { url: "https://example.test/kmz.jpg" } };
    },
    async callAdminApi(body){
      apiCalls.push(body);
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "function rmStartWalkCorners",
    context
  );

  const result = await context.rmPersistKmlGroundOverlayBaseMap("building-1", "roof-1");

  assert.equal(result, false);
  assert.equal(apiCalls.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(roof.roof_base_map_url, "https://example.test/base-1.jpg");
  assert.equal(context.rmAssetDisplayLatLng(roof.roof_assets[0]), null);
  assert.ok(toasts.some((message) => message.includes("Roof outline saved") && message.includes("KMZ/KML image was not attached")));
});

test("RoofMapper saves KML outline while refusing unsafe image-frame map replacement", async () => {
  const toasts = [];
  const apiCalls = [];
  const uploads = [];
  const outlineRing = [
    { lat: 41.505, lng: -81.605 },
    { lat: 41.505, lng: -81.595 },
    { lat: 41.495, lng: -81.595 },
    { lat: 41.505, lng: -81.605 }
  ];
  const roof = {
    id: "roof-1",
    label: "Roof 1",
    roof_base_map_type: "sketch",
    roof_base_map_url: "https://example.test/base-1.jpg",
    roof_base_map_synthetic: true,
    roof_outlines: [{
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/base-1.jpg",
      imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    }]
  };
  const building = { companyCamProjectId: "cc-1", roofs: [roof] };
  let savedRoofs = null;
  const context = {
    isAdmin: true,
    rmState: {
      outline: { ring: outlineRing, center: { lat: 41.5, lng: -81.6 } },
      kmlOverlayActive: true,
      kmlOverlayMeta: {
        bounds: { north: 41.51, south: 41.49, east: -81.59, west: -81.61 },
        imageFileName: "ortho.jpg"
      },
      kmlOverlayDataUrl: "data:image/jpeg;base64,kml-image"
    },
    document: {
      getElementById(){
        return {
          style: {},
          classList: { add(){}, remove(){}, toggle(){} },
          addEventListener(){},
          appendChild(){},
          querySelector(){ return null; },
          innerHTML: "",
          textContent: "",
          value: ""
        };
      },
      querySelector(){ return null; },
      createElement(){
        return {
          style: {},
          classList: { add(){}, remove(){}, toggle(){} },
          addEventListener(){},
          appendChild(){},
          querySelector(){ return null; },
          innerHTML: "",
          textContent: "",
          value: ""
        };
      }
    },
    toast(message){ toasts.push(message); },
    confirm(){ return true; },
    rmIsFiniteNumber(value){
      return typeof value === "number" && Number.isFinite(value);
    },
    rmGeomRingCentroid(){
      throw new Error("test outline provides an explicit center");
    },
    rmRefreshOutlineMeasurementModel(){},
    rmSetPrecisionMode(){},
    genId(prefix){ return prefix + "-new"; },
    getBuildingRoofs(buildingData){
      return buildingData.roofs || [];
    },
    getRoofById(buildingData, roofId){
      return (buildingData.roofs || []).find((r) => r.id === roofId) || null;
    },
    async saveBuildingRoofs(buildingId, roofs){
      savedRoofs = roofs;
      building.roofs = roofs;
    },
    rmPendingIdFor(){ return null; },
    rmResolveFailSafeCopy(){},
    rmFailSafeSaveOutline(){
      throw new Error("fail-safe should not run on this successful KML save");
    },
    closeRmSaveModal(){},
    rmClearSplitState(){},
    rmRenderRoofSwitcher(){},
    rmRenderExportRoofSelect(){},
    rmShowFeaturePanel(){},
    async rmLoadLinkedAssets(){},
    rmUpdateExportHint(){},
    rmUpdateControlVisibility(){},
    fdb: {
      collection(){
        return {
          doc(){
            return {
              async get(){
                return {
                  exists: true,
                  data(){
                    return building;
                  }
                };
              }
            };
          }
        };
      }
    },
    async ccApiPost(body){
      uploads.push(body);
      return { document: { url: "https://example.test/kmz.jpg" } };
    },
    async callAdminApi(body){
      apiCalls.push(body);
    }
  };
  loadFunctionBlock(
    "js/roofmapper.js",
    "function rmValidOrthoBounds",
    "async function rmOpenRoofInMapper",
    context
  );
  context.closeRmSaveModal = () => {};
  context.rmRenderRoofSwitcher = () => {};
  context.rmRenderExportRoofSelect = () => {};
  context.rmShowFeaturePanel = () => {};
  context.rmLoadLinkedAssets = async () => {};
  context.rmUpdateExportHint = () => {};
  context.rmUpdateControlVisibility = () => {};

  const result = await context.rmSaveOutlineToBuilding("building-1", "roof-1");

  assert.equal(result, true, toasts.join("\n"));
  assert.equal(apiCalls.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(savedRoofs[0].roof_outlines.length, 2);
  assert.equal(savedRoofs[0].roof_outlines[1].ring.length, outlineRing.length);
  assert.equal(savedRoofs[0].roof_outlines[1].imageFrame, null);
  assert.equal(savedRoofs[0].roof_base_map_url, "https://example.test/base-1.jpg");
  assert.ok(toasts.some((message) => message.includes("Roof outline saved") && message.includes("KMZ/KML image was not attached")));
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

test("building maps render selected synthetic image outlines in custom image space", () => {
  const context = { Number };
  loadFunctionBlock(
    "js/workorders.js",
    "function inlineHistoryPinsForMap",
    "async function refreshInlineBuildingHistory",
    context
  );
  loadFunctionBlock(
    "js/workorders.js",
    "function buildingMapIsFiniteNumber",
    "function renderBuildingMap",
    context
  );

  const selectedRoof = {
    id: "roof-1",
    label: "Roof 1",
    roof_base_map_type: "sketch",
    roof_base_map_url: "https://example.test/base.jpg",
    roof_base_map_synthetic: true,
    roof_outlines: [{
      ring: [],
      imageRing: [
        { x: 0.25, y: 0.25 },
        { x: 0.75, y: 0.25 },
        { x: 0.75, y: 0.75 },
        { x: 0.25, y: 0.25 }
      ],
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/base.jpg"
    }]
  };
  const outlines = context.inlineHistoryOutlines([selectedRoof], true, selectedRoof);
  const imageRing = context.buildingMapImageOutlineRing(outlines[0], 400, 200, selectedRoof.roof_base_map_url);

  assert.equal(outlines.length, 1);
  assert.equal(outlines[0]._roofLabel, "Roof 1");
  assert.equal(imageRing[0][0], 50);
  assert.equal(imageRing[0][1], 100);
  assert.equal(imageRing[1][0], 50);
  assert.equal(imageRing[1][1], 300);
  assert.equal(context.buildingMapImageOutlineRing(outlines[0], 400, 200, "https://example.test/other.jpg"), null);
  assert.equal(context.buildingMapImageFrameMatches({ imageFrameUrl: "https://example.test/base.jpg" }, "https://example.test/base.jpg"), true);
  assert.equal(context.buildingMapImageFrameMatches({ imageFrameUrl: "https://example.test/base.jpg" }, "https://example.test/other.jpg"), false);
  assert.equal(context.buildingMapImageOutlineRing({ imageRing: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, 400, 200), null);
});

test("building maps disclose image-frame records from a different base image", () => {
  const context = { Number };
  loadFunctionBlock(
    "js/workorders.js",
    "function buildingMapIsFiniteNumber",
    "function renderBuildingMap",
    context
  );

  const disclosure = context.buildingMapFrameMismatchDisclosure([
    {
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/old.jpg",
      imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    },
    {
      imageFrame: "roof_base_map",
      imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    }
  ], [
    {
      x: 0.5,
      y: 0.5,
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/old.jpg"
    },
    {
      x: 0.25,
      y: 0.25,
      imageFrame: "roof_base_map"
    }
  ], [
    {
      x: 0.5,
      y: 0.5,
      imageFrame: "roof_base_map",
      imageFrameUrl: "https://example.test/old.jpg"
    },
    {
      x: 0.25,
      y: 0.25,
      imageFrame: "roof_base_map"
    }
  ], "https://example.test/current.jpg");

  assert.equal(disclosure.outlines, 1);
  assert.equal(disclosure.assets, 1);
  assert.equal(disclosure.pins, 1);
  assert.equal(disclosure.total, 3);
  assert.equal(
    context.buildingMapFrameMismatchText(disclosure),
    "1 outline, 1 feature, and 1 pin were placed on a different base image and can't be shown here."
  );
  assert.equal(context.buildingMapFrameMismatchDisclosure([], [], [], "https://example.test/current.jpg").total, 0);
});

test("work order image-space pins persist their base image frame", () => {
  const finding = { id: "finding-1", roofId: "roof-1" };
  const context = {
    pinMarker: { getLatLng(){ return { lat: 80, lng: 120 }; } },
    pinModalFindingId: "finding-1",
    pinMapMode: "xy",
    pinXYSize: { w: 400, h: 200 },
    pinDeviceGpsUsed: false,
    pinInitialSource: "tech_placed",
    pinInteracted: true,
    currentRoofId: "roof-1",
    lastLookupRoofInfo: {
      buildingId: "bld-1",
      roofs: [{
        id: "roof-1",
        roof_base_map_type: "sketch",
        roof_base_map_url: "https://example.test/base.jpg"
      }]
    },
    currentWorkOrderBuildingId(){ return "bld-1"; },
    lookupRoofInfoMatchesBuilding(info, buildingId){
      return !!(info && info.buildingId && buildingId && info.buildingId === buildingId);
    },
    findingById(id){ return id === "finding-1" ? finding : null; },
    renderFindings(){},
    closePinModal(){},
    toast(){}
  };
  loadFunctionBlock(
    "js/workorders.js",
    "function pinImageFrameUrlForFinding",
    "function clearPinFromModal",
    context
  );

  context.savePinFromModal();

  assert.equal(finding.pin.lat, null);
  assert.equal(finding.pin.lng, null);
  assert.equal(finding.pin.x, 0.3);
  assert.equal(finding.pin.y, 0.4);
  assert.equal(finding.pin.source, "tech_placed");
  assert.equal(finding.pin.imageFrame, "roof_base_map");
  assert.equal(finding.pin.imageFrameUrl, "https://example.test/base.jpg");
});

test("work order xy save leaves untouched GPS-only photo pins unchanged", () => {
  const originalPin = { lat: 0, lng: -90.2, source: "photo_gps" };
  const finding = { id: "finding-1", roofId: "roof-1", pin: originalPin };
  const events = [];
  const context = {
    pinMarker: { getLatLng(){ return { lat: 80, lng: 120 }; } },
    pinModalFindingId: "finding-1",
    pinMapMode: "xy",
    pinXYSize: { w: 400, h: 200, imageFrameUrl: "https://example.test/base.jpg" },
    pinDeviceGpsUsed: false,
    pinInitialSource: "photo_gps",
    pinInteracted: false,
    findingById(id){ return id === "finding-1" ? finding : null; },
    renderFindings(){ events.push("render"); },
    closePinModal(){ events.push("close"); },
    toast(message){ events.push(message); }
  };
  loadFunctionBlock(
    "js/workorders.js",
    "function pinImageFrameUrlForFinding",
    "function clearPinFromModal",
    context
  );

  context.savePinFromModal();

  assert.equal(finding.pin, originalPin);
  assert.deepEqual(finding.pin, { lat: 0, lng: -90.2, source: "photo_gps" });
  assert.deepEqual(events, ["close", "Pin left unchanged"]);
});

test("work order xy save preserves existing source without fabricating tech placement", () => {
  const finding = {
    id: "finding-1",
    roofId: "roof-1",
    pin: { lat: null, lng: null, x: 0.25, y: 0.25, source: "plan_imported" }
  };
  const context = {
    pinMarker: { getLatLng(){ return { lat: 0, lng: 0 }; } },
    pinModalFindingId: "finding-1",
    pinMapMode: "xy",
    pinXYSize: { w: 400, h: 200, imageFrameUrl: "https://example.test/base.jpg" },
    pinDeviceGpsUsed: false,
    pinInitialSource: "tech_placed",
    pinInteracted: false,
    findingById(id){ return id === "finding-1" ? finding : null; },
    renderFindings(){},
    closePinModal(){},
    toast(){}
  };
  loadFunctionBlock(
    "js/workorders.js",
    "function pinImageFrameUrlForFinding",
    "function clearPinFromModal",
    context
  );

  context.savePinFromModal();

  assert.equal(finding.pin.lat, null);
  assert.equal(finding.pin.lng, null);
  assert.equal(finding.pin.x, 0);
  assert.equal(finding.pin.y, 0);
  assert.equal(finding.pin.source, "plan_imported");
  assert.equal(finding.pin.imageFrame, "roof_base_map");
  assert.equal(finding.pin.imageFrameUrl, "https://example.test/base.jpg");
});
