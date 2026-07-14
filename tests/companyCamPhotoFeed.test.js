"use strict";
/* Tests for the CompanyCam PHOTO FEED push (work-order photos -> the linked
   project's feed, map-pinned), on BOTH sides of the wire:

     SERVER  netlify/functions/lib/companyCamPhotos.js + the upload_photo action
             in netlify/functions/companycam.js
     CLIENT  pushPhotosToCompanyCamFeed() / ccBestPhotoCoordinate() in
             js/history.js (loaded from REAL source via vm, the same way
             reportScaleProvenance.test.js does -- a hand-copied mirror of the
             logic could drift silently out of sync with the file it claims to
             guard, which defeats the point)

   NOTHING here touches a real CompanyCam project. firebase-admin AND global
   fetch are both stubbed; every request the code would have made to
   api.companycam.com is captured and asserted against instead of sent. If a
   test ever reaches the network, the fetch stub records the URL and the
   assertions below will show it.

   Run: npm test */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* ---------------------------------------------------------------- stubs -- */

const VALID = "VALID_CREW_TOKEN";
const SIGNED_URL = "https://storage.googleapis.com/bkt/workorders/wo_1/0.jpg?X-Goog-Signature=deadbeef";

// Objects that "exist" in Storage. Keyed by object path.
const storage = new Set();
// Every photo doc merge-written back to Firestore, keyed by path.
const firestoreWrites = [];

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token !== VALID) throw new Error("Decoding Firebase ID token failed");
        return { uid: "crew_tech_1", email: "tech@watkins.com", owner: false, role: "tech" };
      }
    };
  },
  storage() {
    return {
      bucket: () => ({
        file: (p) => ({
          exists: async () => [storage.has(p)],
          // The real thing returns [url]; the signed URL is the WHOLE point of
          // this feature (CompanyCam fetches the image from it), so the test
          // asserts the code actually asks for a v4 READ url with an expiry.
          getSignedUrl: async (opts) => {
            assert.strictEqual(opts.version, "v4", "must mint a V4 signed URL");
            assert.strictEqual(opts.action, "read", "CompanyCam only needs READ");
            assert.ok(opts.expires > Date.now(), "signed URL must expire in the future");
            assert.ok(opts.expires <= Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000,
              "7 days is Google's V4 maximum -- a longer expiry would be silently rejected");
            return [SIGNED_URL];
          }
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

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.COMPANYCAM_TOKEN = "cc_fake_token";

// Every CompanyCam call the server makes is captured here. NONE go out.
let ccCalls = [];
let projectCoordinates = null;   // what GET /projects/{id} reports, or null
let nextPhotoPostFails = false;

global.fetch = async (url, opts) => {
  opts = opts || {};
  ccCalls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });

  if (/\/v2\/projects\/[^/]+\/photos$/.test(url) && opts.method === "POST") {
    if (nextPhotoPostFails) {
      return { ok: false, status: 422, text: async () => '{"errors":["nope"]}' };
    }
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: "cc_photo_" + ccCalls.length, processing_status: "pending" }) };
  }
  if (/\/v2\/projects\/[^/]+\/documents$/.test(url) && opts.method === "POST") {
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: "cc_doc_1" }) };
  }
  if (/\/v2\/projects\/[^/]+$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ id: "p1", coordinates: projectCoordinates }), text: async () => "{}" };
  }
  throw new Error("UNEXPECTED CompanyCam call: " + url);
};

const companycam = require("../netlify/functions/companycam.js");
const lib = require("../netlify/functions/lib/companyCamPhotos.js");

function ev(body, token) {
  return {
    httpMethod: "POST",
    headers: { host: "dev--watkins.netlify.app", authorization: token ? "Bearer " + token : undefined },
    body: JSON.stringify(body),
    queryStringParameters: {}
  };
}
function photoPosts() {
  return ccCalls.filter(c => /\/photos$/.test(c.url) && c.method === "POST");
}
function reset() {
  ccCalls = [];
  projectCoordinates = null;
  nextPhotoPostFails = false;
  firestoreWrites.length = 0;
}

/* =========================================================== SERVER SIDE == */

