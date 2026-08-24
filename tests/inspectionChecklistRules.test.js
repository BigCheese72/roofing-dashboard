const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* CHARACTERIZATION tests for the three functions carrying the Inspection
   checklist's actual business rules. They had no direct coverage before this
   file -- every existing test that mentions them stubs them out as a no-op
   (`ensureInspectionChecklist(){}`), which asserts nothing about behaviour.

   These pin CURRENT behaviour deliberately, including the rough edges called
   out in comments below. If a change here goes red, that is the point: decide
   whether the change was intended, don't reflexively update the assertion.

   Written ahead of the H-2 extraction of the checklist engine out of
   js/photos.js and into js/inspections.js. That move is a pure relocation with
   no behaviour change, so this suite is its safety net: it should stay green
   across the move -- and it did.

   The extraction landed 2026-07-18 and split this suite's sources in two,
   slightly differently than the note above predicted:
     * The checklist engine moved to js/inspections.js.
     * findingById() did NOT -- it sits above the checklist block and is used
       all over js/photos.js, so it stayed. syncInspectionFinding() still
       depends on it, hence ENGINE_BLOCK is stitched from both files.
     * maybeAutoPinInspectionItem() did NOT -- it is a photo-pipeline function
       sharing GPS/roof helpers with maybeAutoPinFinding(), so moving it would
       have cut that pipeline in half. AUTOPIN_BLOCK still reads js/photos.js.
   The slice markers were string-based and travelled with the code exactly as
   intended; only the file each one is read from changed. */
const ENGINE_SRC = path.join(__dirname, "..", "js", "inspections.js");
const PHOTOS_SRC = path.join(__dirname, "..", "js", "photos.js");

const engineSource = fs.readFileSync(ENGINE_SRC, "utf8");
const photosSource = fs.readFileSync(PHOTOS_SRC, "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* The 8 fixed components + ratings come from js/workorders.js rather than
   being restated here, so this suite tracks the real vocabulary. If someone
   adds a 9th component the count assertions below move with it. */
const COMPONENTS_SRC = between(workordersSource,
  "var INSPECTION_CHECKLIST_COMPONENTS", "var inspectionChecklist");
/* findingById() sits immediately above the checklist block and syncInspectionFinding
   depends on it, so the slice starts there. */
const ENGINE_BLOCK =
  between(photosSource, "function findingById", "/* Read-only lookup of the prospective building") +
  between(engineSource, "function inspectionChecklistItemById", "function renderInspectionChecklist");
const AUTOPIN_BLOCK = between(photosSource,
  "async function maybeAutoPinInspectionItem", "/* Change Order equivalent");

function makeSandbox(opts){
  opts = opts || {};
  let seq = 0;
  const sandbox = {
    findings: opts.findings ? opts.findings.slice() : [],
    photos: opts.photos ? opts.photos.slice() : [],
    inspectionChecklist: opts.inspectionChecklist ? opts.inspectionChecklist.slice() : [],
    /* Deterministic ids so assertions can name them. */
    genId(prefix){ seq += 1; return prefix + "_" + seq; },
    renderFindingsCalls: 0,
    renderChecklistCalls: 0,
    toasts: [],
    toast(m){ sandbox.toasts.push(m); },
    /* Multi-roof (2026-07-19): the checklist is now keyed by (roofId, key), so
       the engine reads the inspector's roof selection. Default here is the
       single-roof case -- no selection at all -- which must keep behaving
       exactly as it did before multi-roof existed. Tests that care pass
       opts.roofIds. */
    currentRoofIds: opts.roofIds || null,
    currentRoofId: opts.roofId || null,
    inspectionRoofLabelCache: opts.roofLabels || {},
    inspectionRoofSystemCache: {},
    /* Overridden per-test for the auto-pin cases. */
    async rmMaybeAutoAssignRoofForPin(){ return null; }
  };
  sandbox.renderFindings = function(){ sandbox.renderFindingsCalls += 1; };
  sandbox.renderInspectionChecklist = function(){ sandbox.renderChecklistCalls += 1; };
  vm.createContext(sandbox);
  vm.runInContext(COMPONENTS_SRC, sandbox);
  vm.runInContext(ENGINE_BLOCK, sandbox);
  vm.runInContext(AUTOPIN_BLOCK, sandbox);
  return sandbox;
}

const ALL_KEYS = ["membrane","flashings","penetrations","drainage","equipment","perimeter","interior","safety"];

/* ================= ensureInspectionChecklist ================= */

test("ensure: a brand-new Inspection gets all 8 components, N/A, in canonical order", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  assert.deepStrictEqual(sb.inspectionChecklist.map(i => i.key), ALL_KEYS);
  assert.ok(sb.inspectionChecklist.every(i => i.rating === "N/A"),
    "nothing is rated until the tech rates it -- N/A must not imply a finding");
  assert.ok(sb.inspectionChecklist.every(i => i.pin === null && i.linkedFindingId === null));
  assert.ok(sb.inspectionChecklist.every(i => typeof i.id === "string" && i.id.startsWith("chk_")));
});

