const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Orphaned records after a building merge (Mark, KOMU job 17488, 2026-07-19).

   THE BUG. merge_buildings re-pointed building_history_events and reports, but
   NOT workorders. A saved inspection therefore kept storing the loser's
   buildingId, and lookupProspectiveBuildingRoofInfo() resolves the stored id
   first (correctly -- that rule is what makes renames safe). So the inspection
   resolved to the archived loser, which the merge had just EMPTIED (roofs: []),
   and getBuildingRoofs() synthesised a phantom "Roof 1" with no base map and no
   history. Mark's screen exactly.

   THREE DEFENCES, tested here:
     (a) the merge re-points every collection carrying a buildingId
     (b) resolveMergedBuildingId() follows mergedIntoBuildingId, so rows written
         BEFORE (a) existed heal themselves with no backfill
     (c) a manual re-file, for a mis-link no merge explains */

const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const ccSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "buildinghistory.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function from(src, start){
  const a = src.indexOf(start);
  assert.notStrictEqual(a, -1, "missing start: " + start);
  return src.slice(a);
}
function between(src, start, end){
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start: " + start);
  assert.notStrictEqual(b, -1, "missing end: " + end);
  return src.slice(a, b);
}
const MERGE = between(adminSource, 'if (body.action === "merge_buildings")', 'if (body.action === "move_roof")');

/* ---- (b) the forward-follow, exercised against a fake Firestore ---- */
function followSandbox(docs){
  const sb = {
    fdb: {
      collection(){
        return { doc(id){ return { async get(){
          const d = docs[id];
          return d ? { exists: true, data: () => d } : { exists: false };
        } }; } };
      }
    },
    console: { warn(){} }
  };
  vm.createContext(sb);
  vm.runInContext(between(coreSource, "var MAX_MERGE_HOPS", "async function findExistingBuildingId"), sb);
  return sb;
}

/* ================= (a) the merge re-points everything ================= */

test("the merge re-points work orders and DPRs, not just history and reports", () => {
  assert.match(MERGE, /collection\("building_history_events"\)/);
  assert.match(MERGE, /collection\("reports"\)/);
  assert.match(MERGE, /collection\("workorders"\)\.where\("buildingId", "==", sourceBuildingId\)/,
    "workorders was the collection the original merge forgot -- this IS the bug");
  assert.match(MERGE, /collection\("daily_progress_reports"\)\.where\("buildingId", "==", sourceBuildingId\)/);
});

test("all four collections are actually written, not just queried", () => {
  /* Querying without writing would look right and fix nothing. */
  ["evtSnap", "repSnap", "woSnap", "dprSnap"].forEach(s => {
    assert.match(MERGE, new RegExp(s + "\\.forEach\\(d => writes\\.push"), s + " must be written");
  });
});

test("archived work orders are re-pointed too", () => {
  /* Mark: keep it all consistent. An archived WO still aimed at an emptied
     building is a landmine the day someone restores it. The query filters on
     buildingId ONLY -- no archived/status filter anywhere near it. */
  const woQuery = between(MERGE, 'collection("workorders")', ".get()");
  assert.doesNotMatch(woQuery, /archived/);
  assert.doesNotMatch(woQuery, /voided/);
  assert.doesNotMatch(woQuery, /status/);
});

test("the merge still chunks writes under the Firestore batch cap", () => {
  /* Adding two more collections makes overflow more likely, not less. */
  assert.match(MERGE, /i \+= 400/);
});

test("the audit log and response report what moved", () => {
  assert.match(MERGE, /movedWorkOrders: woSnap\.size/);
  assert.match(MERGE, /movedDprs: dprSnap\.size/);
});

/* ================= (b) the forward-follow ================= */

test("a record pointing at a merged-away building follows to the survivor", () => {
  /* The KOMU case, with no backfill script. */
  const sb = followSandbox({
    bld_loser: { archived: true, mergedIntoBuildingId: "bld_survivor" },
    bld_survivor: { name: "Orr Street Studios", roofs: [1,2,3,4,5] }
  });
  return sb.resolveMergedBuildingId("bld_loser")
    .then(id => assert.equal(id, "bld_survivor"));
});

test("a live building is returned untouched", () => {
  const sb = followSandbox({ bld_a: { name: "Fine" } });
  return sb.resolveMergedBuildingId("bld_a").then(id => assert.equal(id, "bld_a"));
});

test("an archived building that was NOT merged is not followed", () => {
  /* Archiving without merging is a deliberate filing act. Its records should
     keep pointing at it, not silently migrate somewhere else. */
  const sb = followSandbox({ bld_filed: { archived: true } });
  return sb.resolveMergedBuildingId("bld_filed").then(id => assert.equal(id, "bld_filed"));
});

