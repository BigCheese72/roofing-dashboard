const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Removing the empty duplicate roof — Orr St, 2026-07-20.

   Confirmed by a read-only dump of the live building:

     0 roof_default        "Roof 5"      outlines:1  <- real, holds the base map
     1 roof_mrt3f74ew1fv1  "Roof 2"      outlines:1  assets:2
     2 roof_mrt3gpcuqb9t9  "Roof 3"      outlines:1
     3 roof_mrt3hs12fvm1q  "Roof 4"      outlines:1
     4 roof_default        "Roof 1 (2)"  outlines:0  assets:0  <- empty phantom

   Removing index 4 resolves the id collision outright, and Mark's saved
   inspection left "Roof 1 (2)" unchecked, so nothing of his describes it.

   This is the ONLY destructive roof operation in the codebase. These tests
   exist to keep all three fences standing: index-addressed, later-duplicate
   only, empty only. */

const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");

function codeOnly(src){
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}
const REMOVE = () => between(adminSource, 'body.action === "remove_building_roof_by_index"', 'body.action === "reid_building_roof"');

function helpers(){
  const src = between(adminSource, "function genRoofId", "exports.handler");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb;
}

/* The live Orr St shape. */
const ORR_ST = [
  { id: "roof_default",       label: "Roof 5",     roof_outlines: [{}] },
  { id: "roof_mrt3f74ew1fv1", label: "Roof 2",     roof_outlines: [{}], roof_assets: [{}, {}] },
  { id: "roof_mrt3gpcuqb9t9", label: "Roof 3",     roof_outlines: [{}] },
  { id: "roof_mrt3hs12fvm1q", label: "Roof 4",     roof_outlines: [{}] },
  { id: "roof_default",       label: "Roof 1 (2)", roofSystem: "FA EPDM" }
];

/* ================= THE index-0 question ================= */

test("index 0 is STRUCTURALLY unremovable — it is never a 'later duplicate'", () => {
  /* The guarantee asked for. duplicateRoofIdIndexes() reports the first
     occurrence of an id as `firstIndex` and only subsequent ones as `index`.
     The guard tests `d.index === roofIndex`, so the entry every by-id lookup
     resolves to can never be selected — regardless of what it contains. */
  const dupes = helpers().duplicateRoofIdIndexes(ORR_ST);
  assert.deepEqual(dupes, [{ index: 4, id: "roof_default", firstIndex: 0 }]);
  assert.ok(!dupes.some(d => d.index === 0), "index 0 must never appear as a removable index");
  assert.ok(dupes.some(d => d.index === 4), "index 4 is the removable duplicate");
});

test("index 0 stays unremovable even if it were the EMPTY one", () => {
  /* Belt and braces: if the phantom had landed first and the real roof second,
     the guard must still refuse index 0 — because by-id lookups resolve there,
     so removing it would silently re-aim every existing reference. */
  const flipped = [
    { id: "roof_default", label: "Roof 1 (2)" },            // empty, FIRST
    { id: "roof_default", label: "Roof 5", roof_outlines: [{}] }
  ];
  const dupes = helpers().duplicateRoofIdIndexes(flipped);
  assert.ok(!dupes.some(d => d.index === 0), "the first occurrence is never removable");
  assert.deepEqual(dupes.map(d => d.index), [1]);
});

test("the guard is on d.index, not merely 'shares an id'", () => {
  /* `dupes.some(d => d.id === target.id)` would have matched index 0 too —
     that is the subtle version of this bug. */
  const b = codeOnly(REMOVE());
  assert.match(b, /dupes\.some\(d => d\.index === roofIndex\)/);
  assert.doesNotMatch(b, /dupes\.some\(d => d\.id === oldId\)/);
});

/* ================= the three fences ================= */

test("addressed by ARRAY INDEX, never by the ambiguous id", () => {
  const b = codeOnly(REMOVE());
  assert.match(b, /Number\.isInteger\(body\.roofIndex\)/);
  assert.match(b, /stored\[roofIndex\]/);
  assert.match(b, /stored\.filter\(\(r, i\) => i !== roofIndex\)/);
});