test("ensure: is idempotent -- second call adds nothing and reuses the same ids", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const idsAfterFirst = sb.inspectionChecklist.map(i => i.id);
  sb.ensureInspectionChecklist();
  assert.strictEqual(sb.inspectionChecklist.length, 8);
  assert.deepStrictEqual(sb.inspectionChecklist.map(i => i.id), idsAfterFirst,
    "regenerating ids would orphan every photo pointing at the old ones");
});

test("ensure: backfills a partial legacy order WITHOUT disturbing the rows already there", () => {
  const sb = makeSandbox({ inspectionChecklist: [
    { id: "chk_old", key: "drainage", rating: "Poor", notes: "ponding at NW drain",
      linkedFindingId: "fnd_old", pin: { lat: 41.2, lng: -95.9 } }
  ]});
  sb.ensureInspectionChecklist();
  assert.strictEqual(sb.inspectionChecklist.length, 8);
  const drainage = sb.inspectionChecklist.find(i => i.key === "drainage");
  assert.strictEqual(drainage.id, "chk_old", "existing row is preserved, not replaced");
  assert.strictEqual(drainage.rating, "Poor");
  assert.strictEqual(drainage.notes, "ponding at NW drain");
  assert.strictEqual(drainage.linkedFindingId, "fnd_old");
  assert.strictEqual(drainage.pin.lat, 41.2);
});

test("ensure: re-sorts storage order into canonical order", () => {
  const sb = makeSandbox({ inspectionChecklist: [
    { id: "c1", key: "safety",   rating: "Good", notes: "", linkedFindingId: null, pin: null },
    { id: "c2", key: "membrane", rating: "Good", notes: "", linkedFindingId: null, pin: null }
  ]});
  sb.ensureInspectionChecklist();
  assert.deepStrictEqual(sb.inspectionChecklist.map(i => i.key), ALL_KEYS,
    "display order must not depend on the order Firestore happened to return");
});

test("ensure: self-heals a missing `pin` field on rows saved before pins existed", () => {
  const sb = makeSandbox({ inspectionChecklist: [
    { id: "c1", key: "membrane", rating: "Fair", notes: "", linkedFindingId: null }
  ]});
  sb.ensureInspectionChecklist();
  const membrane = sb.inspectionChecklist.find(i => i.key === "membrane");
  assert.strictEqual(membrane.pin, null,
    "field is added as null -- self-heal must never FABRICATE a location");
});

/* Documents a real asymmetry: `pin` is self-healed for legacy rows but the
   other fields are not. A legacy row missing `notes` keeps it undefined, which
   reaches esc() in the renderer. Not a crash today; pinning it so an
   intentional fix is a visible decision rather than a silent drift. */
