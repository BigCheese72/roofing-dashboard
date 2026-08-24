// Photo storage — the ONLY place in the app allowed to touch Firebase
// Storage, using the Firebase Admin SDK (service-account credentials, not
// subject to Storage security rules at all).
//
// WHY THIS EXISTS (see "Photo storage migration" in DEV_NOTES.md): Storage
// security rules are deny-all — that's correct and must stay that way (an
// open bucket would make every customer's roof photos world-readable to
// anyone who guessed a URL). The client must NEVER be given direct Storage
// access — instead it calls this function, which does the real read/write
// server-side and returns only what's needed (a storage reference to save
// in Firestore, or the actual image bytes to display/embed). The bucket
// itself stays completely sealed to the browser.
//
// AUTHENTICATION (2026-07-13): every action here is now gated on a VERIFIED
// Firebase ID token. Until today this function was a trusted proxy with NO
// gate at all -- the header comment used to justify that with "the app has
// no user auth yet," which went stale the moment Firebase Auth shipped, and
// the guard was never added. The practical effect was that anyone on the
// internet, with no token, could upload into the bucket, read any work
// order's photos, and DELETE a photo given only a workOrderId + index.
//
// The gate is AUTHENTICATION, not permission: any signed-in Watkins user
// passes. This is deliberate and load-bearing -- techs must keep FULL
// ability to view, upload, and delete photos on their own work orders (they
// need to be able to fix their own mistakes in the field), so this must NOT
// become a role/permission check. verifyCaller() is exactly that primitive:
// it proves WHO you are and throws 401 if you're nobody, without asking
// what you're allowed to do. requirePermission() is the role-gate and is
// deliberately NOT used here.
//
// The migrate_*/thumbnail actions stay additionally owner-gated below --
// authentication is the floor for every action, not the ceiling for those.
const { getAdmin, verifyCaller, hostnameFromEvent } = require("./lib/authGuard");

// workOrderId shapes seen in real data: "wo_1783782867489" (Date.now()-based,
// see genId()/collect() in index.html) and legacy/manual ids -- alphanumeric
// plus underscore/hyphen covers every real id this app generates, and
// rejecting anything else is what actually prevents a crafted workOrderId
// from being used to write/read OUTSIDE the workorders/ prefix below.
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// No bucket name passed here -- getAdmin() (authGuard.js) configures the
// correct default bucket for whichever project FIREBASE_SERVICE_ACCOUNT
// belongs to at admin.initializeApp() time (Firebase split, 2026-07-11:
// production/dev now resolve to genuinely separate projects, not just
// separate credentials against one shared project).
function getBucket() {
  return getAdmin().storage().bucket();
}
function getDb() {
  return getAdmin().firestore();
}

// The client never sends a raw path -- only a workOrderId + photoIndex, both
// validated, and the path is always built here server-side. This is what
// makes path-injection structurally impossible rather than just filtered.
function storagePathFor(workOrderId, photoIndex) {
  return "workorders/" + workOrderId + "/" + photoIndex + ".jpg";
}

function validateWorkOrderId(v) {
  return typeof v === "string" && SAFE_ID.test(v);
}
function validatePhotoIndex(v) {
  return Number.isInteger(v) && v >= 0 && v < 10000;
}

// Accepts "data:image/jpeg;base64,AAAA..." (what every photo capture path
// in the client already produces via canvas.toDataURL("image/jpeg", q) --
// see photoPreset()/addPhotosFromCamera() in js/photos.js) -- returns the
// raw Buffer, or null if the shape doesn't match at all.
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try { return Buffer.from(m[2], "base64"); }
  catch (e) { return null; }
}

