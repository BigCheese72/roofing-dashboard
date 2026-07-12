"use strict";
/* ================= building picker (explicit selection) =================
   Phase 2 roadmap item: "explicit customer/building picker UI in the Edit
   tab, replacing the current implicit derive-from-text-fields approach,
   while keeping the same Firestore shape." Deliberately a thin UX layer,
   not a schema change: picking a building just fills the same
   jobName/billTo/location/roofSystem inputs ensureCustomerAndBuilding()
   already reads, with the exact text already on that building doc — so
   its slugified id derivation lands on the same customer/building record
   it already would have from typing the same thing by hand. This doesn't
   replace the text fields (typing a brand-new job/customer still works
   exactly as before); it only cuts down on typo-created duplicate
   buildings/customers by letting a tech pick an existing one by name. */
var bpCache = null;
async function openBuildingPicker(){
  document.getElementById("bp-modal").style.display = "";
  lockBodyScroll();
  document.getElementById("bp-search").value = "";
  var list = document.getElementById("bp-list");
  list.className = "hint";
  list.textContent = "Loading buildings…";
  bpCcCache = [];
  bpRenderCcList(); /* clears/resets the CC section's "Loading…" from a previous open */
  if (!fdb){
    list.textContent = "Building picker needs cloud sync (internet connection) to load.";
  } else {
    try{
      var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(200).get();
      bpCache = [];
      qs.forEach(function(d){
        var b = Object.assign({ id: d.id }, d.data());
        if (!b.archived) bpCache.push(b); /* archived buildings stay out of every default picker -- see "Building archive" in DEV_NOTES.md */
      });
      bpRender(bpCache);
    }catch(e){
      list.className = "hint";
      list.textContent = "Couldn't load buildings: " + e.message;
    }
  }
  /* CompanyCam browse/search is entirely separate from the buildings load
     above -- neither blocks the other, so a slow/unavailable CompanyCam API
     never holds up the (usually much faster) existing-buildings list. See
     "Change Order building picker" in DEV_NOTES.md. */
  bpSearchCompanyCam("");
}
function closeBuildingPicker(){
  document.getElementById("bp-modal").style.display = "none";
  unlockBodyScroll();
  if (bpCcDebounceTimer) clearTimeout(bpCcDebounceTimer);
}
function bpFilter(){
  if (!bpCache) return;
  var q = document.getElementById("bp-search").value.trim().toLowerCase();
  if (!q){ bpRender(bpCache); return; }
  bpRender(bpCache.filter(function(b){
    return (b.name || "").toLowerCase().indexOf(q) > -1 ||
      (b.customerName || "").toLowerCase().indexOf(q) > -1 ||
      (b.location || "").toLowerCase().indexOf(q) > -1;
  }));
}
function bpRender(list){
  var host = document.getElementById("bp-list");
  if (!list.length){ host.className = "hint"; host.textContent = "No buildings found."; return; }
  host.className = "";
  host.innerHTML = list.map(function(b){
    return '<div class="bld-item" onclick="bpSelectBuilding(\'' + b.id + '\')"><div class="info">' +
      '<div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta">' + esc(b.customerName || "") + (b.location ? ' · ' + esc(b.location) : "") +
      (b.roofSystem ? ' · ' + esc(b.roofSystem) : "") +
      (b.companyCamProjectId ? ' · 🔗 CompanyCam linked' : "") + '</div></div>' +
      '<button class="btn">Select</button></div>';
  }).join("");
}
/* ---- CompanyCam merge (Mark's ask: "Select Existing Building" should
   surface the WHOLE CompanyCam project file, not just buildings already
   created in this app) ----
   Debounced separately from bpFilter() (which is instant/local against the
   already-loaded bpCache) since this one is a real network round-trip.
   Dedupes against EVERY loaded app building (not just the currently
   filtered/visible ones) so a CompanyCam project already linked to some
   building never shows twice regardless of search state -- "prefer the app
   building record" per spec. See "Change Order building picker" in
   DEV_NOTES.md. */
var bpCcCache = [];
var bpCcDebounceTimer = null;
function bpDebouncedCcSearch(){
  if (bpCcDebounceTimer) clearTimeout(bpCcDebounceTimer);
  var q = document.getElementById("bp-search").value.trim();
  bpCcDebounceTimer = setTimeout(function(){ bpSearchCompanyCam(q); }, 400);
}
async function bpSearchCompanyCam(q){
  var host = document.getElementById("bp-cc-list");
  if (host){ host.className = "hint"; host.textContent = "Searching CompanyCam…"; }
  try{
    var out = await ccApi({ action: "projects", q: q || "" });
    bpCcCache = out.projects || [];
    bpRenderCcList();
  }catch(e){
    bpCcCache = [];
    if (host){
      host.className = "hint";
      host.textContent = "Couldn't reach CompanyCam right now — showing existing buildings only.";
    }
  }
}
/* Deduped subset actually rendered/selectable -- kept separate from
   bpCcCache (the raw fetch result) specifically so the onclick index below
   always matches what's on screen. Indexing into bpCcCache directly here
   was a real bug: once dedup removes an earlier entry, every later
   CompanyCam-only row's index no longer lines up with its position in the
   raw array, so tapping "Select" silently linked the WRONG CompanyCam
   project/building. Caught in testing, not shipped. */
var bpCcVisibleCache = [];
function bpRenderCcList(){
  var host = document.getElementById("bp-cc-list");
  if (!host) return;
  var linkedIds = {};
  (bpCache || []).forEach(function(b){ if (b.companyCamProjectId) linkedIds[b.companyCamProjectId] = true; });
  bpCcVisibleCache = bpCcCache.filter(function(p){ return !linkedIds[p.id]; });
  if (!bpCcVisibleCache.length){
    host.className = "hint";
    host.textContent = "No other CompanyCam projects found.";
    return;
  }
  host.className = "";
  host.innerHTML = bpCcVisibleCache.map(function(p, i){
    return '<div class="bld-item" onclick="bpSelectCompanyCamProject(' + i + ')"><div class="info">' +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="meta">' + (p.address ? esc(p.address) : "") + ' · ☁️ CompanyCam only</div></div>' +
      '<button class="btn">Select</button></div>';
  }).join("");
}
async function bpSelectCompanyCamProject(i){
  var p = bpCcVisibleCache[i];
  if (!p) return;
  setVal("jobName", p.name || "");
  setVal("location", p.address || "");
  ccLinkedProjectId = p.id;
  ccLinkedProjectName = p.name || "";
  renderCCLinkInfo();
  closeBuildingPicker();
  toast("Loaded “" + p.name + "” from CompanyCam — review the fields below before saving");
  /* Creates/links a real building record right away (not deferred to save)
     so RoofMapper/Building History/reports all have something to attach to
     immediately, matching how RoofMapper's "create a new building" flow
     already works (ensureCustomerAndBuilding() is the same idempotent
     upsert, keyed off billTo+jobName -- calling it again at save time, or
     from RoofMapper later, just merges into the same building doc, never
     creates a duplicate). */
  try{
    await ensureCustomerAndBuilding({
      jobName: p.name || "", billTo: val("billTo") || "", location: p.address || "",
      roofSystem: val("roofSystem") || "", companyCamProjectId: p.id
    });
  }catch(e){ console.warn("Couldn't create/link building from CompanyCam project", e); }
}
function bpSelectBuilding(buildingId){
  var b = (bpCache || []).find(function(x){ return x.id === buildingId; });
  if (!b) return;
  setVal("jobName", b.name || "");
  setVal("billTo", b.customerName || "");
  setVal("location", b.location || "");
  setVal("roofSystem", b.roofSystem || "");
  /* Previously only copied plain fields — the building's CompanyCam link
     (shown right here in the picker as "🔗 CompanyCam linked") never
     carried over, so a work order for an already-linked building silently
     stayed unlinked unless the tech separately used Import from CompanyCam
     too. That's the root cause behind report PDFs missing from CompanyCam
     for repeat-building jobs — see "CompanyCam PDF upload gaps" in
     DEV_NOTES.md. Only sets it if this work order isn't already linked to
     something else (never clobbers an explicit Import-from-CompanyCam
     link the tech already made in this session). */
  if (b.companyCamProjectId && !ccLinkedProjectId){
    ccLinkedProjectId = b.companyCamProjectId;
    ccLinkedProjectName = b.companyCamProjectName || "";
    renderCCLinkInfo();
  }
  closeBuildingPicker();
  toast("Loaded “" + b.name + "” — review the fields below before saving");
}

/* ---- Move/reassign a roof to a different building ----
   Mark: traced a roof onto the wrong building, no way out short of
   admin-deleting the whole wrong building (destroying everything else on
   it too). A roof isn't just a roofs[] array entry -- building_history_
   events/reports docs reference it by (buildingId, roofId) pair too (see
   DATA_MODEL.md) -- so the actual move happens server-side, in one atomic
   batch, via admin.js's move_roof action (Admin SDK, claims/permission-
   gated + audited, same treatment as every other cross-cutting
   building/roof write in this app). This modal is just the destination
   picker. See "Move/reassign a
   roof to a different building" in DEV_NOTES.md. */
