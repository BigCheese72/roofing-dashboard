"use strict";
/* Foundation -> work-order job linkage.
 *
 * WHY THIS FILE EXISTS — feedback report fb_ms7nxq1flqumf (2026-07-30):
 * a work order for 915 Richmond linked Foundation job #17211 when the ticket
 * was #17502.
 *
 * The fixtures below are NOT invented. They were read out of the live
 * Foundation database (dbo.jobs, read-only) on 2026-07-30 while diagnosing
 * that report, and they are what makes the bug reachable:
 *
 *   - job 17211 and job 17502 are BOTH active, BOTH named "915 Richmond Leak",
 *     both customer SOPHIAS, both PM MARK. A recurring leak site gets a brand
 *     new job number per callout, reusing the name verbatim.
 *   - NEITHER carries an address. 526 of 544 active jobs have address_1 NULL,
 *     so fdnAddressMatchKey() — "address is the strongest signal" — returns ""
 *     for ~97% of the data and every tie falls through to the NAME, which is
 *     exactly what is duplicated.
 *   - 12 duplicate-name groups cover 25 active jobs; 11 of the 12 are "… Leak".
 *     This is the normal shape of Watkins' service work, not an edge case.
 *   - job 16457 is the one active job whose `job_number` column is populated
 *     AND differs from `job_no` (16457 -> 25003). That is what made the WO
 *     form's `job_number || job_no` preference able to display a number the
 *     user never picked.
 *
 * If a future change reintroduces silent anchor inheritance, or re-prefers
 * job_number over job_no, these MUST fail.
 *
 * Run: npm test
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* js/foundation.js in a sandbox — the REAL helpers, no re-implementation.
   Strips the "use strict" directive so top-level declarations bind to the
   sandbox global (same approach as tests/serviceManager.test.js). */
function loadFdn() {
  const ctx = { console, document: { getElementById() { return null; } } };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");
  vm.runInContext(src.replace(/^\s*["']use strict["'];?\s*/, ""), ctx);
  return ctx;
}

// ---- live-shaped fixtures (foundationDb.mapJobForCache output shape) ----
const J = (job_no, name, extra) => Object.assign({
  job_no, job_number: "", name, status: "A",
  customer_no: "SOPHIAS", project_manager_no: "MARK",
  address: "", city: "", state: "", zip: "", job_location: "",
  job_start_date: null, completion_date: null
}, extra || {});

// The pair from the report. Same name, same customer, no address.
const JOB_17211 = J("17211", "915 Richmond Leak");
const JOB_17502 = J("17502", "915 Richmond Leak");
// A genuinely unambiguous job, for the control cases.
const JOB_17456 = J("17456", "Prairie Farms", {
  customer_no: "ACME", address: "1 Dairy Ln", city: "Columbia", state: "MO"
});
// The one live job where job_number is populated and DIFFERENT.
const JOB_16457 = J("16457", "Osage Co R-II Reno & Addition", {
  job_number: "25003", customer_no: "OSAGE", city: "Linn"
});

const CACHE = [JOB_17502, JOB_17211, JOB_17456, JOB_16457];

// =====================================================================
// THE BUG: a building's stale Foundation anchor must not auto-link.
// =====================================================================
/* The 915 Richmond building as it exists after the PREVIOUS callout was saved:
   ensureCustomerAndBuilding() (js/core.js) stamped it with that work order's
   job number. It is a record of last time, not a claim about this time. */
const BUILDING_915 = {
  id: "b_915richmond", name: "915 Richmond Leak", location: "",
  foundationJobNo: "17211", foundationJobName: "915 Richmond Leak",
  foundationCustomerNo: "SOPHIAS", foundationAddress: ""
};

test("915 Richmond: a building anchored to #17211 must NOT auto-link when #17502 is also active", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  const res = fdnResolveBuildingJobAnchor(BUILDING_915, CACHE);
  assert.strictEqual(res.status, "superseded",
    "THE REPORTED BUG: inheriting the building's last job number silently linked #17211 " +
    "to a work order that belonged to #17502");
  assert.deepStrictEqual(res.candidates.map(c => c.job_no), ["17502"],
    "the rival job must be surfaced so the tech is told WHICH numbers are in play");
});

test("a superseded anchor still reports the number it declined to use", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  const res = fdnResolveBuildingJobAnchor(BUILDING_915, CACHE);
  assert.strictEqual(res.jobNo, "17211");
  assert.strictEqual(res.name, "915 Richmond Leak");
});

test("the SAME building auto-links cleanly once the rival job is gone from the cache", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  // 17502 closed out and dropped from the active cache -> 17211 is unambiguous.
  const res = fdnResolveBuildingJobAnchor(BUILDING_915, [JOB_17211, JOB_17456]);
  assert.strictEqual(res.status, "ok", "no rival = the old inheritance behaviour is preserved");
  assert.strictEqual(res.jobNo, "17211");
});

