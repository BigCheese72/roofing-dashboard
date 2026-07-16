const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "css", "app.css"), "utf8");

test("RoofMapper tracing mode uses pointer cursor instead of Leaflet grab cursor", () => {
  assert.doesNotMatch(css, /(^|\n)\s*#rm-map\s*,[\s\S]*?\{cursor:pointer\}/, "normal RoofMapper map panning is not globally forced to pointer");
  assert.match(css, /#rm-map-wrap\.rm-precision-active\s+#rm-map\s+\.leaflet-grab/, "Leaflet grab class is overridden only in precision mode");
  assert.match(css, /#rm-map-wrap\.rm-precision-active\s+#rm-map\.leaflet-dragging/, "Leaflet dragging class is overridden only in precision mode");
  assert.doesNotMatch(css, /#rm-map-wrap\.rm-precision-active[^{}]*\{[^{}]*cursor\s*:\s*crosshair/i);
  assert.match(css, /#rm-map-wrap\.rm-precision-active[^{}]*#rm-map[^{}]*\{[^{}]*cursor\s*:\s*pointer/i);
});