test("a chain of merges resolves to the final survivor", () => {
  const sb = followSandbox({
    a: { archived: true, mergedIntoBuildingId: "b" },
    b: { archived: true, mergedIntoBuildingId: "c" },
    c: { name: "final" }
  });
  return sb.resolveMergedBuildingId("a").then(id => assert.equal(id, "c"));
});

test("a pointer CYCLE degrades to the original id instead of spinning", () => {
  /* Only reachable through a bug or a hand-edit -- but a resolver that hangs
     would take every read path down with it. */
  const sb = followSandbox({
    a: { archived: true, mergedIntoBuildingId: "b" },
    b: { archived: true, mergedIntoBuildingId: "a" }
  });
  return sb.resolveMergedBuildingId("a").then(id => assert.equal(id, "a"));
});

test("a missing building resolves to itself rather than throwing", () => {
  const sb = followSandbox({});
  return sb.resolveMergedBuildingId("bld_gone").then(id => assert.equal(id, "bld_gone"));
});

test("a Firestore failure returns the original id, never throws", () => {
  /* This runs inside every save and every history read. Throwing here would
     break far more than one stale pointer ever could. */
  const sb = { fdb: { collection(){ throw new Error("offline"); } }, console: { warn(){} } };
  vm.createContext(sb);
  vm.runInContext(between(coreSource, "var MAX_MERGE_HOPS", "async function findExistingBuildingId"), sb);
  return sb.resolveMergedBuildingId("bld_x").then(id => assert.equal(id, "bld_x"));
});

test("both the SAVE path and the READ path follow the pointer", () => {
  /* Save alone would leave an unsaved record still showing the empty husk;
     read alone would let the next save write the stale id straight back. */
  assert.match(coreSource, /resolvedStored = o\.buildingId \? await resolveMergedBuildingId\(o\.buildingId\)/);
  assert.match(photosSource, /bldId = await resolveMergedBuildingId\(bldId\)/);
});

/* ================= (c) the manual re-file ================= */

test("re-filing moves the work order AND its history and report together", () => {
  /* Updating only the work order would leave the timeline pointing at the old
     building -- the same split that caused this bug. */
  const block = from(ccSource, "async function relinkModalPick");
  assert.match(block, /collection\("workorders"\)/);
  /* Both follow-on collections are written through one loop, so assert the
     names and the loop rather than two literal collection() calls. */
  assert.match(block, /"building_history_events"/);
  assert.match(block, /"reports"/);
  assert.match(block, /fdb\.collection\(col\)\.doc\(evtId\)/);
});

test("re-filing targets the REAL history/report doc id, not the work order id", () => {
  /* Review finding, 2026-07-19: the first cut wrote to .doc(o.id). The history
     event and its report actually live at "evt_" + workOrderId
     (logReportAndHistoryEvent, js/history.js). Writing to o.id missed both real
     docs AND -- because set({merge:true}) creates -- conjured two malformed
     stubs that render in the timeline and cannot be deleted, since
     firestore.rules denies client deletes on both collections. */
  const block = from(ccSource, "async function relinkModalPick");
  assert.match(block, /var evtId = "evt_" \+ o\.id/);
  assert.doesNotMatch(block, /collection\("building_history_events"\)\.doc\(o\.id\)/);
  assert.doesNotMatch(block, /collection\("reports"\)\.doc\(o\.id\)/);
});

test("re-filing never CREATES a history entry a work order never had", () => {
  const block = from(ccSource, "async function relinkModalPick");
  assert.match(block, /snap\.exists/, "update in place only");
});

test("a failed follow-on write is reported, not papered over with a tick", () => {
  const block = from(ccSource, "async function relinkModalPick");
  assert.match(block, /followFailed/);
  assert.match(block, /could not be moved/);
});

