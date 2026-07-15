// The SECOND write path into CompanyCam (the first is lib/companyCamDocuments.js,
// which POSTs the generated work-order PDF to /documents). This one pushes an
// INDIVIDUAL work-order photo into a linked project's PHOTO FEED, map-pinned,
// so a photo a tech took on the roof shows up in CompanyCam as a real
// CompanyCam photo at the right spot -- not just buried inside a PDF.
//
// Both pushes happen, and they are deliberately independent: the PDF is the
// document of record; the feed photos are what a CompanyCam user actually
// browses. Neither replaces the other.
//
// ---------------------------------------------------------------------------
// THE API CONTRACT (verified against CompanyCam's live OpenAPI spec,
// 2026-07-14 -- docs.companycam.com/reference/createprojectphoto):
//
//   POST /v2/projects/{project_id}/photos
//   { "photo": { "uri": <string, REQUIRED>,
//                "captured_at": <unix seconds int, REQUIRED>,
//                "coordinates": { "lat": <num>, "lon": <num> },   // optional
//                "description": <string> } }                       // optional
//
// TWO THINGS THAT MATTER AND ARE EASY TO GET WRONG:
//
//  1. `uri` is REQUIRED and there is NO base64/binary variant. Unlike the
//     Documents endpoint (which takes a base64 `attachment` and is why the PDF
//     push was easy), CompanyCam's photo endpoint takes a URL and CompanyCam's
//     own servers go FETCH it. So the image must be reachable BY COMPANYCAM,
//     from the public internet, without our Firebase auth -- which is exactly
//     what DEV_NOTES.md (2026-07-09) called the blocker for this feature.
//
//  2. It is "lon", NOT "lng". (companycam.js's read path already knows this --
//     see the mapping comment on action=photos.)
//
// HOW THE BLOCKER IS ACTUALLY CLEARED -- read this before "simplifying" it:
// Photos now live in Firebase Storage, but the bucket is DENY-ALL by design
// (see the header of netlify/functions/photos.js: an open bucket would make
// every customer's roof photos world-readable to anyone who guessed a URL, and
// that must never change). So "the photos are in Storage now" does NOT by
// itself hand us a public URL -- there ISN'T one, and we must not create one.
//
// Instead we mint a short-lived V4 SIGNED URL, server-side, per photo, per
// push. It is unguessable, it expires, it grants read on exactly ONE object,
// and the bucket stays sealed. CompanyCam fetches the bytes once during that
// window and stores its own copy; the link then rots harmlessly. This is the
// ONLY thing in the app that hands out a Storage-readable URL, and it hands it
// to CompanyCam, not to a browser.
const { getAdmin, getDb } = require("./authGuard");

// Same shapes photos.js validates -- a crafted workOrderId must not be able to
// address anything outside the workorders/ prefix, and the path is always
// built here, server-side, never accepted from the client.
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

// CompanyCam has to fetch the image before this expires. A few minutes would
// probably do (the fetch looks synchronous-ish -- the 201 comes back with a
// processing_status), but photo processing is explicitly async on their side
// ("pending"/"processing"), and a signed URL that dies mid-processing would
// fail in a way we'd only find out about from a customer. 7 days is Google's
// V4 maximum and costs nothing to grant on a single object.
const SIGNED_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function storagePathFor(workOrderId, photoIndex) {
  return "workorders/" + workOrderId + "/" + photoIndex + ".jpg";
}
function validWorkOrderId(v) { return typeof v === "string" && SAFE_ID.test(v); }
function validPhotoIndex(v) { return Number.isInteger(v) && v >= 0 && v < 10000; }

// Accepts either of the app's two in-the-wild coordinate shapes -- RoofOps
// speaks {lat,lng} everywhere (Leaflet's convention), CompanyCam speaks
// {lat,lon} -- and always emits CompanyCam's.
//
// Rejects (returns null, i.e. "no coordinate", NOT a zeroed one):
//   - anything non-numeric / out of range
//   - NULL ISLAND (0,0). The repo already has tools/audit_null_island.js
//     because 0,0 is what a broken/missing coordinate looks like in this app's
//     real data, and a photo pinned in the Gulf of Guinea is worse than a
//     photo with no pin at all -- an unpinned photo is honestly unpinned; a
//     0,0 photo is a confident lie that also drags the project's map view.
function normalizeCoordinates(c) {
  if (!c || typeof c !== "object") return null;
  const lat = Number(c.lat);
  const lon = Number(c.lon !== undefined && c.lon !== null ? c.lon : c.lng);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: lat, lon: lon };
}

