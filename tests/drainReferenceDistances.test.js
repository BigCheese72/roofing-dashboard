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
  assert.doesNotMatch(ctx.assetReferenceDistancesHtml({
    referenceDistances: { point1Label: "North parapet", point1DistanceFt: 14 }
  }), /Point 2/);
});

test("building history and RoofMapper expose and save drain reference fields", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const photos = fs.readFileSync(path.join(root, "js", "photos.js"), "utf8");
  const roofmapper = fs.readFileSync(path.join(root, "js", "roofmapper.js"), "utf8");
  const buildinghistory = fs.readFileSync(path.join(root, "js", "buildinghistory.js"), "utf8");

  assert.match(html, /id="asset-drain-reference-fields"/);
  assert.match(html, /id="rm-feature-drain-reference-fields"/);
  assert.match(photos, /roofAssetDrainReferenceFromFields\("asset", asset\.type\)/);
  assert.match(roofmapper, /roofAssetDrainReferenceFromFields\("rm-feature", asset\.type\)/);
  assert.match(photos, /assetReferenceDistancesHtml\(a\)/);
  assert.match(buildinghistory, /assetReferenceDistancesHtml\(a\)/);
});
