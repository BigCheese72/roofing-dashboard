const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Click-to-zoom lightbox (Mark: "I should be able to zoom any photo I
   click on."). Two guarantees regress-tested here:
     1. The pure zoom math keeps the pixel under the cursor fixed while
        scaling, clamps to [min,max], snaps back to centered at 1x, and
        never lets the image pan fully off the viewport.
     2. Every read-only photo render site actually wires a click handler
        into the shared lightbox -- the "clicking a photo does nothing"
        half of the bug was these bare <img>s having no onclick. */

const photosSrc = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const start = photosSrc.indexOf("function lightboxZoomToward");
assert.notEqual(start, -1, "lightboxZoomToward not found in photos.js");
const end = photosSrc.indexOf("function applyLightboxTransform", start);
assert.notEqual(end, -1, "applyLightboxTransform not found in photos.js");
const ctx = {};
vm.runInNewContext(photosSrc.slice(start, end), ctx);
const lightboxZoomToward = ctx.lightboxZoomToward;
const lightboxClampPan = ctx.lightboxClampPan;

const base = { scale: 1, x: 0, y: 0, min: 1, max: 6 };

test("zooming about the viewer center leaves pan at 0", () => {
  // origin (500,400) == cursor (500,400): the anchor is the center itself.
  const r = lightboxZoomToward(base, 2, 500, 400, 500, 400);
  assert.equal(r.scale, 2);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test("zooming toward an off-center point pans so that point stays put", () => {
  // Anchor 100px right / 50px below center; k = 2/1 = 2, so pan = (c-o)*(1-k) = -100,-50.
  const r = lightboxZoomToward(base, 2, 600, 450, 500, 400);
  assert.equal(r.x, -100);
  assert.equal(r.y, -50);
  // Invariant: the pixel under the cursor maps back to the same screen point.
  // screen = origin + pan + scale*u, with u = cursor-origin at scale 1 = (100,50).
  assert.equal(500 + r.x + r.scale * 100, 600);
  assert.equal(400 + r.y + r.scale * 50, 450);
});

test("scale is clamped to [min,max]", () => {
  assert.equal(lightboxZoomToward(base, 99, 500, 400, 500, 400).scale, 6);
  assert.equal(lightboxZoomToward(base, 0.1, 500, 400, 500, 400).scale, 1);
});

test("returning to 1x snaps pan back to centered", () => {
  const zoomed = lightboxZoomToward(base, 3, 700, 500, 500, 400);
  assert.notEqual(zoomed.x, 0);
  const backToOne = lightboxZoomToward(zoomed, 1, 700, 500, 500, 400);
  assert.equal(backToOne.scale, 1);
  assert.equal(backToOne.x, 0);
  assert.equal(backToOne.y, 0);
});

test("pan is clamped so the image can't be dragged off-viewport", () => {
  // image 2000x1600 inside a 1000x800 viewport => max pan (2000-1000)/2=500, (1600-800)/2=400.
  const state = { scale: 2, x: 9999, y: -9999, min: 1, max: 6 };
  const c = lightboxClampPan(state, 1000, 800, 2000, 1600);
  assert.equal(c.x, 500);
  assert.equal(c.y, -400);
});

test("an image smaller than the viewport is pinned to center (no pan)", () => {
  const state = { scale: 1, x: 30, y: -20, min: 1, max: 6 };
  const c = lightboxClampPan(state, 1000, 800, 600, 400);
  assert.ok(c.x === 0, "x pinned to 0");   // === so -0 counts as 0 (Object.is would not)
  assert.ok(c.y === 0, "y pinned to 0");
});

/* Regression guard for the "clicking a photo does nothing" half: the
   read-only building-history timeline and the activity-photo previews must
   route clicks into the shared lightbox. The timeline photo also lives
   inside a card whose own onclick opens the source work order (#133), so it
   must stopPropagation to open the viewer instead of navigating away. */
const historySrc = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");

test("building-history timeline photos open the lightbox (and don't bubble to the card)", () => {
  const block = historySrc.slice(historySrc.indexOf("function timelineEventHtml"),
    historySrc.indexOf("function renderTimelineList"));
  const imgLines = block.split("\n").filter((l) => l.includes("return '<img"));
  assert.ok(imgLines.length, "expected a photo <img> in timelineEventHtml");
  assert.ok(imgLines.every((l) => l.includes("openImageLightbox(this.src)")),
    "timeline photos must wire openImageLightbox(this.src)");
  assert.ok(imgLines.every((l) => l.includes("event.stopPropagation()")),
    "timeline photos must stopPropagation so the card's onclick doesn't fire too");
});

test("activity-photo previews open the lightbox on click", () => {
  const block = historySrc.slice(historySrc.indexOf("function renderActivityPhotosStatus"),
    historySrc.indexOf("function removeActivityPhoto"));
  const imgLine = block.split("\n").find((l) => l.includes("<img src="));
  assert.ok(imgLine && imgLine.includes("openImageLightbox(this.src)"),
    "activity-photo previews must wire openImageLightbox(this.src)");
});