// captured_at is REQUIRED and must be unix SECONDS. Every timestamp this app
// generates is Date.now() milliseconds, so a raw pass-through would send a
// captured_at ~50,000 years in the future and CompanyCam would either reject
// it or (worse) accept it and sort the feed by it.
function normalizeCapturedAt(v) {
  let n = Number(v);
  if (!isFinite(n) || n <= 0) n = Date.now();
  if (n > 1e11) n = Math.floor(n / 1000); // milliseconds -> seconds
  return Math.floor(n);
}

// Last-resort coordinate: the LINKED PROJECT'S OWN location, straight from
// CompanyCam. Only consulted when the caller supplied no usable coordinate at
// all (a bottom-section "Photo Documentation" photo with no GPS, on a work
// order whose address didn't geocode). It is the truest available answer to
// "where is this job", and it needs no geocoding -- CompanyCam already knows,
// because the project is the job.
//
// Never throws: a photo with no coordinate is still a photo worth pushing.
async function fetchProjectCoordinates(projectId, token) {
  try {
    const r = await fetch("https://api.companycam.com/v2/projects/" + projectId, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
    });
    if (!r.ok) return null;
    const pr = await r.json();
    return normalizeCoordinates(pr && pr.coordinates);
  } catch (e) {
    return null;
  }
}

