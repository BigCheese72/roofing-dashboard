const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* roofId COLLISION — Orr St, 2026-07-20.

   The renumber dry-run on bld_nocust-unnamed-project surfaced TWO roofs both
   carrying the id "roof_default": one labelled "Roof 5" (holding the base map
   and measurements) and one labelled "Roof 1 (2)". That collision — not the
   "(2)" suffix — is the actual defect.

   Why it makes the building unsafe to operate: every roof mutation in the app
   resolves by id and takes the FIRST match (js/core.js getRoofById,
   js/history.js:1063, js/roofmapper.js findIndex calls). So Rename, Move and
   the RoofMapper switcher all target index 0 whichever roof the user clicked,
   and a delete-by-id would destroy the wrong roof.

   Two guards under test:
     * renumber REFUSES on a collision. Its safety argument is "identity is the
       id, so a label change disturbs nothing" — which is false here, and a
       clean Roof 1..N would erase the only visible symptom.
     * reid addresses by ARRAY INDEX (the only unambiguous handle) and only
       ever breaks a real collision. */

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

/* Load the real helpers. */
function helpers(){
  const src = between(adminSource, "function genRoofId", "exports.handler");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb;
}

/* The actual Orr St shape, from the live dry-run output. */
const ORR_ST = [
  { id: "roof_default",       label: "Roof 5",     roof_outlines: [{}], roof_base_map_type: "drone_ortho" },
  { id: "roof_mrt3f74ew1fv1", label: "Roof 2" },
  { id: "roof_mrt3gpcuqb9t9", label: "Roof 3" },
  { id: "roof_mrt3hs12fvm1q", label: "Roof 4" },
  { id: "roof_default",       label: "Roof 1 (2)" }
];

/* ================= detecting the collision ================= */

test("the real Orr St shape is detected, and points at the LATER entry", () => {
  const dupes = helpers().duplicateRoofIdIndexes(ORR_ST);
  assert.deepEqual(dupes, [{ index: 4, id: "roof_default", firstIndex: 0 }]);
});

test("a healthy building reports no collision", () => {
  const dupes = helpers().duplicateRoofIdIndexes([
    { id: "roof_a", label: "Roof 1" }, { id: "roof_b", label: "Roof 2" }
  ]);
  assert.deepEqual(dupes, []);
});

test("three-way collisions and ragged entries do not throw", () => {
  const sb = helpers();
  assert.equal(sb.duplicateRoofIdIndexes([
    { id: "x" }, { id: "x" }, { id: "x" }
  ]).length, 2, "every entry after the first is a duplicate");
  assert.deepEqual(sb.duplicateRoofIdIndexes([{}, { id: null }, null]), [],
    "an entry with no id is skipped, not treated as a duplicate of another");
  assert.deepEqual(sb.duplicateRoofIdIndexes(null), []);
});

test("generated ids match the app's own roof-id shape", () => {
  const id = helpers().genRoofId();
  assert.match(id, /^roof_[a-z0-9]+$/, id);
  assert.notEqual(id, "roof_default");
});

/* ================= renumber refuses ================= */

