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
  { key: "sealant_deteriorated",  label: "Deteriorated sealant / caulk / mastic" },
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
  { key: "indeterminate",         label: "Indeterminate / can't tell from photo" },
  { key: "other",                 label: "Other (describe)" }
];
/* no_defect_found vs indeterminate is a deliberate distinction: "looked,
   confirmed nothing wrong" and "couldn't tell from this photo" are different
   training signals — collapsing them would teach a model that unreadable
   photos are clean roofs.

   PARITY CONTRACT: netlify/functions/lib/aiProvider.js's ISSUE_VOCABULARY
   (what the issue-ID model may answer with) must stay a SUBSET of these
   keys, so a model suggestion the tech confirms is always storable as a
   training label with no mapping table. Enforced by the parity test in
   tests/aiLabels.test.js — extend both lists together (or only this one;
   this one may be a superset). */

var AI_LABEL_SOURCES = ["leak", "inspection", "workorder"];
/* schemaVersion 2 (Mark, approved 2026-07-19): v1 recorded only the CONFIRMED
   answer. For fine-tuning, the disagreement is the signal -- a row where the
   tech OVERRODE the model is worth more than one where he agreed, and v1 threw
   that away. v2 adds what the model predicted alongside what the tech decided,
   so every correction becomes a labelled error case.

   Additive only: v1 rows stay readable, and every v2 field is optional at the
   rules layer. A label recorded with no prediction (a tech labelling a photo
   the AI never saw) is still a valid v2 row -- predicted* simply stays null and
   `agreed` stays null rather than being forced to a misleading false.

   COUPLING: firestore.rules pins this number. Bumping it here without
   shipping the matching rules change means every write is REJECTED in
   production. The rule now accepts [1, 2] so a stale client mid-deploy can
   still write v1. */
var AI_LABEL_SCHEMA_VERSION = 2;

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
/* Cause vocabulary -- the browser-side mirror of CAUSE_VOCABULARY in
   netlify/functions/lib/aiProvider.js. Hand-synced, same discipline as the
   issue-label parity contract above and getBuildingRoofsServer(): the
   browser/CommonJS split means there is no shared import, so a parity test
   guards the two lists instead. */
