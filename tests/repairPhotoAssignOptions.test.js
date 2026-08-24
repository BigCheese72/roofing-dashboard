"use strict";
/* On a Repair work order the photo dropdown lists the Repairs Performed rows
   ("Repair #N") tagged repair:<original-index>, blanks skipped, numbering
   contiguous. repairPhotoAssignOptions extracted from js/core.js. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const ctx = { String };
vm.runInNewContext(src.slice(src.indexOf("function repairPhotoAssignOptions"), src.indexOf("function renderPhotos")), ctx);
const opt = ctx.repairPhotoAssignOptions;

test("lists filled repairs, tagged by ORIGINAL row index, numbered contiguously", () => {
  const out = opt([
    { repair: "Seal flashing", location: "NE corner" },
    { repair: "", location: "" },                 // blank -> skipped
    { repair: "Replace pitch pan", location: "" }
  ]);
  assert.deepEqual(out, [
    { id: "repair:0", label: "Repair #1: Seal flashing" },
    { id: "repair:2", label: "Repair #2: Replace pitch pan" } // id keeps original index 2; label # is contiguous
  ]);
});

test("a location-only repair is included; long text truncated to 40 chars", () => {
  const long = "x".repeat(60);
  const out = opt([{ repair: "", location: "roof drain" }, { repair: long, location: "" }]);
  assert.equal(out[0].id, "repair:0");
  assert.equal(out[0].label, "Repair #1"); // no ": text" when repair text is blank
  assert.equal(out[1].label, "Repair #2: " + "x".repeat(40));
});

test("empty / all-blank repairs -> []", () => {
  assert.deepEqual(opt([]), []);
  assert.deepEqual(opt([{ repair: "", location: "" }, {}]), []);
  assert.deepEqual(opt(null), []);
});

test("ids never collide with a real finding id (always repair:-prefixed)", () => {
  const out = opt([{ repair: "A" }, { repair: "B" }]);
  assert.ok(out.every((o) => /^repair:\d+$/.test(o.id)));
});
