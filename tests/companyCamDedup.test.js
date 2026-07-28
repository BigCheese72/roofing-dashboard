"use strict";
/* Tests for CompanyCam photo-push DE-DUPLICATION -- Mark's design, confirmed:
   compare a candidate against what is ALREADY in the CompanyCam project, using
   capture date/time + GPS, with a SHA-256 content hash as the fallback.

     CONFIG  netlify/functions/lib/companyCamDedupConfig.js  (the one place
             tolerances live)
     ENGINE  netlify/functions/lib/companyCamDedup.js
     WIRING  lib/companyCamPhotos.js + the upload_photo action in companycam.js
     CLIENT  pushPhotosToCompanyCamFeed() / ccPushSummaryLine() in js/history.js
             (loaded from REAL source via vm -- a hand-copied mirror could drift)
     EXIF    parseExifCapturedAt() in js/photos.js (real source, vm-loaded)

   The most important tests in this file are the FALSE-SKIP guards. A false dup
   (an extra upload) is an annoyance; a false skip silently drops field evidence
   off a roof. They are asserted explicitly and by name.

   NOTHING here touches a real CompanyCam project. firebase-admin and global
   fetch are stubbed; every api.companycam.com request is captured and asserted
   against instead of sent -- an unexpected one throws by design.

   Run: npm test */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* ---------------------------------------------------------------- stubs -- */

const VALID = "VALID_CREW_TOKEN";
const SIGNED_URL = "https://storage.googleapis.com/bkt/x.jpg?X-Goog-Signature=deadbeef";

// Storage: object path -> Buffer of "image bytes" (or null = exists but not
// downloadable, which is how the "can't be hashed" path is exercised).
const storage = new Map();
// Firestore: flat path -> document data. Enough to model the ledger's
// collection/doc/collection/doc shape without pulling in a real emulator.
const firestore = new Map();
const firestoreWrites = [];

function fakeDocRef(pathStr) {
  return {
    get: async () => {
      const has = firestore.has(pathStr);
      return { exists: has, data: () => firestore.get(pathStr) };
    },
    set: async (data, opts) => {
      firestoreWrites.push({ path: pathStr, data: data, opts: opts });
      const prev = (opts && opts.merge && firestore.get(pathStr)) || {};
      firestore.set(pathStr, Object.assign({}, prev, data));
    },
    collection: (name) => fakeCollectionRef(pathStr + "/" + name)
  };
}
function fakeCollectionRef(pathStr) {
  return { doc: (id) => fakeDocRef(pathStr + "/" + id) };
}

let signedUrlCalls = 0;

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
          download: async () => {
            const buf = storage.get(p);
            if (!buf) throw new Error("download failed for " + p);
            return [buf];
          },
          getSignedUrl: async () => { signedUrlCalls++; return [SIGNED_URL]; }
        })
      })
    };
  },
  firestore() { return { collection: (name) => fakeCollectionRef(name) }; }
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

// What the fake project already contains. Shape = CompanyCam's /photos payload.
let existingPhotos = [];
let ccCalls = [];
let indexFetchFails = false;

global.fetch = async (url, opts) => {
  opts = opts || {};
  ccCalls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });

  if (/\/v2\/projects\/[^/]+\/photos\?/.test(url) && (opts.method || "GET") === "GET") {
    if (indexFetchFails) return { ok: false, status: 500, text: async () => "boom" };
    const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
    const per = Number(/[?&]per_page=(\d+)/.exec(url)[1]);
    const slice = existingPhotos.slice((page - 1) * per, page * per);
    return { ok: true, status: 200, json: async () => slice, text: async () => JSON.stringify(slice) };
  }
  if (/\/v2\/projects\/[^/]+\/photos$/.test(url) && opts.method === "POST") {
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: "cc_new_" + ccCalls.length }) };
  }
  if (/\/v2\/projects\/[^/]+$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ id: "p1", coordinates: null }), text: async () => "{}" };
  }
  throw new Error("UNEXPECTED CompanyCam call: " + url);
};

const companycam = require("../netlify/functions/companycam.js");
const dedup = require("../netlify/functions/lib/companyCamDedup.js");
const { getDedupConfig, DEFAULTS, ENV_NAMES } = require("../netlify/functions/lib/companyCamDedupConfig.js");

const DEDUP_ENV = Object.keys(ENV_NAMES).map(k => ENV_NAMES[k]);

function reset() {
  ccCalls = [];
  existingPhotos = [];
  indexFetchFails = false;
  signedUrlCalls = 0;
  storage.clear();
  firestore.clear();
  firestoreWrites.length = 0;
  dedup.__clearIndexCache();
  DEDUP_ENV.forEach(name => { delete process.env[name]; });
}
function ev(body, token) {
  return {
    httpMethod: "POST",
    headers: { host: "dev--watkins.netlify.app", authorization: token ? "Bearer " + token : undefined },
    body: JSON.stringify(body),
    queryStringParameters: {}
  };
}
async function upload(body) {
  const r = await companycam.handler(ev(Object.assign({
    action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 0
  }, body), VALID));
  return { status: r.statusCode, out: JSON.parse(r.body) };
}
function photoPosts() { return ccCalls.filter(c => /\/photos$/.test(c.url) && c.method === "POST"); }
function indexFetches() { return ccCalls.filter(c => /\/photos\?/.test(c.url)); }
function putImage(woId, idx, bytes) { storage.set("workorders/" + woId + "/" + idx + ".jpg", Buffer.from(bytes)); }