// Pushes ONE work-order photo into a linked CompanyCam project's photo feed.
//
// The client never sends image bytes and never sends a storage path -- it
// sends { workOrderId, photoIndex }, exactly like every other action in
// photos.js, and the path is derived HERE. That's what keeps path injection
// structurally impossible rather than merely filtered, and it's also why this
// works for a photo the tech captured thirty seconds ago: the in-memory photo
// object doesn't carry a storageRef (cloudSaveOrder() computes it but never
// writes it back onto the client-side photo), but the OBJECT is in the bucket
// the moment the work order was saved, and the path is a pure function of
// (workOrderId, photoIndex).
//
// A photo that isn't in Storage yet is NOT an error -- it's { skipped }. That
// happens for a legacy pre-migration photo (base64 in Firestore, never
// uploaded) or a save that partially failed. The next send retries it for
// free, and one such photo must never fail the other nine.
async function uploadPhotoToCompanyCam(opts) {
  opts = opts || {};
  const readToken = process.env.COMPANYCAM_TOKEN;
  const writeToken = process.env.COMPANYCAM_WRITE_TOKEN || readToken;
  if (!writeToken) {
    return { ok: false, error: "COMPANYCAM_WRITE_TOKEN (or COMPANYCAM_TOKEN) is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy." };
  }

  const projectId = String(opts.projectId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!projectId) return { ok: false, error: "Missing project_id" };
  if (!validWorkOrderId(opts.workOrderId)) return { ok: false, error: "Invalid workOrderId" };
  if (!validPhotoIndex(opts.photoIndex)) return { ok: false, error: "Invalid photoIndex" };

  const path = storagePathFor(opts.workOrderId, opts.photoIndex);
  const file = getAdmin().storage().bucket().file(path);

  let exists = false;
  try { exists = (await file.exists())[0]; }
  catch (e) { return { ok: false, error: "Storage check failed: " + (e && e.message ? e.message : "unknown") }; }
  if (!exists) {
    return { ok: false, skipped: true, reason: "not_in_storage", error: "Photo is not in Storage yet -- it will be pushed on the next save/send once its upload lands." };
  }

  let uri;
  try {
    const signed = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_MS
    });
    uri = Array.isArray(signed) ? signed[0] : signed;
  } catch (e) {
    return { ok: false, error: "Couldn't sign a fetchable URL for CompanyCam: " + (e && e.message ? e.message : "unknown") };
  }
  if (!uri) return { ok: false, error: "Couldn't sign a fetchable URL for CompanyCam (empty URL)" };

  let coordinates = normalizeCoordinates(opts.coordinates);
  if (!coordinates) coordinates = await fetchProjectCoordinates(projectId, readToken || writeToken);

  const photo = { uri: uri, captured_at: normalizeCapturedAt(opts.capturedAt) };
  if (coordinates) photo.coordinates = coordinates;
  if (opts.description) photo.description = String(opts.description).slice(0, 500);

  const headers = {
    "Authorization": "Bearer " + writeToken,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  if (process.env.COMPANYCAM_USER_EMAIL) headers["X-CompanyCam-User"] = process.env.COMPANYCAM_USER_EMAIL;

  try {
    const r = await fetch("https://api.companycam.com/v2/projects/" + projectId + "/photos", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ photo: photo })
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, error: "CompanyCam rejected the photo: " + r.status + " " + t.slice(0, 300) };
    let out = null;
    try { out = JSON.parse(t); } catch (e) {}
    return {
      ok: true,
      photoId: out && out.id ? String(out.id) : null,
      coordinates: coordinates,
      photo: out
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Removes a photo the INTEGRATION pushed into a CompanyCam project's feed
// (issue: pushed photos are "sticky" -- CompanyCam's UI won't let a user delete
// an integration-owned photo, but the API + our token can).
//
// THE SAFETY SCOPING, and why it is structurally impossible to delete a real
// user-taken CompanyCam photo:
//   - The client sends { workOrderId, photoIndex } -- NEVER a raw CompanyCam
//     photo id. The id to delete is DERIVED HERE, server-side, from OUR OWN
//     Firestore record: workorders/{id}/photos/p{index}.ccFeedPhotoId, which we
//     only ever wrote after WE pushed that exact photo (see ccPersistFeedPhotoId
//     / pushPhotosToCompanyCamFeed). A photo we didn't push has no ccFeedPhotoId,
//     so there is nothing for this to delete -> it refuses ({skipped}).
//   - A user-taken CompanyCam photo is never in our records, is never addressable
//     here, and cannot be reached even by a crafted request. The only thing this
//     can ever DELETE is an id this app itself created.
//   - Optional drift guard: the caller may pass expectedFeedPhotoId (it has it in
//     memory); if our stored id disagrees (e.g. an unsaved photo reorder), refuse
//     rather than delete a DIFFERENT one of our own photos.
async function deletePushedPhotoFromCompanyCam(opts) {
  opts = opts || {};
  const writeToken = process.env.COMPANYCAM_WRITE_TOKEN || process.env.COMPANYCAM_TOKEN;
  if (!writeToken) {
    return { ok: false, error: "COMPANYCAM_WRITE_TOKEN (or COMPANYCAM_TOKEN) is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy." };
  }
  if (!validWorkOrderId(opts.workOrderId)) return { ok: false, error: "Invalid workOrderId" };
  if (!validPhotoIndex(opts.photoIndex)) return { ok: false, error: "Invalid photoIndex" };

  const db = getDb();
  const photoRef = db.collection("workorders").doc(opts.workOrderId).collection("photos").doc("p" + opts.photoIndex);
  let snap;
  try { snap = await photoRef.get(); }
  catch (e) { return { ok: false, error: "Record read failed: " + (e && e.message ? e.message : "unknown") }; }
  const stored = (snap && snap.exists) ? snap.data() : null;
  const ccFeedPhotoId = stored && stored.ccFeedPhotoId ? String(stored.ccFeedPhotoId) : null;

  // SCOPING GUARD -- no id of ours => nothing we may delete.
  if (!ccFeedPhotoId) return { ok: false, skipped: true, reason: "not_integration_photo" };
  if (opts.expectedFeedPhotoId && String(opts.expectedFeedPhotoId) !== ccFeedPhotoId) {
    return { ok: false, skipped: true, reason: "feed_id_mismatch" };
  }

  let projectId = null;
  try {
    const woSnap = await db.collection("workorders").doc(opts.workOrderId).get();
    projectId = (woSnap && woSnap.exists && woSnap.data().companyCamProjectId) || null;
  } catch (e) { /* project id is for the audit log only -- not required to delete */ }

  const headers = { "Authorization": "Bearer " + writeToken, "Accept": "application/json" };
  if (process.env.COMPANYCAM_USER_EMAIL) headers["X-CompanyCam-User"] = process.env.COMPANYCAM_USER_EMAIL;

  let status;
  try {
    const r = await fetch("https://api.companycam.com/v2/photos/" + encodeURIComponent(ccFeedPhotoId), { method: "DELETE", headers });
    status = r.status;
    // 204 No Content = deleted. 404 = already gone -> the goal (not in the feed) holds either way.
    if (r.status !== 204 && r.status !== 404) {
      let t = ""; try { t = await r.text(); } catch (e) {}
      return { ok: false, error: "CompanyCam rejected the delete: " + r.status + " " + t.slice(0, 200), ccFeedPhotoId: ccFeedPhotoId, projectId: projectId };
    }
  } catch (e) { return { ok: false, error: e && e.message ? e.message : "delete failed", ccFeedPhotoId: ccFeedPhotoId, projectId: projectId }; }

  // Clear OUR record so the photo can be re-pushed later and our state reflects
  // it is no longer in the feed. Merge-only -- never touches img/storageRef/etc.
  try { await photoRef.set({ ccFeedPhotoId: null }, { merge: true }); }
  catch (e) { /* the CompanyCam delete already succeeded; the stale flag self-heals on the next save/push */ }

  return { ok: true, deletedPhotoId: ccFeedPhotoId, projectId: projectId, alreadyGone: status === 404 };
}

module.exports = {
  uploadPhotoToCompanyCam,
  deletePushedPhotoFromCompanyCam,
  // exported for tests -- the normalizers are where the silent, expensive bugs
  // live (ms-vs-seconds, lng-vs-lon, null island), so they get asserted directly.
  normalizeCoordinates,
  normalizeCapturedAt,
  storagePathFor
};