test("SERVER: the auth guard is NOT weakened -- upload_photo 401s with no/garbage token", async () => {
  for (const token of [null, "garbage.token"]) {
    reset();
    const r = await companycam.handler(ev({
      action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 0
    }, token));
    assert.strictEqual(r.statusCode, 401, "upload_photo must sit behind requireAuth");
    assert.match(r.body, /^\{"error":"Unauthorized"\}$/, "401 must leak nothing");
    assert.strictEqual(ccCalls.length, 0, "an unauthenticated caller must never reach CompanyCam");
  }
});

test("SERVER: an authenticated TECH (not owner) can push -- it's a field op, not an admin op", async () => {
  reset();
  storage.add("workorders/wo_1/0.jpg");
  const r = await companycam.handler(ev({
    action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 0,
    coordinates: { lat: 35.1, lon: -80.2 }, captured_at: 1752000000000
  }, VALID));
  assert.strictEqual(r.statusCode, 200);
  assert.notStrictEqual(r.statusCode, 403, "the gate is AUTHENTICATION, not permission");
  assert.match(r.body, /"photoId":"cc_photo_/);
});

test("SERVER: posts the verified contract -- uri (signed URL), captured_at in SECONDS, coordinates as lat/LON", async () => {
  reset();
  storage.add("workorders/wo_1/0.jpg");
  await companycam.handler(ev({
    action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 0,
    coordinates: { lat: 35.123456, lon: -80.654321 },
    captured_at: 1752000000000,   // MILLISECONDS, as every timestamp in this app is
    description: "Split seam at drain"
  }, VALID));

  const posts = photoPosts();
  assert.strictEqual(posts.length, 1, "exactly one photo POST");
  assert.match(posts[0].url, /^https:\/\/api\.companycam\.com\/v2\/projects\/p1\/photos$/);

  const photo = posts[0].body.photo;
  assert.ok(photo, "body must be wrapped in a `photo` object -- CompanyCam requires it");
  assert.strictEqual(photo.uri, SIGNED_URL, "uri must be the fetchable signed Storage URL");
  assert.deepStrictEqual(photo.coordinates, { lat: 35.123456, lon: -80.654321 },
    "CompanyCam's field is `lon`, NOT `lng` -- getting this wrong silently drops the pin");
  assert.strictEqual(photo.captured_at, 1752000000,
    "captured_at must be unix SECONDS -- passing our milliseconds through would date the photo ~50,000 years out");
  assert.ok(Number.isInteger(photo.captured_at), "captured_at must be an integer");
  assert.strictEqual(photo.description, "Split seam at drain");
  assert.match(posts[0].headers.Authorization, /^Bearer /);
});

test("SERVER: a photo not in Storage is SKIPPED (200 {skipped}), never an error, and never posted", async () => {
  reset();
  const r = await companycam.handler(ev({
    action: "upload_photo", project_id: "p1", workOrderId: "wo_ghost", photoIndex: 4
  }, VALID));
  assert.strictEqual(r.statusCode, 200, "a legacy/not-yet-uploaded photo is an expected state, not a failure");
  const out = JSON.parse(r.body);
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, "not_in_storage");
  assert.strictEqual(photoPosts().length, 0, "nothing may be pushed for a photo we can't actually serve");
});

test("SERVER: with NO coordinate from the client, it falls back to the linked PROJECT's own location", async () => {
  reset();
  storage.add("workorders/wo_1/1.jpg");
  projectCoordinates = { lat: 41.5, lon: -81.7 };
  await companycam.handler(ev({
    action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 1, coordinates: null
  }, VALID));
  const photo = photoPosts()[0].body.photo;
  assert.deepStrictEqual(photo.coordinates, { lat: 41.5, lon: -81.7 },
    "the job's location IS the linked project's location -- ask CompanyCam, don't guess");
});

test("SERVER: with no coordinate anywhere, the photo still reaches the feed -- UNPINNED, never faked", async () => {
  reset();
  storage.add("workorders/wo_1/2.jpg");
  projectCoordinates = null;
  await companycam.handler(ev({
    action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 2, coordinates: null
  }, VALID));
  const photo = photoPosts()[0].body.photo;
  assert.strictEqual(photo.coordinates, undefined,
    "no coordinate must mean NO coordinates key -- an honestly unpinned photo, not a fabricated pin");
  assert.strictEqual(photo.uri, SIGNED_URL, "it still gets pushed");
});