// A fixed instant everything hangs off, so nothing here depends on wall clock.
const T0 = Date.UTC(2026, 6, 10, 18, 32, 7) / 1000;   // 2026-07-10 18:32:07Z
const SITE = { lat: 35.2271, lon: -80.8431 };          // Charlotte, NC

/* ====================================================== UNITS: timezone == */

test("TIMEZONE: milliseconds, seconds, and zoned ISO all normalize to the same instant", () => {
  const cfg = getDedupConfig();
  assert.strictEqual(dedup.normalizeToEpochSeconds(T0 * 1000, cfg), T0, "epoch ms -> seconds");
  assert.strictEqual(dedup.normalizeToEpochSeconds(T0, cfg), T0, "already seconds -> unchanged");
  assert.strictEqual(dedup.normalizeToEpochSeconds("2026-07-10T18:32:07Z", cfg), T0, "ISO with Z");
  assert.strictEqual(dedup.normalizeToEpochSeconds("2026-07-10T14:32:07-04:00", cfg), T0,
    "ISO with an explicit offset must be shifted to UTC, not read as wall-clock");
  assert.strictEqual(dedup.normalizeToEpochSeconds(String(T0 * 1000), cfg), T0, "numeric string");
});

test("TIMEZONE: a NAIVE EXIF timestamp is refused rather than guessed at", () => {
  const cfg = getDedupConfig();
  assert.strictEqual(dedup.normalizeToEpochSeconds("2026:07:10 14:32:07", cfg), null,
    "no zone and no configured offset -- comparing it would be a guess, and a wrong guess makes every photo read as new");
  const cfgCentral = getDedupConfig({ assumedUtcOffsetMinutes: -240 });
  assert.strictEqual(dedup.normalizeToEpochSeconds("2026:07:10 14:32:07", cfgCentral), T0,
    "with the offset configured, naive local converts to the same UTC instant");
});

test("TIMEZONE: the whole point -- a local-time photo must MATCH its UTC copy in CompanyCam", () => {
  const cfg = getDedupConfig({ assumedUtcOffsetMinutes: -240 });
  // CompanyCam normalized it to unix UTC; the camera wrote naive local.
  const fromCompanyCam = dedup.normalizeToEpochSeconds(T0, cfg);
  const fromExif = dedup.normalizeToEpochSeconds("2026:07:10 14:32:07", cfg);
  const match = dedup.findMetadataMatch(
    { capturedAt: fromExif, coord: SITE },
    [{ id: "cc_1", capturedAt: fromCompanyCam, coord: SITE }], cfg, []);
  assert.ok(match, "if this fails, every photo reads as new and de-duplication silently does nothing");
  assert.strictEqual(match.deltaSeconds, 0);
});

test("garbage and zero timestamps normalize to null, never to 1970", () => {
  const cfg = getDedupConfig();
  [null, undefined, "", 0, -5, "not a date", {}, []].forEach(v => {
    assert.strictEqual(dedup.normalizeToEpochSeconds(v, cfg), null, "rejects " + JSON.stringify(v));
  });
});

/* ===================================================== UNITS: tolerances == */

test("TOLERANCE: the time window is inclusive at the edge and excludes past it", () => {
  const cfg = getDedupConfig();             // default 3s
  const index = [{ id: "cc_1", capturedAt: T0, coord: SITE }];
  const at = (dt) => dedup.findMetadataMatch({ capturedAt: T0 + dt, coord: SITE }, index, cfg, []);
  assert.ok(at(0), "same second matches");
  assert.ok(at(3), "+3s is inside the default window");
  assert.ok(at(-3), "-3s is inside the default window");
  assert.strictEqual(at(4), null, "+4s is outside -- a genuinely different shot must upload");
});

test("TOLERANCE: the distance window is metres, and configurable", () => {
  const cfg = getDedupConfig();             // default 5m
  const index = [{ id: "cc_1", capturedAt: T0, coord: SITE }];
  // ~0.00001 deg latitude = ~1.11 m
  const north = (m) => ({ lat: SITE.lat + (m / 111320), lon: SITE.lon });
  assert.ok(dedup.findMetadataMatch({ capturedAt: T0, coord: north(4) }, index, cfg, []), "4m apart is the same spot");
  assert.strictEqual(dedup.findMetadataMatch({ capturedAt: T0, coord: north(25) }, index, cfg, []), null,
    "25m apart is a different part of the roof");
  const wide = getDedupConfig({ distanceToleranceMeters: 50 });
  assert.ok(dedup.findMetadataMatch({ capturedAt: T0, coord: north(25) }, index, wide, []),
    "the tolerance is a knob, not a constant baked into the matcher");
});

