// AI training labels — the learning-model data foundation (js/ailabels.js,
// netlify/functions/lib/aiLabels.js, firestore.rules). Covers: the
// controlled vocabulary's shape, entry validation, the never-a-URL photo
// reference discipline, the fail-safe write path, the admin vocab-extension
// seam, the rules block, and the deletion cascade.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "ailabels.js"), "utf8");
const rulesSource = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const purgeLib = require("../netlify/functions/lib/aiLabels");

/* Objects built inside the vm context have a different Object.prototype, so
   assert.deepStrictEqual rejects them on prototype identity — normalize
   through JSON before structural comparisons. */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/* Loads the whole module into a fresh vm context. opts.fdb / opts.fauth
   stand in for the core.js globals; a fresh sandbox per test also resets
   the module's session vocab cache. */
function makeSandbox(opts) {
  opts = opts || {};
  const sandbox = { console: { warn() {} } };
  if (opts.fdb !== undefined) sandbox.fdb = opts.fdb;
  if (opts.fauth !== undefined) sandbox.fauth = opts.fauth;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

/* Minimal fdb stub: records set() calls, serves app_settings/ai_label_vocab. */
function makeFdbStub(cfg) {
  cfg = cfg || {};
  const writes = [];
  const fdb = {
    __writes: writes,
    collection(name) {
      return {
        doc(id) {
          return {
            get() {
              if (name === "app_settings" && id === "ai_label_vocab") {
                if (cfg.vocabError) return Promise.reject(new Error("offline"));
                const extra = cfg.extraLabels;
                return Promise.resolve({ exists: !!extra, data: () => ({ extraLabels: extra }) });
              }
              return Promise.resolve({ exists: false, data: () => ({}) });
            },
            set(doc) {
              if (cfg.setError) return Promise.reject(new Error("permission denied"));
              writes.push({ collection: name, id, doc });
              return Promise.resolve();
            }
          };
        }
      };
    }
  };
  return fdb;
}

const signedIn = { currentUser: { uid: "uid_test_1" } };

function validEntry(overrides) {
  return Object.assign({
    source: "leak",
    label: "ponding_water",
    likelyCause: "Clogged drain upslope of the low spot",
    photo: { kind: "storage", workOrderId: "wo_123", photoIndex: 2 },
    pin: { lat: 35.1, lng: -80.8 },
    buildingId: "bld_stable_doc_id_1",
    customerId: "cust_1",
    workOrderId: "wo_123",
    findingId: "fnd_abc",
    roofId: "roof_default",
    roofSystem: "TPO",
    roofAgeYears: 12,
    confirmedByName: "Alex"
  }, overrides || {});
}

/* ================= controlled vocabulary ================= */

test("vocabulary: snake_case keys, unique, labeled, includes the required starter set", () => {
  const sb = makeSandbox();
  const vocab = sb.AI_ISSUE_LABELS;
  assert.ok(Array.isArray(vocab) && vocab.length >= 20, "starter set should be substantial");
  const keys = vocab.map(e => e.key);
  assert.strictEqual(new Set(keys).size, keys.length, "keys must be unique");
  vocab.forEach(e => {
    assert.match(e.key, /^[a-z0-9_]{2,60}$/, "key must be snake_case: " + e.key);
    assert.ok(typeof e.label === "string" && e.label.trim(), "label required for " + e.key);
  });
  // The brief's core failure modes must exist under stable keys.
  ["ponding_water", "flashing_failed", "open_seam", "blister", "fastener_backout",
   "puncture", "drain_clogged", "pitch_pan_deteriorated", "membrane_split",
   "coping_failure", "no_defect_found", "indeterminate", "sealant_deteriorated",
   "other"].forEach(k =>
    assert.ok(keys.includes(k), "missing required vocabulary key: " + k));
});

test("vocabulary: no_defect_found and indeterminate are distinct keys", () => {
  // "Looked, confirmed nothing wrong" vs "couldn't tell from this photo" are
  // different training signals — collapsing them would teach a model that
  // unreadable photos are clean roofs.
  const keys = makeSandbox().AI_ISSUE_LABELS.map(e => e.key);
  assert.ok(keys.includes("no_defect_found") && keys.includes("indeterminate"));
});

test("parity: aiProvider's ISSUE_VOCABULARY is a subset of AI_ISSUE_LABELS keys", () => {
  // The convergence contract from the #122/#123 coordination: what the
  // issue-ID model may answer with is exactly what a tech's confirmation
  // stores in ai_training_labels — no mapping table anywhere. The two lists
  // live on opposite sides of the browser/CommonJS split, so they're
  // hand-synced (getBuildingRoofsServer() discipline); this test is the
  // tripwire. AI_ISSUE_LABELS may be a superset (labels a tech can pick that
  // the model isn't offered) — the reverse is the drift this catches.
  const aiProvider = require("../netlify/functions/lib/aiProvider");
  const labelKeys = new Set(makeSandbox().AI_ISSUE_LABELS.map(e => e.key));
  assert.ok(Array.isArray(aiProvider.ISSUE_VOCABULARY) && aiProvider.ISSUE_VOCABULARY.length >= 10);
  const drifted = aiProvider.ISSUE_VOCABULARY.filter(k => !labelKeys.has(k));
  assert.deepStrictEqual(drifted, [],
    "ISSUE_VOCABULARY keys with no matching AI_ISSUE_LABELS key (a confirmed " +
    "model suggestion could not be stored as a training label): " + drifted.join(", "));
});

test("vocabulary: admin seam merges app_settings extraLabels, filters malformed ones", async () => {
  const sb = makeSandbox({
    fdb: makeFdbStub({ extraLabels: [
      { key: "solar_panel_leak", label: "Solar panel mount leak" },
      { key: "BAD KEY!", label: "rejected" },
      { key: "no_label" },
      null
    ]})
  });
  const extra = await sb.loadAiLabelVocabExtra();
  assert.deepStrictEqual(plain(extra.map(e => e.key)), ["solar_panel_leak"]);
  assert.ok(sb.aiLabelKeys().includes("solar_panel_leak"), "merged into the live vocabulary");
  assert.ok(sb.aiLabelKeys().includes("ponding_water"), "built-ins still present");
});

/* ================= validation ================= */

test("validate: a complete entry passes", () => {
  const sb = makeSandbox();
  assert.deepStrictEqual(plain(sb.aiLabelValidateEntry(validEntry())), { ok: true });
});

test("validate: rejects bad source, unknown label, other-without-text, missing buildingId", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ source: "dpr" })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ label: "wet roof" })).ok, false,
    "free-text labels are useless for training and must be rejected");
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ label: "other" })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ label: "other", labelOther: "new failure mode" })).ok, true);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ buildingId: "" })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ buildingId: undefined })).ok, false);
});

