"use strict";
/* ================= AI training labels (data foundation) =================

   Mark's framing: once we start identifying photos in leak reports, each
   identified leak becomes a labeled training example for a future learning
   model. This module is the WRITE PATH for that data — pure plumbing, no
   AI call, no API key. It exists so labeled examples start accumulating
   NOW instead of being thrown away.

   One confirmed tech action ("yes, that's ponding water") = one clean row
   in the `ai_training_labels` collection. Nothing here renders UI; the
   flows that own the confirm/correct interaction (work orders, photos,
   DPR, inspections) call recordConfirmedLabel() when they're ready to —
   this module deliberately has NO callers yet.

   Design rules (see "AI training labels" in DEV_NOTES.md / DATA_MODEL.md):

   - PHOTO REFERENCES ONLY, NEVER URLS. Customer roof photos live behind a
     sealed Storage bucket (netlify/functions/photos.js) or in CompanyCam;
     both are resolved to signed/authorized access SERVER-side at read
     time. A label record stores { kind, workOrderId, photoIndex } or
     { kind, companyCamPhotoId, companyCamProjectId } — a record can never
     leak a photo by itself. aiLabelBuildDoc() enforces this structurally
     (it rebuilds the photo ref field-by-field; a URL has nowhere to go).

   - STABLE BUILDING ID. entry.buildingId must be the building's stored
     Firestore doc id — currentWorkOrderBuildingId()/buildingIdFor() once
     the stable-identity fix (PR #120) lands — NOT a slug recomputed from
     Bill To + Job Name. This module never derives identity itself; it
     records what the caller resolved.

   - CONTROLLED VOCABULARY. Free-text labels are useless for training.
     entry.label must be a key from aiLabelVocabulary() — the built-in
     AI_ISSUE_LABELS list plus the admin-extendable
     app_settings/ai_label_vocab doc (see loadAiLabelVocabExtra()).
     "other" is allowed but requires labelOther text, so even the escape
     hatch produces a searchable string to promote into a real key later.

   - WRITE-ONLY FROM THE CLIENT. firestore.rules: any signed-in tech can
     create; NOBODY can read/update/delete through the client SDK —
     training data is customer-sensitive, so reads are Admin SDK only
     (future export/labeling tooling). Deletion cascade lives in
     netlify/functions/lib/aiLabels.js (called by admin.js's
     delete_building).

   - FAIL-SAFE. recordConfirmedLabel() never throws and never blocks the
     tech's flow — capturing a training row is best-effort bookkeeping; a
     failed write logs a console warning and returns { ok:false }. */

/* ---- controlled vocabulary ----
   Starter set proposed 2026-07-16 (Mark's brief + common low-slope failure
   modes). Keys are snake_case, permanent once data exists against them —
   rename the LABEL freely, never the key. Extend via the admin seam below,
   not by free-typing in a UI. "no_defect_found" is deliberate: negative
   examples are as valuable to a model as positives. */
var AI_ISSUE_LABELS = [
  { key: "ponding_water",         label: "Ponding water" },
  { key: "flashing_failed",       label: "Failed / lifted flashing" },
  { key: "open_seam",             label: "Open seam / lap failure" },
  { key: "membrane_split",        label: "Split / cracked membrane" },
  { key: "blister",               label: "Blister" },
  { key: "fastener_backout",      label: "Fastener back-out" },
  { key: "puncture",              label: "Puncture / tear" },
  { key: "drain_clogged",         label: "Clogged / failed drain" },
  { key: "scupper_blocked",       label: "Blocked / failed scupper" },
  { key: "pitch_pan_deteriorated",label: "Deteriorated pitch pan / sealant pocket" },
  { key: "coping_failure",        label: "Coping / counterflashing failure" },
  { key: "penetration_seal_failed", label: "Failed penetration seal / boot" },
  { key: "expansion_joint_failed",label: "Expansion joint failure" },
  { key: "granule_loss",          label: "Granule loss / surface erosion" },
  { key: "alligatoring",          label: "Alligatoring / coating failure" },
  { key: "ridging_wrinkling",     label: "Ridging / wrinkling" },
  { key: "hail_damage",           label: "Hail damage" },
  { key: "wind_uplift",           label: "Wind uplift / displaced membrane" },
  { key: "debris_accumulation",   label: "Debris accumulation" },
  { key: "vegetation_growth",     label: "Vegetation growth" },
  { key: "skylight_failure",      label: "Skylight / roof hatch failure" },
  { key: "equipment_related",     label: "HVAC / equipment-related leak" },
  { key: "wall_intrusion",        label: "Wall / masonry water intrusion (not roof)" },
  { key: "insulation_saturated",  label: "Saturated insulation / wet area" },
  { key: "no_defect_found",       label: "No defect found" },
  { key: "other",                 label: "Other (describe)" }
];

