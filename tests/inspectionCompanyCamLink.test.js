"use strict";
/* Building-level CompanyCam link surfaced on Inspection (Mark: "link CompanyCam
   once at the building/base-map level -> every report type inherits it"). The
   link data path is already building-level and type-agnostic (collect() writes
   companyCamProjectId for every type; it's saved onto buildings/{id} and
   bpSelectBuilding() inherits it). This tests the ONLY new logic: which types
   show the standalone building-level link control (#wo-cc-link-row). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const start = src.indexOf("function ccBuildingLinkControlVisible");
const end = src.indexOf("function renderCCLinkInfo", start);
assert.notEqual(start, -1); assert.notEqual(end, -1);
const ctx = {};
vm.runInNewContext(src.slice(start, end), ctx);
const { ccBuildingLinkControlVisible } = ctx;

test("Inspection now shows the building-level CompanyCam link control", () => {
  assert.equal(ccBuildingLinkControlVisible("Inspection"), true, "the gap Mark reported");
});

test("Leak and Warranty (also findings-based, global import row hidden) show it too", () => {
  assert.equal(ccBuildingLinkControlVisible("Leak / Service"), true);
  assert.equal(ccBuildingLinkControlVisible("Warranty"), true);
});

test("Change Order and Repair do NOT show this control (they have their own path)", () => {
  assert.equal(ccBuildingLinkControlVisible("Change Order"), false, "CO uses #cc-link-info-co");
  assert.equal(ccBuildingLinkControlVisible("Repair"), false, "Repair keeps the global import row");
});
