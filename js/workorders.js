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
  /* The job list (Foundation-sourced cache) is the primary section of this
     same picker -- primed independently so it never blocks (or is blocked by)
     the buildings/CompanyCam loads. Guarded so this file has no hard dependency
     on js/foundation.js. */
  if (typeof fdnPrimePicker === "function") fdnPrimePicker();
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
  scheduleChangeOrderAutofill(); /* Change Order only -- see runChangeOrderAutofill() */
}
function bpFoundationJobNameForBuilding(b){
  if (!b || !b.foundationJobNo) return "";
  var jobNo = String(b.foundationJobNo);
  var cached = (typeof fdnCache !== "undefined" && fdnCache) ? fdnCache : [];
  var j = cached.find(function(x){
    return String((x && (x.job_no || x.job_number)) || "") === jobNo;
  });
  return (j && j.name) || b.foundationJobName || b.name || jobNo;
}
function bpSelectBuilding(buildingId){
  var b = (bpCache || []).find(function(x){ return x.id === buildingId; });
  if (!b) return;
  /* Picking a building IS choosing its stable identity (FIX 1) — the doc id
     from the buildings collection, not a name-derived slug. This is also
     the deliberate way to RE-POINT an order at a different building (typing
     a new name into a saved order renames its building instead). */
  currentBuildingId = b.id;
  currentCustomerId = b.customerId || null;
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
  /* Same inheritance rule as CompanyCam: picking an existing building should
     carry its durable Foundation anchor onto a new work order, but must not
     overwrite a job the tech already selected in this session. */
  if (b.foundationJobNo && typeof fdnSetLinkedJob === "function" &&
      (typeof fdnLinkedJobNo === "undefined" || !fdnLinkedJobNo)){
    fdnSetLinkedJob(b.foundationJobNo, bpFoundationJobNameForBuilding(b),
      b.foundationCustomerNo || null, b.foundationAddress || "");
  }
  currentRoofId = null;
  currentRoofIds = null;
  renderLocationDirectionsLink(); /* picked building's address is navigable immediately */
  if (typeof refreshInspectionRoofPickerIfNeeded === "function") refreshInspectionRoofPickerIfNeeded();
  closeBuildingPicker();
  toast("Loaded “" + b.name + "” — review the fields below before saving");
  scheduleInlineBuildingHistoryRefresh();
  /* Change Order only (no-op otherwise): now that this work order is for a
     real building, default its Job No. from that building's parent job and
     adopt the building's CompanyCam link if it has one. */
  scheduleChangeOrderAutofill();
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
var materials = []; /* Repair-type only — see wo-materials-card / addMaterial() below */
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

/* buildingIdFor()/customerIdFor() moved to js/core.js (audit FIX 1) — ONE
   canonical copy of the slug formula instead of five hand-copied ones. */
function lookupRoofInfoMatchesBuilding(info, buildingId){
  return !!(info && info.buildingId && buildingId && info.buildingId === buildingId);
}
function currentWorkOrderBuildingId(){
  /* Stored/stable identity first (currentBuildingId — see js/core.js):
     renaming the job on a saved order must not re-derive a different
     building. Name-derived slug is the legacy/new-order fallback only. */
  return currentBuildingId || buildingIdFor(val("billTo"), val("jobName"));
}
function clearStaleLookupRoofInfoForCurrentOrder(){
  if (!lookupRoofInfoMatchesBuilding(lastLookupRoofInfo, currentWorkOrderBuildingId())){
    lastLookupRoofInfo = null;
  }
}

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
    /* Repairs paired to this finding (before/after — see the pairing block
       below) fall back to unlinked, same rule as the photos above: the
       repair row itself is real work performed and is never deleted with
       the finding it used to resolve. */
    repairs.forEach(function(r){ if (r && r.finding_id === removedId) r.finding_id = null; });
    renderPhotos();
    renderRepairs();
  }
  renderFindings();
}

/* ================= finding ↔ repair pairing (before/after) ================= *
   Mark: a finding's photo is the BEFORE and the paired repair's photo is the
   AFTER of the exact same spot. The pairing is job-centric and single-sourced:
   the REPAIR row carries finding_id (like photos and materials reference
   rows); the finding side is always DERIVED via repairForFinding() — no
   second stored back-reference to drift. Linking carries the finding's
   location and a SNAPSHOT of its pin onto the repair (only where the repair
   doesn't already have its own), so the after-photo is framed on literally
   the same spot; the snapshot is a clone (moving one pin later never yanks
   the other). "After" photos already have a home — the photo dropdown's
   "Repair #N" assignment (#95). The full side-by-side before/after PHOTO
   layout in the report is the flagged fast-follow (per Mark's split:
   linkage + shared pin first); the report meanwhile prints the pairing as a
   "Resolves Finding #N" reference on the Work Performed rows. Cross-ORDER
   pairing (a leak order's finding resolved by a later Work Order's repair)
   is a separate fast-follow — this ships same-order pairing, which is where
   both sections coexist (Inspection/Warranty; the Leak form deliberately
   has no Work Performed card since #46). */
function repairForFinding(findingId){
  if (!findingId) return null;
  return repairs.find(function(r){ return r && r.finding_id === findingId; }) || null;
}
function repairIndexForFinding(findingId){
  if (!findingId) return -1;
  for (var i = 0; i < repairs.length; i++){
    if (repairs[i] && repairs[i].finding_id === findingId) return i;
  }
  return -1;
}
/* "— not linked —" + one option per finding that has any text, labeled with
   the same #N the findings list shows (array position, blanks included, so
   the tech sees matching numbers on screen). */
function repairFindingLinkOptionsHtml(selectedId){
  var opts = ['<option value="">— not linked —</option>'];
  findings.forEach(function(f, i){
    if (!f || !f.id || !(f.condition || f.location)) return;
    var text = (f.condition || f.location).slice(0, 40);
    opts.push('<option value="' + esc(f.id) + '"' + (f.id === selectedId ? " selected" : "") + '>' +
      esc("Finding #" + (i + 1) + " — " + text) + '</option>');
  });
  return opts.join("");
}
/* Carry the finding's spot onto the repair — only into gaps, never over the
   repair's own location or an already-placed pin. Pin is a deep clone. */
function linkRepairToFinding(r, f){
  if (!r || !f) return;
  if (!r.location && f.location) r.location = f.location;
  if (!r.pin && f.pin) r.pin = JSON.parse(JSON.stringify(f.pin));
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
      /* AI issue-ID chip + confirm/correct (js/ailabels.js). Rendered on BOTH
         the finding strip and the inspection-checklist strip: a checklist
         photo is exactly as good a training row as a leak-finding one.
         typeof-guarded because ailabels.js loads AFTER this file and is the
         one module a deploy could legitimately ship without -- a missing
         training-label module must cost one button, never the photo strip. */
      ((typeof aiIssueChipHtml === "function") ? aiIssueChipHtml(x.gi) : "") +
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
/* Checklist items get in-app camera capture AND library add (Mark,
   2026-07-17 field hotfix: techs need to attach existing phone-library
   photos to a checklist item, not only shoot a live one -- e.g. a photo
   taken earlier in the walk, or one already on the phone). CompanyCam
   import stays off the checklist. A live "📷 Take Photo" capture still
   goes through the camera path and auto-pins from the device's current
   GPS (see maybeAutoPinInspectionItem()) -- that pin is what makes the
   photo a "before" reference a later repair photo at the same spot can be
   compared against (before/after-at-a-pin -- see "Inspection checklist
   photo pinning" in ROADMAP.md/DEV_NOTES.md). A library-added photo is
   deliberately left un-pinned (addPhotosFromFiles(): it could be old or
   from elsewhere, so no GPS is guessed) -- same as a finding's library
   add; the tech can still place it manually. */
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
      /* AI issue-ID chip + confirm/correct (js/ailabels.js). Rendered on BOTH
         the finding strip and the inspection-checklist strip: a checklist
         photo is exactly as good a training row as a leak-finding one.
         typeof-guarded because ailabels.js loads AFTER this file and is the
         one module a deploy could legitimately ship without -- a missing
         training-label module must cost one button, never the photo strip. */
      ((typeof aiIssueChipHtml === "function") ? aiIssueChipHtml(x.gi) : "") +
      '</div>';
  }).join("");
  return '<div class="finding-photos">' +
    '<div class="btnrow" style="margin:0">' +
      '<button class="btn primary" onclick="document.getElementById(\'fcam-' + safeId + '\').click()">📷 Take Photo</button>' +
      '<button class="btn" onclick="document.getElementById(\'flib-' + safeId + '\').click()">+ Add Photos</button>' +
      /* Mark, 2026-07-20: the crew routinely shoots a roof into CompanyCam
         first and writes the inspection afterwards, so the photo for a
         checklist section already exists and re-shooting it is busywork. The
         leak-finding strip has had this since the beginning
         (findingPhotoGalleryHtml); the checklist strip did not, for no reason
         other than nobody adding it. openCC(itemId) targets this row exactly
         as it targets a finding -- ccImport() attaches and auto-pins by id. */
      '<button class="btn" onclick="openCC(\'' + safeId + '\')">Add from CompanyCam</button>' +
    '</div>' +
    '<input type="file" id="fcam-' + safeId + '" accept="image/*" capture="environment" style="display:none" ' +
      'onchange="addPhotosFromCamera(this.files, \'' + safeId + '\'); this.value=\'\';">' +
    '<input type="file" id="flib-' + safeId + '" accept="image/*" multiple style="display:none" ' +
      'onchange="addPhotosFromFiles(this.files, \'' + safeId + '\'); this.value=\'\';">' +
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
   show a real name instead of a raw id without a second fetch. The cached
   lookup is only trusted when it belongs to the building currently loaded
   in the form; otherwise null makes the badge disappear instead of showing
   another building's roof name. See "GPS auto-assign photos
   to roofs" in DEV_NOTES.md. */