test("re-filing touches ONE record, never a building or a roof", () => {
  const block = from(ccSource, "async function relinkModalPick");
  assert.doesNotMatch(block, /roofs/, "re-filing must not move roofs -- that is what merge is for");
  assert.doesNotMatch(block, /merge_buildings/);
  assert.match(block, /confirm\(/, "a cross-building move is confirmed, not one-tap");
});

test("candidates are ranked by the same identity ladder as dedup and merge", () => {
  const block = between(ccSource, "function relinkRankBuildings", "function relinkModalRender");
  assert.match(block, /companyCamProjectId/);
  assert.match(block, /foundationJobNo/);
  assert.match(block, /fdnAddressMatchKey/);
});

test("a merged-away husk is never offered as a destination", () => {
  /* Re-filing onto an emptied record would recreate the exact bug. */
  const block = between(ccSource, "async function openRelinkBuildingModal", "function relinkRankBuildings");
  assert.match(block, /if \(v\.archived\) return;/);
});

test("the current filing is named, and a merged-away one says so", () => {
  /* Naming the husk IS the diagnosis -- it tells the user the record will
     self-heal rather than needing a manual pick. */
  const block = between(ccSource, "async function openRelinkBuildingModal", "function relinkRankBuildings");
  assert.match(block, /merged away/);
});

test("the re-file entry point is admin-gated and on the history card", () => {
  const block = between(historySource, "function ensureInlineBuildingHistoryCard", "var ref = document.getElementById");
  assert.match(block, /isAdmin \?/);
  assert.match(block, /openRelinkBuildingModal\(\)/);
  assert.match(indexSource, /id="relink-bld-modal"/);
  assert.match(indexSource, /id="relink-bld-list"/);
});

/* ================= regressions found in review =================
   Every test below exists because a reviewer found the code wrong. The hop
   tests in particular would have caught an off-by-one that made a 3-deep merge
   chain resolve to an archived husk -- strictly worse than no guard at all. */

test("a 3-pointer chain resolves to the live survivor, not the husk", () => {
  /* THE off-by-one. The loop follows N pointers but must also LOOK AT the
     target of the last one. A 3-link chain is the normal shape of a dedup
     campaign (A->B, later B->C, later C->D). */
  const sb = followSandbox({
    a: { archived: true, mergedIntoBuildingId: "b" },
    b: { archived: true, mergedIntoBuildingId: "c" },
    c: { archived: true, mergedIntoBuildingId: "d" },
    d: { name: "live survivor" }
  });
  return sb.resolveMergedBuildingId("a").then(id => assert.equal(id, "d"));
});

test("a chain deeper than the budget gives up on the ORIGINAL id", () => {
  /* Visibly mis-linked is recoverable; silently writing into a dead building
     is not. */
  const sb = followSandbox({
    a: { archived: true, mergedIntoBuildingId: "b" },
    b: { archived: true, mergedIntoBuildingId: "c" },
    c: { archived: true, mergedIntoBuildingId: "d" },
    d: { archived: true, mergedIntoBuildingId: "e" },
    e: { name: "live" }
  });
  return sb.resolveMergedBuildingId("a").then(id => assert.equal(id, "a"));
});

test("a dangling merge pointer never creates a nameless ghost building", () => {
  /* resolveMergedBuildingId returns the missing target; without a guard the
     save path would set({merge:true}) it into existence with no name, no
     customer and no location, then file the work order under it. */
  assert.match(coreSource, /if \(redirectedByMerge && !snap\.exists\)/);
  assert.match(coreSource, /buildingId: o\.buildingId/);
});

test("the destructive source patch commits LAST", () => {
  /* Chunks are not atomic across boundaries. Source-first meant a mid-way
     failure left the building emptied and archived with records still pointing
     at it, and no audit entry. */
  const destIdx = MERGE.indexOf("doc(destBuildingId), data: destPatch");
  const srcIdx = MERGE.indexOf("doc(sourceBuildingId), data: sourcePatch");
  const woIdx = MERGE.indexOf("woSnap.forEach");
  assert.ok(destIdx !== -1 && srcIdx !== -1 && woIdx !== -1);
  assert.ok(srcIdx > woIdx, "sourcePatch must be pushed after the record re-points");
});

test("a merge retry does not duplicate roofs onto the survivor", () => {
  /* The flip side of retry-safety: the source keeps its roofs on failure, so a
     retry must not append them twice. The label auto-suffix would have hidden
     it by renaming the copies to "Roof 1 (2)". */
  assert.match(MERGE, /dstRoofIds/);
  assert.match(MERGE, /srcRoofs\.filter/);
});

test("the deduper is not blinded by orderBy the way the picker was", () => {
  /* findExistingBuildingId is the function whose whole job is preventing the
     duplicates this branch cleans up. Firestore excludes docs lacking the
     ordered field, so a legacy building was invisible to it. */
  const block = between(coreSource, "async function findExistingBuildingId", "async function ensureCustomerAndBuilding");
  assert.doesNotMatch(block, /\.orderBy\("updatedAt"/, "the call, not the comment explaining why it is gone");
  assert.match(block, /collection\("buildings"\)\.limit\(/);
});

test("re-filing syncs the form to the destination building", () => {
  /* Otherwise the next save writes the mis-filed order's jobName and location
     onto the destination -- the same data loss the merge-redirect guard stops,
     through a door that guard doesn't watch. */
  const block = from(ccSource, "async function relinkModalPick");
  assert.match(block, /setVal\("jobName", b\.name/);
  assert.match(block, /setVal\("location", b\.location/);
  assert.match(block, /setVal\("billTo", b\.customerName/);
});

test("an ordinary rename still renames its building in place", () => {
  /* Load-bearing (audit FIX 1). The ownsBuilding guard keys on REDIRECTION,
     not on whether the name still derives the id -- an earlier cut used the
     name and silently broke rename. */
  assert.match(coreSource, /var ownsBuilding = !redirectedByMerge;/);
  assert.doesNotMatch(coreSource, /ownsBuilding = .*buildingIdFor\(o\.billTo/);
});
