"use strict";
// De-duplication for the RoofOps -> CompanyCam photo push.
//
// THE PROBLEM: uploadPhotoToCompanyCam() (lib/companyCamPhotos.js) had exactly
// one duplicate guard -- ccFeedPhotoId, "did WE push THIS work-order photo
// before". That covers a resend of the same work order and nothing else. It
// cannot see:
//   * the same photo the tech ALSO uploaded to CompanyCam directly from their
//     phone (the common case -- CompanyCam is where they already live), and
//   * the same image reaching the same project from a DIFFERENT work order,
//     a re-created work order, or a restored/duplicated record.
// Both land a second copy in the project feed, and a pushed photo is sticky:
// CompanyCam's UI will not let a user delete an integration-owned photo (see
// deletePushedPhotoFromCompanyCam). So a duplicate is a duplicate forever
// unless an admin runs the undo-push.
//
// MARK'S DESIGN (confirmed): compare against what is ALREADY in CompanyCam,
// using capture date/time + GPS, with a content hash as the fallback.
//
//   PRIMARY -- match the live project. Fetch the target project's existing
//     photos (captured_at + coordinates) and match a candidate against them on
//     BOTH time (within tolerance) and location (within tolerance). A hit is a
//     duplicate and is skipped.
//
//   FALLBACK -- content hash. SHA-256 of the image bytes, checked against a
//     per-project "already pushed" ledger in Firestore. Catches photos whose
//     EXIF was stripped, and RoofOps-originated duplicates the primary check
//     structurally cannot see (below).
//
// ---------------------------------------------------------------------------
// THE FALSE-SKIP RULE -- the single most important thing in this file.
//
// A false DUP (uploading something twice) is an annoyance. A false SKIP
// (deciding a real, new photo is a duplicate and silently dropping it) is LOST
// FIELD EVIDENCE on a roof someone is going to make a warranty claim about.
// They are not symmetric and this code does not treat them as symmetric.
//
// That is why the primary check demands TRUSTED, PER-PHOTO metadata and
// refuses to run on anything else. In this app:
//
//   * captured_at sent to CompanyCam has, historically, been the WORK ORDER's
//     service date at noon -- IDENTICAL for every photo on the order
//     (ccPhotoCapturedAt() in js/history.js). Photos carried no capture time of
//     their own because the canvas resize strips EXIF (see parseExifGps()'s
//     comment in js/photos.js).
//   * coordinates sent to CompanyCam fall back, in order, to a finding's pin
//     and then to the JOB's location -- also IDENTICAL across photos.
//
// So on a work order whose photos have no GPS, every photo already presents the
// same (time, place) as every other. A naive "time + GPS" match would upload
// photo 0 and then skip photos 1..9 as duplicates OF photo 0. That is the
// catastrophic failure mode of this feature, and it is the reason for:
//
//   1. The client must send dedupCapturedAt (the photo's OWN capture time, from
//      EXIF DateTimeOriginal or the moment of camera capture) and
//      dedupCoordinates (the photo's OWN GPS). Derived/shared values -- service
//      date, finding pin, job location -- are NEVER sent as dedup metadata.
//      No own metadata => the primary check does not run at all => hash.
//   2. excludeCcPhotoIds: the ids this push run has already created are removed
//      from the match index, so photo 5 can never be judged a duplicate of
//      photo 3 that we uploaded eight seconds ago in the same run.
//
// ---------------------------------------------------------------------------
// TIMEZONE -- the "everything reads as new" trap.
//
// EXIF DateTimeOriginal is "2026:07:10 14:32:07": naive local wall-clock, no
// zone. CompanyCam's captured_at is normalized (unix seconds, UTC). Compare
// them raw and a US Central photo is off by 5-6 hours -- every single photo
// misses its match and re-uploads, and the feature silently does nothing.
//
// The conversion happens CLIENT-side, in js/photos.js, at import time, because
// that is the only place that knows the right zone: the device that is holding
// the photo is (essentially always) in the zone the photo was taken in, and
// EXIF's own OffsetTimeOriginal tag is used exactly when present. The client
// therefore sends unambiguous epoch milliseconds and the server compares two
// UTC numbers.
//
// normalizeToEpochSeconds() below still handles every other shape defensively
// (ms, seconds, ISO with Z or +hh:mm, and naive EXIF), because CompanyCam's
// captured_at comes back through it too. A NAIVE value with no zone
// information returns null unless cfg.assumedUtcOffsetMinutes is explicitly
// configured -- refusing to compare is honest; guessing is the bug.
const crypto = require("crypto");
const { getDb } = require("./authGuard");
const { getDedupConfig } = require("./companyCamDedupConfig");