test("SERVER: NULL ISLAND (0,0) is rejected as a coordinate, not published as a pin", () => {
  assert.strictEqual(lib.normalizeCoordinates({ lat: 0, lon: 0 }), null,
    "(0,0) is what a BROKEN coordinate looks like in this app's data (see tools/audit_null_island.js)");
  assert.strictEqual(lib.normalizeCoordinates({ lat: 91, lon: 0 }), null, "out-of-range lat");
  assert.strictEqual(lib.normalizeCoordinates({ lat: 35, lon: -200 }), null, "out-of-range lon");
  assert.strictEqual(lib.normalizeCoordinates(null), null);
  // Accepts the app's own {lat,lng} shape and converts it to CompanyCam's {lat,lon}.
  assert.deepStrictEqual(lib.normalizeCoordinates({ lat: 35, lng: -80 }), { lat: 35, lon: -80 });
});

test("SERVER: a crafted workOrderId cannot escape the workorders/ prefix", async () => {
  reset();
  const r = await companycam.handler(ev({
    action: "upload_photo", project_id: "p1", workOrderId: "../../etc/passwd", photoIndex: 0
  }, VALID));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(photoPosts().length, 0);
});

/* =========================================================== CLIENT SIDE == */

// Loads the REAL js/history.js (plus js/core.js for its helpers) into a vm
// sandbox with the browser bits stubbed -- same technique as
// reportScaleProvenance.test.js. ccApiPost is stubbed to run the SERVER
// handler above, so a client test exercises the whole path end-to-end
// (client -> action -> lib -> [stubbed] CompanyCam) without a network.
function loadClient(opts) {
  opts = opts || {};
  const noop = function () {};
  const stubEl = () => ({
    style: {}, classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [], setAttribute: noop,
    getAttribute: () => null, children: [], value: "", textContent: "", innerHTML: ""
  });
  const toasts = [];
  const sandbox = {
    console,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: stubEl, addEventListener: noop, body: stubEl()
    },
    navigator: { geolocation: {}, onLine: true, userAgent: "node-test" },
    L: { map: noop, tileLayer: noop, marker: noop, divIcon: noop, layerGroup: noop, polygon: noop,
         polyline: noop, circle: noop, circleMarker: noop, rectangle: noop,
         point: (x, y) => ({ x, y }), latLng: (a, b) => ({ lat: a, lng: b }) },
    URL: { createObjectURL: noop, revokeObjectURL: noop },
    Image: function () { this.addEventListener = noop; },
    Blob: function () {}, addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hostname: "localhost", href: "http://localhost/", search: "" },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    fetch: global.fetch, Date, Math, JSON, Number, String, Boolean, Array, Object, Promise, isFinite
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const root = path.join(__dirname, "..");
  ["js/core.js", "js/history.js"].forEach(function (rel) {
    vm.runInContext(fs.readFileSync(path.join(root, rel), "utf8"), sandbox, { filename: rel });
  });

  // --- overrides, applied AFTER the real source is loaded ---
  sandbox.toast = (m) => toasts.push(String(m));
  // The real client's only door to the server. Route it at the REAL handler.
  sandbox.ccApiPost = async (body) => {
    const r = await companycam.handler(ev(body, VALID));
    const out = JSON.parse(r.body);
    if (r.statusCode >= 400 || !out) throw new Error((out && out.error) || ("server error " + r.statusCode));
    return out;
  };
  // Geocoder: whatever the test wants the job address to resolve to (or fail).
  sandbox.geocodeAddress = async () => (opts.siteLatLng || null);
  // Firestore: capture the idempotency merge-writes instead of performing them.
  sandbox.fdb = {
    collection: () => ({
      doc: (woId) => ({
        collection: () => ({
          doc: (pid) => ({
            set: async (data, o2) => { firestoreWrites.push({ woId, pid, data, opts: o2 }); }
          })
        })
      })
    })
  };
  sandbox.__toasts = toasts;
  return sandbox;
}