test("validate: photo must be a structured reference, never a URL", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ photo: "https://x.com/p.jpg" })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ photo: { kind: "url", url: "https://x.com/p.jpg" } })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ photo: null })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ photo: { kind: "storage", workOrderId: "wo_1" } })).ok, false,
    "storage kind requires photoIndex");
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({
    photo: { kind: "companycam", companyCamPhotoId: "cc_9", companyCamProjectId: "ccp_1" }
  })).ok, true);
});

test("validate: pin is {lat,lng} or {x,y} or absent", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ pin: null })).ok, true);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ pin: undefined })).ok, true);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ pin: { x: 120, y: 340 } })).ok, true);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ pin: { lat: "35" } })).ok, false);
  assert.strictEqual(sb.aiLabelValidateEntry(validEntry({ pin: { lat: NaN, lng: 1 } })).ok, false);
});

/* ================= document shape ================= */

test("buildDoc: exact schema, unknown caller keys dropped, no URL can survive", () => {
  const sb = makeSandbox();
  const entry = validEntry({ secretUiState: { html: "<div>" }, img: "data:image/jpeg;base64,AAA" });
  const doc = sb.aiLabelBuildDoc(entry, "uid_test_1");
  assert.strictEqual(doc.schemaVersion, 2); // v2: prediction capture + controlled cause
  assert.strictEqual(doc.label, "ponding_water");
  assert.strictEqual(doc.buildingId, "bld_stable_doc_id_1");
  assert.strictEqual(doc.confirmedByUid, "uid_test_1");
  assert.deepStrictEqual(plain(doc.photo), { kind: "storage", workOrderId: "wo_123", photoIndex: 2 });
  assert.deepStrictEqual(plain(doc.pin), { lat: 35.1, lng: -80.8, x: null, y: null });
  assert.strictEqual(doc.roofSystem, "TPO");
  assert.strictEqual(doc.roofAgeYears, 12);
  assert.ok(typeof doc.confirmedAt === "number" && typeof doc.createdAt === "number");
  assert.ok(!("secretUiState" in doc) && !("img" in doc), "unknown keys must be dropped");
  const json = JSON.stringify(doc);
  assert.ok(!/https?:/.test(json) && !/base64/.test(json),
    "a label record may never contain a URL or image bytes — references only");
});

test("buildDoc: defaults — roofId falls back to roof_default, optional ids null", () => {
  const sb = makeSandbox();
  const doc = sb.aiLabelBuildDoc(validEntry({
    roofId: undefined, customerId: undefined, workOrderId: undefined,
    findingId: undefined, roofAgeYears: undefined, roofSystem: undefined
  }), "u1");
  assert.strictEqual(doc.roofId, "roof_default");
  assert.strictEqual(doc.customerId, null);
  assert.strictEqual(doc.workOrderId, null);
  assert.strictEqual(doc.findingId, null);
  assert.strictEqual(doc.roofAgeYears, null);
  assert.strictEqual(doc.roofSystem, "");
});

/* ================= write path ================= */

test("recordConfirmedLabel: happy path writes one row to ai_training_labels", async () => {
  const fdb = makeFdbStub();
  const sb = makeSandbox({ fdb, fauth: signedIn });
  const res = await sb.recordConfirmedLabel(validEntry());
  assert.strictEqual(res.ok, true);
  assert.match(res.id, /^ail_/);
  assert.strictEqual(fdb.__writes.length, 1);
  assert.strictEqual(fdb.__writes[0].collection, "ai_training_labels");
  assert.strictEqual(fdb.__writes[0].id, res.id);
  assert.strictEqual(fdb.__writes[0].doc.confirmedByUid, "uid_test_1");
});