const EXIF_NAIVE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const HAS_ZONE = /(Z|[+\-]\d{2}:?\d{2})$/;
const SAFE_HASH = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------- time ------

// -> integer unix SECONDS, or null when the value cannot be compared honestly.
function normalizeToEpochSeconds(value, cfg) {
  if (value === null || value === undefined || value === "") return null;
  cfg = cfg || getDedupConfig();

  // Numbers (and pure-numeric strings): the app speaks Date.now() milliseconds,
  // CompanyCam speaks seconds. Same 1e11 cut companyCamPhotos.js uses -- a
  // value that big cannot be a plausible "seconds" timestamp (it would be the
  // year 5138) but is an ordinary millisecond one.
  const numeric = (typeof value === "number") ? value
    : (/^-?\d+(\.\d+)?$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN);
  if (isFinite(numeric)) {
    if (numeric <= 0) return null;
    return Math.floor(numeric > 1e11 ? numeric / 1000 : numeric);
  }

  const s = String(value).trim();

  // ISO-8601 carrying its own zone -- unambiguous, let Date parse it.
  if (HAS_ZONE.test(s)) {
    const t = Date.parse(s);
    return isFinite(t) ? Math.floor(t / 1000) : null;
  }

  // Naive wall-clock ("YYYY:MM:DD HH:MM:SS" from EXIF, or an ISO string with no
  // offset). Uncomparable without a zone -- see the TIMEZONE block above.
  const m = EXIF_NAIVE.exec(s);
  if (!m) return null;
  const offset = cfg.assumedUtcOffsetMinutes;
  if (offset === null || offset === undefined || !isFinite(Number(offset))) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!isFinite(utcMs)) return null;
  return Math.floor((utcMs - Number(offset) * 60000) / 1000);
}

// ------------------------------------------------------------ geometry ------

// Same acceptance rules as normalizeCoordinates() in companyCamPhotos.js --
// {lat,lng} or {lat,lon}, no Null Island, in range -- deliberately duplicated
// rather than imported so the dedup path cannot be broken by a change made for
// the upload path, and vice versa. Both are covered by tests.
function toLatLon(c) {
  if (!c || typeof c !== "object") return null;
  const lat = Number(c.lat);
  const lon = Number(c.lon !== undefined && c.lon !== null ? c.lon : c.lng);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: lat, lon: lon };
}

// Great-circle distance in metres. Tolerances here are single-digit metres, so
// the spherical-earth error (~0.3%) is ~15mm at 5m -- irrelevant.
function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// --------------------------------------------------- the live project index --