test("TOLERANCE: BOTH time and place must match -- either alone is far too weak", () => {
  const cfg = getDedupConfig();
  const index = [{ id: "cc_1", capturedAt: T0, coord: SITE }];
  assert.strictEqual(dedup.findMetadataMatch({ capturedAt: T0, coord: { lat: 40, lon: -75 } }, index, cfg, []), null,
    "same second, different state");
  assert.strictEqual(dedup.findMetadataMatch({ capturedAt: T0 + 86400, coord: SITE }, index, cfg, []), null,
    "same spot a day later is a RETURN VISIT, not a duplicate");
});

test("an existing photo missing captured_at or coordinates can never produce a match", () => {
  const cfg = getDedupConfig();
  const candidate = { capturedAt: T0, coord: SITE };
  assert.strictEqual(dedup.findMetadataMatch(candidate, [{ id: "a", capturedAt: null, coord: SITE }], cfg, []), null);
  assert.strictEqual(dedup.findMetadataMatch(candidate, [{ id: "b", capturedAt: T0, coord: null }], cfg, []), null);
});

test("haversine is metres, not degrees", () => {
  const d = dedup.haversineMeters({ lat: 35, lon: -80 }, { lat: 35.001, lon: -80 });
  assert.ok(d > 110 && d < 112, "0.001 deg latitude is ~111m, got " + d);
});

test("toLatLon accepts both in-app shapes and rejects Null Island", () => {
  assert.deepStrictEqual(dedup.toLatLon({ lat: 1, lng: 2 }), { lat: 1, lon: 2 }, "RoofOps speaks lng");
  assert.deepStrictEqual(dedup.toLatLon({ lat: 1, lon: 2 }), { lat: 1, lon: 2 }, "CompanyCam speaks lon");
  assert.strictEqual(dedup.toLatLon({ lat: 0, lon: 0 }), null, "0,0 is what a broken coordinate looks like here");
  assert.strictEqual(dedup.toLatLon({ lat: 91, lon: 0 }), null);
  assert.strictEqual(dedup.toLatLon(null), null);
});

/* ========================================================= UNITS: config == */

test("CONFIG: one place for the knobs, and the environment overrides it", () => {
  reset();
  assert.strictEqual(DEFAULTS.timeToleranceSeconds, 3, "Mark's default: ~3 seconds");
  assert.strictEqual(DEFAULTS.distanceToleranceMeters, 5, "Mark's default: ~5 metres");
  process.env.CC_DEDUP_TIME_TOLERANCE_SECONDS = "10";
  process.env.CC_DEDUP_DISTANCE_TOLERANCE_METERS = "25";
  process.env.CC_DEDUP_ENABLED = "false";
  const cfg = getDedupConfig();
  assert.strictEqual(cfg.timeToleranceSeconds, 10);
  assert.strictEqual(cfg.distanceToleranceMeters, 25);
  assert.strictEqual(cfg.enabled, false);
  reset();
});

test("CONFIG: an out-of-range or garbage env value falls back to the default and SAYS SO", () => {
  reset();
  process.env.CC_DEDUP_TIME_TOLERANCE_SECONDS = "99999";   // would merge a whole day of photos
  process.env.CC_DEDUP_DISTANCE_TOLERANCE_METERS = "banana";
  const cfg = getDedupConfig();
  assert.strictEqual(cfg.timeToleranceSeconds, DEFAULTS.timeToleranceSeconds,
    "a typo'd tolerance must not be able to turn de-duplication into a photo shredder");
  assert.strictEqual(cfg.distanceToleranceMeters, DEFAULTS.distanceToleranceMeters);
  assert.strictEqual(cfg.warnings.length, 2, "both bad values are reported, not swallowed");
  reset();
});

/* ================================================== SERVER: the live match = */

test("SERVER PRIMARY: a photo already in the project (time + GPS) is SKIPPED, nothing is uploaded", async () => {
  reset();
  putImage("wo_1", 0, "roof-photo-bytes");
  existingPhotos = [{ id: "cc_existing", captured_at: T0, coordinates: { lat: SITE.lat, lon: SITE.lon } }];

  const { status, out } = await upload({
    dedupCapturedAt: (T0 + 1) * 1000,                       // 1s off -- inside tolerance
    dedupCoordinates: { lat: SITE.lat, lon: SITE.lon },
    runKey: "run_a"
  });

  assert.strictEqual(status, 200, "a duplicate is a successful outcome, not an error");
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(out.reason, "matched_time_gps");
  assert.strictEqual(out.matchedPhotoId, "cc_existing");
  assert.strictEqual(out.dedup.detail.deltaSeconds, 1);
  assert.strictEqual(photoPosts().length, 0, "NOTHING may be uploaded for a duplicate");
  assert.strictEqual(signedUrlCalls, 0, "and we must not even mint a signed URL for one");
});

