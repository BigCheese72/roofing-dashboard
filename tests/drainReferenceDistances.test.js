"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function loadDrainHelpers() {
  const src = fs.readFileSync(path.join(root, "js", "photos.js"), "utf8");
  const start = src.indexOf("function roofAssetDistanceFt");
  const end = src.indexOf("function assetPopupHtml", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = {
    document: { getElementById: () => null },
    ROOF_ASSET_TYPES: {
      drain: { label: "Drain" },
      core_cut: { label: "Core Cut" },
      test_cut: { label: "Test Cut" },
      other: { label: "Other" }
    },
    esc: value => String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  };
  vm.createContext(context);
  vm.runInContext(src.slice(start, end), context);
  return context;
}

test("drain reference distance helper stores feet as one-decimal numbers", () => {
  const ctx = loadDrainHelpers();

  assert.equal(ctx.roofAssetDistanceFt("12.34"), 12.3);
  assert.equal(ctx.roofAssetDistanceFt("0"), 0);
  assert.equal(ctx.roofAssetDistanceFt(""), null);
  assert.equal(ctx.roofAssetDistanceFt("-1"), null);
  assert.equal(ctx.roofAssetDistanceFt("not a number"), null);
});

test("drain reference fields build structured data only for drains", () => {
  const ctx = loadDrainHelpers();
  const els = {
    "asset-ref1-label": { value: "North parapet" },
    "asset-ref1-distance": { value: "14.25" },
    "asset-ref2-label": { value: "West wall" },
    "asset-ref2-distance": { value: "22" },
    "asset-drain-reference-fields": { style: {} }
  };
  ctx.document = { getElementById: id => els[id] || null };

  const actual = JSON.parse(JSON.stringify(ctx.roofAssetDrainReferenceFromFields("asset", "drain")));
  assert.deepEqual(actual, {
    point1Label: "North parapet",
    point1DistanceFt: 14.3,
    point2Label: "West wall",
    point2DistanceFt: 22,
    unit: "ft"
  });
  assert.equal(ctx.roofAssetDrainReferenceFromFields("asset", "hvac"), null);
});

test("saved drain reference distances render in asset popups", () => {
  const ctx = loadDrainHelpers();
  ctx.L = {
    divIcon: cfg => ({ kind: "icon", cfg }),
    marker: (latlng, opts) => ({
      latlng,
      opts,
      addTo(layer){ layer.added = { latlng, opts }; return this; }
    })
  };
  const html = ctx.assetReferenceDistancesHtml({
    type: "drain",
    referenceDistances: {
      point1Label: "North parapet",
      point1DistanceFt: 14,
      point2Label: "West wall",
      point2DistanceFt: 22.5
    }
  });

  assert.match(html, /Refs:/);
  assert.match(html, /North parapet: 14 ft/);
  assert.match(html, /West wall: 22.5 ft/);
  assert.equal(ctx.assetReferenceDistancesText({
    referenceDistances: { point1Label: "A&B", point1DistanceFt: 8 }
  }), "A&B: 8 ft");
  assert.match(ctx.assetReferenceDistancesHtml({
    referenceDistances: { point1Label: "A&B", point1DistanceFt: 8 }
  }), /A&amp;B: 8 ft/);
  assert.doesNotMatch(ctx.assetReferenceDistancesHtml({
    referenceDistances: { point1Label: "North parapet", point1DistanceFt: 14 }
  }), /Point 2/);

  const layer = {};
  const marker = ctx.addAssetReferenceDistanceLabel(layer, [10, 20], {
    type: "drain",
    referenceDistances: { point1Label: "North parapet", point1DistanceFt: 14 }
  });
  assert.ok(marker);
  assert.deepEqual(layer.added.latlng, [10, 20]);
  assert.match(layer.added.opts.icon.cfg.html, /Refs: North parapet: 14 ft/);
});

