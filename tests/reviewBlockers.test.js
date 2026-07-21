const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* REQUIRED #2 and #3 from the pre-promotion review (2026-07-20).

   #2 -- the merge happy path ended on an error. closeMergeBuildingModal()
        nulls mergeModalSurvivorId, and the redirect afterwards read it, so
        every SUCCESSFUL merge finished on "Couldn't load timeline" -- straight
        after a confirm that warns "this is not instant to reverse".

   #3a -- promptProjection() stripped workOrderId and photos but not
        visionImages, so every downscaled photo went to the model a second time
        as base64 TEXT alongside its image block. Double spend, and it undid
        exactly what the ~900px downscale was for. Live cost, the key is on prod.

   #3b -- a training row referenced its photo by POSITION in an array that is
        spliced on every delete. Remove one photo and existing rows start
        naming a different photo -- silently mislabelled training data. */

const ccSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const providerSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "aiProvider.js"), "utf8");
const labelsSource = fs.readFileSync(path.join(__dirname, "..", "js", "ailabels.js"), "utf8");

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

/* ================= #2: the merge happy path ================= */

test("the survivor id is captured BEFORE the modal is closed", () => {
  /* codeOnly FIRST: the fix's own comment names closeMergeBuildingModal()
     while explaining the ordering, and it sits ABOVE the capture — so a raw
     indexOf finds the close in the prose and reports the order backwards. */
  const block = codeOnly(between(ccSource, "async function mergeModalPick", "catch(e){ toast(\"Couldn't merge"));
  const capture = block.indexOf("var survivorId = mergeModalSurvivorId");
  const close = block.indexOf("closeMergeBuildingModal()");
  assert.ok(capture !== -1, "the id must be captured into a local");
  assert.ok(close !== -1, "the modal must still be closed");
  assert.ok(capture < close, "capture must precede the close that nulls it");
});

test("the post-merge redirect uses the captured id, not the nulled global", () => {
  const block = between(ccSource, "async function mergeModalPick", "catch(e){ toast(\"Couldn't merge");
  assert.match(block, /openBuildingHistory\(survivorId\)/);
  const close = block.indexOf("closeMergeBuildingModal()");
  const after = block.slice(close);
  assert.doesNotMatch(codeOnly(after), /openBuildingHistory\(mergeModalSurvivorId\)/,
    "reading the global after close() is the bug");
});

test("the stale duplicate-scan cache is cleared after a merge", () => {
  /* The merge re-points records and renames roofs; a cached "possible
     duplicate" answer for this building is now wrong. */
  const block = between(ccSource, "async function mergeModalPick", "catch(e){ toast(\"Couldn't merge");
  assert.match(block, /clearDuplicateBuildingCache/);
});

/* ================= #3a: no photo sent twice ================= */

test("promptProjection strips visionImages from the JSON projection", () => {
  const fn = between(providerSource, "function promptProjection", "async function identifyIssue");
  assert.match(fn, /delete out\.visionImages/);
});

test("the projection really drops them — run it", () => {
  /* Source-matching alone would pass on a delete that never runs. */
  const src = between(providerSource, "function promptProjection", "// (b) ISSUE-ID");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  const out = sb.promptProjection({
    jobName: "Somewhere",
    workOrderId: "wo_1",
    visionImages: [{ mediaType: "image/jpeg", data: "QUJD" }],
    photos: [{ caption: "north drain" }]
  });
  assert.strictEqual(out.visionImages, undefined, "base64 must not ride as text");
  assert.strictEqual(out.workOrderId, undefined);
  assert.strictEqual(out.photos, undefined);
  assert.deepEqual(out.photoCaptions, ["north drain"], "captions still reach the model");
  assert.equal(out.jobName, "Somewhere");
  assert.doesNotMatch(JSON.stringify(out), /QUJD/, "no image bytes anywhere in the prompt JSON");
});

/* ================= #3b: photos referenced by identity ================= */

function refSandbox(){
  const src = between(labelsSource, "function aiLabelNormalizePhotoRef", "/* ---- pin:");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb;
}

test("a photo reference keys off the stable local id", () => {
  const sb = refSandbox();
  const ref = sb.aiLabelNormalizePhotoRef({
    kind: "workorder_embedded", workOrderId: "wo_1", photoLocalId: "lp_abc", photoIndex: 3
  });
  assert.equal(ref.photoLocalId, "lp_abc");
});

test("the positional index is demoted to a snapshot, not the identity", () => {
  /* Renaming it is the point: nothing downstream can resolve a photo by
     position without noticing it is reading a field called *Snapshot. */
  const sb = refSandbox();
  const ref = sb.aiLabelNormalizePhotoRef({
    kind: "workorder_embedded", workOrderId: "wo_1", photoLocalId: "lp_abc", photoIndex: 3
  });
  assert.strictEqual(ref.photoIndex, undefined, "no field that reads as the identity");
  assert.equal(ref.photoIndexSnapshot, 3);
});

test("a row is still writable for a photo with no local id", () => {
  /* Photos predating localId, and CompanyCam imports, must not lose the
     ability to be labelled. */
  const sb = refSandbox();
  const ref = sb.aiLabelNormalizePhotoRef({ kind: "storage", workOrderId: "wo_1", photoIndex: 0 });
  assert.equal(ref.workOrderId, "wo_1");
  assert.equal(ref.photoIndexSnapshot, 0);
  assert.strictEqual(ref.photoLocalId, undefined);
});

test("a reference with neither identifier is refused", () => {
  const sb = refSandbox();
  assert.strictEqual(sb.aiLabelNormalizePhotoRef({ kind: "workorder_embedded", workOrderId: "wo_1" }), null);
  assert.strictEqual(sb.aiLabelNormalizePhotoRef({ kind: "workorder_embedded", photoLocalId: "lp_a" }), null,
    "workOrderId is still required");
});

test("the confirm path passes the photo's local id", () => {
  const block = between(labelsSource, "async function aiConfirmPhotoIssue", "var res = await recordConfirmedLabel");
  const call = between(labelsSource, "photo: { kind: \"workorder_embedded\"", "pin:");
  assert.match(call, /photoLocalId/);
  assert.ok(block.length > 0);
});