var AI_LABEL_SOURCES = ["leak", "inspection", "workorder"];
var AI_LABEL_SCHEMA_VERSION = 1;
var AI_LABELS_COLLECTION = "ai_training_labels";

/* ---- admin seam: extendable vocabulary ----
   Extra labels live in app_settings/ai_label_vocab ({ extraLabels:
   [{key,label}], updatedAt }) — the app_settings collection is already
   world-readable / server-write-only (firestore.rules), so extending the
   vocabulary is a data change (future admin.js `set_ai_label_vocab`
   action, or a one-off Console edit), never a code deploy. Loaded lazily,
   best-effort, cached for the session; a missing doc or offline read just
   means the built-in list. */
var aiLabelVocabExtra = null; // null = not loaded yet; [] = loaded, none
function loadAiLabelVocabExtra(){
  if (aiLabelVocabExtra !== null) return Promise.resolve(aiLabelVocabExtra);
  if (typeof fdb === "undefined" || !fdb){ return Promise.resolve([]); }
  return fdb.collection("app_settings").doc("ai_label_vocab").get().then(function(snap){
    var extra = (snap.exists && Array.isArray(snap.data().extraLabels)) ? snap.data().extraLabels : [];
    aiLabelVocabExtra = extra.filter(function(e){
      return e && typeof e.key === "string" && /^[a-z0-9_]{2,60}$/.test(e.key) &&
             typeof e.label === "string" && e.label.trim();
    });
    return aiLabelVocabExtra;
  }).catch(function(){ return []; }); // cache stays null — retried next call
}
function aiLabelVocabulary(){
  return AI_ISSUE_LABELS.concat(aiLabelVocabExtra || []);
}
function aiLabelKeys(){
  return aiLabelVocabulary().map(function(e){ return e.key; });
}

