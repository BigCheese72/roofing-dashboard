"use strict";
/* Regression guard for the 2026-07-13 security fix: netlify/functions/
   companycam.js and photos.js were both reachable by ANYONE on the internet
   with no token -- every CompanyCam project (names + customer addresses),
   every jobsite photo, document upload into Mark's CompanyCam account, and
   photo DELETE given only a workOrderId + index.
   
   Two things must stay true forever, and this file asserts BOTH, because
   fixing only one of them is how you either leave the hole open or lock the
   whole crew out of the field:
   
     1. NO valid Firebase ID token  ->  401, and a body that leaks nothing.
     2. ANY valid signed-in user (a plain tech, NOT an owner/admin) can still
        upload, view, batch-view and DELETE photos, and still use CompanyCam.
        The gate is AUTHENTICATION, not permission -- a tech must be able to
        fix their own mistakes in the field.
   
   firebase-admin is stubbed so this runs offline with no credentials and no
   secrets: only the sentinel token below "verifies", exactly as a real
   forged/garbage token would fail against Firebase. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const VALID = "VALID_CREW_TOKEN";
const bucket = new Map();

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token !== VALID) throw new Error("Decoding Firebase ID token failed");
        // A plain field tech: authenticated, but NOT owner and NOT admin.
        return { uid: "crew_tech_1", email: "tech@watkins.com", owner: false, role: "tech" };
      }
    };
  },
  storage() {
    return {
      bucket: () => ({
        file: (p) => ({
          save: async (buf) => { bucket.set(p, buf); },
          exists: async () => [bucket.has(p)],
          download: async () => [bucket.get(p) || Buffer.alloc(0)],
          delete: async () => { bucket.delete(p); }
        })
      })
    };
  },
  firestore() {
    return { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN"] = {
  id: "FAKE_FIREBASE_ADMIN", filename: "FAKE_FIREBASE_ADMIN", loaded: true, exports: fakeAdmin
};

// Dev-project service account (project_id is deliberately NOT production's,
// and every request below comes in on a dev-- host, so authGuard's
// cross-project safety guard is satisfied). cert() is stubbed -- no real key,
// no secret in this file.
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.COMPANYCAM_TOKEN = "cc_fake_token";
// If an unauthenticated caller ever reaches CompanyCam's API again, this
// throws loudly rather than quietly letting the test pass.
global.fetch = async () => { throw new Error("REACHED COMPANYCAM NETWORK CALL"); };

const photos = require("../netlify/functions/photos.js");
const companycam = require("../netlify/functions/companycam.js");

function ev(method, body, token, qs) {
  const headers = { host: "dev--watkins.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return {
    httpMethod: method,
    headers: headers,
    body: body ? JSON.stringify(body) : "",
    queryStringParameters: qs || {}
  };
}

// Every action photos.js exposes -- including the ones no client calls today
// (get_batch), because "nothing calls it" is not a security control.
const PHOTO_ACTIONS = [
  { action: "upload", workOrderId: "wo_123", photoIndex: 0, dataUrl: "data:image/jpeg;base64,eA==" },
  { action: "get", workOrderId: "wo_123", photoIndex: 0 },
  { action: "get_batch", items: [{ workOrderId: "wo_123", photoIndex: 0 }] },
  { action: "delete", workOrderId: "wo_123", photoIndex: 0 },
  { action: "migrate_scan" },
  { action: "migrate_photo", workOrderId: "wo_123", photoIndex: 0 },
  { action: "scan_missing_thumbnails" },
  { action: "backfill_thumbnail", workOrderId: "wo_123", photoIndex: 0 },
  { action: "totally_bogus" },
  {}
];
const CC_GET_ACTIONS = [
  { action: "projects" },
  { action: "project_detail", project_id: "1" },
  { action: "photos", project_id: "1" },
  { action: "image", url: "https://companycam.com/x.jpg" },
  { action: "bogus" }
];

// An anonymous caller must learn NOTHING -- not project names, not addresses,
// not photo bytes, not even whether an action name or a work order is real.
function assertNoLeak(body) {
  assert.match(body, /^\{"error":"Unauthorized"\}$/,
    "401 body must be a flat Unauthorized and nothing else, got: " + body);
}

for (const token of [null, "garbage.token.value"]) {
  const label = token ? "a GARBAGE token" : "NO token";

  test(`photos.js: every action returns 401 with ${label}`, async () => {
    for (const body of PHOTO_ACTIONS) {
      const r = await photos.handler(ev("POST", body, token));
      assert.strictEqual(r.statusCode, 401,
        `action ${body.action || "(none)"} must 401 with ${label}, got ${r.statusCode}`);
      assertNoLeak(r.body);
    }
  });

  test(`companycam.js: every action returns 401 with ${label}`, async () => {
    for (const qs of CC_GET_ACTIONS) {
      const r = await companycam.handler(ev("GET", null, token, qs));
      assert.strictEqual(r.statusCode, 401,
        `GET ${qs.action} must 401 with ${label}, got ${r.statusCode}`);
      assertNoLeak(r.body);
    }
    const up = await companycam.handler(
      ev("POST", { action: "upload_document", project_id: "1", attachment: "x" }, token));
    assert.strictEqual(up.statusCode, 401, "upload_document must 401 with " + label);
    assertNoLeak(up.body);
  });
}

// The other half of the fix. If this ever fails, the field crew is locked out.
test("AUTHENTICATED tech (not owner) keeps FULL photo access: upload, get, get_batch, DELETE", async () => {
  const wo = "wo_crew", idx = 7;
  const dataUrl = "data:image/jpeg;base64," + Buffer.from("realphoto").toString("base64");

  const up = await photos.handler(ev("POST", { action: "upload", workOrderId: wo, photoIndex: idx, dataUrl }, VALID));
  assert.strictEqual(up.statusCode, 200, "tech must still be able to UPLOAD");
  assert.match(up.body, /"storageRef":"workorders\/wo_crew\/7\.jpg"/);

  const get = await photos.handler(ev("POST", { action: "get", workOrderId: wo, photoIndex: idx }, VALID));
  assert.strictEqual(get.statusCode, 200, "tech must still be able to VIEW");
  assert.match(get.body, /"dataUrl":"data:image\/jpeg;base64,/);

  const batch = await photos.handler(ev("POST", { action: "get_batch", items: [{ workOrderId: wo, photoIndex: idx }] }, VALID));
  assert.strictEqual(batch.statusCode, 200, "tech must still be able to BATCH-VIEW");
  assert.match(batch.body, /"results":\[\{/);

  // Mark's hard requirement: "I want them to be able to edit their work orders
  // in case they mess something up." Delete must stay open to a plain tech.
  const del = await photos.handler(ev("POST", { action: "delete", workOrderId: wo, photoIndex: idx }, VALID));
  assert.strictEqual(del.statusCode, 200, "tech must still be able to DELETE");

  // The delete really happened -- not just a 200.
  const after = await photos.handler(ev("POST", { action: "get", workOrderId: wo, photoIndex: idx }, VALID));
  assert.strictEqual(after.statusCode, 404, "photo should be gone after a tech's delete");
});

test("AUTHENTICATED tech still reaches CompanyCam (passes the gate, is not role-blocked)", async () => {
  const r = await companycam.handler(ev("GET", null, VALID, { action: "projects" }));
  assert.notStrictEqual(r.statusCode, 401, "an authenticated tech must not be turned away");
  assert.notStrictEqual(r.statusCode, 403, "the gate is authentication, NOT permission");
  assert.notStrictEqual(r.statusCode, 503, "auth infrastructure should be healthy here");
});

// Authentication is the FLOOR for every action, not the CEILING for the
// owner-only bulk migrations -- those keep their extra owner check.
test("owner-only bulk actions stay owner-only for an authenticated tech (403, not 401)", async () => {
  for (const action of ["migrate_scan", "migrate_photo", "scan_missing_thumbnails", "backfill_thumbnail"]) {
    const r = await photos.handler(ev("POST", { action, workOrderId: "wo_123", photoIndex: 0 }, VALID));
    assert.strictEqual(r.statusCode, 403, action + " must stay owner-only");
  }
});