test("SERVER PRIMARY: an unmatched photo uploads normally", async () => {
  reset();
  putImage("wo_1", 0, "new-photo-bytes");
  existingPhotos = [{ id: "cc_existing", captured_at: T0, coordinates: { lat: SITE.lat, lon: SITE.lon } }];

  const { out } = await upload({
    dedupCapturedAt: (T0 + 600) * 1000,                     // ten minutes later
    dedupCoordinates: { lat: SITE.lat, lon: SITE.lon },
    coordinates: { lat: SITE.lat, lon: SITE.lon },
    captured_at: (T0 + 600) * 1000,
    runKey: "run_b"
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(photoPosts().length, 1);
  assert.strictEqual(photoPosts()[0].body.photo.captured_at, T0 + 600, "captured_at still normalizes to unix seconds");
});

test("SERVER: excludeCcPhotoIds stops a photo being judged a duplicate of one WE just uploaded", async () => {
  reset();
  putImage("wo_1", 1, "second-photo-bytes");
  // The index now contains the photo this same run created two seconds ago.
  existingPhotos = [{ id: "cc_ours_just_now", captured_at: T0, coordinates: { lat: SITE.lat, lon: SITE.lon } }];

  const dup = await upload({
    photoIndex: 1, dedupCapturedAt: (T0 + 1) * 1000,
    dedupCoordinates: { lat: SITE.lat, lon: SITE.lon }, runKey: "run_c1"
  });
  assert.strictEqual(dup.out.duplicate, true, "control: it WOULD match without the exclusion");

  reset();
  putImage("wo_1", 1, "second-photo-bytes");
  existingPhotos = [{ id: "cc_ours_just_now", captured_at: T0, coordinates: { lat: SITE.lat, lon: SITE.lon } }];
  const kept = await upload({
    photoIndex: 1, dedupCapturedAt: (T0 + 1) * 1000,
    dedupCoordinates: { lat: SITE.lat, lon: SITE.lon },
    excludeCcPhotoIds: ["cc_ours_just_now"], runKey: "run_c2"
  });
  assert.strictEqual(kept.out.ok, true, "FALSE-SKIP GUARD: a burst of shots must not eat itself");
  assert.strictEqual(photoPosts().length, 1);
});

test("SERVER: one project-index fetch is shared across a run, not refetched per photo", async () => {
  reset();
  existingPhotos = [];
  for (let i = 0; i < 4; i++) {
    putImage("wo_1", i, "bytes-" + i);
    await upload({ photoIndex: i, dedupCapturedAt: (T0 + i * 60) * 1000, dedupCoordinates: SITE, runKey: "run_shared" });
  }
  assert.strictEqual(photoPosts().length, 4, "all four are genuinely new and upload");
  assert.strictEqual(indexFetches().length, 1, "the index snapshot is taken once per run, not four times");
});

test("INDEX: a huge project is truncated by page count, and says so", async () => {
  reset();
  existingPhotos = [];
  for (let i = 0; i < 500; i++) existingPhotos.push({ id: "cc_" + i, captured_at: T0 - i, coordinates: SITE });
  const cfg = getDedupConfig({ indexPerPage: 100, indexMaxPages: 2 });
  const idx = await dedup.fetchProjectPhotoIndex("p1", "tok", cfg);
  assert.strictEqual(idx.photos.length, 200, "stops at the page ceiling");
  assert.strictEqual(idx.truncated, true, "and reports that it did, rather than quietly under-matching");
});

test("INDEX: the wall-clock budget stops the scan before the function times out", async () => {
  reset();
  existingPhotos = [];
  for (let i = 0; i < 2000; i++) existingPhotos.push({ id: "cc_" + i, captured_at: T0 - i, coordinates: SITE });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    await new Promise(res => setTimeout(res, 120));   // a slow page
    return realFetch(url, opts);
  };
  try {
    const cfg = getDedupConfig({ indexPerPage: 100, indexMaxPages: 20, indexMaxMillis: 500 });
    const started = Date.now();
    const idx = await dedup.fetchProjectPhotoIndex("p1", "tok", cfg);
    const took = Date.now() - started;
    assert.ok(took < 2000, "the scan must respect its budget, not walk 20 pages (took " + took + "ms)");
    assert.strictEqual(idx.truncated, true);
    assert.ok(idx.photos.length > 0 && idx.photos.length < 2000, "a partial index is still useful");
  } finally {
    global.fetch = realFetch;
  }
});

/* ================================================ SERVER: the hash fallback = */

test("SERVER FALLBACK: no EXIF time and no GPS -> hashed; a hash already in the ledger is SKIPPED", async () => {
  reset();
  const bytes = "identical-stripped-photo";
  putImage("wo_1", 0, bytes);
  const hash = crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

  // First push: nothing known, so it uploads and records the hash.
  const first = await upload({ dedupCapturedAt: null, dedupCoordinates: null, runKey: "run_h1" });
  assert.strictEqual(first.out.ok, true);
  assert.strictEqual(indexFetches().length, 0, "no per-photo metadata -> the live match is not even attempted");
  assert.ok(firestore.has("cc_push_ledger/p1/entries/" + hash), "the push must be recorded in the per-project ledger");
  assert.strictEqual(firestore.get("cc_push_ledger/p1/entries/" + hash).workOrderId, "wo_1");

  // Second push of the SAME bytes from a DIFFERENT work order -- the case
  // ccFeedPhotoId could never see.
  ccCalls = [];
  putImage("wo_2", 3, bytes);
  const second = await upload({
    workOrderId: "wo_2", photoIndex: 3, dedupCapturedAt: null, dedupCoordinates: null, runKey: "run_h2"
  });
  assert.strictEqual(second.out.duplicate, true);
  assert.strictEqual(second.out.reason, "matched_hash");
  assert.strictEqual(photoPosts().length, 0, "the same bytes must not reach the same project twice");
});

test("SERVER FALLBACK: different bytes hash differently and both upload", async () => {
  reset();
  putImage("wo_1", 0, "photo-A");
  await upload({ photoIndex: 0, dedupCapturedAt: null, dedupCoordinates: null, runKey: "run_d" });
  putImage("wo_1", 1, "photo-B");
  const second = await upload({ photoIndex: 1, dedupCapturedAt: null, dedupCoordinates: null, runKey: "run_d" });
  assert.strictEqual(second.out.ok, true);
  assert.strictEqual(photoPosts().length, 2);
});

test("SERVER: alwaysHash catches a RoofOps duplicate the time+GPS match structurally cannot see", async () => {
  reset();
  // The photo's CompanyCam copy was pinned at a FINDING PIN, not at the photo's
  // own GPS -- so the primary check looks in the wrong place and finds nothing.
  const bytes = "pinned-photo-bytes";
  putImage("wo_1", 0, bytes);
  await upload({
    dedupCapturedAt: T0 * 1000, dedupCoordinates: SITE,
    coordinates: { lat: 35.9, lon: -81.9 }, runKey: "run_p1"
  });
  assert.strictEqual(photoPosts().length, 1, "first push happens");

  ccCalls = [];
  existingPhotos = [{ id: "cc_pinned", captured_at: T0, coordinates: { lat: 35.9, lon: -81.9 } }];
  putImage("wo_9", 0, bytes);
  const again = await upload({ workOrderId: "wo_9", dedupCapturedAt: T0 * 1000, dedupCoordinates: SITE, runKey: "run_p2" });
  assert.strictEqual(again.out.duplicate, true);
  assert.strictEqual(again.out.reason, "matched_hash",
    "the primary check misses (wrong coordinate); the content hash is what saves it");
});

test("SERVER: CC_DEDUP_ALWAYS_HASH=false skips hashing once the live match has decided", async () => {
  reset();
  process.env.CC_DEDUP_ALWAYS_HASH = "false";
  putImage("wo_1", 0, "bytes");
  existingPhotos = [{ id: "cc_other", captured_at: T0 - 5000, coordinates: SITE }];
  const { out } = await upload({ dedupCapturedAt: T0 * 1000, dedupCoordinates: SITE, runKey: "run_nh" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dedup.checks.meta, "no_match");
  assert.strictEqual(out.dedup.checks.hash, "not_needed");
  assert.strictEqual(out.dedup.hash, null, "no hash computed, so no Storage read");
  assert.strictEqual(firestoreWrites.filter(w => /cc_push_ledger/.test(w.path)).length, 0);
  reset();
});

/* ============================================== SERVER: fail-open behaviour = */

test("MISSING METADATA + UNHASHABLE: the photo is UPLOADED and FLAGGED, never dropped", async () => {
  reset();
  storage.set("workorders/wo_1/0.jpg", null);     // exists, but download throws
  const { out } = await upload({ dedupCapturedAt: null, dedupCoordinates: null, runKey: "run_u" });

  assert.strictEqual(out.ok, true, "Mark's rule: if it can't be checked, UPLOAD -- don't silently drop it");
  assert.strictEqual(photoPosts().length, 1);
  assert.strictEqual(out.dedup.unverified, true, "and flag it, so the summary can say it wasn't verified");
  assert.strictEqual(out.dedup.checks.hash, "unavailable");
  assert.ok(out.dedup.detail.hashError, "the reason is carried, not swallowed");
});

test("a failed project-index fetch uploads and flags -- it never blocks the push", async () => {
  reset();
  putImage("wo_1", 0, "bytes");
  indexFetchFails = true;
  const { out } = await upload({ dedupCapturedAt: T0 * 1000, dedupCoordinates: SITE, runKey: "run_e" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dedup.checks.meta, "index_error");
  assert.strictEqual(out.dedup.unverified, true);
  assert.strictEqual(photoPosts().length, 1);
});

test("CC_DEDUP_ENABLED=false restores the exact previous behaviour", async () => {
  reset();
  process.env.CC_DEDUP_ENABLED = "false";
  putImage("wo_1", 0, "bytes");
  existingPhotos = [{ id: "cc_existing", captured_at: T0, coordinates: SITE }];
  const { out } = await upload({ dedupCapturedAt: T0 * 1000, dedupCoordinates: SITE, runKey: "run_off" });
  assert.strictEqual(out.ok, true, "the kill switch must fully disable the feature");
  assert.strictEqual(indexFetches().length, 0);
  assert.strictEqual(photoPosts().length, 1);
  reset();
});

test("the auth guard is NOT weakened -- upload_photo still 401s without a token", async () => {
  reset();
  putImage("wo_1", 0, "bytes");
  const r = await companycam.handler(ev({ action: "upload_photo", project_id: "p1", workOrderId: "wo_1", photoIndex: 0 }, null));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(ccCalls.length, 0, "an unauthenticated caller must not reach CompanyCam at all");
});

/* ======================================================= CLIENT: the push == */

function loadClient() {
  const noop = function () {};
  const stubEl = () => ({
    style: {}, classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [], setAttribute: noop,
    getAttribute: () => null, children: [], value: "", textContent: "", innerHTML: ""
  });
  const toasts = [];
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a), warn: noop, error: noop },
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
  sandbox.toast = (m) => toasts.push(String(m));
  sandbox.ccApiPost = async (body) => {
    const r = await companycam.handler(ev(body, VALID));
    const out = JSON.parse(r.body);
    if (r.statusCode >= 400 || !out) throw new Error((out && out.error) || ("server error " + r.statusCode));
    return out;
  };
  sandbox.geocodeAddress = async () => null;
  sandbox.fdb = {
    collection: () => ({
      doc: (woId) => ({
        get: async () => ({ exists: false }),
        collection: () => ({ doc: (pid) => ({ set: async (data) => { firestoreWrites.push({ woId, pid, data }); } }) })
      })
    })
  };
  sandbox.__toasts = toasts;
  sandbox.__logs = logs;
  return sandbox;
}

test("CLIENT FALSE-SKIP GUARD: photos with NO own metadata all upload -- none is a duplicate of photo 0", async () => {
  reset();
  // The historical shape this feature had to be safe for: no photo GPS, no EXIF
  // time, so every photo shares the work order's service date and the job's
  // location. A naive time+GPS match would upload photo 0 and eat 1..4.
  const sb = loadClient();
  const o = {
    id: "wo_1", jobNo: "1234", jobName: "Tri-Delta", location: "100 Main St",
    serviceDate: "2026-07-10", companyCamProjectId: "p1", findings: [], inspectionChecklist: [],
    photos: [0, 1, 2, 3, 4].map(i => ({ caption: "photo " + i, finding_id: null, gps: null }))
  };
  for (let i = 0; i < 5; i++) putImage("wo_1", i, "distinct-bytes-" + i);

  const r = await sb.pushPhotosToCompanyCamFeed(o);

  assert.strictEqual(r.pushed, 5, "ALL FIVE must upload -- this is the failure mode that loses field evidence");
  assert.strictEqual(r.duplicate, 0);
  assert.strictEqual(indexFetches().length, 0, "with no per-photo metadata the live match is never attempted");
});

test("CLIENT: identical shared metadata is NEVER sent as dedup identity", async () => {
  reset();
  const sb = loadClient();
  const o = {
    id: "wo_1", jobNo: "1", jobName: "J", location: "100 Main St", serviceDate: "2026-07-10",
    companyCamProjectId: "p1",
    findings: [{ id: "f1", condition: "Seam", pin: { lat: 35.5, lng: -80.5, source: "tech_placed" } }],
    inspectionChecklist: [],
    photos: [
      { caption: "a", finding_id: "f1", gps: null },
      { caption: "b", finding_id: "f1", gps: null }
    ]
  };
  putImage("wo_1", 0, "a"); putImage("wo_1", 1, "b");
  await sb.pushPhotosToCompanyCamFeed(o);

  const sent = photoPosts();
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[0].body.photo.coordinates, { lat: 35.5, lon: -80.5 },
    "the FEED still gets the finding pin -- unchanged behaviour");
  // The dedup fields travel in the request body to the function, not to CompanyCam.
  const calls = ccCalls.filter(c => /\/photos$/.test(c.url));
  assert.ok(calls.length === 2, "both photos reached CompanyCam -- the shared pin did not make one a duplicate");
});