function aiLabelGenId(){
  return "ail_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---- photo reference (never a URL) ----
   Three kinds, mirroring where a photo actually lives today:
   - "storage":  Firebase Storage via netlify/functions/photos.js —
                 identified by workOrderId + photoIndex, the same pair the
                 server's storagePathFor() builds paths from. The record
                 stores the pair, never the path and never a URL.
   - "companycam": a CompanyCam-hosted photo — companyCamPhotoId
                 (+ companyCamProjectId when known).
   - "workorder_embedded": legacy base64 photo still inline on the
                 workorder doc — identified the same way as "storage"
                 (workOrderId + photoIndex) so the reference survives the
                 photo-storage migration unchanged. */
function aiLabelNormalizePhotoRef(photo){
  if (!photo || typeof photo !== "object") return null;
  var kind = photo.kind;
  if (kind === "companycam"){
    if (typeof photo.companyCamPhotoId !== "string" || !photo.companyCamPhotoId) return null;
    return {
      kind: "companycam",
      companyCamPhotoId: photo.companyCamPhotoId,
      companyCamProjectId: (typeof photo.companyCamProjectId === "string" && photo.companyCamProjectId) || null
    };
  }
  if (kind === "storage" || kind === "workorder_embedded"){
    if (typeof photo.workOrderId !== "string" || !photo.workOrderId) return null;
    if (!Number.isInteger(photo.photoIndex) || photo.photoIndex < 0) return null;
    return { kind: kind, workOrderId: photo.workOrderId, photoIndex: photo.photoIndex };
  }
  return null;
}

/* ---- pin: {lat,lng} (real-world) or {x,y} (base-map pixel space) ----
   Exactly one pair, same convention as finding pins / roof assets. */
function aiLabelNormalizePin(pin){
  if (!pin || typeof pin !== "object") return null;
  var hasLatLng = typeof pin.lat === "number" && isFinite(pin.lat) &&
                  typeof pin.lng === "number" && isFinite(pin.lng);
  var hasXY = typeof pin.x === "number" && isFinite(pin.x) &&
              typeof pin.y === "number" && isFinite(pin.y);
  if (hasLatLng) return { lat: pin.lat, lng: pin.lng, x: null, y: null };
  if (hasXY)     return { lat: null, lng: null, x: pin.x, y: pin.y };
  return null;
}

/* Validates a caller-supplied entry. Returns { ok:true } or
   { ok:false, error } — string errors, meant for console/diagnostics, not
   user-facing copy. Exposed for tests and for callers that want to check
   before offering the confirm button at all. */
function aiLabelValidateEntry(entry){
  if (!entry || typeof entry !== "object") return { ok: false, error: "missing entry" };
  if (AI_LABEL_SOURCES.indexOf(entry.source) === -1)
    return { ok: false, error: "source must be one of: " + AI_LABEL_SOURCES.join(", ") };
  if (typeof entry.label !== "string" || aiLabelKeys().indexOf(entry.label) === -1)
    return { ok: false, error: "label must be a key from aiLabelVocabulary()" };
  if (entry.label === "other" && !(typeof entry.labelOther === "string" && entry.labelOther.trim()))
    return { ok: false, error: 'label "other" requires labelOther text' };
  if (typeof entry.buildingId !== "string" || !entry.buildingId.trim())
    return { ok: false, error: "buildingId (the STORED building doc id) is required" };
  if (!aiLabelNormalizePhotoRef(entry.photo))
    return { ok: false, error: "photo must be a valid reference (storage/companycam/workorder_embedded), never a URL" };
  if (entry.pin != null && !aiLabelNormalizePin(entry.pin))
    return { ok: false, error: "pin must be {lat,lng} or {x,y} numbers (or omitted)" };
  return { ok: true };
}

/* Builds the exact Firestore document from a validated entry. Rebuilds
   every field explicitly — unknown caller keys are dropped, so a caller
   can pass its whole UI state object without polluting the record. */
function aiLabelBuildDoc(entry, uid){
  var str = function(v, max){ return (typeof v === "string" ? v : "").slice(0, max || 500); };
  return {
    schemaVersion: AI_LABEL_SCHEMA_VERSION,
    source: entry.source,                          // "leak" | "inspection" | "workorder"
    label: entry.label,                            // controlled-vocabulary key
    labelOther: str(entry.labelOther, 200),        // only meaningful when label === "other"
    likelyCause: str(entry.likelyCause, 500),      // tech's short free-text cause
    photo: aiLabelNormalizePhotoRef(entry.photo),  // reference, NEVER a URL
    pin: aiLabelNormalizePin(entry.pin),           // {lat,lng,x,y} or null
    roofId: str(entry.roofId, 100) || "roof_default",
    roofSystem: str(entry.roofSystem, 100),        // material snapshot if known
    roofAgeYears: (typeof entry.roofAgeYears === "number" && isFinite(entry.roofAgeYears))
      ? entry.roofAgeYears : null,                 // from roof.profile installDate/estimatedAgeYears
    buildingId: entry.buildingId,                  // STABLE stored doc id (PR #120), not a recomputed slug
    customerId: str(entry.customerId, 200) || null,
    workOrderId: str(entry.workOrderId, 200) || null,
    findingId: str(entry.findingId, 100) || null,
    confirmedByUid: uid,                           // rules require this to match request.auth.uid
    confirmedByName: str(entry.confirmedByName, 120),
    confirmedAt: Date.now(),                       // plain number, same convention as audit_logs.ts
    createdAt: Date.now()
  };
}

/* THE write-path helper other modules call. One confirmed/corrected label
   -> one row. Never throws; never blocks the calling flow.

   recordConfirmedLabel({
     source: "leak",                       // "leak" | "inspection" | "workorder"
     label: "ponding_water",              // key from aiLabelVocabulary()
     labelOther: "",                      // required text iff label === "other"
     likelyCause: "Clogged drain upslope",// optional free text
     photo: { kind:"storage", workOrderId, photoIndex },   // or companycam kind
     pin: { lat, lng } | { x, y } | null,
     buildingId,                          // REQUIRED — stored building doc id
     customerId, workOrderId, findingId,  // optional context ids
     roofId, roofSystem, roofAgeYears,    // optional roof snapshot
     confirmedByName                      // optional tech display name
   }) -> Promise<{ ok:true, id } | { ok:false, error }> */
function recordConfirmedLabel(entry){
  return loadAiLabelVocabExtra().then(function(){
    var v = aiLabelValidateEntry(entry);
    if (!v.ok) return { ok: false, error: v.error };
    if (typeof fdb === "undefined" || !fdb)
      return { ok: false, error: "Firestore unavailable" };
    var user = (typeof fauth !== "undefined" && fauth && fauth.currentUser) ? fauth.currentUser : null;
    if (!user || !user.uid)
      return { ok: false, error: "not signed in — training labels require an authenticated tech" };
    var id = aiLabelGenId();
    var doc = aiLabelBuildDoc(entry, user.uid);
    return fdb.collection(AI_LABELS_COLLECTION).doc(id).set(doc).then(function(){
      return { ok: true, id: id };
    });
  }).catch(function(e){
    try{ console.warn("ai label write failed (flow unaffected):", e && e.message ? e.message : e); }catch(_){ }
    return { ok: false, error: (e && e.message) || "write failed" };
  });
}