test("ensure: does NOT backfill notes/rating/linkedFindingId on legacy rows (pin only)", () => {
  const sb = makeSandbox({ inspectionChecklist: [{ id: "c1", key: "membrane" }] });
  sb.ensureInspectionChecklist();
  const membrane = sb.inspectionChecklist.find(i => i.key === "membrane");
  assert.strictEqual(membrane.pin, null, "pin IS healed");
  assert.strictEqual(membrane.notes, undefined, "notes is NOT healed -- current behaviour");
  assert.strictEqual(membrane.rating, undefined, "rating is NOT healed -- current behaviour");
});

test("ensure: an unknown/retired component key survives, sorted to the front", () => {
  const sb = makeSandbox({ inspectionChecklist: [
    { id: "c1", key: "gutters_retired", rating: "Poor", notes: "", linkedFindingId: null, pin: null }
  ]});
  sb.ensureInspectionChecklist();
  assert.strictEqual(sb.inspectionChecklist.length, 9, "old data is never silently dropped");
  /* findIndex returns -1 for an unknown key, so it sorts ahead of index 0.
     Pinning the current placement; the important guarantee is that it SURVIVES. */
  assert.strictEqual(sb.inspectionChecklist[0].key, "gutters_retired");
  assert.strictEqual(sb.inspectionComponentLabel("gutters_retired"), "gutters_retired",
    "an unmapped key falls back to showing the raw key rather than blank");
});

/* ================= syncInspectionFinding ================= */

test("sync: Fair/Poor/Critical each surface as exactly one auto-finding", () => {
  for (const rating of ["Fair", "Poor", "Critical"]){
    const sb = makeSandbox();
    sb.ensureInspectionChecklist();
    const item = sb.inspectionChecklist.find(i => i.key === "membrane");
    item.rating = rating;
    sb.syncInspectionFinding(item);
    assert.strictEqual(sb.findings.length, 1, rating + " must surface as a finding");
    assert.strictEqual(sb.findings[0].condition, "Membrane / Field: " + rating);
    assert.strictEqual(sb.findings[0].location, "Membrane / Field");
    assert.strictEqual(sb.findings[0].warranty, "Undetermined",
      "auto-findings never presume a warranty opinion -- that stays the tech's call");
    assert.strictEqual(item.linkedFindingId, sb.findings[0].id);
  }
});

test("sync: Good and N/A create nothing", () => {
  for (const rating of ["Good", "N/A"]){
    const sb = makeSandbox();
    sb.ensureInspectionChecklist();
    const item = sb.inspectionChecklist.find(i => i.key === "membrane");
    item.rating = rating;
    sb.syncInspectionFinding(item);
    assert.strictEqual(sb.findings.length, 0, rating + " is not a finding");
    assert.strictEqual(item.linkedFindingId, null);
  }
});

test("sync: notes ride into the finding text, em-dash separated", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "drainage");
  item.rating = "Critical";
  item.notes = "standing water 3 days after rain";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.findings[0].condition,
    "Drainage (incl. Ponding): Critical — standing water 3 days after rain");
});

test("sync: re-rating UPDATES the same finding in place rather than adding another", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "flashings");
  item.rating = "Fair";
  sb.syncInspectionFinding(item);
  const firstId = sb.findings[0].id;
  item.rating = "Critical";
  item.notes = "open corner";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.findings.length, 1, "a tech nudging the dropdown must not spawn duplicates");
  assert.strictEqual(sb.findings[0].id, firstId, "same finding, edited in place");
  assert.strictEqual(sb.findings[0].condition, "Flashings & Terminations: Critical — open corner");
});

test("sync: rating back up to Good REMOVES the auto-finding and clears the link", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "safety");
  item.rating = "Poor";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.findings.length, 1);
  item.rating = "Good";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.findings.length, 0, "correcting a misclick leaves no orphan finding");
  assert.strictEqual(item.linkedFindingId, null);
});

/* The photo-orphaning rule. Photos are keyed by finding_id, and checklist item
   ids and finding ids share that one field -- so removing an auto-finding must
   detach its photos rather than leave them pointing at a deleted row. */
