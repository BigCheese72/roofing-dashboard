const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Issue #44: the report roof plan must not silently drop a roof traced on a
   non-georeferenced image (PR #43 / #40 image-frame geometry). It must be
   INCLUDED and flagged planUnavailable so the caller names it with a notice.
   We load just the pure classifier (no SVG/Firestore deps) out of export.js. */
const src = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const start = src.indexOf("function rmReportOutlineDrawability");
assert.notEqual(start, -1, "rmReportOutlineDrawability not found in export.js");
const end = src.indexOf("async function rmFetchReportRoofOutlines", start);
const ctx = {};
vm.runInNewContext(src.slice(start, end), ctx);
const rmReportOutlineDrawability = ctx.rmReportOutlineDrawability;

/* Compare fields directly: the returned object comes from the vm realm, so
   deepStrictEqual would fail on the cross-realm Object.prototype mismatch. */
function check(outline, include, planUnavailable){
  const d = rmReportOutlineDrawability(outline);
  assert.equal(d.include, include, "include");
  assert.equal(d.planUnavailable, planUnavailable, "planUnavailable");
}

const worldRing = [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }, { lat: 1, lng: 1 }];

test("world-coordinate ring is drawable and not flagged", () => {
  check({ ring: worldRing }, true, false);
});

test("PR #43 image-frame outline (ring:[] + imageRing) is included but plan-unavailable", () => {
  check({
    ring: [], imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    imageFrame: "roof_base_map", tracedOnOrtho: true, georeferencedSource: false
  }, true, true);
});

test("tracedOnOrtho alone (no imageRing yet) still marks plan-unavailable, not dropped", () => {
  check({ ring: [], tracedOnOrtho: true }, true, true);
});

test("imageFrame flag alone marks plan-unavailable", () => {
  check({ ring: [], imageFrame: "roof_base_map" }, true, true);
});

test("empty/short ring with no image frame is excluded, and null is excluded", () => {
  check({ ring: [] }, false, false);
  check({ ring: [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }] }, false, false);
  check(null, false, false);
});

test("a world ring wins even if stray image-frame flags are present", () => {
  check({ ring: worldRing, imageFrame: "roof_base_map" }, true, false);
});

test("mixed set: drawable roof is kept, image-frame roof is surfaced (never omitted)", () => {
  const entries = [
    { roofLabel: "Roof 1", outline: { ring: worldRing } },
    { roofLabel: "Roof 2", outline: { ring: [], imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], imageFrame: "roof_base_map" } }
  ].map((e) => {
    const d = rmReportOutlineDrawability(e.outline);
    return Object.assign({}, e, { include: d.include, planUnavailable: d.planUnavailable });
  });
  const drawable = entries.filter((e) => e.include && !e.planUnavailable);
  const unavailable = entries.filter((e) => e.include && e.planUnavailable);
  assert.equal(drawable.length, 1);
  assert.equal(drawable[0].roofLabel, "Roof 1");
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].roofLabel, "Roof 2");
  // every included roof is accounted for: none silently dropped
  assert.equal(drawable.length + unavailable.length, entries.filter((e) => e.include).length);
});