// Fail-closed authentication gate. Runs before the body is even parsed, so
// no action branch, no validation message, and no config/env read is
// reachable without a verified identity.
//
// Deliberately leaks NOTHING to an unauthenticated caller: a flat
// "Unauthorized" regardless of whether the token was missing, malformed,
// expired, or revoked, and never an echo of an internal error message. The
// real reason goes to console.error (Netlify function logs, visible to Mark,
// not to the internet).
//
// An infrastructure failure (missing FIREBASE_SERVICE_ACCOUNT, or the
// authGuard cross-project safety guard tripping) can't verify anybody, so it
// returns 503 and NOT a pass -- a misconfigured deploy is a closed door, not
// an open one. This is the same ordering discipline as the outlook.js fix:
// the endpoint must never depend on being correctly configured in order to
// be safe.
async function requireAuth(event) {
  try {
    return { caller: await verifyCaller(event) };
  } catch (e) {
    if (e && e.statusCode === 401) {
      return { errorResponse: resp(401, { error: "Unauthorized" }) };
    }
    console.error("photos.js auth infrastructure failure:", e && e.message ? e.message : e);
    return { errorResponse: resp(503, { error: "Service unavailable" }) };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }

  // ---- AUTHENTICATION: every action, before anything else. ----
  // verifyCaller() also primes the Admin SDK singleton with this request's
  // hostname (it calls getAuth(hostnameFromEvent(event)) internally), so the
  // cross-project safety guard in lib/authGuard.js is armed on a cold
  // container by this call, exactly as it is for send-workorder.js.
  const gate = await requireAuth(event);
  if (gate.errorResponse) return gate.errorResponse;
  const caller = gate.caller;

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  try {
    // Belt-and-braces prime of the Admin SDK singleton (a no-op after
    // requireAuth above, since admin.apps.length caches init for the
    // process's lifetime) -- kept so this handler still matches the
    // priming convention every other function file follows.
    getAdmin(hostnameFromEvent(event));

    if (body.action === "upload") {
      const workOrderId = body.workOrderId;
      const photoIndex = body.photoIndex;
      if (!validateWorkOrderId(workOrderId)) return resp(400, { error: "Invalid workOrderId" });
      if (!validatePhotoIndex(photoIndex)) return resp(400, { error: "Invalid photoIndex" });
      const buf = decodeDataUrl(body.dataUrl);
      if (!buf) return resp(400, { error: "dataUrl must be a base64 data:image/jpeg or data:image/png URI" });
      // A real photo, compressed, is comfortably under this -- this is a
      // sanity ceiling against a malformed/malicious payload, not a normal
      // operating limit (Netlify's own function payload cap is ~6MB and
      // would reject anything near that well before this does).
      if (buf.length > 15 * 1024 * 1024) return resp(400, { error: "Photo too large" });

      const path = storagePathFor(workOrderId, photoIndex);
      const file = getBucket().file(path);
      await file.save(buf, { contentType: "image/jpeg", resumable: false });
      return resp(200, { ok: true, storageRef: path });
    }

    if (body.action === "get") {
      const workOrderId = body.workOrderId;
      const photoIndex = body.photoIndex;
      if (!validateWorkOrderId(workOrderId)) return resp(400, { error: "Invalid workOrderId" });
      if (!validatePhotoIndex(photoIndex)) return resp(400, { error: "Invalid photoIndex" });
      const path = storagePathFor(workOrderId, photoIndex);
      const file = getBucket().file(path);
      const [exists] = await file.exists();
      if (!exists) return resp(404, { ok: false, error: "Photo not found in storage" });
      const [buf] = await file.download();
      return resp(200, { ok: true, dataUrl: "data:image/jpeg;base64," + buf.toString("base64") });
    }

    // Batch retrieval -- PDF generation / a photo gallery often need several
    // photos at once; one round-trip per photo would be needlessly slow.
    // Same validation as "get", just over an array; a single bad entry is
    // skipped (reported in `errors`) rather than failing the whole batch,
    // so one corrupt reference doesn't block every other photo from loading.
    if (body.action === "get_batch") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return resp(400, { error: "items must be a non-empty array" });
      if (items.length > 60) return resp(400, { error: "Too many items in one batch (max 60)" });
      const results = [];
      const errors = [];
      await Promise.all(items.map(async function (item, idx) {
        if (!validateWorkOrderId(item.workOrderId) || !validatePhotoIndex(item.photoIndex)) {
          errors.push({ idx: idx, error: "Invalid workOrderId/photoIndex" });
          return;
        }
        const path = storagePathFor(item.workOrderId, item.photoIndex);
        try {
          const file = getBucket().file(path);
          const [exists] = await file.exists();
          if (!exists) { errors.push({ idx: idx, workOrderId: item.workOrderId, photoIndex: item.photoIndex, error: "not found" }); return; }
          const [buf] = await file.download();
          results.push({ idx: idx, workOrderId: item.workOrderId, photoIndex: item.photoIndex, dataUrl: "data:image/jpeg;base64," + buf.toString("base64") });
        } catch (e) {
          errors.push({ idx: idx, workOrderId: item.workOrderId, photoIndex: item.photoIndex, error: e.message });
        }
      }));
      return resp(200, { ok: true, results: results, errors: errors });
    }

    if (body.action === "delete") {
      const workOrderId = body.workOrderId;
      const photoIndex = body.photoIndex;
      if (!validateWorkOrderId(workOrderId)) return resp(400, { error: "Invalid workOrderId" });
      if (!validatePhotoIndex(photoIndex)) return resp(400, { error: "Invalid photoIndex" });
      const path = storagePathFor(workOrderId, photoIndex);
      await getBucket().file(path).delete({ ignoreNotFound: true });
      return resp(200, { ok: true });
    }

    // ---- Existing-photo migration (Stage c, see "Photo storage migration"
    // in DEV_NOTES.md) -- OWNER-gated (Auth Phase 5, see docs/AUTH_DESIGN.md)
    // on top of the authentication every action in this file now requires.
    // The actions above are normal field-use operations (any signed-in tech
    // uploads/views/deletes photos constantly, by design); this is a
    // one-time bulk rewrite of already-saved data, explicitly gated on Mark's own
    // go-ahead per his own instruction, not just something this session
    // chose not to call yet. Owner-only, not a permissions.js key lookup --
    // there's no dedicated "migrate photos" permission (it's an
    // exceptional, one-time bulk operation, not a day-to-day admin task),
    // so this checks caller.owner directly, matching the same "exceptional,
    // heavily audited" tier as buildings.purge.
    if (body.action === "migrate_scan" || body.action === "migrate_photo" ||
        body.action === "scan_missing_thumbnails" || body.action === "backfill_thumbnail") {
      // The caller is already VERIFIED by requireAuth() at the top of the
      // handler (that used to happen right here, and only for these four
      // actions -- it's now the floor for every action in this file), so
      // this is purely the extra owner check these bulk operations carry on
      // top of authentication. 403 (not 401): you're authenticated, you're
      // just not the owner.
      if (!caller.owner) return resp(403, { error: "Owner only" });
    }

    // Dry run -- reports exactly what migrate_photo WOULD do, writes
    // nothing at all (not Storage, not Firestore). Scans every workorders
    // doc (this app has a handful of real records, not thousands -- no
    // pagination needed) and every photo doc under it, classifying each as
    // already-migrated (has storageRef), needs-migration (has img, no
    // storageRef), or empty (neither -- a genuinely photo-less record,
    // nothing to do). Lets Mark see the exact scope before anything real
    // runs, and lets this be re-run anytime afterward to confirm nothing
    // was missed.
    if (body.action === "migrate_scan") {
      const woSnap = await getDb().collection("workorders").get();
      const alreadyMigrated = [];
      const needsMigration = [];
      const empty = [];
      for (const woDoc of woSnap.docs) {
        const photosSnap = await getDb().collection("workorders").doc(woDoc.id).collection("photos").get();
        for (const pDoc of photosSnap.docs) {
          const v = pDoc.data();
          const entry = { workOrderId: woDoc.id, photoIndex: typeof v.i === "number" ? v.i : null, photoDocId: pDoc.id };
          if (v.storageRef) alreadyMigrated.push(entry);
          else if (v.img) needsMigration.push(entry);
          else empty.push(entry);
        }
      }
      return resp(200, { ok: true, totalWorkOrders: woSnap.size, alreadyMigrated, needsMigration, empty });
    }

    // Migrates ONE photo -- idempotent (a photo that already has a
    // storageRef is reported as already-migrated and untouched, so
    // re-running this over the same photo, or the whole migration after a
    // partial failure, is always safe) and non-destructive (img is never
    // deleted here, only storageRef is added -- see DEV_NOTES.md for why
    // removing img is a deliberately separate, later step). Uploads, then
    // immediately reads the upload back and verifies it decodes to the
    // exact same bytes as the original BEFORE writing storageRef onto the
    // Firestore doc -- so a Firestore doc only ever claims a storageRef
    // once that reference has been proven to actually work, not just
    // "the upload call didn't throw."
    if (body.action === "migrate_photo") {
      const workOrderId = body.workOrderId;
      const photoIndex = body.photoIndex;
      if (!validateWorkOrderId(workOrderId)) return resp(400, { error: "Invalid workOrderId" });
      if (!validatePhotoIndex(photoIndex)) return resp(400, { error: "Invalid photoIndex" });
      const photoRef = getDb().collection("workorders").doc(workOrderId).collection("photos").doc("p" + photoIndex);
      const snap = await photoRef.get();
      if (!snap.exists) return resp(404, { error: "Photo doc not found" });
      const v = snap.data();
      if (v.storageRef) return resp(200, { ok: true, alreadyMigrated: true, storageRef: v.storageRef });
      if (!v.img) return resp(200, { ok: true, skipped: true, reason: "no img to migrate" });
      const buf = decodeDataUrl(v.img);
      if (!buf) return resp(400, { error: "Existing img field is not a valid data:image/jpeg or data:image/png URI" });

      const path = storagePathFor(workOrderId, photoIndex);
      const file = getBucket().file(path);
      await file.save(buf, { contentType: "image/jpeg", resumable: false });

      // Verify: read the just-written object back and confirm it matches
      // byte-for-byte before Firestore is ever told this storageRef is
      // good. A mismatch here is the ONE case worth treating as a hard
      // failure -- better a migration that reports "unverified, retry"
      // than a Firestore doc pointing at a corrupt/incomplete upload.
      const [readBack] = await file.download();
      if (!readBack.equals(buf)) {
        return resp(500, { error: "Upload verification failed (readback did not match) -- storageRef NOT saved, img untouched, safe to retry" });
      }

      await photoRef.set({ storageRef: path }, { merge: true });
      return resp(200, { ok: true, migrated: true, storageRef: path, bytes: buf.length });
    }

    // ---- Thumbnail backfill (real production incident, 2026-07-12, see
    // "captions but no photos" in DEV_NOTES.md): every photo the Stage-c
    // migration above ever moved to Storage came out with storageRef but no
    // thumb -- thumb generation only ever happened client-side at
    // fresh-capture time (makeThumbDataUrl() in js/photos.js), never during
    // that server-side migration. The client already falls back to the
    // full-size base64 backup when thumb is missing (imgFallback, see
    // js/core.js), so nothing is broken for a tech today -- this is a
    // permanence/performance follow-up, not a fix for an active bug: a
    // proper small thumbnail is far cheaper to load into a photo gallery
    // than shipping the full-resolution image every time. Same owner-only,
    // dry-run-first tier as the Stage-c migration above -- exceptional,
    // one-time bulk operation, not day-to-day admin work. ----
    if (body.action === "scan_missing_thumbnails") {
      const woSnap = await getDb().collection("workorders").get();
      const missing = [];
      for (const woDoc of woSnap.docs) {
        const photosSnap = await getDb().collection("workorders").doc(woDoc.id).collection("photos").get();
        for (const pDoc of photosSnap.docs) {
          const v = pDoc.data();
          if (v.storageRef && !v.thumb) {
            missing.push({ workOrderId: woDoc.id, photoIndex: typeof v.i === "number" ? v.i : null, photoDocId: pDoc.id });
          }
        }
      }
      return resp(200, { ok: true, totalWorkOrders: woSnap.size, missing });
    }

    // Generates ONE photo's thumbnail -- idempotent (a photo that already
    // has a thumb is reported as already-done and untouched) and additive-
    // only: writes ONLY the thumb field via merge, never touches img/
    // storageRef/caption/anything else this photo doc already has. Source
    // bytes: the base64 img backup already in Firestore if present (every
    // migrated photo has one -- confirmed live against production, see the
    // "captions but no photos" incident), falling back to a Storage
    // download via storageRef for the rare case it isn't (e.g. a future
    // photo whose backup was already cleaned up some other way). Same
    // 200x200/q0.6 shape js/photos.js's makeThumbDataUrl() already
    // produces at capture time, via jimp (pure JS, no native binary --
    // deliberately not sharp, to avoid Netlify's function-bundler native-
    // dependency issues that external_node_modules in netlify.toml already
    // has to work around for firebase-admin).
    if (body.action === "backfill_thumbnail") {
      const workOrderId = body.workOrderId;
      const photoIndex = body.photoIndex;
      if (!validateWorkOrderId(workOrderId)) return resp(400, { error: "Invalid workOrderId" });
      if (!validatePhotoIndex(photoIndex)) return resp(400, { error: "Invalid photoIndex" });
      const photoRef = getDb().collection("workorders").doc(workOrderId).collection("photos").doc("p" + photoIndex);
      const snap = await photoRef.get();
      if (!snap.exists) return resp(404, { error: "Photo doc not found" });
      const v = snap.data();
      if (v.thumb) return resp(200, { ok: true, alreadyDone: true });
      if (!v.storageRef) return resp(200, { ok: true, skipped: true, reason: "no storageRef -- not a migrated photo, nothing to backfill" });

      let buf;
      if (v.img) {
        buf = decodeDataUrl(v.img);
        if (!buf) return resp(400, { error: "Existing img field is not a valid data:image/jpeg or data:image/png URI" });
      } else {
        const path = storagePathFor(workOrderId, photoIndex);
        const [downloaded] = await getBucket().file(path).download();
        buf = downloaded;
      }

      const Jimp = require("jimp");
      const image = await Jimp.read(buf);
      const THUMB_MAX_DIM = 200; // matches js/photos.js's PHOTO_THUMB_MAX_DIM exactly
      image.scaleToFit(THUMB_MAX_DIM, THUMB_MAX_DIM);
      image.quality(60); // matches js/photos.js's PHOTO_THUMB_QUALITY (0.6) exactly
      const thumbBuf = await image.getBufferAsync(Jimp.MIME_JPEG);
      const thumb = "data:image/jpeg;base64," + thumbBuf.toString("base64");

      await photoRef.set({ thumb: thumb }, { merge: true });
      return resp(200, { ok: true, backfilled: true, thumbBytes: thumbBuf.length });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