// Every existing photo in the target project, reduced to the two fields the
// match needs. Paginated; stops at the first short/empty page.
//
// BOUNDED BY BOTH A PAGE COUNT AND A WALL-CLOCK BUDGET. The clock is the one
// that really matters: verified against the live API (2026-07-28), a real
// Watkins project returns a full 100 photos on page 1 and keeps going, so an
// unbounded walk of a big project would outlast the Netlify function itself and
// turn "check for duplicates" into "the push times out".
//
// truncated:true means the project has MORE photos than we scanned. That biases
// toward a false DUP (an extra upload), never a false skip, and it is reported
// so the push summary can say so out loud rather than quietly under-matching.
// CompanyCam returns newest-first, so what falls off the end is the oldest
// photos -- the least likely to match a shot taken on site today.
async function fetchProjectPhotoIndex(projectId, token, cfg) {
  cfg = cfg || getDedupConfig();
  const headers = { "Authorization": "Bearer " + token, "Accept": "application/json" };
  const photos = [];
  const deadline = Date.now() + cfg.indexMaxMillis;
  let truncated = false;
  for (let page = 1; page <= cfg.indexMaxPages; page++) {
    if (Date.now() > deadline) { truncated = true; break; }
    const url = "https://api.companycam.com/v2/projects/" + projectId +
      "/photos?per_page=" + cfg.indexPerPage + "&page=" + page;
    const r = await fetch(url, { headers: headers });
    if (!r.ok) {
      let t = ""; try { t = await r.text(); } catch (e) {}
      throw new Error("CompanyCam photo index failed: " + r.status + " " + String(t).slice(0, 200));
    }
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const ph of arr) {
      if (!ph || ph.id === undefined || ph.id === null) continue;
      photos.push({
        id: String(ph.id),
        capturedAt: normalizeToEpochSeconds(ph.captured_at, cfg),
        coord: toLatLon(ph.coordinates)
      });
    }
    if (arr.length < cfg.indexPerPage) break;
    if (page === cfg.indexMaxPages) truncated = true;
  }
  return { photos: photos, truncated: truncated, fetchedAt: Date.now() };
}

// Module-scope cache. Netlify reuses a warm container across the invocations of
// one push run (one function call per photo), so this usually turns an N-photo
// push into ONE index fetch. Correctness never depends on it: a cold container
// just refetches, and excludeCcPhotoIds (below) is what actually protects the
// run from matching its own uploads, not the cache.
//
// Keyed by project AND runKey so two different pushes -- or the same project an
// hour later -- never read each other's snapshot.
const indexCache = new Map();

function cacheKey(projectId, runKey) { return String(projectId) + "|" + String(runKey || "-"); }

async function getProjectPhotoIndex(projectId, token, cfg, runKey) {
  cfg = cfg || getDedupConfig();
  const key = cacheKey(projectId, runKey);
  const now = Date.now();
  const hit = indexCache.get(key);
  if (hit && (now - hit.fetchedAt) < cfg.indexCacheTtlMs) return hit;
  // Opportunistic prune so a long-lived container cannot grow this without bound.
  indexCache.forEach(function (v, k) {
    if ((now - v.fetchedAt) >= cfg.indexCacheTtlMs) indexCache.delete(k);
  });
  const fresh = await fetchProjectPhotoIndex(projectId, token, cfg);
  indexCache.set(key, fresh);
  return fresh;
}

function clearIndexCache() { indexCache.clear(); }

// ------------------------------------------------------------- matching -----

// The PRIMARY match. Returns the matching existing photo, or null.
//
// Requires BOTH a time and a location match -- either alone is far too weak
// (a project's photos share a location by definition; a burst shares a second).
// Among several candidates within tolerance, the closest in time wins, then the
// closest in space, so the reported match is the most defensible one.
function findMetadataMatch(candidate, index, cfg, excludeIds) {
  cfg = cfg || getDedupConfig();
  if (!candidate || candidate.capturedAt === null || !candidate.coord) return null;
  const skip = new Set((excludeIds || []).map(String));
  let best = null;
  for (const ex of (index || [])) {
    if (!ex || skip.has(ex.id)) continue;
    if (ex.capturedAt === null || !ex.coord) continue;
    const dt = Math.abs(ex.capturedAt - candidate.capturedAt);
    if (dt > cfg.timeToleranceSeconds) continue;
    const dm = haversineMeters(candidate.coord, ex.coord);
    if (dm > cfg.distanceToleranceMeters) continue;
    if (!best || dt < best.deltaSeconds || (dt === best.deltaSeconds && dm < best.deltaMeters)) {
      best = { id: ex.id, deltaSeconds: dt, deltaMeters: dm, capturedAt: ex.capturedAt, coord: ex.coord };
    }
  }
  return best;
}

// ---------------------------------------------------------------- hash ------

