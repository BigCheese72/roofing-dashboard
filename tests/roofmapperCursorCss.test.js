const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "css", "app.css"), "utf8");

test("RoofMapper map uses pointer cursor instead of Leaflet grab cursor", () => {
  assert.match(css, /#rm-map(?:,|\s*\{)/, "RoofMapper map cursor rule is present");
  assert.match(css, /#rm-map\s+\.leaflet-grab/, "Leaflet grab class is overridden in RoofMapper");
  assert.match(css, /#rm-map\.leaflet-dragging/, "Leaflet dragging class is overridden in RoofMapper");
  assert.doesNotMatch(css, /#rm-map-wrap\.rm-precision-active[^{}]*\{[^{}]*cursor\s*:\s*crosshair/i);
  assert.match(css, /#rm-map-wrap\.rm-precision-active[^{}]*#rm-map[^{}]*\{[^{}]*cursor\s*:\s*pointer/i);
});