var AI_CAUSE_LABELS = [
  { key: "weathering_age",          label: "Weathering / age" },
  { key: "mechanical_damage",       label: "Mechanical damage" },
  { key: "foot_traffic",            label: "Foot traffic" },
  { key: "storm_event",             label: "Storm event" },
  { key: "installation_defect",     label: "Installation defect" },
  { key: "debris_accumulation",     label: "Debris accumulation" },
  { key: "thermal_movement",        label: "Thermal movement" },
  { key: "drainage_deficiency",     label: "Drainage deficiency" },
  { key: "previous_repair_failure", label: "Previous repair failure" },
  { key: "unconfirmed",             label: "Unconfirmed" }
];
function aiLabelCauseKeys(){
  return AI_CAUSE_LABELS.map(function(c){ return c.key; });
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
    /* IDENTITY IS photoLocalId, NOT THE INDEX. photos[] is spliced on every
       delete and re-ordered freely, so a stored position silently starts
       pointing at a DIFFERENT photo the moment one before it is removed --
       and a training row that names the wrong photo is worse than no row,
       because nothing about it looks wrong afterwards.
       photoIndex is still recorded when present, but only as a positional
       SNAPSHOT for forensics; never resolve a photo by it. Accepting either
       keeps rows writable for a photo that predates localId. */
    var localId = (typeof photo.photoLocalId === "string" && photo.photoLocalId) ? photo.photoLocalId : null;
    var idx = (Number.isInteger(photo.photoIndex) && photo.photoIndex >= 0) ? photo.photoIndex : null;
    if (!localId && idx === null) return null;
    var ref = { kind: kind, workOrderId: photo.workOrderId };
    if (localId) ref.photoLocalId = localId;
    if (idx !== null) ref.photoIndexSnapshot = idx;
    return ref;
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
    /* CONTROLLED (Mark, approved 2026-07-19): cause was free text, which is
       useless for training -- "clogged drain", "drain blocked" and "debris in
       drain" are one class typed three ways. It is now a CAUSE_VOCABULARY key,
       with the tech's own wording preserved separately in causeNote so nothing
       he wanted to say is lost. */
    likelyCause: (aiLabelCauseKeys().indexOf(entry.likelyCause) !== -1) ? entry.likelyCause : "unconfirmed",
    causeNote: str(entry.causeNote, 500),          // optional free text alongside the key

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
    /* ---- v2: what the MODEL said, alongside what the TECH decided ---- */
    predictedLabel: str(entry.predictedLabel, 60) || null,      // vocab key the model returned
    predictedCause: str(entry.predictedCause, 60) || null,      // vocab key, not free text
    predictedConfidence: (["low","medium","high"].indexOf(entry.predictedConfidence) !== -1)
      ? entry.predictedConfidence : null,
    /* DERIVED, never taken from the caller: did the tech accept the call?
       null when there was no prediction to agree with -- distinct from false,
       which means the model was actively overridden. Conflating the two would
       poison the error set with rows the model never saw. */
    agreed: (typeof entry.predictedLabel === "string" && entry.predictedLabel)
      ? (entry.predictedLabel === entry.label) : null,
    modelId: str(entry.modelId, 80) || null,                    // which model made the call
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

/* ================= Phase 1 + 2: per-photo issue ID, confirm/correct =========
   Mark's learning pipeline. Phase 1 asks the vision model what it sees in ONE
   leak/finding photo; Phase 2 lets the tech confirm or correct that call, and
   THAT is what becomes a training row.

   Why the tech's answer is the product and the model's is not: an unreviewed
   guess is not training data, it is noise with a confidence score attached. A
   row is only written on a human decision, and it records BOTH what the model
   said and what the tech decided -- so a correction is a labelled error case
   rather than a silently discarded guess.

   On-demand per photo (a button, never automatic on capture) for the same
   reason the summary is button-triggered: the tap IS the cost control. One
   photo is roughly a fifth of a summary's image cost.

   Keyless deploys show the same friendly "coming soon" the summary uses --
   one gate, one behaviour, no half-wired state. */

var aiIssueState = {};   /* photoIndex -> { loading, result, error, dismissed, correcting } */

function aiIssueHostId(gi){ return "ai-issue-" + gi; }

/* The per-photo control + chip container, rendered inside each finding photo
   item. Empty until the tech asks. */
function aiIssueChipHtml(gi){
  return '<div class="ai-issue-wrap" id="' + aiIssueHostId(gi) + '">' + aiIssueInnerHtml(gi) + '</div>';
}
function aiIssueInnerHtml(gi){
  var st = aiIssueState[gi];
  if (!st || st.dismissed){
    return '<button class="btn" style="margin-top:4px" onclick="aiIdentifyPhotoIssue(' + gi + ')">&#128269; Identify issue</button>';
  }
  if (st.loading) return '<p class="hint" style="margin:4px 0">Looking at this photo&hellip;</p>';
  if (st.error){
    return '<p class="hint" style="margin:4px 0">' + esc(st.error) +
      ' <a href="#" onclick="aiIdentifyPhotoIssue(' + gi + ');return false;">try again</a></p>';
  }
  var r = st.result || {};
  var issueOpts = aiLabelVocabulary().map(function(v){
    return '<option value="' + esc(v.key) + '"' + (v.key === r.issue ? ' selected' : '') + '>' + esc(v.label) + '</option>';
  }).join("");
  var causeOpts = AI_CAUSE_LABELS.map(function(c){
    return '<option value="' + esc(c.key) + '"' + (c.key === r.likelyCause ? ' selected' : '') + '>' + esc(c.label) + '</option>';
  }).join("");
  return '<div class="ai-issue-chip" style="margin:4px 0;padding:6px 8px;background:#EAF4FF;border-left:4px solid #0d3c61;border-radius:4px">' +
    '<div><b>Looks like:</b> ' + esc(aiIssueLabelText(r.issue)) +
      (r.likelyCause ? ' &middot; ' + esc(aiIssueCauseText(r.likelyCause)) : "") +
      (r.confidence ? ' &middot; <span class="hint" style="margin:0">' + esc(r.confidence) + ' confidence</span>' : "") +
    '</div>' +
    (r.rationale ? '<div class="hint" style="margin:2px 0 0">' + esc(r.rationale) + '</div>' : "") +
    '<div class="btnrow" style="margin:6px 0 0">' +
      '<button class="btn primary" onclick="aiConfirmPhotoIssue(' + gi + ', false)">Confirm</button>' +
      '<button class="btn" onclick="aiToggleCorrectPhotoIssue(' + gi + ')">Correct</button>' +
      '<button class="btn" onclick="aiDismissPhotoIssue(' + gi + ')">Dismiss</button>' +
    '</div>' +
    (!st.correcting ? "" :
      '<div style="margin-top:6px">' +
        '<div class="fld" style="margin-bottom:6px"><label>Issue</label>' +
          '<select id="ai-issue-sel-' + gi + '">' + issueOpts + '</select></div>' +
        '<div class="fld" style="margin-bottom:6px"><label>Likely cause</label>' +
          '<select id="ai-cause-sel-' + gi + '">' + causeOpts + '</select></div>' +
        '<div class="fld" style="margin-bottom:6px"><label>Note (optional)</label>' +
          '<input type="text" id="ai-cause-note-' + gi + '" placeholder="anything the dropdowns miss"></div>' +
        '<button class="btn primary" onclick="aiConfirmPhotoIssue(' + gi + ', true)">Save correction</button>' +
      '</div>') +
    '</div>';
}
function aiIssueLabelText(key){
  var v = aiLabelVocabulary().find(function(x){ return x.key === key; });
  return v ? v.label : (key || "unclear");
}
function aiIssueCauseText(key){
  var c = AI_CAUSE_LABELS.find(function(x){ return x.key === key; });
  return c ? c.label : key;
}
function aiIssueRerender(gi){
  var host = document.getElementById(aiIssueHostId(gi));
  if (host) host.innerHTML = aiIssueInnerHtml(gi);
}
function aiToggleCorrectPhotoIssue(gi){
  var st = aiIssueState[gi];
  if (!st) return;
  st.correcting = !st.correcting;
  aiIssueRerender(gi);
}
function aiDismissPhotoIssue(gi){
  aiIssueState[gi] = { dismissed: true };
  aiIssueRerender(gi);
}

/* Phase 1 -- ask the model. Sends the SHARED ~900px downscale
   (aiVisionImagePart in js/export.js), never the full-res capture: same
   reasoning as the summary, roughly a third of the image tokens for detail the
   model can actually use. */
async function aiIdentifyPhotoIssue(gi){
  var p = photos[gi];
  if (!p) return;
  /* Same keyless gate as the summary button -- one probe, one behaviour. */
  var configured = (typeof aiSummaryConfigured === "function") ? aiSummaryConfigured() : null;
  if (configured === null && typeof probeAiSummaryCapability === "function"){
    try{ configured = await probeAiSummaryCapability(); }catch(e){ configured = false; }
  }
  if (!configured){ toast("AI issue ID — coming soon"); return; }

  aiIssueState[gi] = { loading: true };
  aiIssueRerender(gi);
  try{
    var img = (typeof aiVisionImagePart === "function" && p.img) ? await aiVisionImagePart(p.img) : null;
    var o = (typeof collect === "function") ? collect() : {};
    var body = {
      action: "issue_id",
      context: {
        woType: o.woType, jobName: o.jobName, roofSystem: o.roofSystem,
        reportedArea: o.reportedArea, notes: p.caption || ""
      }
    };
    if (img) body.photoImage = img;
    else if (p.storageUrl) body.photoUrl = p.storageUrl;
    var r = await fetch("/.netlify/functions/ai-service", {
      method: "POST", headers: await authHeaders(), body: JSON.stringify(body)
    });
    var out = null; try{ out = await r.json(); }catch(e){}
    if (!r.ok || !out || !out.ok){
      aiIssueState[gi] = { error: (out && out.error) || ("Couldn't reach the model (" + r.status + ")") };
    } else {
      aiIssueState[gi] = { result: Object.assign({}, out.result, { model: out.model, llm: out.llm }) };
    }
  }catch(e){
    aiIssueState[gi] = { error: "Couldn't reach the model." };
  }
  aiIssueRerender(gi);
}

/* Phase 2 -- the tech's decision becomes ONE training row. Carries the roof
   snapshot (system + age) from the multi-roof profile, and the model's own
   call, so an override is stored as a labelled error rather than lost. */
async function aiConfirmPhotoIssue(gi, corrected){
  var st = aiIssueState[gi];
  var p = photos[gi];
  if (!st || !st.result || !p) return;
  var predicted = st.result;
  var label = predicted.issue, cause = predicted.likelyCause, note = "";
  if (corrected){
    var ls = document.getElementById("ai-issue-sel-" + gi);
    var cs = document.getElementById("ai-cause-sel-" + gi);
    var ns = document.getElementById("ai-cause-note-" + gi);
    if (ls) label = ls.value;
    if (cs) cause = cs.value;
    if (ns) note = ns.value || "";
  }
  var o = (typeof collect === "function") ? collect() : {};
  var buildingId = o.buildingId ||
    (typeof buildingIdFor === "function" ? buildingIdFor(o.billTo, o.jobName) : null);
  if (!buildingId){
    toast("Add the job name and address first — a training label belongs to a building.");
    return;
  }
  /* Roof snapshot taken AT CONFIRM TIME on purpose: a roof re-roofed two years
     from now must not silently rewrite what the roof was when this photo was
     taken. Training rows are historical facts, not live joins. */
  var roofId = p.roofId || o.roofId || null;
  var roofSystem = "", roofAge = null;
  try{
    if (roofId && typeof inspectionRoofSystemCache !== "undefined" && inspectionRoofSystemCache[roofId]){
      roofSystem = inspectionRoofSystemCache[roofId];
    }
    if (roofId && typeof inspectionRoofProfileCache !== "undefined" && inspectionRoofProfileCache[roofId]
        && typeof inspectionRoofAgeYears === "function"){
      roofAge = inspectionRoofAgeYears(inspectionRoofProfileCache[roofId]);
    }
  }catch(e){}
  if (!roofSystem) roofSystem = o.roofSystem || "";

  var source = (o.woType === "Inspection") ? "inspection"
    : ((typeof WORK_ORDER_TYPES !== "undefined" && o.woType === WORK_ORDER_TYPES[0]) ? "leak" : "workorder");

  var res = await recordConfirmedLabel({
    source: source,
    label: label,
    likelyCause: cause,
    causeNote: note,
    predictedLabel: predicted.issue || null,
    predictedCause: predicted.likelyCause || null,
    predictedConfidence: predicted.confidence || null,
    modelId: predicted.model || null,
    /* photoLocalId is the durable reference; gi is this render's position and
       is kept only as a snapshot (see aiLabelCleanPhotoRef). */
    photo: { kind: "workorder_embedded", workOrderId: o.id,
             photoLocalId: (p && p.localId) || null, photoIndex: gi },
    pin: p.gps || null,
    buildingId: buildingId,
    customerId: o.customerId || null,
    workOrderId: o.id || null,
    findingId: p.finding_id || null,
    roofId: roofId || undefined,
    roofSystem: roofSystem,
    roofAgeYears: roofAge,
    confirmedByName: (typeof currentUserName === "string" ? currentUserName : "")
  });
  if (res && res.ok){
    aiIssueState[gi] = { dismissed: true };
    aiIssueRerender(gi);
    toast(corrected ? "Correction saved to training data" : "Confirmed — saved to training data");
  } else {
    toast("Couldn't save that label: " + ((res && res.error) || "unknown"));
  }
}
