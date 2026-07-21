const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Roof label renumbering after a merge (Mark, 2026-07-20).

   After the Orr Street merge his roofs read "Roof 1 (2)". That suffix is the
   merge's collision guard working correctly -- both buildings had a "Roof 1"
   and one had to give -- but it reads like a duplicate record. Mark's rule:
   RENAME it, never delete it. Each of these is a real roof carrying real
   geometry and pins; deleting one to tidy a name would be catastrophic.

   The safety argument, which these tests exist to keep true: a roof's identity
   is its `id`. Pins, base maps, outlines, assets, checklist rows (keyed
   roofId+key) and history events all reference the id. Nothing keys off the
   label. So renumbering rewrites a display string and moves no data -- but ONLY
   as long as every other field survives the rewrite untouched. */

const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Strip // comments before asserting a token is ABSENT. Twice now a
   doesNotMatch has fired on a comment explaining why the thing is not done --
   "NOT getBuildingRoofsServer(): ...". The assertion is about the code.

   Note this file is CRLF: `.` does not match \r, so the obvious /\/\/.*$/
   silently strips NOTHING here. [^\n]* does match \r. */
function codeOnly(src){
  return src.replace(/\/\/[^\n]*/g, "");
}

/* Load the real helper, not a restatement of it. */
const HELPER_SRC = between(adminSource, "const GENERIC_ROOF_LABEL", "exports.handler");
function renumber(roofs){
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(HELPER_SRC, sb);
  return sb.renumberRoofLabels(roofs);
}
const labelsOf = (r) => r.roofs.map(x => x.label);

/* ================= the Orr Street case ================= */

test("the Orr Street shape: 'Roof 1 (2)' becomes a clean sequence", () => {
  const out = renumber([
    { id: "a", label: "Roof 1" },
    { id: "b", label: "Roof 2" },
    { id: "c", label: "Roof 3" },
    { id: "d", label: "Roof 1 (2)" }
  ]);
  assert.deepEqual(labelsOf(out), ["Roof 1", "Roof 2", "Roof 3", "Roof 4"]);
  assert.deepEqual(out.changes, [{ roofId: "d", from: "Roof 1 (2)", to: "Roof 4" }],
    "only the collided roof is touched — the other three are already correct");
});

test("no roof is ever dropped", () => {
  /* Mark was explicit: it is a REAL roof with a colliding name, not a phantom.
     Any change that reduces the roof count is a data-loss bug. */
  const input = [
    { id: "a", label: "Roof 1" }, { id: "b", label: "Roof 1 (2)" },
    { id: "c", label: "Roof 1 (3)" }, { id: "d", label: "North Wing" }
  ];
  const out = renumber(input);
  assert.equal(out.roofs.length, input.length);
  assert.deepEqual(out.roofs.map(r => r.id).sort(), ["a","b","c","d"]);
});

test("every non-label field survives — geometry, pins, base map, outlines", () => {
  /* The whole safety argument is "only the display string changes". If a
     renumber ever dropped roof_outlines or a base map, a roof would keep its
     name and lose its shape. */
  const rich = {
    id: "r1", label: "Roof 1 (2)",
    roofSystem: "TPO",
    roof_base_map_type: "drone_ortho",
    roof_base_map_url: "https://example/x.png",
    roof_base_map_bounds: { north: 1, south: 0, east: 1, west: 0 },
    roof_assets: [{ kind: "drain" }, { kind: "hatch" }],
    roof_outlines: [{ points: [[0,0],[1,1]], areaSqFt: 1200 }],
    areaSqFt: 1200, ageYears: 12
  };
  const out = renumber([rich]);
  const got = out.roofs[0];
  assert.equal(got.label, "Roof 1", "label changed");
  Object.keys(rich).forEach(k => {
    if (k === "label") return;
    assert.deepEqual(got[k], rich[k], "field must survive renumbering: " + k);
  });
});

test("the original roof objects are not mutated in place", () => {
  /* A dry run must not alter the caller's data — it reports what WOULD change. */
  const input = [{ id: "a", label: "Roof 1 (2)" }];
  renumber(input);
  assert.equal(input[0].label, "Roof 1 (2)", "dry-run inspection must not mutate");
});

/* ================= custom names ================= */

test("hand-typed roof names are never renumbered away", () => {
  /* Blindly forcing Roof 1..N would destroy "North Wing" — worse than the
     suffix it fixes. */
  const out = renumber([
    { id: "a", label: "North Wing" },
    { id: "b", label: "Roof 1" },
    { id: "c", label: "Roof 1 (2)" },
    { id: "d", label: "Boiler Room Roof" }
  ]);
  assert.deepEqual(labelsOf(out), ["North Wing", "Roof 1", "Roof 2", "Boiler Room Roof"]);
});

test("a custom name that merely CONTAINS a number stays custom", () => {
  const out = renumber([
    { id: "a", label: "Roof 2 - North Annex" },
    { id: "b", label: "Roof 1 (2)" }
  ]);
  assert.deepEqual(labelsOf(out), ["Roof 2 - North Annex", "Roof 1"]);
});

