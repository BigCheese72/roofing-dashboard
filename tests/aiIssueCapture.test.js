const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Vision learning pipeline, Phase 1 + 2 (Mark, 2026-07-19).

   Phase 1 asks the vision model what it sees in ONE photo. Phase 2 lets the
   tech confirm or correct that call, and THAT decision becomes a training row.

   The invariant worth defending: an unreviewed model guess is NOT training
   data. Nothing is ever written without a human decision, and the row records
   both what the model said and what the tech decided -- so an override is a
   labelled error case rather than a silently discarded guess. If a future
   change starts writing rows automatically, these tests should fail loudly. */

const labelsSource = fs.readFileSync(path.join(__dirname, "..", "js", "ailabels.js"), "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const aiServiceSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "ai-service.js"), "utf8");
const providerSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "aiProvider.js"), "utf8");
const rulesSource = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
const provider = require("../netlify/functions/lib/aiProvider");

/* Slice from a marker to end-of-file. between() with an empty end marker
   silently returns "" (indexOf("") returns the start index), which made two
   assertions below vacuously pass against an empty string. */
function from(source, start){
  const a = source.indexOf(start);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  return source.slice(a);
}
function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Run the real ailabels.js in a sandbox, stubbing only the browser edges. */
function sandbox(opts){
  opts = opts || {};
  const written = [];
  const sb = {
    console: { warn(){}, log(){} },
    document: { getElementById(){ return null; } },
    toast(){},
    fdb: null,
    __written: written
  };
  vm.createContext(sb);
  vm.runInContext(labelsSource, sb);
  return sb;
}

/* ================= schema v2: the part we're stuck with ================= */

test("an override is recorded as a labelled error case", () => {
  /* THE point of schemaVersion 2. v1 stored only the confirmed answer, so a
     correction -- the most valuable row type there is -- was indistinguishable
     from an agreement. */
  const sb = sandbox();
  const doc = sb.aiLabelBuildDoc({
    source: "leak", label: "ponding_water",
    predictedLabel: "drain_clogged", predictedCause: "debris_accumulation",
    predictedConfidence: "medium", modelId: "claude-opus-4-8",
    buildingId: "bld_1", photo: { kind: "storage", workOrderId: "wo_1", photoIndex: 0 }
  }, "uid_1");
  assert.equal(doc.label, "ponding_water", "the tech's answer is the label");
  assert.equal(doc.predictedLabel, "drain_clogged", "the model's answer is kept alongside");
  assert.equal(doc.agreed, false);
  assert.equal(doc.modelId, "claude-opus-4-8");
});

test("an agreement is recorded as agreed:true", () => {
  const sb = sandbox();
  const doc = sb.aiLabelBuildDoc({
    source: "leak", label: "ponding_water", predictedLabel: "ponding_water",
    buildingId: "b", photo: { kind: "storage", workOrderId: "w", photoIndex: 0 }
  }, "u");
  assert.equal(doc.agreed, true);
});

test("NO prediction yields agreed:null, never false", () => {
  /* A tech labelling a photo the AI never saw is not a disagreement. Storing
     false here would poison the error set with rows the model never called. */
  const sb = sandbox();
  const doc = sb.aiLabelBuildDoc({
    source: "leak", label: "blister",
    buildingId: "b", photo: { kind: "storage", workOrderId: "w", photoIndex: 0 }
  }, "u");
  assert.strictEqual(doc.agreed, null);
  assert.strictEqual(doc.predictedLabel, null);
});

test("`agreed` is DERIVED and cannot be forged by the caller", () => {
  /* A caller passing agreed:true on a genuine override must not be believed --
     the field is computed from the two labels, full stop. */
  const sb = sandbox();
  const doc = sb.aiLabelBuildDoc({
    source: "leak", label: "ponding_water", predictedLabel: "hail_damage",
    agreed: true,
    buildingId: "b", photo: { kind: "storage", workOrderId: "w", photoIndex: 0 }
  }, "u");
  assert.equal(doc.agreed, false, "derived from the labels, not from the caller");
});

test("cause is controlled vocabulary; free text is coerced, not stored", () => {
  /* "clogged drain", "drain blocked" and "debris in drain" are one class typed
     three ways -- useless for training. */
  const sb = sandbox();
  const doc = sb.aiLabelBuildDoc({
    source: "leak", label: "blister", likelyCause: "whatever the tech felt like typing",
    buildingId: "b", photo: { kind: "storage", workOrderId: "w", photoIndex: 0 }
  }, "u");
  assert.equal(doc.likelyCause, "unconfirmed");
});

test("the tech's own wording survives in causeNote", () => {
  const sb = sandbox();
  const doc = sb.aiLabelBuildDoc({
    source: "leak", label: "ponding_water", likelyCause: "drainage_deficiency",
    causeNote: "drain packed with gravel from the parapet",
    buildingId: "b", photo: { kind: "storage", workOrderId: "w", photoIndex: 0 }
  }, "u");
  assert.equal(doc.likelyCause, "drainage_deficiency");
  assert.match(doc.causeNote, /gravel/);
});

test("the browser cause vocabulary matches the server's, key for key", () => {
  /* Hand-synced across the browser/CommonJS split, same discipline as the
     issue-label parity contract. This test is the only thing stopping drift. */
  const sb = sandbox();
  assert.deepEqual(sb.aiLabelCauseKeys().slice().sort(),
                   provider.CAUSE_VOCABULARY.slice().sort());
});

