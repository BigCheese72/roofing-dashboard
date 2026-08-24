const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/* "Add from CompanyCam" on inspection checklist sections (Mark, 2026-07-20).

   The crew routinely shoots a roof into CompanyCam first and writes the
   inspection afterwards, so the photo for a checklist section usually already
   exists. The leak-FINDING strip has had an import button since the beginning;
   the checklist strip never got one, so those photos had to be re-shot.

   Nearly all the plumbing already existed -- openCC(id) targets a row and
   ccImport() attaches by id -- which is what made the one real gap easy to
   miss: the import path only auto-pinned FINDINGS. A checklist item's id is
   not in findings[], so an imported photo silently skipped the pin that a
   camera photo on the same row gets. */

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const ccSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const CHECKLIST_STRIP = () =>
  between(workordersSource, "function inspectionItemPhotoGalleryHtml", "\nfunction ");

/* ================= the button ================= */

test("the checklist strip offers CompanyCam alongside camera and library", () => {
  const strip = CHECKLIST_STRIP();
  assert.match(strip, /Take Photo/);
  assert.match(strip, /Add Photos/);
  assert.match(strip, /Add from CompanyCam/);
});

test("the button targets THIS checklist row, not the global import", () => {
  /* openCC() with no argument imports into the work order generally. The row's
     own id is what makes ccImport() attach the photo to this section. */
  const strip = CHECKLIST_STRIP();
  assert.match(strip, /openCC\(\\?'" \+ safeId \+ "\\?'\)|openCC\(\\'' \+ safeId \+ '\\'\)/,
    "must pass the item id");
  assert.doesNotMatch(strip, /onclick="openCC\(\)"/, "must not open the untargeted picker");
});

test("the id is escaped into the handler, like the camera and library buttons", () => {
  const strip = CHECKLIST_STRIP();
  assert.match(strip, /var safeId = esc\(item\.id\)/);
});

/* ================= the gap the button exposed ================= */

test("an imported photo auto-pins on a CHECKLIST row, not just a finding", () => {
  /* THE bug. ccImport() called maybeAutoPinFinding() only, which looks the id
     up in findings[] and no-ops for a checklist item -- so the new button
     would have shipped quietly not doing what the camera button beside it
     does. */
  const block = between(ccSource, "compressed.finding_id = ccTargetFindingId", "renderPhotos();");
  assert.match(block, /maybeAutoPinFinding\(compressed\)/);
  assert.match(block, /maybeAutoPinInspectionItem\(compressed\)/);
});

test("both pin paths are awaited, matching the camera path", () => {
  /* js/photos.js awaits them sequentially -- they mutate shared state and
     rmMaybeAutoAssignRoofForPin() is async. Fire-and-forget here would race. */
  const block = between(ccSource, "compressed.finding_id = ccTargetFindingId", "renderPhotos();");
  assert.match(block, /await maybeAutoPinFinding/);
  assert.match(block, /await maybeAutoPinInspectionItem/);
});

test("the two pin helpers stay mutually exclusive by construction", () => {
  /* Calling both is only safe because each no-ops when the id is not in its
     own array. If either ever stopped checking, one photo would get two pins. */
  const finding = between(photosSource, "async function maybeAutoPinFinding", "async function maybeAutoPinInspectionItem");
  assert.match(finding, /findingById\(photo\.finding_id\)/);
  assert.match(finding, /if \(!f \|\| f\.pin\) return/);
  const item = between(photosSource, "async function maybeAutoPinInspectionItem", "function maybeAutoPinPhoto");
  assert.match(item, /inspectionChecklistItemById\(photo\.finding_id\)/);
});

test("the checklist re-renders after an import so the photo appears", () => {
  /* Anchor inside ccImport(): "renderPhotos();" alone matches an earlier,
     unrelated call site. */
  const tail = between(ccSource, "async function ccImport", "renderCCLinkInfo();");
  assert.match(tail, /inspectionChecklistItemById\(ccTargetFindingId\)/);
  assert.match(tail, /renderInspectionChecklist\(\)/);
});

test("the import target is cleared when the modal closes", () => {
  /* A stale ccTargetFindingId would attach the NEXT global import to a
     checklist row the user has moved on from. */
  const close = between(ccSource, "function closeCC()", "/* ccApi()");
  assert.match(close, /ccTargetFindingId = null/);
});