// A work order with one photo of every kind that matters.
function fixtureOrder() {
  return {
    id: "wo_1",
    jobNo: "1234",
    jobName: "Tri-Delta",
    location: "100 Main St",
    serviceDate: "2026-07-10",
    companyCamProjectId: "p1",
    findings: [
      { id: "f_pinned", condition: "Open seam", pin: { lat: 35.5, lng: -80.5, source: "tech_placed" } },
      { id: "f_unpinned", condition: "Ponding", pin: null }
    ],
    inspectionChecklist: [],
    photos: [
      /* 0 */ { caption: "Seam", finding_id: "f_pinned", gps: { lat: 11.1, lng: -22.2 } },  // finding pin AND gps -> pin wins
      /* 1 */ { caption: "Drain", finding_id: "f_unpinned", gps: { lat: 36.6, lng: -81.6 } }, // no finding pin -> its own GPS
      /* 2 */ { caption: "Overview", finding_id: null, gps: null },                          // global section -> site location
      /* 3 */ { caption: "From CC", finding_id: null, gps: null, ccPhotoId: "cc_999" },      // IMPORTED -> never pushed back
      /* 4 */ { caption: "Already sent", finding_id: null, gps: null, ccFeedPhotoId: "cc_prev" } // already pushed -> skipped
    ]
  };
}
function storeAll(woId, n) {
  for (let i = 0; i < n; i++) storage.add("workorders/" + woId + "/" + i + ".jpg");
}

test("CLIENT: coordinate priority -- finding pin > photo GPS > site location", async () => {
  reset();
  storeAll("wo_1", 5);
  const sb = loadClient({ siteLatLng: { lat: 40.0, lng: -75.0 } });
  const o = fixtureOrder();

  const r = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(r.pushed, 3, "3 pushable photos (the imported one and the already-pushed one are skipped)");

  const coords = photoPosts().map(c => c.body.photo.coordinates);
  assert.deepStrictEqual(coords[0], { lat: 35.5, lon: -80.5 },
    "photo 0 is on a PINNED finding -- the tech-confirmed roof pin must win over the photo's own GPS");
  assert.deepStrictEqual(coords[1], { lat: 36.6, lon: -81.6 },
    "photo 1's finding has no pin -- fall back to the photo's own GPS");
  assert.deepStrictEqual(coords[2], { lat: 40.0, lon: -75.0 },
    "photo 2 is a global 'Photo Documentation' photo with no coordinate -- it pins at the JOB's location");
});

test("CLIENT: a photo's OWN pin outranks everything (forward-compat, priority 1)", async () => {
  reset();
  storeAll("wo_1", 1);
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();
  o.photos = [{ caption: "x", finding_id: "f_pinned", pin: { lat: 1.5, lng: 2.5 }, gps: { lat: 9, lng: 9 } }];
  await sb.pushPhotosToCompanyCamFeed(o);
  assert.deepStrictEqual(photoPosts()[0].body.photo.coordinates, { lat: 1.5, lon: 2.5 });
});

test("CLIENT: imported (ccPhotoId) photos are NEVER pushed back into CompanyCam", async () => {
  reset();
  storeAll("wo_1", 5);
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();
  const r = await sb.pushPhotosToCompanyCamFeed(o);

  assert.strictEqual(r.imported, 1, "the ccPhotoId-bearing photo is counted as imported");
  const descriptions = photoPosts().map(c => c.body.photo.description);
  assert.ok(!descriptions.some(d => /From CC/.test(d)),
    "pushing an imported photo back would duplicate CompanyCam's own photo into its own feed");
});