test("recordConfirmedLabel: accepts an admin-extended vocabulary key", async () => {
  const fdb = makeFdbStub({ extraLabels: [{ key: "solar_panel_leak", label: "Solar panel mount leak" }] });
  const sb = makeSandbox({ fdb, fauth: signedIn });
  const res = await sb.recordConfirmedLabel(validEntry({ label: "solar_panel_leak" }));
  assert.strictEqual(res.ok, true);
});

test("recordConfirmedLabel: fail-safe — never throws, never writes garbage", async () => {
  // invalid entry -> ok:false, no write
  const fdb1 = makeFdbStub();
  const sb1 = makeSandbox({ fdb: fdb1, fauth: signedIn });
  const bad = await sb1.recordConfirmedLabel(validEntry({ label: "not_in_vocab" }));
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(fdb1.__writes.length, 0);

  // signed out -> ok:false (rules would reject anyway; fail before the round-trip)
  const sb2 = makeSandbox({ fdb: makeFdbStub(), fauth: { currentUser: null } });
  assert.strictEqual((await sb2.recordConfirmedLabel(validEntry())).ok, false);

  // no Firestore at all -> ok:false
  const sb3 = makeSandbox({ fauth: signedIn });
  assert.strictEqual((await sb3.recordConfirmedLabel(validEntry())).ok, false);

  // Firestore write rejects -> resolved {ok:false}, not a rejection
  const sb4 = makeSandbox({ fdb: makeFdbStub({ setError: true }), fauth: signedIn });
  assert.strictEqual((await sb4.recordConfirmedLabel(validEntry())).ok, false);

  // vocab doc read fails -> built-in vocabulary still works
  const fdb5 = makeFdbStub({ vocabError: true });
  const sb5 = makeSandbox({ fdb: fdb5, fauth: signedIn });
  assert.strictEqual((await sb5.recordConfirmedLabel(validEntry())).ok, true);
});

/* ================= firestore.rules ================= */

test("rules: ai_training_labels is auth-gated create-only, validated, never client-readable", () => {
  const block = rulesSource.split("match /ai_training_labels/")[1];
  assert.ok(block, "firestore.rules must have an ai_training_labels block");
  const body = block.split("match /")[0]; // this block only
  assert.match(body, /request\.auth != null/);
  assert.match(body, /confirmedByUid == request\.auth\.uid/, "a label is the caller's own attestation");
  assert.match(body, /source in \['leak', 'inspection', 'workorder'\]/);
  assert.match(body, /photo is map/);
  assert.match(body, /allow read, update, delete: if false;/, "training data must not be client-readable");
});

/* ================= deletion cascade ================= */

function makePurgeDb(docCount) {
  const deleted = [];
  const commits = [];
  const docs = Array.from({ length: docCount }, (_, i) => ({ ref: "ref_" + i }));
  const db = {
    __deleted: deleted, __commits: commits,
    collection(name) {
      assert.strictEqual(name, "ai_training_labels");
      const q = {
        where() { return q; },
        get: () => Promise.resolve({ docs })
      };
      return q;
    },
    batch() {
      const ops = [];
      return {
        delete(ref) { ops.push(ref); deleted.push(ref); },
        commit() { commits.push(ops.length); return Promise.resolve(); }
      };
    }
  };
  return db;
}

test("cascade: purgeLabelsForBuilding deletes every matching row, chunked under the 500-op batch cap", async () => {
  const db = makePurgeDb(3);
  assert.strictEqual(await purgeLib.purgeLabelsForBuilding(db, "bld_1"), 3);
  assert.strictEqual(db.__deleted.length, 3);

  const big = makePurgeDb(501);
  assert.strictEqual(await purgeLib.purgeLabelsForWorkOrder(big, "wo_1"), 501);
  assert.deepStrictEqual(big.__commits, [500, 1], "501 docs need two batches");

  const photo = makePurgeDb(2);
  assert.strictEqual(await purgeLib.purgeLabelsForPhoto(photo, "wo_1", 0), 2);
});

test("cascade: admin.js's delete_building purges labels before deleting the building", () => {
  assert.match(adminSource, /require\("\.\/lib\/aiLabels"\)/);
  const deleteBlock = adminSource.split('body.action === "delete_building"')[1].split("body.action ===")[0];
  const purgeAt = deleteBlock.indexOf("purgeLabelsForBuilding(db, buildingId)");
  const commitAt = deleteBlock.indexOf("batch.commit()");
  assert.ok(purgeAt !== -1, "delete_building must cascade to ai_training_labels");
  assert.ok(commitAt !== -1 && purgeAt < commitAt,
    "labels purge before the building doc delete, so a mid-delete failure keeps a retry path");
});

/* ================= wiring ================= */

test("index.html loads js/ailabels.js so future confirm flows can call it", () => {
  assert.match(indexSource, /<script src="js\/ailabels\.js"><\/script>/);
});
