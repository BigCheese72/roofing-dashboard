const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* The Change Order report builders (buildChangeOrderText / renderChangeOrderDoc /
   generateChangeOrderPdf) print their OWN Materials section — they do NOT flow
   through the leak/repair report builders. Mark: "a change order form needs
   materials too." So the itemized Material List (materials[]) is now the primary
   materials entry on a Change Order, with the legacy free-text #woMaterials kept
   as "Additional Material Notes" for backward compatibility. This exercises the
   text builder's Materials block functionally, and shape-guards the HTML + PDF
   builders. */
function runTextMaterialsBlock(materials, woMaterials){
  const L = [];
  const sandbox = { L, materials, o: { woMaterials } };
  vm.createContext(sandbox);
  /* the two shared helpers + the CO text builder's Materials block */
  vm.runInContext(
    between(exportSource, "function filledMaterials", "function materialRepairRefLabel") +
    between(exportSource, "function materialLineLabel", "/* \"Finding #N\"") +
    between(exportSource, 'L.push("MATERIALS");', 'L.push("MAN-HOURS: "'),
    sandbox
  );
  return L.join("\n");
}

test("CO text builder prints the itemized Material List (qty/unit/notes)", () => {
  const out = runTextMaterialsBlock([
    { id: "mat_a", material: "", qty: "", unit: "", notes: "", repair_id: null }, /* blank — skipped */
    { id: "mat_b", material: "Lap sealant", qty: "2", unit: "tubes", notes: "sealed seam", repair_id: null }
  ], "");
  assert.match(out, /MATERIALS/);
  assert.match(out, /1\. Lap sealant x2 tubes — sealed seam/);
  /* blank row does not print, so numbering starts at 1 for the first real row */
  assert.doesNotMatch(out, /2\. /);
  assert.doesNotMatch(out, /Additional Material Notes/, "no legacy notes header when #woMaterials is empty");
});

test("CO text builder keeps legacy free-text #woMaterials as Additional Material Notes (backward compatible)", () => {
  /* An existing Change Order with ONLY the old free-text field must not lose it. */
  const out = runTextMaterialsBlock([], "50 tubes roofing cement\n2 rolls membrane");
  assert.match(out, /Additional Material Notes:/);
  assert.match(out, /50 tubes roofing cement\n2 rolls membrane/);
});

test("CO text builder prints itemized list FIRST, then legacy notes, when both are present", () => {
  const out = runTextMaterialsBlock(
    [{ id: "mat_b", material: "Lap sealant", qty: "2", unit: "tubes", notes: "", repair_id: null }],
    "misc fasteners");
  const itemIdx = out.indexOf("1. Lap sealant");
  const noteIdx = out.indexOf("Additional Material Notes:");
  assert.ok(itemIdx > -1 && noteIdx > -1);
  assert.ok(itemIdx < noteIdx, "itemized list is primary and prints ahead of legacy notes");
});

test("CO HTML doc builder renders itemized materials[] and preserves legacy notes", () => {
  const block = between(exportSource, "h += \"<h3 class='cond'>Materials</h3>\";", "h += \"<h3 class='cond'>Cost Summary");
  assert.match(block, /var coMat = filledMaterials\(\)/);
  assert.match(block, /materialLineLabel\(m\)/);
  assert.match(block, /Additional Material Notes/);
});

test("CO PDF builder renders itemized materials[] and preserves legacy notes", () => {
  const block = between(exportSource, 'heading("Materials");', 'heading("Cost Summary");');
  assert.match(block, /var coMat = filledMaterials\(\)/);
  assert.match(block, /coMat\.map\(materialLineLabel\)/);
  assert.match(block, /Additional Material Notes/);
});