var mrCache = null, mrSourceBuildingId = null, mrRoofId = null, mrRoofLabel = "";
async function openMoveRoofModal(sourceBuildingId, roofId, roofLabel){
  if (!isAdmin){ toast("Admin mode required to move a roof."); return; }
  mrSourceBuildingId = sourceBuildingId;
  mrRoofId = roofId;
  mrRoofLabel = roofLabel || "this roof";
  document.getElementById("mr-modal").style.display = "";
  lockBodyScroll();
  document.getElementById("mr-hint").textContent = "Pick the building “" + mrRoofLabel + "” actually belongs on.";
  document.getElementById("mr-search").value = "";
  var list = document.getElementById("mr-list");
  list.className = "hint";
  list.textContent = "Loading buildings…";
  if (!fdb){
    list.textContent = "Moving a roof needs cloud sync (internet connection) to load buildings.";
    return;
  }
  try{
    var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(200).get();
    mrCache = [];
    qs.forEach(function(d){
      /* Excludes the source building itself (can't move a roof "to" the
         building it's already on) and archived buildings (moving a roof
         onto something Mark deliberately archived would be confusing --
         unarchive it first if that's really the intent). */
      if (d.id === sourceBuildingId) return;
      var b = Object.assign({ id: d.id }, d.data());
      if (b.archived) return;
      mrCache.push(b);
    });
    mrRender(mrCache);
  }catch(e){
    list.className = "hint";
    list.textContent = "Couldn't load buildings: " + e.message;
  }
}
function closeMoveRoofModal(){
  document.getElementById("mr-modal").style.display = "none";
  unlockBodyScroll();
}
function mrFilter(){
  if (!mrCache) return;
  var q = document.getElementById("mr-search").value.trim().toLowerCase();
  if (!q){ mrRender(mrCache); return; }
  mrRender(mrCache.filter(function(b){
    return (b.name || "").toLowerCase().indexOf(q) > -1 ||
      (b.customerName || "").toLowerCase().indexOf(q) > -1 ||
      (b.location || "").toLowerCase().indexOf(q) > -1;
  }));
}
function mrRender(list){
  var host = document.getElementById("mr-list");
  if (!list.length){ host.className = "hint"; host.textContent = "No other buildings found."; return; }
  host.className = "";
  host.innerHTML = list.map(function(b){
    return '<div class="bld-item" onclick="mrSelectDestination(\'' + b.id + '\')"><div class="info">' +
      '<div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta">' + esc(b.customerName || "") + (b.location ? ' · ' + esc(b.location) : "") + '</div></div>' +
      '<button class="btn primary">Move Here</button></div>';
  }).join("");
}
async function mrSelectDestination(destBuildingId){
  var b = (mrCache || []).find(function(x){ return x.id === destBuildingId; });
  if (!b) return;
  if (!confirm('Move “' + mrRoofLabel + '” to “' + (b.name || "this building") + '”? ' +
    "Its outline, features, and every timeline entry/report for it move with it. This can be done again to undo it " +
    "(move it right back), but isn't instant to reverse -- double check this is the right building.")) return;
  toast("Moving roof…");
  try{
    var out = await callAdminApi({ action: "move_roof", sourceBuildingId: mrSourceBuildingId,
      destBuildingId: destBuildingId, roofId: mrRoofId });
    closeMoveRoofModal();
    toast('Moved to “' + b.name + '” ✓ (' + out.movedEvents + ' history entries, ' + out.movedReports + ' reports carried over)');
    /* The source building no longer has this roof -- if RoofMapper currently
       has it open, that link is now stale (pointing at a roof that's gone
       from this building), so drop it rather than leaving a phantom "linked"
       state that would silently save any further edits to the WRONG place. */
    if (rmState.linkedBuildingId === mrSourceBuildingId && rmState.linkedRoofId === mrRoofId){
      rmClearFootprintLayers();
      rmSetStatus('This roof moved to “' + b.name + '” — open it there from Building History.');
    }
    if (currentViewName === "history") openBuildingHistory(mrSourceBuildingId);
  }catch(e){ toast("Couldn't move roof: " + e.message); }
}

function computeWarrantyStatus(o){
  var w = (o.warrantable || "").trim(), n = (o.nonWarrantable || "").trim();
  if (w && n) return "Mixed";
  if (w) return "Warrantable";
  if (n) return "Non-warrantable";
  var filled = (o.findings || []).filter(function(f){ return f.condition || f.location; });
  var fw = filled.some(function(f){ return f.warranty === "Warrantable" || f.warranty === "Warrantable condition noted"; });
  var fn = filled.some(function(f){ return f.warranty === "Non-warrantable"; });
  if (fw && fn) return "Mixed";
  if (fw) return "Warrantable";
  if (fn) return "Non-warrantable";
  return "Undetermined";
}

var currentId = null;
var findings = [];
var repairs = [];
var repairItems = []; /* Repair-type only — see wo-repair-card / addRepairItem() */
/* Inspection-type only — component-by-component condition checklist (see
   "Inspection form overhaul" in DEV_NOTES.md). A fixed set of 8 rows
   (ensureInspectionChecklist() backfills any missing ones, always in this
   order), not an addable/removable list like repairItems -- an inspection
   always covers the same components, a tech just rates what applies and
   leaves the rest N/A. linkedFindingId tracks the finding auto-surfaced
   into findings[] when a rating is below Good (see syncInspectionFinding())
   -- null when the rating is Good/N/A, i.e. nothing to surface. */
var INSPECTION_CHECKLIST_COMPONENTS = [
  { key: "membrane", label: "Membrane / Field" },
  { key: "flashings", label: "Flashings & Terminations" },
  { key: "penetrations", label: "Penetrations" },
  { key: "drainage", label: "Drainage (incl. Ponding)" },
  { key: "equipment", label: "Rooftop Equipment" },
  { key: "perimeter", label: "Perimeter / Edge" },
  { key: "interior", label: "Interior (if accessible)" },
  { key: "safety", label: "Safety Hazards" }
];
var INSPECTION_RATINGS = ["Good", "Fair", "Poor", "Critical", "N/A"];
var inspectionChecklist = [];
var photos = [];
// ccLinkedProjectId/ccLinkedProjectName moved to js/core.js -- see the note
// there. Declared in this file originally, but js/companycam.js (loaded
// BEFORE this file) also references them; that only worked by accident of
// which script happened to finish loading first, and broke for real on a
// slow/cold load (production's first-ever page load hit it: a
// ReferenceError thrown from inside the auth-state-change handler, since
// Auth Phase 5's recomputeIsAdmin() now calls updateAdminUI() ->
// renderCCLinkInfo() much earlier in the page lifecycle than before).
/* Change Order-only for now -- { img (PNG data URL), printName, date } or
   null. Captured via the reusable openSignaturePad() (see its definition
   below) -- the SAME modal/component is meant to be reused for other
   forms later (leak-form/non-warranty service-order signing), this is
   just the one field the Change Order flow happens to store its result
   in. See "In-app signature capture" in DEV_NOTES.md. */
var changeOrderSignature = null;
/* Which of the building's roofs (see getBuildingRoofs/DATA_MODEL.md) this
   work order's findings/pins belong to. null means "not chosen yet" —
   treated as the building's first/default roof ("roof_default")
   everywhere this is read, so a single-roof building (all of them,
   before a tech ever adds a second roof) behaves identically to before
   this field existed. Set via the pin modal's roof picker, which only
   appears once a building actually has more than one roof. */
var currentRoofId = null;
/* Multi-roof Inspection (Mark: "he may inspect the whole building or just
   one section" -- support one, several, or ALL roofs in one inspection,
   not the one-roof-per-work-order model every other type still uses).
   null unless an Inspection work order on a multi-roof building has this
   set via renderInspectionRoofPicker()'s checkboxes -- kept in sync with
   currentRoofId (always currentRoofIds[0], the "primary" roof) so every
   existing singular-currentRoofId reader keeps working unchanged. See
   "Inspection multi-roof selector" in DEV_NOTES.md. */
var currentRoofIds = null;
/* Cache of the last lookupProspectiveBuildingRoofInfo() result -- collect()
   needs roof LABELS (not just ids) to denormalize onto the saved work
   order for report rendering (renderLeakReportDoc() is synchronous, no
   Firestore access mid-render), and this is the cheapest way to have them
   on hand without a second fetch. */
var lastLookupRoofInfo = null;
var toastTimer = null;

