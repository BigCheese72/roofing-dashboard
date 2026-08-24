"use strict";
/* Guarded CompanyCam photo removal ("undo push"): the remove_pushed_photo action
   in netlify/functions/companycam.js + deletePushedPhotoFromCompanyCam() in
   lib/companyCamPhotos.js.

   THE POINT OF THESE TESTS is the SAFETY SCOPING: it must be structurally
   impossible to delete a real user-taken CompanyCam photo. The server derives the
   id to delete from OUR OWN stored ccFeedPhotoId; a photo we didn't push has none,
   so nothing is deleted. firebase-admin AND global fetch are stubbed -- no request
   reaches api.companycam.com; every DELETE the code would send is captured. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const OWNER = "OWNER_TOKEN";     // owner -> passes requirePermission automatically
const TECH = "TECH_TOKEN";       // non-owner, no companycam.link -> 403

// --- Firestore-ish store the fake admin reads/writes ---
let photoDocs = {};   // "woId/pId" -> data (or undefined = missing)
let woDocs = {};      // woId -> data (companyCamProjectId)
let audits = [];      // captured audit_logs writes
let photoSets = [];   // captured photo-doc merge writes

function docApi(getData, onSet){
  return { get: async () => { const d = getData(); return { exists: d !== undefined, data: () => d }; },
    set: async (data, opts) => { if (onSet) onSet(data, opts); } };
}
const fakeAdmin = {
  apps: [], credential: { cert: () => ({}) },
  initializeApp(cfg){ this.apps.push(cfg); return this; },
  auth(){ return { verifyIdToken: async (t) => {
    if (t === OWNER) return { uid: "owner_1", email: "owner@watkins.com", owner: true, role: "owner" };
    if (t === TECH) return { uid: "tech_1", email: "tech@watkins.com", owner: false, role: "tech" };
    throw new Error("Decoding Firebase ID token failed");
  } }; },
  storage(){ return { bucket: () => ({ file: () => ({ exists: async () => [false] }) }) }; },
  firestore(){
    return { collection(name){
      if (name === "workorders") return { doc(woId){ return {
        get: async () => ({ exists: woDocs[woId] !== undefined, data: () => woDocs[woId] }),
        collection(){ return { doc(pId){ const key = woId + "/" + pId;
          return docApi(() => photoDocs[key], (data) => { photoSets.push({ key, data }); photoDocs[key] = Object.assign({}, photoDocs[key], data); }); } }; }
      }; } };
      if (name === "roles") return { doc(rId){ return docApi(() => (rId === "tech" ? { permissions: {} } : undefined)); } };
      if (name === "audit_logs") return { doc(){ return { set: async (d) => { audits.push(d); } }; } };
      return { doc(){ return docApi(() => undefined); } };
    } };
  }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN"] = { id: "FAKE_FIREBASE_ADMIN", filename: "FAKE_FIREBASE_ADMIN", loaded: true, exports: fakeAdmin };

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.COMPANYCAM_TOKEN = "cc_fake_token";

let deletes = [];        // captured DELETE calls to CompanyCam
let nextDeleteStatus = 204;
global.fetch = async (url, opts) => {
  opts = opts || {};
  if (opts.method === "DELETE" && /\/v2\/photos\//.test(url)) { deletes.push(String(url)); return { ok: nextDeleteStatus < 300, status: nextDeleteStatus, text: async () => "" }; }
  if (/\/v2\/projects\/[^/]+$/.test(url)) return { ok: true, status: 200, json: async () => ({ coordinates: null }), text: async () => "{}" };
  throw new Error("UNEXPECTED CompanyCam call: " + opts.method + " " + url);
};

const companycam = require("../netlify/functions/companycam.js");

function ev(body, token){
  return { httpMethod: "POST", headers: { host: "dev--watkins.netlify.app", authorization: token ? "Bearer " + token : undefined },
    body: JSON.stringify(body), queryStringParameters: {} };
}
function reset(){ photoDocs = {}; woDocs = {}; audits = []; photoSets = []; deletes = []; nextDeleteStatus = 204; }

test("owner removes an app-pushed photo -> DELETEs the STORED id, clears our record, audits it", async () => {
  reset();
  photoDocs["wo_1/p2"] = { ccFeedPhotoId: "cc_photo_777", storageRef: "workorders/wo_1/2.jpg", caption: "keep me" };
  woDocs["wo_1"] = { companyCamProjectId: "proj_9" };

  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 2 }, OWNER));
  assert.strictEqual(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.deletedPhotoId, "cc_photo_777");
  assert.strictEqual(deletes.length, 1, "exactly one DELETE");
  assert.match(deletes[0], /\/v2\/photos\/cc_photo_777$/, "DELETEs the STORED id");
  // record cleared (merge write of ccFeedPhotoId:null), other fields untouched
  assert.deepStrictEqual(photoSets[0].data, { ccFeedPhotoId: null });
  assert.strictEqual(photoDocs["wo_1/p2"].caption, "keep me", "caption/storageRef untouched");
  // audit entry: what/where/who/when
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0].action, "companycam_photo_removed");
  assert.strictEqual(audits[0].ccFeedPhotoId, "cc_photo_777");
  assert.strictEqual(audits[0].projectId, "proj_9");
  assert.strictEqual(audits[0].actorUid, "owner_1");
  assert.strictEqual(audits[0].workOrderId, "wo_1");
  assert.ok(audits[0].ts > 0);
});

test("SCOPING GUARD: a photo we never pushed (no ccFeedPhotoId) is REFUSED, and NOTHING is deleted", async () => {
  reset();
  photoDocs["wo_1/p0"] = { storageRef: "workorders/wo_1/0.jpg" }; // a real user photo we never pushed
  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 0 }, OWNER));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { ok: false, skipped: true, reason: "not_integration_photo" });
  assert.strictEqual(deletes.length, 0, "a photo the app didn't push can NEVER be deleted");
  assert.strictEqual(audits.length, 0, "nothing happened -> nothing audited");
});

test("SCOPING GUARD: a bogus client-supplied photo id in the body cannot force a delete", async () => {
  reset();
  photoDocs["wo_1/p0"] = { storageRef: "workorders/wo_1/0.jpg" }; // not ours
  // Attacker tries to smuggle a raw CompanyCam id / mismatched expected id.
  const r = await companycam.handler(ev({
    action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 0,
    photoId: "SOMEONES_REAL_PHOTO", ccFeedPhotoId: "SOMEONES_REAL_PHOTO", expectedFeedPhotoId: "SOMEONES_REAL_PHOTO"
  }, OWNER));
  assert.strictEqual(JSON.parse(r.body).skipped, true);
  assert.strictEqual(deletes.length, 0, "the server ignores client-supplied ids; only OUR stored id is ever deletable");
});

test("drift guard: expectedFeedPhotoId that disagrees with our record is refused (no delete)", async () => {
  reset();
  photoDocs["wo_1/p1"] = { ccFeedPhotoId: "cc_real_1" };
  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 1, expectedFeedPhotoId: "cc_stale_9" }, OWNER));
  assert.deepStrictEqual(JSON.parse(r.body), { ok: false, skipped: true, reason: "feed_id_mismatch" });
  assert.strictEqual(deletes.length, 0);
});

test("permission gate: a non-owner without companycam.link is 403 -- no read, no delete, no audit", async () => {
  reset();
  photoDocs["wo_1/p0"] = { ccFeedPhotoId: "cc_photo_1" };
  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 0 }, TECH));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(deletes.length, 0);
  assert.strictEqual(audits.length, 0);
});

test("no token -> 401, nothing touched", async () => {
  reset();
  photoDocs["wo_1/p0"] = { ccFeedPhotoId: "cc_photo_1" };
  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 0 }, null));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(deletes.length, 0);
});

test("a crafted workOrderId cannot escape the workorders/ prefix (400, no delete)", async () => {
  reset();
  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "../../secret", photoIndex: 0 }, OWNER));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(deletes.length, 0);
});

test("CompanyCam 404 (already gone) still succeeds and clears our record", async () => {
  reset();
  photoDocs["wo_1/p0"] = { ccFeedPhotoId: "cc_gone_1" };
  nextDeleteStatus = 404;
  const r = await companycam.handler(ev({ action: "remove_pushed_photo", workOrderId: "wo_1", photoIndex: 0 }, OWNER));
  const out = JSON.parse(r.body);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.alreadyGone, true);
  assert.deepStrictEqual(photoSets[0].data, { ccFeedPhotoId: null }, "our record is cleared even when CC already lost it");
});