test("CLIENT: a real per-photo capture time flows through to captured_at AND to the dedup check", async () => {
  reset();
  const sb = loadClient();
  existingPhotos = [{ id: "cc_theirs", captured_at: T0, coordinates: { lat: SITE.lat, lon: SITE.lon } }];
  const o = {
    id: "wo_1", jobNo: "1", jobName: "J", location: "100 Main St", serviceDate: "2026-07-10",
    companyCamProjectId: "p1", findings: [], inspectionChecklist: [],
    photos: [
      // The tech also uploaded this one to CompanyCam straight from their phone.
      { caption: "dup", finding_id: null, gps: { lat: SITE.lat, lng: SITE.lon }, capturedAt: (T0 + 2) * 1000, capturedAtSource: "exif" },
      // A different shot, twenty minutes later.
      { caption: "new", finding_id: null, gps: { lat: SITE.lat, lng: SITE.lon }, capturedAt: (T0 + 1200) * 1000, capturedAtSource: "exif" }
    ]
  };
  putImage("wo_1", 0, "dup-bytes"); putImage("wo_1", 1, "new-bytes");

  const r = await sb.pushPhotosToCompanyCamFeed(o);

  assert.strictEqual(r.duplicate, 1, "the photo already in CompanyCam is skipped");
  assert.strictEqual(r.dupByMeta, 1);
  assert.strictEqual(r.dupByHash, 0);
  assert.strictEqual(r.pushed, 1, "the genuinely new photo still uploads");
  assert.strictEqual(photoPosts().length, 1);
  assert.strictEqual(photoPosts()[0].body.photo.captured_at, T0 + 1200,
    "captured_at is now the photo's OWN time, not the work order's service date at noon");

  // The audit trail Mark asked for.
  assert.strictEqual(r.dedupLog.length, 1);
  assert.strictEqual(r.dedupLog[0].action, "skipped_duplicate");
  assert.strictEqual(r.dedupLog[0].reason, "matched capture time + GPS");
  assert.strictEqual(r.dedupLog[0].matchedPhotoId, "cc_theirs");
  assert.strictEqual(r.dedupLog[0].deltaSeconds, 2);
});

