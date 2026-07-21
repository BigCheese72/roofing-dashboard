const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/* REQUIRED #1 from the pre-promotion review (2026-07-20): LIVE DATA LOSS.

   merge_buildings re-pointed a work order's buildingId/buildingName/customer
   but left jobName, location and billTo holding the LOSER's values. A work
   order carries the building's identity a second time, in those editable
   fields, so the merge set a trap that sprang on the next ordinary save:

     ensureCustomerAndBuilding() resolves the stored buildingId -> gets the
     SURVIVOR -> the survivor was not itself merged away, so redirectedByMerge
     is false -> ownsBuilding === true -> it writes patch.name = o.jobName,
     patch.location = o.location, patch.customerName from o.billTo onto the
     survivor.

   Result: "Orr Street Studios" is renamed "KOMU" and its address overwritten,
   by a save that looks completely normal. The Orr Street merge had already run
   in production, so affected work orders were primed to do this on next save.

   No smoke test catches it -- it only fires on save. These tests are the guard. */

const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

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
const MERGE = () => between(adminSource, 'body.action === "merge_buildings"', 'body.action === "renumber_building_roofs"');

/* ================= the fix ================= */

test("work orders receive the SURVIVOR's jobName, location and billTo", () => {
  /* Without all three, the next save writes the loser's identity onto the
     survivor. jobName renames it; location overwrites the address; billTo
     re-points the customer. */
  const m = codeOnly(MERGE());
  const wo = between(m, "const woReassign", "});");
  assert.match(wo, /jobName:/, "jobName missing -> survivor gets renamed on next save");
  assert.match(wo, /location:/, "location missing -> survivor's address overwritten");
  assert.match(wo, /billTo:/, "billTo missing -> survivor's customer overwritten");
});

test("those three come from the SURVIVOR, never the source building", () => {
  /* Taking them from srcBld would write the loser's identity deliberately --
     the same corruption, just on purpose. */
  const wo = between(codeOnly(MERGE()), "const woReassign", "});");
  assert.match(wo, /jobName: chosenName \|\| dstBld\.name/);
  assert.match(wo, /location: dstBld\.location/);
  assert.doesNotMatch(wo, /location: srcBld/);
  assert.doesNotMatch(wo, /jobName: srcBld/);
});

test("the work-order patch is the one carrying identity — not events or reports", () => {
  /* History events, reports and DPRs have no jobName/location/billTo fields;
     writing them there would add stray keys to documents that never had them. */
  const m = codeOnly(MERGE());
  assert.match(m, /woSnap\.forEach\(d => writes\.push\(\{ ref: d\.ref, data: woReassign \}\)\)/);
  assert.match(m, /evtSnap\.forEach\(d => writes\.push\(\{ ref: d\.ref, data: reassign \}\)\)/);
  assert.match(m, /repSnap\.forEach\(d => writes\.push\(\{ ref: d\.ref, data: reassign \}\)\)/);
  assert.match(m, /dprSnap\.forEach\(d => writes\.push\(\{ ref: d\.ref, data: reassign \}\)\)/);
});

test("woReassign still carries everything the base patch does", () => {
  /* It must EXTEND the pointer patch, not replace it -- dropping buildingId
     would leave the work order pointing at the archived loser. */
  const m = codeOnly(MERGE());
  assert.match(m, /const woReassign = Object\.assign\(\{\}, reassign, \{/);
});

test("roofSystem is deliberately NOT copied", () => {
  /* A work order's roofSystem describes the roof being worked and legitimately
     differs per order; copying the building's would be a new bug, not a fix. */
  const wo = between(codeOnly(MERGE()), "const woReassign", "});");
  assert.doesNotMatch(wo, /roofSystem/);
});

/* ================= why it was silent ================= */

test("the save path really does write these fields onto the building", () => {
  /* This is the mechanism the fix defuses. If ownsBuilding ever stops writing
     name/location/customerName, this test should be revisited -- but while it
     does, the merge MUST leave the work order describing the survivor. */
  const ensure = between(coreSource, "var ownsBuilding", "if (o.companyCamProjectId)");
  assert.match(ensure, /patch\.name = bldName/);
  assert.match(ensure, /patch\.location = o\.location/);
  assert.match(ensure, /patch\.customerName = custName/);
});

test("a merge-re-pointed order is NOT treated as redirected", () => {
  /* The trap's trigger: the survivor was not itself merged away, so
     resolveMergedBuildingId() returns it unchanged, redirectedByMerge is
     false, and ownsBuilding is true -- the order is allowed to rewrite the
     building it now points at. */
  const ensure = between(coreSource, "var resolvedStored", "var patch = {");
  assert.match(ensure, /redirectedByMerge = !!\(resolvedStored && o\.buildingId && resolvedStored !== o\.buildingId\)/);
  assert.match(ensure, /var ownsBuilding = !redirectedByMerge/);
});