test("renumber REFUSES to run on a collision", () => {
  /* Mark is holding a working apply command for this exact building. Without
     this guard, running it swaps which physical roof is called what AND makes
     the building look healthy while the collision remains. */
  const block = between(adminSource, 'body.action === "renumber_building_roofs"', 'body.action === "move_roof"');
  assert.match(block, /duplicateRoofIdIndexes\(stored\)/);
  assert.match(block, /resp\(409,/, "a collision is a conflict, not a silent no-op");
  assert.match(block, /reid_building_roof/, "the refusal must name the way out");
});

test("the refusal happens BEFORE any label computation or write", () => {
  const block = codeOnly(between(adminSource, 'body.action === "renumber_building_roofs"', 'body.action === "move_roof"'));
  const guard = block.indexOf("if (collisions.length)");
  const compute = block.indexOf("renumberRoofLabels(stored)");
  const write = block.indexOf("ref.set(");
  assert.ok(guard !== -1 && guard < compute, "guard must precede the relabel");
  assert.ok(guard < write, "guard must precede the write");
});

test("the refusal shows the caller the actual roof list", () => {
  /* A bare "refused" leaves them unable to pick a roofIndex for the fix. */
  const block = between(adminSource, 'body.action === "renumber_building_roofs"', 'body.action === "move_roof"');
  assert.match(block, /roofs: stored\.map\(\(r, i\) => \(\{ index: i/);
});

/* ================= reid: addressing and guardrails ================= */

const REID = () => between(adminSource, 'body.action === "reid_building_roof"', 'body.action === "renumber_building_roofs"');

test("reid addresses by ARRAY INDEX, never by the ambiguous id", () => {
  const b = codeOnly(REID());
  assert.match(b, /Number\.isInteger\(body\.roofIndex\)/);
  assert.match(b, /stored\[roofIndex\]/);
  assert.doesNotMatch(b, /\.find\(r => r\.id === body\.roofId\)/,
    "addressing by id is the bug, not the fix");
});

test("reid DRY RUNS by default — writing needs an explicit apply", () => {
  const b = REID();
  assert.match(b, /const apply = body\.apply === true/);
  assert.match(b, /dryRun: !apply/);
  const early = b.indexOf("if (!apply) return resp(200, payload)");
  const write = b.indexOf("ref.set(");
  assert.ok(early !== -1 && early < write, "the dry-run return must precede the write");
});

test("reid only ever breaks a REAL collision", () => {
  /* It re-keys a roof WITHOUT re-pointing its records. That is only defensible
     when the id was ambiguous already; on a uniquely-identified roof it would
     deliberately orphan every record referencing it. */
  const b = REID();
  assert.match(b, /dupes\.some\(d => d\.id === oldId\)/);
    assert.match(b, /does not share its id with another roof/);
});

test("reid refuses an out-of-range index and never synthesises roofs", () => {
  const b = REID();
  assert.match(b, /roofIndex >= stored\.length/);
  assert.match(b, /Array\.isArray\(bld\.roofs\) \? bld\.roofs : \[\]/);
  assert.doesNotMatch(codeOnly(b), /getBuildingRoofsServer\(/);
});

test("reid changes ONLY the id — geometry and base map ride through", () => {
  const b = REID();
  assert.match(b, /Object\.assign\(\{\}, target, \{ id: newId, updatedAt: Date\.now\(\) \}\)/);
});

test("reid does NOT re-point records, and says so in the preview", () => {
  /* Deciding which physical roof each record describes needs a human and the
     photo GPS. Guessing would bake a wrong answer into the record silently. */
  const b = REID();
  assert.match(b, /referencesToOldId/);
  assert.match(b, /historyEvents: evtSnap\.size/);
  assert.match(b, /NOT re-pointed/);
  assert.doesNotMatch(codeOnly(b), /batch\.set\(d\.ref/, "must not re-point anything");
});

test("the preview reports what the target roof actually carries", () => {
  /* This is how Mark decides keep-vs-delete: an empty duplicate looks very
     different from one holding an outline and a base map. */
  const b = REID();
  ["outlines:", "assets:", "baseMap:", "roofSystem:"].forEach(k =>
    assert.ok(b.includes(k), "preview must report " + k));
});

test("reid is admin-gated and audited like every other roof action", () => {
  const b = REID();
  assert.match(b, /requirePermission\(event, "settings\.company"\)/);
  assert.match(b, /writeAuditLog\(db, caller, "reid_building_roof"/);
  assert.match(b, /oldId/);
  assert.match(b, /newId/);
});

test("a generated id colliding with an existing roof is caught, not written", () => {
  const b = REID();
  assert.match(b, /stored\.some\(r => r && r\.id === newId\)/);
});
