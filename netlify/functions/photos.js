// Photo storage — the ONLY place in the app allowed to touch Firebase
// Storage, using the Firebase Admin SDK (service-account credentials, not
// subject to Storage security rules at all).
//
// WHY THIS EXISTS (see "Photo storage migration" in DEV_NOTES.md): the app
// has no user auth yet, so Storage security rules are deny-all — that's
// correct and must stay that way (an open bucket would make every
// customer's roof photos world-readable to anyone who guessed a URL).
// Firestore's rules are open (`allow read, write: if true`, same "no login
// yet" tradeoff already accepted for every other collection), so the
// client already talks to Firestore directly with no gate beyond that. The
// client must NEVER be given direct Storage access the same way — instead
// it calls this function, which does the real read/write server-side and
// returns only what's needed (a storage reference to save in Firestore, or
// the actual image bytes to display/embed). The bucket itself stays
// completely sealed to the browser.
//
// This is deliberately NOT admin-PIN-gated like admin.js — regular techs
// upload/view photos constantly in normal field use, not just admins. It's
// a trusted proxy for a resource that can't have open client rules, at the
// same "no auth yet" security tier every other collection already has, not
// a privileged action. Basic input validation (safe id/index shapes) below
// guards against abuse regardless.
const { getAdmin } = require("./lib/authGuard");

const BUCKET_NAME = "watkins-service-orders.firebasestorage.app";
// workOrderId shapes seen in real data: "wo_1783782867489" (Date.now()-based,
// see genId()/collect() in index.html) and legacy/manual ids -- alphanumeric
// plus underscore/hyphen covers every real id this app generates, and
// rejecting anything else is what actually prevents a crafted workOrderId
// from being used to write/read OUTSIDE the workorders/ prefix below.
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getBucket() {
  return getAdmin().storage().bucket(BUCKET_NAME);
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

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  try {
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

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
