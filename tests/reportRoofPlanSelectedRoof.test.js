const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* FEEDBACK fb_ms9ifxihyy1rc (prod, 2026-07-31, WO "915 Richmond Leak"):
   "this map is attached but the isn't what I see in building history or when I
   edit the pdf — I see the correct base map."

   The report's Roof Plan used to derive its roof set ONLY from the findings'
   own roofIds (reportDistinctRoofIds). The edit view's Building History card
   derives its base map from the SELECTED roof (inlineSelectedRoofId,
   js/buildinghistory.js). Nothing reconciled the two, so a finding roofId that
   wasn't the selected roof — GPS auto-assign (rmMaybeAutoAssignRoofForPin),
   an unconfirmed ambiguous guess, or an id left stale by a roof move / a
   reid_building_roof that deliberately does not re-point records — silently
   pointed the customer-facing drawing at a DIFFERENT roof than every in-app
   view was showing.

   These tests pin the two halves of the fix:
     1. the report anchors on the SAME roof Building History does, first;
     2. when the drawing still isn't that roof (its outline can't be drawn to
        scale), the report SAYS SO instead of substituting in silence. */

const exportSrc = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const historySrc = fs.readFileSync(path.join(__dirname, "..", "js", "buildinghistory.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  assert.notEqual(a, -1, "missing start marker: " + start);
  const b = source.indexOf(end, a);
  assert.notEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* ---- the real report roof-plan resolution, with Firestore stubbed ---- */
function reportSandbox({ roofs = [], findings = [], exists = true, throws = null } = {}){
  const reads = [];
  const sandbox = {
    console,
    filledFindings(){ return findings; },
    buildingIdFor(billTo, jobName){ return "bld_" + billTo + "-" + jobName; },
    getBuildingRoofs(){ return roofs; },
    fdb: {
      collection(name){
        return { doc(id){
          reads.push(name + "/" + id);
          return { get(){
            if (throws) return Promise.reject(new Error(throws));
            return Promise.resolve({ exists, data(){ return { roofs }; } });
          } };
        } };
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(exportSrc, "function reportDistinctRoofIds", "function rmReportMethodSentences"),
    sandbox
  );
  sandbox.__reads = reads;
  return sandbox;
}

/* ---- the real Building History selection, so parity is proven not assumed ---- */
function historySelectedRoofId(roofs, currentRoofId, currentRoofIds){
  const sandbox = { currentRoofId: currentRoofId || null, currentRoofIds: currentRoofIds || null };
  vm.createContext(sandbox);
  vm.runInContext(between(historySrc, "function inlineSelectedRoofId", "function inlineRoofById"), sandbox);
  return sandbox.inlineSelectedRoofId(roofs);
}

const worldRing = [{ lat: 38.95, lng: -92.33 }, { lat: 38.95, lng: -92.32 },
                   { lat: 38.96, lng: -92.32 }, { lat: 38.95, lng: -92.33 }];
/* A roof traced ON its base map: image-frame geometry, no world ring. Building
   History draws it over the base-map image; the report can't draw it to scale. */
const imageFrameOutline = { ring: [], imageRing: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
                            imageFrame: "roof_base_map" };

function roof(id, label, outline){
  return { id, label, roof_outlines: outline ? [outline] : [], roof_assets: [] };
}
/* Results come out of the vm realm, so rebuild the arrays in THIS realm before
   comparing — deepStrictEqual otherwise fails on the Array.prototype mismatch
   alone (same reason tests/reportRoofPlanImageFrame.test.js compares fields). */
function ids(result){
  return Array.from(result.roofEntries, (r) => r.roofId);
}

/* ================= 1. the report follows the selected roof ================= */

test("the selected roof leads the plan even when a finding was GPS-assigned elsewhere", async () => {
  /* Mark's shape: the tech is on Roof 1 (that's the base map he sees), but a
     photo's GPS auto-assigned the finding to Roof 2. */
  const roofs = [roof("roof_1", "Roof 1", { ring: worldRing }), roof("roof_2", "Roof 2", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [{ roofId: "roof_2", roofIdAmbiguous: true }] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });

  assert.equal(res.selectedRoofId, "roof_1");
  assert.deepEqual(ids(res), ["roof_1", "roof_2"],
    "selected roof first, then the roofs the findings actually cover");
  assert.equal(res.roofEntries[0].isSelectedRoof, true);
  assert.equal(res.roofEntries[1].isSelectedRoof, false);
});

test("BEFORE THE FIX this drew Roof 2 alone — the selected roof is never absent now", async () => {
  const roofs = [roof("roof_1", "Roof 1", { ring: worldRing }), roof("roof_2", "Roof 2", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [{ roofId: "roof_2" }, { roofId: "roof_2" }] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });
  assert.ok(res.roofEntries.some((r) => r.roofId === "roof_1"),
    "the roof the editor and Building History are showing must be in the report");
});

test("no duplicate entry when the findings already name the selected roof", async () => {
  const roofs = [roof("roof_1", "Roof 1", { ring: worldRing }), roof("roof_2", "Roof 2", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [{ roofId: "roof_1" }, { roofId: "roof_2" }] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });
  assert.deepEqual(ids(res), ["roof_1", "roof_2"]);
});

test("an order with no filled findings still shows the same roof the edit view does", async () => {
  /* The old code only fell back to roofs[0] on a SINGLE-roof building, so a
     multi-roof building with nothing filled in showed a plan in the edit view
     and no plan at all in the report. */
  const roofs = [roof("roof_1", "Roof 1", { ring: worldRing }), roof("roof_2", "Roof 2", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x" });
  assert.deepEqual(ids(res), ["roof_1"]);
});

test("a multi-roof Inspection anchors on ROOFS order, exactly like Building History", async () => {
  /* Selection order is roof_b then roof_a; Building History anchors on roof_a
     because it scans the building's roofs. The report must agree — anchoring
     on selection order instead would reintroduce the same mismatch. The
     "Roof(s) Covered" list keeps selection order; that is a different question
     and reportDistinctRoofIds() still answers it. */
  const roofs = [roof("roof_a", "Roof A", { ring: worldRing }), roof("roof_b", "Roof B", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [] });
  const res = await sb.rmFetchReportRoofOutlines(
    { buildingId: "bld_x", roofId: null, roofIds: ["roof_b", "roof_a"] });
  assert.equal(res.selectedRoofId, historySelectedRoofId(roofs, null, ["roof_b", "roof_a"]));
  assert.equal(res.selectedRoofId, "roof_a");
  assert.deepEqual(ids(res), ["roof_a", "roof_b"]);
});

/* ================= 2. parity with Building History ================= */

test("rmReportSelectedRoofId agrees with inlineSelectedRoofId on every shape", () => {
  const roofs = [roof("roof_1", "Roof 1"), roof("roof_2", "Roof 2"), roof("roof_3", "Roof 3")];
  const sb = reportSandbox({ roofs });
  const cases = [
    { roofId: "roof_2", roofIds: null },
    { roofId: null, roofIds: ["roof_3", "roof_1"] },
    { roofId: "gone", roofIds: null },                    /* stale selection */
    { roofId: "gone", roofIds: ["also_gone", "roof_3"] },  /* stale + a live one */
    { roofId: null, roofIds: null },
    { roofId: null, roofIds: ["nope"] }
  ];
  for (const c of cases){
    assert.equal(
      sb.rmReportSelectedRoofId({ roofId: c.roofId, roofIds: c.roofIds }, roofs),
      historySelectedRoofId(roofs, c.roofId, c.roofIds),
      "divergence for " + JSON.stringify(c)
    );
  }
});

/* ================= 3. a roofId this building no longer has ================= */

test("an unresolvable roofId is REPORTED, not silently dropped", async () => {
  /* reid_building_roof re-keys a roof and explicitly does not re-point the
     records referencing it (tests/roofIdCollision.test.js). */
  const roofs = [roof("roof_1", "Roof 1", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [{ roofId: "roof_default" }] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });
  assert.deepEqual(Array.from(res.unresolvedRoofIds), ["roof_default"]);
  assert.deepEqual(ids(res), ["roof_1"],
    "the selected roof still draws — the stale id doesn't take the plan with it");
});

test("every early return carries the same result shape", async () => {
  const shape = (r) => Object.keys(r).sort();
  const full = shape(await reportSandbox({ roofs: [roof("roof_1", "Roof 1", { ring: worldRing })] })
    .rmFetchReportRoofOutlines({ buildingId: "b" }));
  assert.deepEqual(shape(await reportSandbox({ roofs: [], exists: false })
    .rmFetchReportRoofOutlines({ buildingId: "b" })), full, "building missing");
  assert.deepEqual(shape(await reportSandbox({ roofs: [] })
    .rmFetchReportRoofOutlines({ buildingId: "b" })), full, "no roofs");
  assert.deepEqual(shape(await reportSandbox({ roofs: [], throws: "boom" })
    .rmFetchReportRoofOutlines({ buildingId: "b" })), full, "read failed");
});

test("the fetch is still strictly one read-only building get", async () => {
  const sb = reportSandbox({ roofs: [roof("roof_1", "Roof 1", { ring: worldRing })] });
  await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });
  assert.deepEqual(sb.__reads, ["buildings/bld_x"]);
});

/* ================= 4. never substitute a roof in silence ================= */

test("the report says so when the drawing is a different roof than the order's", async () => {
  /* Roof 1 (selected, the one whose base map Mark sees) was traced on its base
     map, so it can't be drawn to scale. Roof 2 can. Without the notice the
     page shows Roof 2's outline under a "Roof Plan" heading with nothing
     saying it isn't Roof 1. */
  const roofs = [roof("roof_1", "Roof 1", imageFrameOutline), roof("roof_2", "Roof 2", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [{ roofId: "roof_2" }] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });

  const notice = sb.rmReportPlanRoofSubstitutionNotice(res.roofEntries);
  assert.match(notice, /drawing above is Roof 2/);
  assert.match(notice, /not Roof 1/);
  assert.match(notice, /this work order is filed against/);
});

test("no notice when the selected roof IS the drawing", async () => {
  const roofs = [roof("roof_1", "Roof 1", { ring: worldRing }), roof("roof_2", "Roof 2", { ring: worldRing })];
  const sb = reportSandbox({ roofs, findings: [{ roofId: "roof_2" }] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });
  assert.equal(sb.rmReportPlanRoofSubstitutionNotice(res.roofEntries), "");
});

test("no notice when nothing is drawable at all — the per-roof notices carry it", async () => {
  const roofs = [roof("roof_1", "Roof 1", imageFrameOutline)];
  const sb = reportSandbox({ roofs, findings: [] });
  const res = await sb.rmFetchReportRoofOutlines({ buildingId: "bld_x", roofId: "roof_1" });
  assert.equal(res.roofEntries[0].planUnavailable, true);
  assert.equal(sb.rmReportPlanRoofSubstitutionNotice(res.roofEntries), "");
});

test("the notice tolerates entries with no selected-roof marking", () => {
  const sb = reportSandbox({});
  assert.equal(sb.rmReportPlanRoofSubstitutionNotice([]), "");
  assert.equal(sb.rmReportPlanRoofSubstitutionNotice(null), "");
  assert.equal(sb.rmReportPlanRoofSubstitutionNotice(
    [{ roofLabel: "Roof 1", outline: { ring: worldRing } }]), "",
    "legacy entries with no isSelectedRoof flag must not invent a substitution");
});

/* ================= 5. both renderers disclose it ================= */

test("the HTML report and the PDF both emit the substitution notice", () => {
  const html = between(exportSrc, "h += \"<h3 class='cond'>Roof Plan</h3>\"", "if (isRepair)");
  assert.match(html, /rmReportPlanRoofSubstitutionNotice\(roofPlanEntries\)/);
  const pdf = between(exportSrc, 'heading("Roof Plan")', "var historyRows = []");
  assert.match(pdf, /rmReportPlanRoofSubstitutionNotice\(roofPlanData\)/,
    "the PDF is the copy that leaves the building — it must not be the quieter one");
});

test("both report entry points warn about unresolvable roofIds", () => {
  const preview = between(exportSrc, "async function goToPreview", "function renderDoc");
  assert.match(preview, /rmWarnUnresolvedReportRoofIds\(roofPlanResult\)/);
  const pdf = between(exportSrc, "var roofPlanResult = await rmFetchReportRoofOutlines(o);",
    "async function generateLeakReportPdf");
  assert.match(pdf, /rmWarnUnresolvedReportRoofIds\(roofPlanResult\)/);
});