test("CLIENT: IDEMPOTENCY -- re-sending the same work order pushes NOTHING a second time", async () => {
  reset();
  storeAll("wo_1", 5);
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();

  const first = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(first.pushed, 3);
  assert.strictEqual(photoPosts().length, 3);

  // The push stamped ccFeedPhotoId onto each photo (in memory) AND merge-wrote
  // it to Firestore -- that record is the whole anti-duplicate mechanism.
  assert.ok(o.photos[0].ccFeedPhotoId, "a pushed photo must be stamped with its feed id");
  assert.strictEqual(firestoreWrites.length, 3, "each push is persisted");
  // strictEqual on the property, not deepStrictEqual on the object: this object
  // was created INSIDE the vm context, so its prototype is that realm's
  // Object.prototype and deepStrictEqual would reject it for that reason alone.
  assert.strictEqual(firestoreWrites[0].opts.merge, true,
    "must be a MERGE -- it may not clobber img/storageRef/caption on the photo doc");
  assert.ok(firestoreWrites[0].data.ccFeedPhotoId, "the merge must carry the feed id");

  // Send it again -- exactly what happens when Mark re-sends or re-downloads.
  ccCalls = [];
  const second = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(second.pushed, 0, "re-sending must not re-push");
  assert.strictEqual(second.alreadyPushed, 4, "3 just-pushed + 1 that already had a feed id");
  assert.strictEqual(photoPosts().length, 0, "ZERO duplicate photos in the project feed");
});

test("CLIENT: no linked project -> NO push at all, and no project is ever created", async () => {
  reset();
  storeAll("wo_1", 5);
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();
  delete o.companyCamProjectId;

  const r = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(ccCalls.length, 0, "an unlinked work order must not talk to CompanyCam AT ALL");
  assert.ok(!ccCalls.some(c => c.method === "POST" && /\/v2\/projects$/.test(c.url)),
    "a project must NEVER be auto-created");
});

test("CLIENT: the PDF document push STILL happens, and the photo push rides the same path", async () => {
  reset();
  storeAll("wo_1", 5);
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();
  const fakePdf = { output: () => "data:application/pdf;base64,JVBERi0=" };
  sb.pdfFileName = () => "WorkOrder-1234.pdf";

  const ccUp = await sb.uploadLinkedPdfToCompanyCam(fakePdf, o, "Email sent");

  const docPosts = ccCalls.filter(c => /\/documents$/.test(c.url) && c.method === "POST");
  assert.strictEqual(docPosts.length, 1, "the PDF-as-document push must still happen -- this ADDS to it, it does not replace it");
  assert.strictEqual(docPosts[0].body.document.name, "WorkOrder-1234.pdf");
  assert.strictEqual(ccUp.ok, true, "the PDF result is still what this function reports");
  assert.strictEqual(photoPosts().length, 3, "...and the photos went to the feed on the same action");
  assert.strictEqual(ccUp.photoFeed.pushed, 3);
});

test("CLIENT: a failing photo push never fails the send, and never blocks the other photos", async () => {
  reset();
  storeAll("wo_1", 5);
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();
  nextPhotoPostFails = true;   // CompanyCam rejects EVERY photo this run

  const fakePdf = { output: () => "data:application/pdf;base64,JVBERi0=" };
  sb.pdfFileName = () => "WorkOrder-1234.pdf";
  const ccUp = await sb.uploadLinkedPdfToCompanyCam(fakePdf, o, "Email sent");

  assert.strictEqual(ccUp.ok, true, "the EMAIL/PDF action still succeeded -- a photo failure must not turn it into a failure");
  assert.strictEqual(ccUp.photoFeed.failed, 3, "all three tried, all three failed, none aborted the loop");
  assert.ok(!o.photos[0].ccFeedPhotoId, "a FAILED push must not be marked as pushed -- it has to retry next send");
  assert.strictEqual(firestoreWrites.length, 0, "nothing may be persisted for a failed push");
});

test("CLIENT: a photo that isn't in Storage yet is skipped and left to retry, not lost", async () => {
  reset();
  storage.clear();
  storeAll("wo_1", 1);            // only photo 0 is in Storage
  const sb = loadClient({ siteLatLng: { lat: 40, lng: -75 } });
  const o = fixtureOrder();
  o.photos = o.photos.slice(0, 3); // photos 0,1,2 -- 1 and 2 have no object

  const r = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(r.pushed, 1);
  assert.strictEqual(r.notStored, 2);
  assert.strictEqual(r.failed, 0, "'not uploaded yet' is not a failure -- the next send picks it up");
  assert.ok(!o.photos[1].ccFeedPhotoId, "an unpushed photo must NOT be marked as pushed");
});
