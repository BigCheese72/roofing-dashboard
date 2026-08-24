"use strict";
/* Safeguard: a finding with photos attached must appear in the report even if
   its Condition/Location text is still blank (so its photos aren't dropped).
   filledFindings/findingHasPhotos extracted from js/export.js. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const block = src.slice(src.indexOf("function findingHasPhotos"), src.indexOf("function filledRepairs"));

function ctxWith(findings, photos){ const ctx = { findings, photos }; vm.runInNewContext(block, ctx); return ctx; }

test("blank finding WITH photos is included", () => {
  const ctx = ctxWith(
    [{ id: "f1", condition: "", location: "" }],
    [{ finding_id: "f1", img: "x" }]
  );
  assert.deepEqual(ctx.filledFindings().map((f) => f.id), ["f1"]);
});

test("blank finding with NO photos is still excluded", () => {
  const ctx = ctxWith([{ id: "f1", condition: "", location: "" }], []);
  assert.deepEqual(ctx.filledFindings(), []);
});

test("findings with text are included regardless of photos", () => {
  const ctx = ctxWith(
    [{ id: "f1", condition: "Fair" }, { id: "f2", location: "North" }, { id: "f3", condition: "", location: "" }],
    []
  );
  assert.deepEqual(ctx.filledFindings().map((f) => f.id), ["f1", "f2"]);
});

test("photos on a different finding don't rescue an unrelated blank one", () => {
  const ctx = ctxWith(
    [{ id: "f1", condition: "", location: "" }, { id: "f2", condition: "Poor" }],
    [{ finding_id: "f2", img: "x" }]
  );
  assert.deepEqual(ctx.filledFindings().map((f) => f.id), ["f2"]);
});