test("a non-duplicate roof is REFUSED, with the roof list so the caller can act", () => {
  const b = REMOVE();
  assert.match(b, /resp\(409,/);
  assert.match(b, /not a later duplicate/);
  assert.match(b, /roofs: stored\.map\(\(r, i\) => \(\{ index: i/);
});

test("a roof carrying ANY work is REFUSED and redirected to reid", () => {
  /* Outlines, assets, markup or a base map all mean a real roof. The refusal
     names the non-destructive alternative rather than dead-ending. */
  const b = REMOVE();
  assert.match(b, /carries work/);
  assert.match(b, /reid_building_roof/);
  const g = codeOnly(b);
  ["roof_outlines", "roof_assets", "roof_markup", "roof_base_map_type", "roof_base_map_url"]
    .forEach(f => assert.ok(g.includes(f), "emptiness must consider " + f));
});

test("emptiness requires ALL of them to be clear", () => {
  const b = codeOnly(REMOVE());
  assert.match(b, /carries\.outlines === 0 && carries\.assets === 0 && carries\.markup === 0 &&\s*!carries\.baseMapType && !carries\.baseMapUrl/);
});

test("both guards run BEFORE any write", () => {
  const b = codeOnly(REMOVE());
  const dupGuard = b.indexOf("isRemovableDuplicate");
  const emptyGuard = b.indexOf("if (!isEmpty)");
  const write = b.indexOf("ref.set(");
  assert.ok(dupGuard !== -1 && dupGuard < write);
  assert.ok(emptyGuard !== -1 && emptyGuard < write);
});

/* ================= preview and reversibility ================= */

test("DRY RUN by default — writing needs an explicit apply", () => {
  const b = REMOVE();
  assert.match(b, /const apply = body\.apply === true/);
  assert.match(b, /dryRun: !apply/);
  const early = b.indexOf("if (!apply) return resp(200, payload)");
  const write = b.indexOf("ref.set(");
  assert.ok(early !== -1 && early < write, "the dry-run return must precede the write");
});

test("the preview shows what is going and what is left", () => {
  const b = REMOVE();
  assert.match(b, /removing: \{ index: roofIndex/);
  assert.match(b, /resultingRoofs:/);
  assert.match(b, /remainingDuplicates: duplicateRoofIdIndexes\(next\)/,
    "must confirm the collision is actually resolved");
});

test("descriptive metadata loss is surfaced, not hidden", () => {
  /* Emptiness is judged on WORK, so a phantom carrying roofSystem "FA EPDM"
     still qualifies. That loss should be a seen decision. */
  const b = REMOVE();
  assert.match(b, /alsoLosesMetadata/);
  assert.match(b, /roofSystem: target\.roofSystem/);
});

test("the removal is reversible from the audit trail", () => {
  /* The only destructive roof op in the codebase stores the WHOLE roof. */
  const b = REMOVE();
  assert.match(b, /const removed = Object\.assign\(\{\}, target\)/);
  assert.match(b, /writeAuditLog\(db, caller, "remove_building_roof_by_index"/);
  assert.match(b, /removedRoof: removed/);
});

test("admin-gated, and never synthesises a roofs[] to delete from", () => {
  const b = REMOVE();
  assert.match(b, /requirePermission\(event, "settings\.company"\)/);
  assert.match(b, /Array\.isArray\(bld\.roofs\) \? bld\.roofs : \[\]/);
  assert.doesNotMatch(codeOnly(b), /getBuildingRoofsServer\(/);
  assert.match(b, /roofIndex >= stored\.length/);
});

/* ================= the outcome ================= */

test("removing index 4 resolves the collision and leaves every real roof", () => {
  const sb = helpers();
  const next = ORR_ST.filter((r, i) => i !== 4);
  assert.equal(next.length, 4);
  assert.deepEqual(sb.duplicateRoofIdIndexes(next), [], "ids unambiguous again");
  assert.deepEqual(next.map(r => r.label), ["Roof 5", "Roof 2", "Roof 3", "Roof 4"]);
  next.forEach(r => assert.ok((r.roof_outlines || []).length > 0, r.label + " keeps its outline"));
});

test("after removal, renumber is unblocked", () => {
  /* renumber refuses on a collision; clearing it is what re-enables the
     cosmetic relabel Mark originally asked for. */
  const sb = helpers();
  assert.deepEqual(sb.duplicateRoofIdIndexes(ORR_ST.filter((r, i) => i !== 4)), []);
});
