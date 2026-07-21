const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/* "These look like the same building — merge?" (Mark, 2026-07-20).

   Mark: "I gotta check it open... clumsy way to merge." Finding a duplicate
   meant SUSPECTING one, opening the record, and hunting for the merge button.

   The insight this is built on: findExistingBuildingId() in js/core.js already
   detects the condition. When two buildings share an address it correctly
   refuses to guess and returns null -- and that finding is thrown away. The
   banner surfaces the signal that was already being computed.

   What these tests defend:
     * detection stays READ-ONLY and separate from the save path's matcher
     * the banner never blocks or breaks the page it sits on
     * nothing auto-merges
     * the picker can actually SHOW the duplicate (the orderBy trap) */

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const ccSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");

/* Strip BOTH comment styles before asserting a token is absent. These files
   explain at length why they do NOT use orderBy("updatedAt"), so an assertion
   run against the prose fires on the explanation rather than the code.
   CRLF note: `.` does not match \r, hence [^\n]* for line comments. */
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

/* ================= detection ================= */

test("detection is a SEPARATE function from the save path's matcher", () => {
  /* findExistingBuildingId() runs inside ensureCustomerAndBuilding() and its
     "never guess" contract decides what a save writes. Detection is read-only
     and must not be able to change that. */
  assert.match(coreSource, /async function findDuplicateBuildingCandidates\(/);
  /* End at the detector's own comment: the detector was inserted BETWEEN the
     matcher and ensureCustomerAndBuilding, so the old end-marker would slice
     it into the "matcher" block and the assertion would test nothing. */
  const matcher = between(coreSource, "async function findExistingBuildingId", "Surfaces the duplicate signal");
  assert.doesNotMatch(codeOnly(matcher), /findDuplicateBuildingCandidates/,
    "the save-path matcher must not depend on the detector");
});

test("the detector never returns the building itself", () => {
  const fn = between(coreSource, "async function findDuplicateBuildingCandidates", "async function ensureCustomerAndBuilding");
  assert.match(fn, /if \(id === buildingId \|\| found\[id\]\) return/);
});

test("archived buildings are never suggested as duplicates", () => {
  const fn = between(coreSource, "async function findDuplicateBuildingCandidates", "async function ensureCustomerAndBuilding");
  const archivedGuards = (fn.match(/archived/g) || []).length;
  assert.ok(archivedGuards >= 2, "both the indexed and address paths must skip archived, saw " + archivedGuards);
});

test("the address scan does NOT orderBy updatedAt", () => {
  /* Firestore excludes documents lacking the ordered field, so a legacy
     building -- exactly the kind most likely to BE the duplicate -- would be
     invisible to the thing looking for duplicates. Same trap already fixed in
     findExistingBuildingId(). */
  const fn = between(coreSource, "async function findDuplicateBuildingCandidates", "async function ensureCustomerAndBuilding");
  assert.doesNotMatch(codeOnly(fn), /orderBy\(/);
});

test("a lookup failure yields no banner, never an error", () => {
  const fn = between(coreSource, "async function findDuplicateBuildingCandidates", "async function ensureCustomerAndBuilding");
  const catches = (fn.match(/catch\s*\(/g) || []).length;
  assert.ok(catches >= 2, "both query paths swallow failures, saw " + catches);
  assert.match(fn, /if \(!fdb \|\| !buildingId \|\| !bld\) return \[\]/);
});

test("results are cached per building so re-opening is free", () => {
  /* The address path scans up to 1000 docs; Building History is re-rendered on
     every roof switch. */
  const fn = between(coreSource, "async function findDuplicateBuildingCandidates", "async function ensureCustomerAndBuilding");
  assert.match(fn, /__dupBuildingCache\[buildingId\]/);
  assert.match(coreSource, /function clearDuplicateBuildingCache/);
});

/* ================= the banner ================= */

test("the banner is filled AFTER render and never blocks the page", () => {
  assert.match(historySource, /var dupBuildingBannerHtml = isAdmin \? '<div id="dup-building-banner"><\/div>' : ''/);
  const fill = between(historySource, "async function fillDuplicateBuildingBanner", "function historySelectRoof");
  assert.match(fill, /catch\(e\)\{ return; \}/, "a failed lookup costs the banner, not the page");
  assert.match(fill, /if \(!dups\.length/, "no twin: render nothing at all");
});

test("the banner re-checks its host survived the await", () => {
  /* Building History re-renders on roof switch; the node this was going to
     fill may be gone by the time the scan returns. */
  const fill = between(historySource, "async function fillDuplicateBuildingBanner", "function historySelectRoof");
  assert.match(fill, /document\.getElementById\("dup-building-banner"\)[\s\S]*document\.getElementById\("dup-building-banner"\)/,
    "host is looked up before AND after the await");
});

test("the banner is admin-gated, like every other merge control", () => {
  assert.match(historySource, /if \(isAdmin\) fillDuplicateBuildingBanner\(/);
});

test("nothing auto-merges — the banner only opens the confirm flow", () => {
  /* A merge re-points four collections and empties the loser; the KOMU orphan
     bug came from exactly that going partly wrong. Remove the HUNT, keep the
     confirmation. */
  const fill = between(historySource, "async function fillDuplicateBuildingBanner", "function historySelectRoof");
  assert.match(fill, /openMergeBuildingModal\(/);
  assert.doesNotMatch(codeOnly(fill), /admin.*merge_buildings|action:\s*"merge_buildings"/);
});

/* ================= the picker ================= */

test("the merge picker can actually show a legacy duplicate", () => {
  /* THE bug this batch found: the picker still ordered by updatedAt, so the
     duplicate could be undisplayable in the very dialog for merging it. */
  const open = between(ccSource, "async function openMergeBuildingModal", "function mergeRankDuplicateBuildings");
  assert.doesNotMatch(codeOnly(open), /orderBy\("updatedAt"/);
  assert.match(open, /collection\("buildings"\)\.limit\(/);
});

test("the flagged duplicate is preselected, not left to be hunted again", () => {
  const open = between(ccSource, "async function openMergeBuildingModal", "function mergeRankDuplicateBuildings");
  assert.match(open, /async function openMergeBuildingModal\(survivorId, preselectId\)/);
  assert.match(open, /mergeModalPreselectId = preselectId \|\| null/);
  const fill = between(historySource, "async function fillDuplicateBuildingBanner", "function historySelectRoof");
  assert.match(fill, /openMergeBuildingModal\(\\?'[^']*\\?' \+ esc\(buildingId\)|openMergeBuildingModal\('/,
    "the banner passes the twin it found");
  assert.match(fill, /esc\(d\.id\)/, "…as the preselect argument");
});

test("hoisting the preselected twin reorders the ARRAY, not just the markup", () => {
  /* mergeModalPick() indexes into mergeModalCandidates. Sorting only the HTML
     would wire every button to the wrong building -- a merge into the wrong
     record, which is unrecoverable-ish. */
  const render = between(ccSource, "function mergeModalRender", "function closeMergeBuildingModal");
  assert.match(render, /mergeModalCandidates\.unshift\(mergeModalCandidates\.splice\(pi, 1\)\[0\]\)/);
  assert.match(render, /mergeModalPick\(' \+ i \+ '\)/, "the button index still follows the array");
});

test("the preselect is cleared when the modal closes", () => {
  const close = between(ccSource, "function closeMergeBuildingModal", "function mergeModalPick");
  assert.match(close, /mergeModalPreselectId = null/);
});

test("callers that pass no preselect behave exactly as before", () => {
  /* Every pre-banner call site passes one argument. */
  const open = between(ccSource, "async function openMergeBuildingModal", "function mergeRankDuplicateBuildings");
  assert.match(open, /preselectId \|\| null/, "absent preselect must be null, not undefined");
  const render = between(ccSource, "function mergeModalRender", "function closeMergeBuildingModal");
  assert.match(render, /if \(mergeModalPreselectId\)\{/, "no preselect: no reordering at all");
});