function sha256Hex(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

// Reads the image bytes out of Firebase Storage and hashes them.
// Returns { hash } or { error } -- NEVER throws, because "we couldn't hash it"
// must degrade to "upload it and flag it", not to a lost photo.
async function hashStorageObject(file, cfg) {
  cfg = cfg || getDedupConfig();
  try {
    if (!file || typeof file.download !== "function") return { error: "storage object cannot be downloaded" };
    const dl = await file.download();
    const buf = Array.isArray(dl) ? dl[0] : dl;
    if (!buf || typeof buf.length !== "number" || buf.length === 0) return { error: "empty download" };
    if (buf.length > cfg.maxHashBytes) return { error: "image is larger than maxHashBytes (" + buf.length + ")" };
    return { hash: sha256Hex(buf), bytes: buf.length };
  } catch (e) {
    return { error: (e && e.message) ? e.message : "hash failed" };
  }
}

// The per-project "already pushed" ledger.
//   cc_push_ledger/{projectId}/entries/{sha256}
// A subcollection, not one fat document, because a busy project can accumulate
// thousands of photos and a single doc caps at 1MB.
function ledgerEntryRef(cfg, projectId, hash) {
  return getDb()
    .collection(cfg.ledgerCollection).doc(String(projectId))
    .collection("entries").doc(hash);
}

// { seen:true, entry } | { seen:false } | { error } -- never throws.
async function lookupHashInLedger(projectId, hash, cfg) {
  cfg = cfg || getDedupConfig();
  if (!SAFE_HASH.test(String(hash || ""))) return { error: "not a sha-256 hex digest" };
  try {
    const snap = await ledgerEntryRef(cfg, projectId, hash).get();
    if (snap && snap.exists) return { seen: true, entry: snap.data() || {} };
    return { seen: false };
  } catch (e) {
    return { error: (e && e.message) ? e.message : "ledger read failed" };
  }
}

// Records a successful push so the same bytes are never sent to this project
// again. Best-effort: the photo IS already in CompanyCam by the time this runs,
// so a ledger write failure must never turn a successful push into an error.
async function recordHashInLedger(projectId, hash, meta, cfg) {
  cfg = cfg || getDedupConfig();
  if (!SAFE_HASH.test(String(hash || ""))) return { ok: false, error: "not a sha-256 hex digest" };
  try {
    await ledgerEntryRef(cfg, projectId, hash).set({
      sha256: hash,
      projectId: String(projectId),
      ccPhotoId: (meta && meta.ccPhotoId) ? String(meta.ccPhotoId) : null,
      workOrderId: (meta && meta.workOrderId) ? String(meta.workOrderId) : null,
      photoIndex: (meta && meta.photoIndex !== undefined && meta.photoIndex !== null) ? Number(meta.photoIndex) : null,
      bytes: (meta && meta.bytes) || null,
      pushedAt: Date.now()
    }, { merge: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : "ledger write failed" };
  }
}

// ------------------------------------------------------------ the decision --

// Decides whether ONE candidate photo is already in the CompanyCam project.
//
// Returns, always (it never throws):
//   {
//     duplicate: bool,
//     reason: "matched_time_gps" | "matched_hash" | null,
//     matchedPhotoId: string|null,
//     hash: string|null,
//     unverified: bool,          // uploaded WITHOUT a completed check -- flagged
//     checks: { meta: <status>, hash: <status> },
//     detail: { ... }            // deltas / notes, for the audit line
//   }
//
// meta statuses: "matched" | "no_match" | "not_eligible" | "index_error" | "disabled"
// hash statuses: "matched" | "no_match" | "unavailable" | "not_needed" | "disabled"
async function evaluatePhotoForDuplicate(opts) {
  opts = opts || {};
  const cfg = opts.config || getDedupConfig();
  const out = {
    duplicate: false, reason: null, matchedPhotoId: null, hash: null,
    unverified: false, checks: { meta: "disabled", hash: "disabled" }, detail: {}
  };
  if (!cfg.enabled) {
    out.detail.note = "de-duplication is disabled (CC_DEDUP_ENABLED)";
    return out;
  }

  // ---- PRIMARY: capture time + GPS against the live project ----
  const capturedAt = normalizeToEpochSeconds(opts.dedupCapturedAt, cfg);
  const coord = toLatLon(opts.dedupCoordinates);
  if (capturedAt === null || !coord) {
    // Missing per-photo metadata is the NORMAL case for a photo whose EXIF was
    // stripped, and the documented trigger for the hash fallback. It is never
    // an error and never a skip.
    out.checks.meta = "not_eligible";
    out.detail.metaNote = capturedAt === null
      ? (coord ? "no per-photo capture time" : "no per-photo capture time and no photo GPS")
      : "no photo GPS";
  } else {
    try {
      const index = await getProjectPhotoIndex(opts.projectId, opts.readToken, cfg, opts.runKey);
      const match = findMetadataMatch({ capturedAt: capturedAt, coord: coord }, index.photos, cfg, opts.excludeCcPhotoIds);
      out.detail.indexSize = index.photos.length;
      if (index.truncated) out.detail.indexTruncated = true;
      if (match) {
        out.checks.meta = "matched";
        out.duplicate = true;
        out.reason = "matched_time_gps";
        out.matchedPhotoId = match.id;
        out.detail.deltaSeconds = match.deltaSeconds;
        out.detail.deltaMeters = Math.round(match.deltaMeters * 100) / 100;
        out.checks.hash = "not_needed";
        return out;
      }
      out.checks.meta = "no_match";
    } catch (e) {
      // A failed index fetch must not block the push. We upload and flag it --
      // an extra copy is recoverable (undo-push); a dropped photo is not.
      out.checks.meta = "index_error";
      out.unverified = true;
      out.detail.metaError = (e && e.message) ? e.message : "index fetch failed";
    }
  }

  // ---- FALLBACK: SHA-256 of the image bytes against the per-project ledger ----
  // Runs when the primary check could not decide, and ALSO on every candidate
  // when cfg.alwaysHash is on. The second case is not redundant: the primary
  // check compares the photo's OWN GPS, but what we previously SENT to
  // CompanyCam for that photo may have been a finding pin or the job location
  // instead (ccBestPhotoCoordinateWithSource() in js/history.js). The live
  // project therefore holds that photo at a coordinate the primary check will
  // never match, and only the hash can see it.
  const metaDecided = (out.checks.meta === "no_match");
  if (!cfg.hashFallback) {
    out.checks.hash = "disabled";
    if (!metaDecided) out.unverified = true;
    return out;
  }
  if (metaDecided && !cfg.alwaysHash) {
    out.checks.hash = "not_needed";
    return out;
  }

  const hashed = await hashStorageObject(opts.file, cfg);
  if (hashed.error) {
    // "if it also can't be hashed for some reason, UPLOAD (don't silently
    // drop) and flag it." -- Mark.
    out.checks.hash = "unavailable";
    out.unverified = true;
    out.detail.hashError = hashed.error;
    return out;
  }
  out.hash = hashed.hash;
  out.detail.bytes = hashed.bytes;

  const seen = await lookupHashInLedger(opts.projectId, hashed.hash, cfg);
  if (seen.error) {
    out.checks.hash = "unavailable";
    out.unverified = true;
    out.detail.ledgerError = seen.error;
    return out;
  }
  if (seen.seen) {
    out.checks.hash = "matched";
    out.duplicate = true;
    out.reason = "matched_hash";
    out.matchedPhotoId = (seen.entry && seen.entry.ccPhotoId) ? String(seen.entry.ccPhotoId) : null;
    out.detail.ledgerPushedAt = (seen.entry && seen.entry.pushedAt) || null;
    out.detail.ledgerWorkOrderId = (seen.entry && seen.entry.workOrderId) || null;
    return out;
  }
  out.checks.hash = "no_match";
  return out;
}

module.exports = {
  evaluatePhotoForDuplicate,
  recordHashInLedger,
  lookupHashInLedger,
  hashStorageObject,
  fetchProjectPhotoIndex,
  getProjectPhotoIndex,
  findMetadataMatch,
  normalizeToEpochSeconds,
  haversineMeters,
  toLatLon,
  sha256Hex,
  // tests only -- the module-scope index cache would otherwise leak between cases
  __clearIndexCache: clearIndexCache
};