test("an unambiguous building anchor still auto-links (no regression)", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  const res = fdnResolveBuildingJobAnchor(
    { id: "b_pf", name: "Prairie Farms", foundationJobNo: "17456" }, CACHE);
  assert.strictEqual(res.status, "ok");
  assert.strictEqual(res.jobNo, "17456");
  // length, not deepStrictEqual: the array is constructed inside the vm realm,
  // so its Array.prototype is not this realm's and deepStrictEqual rejects it.
  assert.strictEqual(res.candidates.length, 0);
});

test("an anchor pointing at a job no longer in the cache is stale, not inherited", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  const res = fdnResolveBuildingJobAnchor(
    { id: "b_old", name: "915 Richmond Ave", foundationJobNo: "15152" }, CACHE);
  assert.strictEqual(res.status, "stale",
    "a number we cannot vouch for must not be written onto a new work order");
  assert.strictEqual(res.jobNo, "15152");
});

test("a building with no Foundation anchor is a no-op", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  assert.strictEqual(fdnResolveBuildingJobAnchor({ id: "b_x", name: "X" }, CACHE).status, "none");
  assert.strictEqual(fdnResolveBuildingJobAnchor(null, CACHE).status, "none");
});

test("resolver survives an empty/absent jobs cache without inheriting", () => {
  const { fdnResolveBuildingJobAnchor } = loadFdn();
  // Cache not loaded yet: the anchor cannot be verified, so it is NOT trusted.
  assert.strictEqual(fdnResolveBuildingJobAnchor(BUILDING_915, []).status, "stale");
  assert.strictEqual(fdnResolveBuildingJobAnchor(BUILDING_915, null).status, "stale");
});

// =====================================================================
// Job identity: the form must show the number that was tapped.
// =====================================================================
test("fdnJobNo prefers job_no — the id the badge, link line, doc id and hours join all use", () => {
  const { fdnJobNo } = loadFdn();
  assert.strictEqual(fdnJobNo(JOB_16457), "16457",
    "job 16457 carries job_number 25003; the old `job_number || job_no` order put 25003 " +
    "into the WO's Job No. field while the row said #16457");
  assert.strictEqual(fdnJobNo(JOB_17502), "17502");
});

test("fdnJobNo falls back to job_number only when job_no is missing", () => {
  const { fdnJobNo } = loadFdn();
  assert.strictEqual(fdnJobNo({ job_no: "", job_number: "25003" }), "25003");
  assert.strictEqual(fdnJobNo({ job_no: null, job_number: null }), "");
  assert.strictEqual(fdnJobNo(null), "");
});

test("fdnJobNo trims the CHAR padding Foundation stores job_no with", () => {
  const { fdnJobNo } = loadFdn();
  assert.strictEqual(fdnJobNo({ job_no: "17502     " }), "17502");
});

// =====================================================================
// Picker disambiguation: identical rows are a mis-tap generator.
// =====================================================================
test("both 915 Richmond jobs are flagged as sharing a name", () => {
  const { fdnDuplicateNameJobNos } = loadFdn();
  const dupes = fdnDuplicateNameJobNos(CACHE);
  assert.ok(dupes["17211"], "#17211 must be marked ambiguous");
  assert.ok(dupes["17502"], "#17502 must be marked ambiguous");
});