test("CLIENT SAFETY: a duplicate match records ccDuplicateOfPhotoId, NEVER ccFeedPhotoId", async () => {
  reset();
  const sb = loadClient();
  existingPhotos = [{ id: "cc_tech_took_this_in_companycam", captured_at: T0, coordinates: { lat: SITE.lat, lon: SITE.lon } }];
  const o = {
    id: "wo_1", jobNo: "1", jobName: "J", location: "x", serviceDate: "2026-07-10",
    companyCamProjectId: "p1", findings: [], inspectionChecklist: [],
    photos: [{ caption: "dup", finding_id: null, gps: { lat: SITE.lat, lng: SITE.lon }, capturedAt: T0 * 1000 }]
  };
  putImage("wo_1", 0, "bytes");
  await sb.pushPhotosToCompanyCamFeed(o);

  assert.strictEqual(o.photos[0].ccDuplicateOfPhotoId, "cc_tech_took_this_in_companycam");
  assert.ok(!o.photos[0].ccFeedPhotoId,
    "ccFeedPhotoId is the id the undo-push DELETES -- stamping a matched photo with it would let RoofOps delete a photo the tech took themselves");
});

test("CLIENT: a known duplicate is not re-checked on the next send", async () => {
  reset();
  const sb = loadClient();
  const o = {
    id: "wo_1", jobNo: "1", jobName: "J", location: "x", serviceDate: "2026-07-10",
    companyCamProjectId: "p1", findings: [], inspectionChecklist: [],
    photos: [{ caption: "known", finding_id: null, gps: null, ccDuplicateOfPhotoId: "cc_known" }]
  };
  putImage("wo_1", 0, "bytes");
  const r = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(r.alreadyDuplicate, 1);
  assert.strictEqual(r.pushed, 0);
  assert.strictEqual(ccCalls.length, 0, "no CompanyCam traffic at all for a photo we already know about");
});