test("sync: removing an auto-finding ORPHANS its photos instead of deleting them", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "penetrations");
  item.rating = "Poor";
  sb.syncInspectionFinding(item);
  const findingId = sb.findings[0].id;

  sb.photos.push({ id: "p1", finding_id: findingId, caption: "vent boot cracked" });
  sb.photos.push({ id: "p2", finding_id: "fnd_other", caption: "unrelated" });
  sb.photos.push({ id: "p3", finding_id: item.id, caption: "attached to the CHECKLIST item" });

  item.rating = "Good";
  sb.syncInspectionFinding(item);

  assert.strictEqual(sb.photos.length, 3, "the tech's photos are never destroyed by a rating change");
  assert.strictEqual(sb.photos[0].finding_id, null, "photo on the removed finding is detached");
  assert.strictEqual(sb.photos[1].finding_id, "fnd_other", "unrelated photos untouched");
  assert.strictEqual(sb.photos[2].finding_id, item.id,
    "a photo attached to the CHECKLIST ITEM keeps its link -- the item still exists");
});

test("sync: never touches findings the tech added by hand", () => {
  const sb = makeSandbox({ findings: [
    { id: "fnd_manual", condition: "Hail bruising, north slope", location: "N field",
      warranty: "Non-warrantable", pin: null }
  ]});
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "interior");
  item.rating = "Fair";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.findings.length, 2);
  item.rating = "N/A";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.findings.length, 1);
  assert.strictEqual(sb.findings[0].id, "fnd_manual", "the manual finding survives untouched");
  assert.strictEqual(sb.findings[0].warranty, "Non-warrantable");
});

test("sync: several flagged components coexist, each owning its own finding", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const flagged = ["membrane", "drainage", "safety"];
  flagged.forEach(key => {
    const item = sb.inspectionChecklist.find(i => i.key === key);
    item.rating = "Poor";
    sb.syncInspectionFinding(item);
  });
  assert.strictEqual(sb.findings.length, 3);
  const linked = flagged.map(k => sb.inspectionChecklist.find(i => i.key === k).linkedFindingId);
  assert.strictEqual(new Set(linked).size, 3, "no two components share a finding");

  /* Clearing the middle one leaves the other two intact. */
  const drainage = sb.inspectionChecklist.find(i => i.key === "drainage");
  drainage.rating = "Good";
  sb.syncInspectionFinding(drainage);
  assert.strictEqual(sb.findings.length, 2);
  assert.ok(!sb.findings.some(f => f.location.startsWith("Drainage")));
});

/* Guards the self-healing path: if a linked finding vanished some other way,
   sync must not throw and must leave the item in a clean state. */
test("sync: a dangling linkedFindingId is cleared without throwing", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "equipment");
  item.rating = "Poor";
  item.linkedFindingId = "fnd_vanished";
  sb.syncInspectionFinding(item);
  /* Below-Good with a dangling link: findingById misses, so a NEW finding is
     created and the link is repointed at it. */
  assert.strictEqual(sb.findings.length, 1);
  assert.strictEqual(item.linkedFindingId, sb.findings[0].id);

  const sb2 = makeSandbox();
  sb2.ensureInspectionChecklist();
  const item2 = sb2.inspectionChecklist.find(i => i.key === "equipment");
  item2.rating = "Good";
  item2.linkedFindingId = "fnd_vanished";
  sb2.syncInspectionFinding(item2);
  assert.strictEqual(item2.linkedFindingId, null, "link cleared even though there was nothing to splice");
  assert.strictEqual(sb2.findings.length, 0);
});

test("sync: re-renders the findings list on every call so the UI can't drift", () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "perimeter");
  item.rating = "Fair";
  sb.syncInspectionFinding(item);
  item.rating = "Good";
  sb.syncInspectionFinding(item);
  assert.strictEqual(sb.renderFindingsCalls, 2);
});

/* ================= maybeAutoPinInspectionItem ================= */