test("unique-name jobs are NOT flagged", () => {
  const { fdnDuplicateNameJobNos } = loadFdn();
  const dupes = fdnDuplicateNameJobNos(CACHE);
  assert.ok(!dupes["17456"]);
  assert.ok(!dupes["16457"]);
});

test("duplicate detection normalizes case/punctuation the way the matcher does", () => {
  const { fdnDuplicateNameJobNos } = loadFdn();
  // Real shape: "Madison Schools - Leak" vs "Madison Schools Leak".
  const dupes = fdnDuplicateNameJobNos([
    J("17220", "Madison Schools - Leak"),
    J("17333", "MADISON SCHOOLS  LEAK")
  ]);
  assert.ok(dupes["17220"] && dupes["17333"],
    "a hyphen or a capital must not hide a duplicate from the warning");
});

test("unnamed jobs never collide with each other", () => {
  const { fdnDuplicateNameJobNos } = loadFdn();
  const dupes = fdnDuplicateNameJobNos([J("1", ""), J("2", null)]);
  assert.deepStrictEqual(Object.keys(dupes), [],
    "two blank names are not evidence of the same site");
});

// =====================================================================
// The picker's own lookup must find the job by the number on the row.
// =====================================================================
test("selecting #17502 resolves job 17502, not its same-named sibling", () => {
  const ctx = loadFdn();
  const filled = {};
  ctx.fdnCache = CACHE;
  ctx.setVal = (id, v) => { filled[id] = v; };
  ctx.toast = () => {};
  ctx.fdnSelectJob("17502");
  assert.strictEqual(filled.jobNo, "17502",
    "THE REPORTED BUG, from the other direction: the Job No. field must carry the " +
    "number that was tapped");
  assert.strictEqual(filled.jobName, "915 Richmond Leak");
  assert.strictEqual(ctx.fdnLinkedJobNo, "17502",
    "the saved linkage (collect() reads this) must agree with the field");
});

test("selecting the job whose job_number differs fills job_no, not job_number", () => {
  const ctx = loadFdn();
  const filled = {};
  ctx.fdnCache = CACHE;
  ctx.setVal = (id, v) => { filled[id] = v; };
  ctx.toast = () => {};
  ctx.fdnSelectJob("16457");
  assert.strictEqual(filled.jobNo, "16457",
    "16457 is what the picker row showed and what his_timecard joins on; 25003 is not");
  assert.strictEqual(ctx.fdnLinkedJobNo, "16457");
});