function rmRoofLabelFromCache(roofId){
  if (!roofId || !lastLookupRoofInfo || !lastLookupRoofInfo.roofs ||
      !lookupRoofInfoMatchesBuilding(lastLookupRoofInfo, currentWorkOrderBuildingId())) return null;
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
    /* Before/after pairing chip — DERIVED from the repair side
       (repairForFinding/repairIndexForFinding; no stored back-ref to
       drift). Shows which Work Performed row resolves this finding. */
    var pairedIdx = (typeof repairIndexForFinding === "function") ? repairIndexForFinding(f.id) : -1;
    var pairedChipHtml = pairedIdx !== -1 ?
      '<span class="evt-tag" style="background:#E8F5E9;color:#2E7D32">🔧 Resolved by Repair #' + (pairedIdx + 1) + '</span>' : '';
    d.innerHTML =
      '<div class="rowhead"><b>Finding #' + (i+1) + '</b>' + roofBadgeHtml + pairedChipHtml + '<span class="sp"></span>' +
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
function pinImageFrameUrlForFinding(f){
  if (pinXYSize && (pinXYSize.imageFrameUrl || pinXYSize.frameUrl)){
    return pinXYSize.imageFrameUrl || pinXYSize.frameUrl;
  }
  if (!lookupRoofInfoMatchesBuilding(lastLookupRoofInfo, currentWorkOrderBuildingId())) return null;
  var roofs = lastLookupRoofInfo.roofs || [];
  var roofId = (f && f.roofId) || currentRoofId || "roof_default";
  var roof = roofs.find(function(r){ return r && r.id === roofId; });
  if (!roof && roofId === "roof_default") roof = roofs[0] || null;
  if (!roof) return null;
  return ((roof.roof_base_map_type === "roof_plan" || roof.roof_base_map_type === "sketch") &&
    roof.roof_base_map_url) ? roof.roof_base_map_url : null;
}
/* Suite TAG (Mark): strip-mall / multi-tenant buildings share one address,
   one roof, one base map — Suite never splits any of that, it's just an
   attribute on the work order (FIELD_IDS "suite", optional/blank for
   single-tenant) that also rides on pins so pins on the shared roof can be
   labeled and filtered by suite. Pins stamp the WO's CURRENT Suite value
   at save time — the tag source of truth is the record's own field. */
function currentSuiteTag(){
  return (val("suite") || "").trim() || null;
}
function pinCoordIsNumber(value){
  return typeof value === "number" && Number.isFinite(value);
}
function pinIsGpsOnly(pin){
  return !!(pin &&
    pinCoordIsNumber(pin.lat) &&
    pinCoordIsNumber(pin.lng) &&
    !pinCoordIsNumber(pin.x) &&
    !pinCoordIsNumber(pin.y));
}
function savePinFromModal(){
  if (!pinMarker || !pinModalFindingId) return;
  var f = findingById(pinModalFindingId);
  if (!f) return;
  var ll = pinMarker.getLatLng();
  if (pinMapMode === "xy" && pinXYSize){
    if (!pinInteracted && pinIsGpsOnly(f.pin)){
      closePinModal();
      toast("Pin left unchanged");
      return;
    }
    var xySource = pinInteracted ? "tech_placed" :
      ((f.pin && f.pin.source) || pinInitialSource || null);
    f.pin = {
      lat: null,
      lng: null,
      x: ll.lng / pinXYSize.w,
      y: ll.lat / pinXYSize.h,
      source: xySource,
      imageFrame: "roof_base_map",
      imageFrameUrl: pinImageFrameUrlForFinding(f),
      suite: currentSuiteTag()
    };
  } else {
    var source = pinDeviceGpsUsed ? "device_gps" :
      (pinInitialSource === "photo_gps" ? (pinInteracted ? "gps_corrected" : "photo_gps") : pinInitialSource);
    f.pin = { lat: ll.lat, lng: ll.lng, x: null, y: null, source: source, suite: currentSuiteTag() };
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

/* ============ repair-area base-map pins — CONTRACT with js/roofmapper.js ============
   Everything ties together around the JOB (Mark): each Work Performed row
   ("repair area") is repair text ⇄ its Repair Scope line ⇄ optionally one pin
   on the job's PERMANENT base map — all carried on the work-order record
   itself (repairs[] round-trips through collect()/fill() like findings do),
   never screen-local, so it's identical wherever the job is opened.

   THIS FILE (js/workorders.js) owns the data side; js/roofmapper.js owns the
   in-form popup UI. The interface, exactly:

     openBaseMapPinPicker(repairAreaId)          — UI entry point, called from the
       row's "📍 Place on Map" button (renderRepairs, js/photos.js). Delegates to
       rmOpenRepairAreaPinPicker(repairAreaId) once js/roofmapper.js provides it;
       until then it's a graceful stub (repair area + scope still fully work).

     rmOpenRepairAreaPinPicker(repairAreaId)     — Codex implements in js/roofmapper.js.
       MUST: open the job's EXISTING permanent base map in an in-form modal
       (resolve the same way the finding pin modal does — no separate/new map);
       fall back to satellite when the job has none georeferenced, and degrade
       gracefully (message, still closable, repair area unaffected) when there's
       no map at all. Reads the row via repairAreaById(); persists ONLY through
       setRepairAreaPin() below — never write r.pin directly.

     repairAreaById(repairAreaId) -> row | null   — row: {id, repair, location, pin}

     setRepairAreaPin(repairAreaId, pin) -> bool  — sole write path. Validates via
       repairAreaPinValid() (rejects the write, returns false, when the shape is
       wrong), stores onto the row, re-renders. Pass pin = null to clear.

   Pin shape — IDENTICAL to finding pins (f.pin), so every existing renderer
   that understands finding pins can be pointed at repair pins unchanged:
     satellite / georeferenced ortho:
       { lat:Number, lng:Number, x:null, y:null, source:"tech_placed"|"device_gps" }
     non-georeferenced roof plan / sketch:
       { lat:null, lng:null, x:0..1, y:0..1, source:"tech_placed",
         imageFrame:"roof_base_map", imageFrameUrl:<the exact image placed against> }
     plus, on BOTH shapes, the optional multi-tenant tag (see
     currentSuiteTag()):
       suite: String|null — e.g. "Suite 12"; a TAG for filtering pins on a
         shared strip-mall roof, never a boundary. The popup may set it
         explicitly (including null); when it's absent, setRepairAreaPin()
         stamps the work order's own Suite field automatically, so the
         popup normally doesn't have to care. Finding pins carry the same
         field (savePinFromModal()).
   Guards enforced here (defense in depth — the popup should uphold them too):
     - Null Island: (0,0) is this codebase's synthetic "no real location"
       convention (#40) — never storable as a real repair pin.
     - Frame binding: an x/y pin is meaningless without the exact base-map image
       it was placed against (#45) — imageFrameUrl is REQUIRED on x/y pins so the
       pin carries its own frame wherever the job is viewed.
     - Only real placements: like savePinFromModal(), the popup must never save
       an un-interacted default/center marker position as a tech placement. */
function repairAreaById(repairAreaId){
  return repairs.find(function(r){ return r && r.id === repairAreaId; }) || null;
}
function repairAreaPinValid(pin){
  if (!pin || typeof pin !== "object") return false;
  var latlng = pinCoordIsNumber(pin.lat) && pinCoordIsNumber(pin.lng);
  var xy = pinCoordIsNumber(pin.x) && pinCoordIsNumber(pin.y);
  if (latlng && !xy) return !(pin.lat === 0 && pin.lng === 0);
  if (xy && !latlng){
    return pin.imageFrame === "roof_base_map" && !!pin.imageFrameUrl &&
      pin.x >= 0 && pin.x <= 1 && pin.y >= 0 && pin.y <= 1;
  }
  return false;
}
function setRepairAreaPin(repairAreaId, pin){
  var r = repairAreaById(repairAreaId);
  if (!r) return false;
  if (pin !== null && !repairAreaPinValid(pin)) return false;
  /* Suite tag rides on every pin (see currentSuiteTag()): an explicit
     suite from the popup (including null) is respected; absent means
     "stamp the work order's own Suite field", so the popup normally
     doesn't have to care. */
  if (pin && pin.suite === undefined) pin.suite = currentSuiteTag();
  r.pin = pin;
  renderRepairs();
  return true;
}
function openBaseMapPinPicker(repairAreaId){
  if (!repairAreaById(repairAreaId)) return;
  if (typeof rmOpenRepairAreaPinPicker === "function"){
    rmOpenRepairAreaPinPicker(repairAreaId);
    return;
  }
  toast("Base-map pin placement for repair areas is coming shortly — this repair area is saved without a pin for now.");
}

/* ================= Work Order material list ================= *
   Itemized materials used on a Work Order (stored type "Repair") — the
   type that executes work and burns material. Same job-centric shape as
   repairs[]/repairItems[]: rows live in materials[] on the work-order
   record (collect()/fill() below), so the list follows the job everywhere
   it's opened — never screen-local.

   Row shape: { id, material, qty, unit, notes, repair_id }
   - id: stable genId("mat"), same plumbing role as finding/repair ids.
   - repair_id: OPTIONAL link to a Work Performed row (repairs[].id) — the
     job-centric tie-in: a material can hang off the same repair area its
     scope line and base-map pin do. null = general/whole-job material.
     Kept loose on purpose (a select per row, photos' finding_id pattern):
     removing a repair area just nulls the link back to "General", the
     material row itself is never deleted with it — the material was still
     used on the job.
   - USER-ENTERED ONLY, nothing is ever written to Foundation. Clean seam
     for later: a Foundation catalog picker would just prefill material/
     unit on this same row shape (and could stamp e.g. foundationItemNo as
     an extra key — collect()/cloudSaveOrder copy whole objects, so no
     schema change needed here). */
function addMaterial(data){
  materials.push(data || {id: genId("mat"), material:"", qty:"", unit:"", notes:"", repair_id:null});
  renderMaterials();
}
function removeMaterial(i){ materials.splice(i,1); renderMaterials(); }
/* "General / whole job" + one option per repair area, labeled by its row
   number and text so the tech recognizes it without ids. Rows without an
   id can't be linked (legacy rows get ids via fill()'s self-heal). */
function materialRepairAreaOptionsHtml(selectedId){
  var opts = ['<option value="">General / whole job</option>'];
  repairs.forEach(function(r, i){
    if (!r || !r.id) return;
    var text = (r.repair || r.location || "").slice(0, 40);
    opts.push('<option value="' + esc(r.id) + '"' + (r.id === selectedId ? " selected" : "") + '>' +
      esc("Repair #" + (i+1) + (text ? " — " + text : "")) + '</option>');
  });
  return opts.join("");
}
function renderMaterials(){
  var host = document.getElementById("materials-list");
  if (!host) return;
  host.innerHTML = "";
  materials.forEach(function(m, i){
    var d = document.createElement("div");
    d.className = "rowcard";
    d.style.borderLeftColor = "#00838F";
    d.innerHTML =
      '<div class="rowhead"><b>Material #' + (i+1) + '</b><span class="sp"></span>' +
      '<button class="btn danger" onclick="removeMaterial(' + i + ')">Remove</button></div>' +
      '<div class="fld"><label>Material / Description</label>' +
      '<input type="text" data-i="' + i + '" data-f="material" value="' + esc(m.material) + '" list="dl-materialName" onblur="rememberFieldValue(\'materialName\', this.value)"></div>' +
      '<div class="grid">' +
      '<div class="fld"><label>Quantity</label><input type="number" min="0" step="any" data-i="' + i + '" data-f="qty" value="' + esc(m.qty) + '"></div>' +
      '<div class="fld"><label>Unit (optional)</label><input type="text" data-i="' + i + '" data-f="unit" value="' + esc(m.unit) + '" list="dl-materialUnit" onblur="rememberFieldValue(\'materialUnit\', this.value)" placeholder="rolls, tubes, sq ft…"></div>' +
      '</div>' +
      '<div class="fld"><label>Notes (optional)</label>' +
      '<input type="text" data-i="' + i + '" data-f="notes" value="' + esc(m.notes) + '"></div>' +
      '<div class="fld"><label>For Repair Area</label>' +
      '<select data-i="' + i + '" data-f="repair_id">' + materialRepairAreaOptionsHtml(m.repair_id) + '</select></div>';
    host.appendChild(d);
  });
  host.querySelectorAll("[data-f]").forEach(function(el){
    el.addEventListener("input", function(){
      /* An empty select value means "General / whole job" — store the same
         null a never-linked row has, not "". */
      materials[+el.dataset.i][el.dataset.f] = (el.dataset.f === "repair_id") ? (el.value || null) : el.value;
    });
  });
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
/* ================= contact phone formatting ================= *
   Auto-formats the work order's contact phone to a consistent US style
   (Mark). ONE constant controls the exact style — his example was
   "(573)489-3291"; shipping the standard "(573) 489-3291" and the space is
   a one-character edit here if he wants it dropped:                       */
var PHONE_DISPLAY_FORMAT = "(AAA) PPP-NNNN";
/* Pure formatter: a clean 10-digit US number (with or without a leading 1,
   punctuation, spaces) comes back in PHONE_DISPLAY_FORMAT — so it's
   idempotent on already-formatted values. ANYTHING else (partial input
   mid-typing, extensions, international) is returned untouched: never
   mangle what we don't positively recognize. The formatted string IS what
   gets stored (display == storage — reports/emails print o.billPhone
   verbatim, and legacy digit-only records normalize on their next open +
   save via fill() below). */
function formatPhoneUS(raw){
  var s = String(raw || "");
  var digits = s.replace(/\D+/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
  if (digits.length !== 10) return s;
  return PHONE_DISPLAY_FORMAT
    .replace("AAA", digits.slice(0, 3))
    .replace("PPP", digits.slice(3, 6))
    .replace("NNNN", digits.slice(6));
}
function renderPhoneFormatting(){
  var el = document.getElementById("billPhone");
  if (!el) return;
  var formatted = formatPhoneUS(el.value);
  if (formatted !== el.value) el.value = formatted;
  renderPhoneCallLink();
}

/* ================= tap-to-call ================= *
   The displayed contact phone is a dialer handoff (Mark) — same spirit as
   the 🧭 Directions link on Location (#124): a 📞 Call anchor under the
   field with a tel: href, so on a phone one tap places the call. Only a
   positively recognized US number gets a link (tel:+1AAAPPPNNNN — E.164,
   which every dialer accepts); extensions/international/partial input get
   no link rather than a wrong one. */
function telHrefFor(phone){
  var digits = String(phone || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return "tel:+1" + digits;
}
function renderPhoneCallLink(){
  var a = document.getElementById("billphone-call");
  if (!a) return;
  var href = telHrefFor(val("billPhone"));
  if (href){
    a.href = href;
    a.style.display = "";
  } else {
    a.style.display = "none";
    a.removeAttribute("href");
  }
}

/* ================= address → turn-by-turn directions ================= *
   The job's Location becomes a navigation handoff (Mark): tap 🧭 Directions
   under the Location field and the device's maps app opens turn-by-turn to
   the address — Apple Maps on iOS/iPadOS, Google Maps everywhere else
   (Android resolves the google.com/maps URL to the native app; desktop gets
   the web app). Opens in a new tab (target=_blank on the anchor) so the
   tech NEVER navigates away from the form they're filling out.
   Address STRING only for now: nav apps geocode a full street address more
   reliably than our building-derived geometry (roof-outline centroids /
   Foundation give no authoritative lat/lng today) — preferring coordinates
   when a trustworthy source exists is a flagged follow-up, not silently
   approximated here. All work-order types — the Location field is shared. */
function isIOSDevice(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    /* iPadOS 13+ masquerades as desktop Safari — MacIntel platform with a
       touch screen is the standard tell. */
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function directionsUrlFor(address){
  var q = String(address || "").trim();
  if (!q) return null;
  return isIOSDevice()
    ? "https://maps.apple.com/?daddr=" + encodeURIComponent(q)
    : "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(q);
}
function renderLocationDirectionsLink(){
  var a = document.getElementById("location-directions");
  if (!a) return;
  var url = directionsUrlFor(val("location"));
  if (url){
    a.href = url;
    a.style.display = "";
  } else {
    a.style.display = "none";
    a.removeAttribute("href");
  }
}

/* ================= "Leak – No Job" catch-all flag ================= *
   Shop convention: a leak call with no real Foundation job yet gets
   written against the "Leak – No Job" catch-all job; Charlotte (Foundation
   record-keeper) later creates the real job and the ticket reconciles to
   its number. The app's job (Mark): make such a ticket impossible to miss —
   a banner on the form, a chip in the Saved list, and an auto-inserted
   note in the outgoing work-order email (which already defaults leaks to
   Charlotte — EMAIL_DEFAULT_TO_LEAK) — until a real job is linked.

   ALL DERIVED, NOTHING STORED: the flag is computed from the job names on
   the record every time it renders, so it clears by itself the moment the
   order is re-linked to the real Foundation job (fill/edit/list all agree,
   on every device, with zero migration or reconciliation bookkeeping).

   ASSUMPTION (flagged for Mark): the catch-all is detected by NAME —
   "leak" followed closely by "no job" in the Foundation-linked job name or
   the visible job name ("Leak - No Job", "LEAK–NO JOB", "leak no job"...).
   If the real Foundation catch-all uses a different name or a well-known
   job number, LEAK_NO_JOB_RE below is the single thing to adjust. */
var LEAK_NO_JOB_RE = /\bleak\b[^A-Za-z0-9]{0,8}no[^A-Za-z0-9]{0,3}job\b/i;
function isLeakNoJobName(name){
  return LEAK_NO_JOB_RE.test(String(name || ""));
}
function isLeakNoJobOrder(o){
  o = o || {};
  /* Rides the catch-all Foundation job itself -> flagged. */
  if (isLeakNoJobName(o.foundationJobName)) return true;
  /* A real (non-catch-all) Foundation job is linked -> reconciled, even if
     the visible job name still says "Leak - No Job" from before. */
  if (o.foundationJobNo && o.foundationJobName) return false;
  return isLeakNoJobName(o.jobName);
}
/* Auto-inserted paragraph for the OUTGOING work-order email (Mark: not a
   separate system email — the tech is emailing the work order to Charlotte
   anyway, the note rides along in that email). "" when not applicable. */
function leakNoJobEmailNote(o){
  if (!isLeakNoJobOrder(o)) return "";
  return "⚠️ LEAK – NO JOB TICKET: This work order is on the “Leak – No Job” catch-all " +
    "and has no real Foundation job number yet. Please create the job/work order in Foundation " +
    "and assign the real job number so this ticket can be reconciled.";
}
function renderLeakNoJobBadge(){
  var el = document.getElementById("wo-leaknojob-banner");
  if (!el) return;
  el.style.display = isLeakNoJobOrder({
    jobName: val("jobName"),
    foundationJobNo: (typeof fdnLinkedJobNo !== "undefined" && fdnLinkedJobNo) ? fdnLinkedJobNo : null,
    foundationJobName: (typeof fdnLinkedJobName !== "undefined" && fdnLinkedJobName) ? fdnLinkedJobName : ""
  }) ? "" : "none";
}
/* Live re-evaluation while the tech types the job name; fill() and
   fdnSetLinkedJob() (js/foundation.js) cover load and job-link changes. */
document.addEventListener("DOMContentLoaded", function(){
  var jn = document.getElementById("jobName");
  if (jn) jn.addEventListener("input", renderLeakNoJobBadge);
  /* Directions link tracks the Location field live as the tech types. */
  var loc = document.getElementById("location");
  if (loc) loc.addEventListener("input", renderLocationDirectionsLink);
  /* Phone auto-format: snaps to PHONE_DISPLAY_FORMAT the moment a full US
     number is present (the 10th digit, a paste, or blur) — partial input
     is never touched mid-typing, so the cursor never fights the tech. */
  var bp = document.getElementById("billPhone");
  if (bp){
    bp.addEventListener("input", renderPhoneFormatting);
    bp.addEventListener("blur", renderPhoneFormatting);
  }
});

/* ================= shared roof-type list ================= *
   The Roof System options are an APP-WIDE, GROWING list (Mark): when a tech
   adds a type that isn't offered, it should stay on the list for every
   future work order on every device — not be a one-off free-text that's
   forgotten. One source of truth feeding every place the field renders:
   the work-order #roofSystem select AND the #dl-roofSystem datalist the
   DPR form's free-text Roof System input suggests from.

   - Builtins live in ROOF_TYPES_BUILTIN below (now including SSM, per
     Mark); user-added types live in Firestore app_settings/roof_types
     { types: [...] } (see firestore.rules — signed-in users may write that
     one doc and nothing else in app_settings), mirrored into localStorage
     so the last-known list still shows offline. The merged view is
     allRoofTypes(): builtins first, additions after, de-duped
     case-insensitively, whitespace-trimmed.
   - "➕ Add new roof type…" is the select's last option: prompt → trim/
     collapse whitespace → if it case-insensitively matches an existing
     type, just select that one (no dupes) → else select it, cache it, and
     arrayUnion it into the shared doc so the next work order anywhere
     already offers it.
   - A record whose saved roofSystem isn't on the list (added elsewhere and
     not yet synced, or pruned later) still displays/keeps its own value —
     populateRoofSystemSelect() injects it as an option rather than blanking
     a select set to an unmatched value.
   - Admin-prune seam: everything user-added is that one doc's types[]
     array — a later admin UI just edits the array (admin.js Admin-SDK
     pattern); nothing else to touch. */
var ROOF_TYPES_BUILTIN = ["FA EPDM","MECH EPDM","Fleece Back EPDM","FA TPO","MECH TPO",
  "Fleece Back TPO","PVC","Fleece Back PVC","BUR / Gravel","BUR Smooth","SBS","Shingles","SSM"];
var ROOF_TYPES_DOC_ID = "roof_types"; /* app_settings/roof_types */
var ROOF_TYPES_CACHE_KEY = "custom-roof-types-v1";
var ROOF_TYPE_ADD_SENTINEL = "__add_new_roof_type__";
var customRoofTypes = [];
var lastRoofSystemValue = ""; /* restore target when "Add new…" is cancelled */
function allRoofTypes(){
  var seen = {}, out = [];
  ROOF_TYPES_BUILTIN.concat(customRoofTypes).forEach(function(t){
    var label = String(t || "").trim();
    if (!label) return;
    var key = label.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(label);
  });
  return out;
}
function populateRoofSystemSelect(value){
  var sel = document.getElementById("roofSystem");
  if (!sel) return;
  var current = (value !== undefined ? (value || "") : sel.value).trim();
  if (current === ROOF_TYPE_ADD_SENTINEL) current = "";
  var types = allRoofTypes();
  var canon = types.find(function(t){ return t.toLowerCase() === current.toLowerCase(); });
  if (canon) current = canon;
  else if (current) types.push(current); /* record's own off-list value stays visible */
  sel.innerHTML = '<option value=""></option>' +
    types.map(function(t){
      return '<option' + (t === current ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('') +
    '<option value="' + ROOF_TYPE_ADD_SENTINEL + '">➕ Add new roof type…</option>';
  sel.value = current;
  lastRoofSystemValue = current;
  populateRoofSystemDatalist();
}
function populateRoofSystemDatalist(){
  var dl = document.getElementById("dl-roofSystem");
  if (!dl) return;
  dl.innerHTML = allRoofTypes().map(function(t){
    return '<option value="' + esc(t) + '">';
  }).join('');
}
function onRoofSystemChange(){
  var sel = document.getElementById("roofSystem");
  if (!sel) return;
  if (sel.value !== ROOF_TYPE_ADD_SENTINEL){
    lastRoofSystemValue = sel.value;
    return;
  }
  var raw = prompt('New roof type (it\'ll be added to the list for every future work order):', "");
  var label = (raw || "").trim().replace(/\s+/g, " ");
  if (!label){
    populateRoofSystemSelect(lastRoofSystemValue);
    return;
  }
  addRoofType(label);
}
function addRoofType(label){
  var existing = allRoofTypes().find(function(t){ return t.toLowerCase() === label.toLowerCase(); });
  if (existing){
    /* Already offered (any casing) — select it, never store a duplicate. */
    populateRoofSystemSelect(existing);
    toast('"' + existing + '" is already on the list — selected it.');
    return;
  }
  customRoofTypes.push(label);
  populateRoofSystemSelect(label);
  try{ localStorage.setItem(ROOF_TYPES_CACHE_KEY, JSON.stringify(customRoofTypes)); }catch(e){}
  if (!fdb){
    toast('Roof type "' + label + '" added on this device — no connection, so it isn\'t on the shared list yet.');
    return;
  }
  fdb.collection("app_settings").doc(ROOF_TYPES_DOC_ID).set(
    { types: firebase.firestore.FieldValue.arrayUnion(label) }, { merge: true }
  ).then(function(){
    toast('Roof type "' + label + '" added to the shared list ✓');
  }).catch(function(e){
    toast("Couldn't save the new roof type to the shared list: " + (e && e.message || e));
  });
}
async function loadRoofTypes(){
  try{
    var raw = localStorage.getItem(ROOF_TYPES_CACHE_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) customRoofTypes = arr.filter(function(t){ return typeof t === "string"; });
  }catch(e){}
  populateRoofSystemSelect();
  if (!fdb) return;
  try{
    var snap = await fdb.collection("app_settings").doc(ROOF_TYPES_DOC_ID).get();
    var data = snap && snap.exists ? snap.data() : null;
    if (data && Array.isArray(data.types)){
      customRoofTypes = data.types.filter(function(t){ return typeof t === "string"; });
      try{ localStorage.setItem(ROOF_TYPES_CACHE_KEY, JSON.stringify(customRoofTypes)); }catch(e){}
      populateRoofSystemSelect(); /* re-render, preserving the current selection */
    }
  }catch(e){ /* offline / rules hiccup — builtins + device cache still work */ }
}

var FIELD_IDS = ["jobName","location","suite","serviceDate","jobNo","projectManager","billTo","billContact","billPhone",
  "siteContact","technician","roofSystem","reportedArea","warrantable","nonWarrantable","summary",
  "woCost","woManHours","woMaterials","woDescription","woPONumber","woDateCompleted","repairDescription",
  "mfgServiceNo"];

/* ===== Service Manager dispatch + proposal linkage =====
   Held as module globals (mirroring the fdnLinked* pattern in js/foundation.js)
   so a dispatched work order survives a normal edit-form round-trip: collect()
   writes them onto the WO and fill() restores them, so a manager who opens a
   dispatched WO in the ordinary edit form and saves never drops its crew / day
   / proposal linkage. cloudSaveOrder() does a FULL-doc ref.set(), so anything
   not carried here would be lost on an edit-form save — hence dispatch lives as
   ONE nested object thread through this one place. js/servicemanager.js is the
   primary WRITER (pre-create builds the object directly; assign/clear use
   targeted Firestore updates); the edit form only preserves what it loaded. */
var smDispatchCrew = null;        // foreman name = the crew key (see DPR_FOREMEN)
var smDispatchDate = null;        // "YYYY-MM-DD" the crew is to run it
var smDispatchStatus = null;      // "assigned" | "cleared" (null = never dispatched)
var smDispatchAssignedAt = null;
var smDispatchAssignedBy = null;
var smDispatchClearedAt = null;
var smDispatchClearedBy = null;
var smProposalRef = null;         // { source, messageId?, attachmentId?, fileName?, subject?, from?, receivedDate?, folder?, upload? }
/* Restores dispatch/proposal globals from a loaded WO. Called by fill(); also
   safe for any caller that needs to reset them (pass {} to clear). */
function smSetDispatchState(o){
  var d = (o && o.dispatch && typeof o.dispatch === "object") ? o.dispatch : {};
  smDispatchCrew = d.crew || null;
  smDispatchDate = d.date || null;
  smDispatchStatus = d.status || null;
  smDispatchAssignedAt = d.assignedAt || null;
  smDispatchAssignedBy = d.assignedBy || null;
  smDispatchClearedAt = d.clearedAt || null;
  smDispatchClearedBy = d.clearedBy || null;
  smProposalRef = (o && o.proposal && typeof o.proposal === "object") ? o.proposal : null;
}
/* Assembles the nested dispatch object from the current globals (or null when
   this WO was never dispatched, so an ordinary WO doesn't grow the field). */
function smBuildDispatchField(){
  if (!(smDispatchCrew || smDispatchDate || smDispatchStatus)) return null;
  return {
    crew: smDispatchCrew || null,
    date: smDispatchDate || null,
    status: smDispatchStatus || null,
    assignedAt: smDispatchAssignedAt || null,
    assignedBy: smDispatchAssignedBy || null,
    clearedAt: smDispatchClearedAt || null,
    clearedBy: smDispatchClearedBy || null
  };
}

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
  o.materials = materials.slice();
  o.inspectionChecklist = inspectionChecklist.slice();
  o.photos = photos.slice();
  o.companyCamProjectId = ccLinkedProjectId || null;
  o.companyCamProjectName = ccLinkedProjectName || "";
  /* Foundation (construction accounting) job linkage — set when a Foundation
     job was picked (js/foundation.js). Kept as its own field (not derived from
     jobNo) so the WO's admin-only labor-hours card can look hours up by the
     exact Foundation job_no even if the human edits the visible Job No. after.
     Persisted on the WO by cloudSaveOrder (copies all keys), AND onto the
     BUILDING doc by ensureCustomerAndBuilding() — customerNo + address ride
     along so the building carries the full accounting identity/anchor (#76). */
  /* Stable identity (FIX 1) — stamped from currentBuildingId/currentCustomerId
     (js/core.js): set on load for docs that carry it, on building pick, and
     by saveOrder() after ensureCustomerAndBuilding(). null on a brand-new
     or legacy order until first save; readers fall back to the name slug. */
  o.buildingId = currentBuildingId || null;
  o.customerId = currentCustomerId || null;
  /* CompanyCam document artifact (vars in js/core.js): stamped so a rebuilt
     order still KNOWS its uploaded PDF — keeps the #54 idempotency guard
     alive across reloads and lets status reconciliation prove a document
     exists (Sophia's Curb Flashing false "failed"). */
  o.ccDocumentId = currentCcDocumentId || null;
  o.ccDocumentHash = currentCcDocumentHash || null;
  o.foundationJobNo = (typeof fdnLinkedJobNo !== "undefined" && fdnLinkedJobNo) ? fdnLinkedJobNo : null;
  o.foundationJobName = (typeof fdnLinkedJobName !== "undefined" && fdnLinkedJobName) ? fdnLinkedJobName : "";
  o.foundationCustomerNo = (typeof fdnLinkedCustomerNo !== "undefined" && fdnLinkedCustomerNo) ? fdnLinkedCustomerNo : null;
  o.foundationAddress = (typeof fdnLinkedAddress !== "undefined" && fdnLinkedAddress) ? fdnLinkedAddress : "";
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
  var buildingId = o.buildingId || buildingIdFor(o.billTo, o.jobName); /* same stored-id-first rule as the lookup that filled the cache */
  o.roofLabels = (lookupRoofInfoMatchesBuilding(lastLookupRoofInfo, buildingId) && lastLookupRoofInfo.roofs) ?
    lastLookupRoofInfo.roofs.reduce(function(m, r){ m[r.id] = r.label || "Roof"; return m; }, {}) : null;
  /* roofSystems rides alongside roofLabels for exactly the same reason: a
     multi-roof inspection report has to say WHICH system each roof is, and the
     report builders are synchronous with no Firestore access. Mark's case is a
     facility carrying EPDM, TPO and mod-bit at once -- the label alone
     ("Roof B") doesn't tell a reader what they're looking at. Null when no
     roof lookup has happened, same as roofLabels; the report simply omits the
     system rather than guessing one. */
  o.roofSystems = (lookupRoofInfoMatchesBuilding(lastLookupRoofInfo, buildingId) && lastLookupRoofInfo.roofs) ?
    lastLookupRoofInfo.roofs.reduce(function(m, r){ if (r.roofSystem) m[r.id] = r.roofSystem; return m; }, {}) : null;
  o.changeOrderSignature = changeOrderSignature || null;
  /* Service Manager dispatch (crew + day + status) and proposal linkage. Both
     null for an ordinary WO; carried here so an edit-form save never drops a
     dispatched WO's assignment or its source proposal (see the globals block
     above). The board queries dispatch.date/dispatch.status; assign/clear write
     these via targeted updates, but this keeps them alive across full re-saves. */
  o.dispatch = smBuildDispatchField();
  o.proposal = smProposalRef || null;
  return o;
}
/* ============ AI-drafted summary, Phase 1 (see DEV_NOTES.md) ============ */
/* Pure projection of a collected work order into the compact payload the
   summary-draft server function consumes (netlify/functions/
   generate-summary.js) — the text a summary is made of plus each photo's
   caption AND Storage ref (the ref is how the Phase-1 vision model will
   actually SEE the photo: the server turns it into a short-lived SIGNED url
   there, never here, never public). Still never photo BYTES, pins, GPS,
   per-row ids, or signatures. The work-order ID itself DOES ride (Phase
   1.5): dev's Firebase project has no Storage bucket, so its photos live
   INLINE in Firestore with no storageRef to sign — the id is how the server
   reads those bytes back out ITSELF (collectInlinePhotoImages() in
   generate-summary.js) to show the vision model. Bytes stay server-side in
   both directions. A photo captured but not yet cloud-saved has no
   storageRef yet — it rides caption-only, so drafting right after a save
   sees everything. Checklist keys become their display labels here because
   the server has no INSPECTION_CHECKLIST_COMPONENTS; N/A rows are dropped.
   Kept pure/DOM-free so tests can vm-extract it
   (tests/generateSummaryDraft.test.js). */
function buildSummaryDraftPayload(o){
  function s(v, max){ return String(v == null ? "" : v).slice(0, max || 300); }
  var labelByKey = {};
  INSPECTION_CHECKLIST_COMPONENTS.forEach(function(c){ labelByKey[c.key] = c.label; });
  return {
    /* SEED (Mark, 2026-07-19): whatever the tech has already typed in the
       Summary box. Until now this was read only to warn before overwriting --
       the model never saw it, so a half-written summary was discarded and
       regenerated from scratch. It is now the STARTING POINT: the prompt
       refines and extends it rather than replacing it. Bounded at 4000 chars,
       the same clamp discipline as every other field here (the server's
       sanitizeReport() enforces the same bound independently). */
    summary: s(o.summary, 4000),
    workOrderId: s(o.id, 80),
    woType: s(o.woType, 40),
    jobName: s(o.jobName, 200),
    location: s(o.location, 300),
    serviceDate: s(o.serviceDate, 40),
    technician: s(o.technician, 120),
    roofSystem: s(o.roofSystem, 200),
    reportedArea: s(o.reportedArea, 300),
    warrantable: s(o.warrantable, 1000),
    nonWarrantable: s(o.nonWarrantable, 1000),
    inspectionChecklist: (o.inspectionChecklist || []).filter(function(it){
      return it && it.rating && it.rating !== "N/A";
    }).slice(0, 20).map(function(it){
      return { label: labelByKey[it.key] || s(it.key, 60), rating: s(it.rating, 20), notes: s(it.notes, 500) };
    }),
    findings: (o.findings || []).filter(function(f){
      return f && ((f.condition || "").trim() || (f.location || "").trim());
    }).slice(0, 50).map(function(f){
      return { condition: s(f.condition, 500), location: s(f.location, 300), warranty: s(f.warranty, 40) };
    }),
    repairs: (o.repairs || []).filter(function(r){
      return r && ((r.repair || "").trim() || (r.location || "").trim());
    }).slice(0, 50).map(function(r){
      return { repair: s(r.repair, 500), location: s(r.location, 300) };
    }),
    repairDescription: s(o.repairDescription, 2000),
    repairItems: (o.repairItems || []).filter(function(it){
      return it && ((it.type || "").trim() || (it.notes || "").trim());
    }).slice(0, 50).map(function(it){
      return { type: s(it.type, 120), qty: s(it.qty, 20), notes: s(it.notes, 500) };
    }),
    photos: (o.photos || []).filter(function(p){
      return p && ((p.caption || "").trim() || p.storageRef);
    }).slice(0, 60).map(function(p){
      return { caption: s(p.caption, 300).trim(), storageRef: p.storageRef ? s(p.storageRef, 300) : null };
    }),
    photoCount: (o.photos || []).length
  };
}
/* "✨ Draft Summary" click handler (index.html's Summary card) — shared by
   all three report types that show the button (Inspection, Leak, Work
   Order). Sends the projection above to the server (Firebase-auth-gated:
   doc.generate) and puts the returned text into the Summary TEXTAREA only —
   a draft the tech edits, never saved or sent by this function. On-demand
   only (this button IS the cost control — drafting never fires on save or
   open). Server side routes through lib/aiProvider.js — live vision model
   where a key exists (dev), deterministic placeholder elsewhere (prod) —
   see generate-summary.js's header. */
async function draftReportSummary(btn){
  /* Teaser gate (Mark, 2026-07-17): on a keyless deploy — production today, no
     ANTHROPIC/OPENAI key — the button is SHOWN but drafting isn't wired up yet,
     so a tap is a friendly "coming soon", never an error and never a
     half-generated placeholder. Whether a key exists lives server-side only, so
     read the cached capability probe: aiSummaryConfigured() is true (keyed),
     false (keyless), or null (not yet probed — await the probe so a fast first
     tap still branches correctly). The moment a key is provisioned this returns
     true and the real generate flow below runs completely untouched. */
  var configured = (typeof aiSummaryConfigured === "function") ? aiSummaryConfigured() : null;
  if (configured === null && typeof probeAiSummaryCapability === "function"){
    /* Disable ONLY across the probe await (a disabled button fires no onclick),
       so a double-tap before the probe resolves can't start two drafts. The
       probe is pre-warmed on type-select, so this branch is almost never taken;
       when it is, the finally re-enables on every outcome — no leaked-disabled
       button, and the paths below (confirm-cancel, etc.) are untouched. */
    if (btn) btn.disabled = true;
    try{ configured = await probeAiSummaryCapability(); }
    catch(e){ configured = false; }
    finally{ if (btn) btn.disabled = false; }
  }
  if (!configured){ toast("✨ AI Draft Summary — coming soon"); return; }
  /* Seed-and-expand: the tech's own text is now sent as the starting point,
     so the confirm says what actually happens -- the draft BUILDS ON his
     words rather than discarding them. Still confirmed rather than silent,
     because the textarea is replaced by the result either way. */
  var existing = val("summary");
  if (existing && existing.trim() &&
      !confirm("Draft from what you've written?\n\nYour text is used as the starting point — the AI will refine and expand it, then replace the box with the result.")) return;
  if (btn) btn.disabled = true;
  try{
    var payload = buildSummaryDraftPayload(collect());
    /* Downscaled photo bytes for the vision model, via the SHARED ~900px
       helper in js/export.js (the same one the PDF uses). Sent from the
       client because the downscale is a canvas operation the server can't
       do without pulling in an image library. The server still enforces its
       own per-image and count caps -- this is the cheap path, not the trust
       boundary. Failure here degrades to text-only rather than blocking a
       draft, matching how the server treats a Storage outage. */
    try{
      if (typeof aiVisionImageParts === "function"){
        payload.visionImages = await aiVisionImageParts(photos, 8);
      }
    }catch(e){ /* text-only draft */ }
    var r = await fetch("/.netlify/functions/generate-summary", {
      method: "POST", headers: await authHeaders(),
      body: JSON.stringify({ action: "draft_summary", report: payload })
    });
    var out = null; try{ out = await r.json(); }catch(e){}
    if (!r.ok || !out || !out.ok || !out.draft){
      toast("Summary draft failed: " + ((out && out.error) || ("server error " + r.status)));
      return;
    }
    setVal("summary", out.draft);
    /* Tell the tech WHO answered — the server reports provenance
       ({llm, fallback, model, photosSeen}) and the three cases mean very
       different things: a real AI draft, an AI outage the fallback covered,
       or a site with no AI key at all (production, deliberately). Without
       this, a fallback draft is indistinguishable from success — exactly
       how the first live test on dev (2026-07-16) went unnoticed. */
    if (out.llm){
      var seen = out.photosSeen || 0;
      toast("AI draft inserted (" + (out.model || "model") + ", " + seen + " photo" + (seen === 1 ? "" : "s") +
        " reviewed) — review and edit it before saving or sending.");
    } else if (out.fallback){
      /* The provider's own (truncated) rejection rides back as out.aiError —
         "invalid x-api-key", "model not found", credit exhaustion — so the
         person clicking can see WHY instead of guessing (added while
         diagnosing the 2026-07-16 dev test, where this took three rounds). */
      toast("⚠️ AI didn't answer — a plain placeholder draft was inserted instead." +
        (out.aiError ? " (" + out.aiError + ")" :
          " Try again in a minute; if it keeps happening, the AI key/credits need a look."));
    } else {
      toast("Placeholder draft inserted (no AI on this site) — review and edit it before saving or sending.");
    }
  }catch(e){
    toast("Summary draft failed: " + (e && e.message ? e.message : "network error"));
  }finally{
    if (btn) btn.disabled = false;
  }
}
function fill(o){
  currentId = o.id;
  /* Stable identity (FIX 1): a doc that carries stored ids keeps them for
     this whole edit session — name edits rename the building rather than
     re-deriving a fork. Legacy docs (no stored id) load null and keep the
     old slug-fallback behavior byte-for-byte. */
  currentBuildingId = o.buildingId || null;
  currentCustomerId = o.customerId || null;
  currentCcDocumentId = o.ccDocumentId || null;
  currentCcDocumentHash = o.ccDocumentHash || null;
  currentRoofId = o.roofId || null;
  currentRoofIds = (o.roofIds && o.roofIds.length > 1) ? o.roofIds.slice() : null;
  /* Must be set before onWoTypeChange() below (Inspection's branch reads
     inspectionChecklist to render it) so a freshly loaded order's own
     checklist is what gets shown, not whatever was left over from
     whichever order was open before this one. */
  inspectionChecklist = (o.inspectionChecklist || []).slice();
  FIELD_IDS.forEach(function(k){ setVal(k, o[k]); });
  /* setVal on a select silently lands on "" when the value matches no
     option — a roofSystem added on another device (or later pruned) would
     display blank and then be SAVED back blank on the next save. Rebuild
     the options around this record's own value instead. */
  populateRoofSystemSelect(o.roofSystem || "");
  /* Legacy digit-only phone values display formatted from the first open
     (and, since display == storage, normalize on the next save). A value
     the formatter doesn't positively recognize passes through untouched. */
  setVal("billPhone", formatPhoneUS(o.billPhone));
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
  /* Same self-heal as findings above: repair areas saved before ids/pins
     existed get a stable id (so a base-map pin can reference the row) and an
     explicit null pin — never a fabricated location, just plumbing. */
  repairs.forEach(function(r){
    if (!r.id) r.id = genId("rep");
    if (r.pin === undefined) r.pin = null;
    if (r.finding_id === undefined) r.finding_id = null; /* before/after pairing (null = not linked) */
  });
  repairItems = (o.repairItems || []).slice(); /* Repair type only — no forced minimum row, optional */
  materials = (o.materials || []).slice(); /* Repair type only — no forced minimum row, optional */
  /* Same self-heal as findings/repairs above: id is plumbing (row identity
     for the repair-area link), repair_id gets an explicit null. */
  materials.forEach(function(m){
    if (!m.id) m.id = genId("mat");
    if (m.repair_id === undefined) m.repair_id = null;
  });
  photos = (o.photos || []).slice();
  photos.forEach(function(p){ if (p.finding_id === undefined) p.finding_id = null; });
  ccLinkedProjectId = o.companyCamProjectId || null;
  ccLinkedProjectName = o.companyCamProjectName || "";
  /* Audit FIX 3: ANY work-order type on a linked building inherits the
     building's CompanyCam link on load (debounced; no-op when this order
     already carries a link, when there's no building yet, or offline —
     see resolveBuildingCompanyCamLink()). The export path re-resolves
     right before a PDF push regardless; this is the eager half so the
     banner shows the link while editing. */
  if (!ccLinkedProjectId && typeof scheduleResolveBuildingCCLink === "function") scheduleResolveBuildingCCLink();
  /* Restore the Foundation job linkage and refresh its dependent UI (the link
     line + the admin-only labor card). Guarded so this file has no hard
     dependency on js/foundation.js being present. */
  if (typeof fdnSetLinkedJob === "function") fdnSetLinkedJob(o.foundationJobNo || null, o.foundationJobName || "", o.foundationCustomerNo || null, o.foundationAddress || "");
  /* Whatever Job No. this order carries is now the LOADED order's number, not
     something this session auto-filled -- so the Change Order autofill below
     must treat it as a human's value and never overwrite it. Reset on every
     load/new. */
  coJobNoAutoValue = null;
  changeOrderSignature = o.changeOrderSignature || null;
  /* Restore Service Manager dispatch + proposal linkage (or clear it for a WO
     that carries none) so a subsequent collect() preserves it. */
  smSetDispatchState(o);
  clearStaleLookupRoofInfoForCurrentOrder();
  renderFindings(); renderRepairs(); renderRepairItems(); renderMaterials(); renderPhotos(); renderCCLinkInfo(); renderChangeOrderSignature();
  /* Re-render the checklist now that photos[]/findings[] are the truly
     loaded values, not whatever onWoTypeChange() saw mid-load above --
     otherwise a checklist item's photo gallery could briefly reflect the
     PREVIOUSLY open order instead of this one. Cheap, harmless if run
     twice. */
  if (val("woType") === "Inspection"){ ensureInspectionChecklist(); renderInspectionChecklist(); }
  if (typeof refreshInspectionRoofPickerIfNeeded === "function") refreshInspectionRoofPickerIfNeeded();
  renderLeakNoJobBadge();
  renderLocationDirectionsLink();
  renderPhoneCallLink();
  scheduleInlineBuildingHistoryRefresh();
}
/* ================= Change Order autofill =================
   Two Change-Order-only defaults, both derived from the building the work
   order is already for, both overridable, neither of which touches any other
   work order type:

   1. Job No. = the parent job's number with " CO" appended (Mark: parent
      16153 -> "16153 CO"). A change order is a change to an EXISTING job, so
      its number is that job's number, marked as the change order. The parent
      number comes from the building's own timeline (building_history_events,
      the same query the inline Building History card already runs), newest
      first, preferring a non-Change-Order entry -- a CO on a building whose
      most recent entry is itself a CO ("16153 CO") still resolves to base
      "16153", never "16153 CO CO" (changeOrderJobNo() is idempotent).

   2. The building's CompanyCam link (resolveBuildingCompanyCamLink(), in
      js/companycam.js) -- so a CO on an already-linked building pushes its
      signed PDF with no manual step.

   NEVER overwrites a number the tech typed: coJobNoAutoValue remembers the
   exact string THIS code last auto-filled, and autofill only writes when the
   field is empty or still holds that remembered value. Anything else in the
   field is a human's, and is left alone. */
var coJobNoAutoValue = null;
var coAutofillTimer = null, coAutofillSeq = 0, coAutofillListenersInstalled = false;
function changeOrderJobNo(baseJobNo){
  var base = String(baseJobNo == null ? "" : baseJobNo).trim();
  if (!base) return "";
  return base.replace(/\s*CO\s*$/i, "").trim() + " CO";
}
/* Newest-first events (loadBuildingHistoryEvents() already sorts them that
   way). A Change Order's own number ("16153 CO") is stripped back to its
   base, so the parent number is recovered whether the newest entry is the
   original work order or a previous change order against it. */
function parentJobNoFromHistoryEvents(events){
  var numbered = (events || []).filter(function(e){ return e && String(e.workOrderNo || "").trim(); });
  var parent = numbered.find(function(e){ return e.workOrderType !== "Change Order"; }) || numbered[0];
  if (!parent) return "";
  return String(parent.workOrderNo).replace(/\s*CO\s*$/i, "").trim();
}
function coJobNoIsAutoOrEmpty(){
  var cur = (val("jobNo") || "").trim();
  return !cur || cur === coJobNoAutoValue;
}
async function maybeApplyChangeOrderJobNo(){
  if (val("woType") !== "Change Order") return { skipped: true, reason: "not-a-change-order" };
  if (!coJobNoIsAutoOrEmpty()) return { skipped: true, reason: "user-entered" };
  if (!fdb) return { skipped: true, reason: "offline" };
  var buildingId = currentWorkOrderBuildingId();
  if (!buildingId) return { skipped: true, reason: "no-building" };
  var seq = ++coAutofillSeq;
  try{
    var events = await loadBuildingHistoryEvents(buildingId, 50);
    if (seq !== coAutofillSeq) return { skipped: true, reason: "superseded" };
    var base = parentJobNoFromHistoryEvents(events);
    if (!base) return { skipped: true, reason: "no-parent-job-no" };
    var next = changeOrderJobNo(base);
    /* Re-check after the await: the tech may have typed a number while the
       building's timeline was loading. Theirs wins, always. */
    if (!coJobNoIsAutoOrEmpty()) return { skipped: true, reason: "user-entered" };
    if ((val("jobNo") || "").trim() === next){ coJobNoAutoValue = next; return { ok: true, jobNo: next, unchanged: true }; }
    setVal("jobNo", next);
    coJobNoAutoValue = next;
    toast("Job No. set to “" + next + "” from this building’s last work order — edit it if that’s not right.");
    return { ok: true, jobNo: next };
  }catch(e){
    console.warn("Change Order job number autofill failed", e);
    return { ok: false, error: e.message };
  }
}
async function runChangeOrderAutofill(){
  if (val("woType") !== "Change Order") return;
  if (typeof resolveBuildingCompanyCamLink === "function") await resolveBuildingCompanyCamLink();
  await maybeApplyChangeOrderJobNo();
}
/* Debounced, and re-run whenever the fields that DERIVE the building change
   (buildingIdFor() is billTo + jobName) -- typing a job name by hand is the
   path the building picker doesn't cover. Listeners are installed lazily,
   once, the first time a Change Order form is shown. */
function installChangeOrderAutofillListeners(){
  if (coAutofillListenersInstalled) return;
  var ids = ["jobName", "billTo"];
  var bound = 0;
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("blur", scheduleChangeOrderAutofill);
    bound++;
  });
  coAutofillListenersInstalled = (bound === ids.length);
}
function scheduleChangeOrderAutofill(){
  installChangeOrderAutofillListeners();
  if (coAutofillTimer) clearTimeout(coAutofillTimer);
  coAutofillTimer = setTimeout(function(){ runChangeOrderAutofill(); }, 120);
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
      (photos && photos.length) || filledFindings().length || filledRepairs().length ||
      filledMaterials().length);
  }catch(e){ return false; }
}
/* "+ New" (header) and "+ New Work Order" (Building History's empty
   state) both land here — now a launcher, not an immediate blank
   Leak/Service form, so the user picks a type first (see
   startNewWorkOrder() below).

   The guard used to be `hasContent() && confirm("...will be lost")`. Both
   halves went stale once continuous autosave landed: hasContent() is a
   has-ANY-content check rather than a dirty check, so it fired on clean
   saved orders, and nothing "will be lost" — the outgoing order is
   autosaved under its own id and sits in the Saved list. The one risk
   worth interrupting a roofer for is work that never reached the cloud.

   The guard also moved OFF this function and onto startNewWorkOrder() /
   loadOrder(), the two calls that actually destroy in-memory state by
   calling fill(). newOrder() only navigates to the launcher — the current
   form is still intact behind it, and prompting here as well as at the
   tile meant two dialogs to get through to a blank form. showView()'s
   wrapper flushes the autosave on the way out. */
function newOrder(){
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
    '<button class="home-tile home-tile-secondary" onclick="showView(\'dpr\')">' +
      '<span class="home-tile-icon">📅</span><span class="home-tile-label">Daily Progress Report</span></button>',
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
  /* fill() below reassigns currentId and every array — this is one of the
     two real points where the current form stops being reachable. Guard
     here rather than in newOrder(); see confirmLeaveUnclouded(). */
  if (!confirmLeaveUnclouded("Start a new " + (WORK_ORDER_TYPE_LABELS[type] || type) + " anyway?")) return;
  fill({ id: "wo_" + Date.now(), serviceDate: todayStr(), woType: type });
  showView("edit");
  scheduleInlineBuildingHistoryRefresh();
  toast("New " + (WORK_ORDER_TYPE_LABELS[type] || type) + " started");
}

/* ================= never lose edits on back-out =================
   Mark, field use 2026-07-17: he was in an edited, un-emailed report and
   backed out of it unsure whether the edits had survived.

   What was actually true before this block, and why the fix is shaped the
   way it is (the trace is worth keeping -- the obvious fix here is the
   wrong one):

   Backing out of the edit view NEVER lost anything. There is no Back or
   Cancel button at all; the exits are the nav tabs, the header logo and
   the home tiles, and every one of them goes through showView(), which is
   a pure CSS show/hide (js/core.js). It never tears the form down, never
   clears findings/repairs/materials/photos, never nulls currentId. Tab
   away, tab back, the form is exactly as it was. On top of that,
   core.js's debounced local autosave had already written the order to
   localStorage 4s after typing stopped.

   So the honest gap was NOT "edits vanish" -- it was that the tech had no
   way to know the work was device-local only, plus three narrow holes:

     1. That autosave is deliberately localOnly, so it never enters the
        sync queue. core.js's beforeunload warning gates on that queue --
        which means a work order that was never explicitly Saved produced
        NO warning on refresh/close, the exact case where a warning is
        most warranted.
     2. The last <4s of typing (the pending debounce) was flushed by
        nothing -- not unload, not phone-lock, not a view swap.
     3. newOrder()'s guard used hasContent(), a has-ANY-content check
        rather than a dirty check, so it fired on clean saved orders and
        told the user their work "will be lost" when autosave had in fact
        already kept it.

   Deliberately NOT done: a confirm() on tab switches. Nothing is lost
   there, and a field-first app must not nag a roofer every time they
   glance at Building History (Mark: keep the roof flows dead-simple). We
   flush instead of prompting, and prompt only where work genuinely goes
   away or genuinely never left the device.

   Lives here rather than in core.js on purpose: workorders.js loads after
   core.js, so it can layer this on with listeners and thin wrappers and
   zero edits to a shared file. */

/* Set on any edit; cleared when an explicit (cloud) Save succeeds. In
   memory only -- the durable half of the question is answered by
   _cloudBaseSavedAt on the stored record (stamped in cloudSaveOrder). */
var woEditDirty = false;

/* True when this order has content that has never made it off the device.
   Both halves matter: _cloudBaseSavedAt is 0/absent until a cloud save has
   actually landed, and the sync queue holds orders whose explicit Save is
   still waiting on a network. */
function woEditHasUncloudedWork(){
  try{
    if (!currentId || !hasContent()) return false;
    var q = (typeof loadSyncQueue === "function") ? loadSyncQueue() : {};
    if (q && q[currentId]) return true;
    var rec = loadDb().orders[currentId];
    if (!rec || !rec._cloudBaseSavedAt) return true;   /* never reached the cloud */
    return woEditDirty;                                /* reached it, but has newer edits */
  }catch(e){ return false; }
}

/* Close the debounce window on demand. core.js's timer handle is a plain
   top-level var (global), so we can cancel the pending run and persist
   immediately rather than racing it. Local-only by design -- same contract
   as the autosave it is short-circuiting; this must never fire a network
   request from an unload handler, where it would be killed mid-flight
   anyway. */
function flushWorkOrderAutosave(){
  try{
    if (typeof localAutosaveTimer !== "undefined" && localAutosaveTimer){
      clearTimeout(localAutosaveTimer);
      localAutosaveTimer = null;
    }
    var view = document.getElementById("view-edit");
    if (!view || view.style.display === "none") return;
    if (!currentId || !hasContent()) return;
    saveOrder({ quiet: true, localOnly: true });
  }catch(e){ console.warn("autosave flush failed", e); }
}

/* Mark dirty on the same delegated listener pattern core.js uses, so every
   current and future field in the view is covered without per-field wiring. */
document.addEventListener("DOMContentLoaded", function(){
  var editView = document.getElementById("view-edit");
  if (!editView) return;
  editView.addEventListener("input", function(){ woEditDirty = true; });
  editView.addEventListener("change", function(){ woEditDirty = true; });
});

/* An explicit Save that reaches the cloud is what makes the form clean
   again. Wrapping rather than editing core.js: index.html's inline
   onclick="saveOrder()" resolves off window at call time, so the wrapper
   is what every Save button gets. localOnly saves (the autosave) must NOT
   clear the flag -- they are exactly the case we are tracking. */
(function(){
  if (typeof saveOrder !== "function") return;
  var coreSaveOrder = saveOrder;
  window.saveOrder = function(opts){
    var result = coreSaveOrder.apply(this, arguments);
    if (!opts || !opts.localOnly){
      Promise.resolve(result).then(function(ok){ if (ok) woEditDirty = false; }, function(){});
    }
    return result;
  };
})();

/* Leaving the edit view for any other view: flush, don't prompt (see the
   header note). Also covers the logo and the home tiles, which reach
   showView() directly. */
(function(){
  if (typeof showView !== "function") return;
  var coreShowView = showView;
  window.showView = function(v){
    try{
      var view = document.getElementById("view-edit");
      if (v !== "edit" && view && view.style.display !== "none") flushWorkOrderAutosave();
    }catch(e){}
    return coreShowView.apply(this, arguments);
  };
})();

/* Phone locking, app-switching, tab close, refresh -- the field cases the
   4s debounce used to lose. pagehide is the one that actually fires
   reliably on mobile Safari/Chrome when the phone locks; visibilitychange
   covers app-switching without a teardown. */
window.addEventListener("pagehide", flushWorkOrderAutosave);
document.addEventListener("visibilitychange", function(){
  if (document.visibilityState === "hidden") flushWorkOrderAutosave();
});

/* The hole core.js's beforeunload couldn't see: work that never reached
   the cloud is never in the sync queue, so that handler stayed silent on
   precisely the riskiest order. Flush first so the local copy is current
   even if the user leaves anyway -- then warn. Browsers show their own
   generic text; setting returnValue is only what triggers the prompt. */
window.addEventListener("beforeunload", function(e){
  flushWorkOrderAutosave();
  if (woEditHasUncloudedWork()){
    e.preventDefault();
    e.returnValue = "";
  }
});

/* The two transitions that genuinely destroy in-memory state: both call
   fill(), which reassigns currentId and every array. Autosave means the
   outgoing order survives under its own id (it is in the Saved list), so
   the prompt is only warranted -- and only honest -- when the work never
   reached the cloud. */
function confirmLeaveUnclouded(actionText){
  flushWorkOrderAutosave();
  if (!woEditHasUncloudedWork()) return true;
  return confirm(
    "This work order is saved on this device but hasn't reached the cloud yet — " +
    "it won't show up on another phone or tablet.\n\n" +
    actionText + "\n\n" +
    "Hit Cancel and press Save first if you want it synced."
  );
}

/* The other fill() caller that discards the current form: opening a
   different saved order. Guarded the same way and for the same reason as
   startNewWorkOrder(). Re-opening the order already on screen is a no-op
   worth letting through silently. */
(function(){
  if (typeof loadOrder !== "function") return;
  var coreLoadOrder = loadOrder;
  window.loadOrder = function(id){
    if (id !== currentId && !confirmLeaveUnclouded("Open the other work order anyway?")) return;
    return coreLoadOrder.apply(this, arguments);
  };
})();