test("renumbering never hands out a label a custom name already holds", () => {
  const out = renumber([
    { id: "a", label: "roof 1" },        // generic, case-insensitive
    { id: "b", label: "Roof 9 Annex" },  // custom
    { id: "c", label: "Roof 5 (2)" }     // generic
  ]);
  const labels = labelsOf(out);
  assert.equal(new Set(labels.map(l => l.toLowerCase())).size, labels.length,
    "no two roofs may share a label: " + JSON.stringify(labels));
});

/* ================= idempotence and no-ops ================= */

test("an already-clean sequence reports no changes and rewrites nothing", () => {
  const input = [{ id: "a", label: "Roof 1" }, { id: "b", label: "Roof 2" }];
  const out = renumber(input);
  assert.deepEqual(out.changes, []);
  assert.strictEqual(out.roofs[0], input[0], "unchanged roofs are returned by reference, not rewritten");
});

test("renumbering is idempotent — running it twice changes nothing the second time", () => {
  const once = renumber([{ id: "a", label: "Roof 1" }, { id: "b", label: "Roof 1 (2)" }]);
  const twice = renumber(once.roofs);
  assert.deepEqual(twice.changes, []);
  assert.deepEqual(labelsOf(twice), labelsOf(once));
});

test("empty and ragged input is handled without throwing", () => {
  assert.deepEqual(renumber([]).roofs, []);
  assert.deepEqual(renumber(null).roofs, []);
  assert.deepEqual(renumber(undefined).changes, []);
  const ragged = renumber([{ id: "x" }, { id: "y", label: null }, {}]);
  assert.equal(ragged.roofs.length, 3, "a roof with no label is left alone, not dropped");
});

test("case and spacing variants of the generic pattern are recognised", () => {
  const out = renumber([
    { id: "a", label: "ROOF 3" }, { id: "b", label: "roof  4 (2)" }, { id: "c", label: " Roof 7 " }
  ]);
  assert.deepEqual(labelsOf(out), ["Roof 1", "Roof 2", "Roof 3"]);
});

/* ================= the action wiring ================= */

test("the action DRY RUNS by default — writing needs an explicit apply", () => {
  /* The anxiety here is losing a roof, so the old->new mapping is reviewable
     before anything is written. Especially for the Orr Street backfill, which
     mutates production data. */
  const block = between(adminSource, 'body.action === "renumber_building_roofs"', 'body.action === "move_roof"');
  assert.match(block, /const apply = body\.apply === true/, "opt-IN to writing, not opt-out");
  assert.match(block, /dryRun: !apply/);
  const applyIdx = block.indexOf("if (!apply");
  const writeIdx = block.indexOf("ref.set(");
  assert.ok(applyIdx !== -1 && applyIdx < writeIdx, "the dry-run early-return must precede the write");
});

test("the action never synthesises a roofs[] onto a building that has none", () => {
  /* getBuildingRoofsServer() invents a default roof for a building that never
     stored one; writing that back would materialise a phantom roof. Same rule
     the merge follows for srcRoofs. */
  const block = between(adminSource, 'body.action === "renumber_building_roofs"', 'body.action === "move_roof"');
  assert.doesNotMatch(codeOnly(block), /getBuildingRoofsServer\(/);
  assert.match(block, /Array\.isArray\(bld\.roofs\) \? bld\.roofs : \[\]/);
});

test("the action is admin-gated and audited like every other roof action", () => {
  const block = between(adminSource, 'body.action === "renumber_building_roofs"', 'body.action === "move_roof"');
  assert.match(block, /requirePermission\(event, "settings\.company"\)/);
  assert.match(block, /writeAuditLog\(/);
  assert.match(block, /changes: result\.changes/, "the audit records old->new, not just 'it ran'");
});

test("the merge de-collides FIRST, then renumbers", () => {
  /* Order matters. The suffix guarantees no two roofs share a label mid-merge;
     renumbering then tidies the result. Renumbering first would let two roofs
     collide. */
  const block = between(adminSource, 'body.action === "merge_buildings"', "await writeAuditLog");
  const suffixIdx = block.indexOf('candidate = label + " ("');
  const renumIdx = block.indexOf("renumberRoofLabels(");
  assert.ok(suffixIdx !== -1 && renumIdx !== -1 && suffixIdx < renumIdx,
    "collision guard must run before renumbering");
});

test("the merge reports and audits the roof renaming", () => {
  const block = between(adminSource, 'body.action === "merge_buildings"', 'body.action === "renumber_building_roofs"');
  assert.match(block, /roofRenumbering: roofRenumbering/);
  const auditIdx = block.indexOf("writeAuditLog");
  assert.ok(block.indexOf("roofRenumbering", auditIdx) !== -1,
    "the audit entry must carry the old->new mapping");
});