test("CLIENT SUMMARY: the push reports N uploaded / M skipped WITH the reason", async () => {
  reset();
  const sb = loadClient();
  const line = sb.ccPushSummaryLine({
    pushed: 7, duplicate: 3, dupByMeta: 2, dupByHash: 1,
    alreadyPushed: 1, imported: 0, notStored: 0, unverified: 1, failed: 0, alreadyDuplicate: 0
  });
  assert.match(line, /7 uploaded/);
  assert.match(line, /3 skipped as duplicates/);
  assert.match(line, /2 matched capture time \+ GPS/);
  assert.match(line, /1 matched content hash/);
  assert.match(line, /1 already in the feed/);
  assert.match(line, /1 uploaded without a duplicate check/);
});

test("CLIENT SUMMARY: the audit line is logged for every push, not just interesting ones", async () => {
  reset();
  const sb = loadClient();
  const o = {
    id: "wo_1", jobNo: "1", jobName: "J", location: "x", serviceDate: "2026-07-10",
    companyCamProjectId: "p1", findings: [], inspectionChecklist: [],
    photos: [{ caption: "a", finding_id: null, gps: null }]
  };
  putImage("wo_1", 0, "bytes");
  await sb.pushPhotosToCompanyCamFeed(o);
  const summary = sb.__logs.map(a => String(a[0])).filter(s => /\[CompanyCam push\] \d+ uploaded/.test(s));
  assert.strictEqual(summary.length, 1, "one auditable summary line per push");
});

test("CLIENT: an unverified upload is surfaced to the user, not hidden", async () => {
  reset();
  const sb = loadClient();
  storage.set("workorders/wo_1/0.jpg", null);   // exists but unhashable
  const o = {
    id: "wo_1", jobNo: "1", jobName: "J", location: "x", serviceDate: "2026-07-10",
    companyCamProjectId: "p1", findings: [], inspectionChecklist: [],
    photos: [{ caption: "a", finding_id: null, gps: null }]
  };
  const r = await sb.pushPhotosToCompanyCamFeed(o);
  assert.strictEqual(r.pushed, 1);
  assert.strictEqual(r.unverified, 1);
  assert.strictEqual(r.dedupLog[0].action, "uploaded_unchecked");
  assert.ok(r.dedupLog[0].note, "the reason it couldn't be checked is carried into the log");
});