test("autopin: a GPS photo on a checklist item drops a device_gps pin", async () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "membrane");
  await sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: { lat: 41.25, lng: -95.93 } });
  /* JSON round-trip: the pin is built inside the vm context, so its prototype
     isn't the host realm's Object and deepStrictEqual would fail on that alone.
     Same idiom as findingRepairPairing.test.js. */
  assert.deepStrictEqual(JSON.parse(JSON.stringify(item.pin)),
    { lat: 41.25, lng: -95.93, x: null, y: null, source: "device_gps" });
  assert.strictEqual(sb.renderChecklistCalls, 1);
  assert.strictEqual(sb.toasts.length, 1);
});

test("autopin: NEVER overwrites a pin that is already there", async () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "membrane");
  item.pin = { lat: 1, lng: 2, x: null, y: null, source: "device_gps" };
  await sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: { lat: 41.25, lng: -95.93 } });
  assert.strictEqual(item.pin.lat, 1, "the FIRST photo anchors the spot -- later ones don't move it");
  assert.strictEqual(sb.toasts.length, 0, "no toast when nothing happened");
});

test("autopin: no GPS, no finding_id, or a non-checklist id -- all no-ops", async () => {
  const sb = makeSandbox();
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "membrane");
  await sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: null });
  await sb.maybeAutoPinInspectionItem({ finding_id: null, gps: { lat: 1, lng: 2 } });
  await sb.maybeAutoPinInspectionItem({ finding_id: "fnd_a_real_finding", gps: { lat: 1, lng: 2 } });
  await sb.maybeAutoPinInspectionItem(null);
  assert.strictEqual(item.pin, null);
  assert.strictEqual(sb.toasts.length, 0);
});

test("autopin: a confident roof match assigns the roof and is NOT flagged ambiguous", async () => {
  const sb = makeSandbox();
  sb.rmMaybeAutoAssignRoofForPin = async () => ({ roofId: "roof_a", label: "Main Roof", ambiguous: false });
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "drainage");
  await sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: { lat: 41.25, lng: -95.93 } });
  assert.strictEqual(item.roofId, "roof_a");
  assert.strictEqual(item.roofIdAmbiguous, false);
  assert.match(sb.toasts[0], /Main Roof/);
  assert.doesNotMatch(sb.toasts[0], /confirm/, "a confident match must not ask the tech to confirm");
});

test("autopin: an ambiguous match still assigns, but asks the tech to confirm", async () => {
  const sb = makeSandbox();
  sb.rmMaybeAutoAssignRoofForPin = async () => ({ roofId: "roof_b", label: "Section B", ambiguous: true });
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "drainage");
  await sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: { lat: 41.25, lng: -95.93 } });
  assert.strictEqual(item.roofId, "roof_b");
  assert.strictEqual(item.roofIdAmbiguous, true);
  assert.match(sb.toasts[0], /please confirm/);
});

test("autopin: a pin outside every roof is flagged ambiguous with NO roof guessed", async () => {
  const sb = makeSandbox();
  sb.rmMaybeAutoAssignRoofForPin = async () => ({ roofId: null, outsideAll: true });
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "perimeter");
  await sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: { lat: 41.25, lng: -95.93 } });
  assert.strictEqual(item.pin.source, "device_gps", "the pin is still dropped");
  assert.strictEqual(item.roofId, undefined, "standing in the parking lot must not guess a roof");
  assert.strictEqual(item.roofIdAmbiguous, true);
});

/* The pin lands before the roof lookup is awaited, so a lookup that throws
   leaves the item pinned but unassigned. Pinning this because the pin is the
   load-bearing half (it anchors before/after comparison) and it survives. */
test("autopin: the pin survives a roof-lookup failure", async () => {
  const sb = makeSandbox();
  sb.rmMaybeAutoAssignRoofForPin = async () => { throw new Error("offline"); };
  sb.ensureInspectionChecklist();
  const item = sb.inspectionChecklist.find(i => i.key === "interior");
  await assert.rejects(() =>
    sb.maybeAutoPinInspectionItem({ finding_id: item.id, gps: { lat: 41.25, lng: -95.93 } }));
  assert.strictEqual(item.pin.lat, 41.25, "pin is set before the await, so it persists");
  assert.strictEqual(item.roofId, undefined);
});