/* ================= dynamic rows ================= */
function genId(prefix){
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
function addFinding(data){
  /* pin is the roof-map location for this finding — null until placed on a
     map (see placePin()). Every finding gets a stable id so a photo can
     reference it (photo.finding_id) independent of array order. */
  findings.push(data || {id: genId("fnd"), condition:"",location:"",warranty:"Warrantable", pin:null});
  renderFindings();
  renderPhotos(); /* new finding should be immediately selectable in each photo's dropdown */
}
function removeFinding(i){
  var removedId = findings[i] && findings[i].id;
  findings.splice(i,1);
  if (removedId){
    photos.forEach(function(p){ if (p.finding_id === removedId) p.finding_id = null; });
    renderPhotos();
  }
  renderFindings();
}
/* Persistent per-photo indicator when a photo has no location data --
   Mark's real Tri-Delta case: captureDeviceGps() already fired on every
   camera capture, but a failure only ever showed as a transient toast,
   easy to miss mid-shoot on a roof -- 11 of 12 photos on one real visit
   had no gps at all and he never noticed until Building History/
   auto-assign came up empty. This is the lasting, can't-miss version:
   shows right on the photo for as long as it has no location, clickable
   straight to that finding's own pin picker when there's a real finding
   to place it on (checklist items and "General/no finding" photos have
   no such picker to jump to, so the badge is informational-only there --
   findingById() returning falsy for those covers this automatically).
   See "Photo GPS capture" in DEV_NOTES.md. */
function photoGpsBadgeHtml(p, findingId){
  if (p.gps) return "";
  var clickable = !!(findingId && findingById(findingId));
  var reasonText = { denied: "location permission blocked", timeout: "no GPS fix in time",
    unavailable: "location unavailable", unsupported: "location not supported" }[p.gpsFailReason] || "no location captured for this photo";
  return '<div style="background:#FFF3E0;color:#8A5A00;font-size:11px;font-weight:600;padding:3px 7px;' +
    'border-radius:4px;margin-top:3px;display:inline-block' + (clickable ? ';cursor:pointer' : '') + '"' +
    (clickable ? ' onclick="openPinModal(\'' + esc(findingId) + '\')"' : '') +
    ' title="' + esc(reasonText) + '">📍 No location' + (clickable ? ' — tap to place' : '') + '</div>';
}
/* Photo-capture rework, increment 2: photos captured/added here are
   associated with this finding from the moment they're added (via the
   findingId param on addPhotosFromCamera()/addPhotosFromFiles()) --
   caption, GPS-derived pin, and the photo itself all attach in one
   action, no separate section to link up afterward. This reads from and
   writes to the SAME global `photos[]` array the Photo Documentation
   section always has (just filtered to this finding's id), so it's
   fully backward compatible: a work order saved before this shipped
   already has finding_id set (or null) on its photos exactly the same
   way, and displays correctly here with zero migration. The global
   section remains the place for reordering/print-order and any
   "General / no specific finding" photos -- this is a second view onto
   the same data, not a second copy of it. */
function findingPhotoGalleryHtml(f){
  var safeId = esc(f.id);
  var items = photos.map(function(p, gi){ return { p: p, gi: gi }; })
    .filter(function(x){ return x.p.finding_id === f.id; });
  var strip = items.map(function(x){
    return '<div class="finding-photo-item">' +
      ((x.p.thumb || x.p.imgFallback || x.p.img) ? '<img class="thumb" src="' + (x.p.thumb || x.p.imgFallback || x.p.img) + '" onclick="openPhotoLightbox(' + x.gi + ')" title="Tap to enlarge">' : '') +
      '<input type="text" placeholder="Caption" data-findingphoto="' + x.gi + '" value="' + esc(x.p.caption) + '" list="dl-photoCaption" onblur="rememberFieldValue(\'photoCaption\', this.value)">' +
      '<button class="btn danger" onclick="removePhoto(' + x.gi + ')">✕ Remove</button>' +
      photoGpsBadgeHtml(x.p, x.p.finding_id) +
      '</div>';
  }).join("");
  return '<div class="finding-photos">' +
    '<div class="btnrow" style="margin:0">' +
      '<button class="btn primary" onclick="document.getElementById(\'fcam-' + safeId + '\').click()">📷 Take Photo</button>' +
      '<button class="btn" onclick="document.getElementById(\'flib-' + safeId + '\').click()">+ Add Photos</button>' +
      '<button class="btn" onclick="openCC(\'' + safeId + '\')">Import from CompanyCam</button>' +
    '</div>' +
    '<input type="file" id="fcam-' + safeId + '" accept="image/*" capture="environment" style="display:none" ' +
      'onchange="addPhotosFromCamera(this.files, \'' + safeId + '\'); this.value=\'\';">' +
    '<input type="file" id="flib-' + safeId + '" accept="image/*" multiple style="display:none" ' +
      'onchange="addPhotosFromFiles(this.files, \'' + safeId + '\'); this.value=\'\';">' +
    (strip ? '<div class="finding-photo-strip">' + strip + '</div>' : '') +
    '</div>';
}
/* Checklist items only get in-app camera capture -- no library add, no
   CompanyCam import (Mark: doesn't want those on the checklist). The tech
   is photographing the specific condition they're looking at and rating
   right there, not attaching photos from elsewhere. Every capture here
   auto-pins (see maybeAutoPinInspectionItem()) -- the pin is what makes
   this photo a "before" reference a later repair photo at the same spot
   can be compared against (before/after-at-a-pin -- see "Inspection
   checklist photo pinning" in ROADMAP.md/DEV_NOTES.md). */
function inspectionItemPhotoGalleryHtml(item){
  var safeId = esc(item.id);
  var items = photos.map(function(p, gi){ return { p: p, gi: gi }; })
    .filter(function(x){ return x.p.finding_id === item.id; });
  var strip = items.map(function(x){
    return '<div class="finding-photo-item">' +
      ((x.p.thumb || x.p.imgFallback || x.p.img) ? '<img class="thumb" src="' + (x.p.thumb || x.p.imgFallback || x.p.img) + '" onclick="openPhotoLightbox(' + x.gi + ')" title="Tap to enlarge">' : '') +
      '<input type="text" placeholder="Caption" data-findingphoto="' + x.gi + '" value="' + esc(x.p.caption) + '" list="dl-photoCaption" onblur="rememberFieldValue(\'photoCaption\', this.value)">' +
      '<button class="btn danger" onclick="removePhoto(' + x.gi + ')">✕ Remove</button>' +
      photoGpsBadgeHtml(x.p, x.p.finding_id) +
      '</div>';
  }).join("");
  return '<div class="finding-photos">' +
    '<div class="btnrow" style="margin:0">' +
      '<button class="btn primary" onclick="document.getElementById(\'fcam-' + safeId + '\').click()">📷 Take Photo</button>' +
    '</div>' +
    '<input type="file" id="fcam-' + safeId + '" accept="image/*" capture="environment" style="display:none" ' +
      'onchange="addPhotosFromCamera(this.files, \'' + safeId + '\'); this.value=\'\';">' +
    (strip ? '<div class="finding-photo-strip">' + strip + '</div>' : '') +
    (item.pin ? '<p class="hint" style="margin:6px 0 0">📍 Pinned on the roof map from this photo\'s location.</p>' : '') +
    '</div>';
}
/* Synchronous, best-effort roofId->label lookup off the last roof info
   this session already fetched (lastLookupRoofInfo, populated by
   lookupProspectiveBuildingRoofInfo() -- called every time the pin modal
   or inspection roof picker render). renderFindings() itself can't be
   async, and a GPS auto-assigned roofId needs to be VISIBLE right on the
   finding row per Mark's "SHOW which roof was auto-assigned... clearly"
   ask, not buried inside the pin modal -- this is the cheapest way to
   show a real name instead of a raw id without a second fetch. Returns
   null (badge just doesn't render) if the cache is empty/stale -- a
   graceful degradation, not a wrong answer. See "GPS auto-assign photos
   to roofs" in DEV_NOTES.md. */
function rmRoofLabelFromCache(roofId){
  if (!roofId || !lastLookupRoofInfo || !lastLookupRoofInfo.roofs) return null;
  var r = lastLookupRoofInfo.roofs.find(function(x){ return x.id === roofId; });
  return r ? (r.label || "Roof") : null;
}
function renderFindings(){
  var host = document.getElementById("findings-list");
  host.innerHTML = "";
  findings.forEach(function(f,i){
    var d = document.createElement("div");
    d.className = "rowcard" + (f.warranty === "Non-warrantable" ? " nonwar" : "");
    var roofLabel = f.pin ? rmRoofLabelFromCache(f.roofId) : null;
    var roofBadgeHtml = roofLabel ?
      ('<span class="evt-tag" style="' + (f.roofIdAmbiguous ? 'background:#FBE2E2;color:#D64545' : 'background:#EAF2FB;color:#1976D2') +
        '" onclick="openPinModal(\'' + f.id + '\')">' + (f.roofIdAmbiguous ? '⚠️ ' : '🏠 ') + esc(roofLabel) + '</span>') : '';
    d.innerHTML =
      '<div class="rowhead"><b>Finding #' + (i+1) + '</b>' + roofBadgeHtml + '<span class="sp"></span>' +
      '<button class="btn danger" onclick="removeFinding(' + i + ')">Remove</button></div>' +
      '<div class="fld"><label>Roof Condition Observed</label>' +
      '<textarea rows="1" data-i="' + i + '" data-f="condition">' + esc(f.condition) + '</textarea></div>' +
      '<div class="fld"><label>Location / Detail</label>' +
      '<input type="text" data-i="' + i + '" data-f="location" value="' + esc(f.location) + '" list="dl-roofLocationDetail" onblur="rememberFieldValue(\'roofLocationDetail\', this.value)"></div>' +
      '<div class="fld"><label>Warranty Opinion</label>' +
      '<select data-i="' + i + '" data-f="warranty">' +
        ["Warrantable","Warrantable condition noted","Non-warrantable","Undetermined"].map(function(o){
          return '<option' + (f.warranty === o ? " selected" : "") + '>' + o + '</option>';
        }).join("") +
      '</select></div>' +
      findingPhotoGalleryHtml(f) +
      '<div class="btnrow" style="margin:-4px 0 12px">' +
        '<button class="btn" onclick="openPinModal(\'' + f.id + '\')">' +
          (f.pin ? '📍 Pinned — move' : '📍 Place on Map') +
        '</button></div>';
    host.appendChild(d);
  });
  host.querySelectorAll("[data-f]").forEach(function(el){
    el.addEventListener("input", function(){
      findings[+el.dataset.i][el.dataset.f] = el.value;
      if (el.dataset.f === "warranty") renderFindings();
    });
  });
  host.querySelectorAll("[data-findingphoto]").forEach(function(el){
    el.addEventListener("input", function(){
      photos[+el.dataset.findingphoto].caption = el.value;
    });
  });
}

/* ================= reusable signature capture ================= *
   A generic canvas-based signature pad -- draw a signature, capture a
   printed name + auto date alongside it, get back
   { img (PNG data URL), printName, date } via a callback. NOT tied to the
   Change Order flow specifically -- openSignaturePad({title, onSave,
   existing}) is the reusable entry point; changeOrderSignature/
   renderChangeOrderSignature()/openChangeOrderSignaturePad() below are
   just its first consumer. To wire this into another form (e.g. leak-form/
   non-warranty service-order signing), call openSignaturePad() with a
   different onSave callback that stores the result wherever that form
   keeps it, following the exact same collect()/fill() + PDF-rendering
   pattern the Change Order wiring uses. See "In-app signature capture" in
   DEV_NOTES.md. */
var sigPadState = { canvas: null, ctx: null, drawing: false, hasStrokes: false, lastX: 0, lastY: 0, onSaveCallback: null };
function openSignaturePad(opts){
  opts = opts || {};
  sigPadState.onSaveCallback = opts.onSave || null;
  document.getElementById("signature-modal-title").textContent = opts.title || "Signature";
  document.getElementById("signature-print-name").value = (opts.existing && opts.existing.printName) || "";
  document.getElementById("signature-date-display").textContent = todayStr();
  var modal = document.getElementById("signature-modal");
  lockBodyScroll();
  modal.style.display = "";
  var canvas = document.getElementById("signature-canvas");
  sigPadState.canvas = canvas;
  sigPadState.hasStrokes = false;
  /* Size the backing canvas to its actual on-screen size x devicePixelRatio
     for crisp strokes on a retina/mobile screen -- deferred a tick so the
     modal has actually laid out and getBoundingClientRect() is accurate,
     same reasoning other modals here use setTimeout for map/canvas sizing
     right after display is toggled on. */
  setTimeout(function(){
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a1a1a";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    sigPadState.ctx = ctx;
    /* Pre-load an existing signature (re-signing/editing) so Save without
       redrawing just keeps what was already there. */
    if (opts.existing && opts.existing.img){
      var img = new Image();
      img.onload = function(){ ctx.drawImage(img, 0, 0, rect.width, rect.height); sigPadState.hasStrokes = true; };
      img.src = opts.existing.img;
    }
  }, 30);
  canvas.onpointerdown = sigPadPointerDown;
  canvas.onpointermove = sigPadPointerMove;
  canvas.onpointerup = sigPadPointerUp;
  canvas.onpointerleave = sigPadPointerUp;
}
function sigPadPointerDown(e){
  e.preventDefault();
  sigPadState.drawing = true;
  var rect = sigPadState.canvas.getBoundingClientRect();
  sigPadState.lastX = e.clientX - rect.left;
  sigPadState.lastY = e.clientY - rect.top;
}
function sigPadPointerMove(e){
  if (!sigPadState.drawing || !sigPadState.ctx) return;
  e.preventDefault();
  var rect = sigPadState.canvas.getBoundingClientRect();
  var x = e.clientX - rect.left, y = e.clientY - rect.top;
  var ctx = sigPadState.ctx;
  ctx.beginPath();
  ctx.moveTo(sigPadState.lastX, sigPadState.lastY);
  ctx.lineTo(x, y);
  ctx.stroke();
  sigPadState.lastX = x; sigPadState.lastY = y;
  sigPadState.hasStrokes = true;
}
function sigPadPointerUp(){
  sigPadState.drawing = false;
}
function sigPadClear(){
  if (!sigPadState.ctx || !sigPadState.canvas) return;
  var rect = sigPadState.canvas.getBoundingClientRect();
  sigPadState.ctx.fillStyle = "#fff";
  sigPadState.ctx.fillRect(0, 0, rect.width, rect.height);
  sigPadState.hasStrokes = false;
}
function sigPadSave(){
  if (!sigPadState.hasStrokes){ toast("Draw a signature first."); return; }
  var printName = val("signature-print-name").trim();
  if (!printName){ toast("Enter the signer's printed name."); return; }
  /* PNG, not JPEG -- a signature is sparse black strokes on white, PNG
     compresses that tiny already, and JPEG's lossy artifacts are wrong for
     thin ink lines (same reasoning photo capture uses JPEG for photos but
     this is deliberately different -- see resizeImageFile()/
     addPhotosFromFiles() for the photo convention this intentionally
     doesn't follow). Canvas is already sized modestly (CSS ~560px wide x
     200px tall x devicePixelRatio) so the resulting data URL stays small,
     not a full-photo-sized payload added to the work order doc. */
  var img = sigPadState.canvas.toDataURL("image/png");
  var sigData = { img: img, printName: printName, date: todayStr() };
  var cb = sigPadState.onSaveCallback;
  closeSignaturePad();
  if (cb) cb(sigData);
}
function closeSignaturePad(){
  document.getElementById("signature-modal").style.display = "none";
  unlockBodyScroll();
  var canvas = sigPadState.canvas;
  if (canvas){
    canvas.onpointerdown = null; canvas.onpointermove = null;
    canvas.onpointerup = null; canvas.onpointerleave = null;
  }
  sigPadState.canvas = null; sigPadState.ctx = null;
  sigPadState.onSaveCallback = null; sigPadState.hasStrokes = false; sigPadState.drawing = false;
}

/* ---- Change Order's own use of the signature pad above ---- */
function renderChangeOrderSignature(){
  var host = document.getElementById("co-signature-status");
  if (!host) return;
  if (changeOrderSignature && changeOrderSignature.img){
    host.innerHTML = "<p class=\"hint\" style=\"margin:0 0 8px\">✅ Signed by <b>" + esc(changeOrderSignature.printName) +
      "</b> on " + esc(changeOrderSignature.date) + "</p>" +
      "<img src=\"" + changeOrderSignature.img + "\" style=\"max-width:220px;max-height:70px;display:block;border:1px solid var(--line);border-radius:4px;margin-bottom:8px\">" +
      "<div class=\"btnrow\" style=\"margin:0\">" +
      "<button class=\"btn\" onclick=\"openChangeOrderSignaturePad()\">Re-sign</button>" +
      "<button class=\"btn danger\" onclick=\"clearChangeOrderSignature()\">Clear Signature</button></div>";
  } else {
    host.innerHTML = '<button class="btn primary" onclick="openChangeOrderSignaturePad()">✍️ Get Signature</button>';
  }
}
function openChangeOrderSignaturePad(){
  openSignaturePad({
    title: "Change Order Signature",
    existing: changeOrderSignature,
    onSave: function(sigData){
      changeOrderSignature = sigData;
      renderChangeOrderSignature();
      toast("Signature captured ✓");
    }
  });
}
function clearChangeOrderSignature(){
  if (!confirm("Remove this signature?")) return;
  changeOrderSignature = null;
  renderChangeOrderSignature();
}

/* Lets a tech standing at the actual spot drop a precise pin from the
   device's own GPS, instead of relying on an old photo's GPS or a
   geocoded street address. Only offered in satellite/lat-lng mode — a
   custom base map (roof plan/sketch) has no real-world coordinate system
   for device GPS to land on. */
function useMyLocationForPin(){
  if (!navigator.geolocation){ toast("Location isn't available on this device/browser."); return; }
  var btn = document.getElementById("pin-mylocation-btn");
  btn.disabled = true; btn.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(function(pos){
    btn.disabled = false; btn.textContent = "📍 Use My Location";
    if (!pinMarker || !pinMap) return;
    var lat = pos.coords.latitude, lng = pos.coords.longitude, acc = Math.round(pos.coords.accuracy || 0);
    pinMarker.setLatLng([lat, lng]);
    pinMap.setView([lat, lng], 20);
    pinInteracted = true;
    pinDeviceGpsUsed = true;
    document.getElementById("pin-hint").textContent = "Placed from your current location (±" + acc + "m) — drag to correct if needed.";
  }, function(err){
    btn.disabled = false; btn.textContent = "📍 Use My Location";
    toast("Couldn't get your location: " + (err.message || "permission denied"));
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function savePinFromModal(){
  if (!pinMarker || !pinModalFindingId) return;
  var f = findingById(pinModalFindingId);
  if (!f) return;
  var ll = pinMarker.getLatLng();
  if (pinMapMode === "xy" && pinXYSize){
    f.pin = { lat: null, lng: null, x: ll.lng / pinXYSize.w, y: ll.lat / pinXYSize.h, source: "tech_placed" };
  } else {
    var source = pinDeviceGpsUsed ? "device_gps" :
      (pinInitialSource === "photo_gps" ? (pinInteracted ? "gps_corrected" : "photo_gps") : pinInitialSource);
    f.pin = { lat: ll.lat, lng: ll.lng, x: null, y: null, source: source };
  }
  renderFindings();
  closePinModal();
  toast("Pin saved ✓");
}
function clearPinFromModal(){
  if (!pinModalFindingId) return;
  var f = findingById(pinModalFindingId);
  if (f) f.pin = null;
  renderFindings();
  closePinModal();
  toast("Pin cleared");
}

/* ================= warranty guidelines (display-only reference) =================
   Plain tech guidelines, NOT manufacturer-official — Mark: "just guidelines
   for the techs." Two arrays, easy to edit (add/remove a line to change what
   shows in the on-form reference). Display-only: shown as a collapsible
   <details> section inside #wo-leak-warranty-extra on the Warranty
   Determination card via populateWarrantyGuidelines() below. Leak/Service
   only — "for leaks and leaks only" (Mark) — gated by onWoTypeChange(), same
   wrapper as the Manufacturer Service # field. No selection, no data
   capture, nothing saved on the work order. */
var WARRANTY_GUIDELINES = {
  warrantable: [
    "Membrane seam failures",
    "Failed factory flashings",
    "Premature material defects",
    "Membrane splits or cracks caused by material defects",
    "Failures caused by warranted workmanship",
    "Water leaks resulting from covered roofing system defects"
  ],
  notWarrantable: [
    "Damage from other contractors (HVAC, electrical, plumbing, solar, etc.)",
    "Foot traffic damage",
    "Dropped tools or punctures",
    "Cuts or gouges",
    "Vandalism",
    "Storm damage (unless specifically covered)",
    "Hail (unless hail coverage was purchased)",
    "Animal damage",
    "Chemical contamination",
    "Lack of routine maintenance",
    "Clogged drains",
    "Ponding caused by structural settlement",
    "Damage from modifications made after installation",
    "Unauthorized repairs",
    "Normal aging and wear",
    "Cosmetic issues that do not affect watertightness"
  ]
};
function populateWarrantyGuidelines(){
  var host = document.getElementById("warranty-guidelines-body");
  if (!host || host.childElementCount) return; /* static reference text — no data-driven content to refresh */
  function list(items){
    return "<ul style='margin:6px 0 0;padding-left:20px'>" +
      items.map(function(i){ return "<li style='margin:0 0 4px'>" + esc(i) + "</li>"; }).join("") +
      "</ul>";
  }
  host.innerHTML =
    "<div style='background:#EAF6EC;border:1px solid #2E7D32;border-radius:8px;padding:10px 12px;margin:0 0 10px'>" +
      "<b style='color:#2E7D32'>Typically Warrantable</b>" + list(WARRANTY_GUIDELINES.warrantable) +
    "</div>" +
    "<div style='background:#FBEAEA;border:1px solid #D64545;border-radius:8px;padding:10px 12px'>" +
      "<b style='color:#D64545'>Typically Not Warrantable</b>" + list(WARRANTY_GUIDELINES.notWarrantable) +
    "</div>";
}
var FIELD_IDS = ["jobName","location","serviceDate","jobNo","billTo","billContact","billPhone",
  "siteContact","technician","roofSystem","reportedArea","warrantable","nonWarrantable","summary",
  "woCost","woManHours","woMaterials","woDescription","woPONumber","woDateCompleted","repairDescription",
  "mfgServiceNo"];

function collect(){
  var o = { id: currentId || ("wo_" + Date.now()) };
  FIELD_IDS.forEach(function(k){ o[k] = val(k); });
  /* Not in FIELD_IDS: a SELECT's .value falls back to "" (nothing
     selected) rather than its first option when set to an unmatched
     value, so an explicit default here is what actually guarantees
     "Leak / Service" for a work order that predates this field —
     relying on option order alone isn't reliable. */
  o.woType = val("woType") || WORK_ORDER_TYPES[0];
  o.findings = findings.slice();
  o.repairs = repairs.slice();
  o.repairItems = repairItems.slice();
  o.inspectionChecklist = inspectionChecklist.slice();
  o.photos = photos.slice();
  o.companyCamProjectId = ccLinkedProjectId || null;
  o.companyCamProjectName = ccLinkedProjectName || "";
  o.roofId = currentRoofId || null;
  /* Multi-roof Inspection only -- null for every other case (a single roof
     selected, or a work order type that doesn't support this at all yet),
     so nothing about the existing single-roofId shape changes unless this
     is genuinely in play. */
  o.roofIds = (currentRoofIds && currentRoofIds.length > 1) ? currentRoofIds.slice() : null;
  /* roofLabels denormalizes id->label from the last roof lookup so
     renderLeakReportDoc() (synchronous, no Firestore access) can show real
     roof names instead of raw ids -- populated whenever a roof lookup has
     happened at all this session (not just for a multi-select Inspection),
     since GPS auto-assign (rmMaybeAutoAssignRoofForPin()) can now give
     individual findings different roofIds on ANY work order type, and the
     report needs real names for those too. See "GPS auto-assign photos to
     roofs" in DEV_NOTES.md. */
  o.roofLabels = (lastLookupRoofInfo && lastLookupRoofInfo.roofs) ?
    lastLookupRoofInfo.roofs.reduce(function(m, r){ m[r.id] = r.label || "Roof"; return m; }, {}) : null;
  o.changeOrderSignature = changeOrderSignature || null;
  return o;
}
function fill(o){
  currentId = o.id;
  currentRoofId = o.roofId || null;
  currentRoofIds = (o.roofIds && o.roofIds.length > 1) ? o.roofIds.slice() : null;
  /* Must be set before onWoTypeChange() below (Inspection's branch reads
     inspectionChecklist to render it) so a freshly loaded order's own
     checklist is what gets shown, not whatever was left over from
     whichever order was open before this one. */
  inspectionChecklist = (o.inspectionChecklist || []).slice();
  FIELD_IDS.forEach(function(k){ setVal(k, o[k]); });
  populateWoTypeSelect();
  setVal("woType", o.woType || WORK_ORDER_TYPES[0]);
  onWoTypeChange();
  findings = (o.findings || []).slice(); if (!findings.length) findings = [{condition:"",location:"",warranty:"Warrantable"}];
  /* Self-heals findings/photos saved before ids and pins existed — never
     fabricates a pin location for old data, just ensures every finding has
     a stable id going forward (see spec: don't backfill pins, but a missing
     id isn't a pin, it's plumbing). */
  findings.forEach(function(f){
    if (!f.id) f.id = genId("fnd");
    if (f.pin === undefined) f.pin = null;
  });
  repairs = (o.repairs || []).slice(); if (!repairs.length) repairs = [{repair:"",location:""}];
  repairItems = (o.repairItems || []).slice(); /* Repair type only — no forced minimum row, optional */
  photos = (o.photos || []).slice();
  photos.forEach(function(p){ if (p.finding_id === undefined) p.finding_id = null; });
  ccLinkedProjectId = o.companyCamProjectId || null;
  ccLinkedProjectName = o.companyCamProjectName || "";
  changeOrderSignature = o.changeOrderSignature || null;
  renderFindings(); renderRepairs(); renderRepairItems(); renderPhotos(); renderCCLinkInfo(); renderChangeOrderSignature();
  /* Re-render the checklist now that photos[]/findings[] are the truly
     loaded values, not whatever onWoTypeChange() saw mid-load above --
     otherwise a checklist item's photo gallery could briefly reflect the
     PREVIOUSLY open order instead of this one. Cheap, harmless if run
     twice. */
  if (val("woType") === "Inspection"){ ensureInspectionChecklist(); renderInspectionChecklist(); }
}
function todayStr(){
  var d = new Date();
  return (d.getMonth()+1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(-2);
}
/* Parses this app's "M/D/YY" date string (todayStr()'s own format, no
   zero-padding) into a real timestamp for CHRONOLOGICAL sorting -- string
   sorting "M/D/YY" directly is wrong (e.g. "12/1/26" < "2/1/26"
   lexicographically). Returns 0 (sorts oldest/last) for anything
   unparseable rather than throwing, so one bad/legacy record can't break
   sorting the rest of a building's timeline. See "Retroactive backfill:
   order the timeline by event date" in DEV_NOTES.md. */
function parseMDYDate(mdy){
  var parts = String(mdy || "").split("/");
  if (parts.length !== 3) return 0;
  var m = parseInt(parts[0], 10), day = parseInt(parts[1], 10);
  var y = parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10);
  if (!m || !day || !y) return 0;
  var t = new Date(y, m - 1, day).getTime();
  return isNaN(t) ? 0 : t;
}
function hasContent(){
  try{
    var o = collect();
    return !!(o.jobName || o.jobNo || o.reportedArea || o.summary ||
      (photos && photos.length) || filledFindings().length || filledRepairs().length);
  }catch(e){ return false; }
}
/* "+ New" (header) and "+ New Work Order" (Building History's empty
   state) both land here — now a launcher, not an immediate blank
   Leak/Service form, so the user picks a type first (see
   startNewWorkOrder() below). The unsaved-work guard still applies
   before leaving the current form, same as before. */
function newOrder(){
  if (hasContent() && !confirm("Start a new work order? Anything not saved on the current one will be lost.\n\nHit Cancel and press Save first if you want to keep it.")) return;
  showView("home");
}
function renderHomeTiles(){
  var host = document.getElementById("home-tiles");
  if (!host || host.childElementCount) return; /* static per session — no data-driven content to refresh */
  var tiles = WORK_ORDER_TYPES.map(function(t){
    return '<button class="home-tile" onclick="startNewWorkOrder(\'' + esc(t) + '\')">' +
      '<span class="home-tile-icon">' + (WORK_ORDER_TYPE_ICONS[t] || "📄") + '</span>' +
      '<span class="home-tile-label">' + esc(WORK_ORDER_TYPE_LABELS[t] || t) + '</span></button>';
  });
  tiles.push(
    '<button class="home-tile home-tile-secondary" onclick="showView(\'roofmapper\')">' +
      '<span class="home-tile-icon">🗺️</span><span class="home-tile-label">RoofMapper</span></button>',
    '<button class="home-tile home-tile-secondary" onclick="showView(\'history\')">' +
      '<span class="home-tile-icon">🏢</span><span class="home-tile-label">Building History</span></button>',
    '<button class="home-tile home-tile-secondary" onclick="showView(\'reports\')">' +
      '<span class="home-tile-icon">📋</span><span class="home-tile-label">Reports</span></button>'
  );
  host.innerHTML = tiles.join("");
}
function startNewWorkOrder(type){
  fill({ id: "wo_" + Date.now(), serviceDate: todayStr(), woType: type });
  showView("edit");
  toast("New " + (WORK_ORDER_TYPE_LABELS[type] || type) + " started");
}

/* ================= duplicate building detection =================
   Conservative on purpose \u2014 a false positive just shows an unnecessary
   badge, but a wrong merge is destructive and irreversible, so this only
   flags pairs sharing the same normalized customer name (typo'd customer
   names across different customers are out of scope; an admin can still
   spot those by eye). Purely client-side over the buildings list that's
   already fetched \u2014 no new query, no schema change. */
function dupNormalize(s){
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function dupLevenshtein(a, b){
  var m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  var prev = [], cur = [];
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++){
    cur[0] = i;
    for (j = 1; j <= n; j++){
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur.slice();
  }
  return prev[n];
}
function buildingsLikelyDuplicate(a, b){
  var custA = dupNormalize(a.customerName), custB = dupNormalize(b.customerName);
  if (!custA || custA !== custB) return false;
  var nameA = dupNormalize(a.name), nameB = dupNormalize(b.name);
  if (!nameA || !nameB || nameA === nameB) return nameA === nameB && !!nameA;
  if (nameA.indexOf(nameB) > -1 || nameB.indexOf(nameA) > -1) return true;
  var dist = dupLevenshtein(nameA, nameB), maxLen = Math.max(nameA.length, nameB.length);
  return maxLen > 0 && (dist / maxLen) <= 0.25;
}
function flagPossibleDuplicateBuildings(list){
  list.forEach(function(b){ b._dupWith = []; });
  for (var i = 0; i < list.length; i++){
    for (var j = i + 1; j < list.length; j++){
      if (buildingsLikelyDuplicate(list[i], list[j])){
        list[i]._dupWith.push(list[j].id);
        list[j]._dupWith.push(list[i].id);
      }
    }
  }
}
var lastBuildingList = [];
/* Building archive (replaces the old hard-delete-only path -- see
   archiveBuildingAdmin()/unarchiveBuildingAdmin() below). Off by default so
   an archived building doesn't clutter the everyday list; toggled on to
   review/restore one. Session-only, not persisted -- resets to hidden every
   fresh visit to Building History, same as any other view-local filter. */
var historyShowArchived = false;
/* ================= Buildings Near Me (proximity / GPS building detection) =================
   Realizes the "tech pulls up on site and the app already knows where they
   are" vision pillar — see ROADMAP.md. Resolves each building's best-known
   coordinate (cached geocode > most recent roof outline's centroid > a live
   geocode of its address, which then gets cached back to Firestore so it's
   a one-time cost), sorts by haversine distance from the tech's current GPS
   fix, and opens straight into Building History (which already links
   CompanyCam/job numbers/reports/roof map) on tap. */
var BUILDINGS_NEAR_ME_RADIUS_MI = 25;
var BUILDINGS_NEAR_ME_GEOCODE_CAP = 25; /* live geocode calls per run -- keeps a
  large, mostly-uncached building list from turning into a slow scan (Nominatim
  is a shared free service, not meant for bulk use). Buildings geocoded this
  run get permanently cached via bnmCacheGeocode(), so later runs need fewer
  live lookups as the building list "warms up" over time. */
function bnmCachedCoord(b){
  if (b.geoCache && typeof b.geoCache.lat === "number" && typeof b.geoCache.lng === "number"){
    return { lat: b.geoCache.lat, lng: b.geoCache.lng };
  }
  /* Free, already-fetched, and (being GPS/geometry-derived, not a street
     address centroid) usually more accurate than a geocoded address --
     checked before ever spending a geocode call. Most recently created
     outline across all of the building's roofs, if it has more than one. */
  var bestOutline = null;
  getBuildingRoofs(b).forEach(function(r){
    (r.roof_outlines || []).forEach(function(o){
      if (o.center && (!bestOutline || o.createdAt > bestOutline.createdAt)) bestOutline = o;
    });
  });
  return bestOutline ? { lat: bestOutline.center.lat, lng: bestOutline.center.lng } : null;
}
async function bnmCacheGeocode(buildingId, coord){
  try{
    await fdb.collection("buildings").doc(buildingId).set({
      geoCache: { lat: coord.lat, lng: coord.lng, source: "geocoded", updatedAt: Date.now() }
    }, { merge: true });
  }catch(e){ /* best-effort -- a failed cache write just means the next run re-geocodes this one */ }
}
async function findBuildingsNearMe(){
  var host = document.getElementById("bnm-results");
  if (!fdb){
    toast("Buildings Near Me needs cloud sync (internet connection) — search below instead.");
    return;
  }
  if (!navigator.geolocation){
    toast("Location isn't available on this device/browser — search below instead.");
    return;
  }
  if (host) host.innerHTML = '<p class="hint">Getting your location…</p>';
  var pos;
  try{
    pos = await new Promise(function(resolve, reject){
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000, enableHighAccuracy: true });
    });
  }catch(e){
    if (host) host.innerHTML = "";
    toast("Couldn't get your location — search below instead.");
    return;
  }
  var here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  if (host) host.innerHTML = '<p class="hint">Locating nearby buildings…</p>';
  try{
    var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(300).get();
    var list = [];
    qs.forEach(function(d){
      var b = Object.assign({ id: d.id }, d.data());
      if (!b.archived) list.push(b); /* archived buildings stay out of every default picker/search -- see "Building archive" in DEV_NOTES.md */
    });
    var geocodeBudget = BUILDINGS_NEAR_ME_GEOCODE_CAP;
    var withCoords = [];
    for (var i = 0; i < list.length; i++){
      var b = list[i];
      var coord = bnmCachedCoord(b);
      if (!coord && b.location && geocodeBudget > 0){
        geocodeBudget--;
        coord = await geocodeAddress(b.location);
        if (coord) await bnmCacheGeocode(b.id, coord);
      }
      if (coord) withCoords.push({ b: b, coord: coord });
    }
    var withDist = withCoords.map(function(x){
      return { b: x.b, coord: x.coord, distMi: rmGeomHaversineMeters(here, x.coord) / 1609.344 };
    }).filter(function(x){ return x.distMi <= BUILDINGS_NEAR_ME_RADIUS_MI; })
      .sort(function(a, c){ return a.distMi - c.distMi; });
    renderBuildingsNearMe(withDist);
  }catch(e){
    if (host) host.innerHTML = '<p class="hint">Couldn\'t search nearby buildings: ' + esc(e.message) + '</p>';
  }
}
function renderBuildingsNearMe(results){
  var host = document.getElementById("bnm-results");
  if (!host) return;
  if (!results.length){
    host.innerHTML = '<p class="hint">No buildings found within ' + BUILDINGS_NEAR_ME_RADIUS_MI +
      ' miles — search below instead.</p>';
    return;
  }
  /* A single very-close match (under ~800ft) is highlighted as a suggestion,
     but tapping is still required -- never auto-navigates away from the
     tech's current screen on its own. */
  var veryClose = results[0].distMi < 0.15;
  host.innerHTML = results.map(function(x, i){
    var highlight = veryClose && i === 0;
    return '<div class="bld-item"' + (highlight ? ' style="border-left-color:var(--orange)"' : '') +
      ' onclick="openBuildingFromNearMe(\'' + x.b.id + '\')"><div class="info">' +
      '<div class="name">' + esc(x.b.name || "(unnamed building)") +
      (highlight ? ' <span style="font-size:11px;font-weight:700;text-transform:uppercase;' +
        'letter-spacing:.04em;background:#FFE0B2;color:#8a5000;border-radius:3px;padding:2px 6px;' +
        'margin-left:6px">You’re here</span>' : '') + '</div>' +
      '<div class="meta">' + esc(x.b.customerName || "") + (x.b.location ? ' · ' + esc(x.b.location) : "") +
      ' · ' + x.distMi.toFixed(x.distMi < 1 ? 2 : 1) + ' mi away</div></div>' +
      '<button class="btn">Open</button></div>';
  }).join("");
}
function openBuildingFromNearMe(buildingId){
  showView("history");
  openBuildingHistory(buildingId);
}
async function renderHistoryList(){
  var host = document.getElementById("history-list");
  var detail = document.getElementById("history-detail");
  detail.innerHTML = "";
  if (!fdb){
    host.innerHTML = '<div class="empty">Building history needs cloud sync (internet connection) to load.</div>';
    return;
  }
  host.innerHTML = '<p class="hint">Loading buildings\u2026</p>';
  try{
    var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(100).get();
    var fullList = [];
    qs.forEach(function(d){ fullList.push(Object.assign({ id: d.id }, d.data())); });
    if (!fullList.length){
      host.innerHTML = '<div class="empty">No building history yet. Save a work order or send a report to start one.</div>';
      lastBuildingList = [];
      return;
    }
    /* Archived buildings (see archiveBuildingAdmin() below) are hidden from
       the default list -- Mark's whole point in archiving one is to get it
       out of the way -- but never excluded from the query itself, so the
       toggle can reveal them again without a second fetch. */
    var archivedCount = fullList.filter(function(b){ return b.archived; }).length;
    var list = historyShowArchived ? fullList : fullList.filter(function(b){ return !b.archived; });
    flagPossibleDuplicateBuildings(list);
    lastBuildingList = fullList;
    var dupBuildingCount = list.filter(function(b){ return b._dupWith.length; }).length;
    var archivedToggleHtml = archivedCount ?
      '<label class="hint" style="display:flex;align-items:center;gap:6px;margin:0 0 10px">' +
        '<input type="checkbox" ' + (historyShowArchived ? "checked" : "") +
        ' onchange="historyShowArchived=this.checked;renderHistoryList()">Show archived (' + archivedCount + ')</label>' : '';
    host.innerHTML = archivedToggleHtml +
      (dupBuildingCount ? '<p class="hint">\u26a0 ' + dupBuildingCount + ' building(s) below look like possible duplicates ' +
        '(same customer, very similar name) \u2014 review manually for now; merging isn\u2019t automated yet.</p>' : '') +
      (list.length ? "" : '<div class="empty">No buildings match.</div>') +
      list.map(function(b){
        return '<div class="bld-item"' + (b._dupWith.length ? ' style="border-left-color:#D64545"' : (b.archived ? ' style="opacity:.6"' : '')) +
          ' onclick="openBuildingHistory(\'' + b.id + '\')"><div class="info">' +
          '<div class="name">' + esc(b.name) +
          (b.archived ? ' <span style="font-size:11px;font-weight:700;text-transform:uppercase;' +
            'letter-spacing:.04em;background:#E0E0E0;color:#555;border-radius:3px;padding:2px 6px;' +
            'margin-left:6px">Archived</span>' : '') +
          (b._dupWith.length ? ' <span style="font-size:11px;font-weight:700;text-transform:uppercase;' +
            'letter-spacing:.04em;background:#FBE2E2;color:#D64545;border-radius:3px;padding:2px 6px;' +
            'margin-left:6px">Possible duplicate</span>' : '') + '</div>' +
        '<div class="meta">' + esc(b.customerName || "") + (b.location ? ' \u00b7 ' + esc(b.location) : "") +
        (b.roofSystem ? ' \u00b7 ' + esc(b.roofSystem) : "") +
        (b.companyCamProjectId ? ' \u00b7 \ud83d\udd17 CompanyCam linked' : "") + '</div></div>' +
        '<button class="btn">View Timeline</button>' +
        (isAdmin ? (b.archived ?
          '<button class="btn" onclick="event.stopPropagation(); unarchiveBuildingAdmin(\'' + b.id + '\')">\u21a9\ufe0f Unarchive (admin)</button>' :
          '<button class="btn danger" onclick="event.stopPropagation(); archiveBuildingAdmin(\'' + b.id + '\')">\ud83d\uddc4\ufe0f Archive (admin)</button>') : '') +
        '</div>';
    }).join("");
  }catch(e){
    host.innerHTML = '<div class="empty">Couldn\u2019t load building history: ' + esc(e.message) + '</div>';
  }
}
/* Replaces the old hard-delete-only admin path (below, now unused/kept only
   as a documented server-capability reference) -- Mark's actual need was a
   way to get a wrong/junk building out of his way, not to permanently
   destroy its history; the old path was the ONLY option, which meant real
   history sometimes got destroyed just to declutter. Soft delete: sets an
   `archived` flag via admin.js's archive_building action (Admin SDK,
   claims/permission-gated + audited, same defense-in-depth pattern as
   every other cross-cutting building write in this file) and changes nothing else --
   roofs/features/history/CompanyCam link are all untouched, fully
   recoverable via unarchiveBuildingAdmin() below. See "Building archive"
   in DEV_NOTES.md. */
async function archiveBuildingAdmin(buildingId){
  if (!isAdmin){ toast("Admin mode required to archive."); return; }
  var b = (lastBuildingList || []).find(function(x){ return x.id === buildingId; });
  var buildingName = b ? b.name : "this building";
  if (!confirm('Archive "' + buildingName + '"? It\u2019ll be hidden from the building list (reversible any time via ' +
    '"Show archived" \u2192 Unarchive). Nothing about it is deleted \u2014 roofs, features, history, and its CompanyCam ' +
    "link (if any) all stay exactly as they are.")) return;
  toast("Archiving\u2026");
  try{
    await callAdminApi({ action: "archive_building", buildingId: buildingId });
    toast("Archived \u2713");
    renderHistoryList();
  }catch(e){ toast("Archive failed: " + e.message); }
}
async function unarchiveBuildingAdmin(buildingId){
  if (!isAdmin){ toast("Admin mode required."); return; }
  toast("Restoring\u2026");
  try{
    await callAdminApi({ action: "unarchive_building", buildingId: buildingId });
    toast("Restored \u2713");
    renderHistoryList();
  }catch(e){ toast("Restore failed: " + e.message); }
}
/* Kept as a defined-but-unreachable server capability (no UI path calls this
   anymore, per Mark: "hard delete stays out of the client") rather than
   deleted outright -- admin.js's delete_building action it calls is still a
   real, audited last resort reachable directly against the API if a
   building genuinely needs to be purged, just never one tap away in the
   app. archiveBuildingAdmin() above is the actual client-facing removal
   path now. */
async function deleteBuildingAdmin(buildingId){
  if (!isAdmin){ toast("Admin mode required to delete."); return; }
  /* Looked up from the cached list rather than passed in as a raw string —
     interpolating a name straight into an onclick="..." attribute breaks
     for any name containing an apostrophe (HTML-decodes back to a literal
     ' inside the inline handler's JS source, terminating the string early
     — see "CompanyCam project names with apostrophes" in DEV_NOTES.md for
     the same bug found in ccLoadProjects()). Passing just the id sidesteps
     the whole escaping problem. */
  var b = (lastBuildingList || []).find(function(x){ return x.id === buildingId; });
  var buildingName = b ? b.name : "this building";
  if (!confirm('Delete "' + buildingName + '" and its entire history? This removes the building, customer link, ' +
    "and every logged report event for it. Work orders themselves are not deleted \u2014 only the building/history record. " +
    "This can't be undone.")) return;
  toast("Deleting building history\u2026");
  try{
    await callAdminApi({ action: "delete_building", buildingId: buildingId });
    toast("Deleted \u2713");
    renderHistoryList();
  }catch(e){
    toast("Delete failed: " + e.message);
  }
}
/* Flags events as likely duplicates when the same work order logged the
   same report type within a few minutes of another entry \u2014 the common
   case is a double-click or a retried Send/Share/Download, not two
   genuinely separate reports. Doesn't touch the data, just marks it for
   the admin delete control below. Requires a real workOrderId to match on
   \u2014 manually logged activities (logActivityEvent) have no work order, so
   two genuinely separate activities of the same type logged close
   together (e.g. two real Drone Flights) never get flagged against each
   other just because both have no work order. */
var DUP_WINDOW_MS = 5 * 60 * 1000;
function flagDuplicateEvents(events){
  var seen = [];
  events.forEach(function(e){
    e._dup = !!e.workOrderId && seen.some(function(s){
      return s.workOrderId === e.workOrderId && s.reportType === e.reportType &&
        Math.abs((s.createdAt || 0) - (e.createdAt || 0)) < DUP_WINDOW_MS;
    });
    seen.push(e);
  });
  return events;
}
function warrantyColor(w){
  if (w === "Warrantable" || w === "Warrantable condition noted") return "#2E7D32";
  if (w === "Non-warrantable") return "#D64545";
  return "#F9A825"; /* Undetermined, Mixed, anything else */
}
var buildingMap = null;
function pinPopupHtml(p){
  var photoNote = p.photo_ids && p.photo_ids.length ?
    "📷 " + p.photo_ids.length + " photo" + (p.photo_ids.length === 1 ? "" : "s") + " — open the work order to view" : "";
  return "<b>" + esc(p.eventDate || p.service_date || "") + "</b>" +
    (p.work_order_no ? " — Job No. " + esc(p.work_order_no) : "") + "<br>" +
    (p.condition ? esc(p.condition) + "<br>" : "") +
    "<span style='color:" + warrantyColor(p.warranty) + ";font-weight:600'>" + esc(p.warranty || "") + "</span><br>" +
    (photoNote ? photoNote + "<br>" : "") +
    "<div style=\"display:flex;gap:6px;margin-top:6px;flex-wrap:wrap\">" +
    "<button class=\"btn\" onclick=\"loadOrder('" + p.work_order_id + "')\">View Work Order</button>" +
    (p.finding_id ? "<button class=\"btn\" onclick=\"jumpToAdjustPin('" + p.work_order_id + "','" + p.finding_id + "')\">Adjust Pin</button>" : "") +
    "</div>";
}
function outlinePopupHtml(o, roofLabel){
  return "<b>🗺️ " + esc(rmOutlineTitle(o)) + "</b><br>" +
    (roofLabel ? "Roof: " + esc(roofLabel) + "<br>" : "") +
    (o.areaSqFt ? Math.round(o.areaSqFt) + " sq ft · " + Math.round(o.perimeterFt || 0) + " ft perimeter<br>" : "") +
    "<span style='color:var(--muted);font-size:12px'>Saved from RoofMapper" +
    (o.createdAt ? " — " + new Date(o.createdAt).toLocaleDateString() : "") + "</span>";
}
/* pins here are already pre-filtered to the mode matching customBld (see
   caller) — null customBld means satellite/lat-lng mode, otherwise x/y
   mode against that building's custom base map image. The map always
   renders, even with zero pins — a building's roof map is a permanent
   thing you can look at, not something that only appears once a pin
   exists. bldAddress centers satellite mode when there's nothing else
   to derive a center from. */
function renderBuildingMap(pins, customBld, bldAddress, orthoOverlay, assets, buildingId, outlines){
  assets = assets || [];
  /* outlines (roof_outlines[] from RoofMapper) are always real lat/lng —
     only drawn in satellite/drone_ortho mode, same tradeoff already
     documented above for pins/assets vs. a custom roof_plan/sketch base
     map (no coordinate system to convert lat/lng into there). Each item
     may carry an optional _roofLabel (set by openBuildingHistory() when
     passing every roof's most recent outline, not just the one currently
     selected in the picker) so multiple roofs can show together, each
     labeled -- Mark: roofs should "coexist" and be identifiable at a
     glance, not switched one-at-a-time. See "Individual-roof tracing +
     labels" in DEV_NOTES.md. */
  outlines = outlines || [];
  var el = document.getElementById("building-map");
  if (!el) return;
  if (buildingMap){ buildingMap.remove(); buildingMap = null; }
  if (customBld){
    var img = new Image();
    img.onload = function(){
      var w = img.naturalWidth, h = img.naturalHeight;
      var bounds = [[0,0],[h,w]];
      setTimeout(function(){
        buildingMap = L.map("building-map", { crs: L.CRS.Simple, minZoom: -5 });
        L.imageOverlay(customBld.roof_base_map_url, bounds).addTo(buildingMap);
        pins.forEach(function(p){
          L.circleMarker([p.y * h, p.x * w], {
            radius: 9, color: "#fff", weight: 2, fillColor: warrantyColor(p.warranty), fillOpacity: 0.95
          }).addTo(buildingMap).bindPopup(pinPopupHtml(p));
        });
        assets.forEach(function(a){
          if (typeof a.x !== "number") return;
          L.marker([a.y * h, a.x * w], { icon: assetIcon(a.type) }).addTo(buildingMap).bindPopup(assetPopupHtml(buildingId, a));
        });
        buildingMap.fitBounds(bounds);
        buildingMap.invalidateSize();
        setTimeout(function(){ if (buildingMap) buildingMap.invalidateSize(); }, 300);
      }, 50);
    };
    img.onerror = function(){ el.innerHTML = '<p class="hint">Couldn’t load the custom base map image.</p>'; };
    img.src = customBld.roof_base_map_url;
    return;
  }
  (async function(){
    var bounds = [];
    pins.forEach(function(p){ bounds.push([p.lat, p.lng]); });
    assets.forEach(function(a){ if (typeof a.lat === "number") bounds.push([a.lat, a.lng]); });
    outlines.forEach(function(o){ (o.ring || []).forEach(function(p){ bounds.push([p.lat, p.lng]); }); });
    var center = null, zoom = 18;
    if (!bounds.length){
      if (orthoOverlay){
        var ob = orthoOverlay.bounds;
        center = { lat: (ob.north + ob.south) / 2, lng: (ob.east + ob.west) / 2 };
      } else {
        center = await geocodeAddress(bldAddress || "");
        if (!center){ center = { lat: 39.8283, lng: -98.5795 }; zoom = 4; }
      }
    }
    setTimeout(function(){
      buildingMap = center ? L.map("building-map").setView([center.lat, center.lng], zoom) : L.map("building-map");
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 22, maxNativeZoom: SAT_MAX_NATIVE_ZOOM, attribution: "Tiles &copy; Esri"
      }).addTo(buildingMap);
      if (orthoOverlay) L.imageOverlay(orthoOverlay.url, boundsToLatLngBounds(orthoOverlay.bounds)).addTo(buildingMap);
      outlines.forEach(function(o){
        if (!o.ring || o.ring.length < 3) return;
        L.polygon(o.ring.map(function(p){ return [p.lat, p.lng]; }), {
          color: "#E8600A", weight: 2, fillColor: "#E8600A", fillOpacity: 0.1
        }).addTo(buildingMap).bindPopup(outlinePopupHtml(o, o._roofLabel));
        if (o._roofLabel){
          /* Respects wherever the roof's label was dragged to in
             RoofMapper (o._roofLabelPos, set alongside _roofLabel below)
             -- read-only here (no onClick/onDragEnd), same as before, just
             positioned correctly instead of always the recomputed
             centroid. See "Draggable roof labels" in DEV_NOTES.md. */
          var labelCenter = o._roofLabelPos || o.center || rmGeomRingCentroid(o.ring);
          roofLabelMarker(labelCenter.lat, labelCenter.lng, o._roofLabel).addTo(buildingMap);
        }
      });
      pins.forEach(function(p){
        L.circleMarker([p.lat, p.lng], {
          radius: 9, color: "#fff", weight: 2, fillColor: warrantyColor(p.warranty), fillOpacity: 0.95
        }).addTo(buildingMap).bindPopup(pinPopupHtml(p));
      });
      assets.forEach(function(a){
        if (typeof a.lat !== "number") return;
        L.marker([a.lat, a.lng], { icon: assetIcon(a.type) }).addTo(buildingMap).bindPopup(assetPopupHtml(buildingId, a));
      });
      if (bounds.length === 1) buildingMap.setView(bounds[0], 19);
      else if (bounds.length > 1) buildingMap.fitBounds(bounds, { padding: [30, 30] });
      else if (orthoOverlay) buildingMap.fitBounds(boundsToLatLngBounds(orthoOverlay.bounds));
      buildingMap.invalidateSize();
      setTimeout(function(){ if (buildingMap) buildingMap.invalidateSize(); }, 300);
    }, 50);
  })();
}