/* ================================================= CLIENT: EXIF capture time */

// Minimal big-endian EXIF JPEG carrying DateTimeOriginal (and optionally
// OffsetTimeOriginal), built the same way exifGpsAndCcName.test.js builds its
// GPS fixture.
function buildExifTimeJpeg(stamp, offset) {
  const size = 256;
  const tiff = new Uint8Array(size);
  const dv = new DataView(tiff.buffer);
  const be = false;                                   // DataView default = big-endian
  dv.setUint16(0, 0x4D4D, be); dv.setUint16(2, 0x002A, be); dv.setUint32(4, 8, be);
  dv.setUint16(8, 1, be);                             // IFD0: 1 entry
  dv.setUint16(10, 0x8769, be); dv.setUint16(12, 4, be); dv.setUint32(14, 1, be); dv.setUint32(18, 26, be); // Exif SubIFD -> 26
  dv.setUint32(22, 0, be);
  const entries = offset ? 2 : 1;
  dv.setUint16(26, entries, be);
  // DateTimeOriginal (0x9003), ASCII, 20 bytes, at 100
  dv.setUint16(28, 0x9003, be); dv.setUint16(30, 2, be); dv.setUint32(32, 20, be); dv.setUint32(36, 100, be);
  let next = 40;
  if (offset) {
    // OffsetTimeOriginal (0x9011), ASCII, 7 bytes, at 140
    dv.setUint16(40, 0x9011, be); dv.setUint16(42, 2, be); dv.setUint32(44, 7, be); dv.setUint32(48, 140, be);
    next = 52;
  }
  dv.setUint32(next, 0, be);                          // next IFD = 0
  for (let i = 0; i < stamp.length; i++) tiff[100 + i] = stamp.charCodeAt(i);
  tiff[100 + stamp.length] = 0;
  if (offset) {
    for (let i = 0; i < offset.length; i++) tiff[140 + i] = offset.charCodeAt(i);
    tiff[140 + offset.length] = 0;
  }
  const head = [0xFF, 0xD8, 0xFF, 0xE1, (size + 8) >> 8, (size + 8) & 0xFF, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const out = new Uint8Array(head.length + size + 2);
  out.set(head, 0); out.set(tiff, head.length); out.set([0xFF, 0xD9], head.length + size);
  return out;
}

function loadExifBlock() {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
  const a = src.indexOf("function rmExifGpsFromTiff");
  const b = src.indexOf("function addPhotosFromFiles", a);
  assert.notStrictEqual(a, -1); assert.notStrictEqual(b, -1);
  const ctx = { DataView, Uint8Array, isFinite, String, Number, Math, Date, RegExp };
  vm.runInNewContext(src.slice(a, b), ctx);
  return ctx;
}

test("EXIF: DateTimeOriginal with an explicit offset resolves to the right UTC instant", () => {
  const exif = loadExifBlock();
  const jpeg = buildExifTimeJpeg("2026:07:10 14:32:07", "-04:00");
  assert.strictEqual(exif.parseExifCapturedAt(jpeg.buffer), T0 * 1000,
    "the camera told us the zone -- use it, don't assume the device's");
});

test("EXIF: DateTimeOriginal with NO offset is read in the DEVICE's timezone", () => {
  const exif = loadExifBlock();
  const jpeg = buildExifTimeJpeg("2026:07:10 14:32:07", null);
  const expected = new Date(2026, 6, 10, 14, 32, 7).getTime();
  assert.strictEqual(exif.parseExifCapturedAt(jpeg.buffer), expected,
    "naive local -> the zone of the phone holding the photo, which is the zone it was taken in");
});

test("EXIF: a blank/implausible timestamp is rejected rather than carried as a lie", () => {
  const exif = loadExifBlock();
  assert.strictEqual(exif.parseExifCapturedAt(buildExifTimeJpeg("0000:00:00 00:00:00", null).buffer), null);
  assert.strictEqual(exif.parseExifCapturedAt(buildExifTimeJpeg("1970:01:01 00:00:00", null).buffer), null,
    "before 1990 is a dead clock, not a capture time");
  assert.strictEqual(exif.parseExifCapturedAt(new Uint8Array([1, 2, 3, 4]).buffer), null, "not a JPEG");
  assert.strictEqual(exif.parseExifCapturedAt(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]).buffer), null, "JPEG with no APP1");
});

test("EXIF: the GPS parser still works -- the capture-time addition did not disturb it", () => {
  const exif = loadExifBlock();
  assert.strictEqual(typeof exif.parseExifGps, "function");
  assert.strictEqual(exif.parseExifGps(new Uint8Array([1, 2, 3, 4]).buffer), null);
});