// =====================================================================
// WIRED PATH: bpSelectBuilding + js/foundation.js together.
//
// tests/workordersRoofLabels.test.js loads js/workorders.js ALONE, so
// fdnResolveBuildingJobAnchor is undefined there and its typeof-guarded
// fallback keeps the old inherit-always behaviour. That is deliberate (this
// file must not hard-depend on js/foundation.js) but it means those tests say
// nothing about the fix. index.html loads BOTH; so does this sandbox.
// =====================================================================
function loadWoWithFdn(building, jobsCache) {
  const woSrc = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
  const slice = (start, end) => {
    const a = woSrc.indexOf(start), b = woSrc.indexOf(end, a);
    assert.notStrictEqual(a, -1, "missing start marker: " + start);
    assert.notStrictEqual(b, -1, "missing end marker: " + end);
    return woSrc.slice(a, b);
  };
  const sandbox = {
    console,
    document: { getElementById() { return null; } },
    ccLinkedProjectId: null, ccLinkedProjectName: "",
    currentBuildingId: null, currentCustomerId: null,
    currentRoofId: null, currentRoofIds: null,
    __fields: {}, __toasts: [], __fdnLinks: [],
    val(id) { return sandbox.__fields[id] || ""; },
    setVal(id, v) { sandbox.__fields[id] = v || ""; },
    toast(m) { sandbox.__toasts.push(m); },
    renderCCLinkInfo() {}, renderLocationDirectionsLink() {},
    refreshInspectionRoofPickerIfNeeded() {},
    closeBuildingPicker() {},
    scheduleInlineBuildingHistoryRefresh() {}, scheduleChangeOrderAutofill() {}
  };
  vm.createContext(sandbox);
  // The REAL fdn* helpers, then the real bpSelectBuilding.
  const fdnSrc = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");
  vm.runInContext(fdnSrc.replace(/^\s*["']use strict["'];?\s*/, ""), sandbox);
  // fdnSetLinkedJob is the real one from foundation.js; wrap it to record calls.
  const realSet = sandbox.fdnSetLinkedJob;
  sandbox.fdnSetLinkedJob = function (jobNo, jobName, customerNo, address) {
    sandbox.__fdnLinks.push({ jobNo, jobName, customerNo, address });
    return realSet(jobNo, jobName, customerNo, address);
  };
  vm.runInContext(slice("function bpFoundationJobNameForBuilding", "/* ---- Move/reassign"), sandbox);
  /* Seed the caches AFTER both sources run: js/foundation.js's top-level
     `var fdnCache = null;` executes as global code in this sandbox and would
     overwrite anything pre-set on the context object. */
  sandbox.fdnCache = jobsCache;
  sandbox.bpCache = [building];
  return sandbox;
}

test("WIRED: picking the 915 Richmond building does NOT silently link stale #17211", () => {
  const sb = loadWoWithFdn(BUILDING_915, CACHE);
  sb.bpSelectBuilding("b_915richmond");
  assert.strictEqual(sb.__fdnLinks.length, 0,
    "THE REPORTED BUG: bpSelectBuilding inherited the building's last-saved job number " +
    "(#17211) even though #17502 was also active for the same site");
  assert.strictEqual(sb.fdnLinkedJobNo, null, "the order must be left UNLINKED, not mis-linked");
});

test("WIRED: the refusal is visible — the toast names both job numbers", () => {
  const sb = loadWoWithFdn(BUILDING_915, CACHE);
  sb.bpSelectBuilding("b_915richmond");
  const said = sb.__toasts.join(" ");
  assert.ok(said.indexOf("17211") !== -1 && said.indexOf("17502") !== -1,
    "a silent refusal is its own bug — the tech must be told which numbers are in play, got: " + said);
  assert.ok(said.indexOf("Select Job") !== -1, "and told what to do about it");
});

test("WIRED: an unambiguous building still auto-links (no regression)", () => {
  const b = {
    id: "b_pf", name: "Prairie Farms", location: "1 Dairy Ln",
    foundationJobNo: "17456", foundationCustomerNo: "ACME",
    foundationAddress: "1 Dairy Ln, Columbia, MO"
  };
  const sb = loadWoWithFdn(b, CACHE);
  sb.bpSelectBuilding("b_pf");
  assert.strictEqual(sb.__fdnLinks.length, 1);
  assert.strictEqual(sb.__fdnLinks[0].jobNo, "17456");
  assert.strictEqual(sb.__fdnLinks[0].jobName, "Prairie Farms",
    "the name is resolved from the live cache, not the building's stale copy");
});

test("WIRED: a job already picked this session is never overwritten by the building", () => {
  const sb = loadWoWithFdn(BUILDING_915, CACHE);
  sb.fdnSelectJob("17502");            // tech explicitly picks the right job first
  sb.__fdnLinks.length = 0;
  sb.bpSelectBuilding("b_915richmond"); // then picks the building
  assert.strictEqual(sb.fdnLinkedJobNo, "17502",
    "an explicit choice outranks a building's stored anchor");
  assert.strictEqual(sb.__fdnLinks.length, 0);
});

test("the select toast names the job NUMBER, not just the ambiguous name", () => {
  const ctx = loadFdn();
  let said = "";
  ctx.fdnCache = CACHE;
  ctx.setVal = () => {};
  ctx.toast = (m) => { said = m; };
  ctx.fdnSelectJob("17502");
  assert.ok(said.indexOf("17502") !== -1,
    "'Loaded job 915 Richmond Leak' cannot tell the tech which of two jobs he got");
});