test("core and test cut helpers store results and photo references", () => {
  const ctx = loadDrainHelpers();
  const els = {
    "asset-core-result": { value: "60 mil TPO over HD board" },
    "asset-core-photo-link": { value: "https://companycam.example/photo/123" },
    "asset-core-fields": { style: {} }
  };
  ctx.document = { getElementById: id => els[id] || null };

  assert.deepEqual(JSON.parse(JSON.stringify(ctx.roofAssetCoreInfoFromFields("asset", "core_cut"))), {
    coreResult: "60 mil TPO over HD board",
    corePhotoLink: "https://companycam.example/photo/123"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.roofAssetCoreInfoFromFields("asset", "test_cut"))), {
    coreResult: "60 mil TPO over HD board",
    corePhotoLink: "https://companycam.example/photo/123"
  });
  assert.equal(ctx.roofAssetCoreInfoFromFields("asset", "drain"), null);

  const html = ctx.assetCoreInfoHtml({
    type: "core_cut",
    coreResult: "60 mil TPO",
    corePhotoLink: "https://companycam.example/photo/123"
  });
  assert.match(html, /Core results: 60 mil TPO/);
  assert.match(html, /Open photo/);
  assert.match(html, /target="_blank"/);

  const unsafe = ctx.assetCoreInfoHtml({
    type: "core_cut",
    corePhotoLink: "javascript:alert(1)"
  });
  assert.doesNotMatch(unsafe, /href=/);
  assert.match(unsafe, /javascript:alert\(1\)/);
});

test("export labels include drain dimensions and core result callouts", () => {
  const ctx = loadDrainHelpers();

  assert.deepEqual(JSON.parse(JSON.stringify(ctx.assetExportLabelLines({
    type: "drain",
    label: "Drain #3",
    referenceDistances: {
      point1Label: "North parapet",
      point1DistanceFt: 14,
      point2Label: "West wall",
      point2DistanceFt: 22.5
    }
  }))), ["Drain #3", "Refs: North parapet: 14 ft | West wall:", "22.5 ft"]);

  const coreLines = JSON.parse(JSON.stringify(ctx.assetExportLabelLines({
    type: "core_cut",
    label: "Core A",
    coreResult: "60 mil TPO over one half inch HD cover board",
    corePhotoLink: "CompanyCam photo 123"
  })));
  assert.equal(coreLines[0], "Core A");
  assert.ok(coreLines.some(line => line.includes("Core: 60 mil TPO")));
  assert.ok(coreLines.some(line => line.includes("Photo: CompanyCam photo 123")));
});

test("building history, RoofMapper, and exports expose and save roof asset callout fields", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const photos = fs.readFileSync(path.join(root, "js", "photos.js"), "utf8");
  const roofmapper = fs.readFileSync(path.join(root, "js", "roofmapper.js"), "utf8");
  const buildinghistory = fs.readFileSync(path.join(root, "js", "buildinghistory.js"), "utf8");
  const exportJs = fs.readFileSync(path.join(root, "js", "export.js"), "utf8");

  assert.match(html, /id="asset-drain-reference-fields"/);
  assert.match(html, /id="rm-feature-drain-reference-fields"/);
  assert.match(html, /id="asset-core-fields"/);
  assert.match(html, /id="rm-feature-core-fields"/);
  assert.match(photos, /roofAssetDrainReferenceFromFields\("asset", asset\.type\)/);
  assert.match(roofmapper, /roofAssetDrainReferenceFromFields\("rm-feature", asset\.type\)/);
  assert.match(photos, /roofAssetCoreInfoFromFields\("asset", asset\.type\)/);
  assert.match(roofmapper, /roofAssetCoreInfoFromFields\("rm-feature", asset\.type\)/);
  assert.match(photos, /assetReferenceDistancesHtml\(a\)/);
  assert.match(photos, /assetCoreInfoHtml\(a\)/);
  assert.match(photos, /function addAssetReferenceDistanceLabel/);
  assert.match(buildinghistory, /assetReferenceDistancesHtml\(a\)/);
  assert.match(buildinghistory, /assetCoreInfoHtml\(a\)/);
  assert.match(buildinghistory, /addAssetReferenceDistanceLabel\(map, assetLatLng, a\)/);
  assert.match(roofmapper, /addAssetReferenceDistanceLabel\(rmState\.assetLayerGroup, assetLatLng, a\)/);
  assert.match(roofmapper, /Object\.assign\(\{\}, a, rmExportProjectPoint\(a, origin\)\)/);
  assert.match(roofmapper, /rmAssetLabelItem\("asset-/);
  assert.match(exportJs, /Object\.assign\(\{\}, a, rmExportProjectPoint\(a, origin\)\)/);
  assert.match(exportJs, /rmReportAssetLabelItem\("asset-/);
});