test("firestore.rules accepts BOTH schema versions", () => {
  /* The coupling that would have bitten: rules pinned schemaVersion == 1, so
     bumping the constant alone means every v2 write is rejected in production,
     silently, at the rules layer. Accepting [1,2] also lets a client still on
     the previous bundle keep writing valid rows mid-deploy. */
  assert.match(rulesSource, /schemaVersion in \[1, 2\]/);
  const sb = sandbox();
  assert.equal(sb.AI_LABEL_SCHEMA_VERSION, 2);
});

/* ================= nothing is written without a human ================= */

test("a row is written ONLY from confirm/correct, never from inference", () => {
  const infer = between(labelsSource, "async function aiIdentifyPhotoIssue", "async function aiConfirmPhotoIssue");
  assert.doesNotMatch(infer, /recordConfirmedLabel/,
    "Phase 1 must never write a training row -- an unreviewed guess is not data");
  const confirm = from(labelsSource, "async function aiConfirmPhotoIssue");
  assert.match(confirm, /recordConfirmedLabel\(/);
});

test("inference is button-triggered, never automatic on capture", () => {
  /* The tap IS the cost control, same rule as the summary button. */
  const block = between(labelsSource, "function aiIssueInnerHtml", "function aiIssueLabelText");
  assert.match(block, /onclick="aiIdentifyPhotoIssue\(/);
  assert.doesNotMatch(workordersSource, /aiIdentifyPhotoIssue\(/,
    "the photo strip renders the button; it must not call inference itself");
});

test("keyless deploys show 'coming soon' and make no model call", () => {
  const block = between(labelsSource, "async function aiIdentifyPhotoIssue", "aiIssueState[gi] = { loading: true }");
  assert.match(block, /aiSummaryConfigured/, "reuses the summary's capability probe -- one gate");
  assert.match(block, /coming soon/);
  const gateIdx = block.indexOf("coming soon");
  const fetchIdx = labelsSource.indexOf("ai-service");
  assert.ok(gateIdx !== -1 && fetchIdx > labelsSource.indexOf("async function aiIdentifyPhotoIssue"),
    "the gate returns before any fetch");
});

test("correction uses dropdowns over the vocabulary, never free text", () => {
  const block = between(labelsSource, "function aiIssueInnerHtml", "function aiIssueLabelText");
  assert.match(block, /aiLabelVocabulary\(\)\.map/, "issue is a select over the vocabulary");
  assert.match(block, /AI_CAUSE_LABELS\.map/, "cause is a select over the vocabulary");
  /* The only free-text input is the optional note, which is stored separately
     and never used as the label. */
  const textInputs = (block.match(/type="text"/g) || []).length;
  assert.equal(textInputs, 1, "exactly one free-text field: the optional note");
  assert.match(block, /ai-cause-note-/);
});

/* ================= the roof snapshot ================= */

test("the roof snapshot is taken at confirm time, from the multi-roof profile", () => {
  /* Historical fact, not a live join: a roof re-roofed in two years must not
     silently rewrite what the roof was when the photo was taken. */
  const block = between(labelsSource, "async function aiConfirmPhotoIssue", "var res = await recordConfirmedLabel");
  assert.match(block, /inspectionRoofSystemCache/);
  assert.match(block, /inspectionRoofAgeYears/);
  assert.match(block, /roofSystem = o\.roofSystem/, "falls back to the work order's own system");
});

test("a label without a building is refused, not written half-formed", () => {
  const block = between(labelsSource, "async function aiConfirmPhotoIssue", "var res = await recordConfirmedLabel");
  assert.match(block, /if \(!buildingId\)/);
  assert.match(block, /return;/);
});

test("the photo is stored as a REFERENCE, never bytes or a URL", () => {
  /* A training row must not become a second copy of customer photo data, and
     must never carry a fetchable URL. */
  const block = from(labelsSource, "async function aiConfirmPhotoIssue");
  assert.match(block, /photo: \{ kind: "workorder_embedded"/);
  assert.doesNotMatch(block, /p\.img/, "the row must never carry photo bytes");
});

/* ================= issue_id accepts the dev path ================= */

test("issue_id accepts an inline image as well as a signed URL", () => {
  /* The dev project has no Storage bucket and is the only context with a key,
     so without this the feature could never be exercised before prod. */
  const block = between(aiServiceSource, 'if (body.action === "issue_id")', "const out = await ai.identifyIssue");
  assert.match(block, /cleanInlineImage\(body\.photoImage\)/);
  assert.match(block, /!hasInline && !ai\.isSignedPhotoUrl/);
});

test("an unsigned URL with no inline image is still rejected", () => {
  /* The signed-URL rule is not relaxed by the new path -- it is joined by it. */
  const block = between(providerSource, "async function identifyIssue", "const text = await callProvider");
  assert.match(block, /!inlineImage && !isSignedPhotoUrl/);
  assert.match(block, /throw new Error/);
});

test("inline images on issue_id go through the same validation gate", () => {
  const block = between(providerSource, "async function identifyIssue", "const text = await callProvider");
  assert.match(block, /cleanInlineImage\(input\.photoImage\)/);
});

/* ================= the chip is wired where photos live ================= */

test("the chip renders on BOTH the finding and inspection photo strips", () => {
  const hits = (workordersSource.match(/aiIssueChipHtml\(/g) || []).length;
  assert.ok(hits >= 2, "a checklist photo is as good a training row as a finding photo, saw " + hits);
});

test("a missing ailabels module costs one button, not the photo strip", () => {
  assert.match(workordersSource, /typeof aiIssueChipHtml === "function"/);
});
