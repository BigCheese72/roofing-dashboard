"use strict";

/* ================= Daily Progress Report (DPR) — Phase 1 (Core) =================

   A field-facing report, DISTINCT from the Leak / Work Order / Change Order /
   Inspection forms (those are all `woType`s of one work order; a DPR is its
   own thing). It answers "what happened on this job today," contributed to by
   whoever was on the roof that day.

   KEYING — ONE DPR PER JOB PER DAY. The Firestore doc id is derived, not
   random: `dpr_<buildingId>_<YYYY-MM-DD>` where buildingId is the SAME
   canonical id the rest of the app derives from Bill To + Job Name (see
   ensureCustomerAndBuilding() / buildingIdFor() in core.js/workorders.js). So
   a second crew opening the DPR for the same building + date lands on the
   SAME doc and adds to it, rather than creating a duplicate — the deterministic
   id is what enforces "one per day" structurally (see dprDocId / dprBuildingId
   below, and dprLoadForBuildingDate() which continues an existing day's report).

   REUSE, not reinvention:
   - Photos ride the EXISTING work-order photo path — uploadPhotoToStorage() /
     resolvePhotoImg() (core.js), the /.netlify/functions/photos proxy, and the
     same storageRef convention. A DPR photo simply uses the DPR's own doc id;
     the proxy builds `workorders/<id>/<index>.jpg` server-side regardless of
     prefix, and resolvePhotoImg() parses it straight back. No new storage path.
   - Building customer/address come from the same `buildings/{id}` doc the work
     orders use (customerName = Bill To, location = address).
   - jsPDF + AutoTable (already loaded globally) for the PDF, styled like the
     other RoofOps documents.

   PROGRESSIVE DISCLOSURE — this module builds ONLY the always-on core now, but
   is structured so later phases' Yes/No-radio-gated sections (delays,
   quantities, JSA, incidents, equipment, visitors) slot in with no rework:
   see dprGate() and the "LATER-PHASE HOOKS" markers below.

   HELD FOR PROD SIGN-OFF (dev only). Auto-fill of Job No. from Foundation,
   admin-only post-sign-off edit lock, and auto-distribution (email +
   CompanyCam) on sign-off are LATER phases — clean hooks are left, nothing
   is built for them here. */

/* ---- module state (flat globals, matching the app's plain-script style) ---- */
var dprState = {
  id: null,              /* current doc id, or null for an unsaved fresh report */
  buildingId: null,      /* canonical building id this DPR is filed under */
  roofs: [],             /* getBuildingRoofs() result for the selected building */
  continuedExisting: false /* true once we've loaded a same-day report to add to */
};
var dprCrew = [];        /* roster rows: [{ name }]  headcount derives from this */
var dprPhotos = [];      /* [{ caption, img, thumb, w, h, gps, storageRef, localId }] */
var dprHeadcountAutoVal = "";  /* last headcount we auto-filled — lets a manual edit stick (same trick as CO job-no autofill) */
var dprBldCache = null;  /* buildings list for the inline picker (lazy) */
var dprLoadSeq = 0;      /* guards against a slow same-day fetch clobbering a newer selection */
/* The section a foreman traces for the day's worked area lives on dprState.section:
   { roofId, mode:"geo"|"image", ring:[{lat,lng}] | imageRing:[{x,y}], imageFrameUrl,
     areaSqFt, createdAt }. dprTrace is the TRANSIENT tracing session (map + in-progress
     points), separate from the saved section. */
var dprTrace = null;

/* Roles allowed to CREATE/SUBMIT a DPR. Display/UX gate only — the real
   enforcement is the daily_progress_reports Firestore rules (dpr.create
   permission, resolved server-side from the live roles doc). Mirrors the
   SEED_ROLES grants for dpr.create in netlify/functions/lib/permissions.js;
   owner always passes. Kept as a small explicit list here for the same reason
   recomputeIsAdmin() hardcodes owner/admin: the client only has the tiny
   {owner,role} claim, never the full permission grid. */
var DPR_CREATE_ROLES = ["admin", "service_manager", "superintendent", "ops_manager", "project_manager", "field_tech"];

/* Foremen roster for the "Foreman" field (who's filling out the report —
   foremen complete these daily). Populated into the dl-dprForeman datalist so
   the field becomes a pick-list with autocomplete. EMPTY until Mark provides
   the roster — until then the field is plain free text AND remembers whatever
   is typed (field-history 'dprForeman'), so it's fully usable today and only
   gets better once names are added here.
   TODO(Mark's roster): add foreman names, e.g. ["Jose Garcia", "Mark Ruiz", ...]. */
var DPR_FOREMEN = [];
function dprPopulateForemen(){
  var names = DPR_FOREMEN.slice();
  try{
    (getFieldHistory("dprForeman") || []).forEach(function(v){ if (names.indexOf(v) === -1) names.push(v); });
  }catch(e){}
  dprSetDatalist("dl-dprForeman", names);
}
/* Fills a <datalist> with de-duped, non-empty option values (case-insensitive
   de-dupe, order preserved so the most relevant source can go first). */
function dprSetDatalist(id, values){
  var dl = document.getElementById(id);
  if (!dl) return;
  var seen = {}, opts = [];
  (values || []).forEach(function(v){
    v = (v == null ? "" : String(v)).trim();
    if (!v) return;
    var k = v.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    opts.push("<option value='" + esc(v) + "'>");
  });
  dl.innerHTML = opts.join("");
}

/* ================= autofill from real data =================
   The device-history datalists (dl-jobName etc.) only hold what was typed on
   THIS device, so on a fresh phone the DPR fields had nothing to pick from.
   This populates the DPR's own datalists from actual records — existing
   buildings (job names / customers / addresses) and prior DPRs (foremen, crew,
   job numbers) — so the foreman can choose from real jobs and names. Job No.
   also auto-fills from the picked building's parent job (see dprAutofillJobNo).
   NOTE: Foundation (ERP) job data is a separate, still-pending integration — see
   dpr-feature-phases memory; this covers everything already in the app. */
var dprDataListsLoaded = false;
async function dprPopulateDataLists(force){
  dprPopulateForemen(); /* immediate/offline: roster + device history */
  if ((dprDataListsLoaded && !force) || !fdb) return;
  try{
    if (!dprBldCache){
      var bs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(300).get();
      dprBldCache = [];
      bs.forEach(function(d){ var b = Object.assign({ id: d.id }, d.data()); if (!b.archived) dprBldCache.push(b); });
    }
    var names = [], custs = [], locs = [];
    dprBldCache.forEach(function(b){
      if (b.name) names.push(b.name);
      if (b.customerName) custs.push(b.customerName);
      if (b.location) locs.push(b.location);
    });
    var foremen = DPR_FOREMEN.slice(), crew = [], jobNos = [];
    try{
      var ds = await fdb.collection("daily_progress_reports").orderBy("date", "desc").limit(200).get();
      ds.forEach(function(d){
        var r = d.data();
        if (r.foreman) foremen.push(r.foreman);
        (r.crew || []).forEach(function(c){ if (c && c.name) crew.push(c.name); });
        if (r.jobNo) jobNos.push(r.jobNo);
      });
    }catch(e){}
    /* Foundation jobs (the accounting system of record) — real job numbers +
       job names to choose from. Loaded once into dprFdnJobsCache; the cache
       also powers the "From Foundation" search results in dprSearchBuildings. */
    var fdnJobNos = [], fdnJobNames = [];
    await dprLoadFoundationJobs();
    (dprFdnJobsCache || []).forEach(function(j){
      if (j.job_no) fdnJobNos.push(j.job_no);
      if (j.name) fdnJobNames.push(j.name);
    });
    dprSetDatalist("dl-dprJobName", fdnJobNames.concat(names, getFieldHistory("jobName")));
    dprSetDatalist("dl-dprBillTo", custs.concat(getFieldHistory("billTo")));
    dprSetDatalist("dl-dprLocation", locs.concat(getFieldHistory("location")));
    dprSetDatalist("dl-dprForeman", foremen.concat(getFieldHistory("dprForeman")));
    dprSetDatalist("dl-dprCrew", crew.concat(getFieldHistory("technician")));
    dprSetDatalist("dl-dprJobNo", fdnJobNos.concat(jobNos));
    dprDataListsLoaded = true;
  }catch(e){ /* best-effort — the fields still work as free text */ }
}
/* Auto-fill Job No. from the picked building's parent job (reuses the same
   building-history resolver the Change Order autofill uses), and offer that
   building's job numbers in the dl-dprJobNo picker. Never stomps a number the
   foreman typed. */
var dprJobNoAutoVal = "";
async function dprAutofillJobNo(buildingId){
  if (!fdb || !buildingId) return;
  var cur = (val("dpr-jobNo") || "").trim();
  if (cur && cur !== dprJobNoAutoVal) return; /* their value wins */
  try{
    var events = await loadBuildingHistoryEvents(buildingId, 50);
    var nums = (events || []).map(function(e){ return e && e.workOrderNo; }).filter(Boolean);
    if (nums.length) dprSetDatalist("dl-dprJobNo", nums);
    if (typeof parentJobNoFromHistoryEvents !== "function") return;
    var base = parentJobNoFromHistoryEvents(events);
    if (!base) return;
    var now = (val("dpr-jobNo") || "").trim();
    if (now && now !== dprJobNoAutoVal) return; /* re-check after await */
    setVal("dpr-jobNo", base);
    dprJobNoAutoVal = base;
  }catch(e){ /* non-fatal */ }
}

/* ================= Foundation jobs (accounting system of record) =================
   Reads the client-readable `foundation_jobs` cache (mirrored from FoundationSoft
   by the parallel session's foundation-sync — read-only here, never written). Lets
   a foreman pick the real Foundation job for the day so Job No./name come straight
   from accounting, and stamps the Foundation link onto the building on save. */
var dprFdnJobsCache = null;
async function dprLoadFoundationJobs(){
  if (dprFdnJobsCache || !fdb) return;
  try{
    var qs = await fdb.collection("foundation_jobs").limit(1000).get();
    dprFdnJobsCache = [];
    qs.forEach(function(d){ dprFdnJobsCache.push(Object.assign({ id: d.id }, d.data())); });
  }catch(e){ dprFdnJobsCache = dprFdnJobsCache || []; }
}
/* Sets Job No. from a building's Foundation link. Returns true if the building
   HAS a Foundation job (so the caller can skip the history-based fallback),
   false if not — never stomps a number the foreman typed. */
function dprApplyFoundationJobNo(b){
  var fjn = (b && b.foundationJobNo != null) ? String(b.foundationJobNo).trim() : "";
  if (!fjn) return false;
  dprState.foundationJobNo = fjn;
  if (b.foundationCustomerNo != null) dprState.foundationCustomerNo = String(b.foundationCustomerNo);
  var cur = (val("dpr-jobNo") || "").trim();
  if (!cur || cur === dprJobNoAutoVal){
    setVal("dpr-jobNo", fjn);
    dprJobNoAutoVal = fjn;
  }
  return true;
}
/* Human label for a Foundation job row. */
function dprFdnJobLabel(j){
  var parts = [];
  if (j.job_no) parts.push(j.job_no);
  if (j.name) parts.push(j.name);
  var loc = [j.address, j.city, j.state].filter(Boolean).join(", ");
  return { title: parts.join(" — ") || (j.name || j.job_no || "Foundation job"), meta: loc };
}
/* Foreman picked a Foundation job directly (no building needed): fill Job Name,
   Location and Job No. from accounting. Customer stays as-is (Foundation gives a
   customer number, not a name — the linked building carries the real name). */
function dprPickFoundationJob(jobNo){
  var j = (dprFdnJobsCache || []).find(function(x){ return String(x.job_no) === String(jobNo); });
  if (!j) return;
  if (j.name) setVal("dpr-jobName", j.name);
  var loc = [j.address, j.city, j.state, j.zip].filter(Boolean).join(", ");
  if (loc) setVal("dpr-location", loc);
  setVal("dpr-jobNo", String(j.job_no || ""));
  dprJobNoAutoVal = String(j.job_no || "");
  dprState.foundationJobNo = String(j.job_no || "");
  dprState.foundationCustomerNo = (j.customer_no != null ? String(j.customer_no) : null);
  setVal("dpr-bld-search", "");
  var host = document.getElementById("dpr-bld-results");
  if (host) host.innerHTML = "";
  dprScheduleSameDayLoad();
  toast("Linked Foundation job " + (j.job_no || "") + " — fill in today's progress");
}

function dprCanView(){
  /* View = crew + office = anyone signed in (the login gate already blocks the
     whole app until sign-in; this is belt-and-braces). */
  return !!currentAuthClaims;
}
function dprCanCreate(){
  if (!currentAuthClaims) return false;
  if (currentAuthClaims.owner === true) return true;
  return DPR_CREATE_ROLES.indexOf(currentAuthClaims.role) !== -1;
}

/* ---- canonical id derivation (must match the rest of the app) ---- */
/* Same formula as ensureCustomerAndBuilding() (core.js) and buildingIdFor()
   (workorders.js), reused here so a DPR files under the EXACT building doc the
   work orders do — never a parallel/rogue building record. */
function dprBuildingId(billTo, jobName){
  var custName = (billTo || "").trim();
  var bldName = (jobName || "").trim();
  if (!bldName) return null;
  var custId = custName ? ("cust_" + slugify(custName)) : null;
  return "bld_" + slugify((custId || "nocust") + "_" + bldName);
}
function dprDocId(buildingId, dateStr){
  if (!buildingId || !dateStr) return null;
  return "dpr_" + buildingId + "_" + dateStr;
}

/* ---- view lifecycle ---- */
function dprOnShow(){
  dprApplyPermissionUI();
  if (!dprCanView()){ return; }
  /* Default the date to today for a fresh report; never stomp an in-progress one. */
  if (!dprState.id && !val("dpr-date")) setVal("dpr-date", dprTodayStr());
  dprPopulateDataLists();
  dprEnsureListeners();
  dprRenderCrew();
  dprRenderPhotos();
  dprRenderSectionStatus();
  dprApplySignoffLock();
  dprHideHistory();
}
function dprTodayStr(){
  /* Native <input type="date"> wants YYYY-MM-DD. Local date, not UTC, so a
     late-evening report doesn't roll to tomorrow. */
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}
var dprListenersInstalled = false;
function dprEnsureListeners(){
  if (dprListenersInstalled) return;
  ["dpr-jobName", "dpr-billTo"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener("blur", dprScheduleSameDayLoad);
  });
  var dateEl = document.getElementById("dpr-date");
  if (dateEl) dateEl.addEventListener("change", dprScheduleSameDayLoad);
  dprListenersInstalled = true;
}

/* ---- permission-driven UI ---- */
function dprApplyPermissionUI(){
  var gate = document.getElementById("dpr-signin-gate");
  var body = document.getElementById("dpr-body");
  if (!dprCanView()){
    if (gate) gate.style.display = "";
    if (body) body.style.display = "none";
    return;
  }
  if (gate) gate.style.display = "none";
  if (body) body.style.display = "";
  var canCreate = dprCanCreate();
  var saveBtn = document.getElementById("dpr-save-btn");
  var roHint = document.getElementById("dpr-readonly-hint");
  if (saveBtn) saveBtn.style.display = canCreate ? "" : "none";
  if (roHint) roHint.style.display = canCreate ? "none" : "";
  /* Capture controls only make sense for someone who can save. */
  var capRow = document.getElementById("dpr-capture-row");
  if (capRow) capRow.style.display = canCreate ? "" : "none";
}

/* ================= building selection (inline, self-contained) =================
   A lightweight inline picker living right in the Job Info card — deliberately
   NOT the work-order bp-modal (that one writes into the work-order fields).
   Same buildings collection, same read-only load. */
async function dprSearchBuildings(){
  var q = (val("dpr-bld-search") || "").trim().toLowerCase();
  var host = document.getElementById("dpr-bld-results");
  if (!host) return;
  if (!q){ host.innerHTML = ""; return; }
  if (!fdb){ host.innerHTML = '<p class="hint">Building search needs an internet connection.</p>'; return; }
  if (!dprBldCache){
    host.innerHTML = '<p class="hint">Loading buildings…</p>';
    try{
      var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(200).get();
      dprBldCache = [];
      qs.forEach(function(d){
        var b = Object.assign({ id: d.id }, d.data());
        if (!b.archived) dprBldCache.push(b);
      });
    }catch(e){ host.innerHTML = '<p class="hint">Couldn\'t load buildings: ' + esc(e.message) + '</p>'; return; }
  }
  var matches = dprBldCache.filter(function(b){
    return (b.name || "").toLowerCase().indexOf(q) > -1 ||
      (b.customerName || "").toLowerCase().indexOf(q) > -1 ||
      (b.location || "").toLowerCase().indexOf(q) > -1;
  }).slice(0, 25);
  var html = matches.map(function(b){
    return '<div class="bld-item" onclick="dprPickBuilding(\'' + esc(b.id) + '\')"><div class="info">' +
      '<div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta">' + esc(b.customerName || "") + (b.location ? ' · ' + esc(b.location) : "") +
      (b.roofSystem ? ' · ' + esc(b.roofSystem) : "") + '</div></div>' +
      '<button class="btn">Select</button></div>';
  }).join("");
  /* "From Foundation" — active jobs from accounting the foreman can pick even
     if there's no RoofOps building for the site yet. Searched against the local
     foundation_jobs cache (loaded in dprPopulateDataLists). */
  await dprLoadFoundationJobs();
  var fdnMatches = (dprFdnJobsCache || []).filter(function(j){
    return String(j.job_no || "").toLowerCase().indexOf(q) > -1 ||
      (j.name || "").toLowerCase().indexOf(q) > -1 ||
      (j.address || "").toLowerCase().indexOf(q) > -1 ||
      (j.city || "").toLowerCase().indexOf(q) > -1;
  }).slice(0, 15);
  if (fdnMatches.length){
    html += '<div class="hint" style="margin:8px 0 4px;font-weight:600">☁️ From Foundation</div>' +
      fdnMatches.map(function(j){
        var lbl = dprFdnJobLabel(j);
        return '<div class="bld-item" onclick="dprPickFoundationJob(\'' + esc(String(j.job_no)) + '\')"><div class="info">' +
          '<div class="name">' + esc(lbl.title) + '</div>' +
          (lbl.meta ? '<div class="meta">' + esc(lbl.meta) + '</div>' : '') + '</div>' +
          '<button class="btn">Select</button></div>';
      }).join("");
  }
  if (!html){ host.innerHTML = '<p class="hint">No matching jobs — type the details in directly below.</p>'; return; }
  host.innerHTML = html;
}
function dprPickBuilding(buildingId){
  var b = (dprBldCache || []).find(function(x){ return x.id === buildingId; });
  if (!b) return;
  setVal("dpr-jobName", b.name || "");
  setVal("dpr-billTo", b.customerName || "");
  setVal("dpr-location", b.location || "");
  setVal("dpr-roofSystem", b.roofSystem || "");
  setVal("dpr-bld-search", "");
  var host = document.getElementById("dpr-bld-results");
  if (host) host.innerHTML = "";
  dprState.buildingId = buildingId;
  dprState.roofs = getBuildingRoofs(b);
  dprRenderRoofPicker();
  /* Prefer the building's Foundation job number (the accounting system of
     record) for Job No.; fall back to the parent-job derivation only if the
     building has no Foundation link. */
  if (!dprApplyFoundationJobNo(b)) dprAutofillJobNo(buildingId);
  dprScheduleSameDayLoad();
  toast("Loaded “" + b.name + "” — review the fields, then fill in today's progress");
}
function dprRenderRoofPicker(){
  var wrap = document.getElementById("dpr-roof-picker");
  if (!wrap) return;
  var roofs = dprState.roofs || [];
  /* One roof (the common case) has nothing to pick — hide it entirely, exactly
     like the inspection roof picker. */
  if (roofs.length < 2){ wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.style.display = "";
  wrap.innerHTML = '<div class="fld"><label>Roof</label><select id="dpr-roof">' +
    roofs.map(function(r){ return '<option value="' + esc(r.id) + '">' + esc(r.label || r.id) + '</option>'; }).join("") +
    '</select></div>';
}
function dprSelectedRoofId(){
  var sel = document.getElementById("dpr-roof");
  if (sel && sel.value) return sel.value;
  var roofs = dprState.roofs || [];
  return roofs[0] ? roofs[0].id : "roof_default";
}

/* ================= one-per-day continuation =================
   When building + date are both known, look for an existing DPR for that pair.
   If one exists, load it so this crew adds to the single day's report instead
   of starting a rival. */
function dprScheduleSameDayLoad(){
  if (dprSameDayTimer) clearTimeout(dprSameDayTimer);
  dprSameDayTimer = setTimeout(dprLoadForBuildingDate, 120);
}
var dprSameDayTimer = null;
async function dprLoadForBuildingDate(){
  var buildingId = dprState.buildingId || dprBuildingId(val("dpr-billTo"), val("dpr-jobName"));
  var dateStr = val("dpr-date");
  var notice = document.getElementById("dpr-continue-notice");
  if (!buildingId || !dateStr || !fdb){ if (notice) notice.style.display = "none"; return; }
  dprState.buildingId = buildingId;
  var wantId = dprDocId(buildingId, dateStr);
  /* Already sitting on this exact report — nothing to do. */
  if (dprState.id === wantId) return;
  var seq = ++dprLoadSeq;
  try{
    var snap = await fdb.collection("daily_progress_reports").doc(wantId).get();
    if (seq !== dprLoadSeq) return; /* a newer selection superseded this fetch */
    if (snap.exists){
      var o = Object.assign({ id: wantId }, snap.data());
      /* Pull the photo subcollection back in, same shape as the work-order load. */
      o.photos = [];
      try{
        var ps = await fdb.collection("daily_progress_reports").doc(wantId).collection("photos").orderBy("i").get();
        ps.forEach(function(d){ o.photos.push(d.data()); });
      }catch(e){ /* photos are best-effort; the report body still loads */ }
      if (seq !== dprLoadSeq) return;
      dprFill(o);
      dprState.continuedExisting = true;
      if (notice){
        notice.style.display = "";
        notice.textContent = "📋 Adding to today's existing report for this job" +
          (o.updatedByName ? " (last updated by " + o.updatedByName + ")" : "") + ".";
      }
      toast("Opened today's existing report for this job — add your crew's progress and save");
    } else {
      /* No report yet for this day — fresh, keyed but unsaved. Default the
         Job No. from the building's parent job (foreman can still override). */
      dprState.id = null;
      dprState.continuedExisting = false;
      if (notice) notice.style.display = "none";
      dprAutofillJobNo(buildingId);
    }
  }catch(e){ if (notice) notice.style.display = "none"; }
}

/* ================= crew roster + headcount ================= */
function dprAddCrewRow(name){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  dprCrew.push({ name: name || "" });
  dprRenderCrew();
  dprSyncHeadcount();
}
function dprRemoveCrewRow(idx){
  if (dprIsLocked()) return;
  dprCrew.splice(idx, 1);
  dprRenderCrew();
  dprSyncHeadcount();
}
function dprRenderCrew(){
  var host = document.getElementById("dpr-crew-list");
  if (!host) return;
  if (!dprCrew.length){
    host.innerHTML = '<p class="hint">No crew added yet. Add each person who worked this job today.</p>';
    return;
  }
  host.innerHTML = dprCrew.map(function(c, i){
    return '<div class="btnrow" style="margin:0 0 6px;gap:6px">' +
      '<input type="text" placeholder="Crew member name" data-dprcrew="' + i + '" value="' + esc(c.name) + '" ' +
        'list="dl-dprCrew" style="flex:1;min-width:140px">' +
      '<button class="btn danger" onclick="dprRemoveCrewRow(' + i + ')">✕</button>' +
      '</div>';
  }).join("");
  host.querySelectorAll("[data-dprcrew]").forEach(function(el){
    el.addEventListener("input", function(){ dprCrew[+el.dataset.dprcrew].name = el.value; dprSyncHeadcount(); });
  });
}
function dprCrewCount(){
  return dprCrew.filter(function(c){ return (c.name || "").trim(); }).length;
}
function dprSyncHeadcount(){
  /* Auto-fill headcount from the roster, but never stomp a value the user
     typed themselves (same "remember what we auto-filled" trick the Change
     Order job-no autofill uses). */
  var el = document.getElementById("dpr-headcount");
  if (!el) return;
  var current = el.value.trim();
  if (current === "" || current === dprHeadcountAutoVal){
    var n = String(dprCrewCount());
    el.value = n;
    dprHeadcountAutoVal = n;
  }
}

/* ================= photos (reuses the work-order storage/upload path) =================
   Its own array + capture handlers on purpose — the codebase already treats
   each capture context as a deliberate separate path, not a shared refactor
   (see the comment on addPhotosFromCamera() in js/photos.js). Persistence,
   upload, and thumbnails all reuse the shared primitives. */
function dprAddPhotosFromFiles(files){ dprIngestPhotos(files, false); }
function dprAddPhotosFromCamera(files){ dprIngestPhotos(files, true); }
function dprIngestPhotos(files, useDeviceGps){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  var gpsPromise = useDeviceGps ? captureDeviceGps() : Promise.resolve({ ok: false });
  gpsPromise.then(function(gpsResult){
    var camGps = (gpsResult && gpsResult.ok) ? { lat: gpsResult.lat, lng: gpsResult.lng, accuracy: gpsResult.accuracy } : null;
    var results = new Array(list.length);
    var pending = list.length;
    function done(){
      pending--;
      if (pending === 0){
        results.forEach(function(r){ if (r) dprPhotos.push(r); });
        dprRenderPhotos();
      }
    }
    list.forEach(function(file, idx){
      var reader = new FileReader();
      reader.onload = function(){
        var exifGps = dataUrlExifGps(reader.result);
        var img = new Image();
        img.onload = function(){
          var preset = photoPreset();
          var MAX = preset.max, w = img.width, h = img.height;
          if (w > MAX || h > MAX){
            if (w >= h){ h = Math.round(h * MAX / w); w = MAX; }
            else { w = Math.round(w * MAX / h); h = MAX; }
          }
          var c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          results[idx] = {
            caption: "", img: c.toDataURL("image/jpeg", preset.q), thumb: makeThumbDataUrl(img),
            w: w, h: h, gps: camGps || exifGps || null, localId: makeLocalPhotoId()
          };
          done();
        };
        img.onerror = function(){ toast("Couldn't read one of the photos"); done(); };
        img.src = reader.result;
      };
      reader.onerror = function(){ toast("Couldn't read one of the photos"); done(); };
      reader.readAsDataURL(file);
    });
  });
}
function dprRemovePhoto(idx){
  if (dprIsLocked()) return;
  dprPhotos.splice(idx, 1);
  dprRenderPhotos();
}
function dprMovePhoto(idx, dir){
  if (dprIsLocked()) return;
  var j = idx + dir;
  if (j < 0 || j >= dprPhotos.length) return;
  var tmp = dprPhotos[idx]; dprPhotos[idx] = dprPhotos[j]; dprPhotos[j] = tmp;
  dprRenderPhotos();
}
function dprRenderPhotos(){
  var host = document.getElementById("dpr-photos-host");
  if (!host) return;
  if (!dprPhotos.length){ host.innerHTML = '<p class="hint">No photos added yet.</p>'; return; }
  host.innerHTML = '<div class="finding-photo-strip">' +
    dprPhotos.map(function(p, i){
      var src = p.thumb || p.imgFallback || p.img || "";
      var locNote = p.gps ? '<span class="hint" style="display:block;margin:2px 0 0;color:#2E7D32">📍 Located</span>' :
        '<span class="hint" style="display:block;margin:2px 0 0">No location</span>';
      return '<div class="finding-photo-item">' +
        (src ? '<img class="thumb" src="' + src + '">' : '<span class="hint">(image loads on save)</span>') +
        '<input type="text" placeholder="Caption" data-dprphoto="' + i + '" value="' + esc(p.caption || "") + '" ' +
          'list="dl-photoCaption" onblur="rememberFieldValue(\'photoCaption\', this.value)">' +
        locNote +
        '<div class="btnrow" style="margin:4px 0 0;gap:4px">' +
          '<button class="btn" onclick="dprMovePhoto(' + i + ',-1)" title="Move up">▲</button>' +
          '<button class="btn" onclick="dprMovePhoto(' + i + ',1)" title="Move down">▼</button>' +
          '<button class="btn danger" onclick="dprRemovePhoto(' + i + ')">✕</button>' +
        '</div>' +
        '</div>';
    }).join("") + '</div>';
  host.querySelectorAll("[data-dprphoto]").forEach(function(el){
    el.addEventListener("input", function(){ dprPhotos[+el.dataset.dprphoto].caption = el.value; });
  });
}

/* ================= collect / fill =================
   Uses val()/setVal() so the logic is exercisable in the same VM-sandbox test
   harness the other modules use (tests/changeOrderAutofill.test.js style). */
function dprCollect(){
  var buildingId = dprState.buildingId || dprBuildingId(val("dpr-billTo"), val("dpr-jobName"));
  var dateStr = val("dpr-date");
  var o = {
    id: dprState.id || dprDocId(buildingId, dateStr),
    buildingId: buildingId,
    roofId: dprSelectedRoofId(),
    date: dateStr,
    foreman: val("dpr-foreman"),   /* who filled it out — foremen complete these daily */
    jobName: val("dpr-jobName"),
    billTo: val("dpr-billTo"),
    location: val("dpr-location"),
    jobNo: val("dpr-jobNo"),          /* from Foundation (building link / job pick) or typed */
    foundationJobNo: dprState.foundationJobNo || null,          /* stamps the building's Foundation link on save (ensureCustomerAndBuilding) */
    foundationCustomerNo: dprState.foundationCustomerNo || null,
    roofSystem: val("dpr-roofSystem"),
    crew: dprCrew.filter(function(c){ return (c.name || "").trim(); }).map(function(c){ return { name: c.name.trim() }; }),
    headcount: val("dpr-headcount"),
    hoursWorked: val("dpr-hours"),
    squares: val("dpr-squares"),
    summary: val("dpr-summary"),
    section: dprState.section || null,   /* the roof area traced for today (progress overlay) */
    signoff: dprState.signoff || null,   /* signature + lock state (see sign-off/lock hooks below) */
    photos: dprPhotos.slice()
    /* LATER-PHASE HOOKS (not built in Phase 1): delays{}, quantities[], jsa{},
       incidents[], equipment[], visitors[] — each will be a radio-gated block
       added via dprGate(); dprCollect() gains one line per block when built. */
  };
  return o;
}
function dprFill(o){
  o = o || {};
  dprState.id = o.id || null;
  dprState.buildingId = o.buildingId || dprBuildingId(o.billTo, o.jobName);
  setVal("dpr-foreman", o.foreman || "");
  setVal("dpr-jobName", o.jobName || "");
  setVal("dpr-billTo", o.billTo || "");
  setVal("dpr-location", o.location || "");
  setVal("dpr-jobNo", o.jobNo || "");
  dprJobNoAutoVal = String(o.jobNo || "");
  dprState.foundationJobNo = o.foundationJobNo || null;
  dprState.foundationCustomerNo = o.foundationCustomerNo || null;
  setVal("dpr-roofSystem", o.roofSystem || "");
  setVal("dpr-date", o.date || dprTodayStr());
  setVal("dpr-headcount", o.headcount || "");
  setVal("dpr-hours", o.hoursWorked || "");
  setVal("dpr-squares", o.squares || "");
  setVal("dpr-summary", o.summary || "");
  dprHeadcountAutoVal = String(o.headcount || "");
  dprCrew = (o.crew || []).map(function(c){ return { name: c.name || "" }; });
  dprPhotos = (o.photos || []).map(function(p){ return Object.assign({}, p); });
  dprState.section = o.section || null;
  dprState.signoff = o.signoff || null;
  dprApplySignoffLock();
  /* Refresh roofs for the roof picker if we have the building loaded. */
  if (dprState.buildingId && fdb){
    fdb.collection("buildings").doc(dprState.buildingId).get().then(function(snap){
      dprState.roofs = getBuildingRoofs(snap.exists ? snap.data() : {});
      dprRenderRoofPicker();
      var sel = document.getElementById("dpr-roof");
      if (sel && o.roofId) sel.value = o.roofId;
    }).catch(function(){});
  }
  dprRenderCrew();
  dprRenderPhotos();
  dprRenderSectionStatus();
}

/* ================= save (client-direct Firestore write, permission-gated by rules) ================= */
function dprValidate(o){
  if (!o.jobName || !o.jobName.trim()) return "Add a Job Name (or pick a building) so the report can be filed to a job.";
  if (!o.date) return "Pick the date this progress was made on.";
  if (!o.buildingId || !o.id) return "Couldn't determine the job — pick or type the job name and customer.";
  return null;
}
async function dprSave(){
  if (!dprCanCreate()){ toast("Your role can view daily progress reports but can't submit them."); return; }
  if (dprIsLocked()){ toast("This report is signed and locked — it can't be edited."); return; }
  var o = dprCollect();
  var problem = dprValidate(o);
  if (problem){ toast(problem); return; }
  if (!fdb){ toast("No internet — a daily progress report needs cloud sync to save. Try again when you're back online."); return; }
  var btn = document.getElementById("dpr-save-btn");
  if (btn){ btn.disabled = true; btn.textContent = "Saving…"; }
  try{
    /* Link/derive the building record the same idempotent way work orders do —
       so a DPR typed for a brand-new job still creates its building. */
    try{ await ensureCustomerAndBuilding(o); }catch(e){ console.warn("dpr building sync failed (non-fatal)", e); }
    await dprCloudSave(o);
    dprState.id = o.id;
    toast("Daily progress report saved ✓");
    dprRenderPhotos();
  }catch(e){
    toast(dprSaveErrMsg(e));
  }finally{
    if (btn){ btn.disabled = false; btn.textContent = "Save Report"; }
  }
}
function dprSaveErrMsg(e){
  var m = (e && e.message) ? String(e.message) : "unknown error";
  if (/permission|PERMISSION/.test(m))
    return "Save blocked — your role may not have permission to submit daily progress reports (dpr.create).";
  return "Couldn't save the report: " + m;
}
async function dprCloudSave(o){
  if (!fdb) throw new Error("cloud not available");
  var main = {};
  Object.keys(o).forEach(function(k){ if (k !== "photos") main[k] = (o[k] == null ? "" : o[k]); });
  main.photoCount = (o.photos || []).length;
  main.updatedAt = Date.now();
  main.updatedByUid = (currentAuthUser && currentAuthUser.uid) || null;
  main.updatedByName = (currentAuthClaims && (currentAuthClaims.name || currentAuthClaims.email)) ||
    (currentAuthUser && currentAuthUser.email) || null;
  var ref = fdb.collection("daily_progress_reports").doc(o.id);
  var snap = null;
  try{ snap = await ref.get(); }catch(e){}
  if (!snap || !snap.exists){
    main.createdAt = Date.now();
    main.createdByUid = main.updatedByUid;
    main.createdByName = main.updatedByName;
  }
  /* merge:true so a second crew's save adds to (rather than replaces) the
     day's report metadata; the arrays (crew/summary) still reflect the current
     in-form state, which is the loaded-then-extended report. */
  await ref.set(main, { merge: true });
  /* Photos -> subcollection, mirroring cloudSaveOrder(): upload any fresh bytes
     to Storage via the shared proxy, store a light doc per photo. */
  var photos = o.photos || [];
  for (var i = 0; i < photos.length; i++){
    var p = photos[i];
    var storageRef = p.storageRef || null;
    if (!storageRef && p.img){
      try{ storageRef = await uploadPhotoToStorage(o.id, i, p.img); p.storageRef = storageRef; }
      catch(e){ console.warn("dpr photo upload failed (kept inline)", e); }
    }
    var photoDoc = {
      i: i, caption: p.caption || "", w: p.w || null, h: p.h || null,
      gps: p.gps || null, thumb: p.thumb || null, storageRef: storageRef || null
    };
    await ref.collection("photos").doc("p" + i).set(photoDoc);
  }
  /* Prune any trailing photo docs left over from a previous, longer save. */
  try{
    var existing = await ref.collection("photos").get();
    var keep = photos.length;
    var deletions = [];
    existing.forEach(function(d){
      var m = /^p(\d+)$/.exec(d.id);
      if (m && +m[1] >= keep) deletions.push(d.ref.delete());
    });
    await Promise.all(deletions);
  }catch(e){ /* non-fatal */ }
  /* Persist the job's location so EVERY later map open (next report, progress
     map) zooms straight here — the durable fix for "the second report didn't
     zoom." A traced section's centroid is an on-the-roof coordinate; cache it
     to the building the same way Buildings Near Me caches a geocode. */
  try{
    var centroid = dprSectionCentroid(o.section);
    if (centroid && o.buildingId && typeof bnmCacheGeocode === "function"){
      bnmCacheGeocode(o.buildingId, centroid);
    }
  }catch(e){ /* best-effort */ }
}

/* ================= new / reset ================= */
function dprNewReport(){
  if (dprHasContent() && !confirm("Start a new daily progress report? Anything not saved will be lost.")) return;
  dprState = { id: null, buildingId: null, roofs: [], continuedExisting: false };
  dprCrew = [];
  dprPhotos = [];
  dprHeadcountAutoVal = "";
  dprJobNoAutoVal = "";
  dprState.foundationJobNo = null;
  dprState.foundationCustomerNo = null;
  ["dpr-foreman", "dpr-jobName", "dpr-billTo", "dpr-location", "dpr-jobNo", "dpr-headcount", "dpr-hours", "dpr-squares", "dpr-summary", "dpr-bld-search"].forEach(function(id){ setVal(id, ""); });
  setVal("dpr-roofSystem", "");
  setVal("dpr-date", dprTodayStr());
  var notice = document.getElementById("dpr-continue-notice");
  if (notice) notice.style.display = "none";
  dprState.section = null;
  dprState.signoff = null;
  dprRenderRoofPicker();
  dprRenderCrew();
  dprRenderPhotos();
  dprRenderSectionStatus();
  dprApplySignoffLock();
  var results = document.getElementById("dpr-bld-results");
  if (results) results.innerHTML = "";
  window.scrollTo(0, 0);
  toast("New daily progress report");
}
function dprHasContent(){
  return !!(val("dpr-jobName") || val("dpr-summary") || dprCrew.length || dprPhotos.length);
}

/* ================= history / list (by job and by date) ================= */
async function dprShowHistory(){
  var panel = document.getElementById("dpr-history-panel");
  var host = document.getElementById("dpr-history-list");
  if (!panel || !host) return;
  /* Toggle: a second tap closes it (the panel is at the bottom of a long form,
     so tapping History with no visible movement read as "nothing happened"). */
  if (panel.style.display !== "none" && panel.dataset.dprOpen === "1"){
    panel.style.display = "none";
    panel.dataset.dprOpen = "0";
    return;
  }
  panel.style.display = "";
  panel.dataset.dprOpen = "1";
  host.innerHTML = '<p class="hint">Loading…</p>';
  /* Always give visible feedback — scroll the panel into view so a phone tap
     doesn't silently reveal a card below the fold. */
  try{ panel.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(e){ panel.scrollIntoView(); }
  if (!fdb){ host.innerHTML = '<p class="hint">History needs an internet connection.</p>'; return; }
  try{
    var qs = await fdb.collection("daily_progress_reports").orderBy("date", "desc").limit(100).get();
    var rows = [];
    qs.forEach(function(d){ rows.push(Object.assign({ id: d.id }, d.data())); });
    if (!rows.length){ host.innerHTML = '<p class="hint">No daily progress reports yet.</p>'; return; }
    host.innerHTML = rows.map(function(r){
      return '<div class="bld-item" onclick="dprOpenReport(\'' + esc(r.id) + '\')"><div class="info">' +
        '<div class="name">' + esc(r.jobName || "(no job name)") + ' — ' + esc(r.date || "") + '</div>' +
        '<div class="meta">' + esc(r.billTo || "") +
        (r.foreman ? ' · 👷 ' + esc(r.foreman) : "") +
        (r.headcount ? ' · ' + esc(String(r.headcount)) + ' crew' : "") +
        (r.squares ? ' · ' + esc(String(r.squares)) + ' sq' : "") +
        (r.photoCount ? ' · ' + esc(String(r.photoCount)) + ' 📷' : "") + '</div></div>' +
        '<button class="btn">Open</button></div>';
    }).join("");
  }catch(e){ host.innerHTML = '<p class="hint">Couldn\'t load history: ' + esc(e.message) + '</p>'; }
}
function dprHideHistory(){
  var panel = document.getElementById("dpr-history-panel");
  if (panel){ panel.style.display = "none"; panel.dataset.dprOpen = "0"; }
}
async function dprOpenReport(id){
  if (!fdb) return;
  try{
    var snap = await fdb.collection("daily_progress_reports").doc(id).get();
    if (!snap.exists){ toast("That report no longer exists."); return; }
    var o = Object.assign({ id: id }, snap.data());
    o.photos = [];
    try{
      var ps = await fdb.collection("daily_progress_reports").doc(id).collection("photos").orderBy("i").get();
      ps.forEach(function(d){ o.photos.push(d.data()); });
    }catch(e){}
    dprFill(o);
    dprHideHistory();
    window.scrollTo(0, 0);
    toast("Report opened");
  }catch(e){ toast("Couldn't open that report: " + e.message); }
}

/* ================= roof section tracing (daily progress on the base map) =================
   The foreman traces the section of roof worked that day. Reuses the SAME idea as
   RoofMapper (tap corners on a base map) but is fully self-contained here —
   RoofMapper's trace pipeline is bound to its own singleton map + DOM and is
   owned by another contributor, so this replicates just the ~40 lines of Leaflet
   tracing rather than calling into it. Only pure shared globals are reused:
   getBuildingRoofs (core), geocodeAddress + boundsToLatLngBounds + SAT_MAX_NATIVE_ZOOM
   (photos/core), and Leaflet (L) itself.

   Trace surface (per Mark): the selected roof's custom base map if it has one
   (roof_plan / sketch → flat image mode; drone_ortho → georeferenced), else
   satellite centered on the job. Storage mirrors RoofMapper's two regimes so a
   section redraws consistently: lat/lng ring for geo modes, 0-1 fractional
   imageRing (+ the base-map url as a guard) for flat images.

   Accumulation (per Mark): each day's section stays on ITS OWN DPR doc — the
   building's permanent roof_outlines are never touched. The Progress Map view
   pulls every DPR for the building and stacks their sections, newest brightest,
   so you can see what got done when. */
var DPR_SECTION_COLORS = ["#E8600A", "#1E88E5", "#43A047", "#8E24AA", "#F4511E", "#00897B", "#C0CA33", "#5E35B1"];

function dprSelectedRoofObj(){
  var roofs = dprState.roofs || [];
  var id = dprSelectedRoofId();
  return roofs.find(function(r){ return r.id === id; }) || roofs[0] || null;
}
function dprRoofBaseMap(roof){
  /* Returns {kind:"image"|"ortho"|null, url, bounds}. Mirrors the read model
     used across the app (photosRoofHasBaseMap / inline history). */
  if (!roof || !roof.roof_base_map_url) return { kind: null };
  var t = roof.roof_base_map_type;
  if (t === "roof_plan" || t === "sketch") return { kind: "image", url: roof.roof_base_map_url };
  if (t === "drone_ortho" && roof.roof_base_map_bounds)
    return { kind: "ortho", url: roof.roof_base_map_url, bounds: roof.roof_base_map_bounds };
  return { kind: null };
}
/* Planar (equirectangular) area estimate in ft² for a lat/lng ring — good enough
   for a roof-sized polygon; used for geo-mode sections only (a flat roof_plan
   image has no known real-world scale, so image-mode area stays null). */
function dprRingAreaSqFt(ring){
  if (!ring || ring.length < 3) return null;
  var pts = ring.slice();
  if (pts.length > 1){
    var a0 = pts[0], aN = pts[pts.length - 1];
    if (a0.lat === aN.lat && a0.lng === aN.lng) pts = pts.slice(0, -1); /* drop closing dup */
  }
  if (pts.length < 3) return null;
  var latRef = pts.reduce(function(s, p){ return s + p.lat; }, 0) / pts.length;
  var mLat = 111320, mLng = 111320 * Math.cos(latRef * Math.PI / 180);
  var xy = pts.map(function(p){ return { x: p.lng * mLng, y: p.lat * mLat }; });
  var area = 0;
  for (var i = 0; i < xy.length; i++){
    var j = (i + 1) % xy.length;
    area += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
  }
  return Math.abs(area / 2) * 10.7639;
}

function dprEnsureSectionModal(){
  var existing = document.getElementById("dpr-section-modal");
  if (existing) return existing;
  var modal = document.createElement("div");
  modal.id = "dpr-section-modal";
  modal.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000";
  modal.innerHTML =
    '<div style="position:absolute;inset:16px;background:#fff;border-radius:8px;display:flex;flex-direction:column;overflow:hidden">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #ddd">' +
        '<b id="dpr-section-title" style="font-size:16px;flex:1">Trace Today\'s Section</b>' +
        '<button class="btn" onclick="dprSectionCancel()">✕ Close</button>' +
      '</div>' +
      '<p class="hint" id="dpr-section-hint" style="margin:8px 14px 0"></p>' +
      '<div id="dpr-section-map" style="flex:1;margin:8px 14px;min-height:220px;background:#ECEFF1;border-radius:6px"></div>' +
      '<div class="btnrow" id="dpr-section-tracebtns" style="margin:0 14px 12px">' +
        '<button class="btn" onclick="dprSectionUndo()">↩ Undo point</button>' +
        '<button class="btn danger" onclick="dprSectionClearPoints()">Clear</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn primary" id="dpr-section-finish" onclick="dprSectionFinish()" disabled>✓ Save Section</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);
  return modal;
}

async function dprOpenSectionTrace(){
  if (!dprCanCreate()){ toast("Your role can view reports but can't edit them."); return; }
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  var modal = dprEnsureSectionModal();
  document.getElementById("dpr-section-title").textContent = "Trace Today's Section";
  document.getElementById("dpr-section-tracebtns").style.display = "";
  modal.style.display = "";
  lockBodyScroll();
  var roof = dprSelectedRoofObj();
  var hint = document.getElementById("dpr-section-hint");
  hint.textContent = "Loading map…";
  try{
    var ctx = await dprSetupSectionMap("dpr-section-map", roof, { readOnly: false });
    dprTrace = { active: true, points: [], map: ctx.map, mode: ctx.mode, frameUrl: ctx.frameUrl,
      w: ctx.w, h: ctx.h, markers: [], poly: null };
    hint.textContent = ctx.mode === "image"
      ? "Tap the corners of the area worked today on the roof plan, all the way around."
      : "Tap the corners of the area worked today. Need at least 3 points.";
    /* Seed from an existing section so re-opening edits rather than restarts. */
    if (dprState.section && dprState.section.mode === ctx.mode &&
        (ctx.mode !== "image" || dprState.section.imageFrameUrl === ctx.frameUrl)){
      var seed = ctx.mode === "image"
        ? (dprState.section.imageRing || []).map(function(p){ return dprFractionToLatLng(p, ctx); })
        : (dprState.section.ring || []).map(function(p){ return L.latLng(p.lat, p.lng); });
      /* drop a closing dup if present */
      if (seed.length > 1 && seed[0].lat === seed[seed.length - 1].lat && seed[0].lng === seed[seed.length - 1].lng) seed.pop();
      seed.forEach(function(ll){ dprTrace.points.push(ll); });
    }
    ctx.map.on("click", function(e){ dprSectionAddPoint(e.latlng); });
    dprSectionRenderPreview();
    /* If we seeded an existing section, frame it (so an edit opens ON the
       section, not wherever the base map happened to center). */
    if (dprTrace.points.length >= 2){
      try{ ctx.map.fitBounds(L.latLngBounds(dprTrace.points).pad(0.4)); }catch(e){}
    }
    setTimeout(function(){ try{ ctx.map.invalidateSize(); }catch(e){} }, 60);
  }catch(e){
    hint.textContent = "Couldn't load the map: " + e.message;
  }
}

/* Sets up a Leaflet map on the given div for the roof's base map (or satellite).
   Resolves { map, mode:"geo"|"image", frameUrl, w, h }. Shared by trace + progress. */
async function dprSetupSectionMap(divId, roof, opts){
  opts = opts || {};
  var div = document.getElementById(divId);
  if (!div) throw new Error("map container missing");
  div.innerHTML = ""; /* Leaflet refuses to reuse a container */
  var base = dprRoofBaseMap(roof);
  if (base.kind === "image"){
    /* Flat roof plan / sketch — no geodata. CRS.Simple, image placed 0..h × 0..w. */
    var dims = await dprLoadImageDims(base.url);
    var map = L.map(divId, { crs: L.CRS.Simple, minZoom: -5, zoomControl: true, attributionControl: false });
    var bounds = [[0, 0], [dims.h, dims.w]];
    L.imageOverlay(base.url, bounds).addTo(map);
    map.fitBounds(bounds);
    return { map: map, mode: "image", frameUrl: base.url, w: dims.w, h: dims.h };
  }
  var map2 = L.map(divId, { zoomControl: true, attributionControl: false });
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, maxNativeZoom: SAT_MAX_NATIVE_ZOOM, attribution: "Tiles © Esri" }).addTo(map2);
  if (base.kind === "ortho"){
    var llb = boundsToLatLngBounds(base.bounds);
    L.imageOverlay(base.url, llb).addTo(map2);
    map2.fitBounds(llb);
    return { map: map2, mode: "geo", frameUrl: null, w: null, h: null };
  }
  /* Satellite: zoom straight to the job — best-available GPS/coordinate for
     the site (photo GPS → building's cached/geometry coord → geocoded address
     on file → this device's GPS), else a wide view to pan from. */
  var resolved = await dprResolveJobCenter(roof);
  if (resolved){ map2.setView([resolved.lat, resolved.lng], resolved.zoom || 20); }
  else {
    var dev = null;
    try{ dev = await captureDeviceGps(); }catch(e){}
    if (dev && dev.ok){ map2.setView([dev.lat, dev.lng], 20); }
    else { map2.setView([39.8, -98.6], 4); toast("Couldn't locate the job — pan/zoom to the roof, then trace."); }
  }
  return { map: map2, mode: "geo", frameUrl: null, w: null, h: null };
}
/* Best-known coordinate for the current job, most-precise first. "gps location
   or the address in the file" (Mark): today's on-site photo GPS, then the
   building's cached geocode / most-recent roof-outline centroid (reusing
   bnmCachedCoord — the same resolver Buildings Near Me trusts), then a live
   geocode of the address on file (cached back so it's a one-time cost). Device
   GPS is a further fallback handled by the caller. Returns {lat,lng,zoom} or null. */
async function dprResolveJobCenter(roof){
  /* 1) A photo taken on the job today carries the truest position. */
  for (var i = 0; i < dprPhotos.length; i++){
    var g = dprPhotos[i] && dprPhotos[i].gps;
    if (g && typeof g.lat === "number" && typeof g.lng === "number") return { lat: g.lat, lng: g.lng, zoom: 20 };
  }
  /* 1a) A section already traced on THIS report — the foreman just marked
     exactly where the work is, so re-opening the trace should land there. */
  var scNow = dprSectionCentroid(dprState.section);
  if (scNow) return { lat: scNow.lat, lng: scNow.lng, zoom: 20 };
  /* 1b) An outline already traced on this roof (fast, no fetch). */
  var rc = dprRoofExistingCenter(roof);
  if (rc) return { lat: rc.lat, lng: rc.lng, zoom: 20 };
  var buildingId = dprState.buildingId || dprBuildingId(val("dpr-billTo"), val("dpr-jobName"));
  if (buildingId && fdb){
    try{
      var snap = await fdb.collection("buildings").doc(buildingId).get();
      if (snap.exists){
        var b = Object.assign({ id: buildingId }, snap.data());
        /* 2) Building's cached geocode or any roof's outline centroid. */
        if (typeof bnmCachedCoord === "function"){
          var c = bnmCachedCoord(b);
          if (c) return { lat: c.lat, lng: c.lng, zoom: 20 };
        }
      }
    }catch(e){}
    /* 2b) A section traced on a PRIOR day's report for this same job — this is
       the fix for "the second report didn't zoom": even with no RoofMapper
       outline and no geocode cache, yesterday's traced section pins the job. */
    try{
      var pq = await fdb.collection("daily_progress_reports").where("buildingId", "==", buildingId).get();
      var best = null;
      pq.forEach(function(d){
        var r = d.data();
        var pc = dprSectionCentroid(r && r.section);
        if (pc && (!best || (r.updatedAt || 0) > best.updatedAt)) best = { lat: pc.lat, lng: pc.lng, updatedAt: r.updatedAt || 0 };
      });
      if (best) return { lat: best.lat, lng: best.lng, zoom: 20 };
    }catch(e){}
    /* 3) Geocode the address on file, then cache it back for next time. */
    try{
      var geo = await geocodeAddress(val("dpr-location") || val("dpr-jobName"));
      if (geo){ try{ if (typeof bnmCacheGeocode === "function") bnmCacheGeocode(buildingId, geo); }catch(e){} return { lat: geo.lat, lng: geo.lng, zoom: 20 }; }
    }catch(e){}
  } else {
    /* 3b) No building yet — geocode whatever address the form has. */
    try{
      var geo2 = await geocodeAddress(val("dpr-location") || val("dpr-jobName"));
      if (geo2) return { lat: geo2.lat, lng: geo2.lng, zoom: 20 };
    }catch(e){}
  }
  return null;
}
/* Geo-mode section centroid (null for image-mode / missing) — used both to
   center the map on an already-traced area and to cache a job's location. */
function dprSectionCentroid(section){
  if (!section || section.mode !== "geo" || !section.ring || section.ring.length < 3) return null;
  var pts = section.ring.slice();
  if (pts.length > 1){
    var a = pts[0], z = pts[pts.length - 1];
    if (a.lat === z.lat && a.lng === z.lng) pts = pts.slice(0, -1);
  }
  if (!pts.length) return null;
  var sLat = 0, sLng = 0;
  pts.forEach(function(p){ sLat += p.lat; sLng += p.lng; });
  return { lat: sLat / pts.length, lng: sLng / pts.length };
}
function dprLoadImageDims(url){
  return new Promise(function(resolve, reject){
    var img = new Image();
    img.onload = function(){ resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }); };
    img.onerror = function(){ reject(new Error("base map image failed to load")); };
    img.src = url;
  });
}
function dprRoofExistingCenter(roof){
  if (!roof) return null;
  var outs = roof.roof_outlines || [];
  for (var i = 0; i < outs.length; i++){
    var o = outs[i];
    if (o && o.center && typeof o.center.lat === "number") return o.center;
    if (o && o.ring && o.ring.length && typeof o.ring[0].lat === "number") return o.ring[0];
  }
  return null;
}
/* Image mode: click latlng is (lat∈0..h, lng∈0..w) → fraction; and back. */
function dprLatLngToFraction(latlng, ctx){ return { x: latlng.lng / ctx.w, y: latlng.lat / ctx.h }; }
function dprFractionToLatLng(f, ctx){ return L.latLng(f.y * ctx.h, f.x * ctx.w); }

function dprSectionAddPoint(latlng){
  if (!dprTrace || !dprTrace.active) return;
  dprTrace.points.push(latlng);
  dprSectionRenderPreview();
}
function dprSectionUndo(){
  if (!dprTrace) return;
  dprTrace.points.pop();
  dprSectionRenderPreview();
}
function dprSectionClearPoints(){
  if (!dprTrace) return;
  dprTrace.points = [];
  dprSectionRenderPreview();
}
function dprSectionRenderPreview(){
  if (!dprTrace || !dprTrace.map) return;
  var map = dprTrace.map;
  dprTrace.markers.forEach(function(m){ map.removeLayer(m); });
  dprTrace.markers = [];
  if (dprTrace.poly){ map.removeLayer(dprTrace.poly); dprTrace.poly = null; }
  dprTrace.points.forEach(function(ll){
    dprTrace.markers.push(L.circleMarker(ll, { radius: 5, color: "#E8600A", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(map));
  });
  if (dprTrace.points.length >= 2){
    dprTrace.poly = L.polygon(dprTrace.points, { color: "#E8600A", weight: 2, fillOpacity: 0.25 }).addTo(map);
  }
  var finish = document.getElementById("dpr-section-finish");
  if (finish) finish.disabled = dprTrace.points.length < 3;
}
function dprSectionFinish(){
  if (!dprTrace || dprTrace.points.length < 3){ toast("Tap at least 3 corners first."); return; }
  var pts = dprTrace.points;
  var section = { roofId: dprSelectedRoofId(), mode: dprTrace.mode, createdAt: Date.now(), areaSqFt: null };
  if (dprTrace.mode === "image"){
    section.imageFrameUrl = dprTrace.frameUrl;
    section.imageRing = pts.map(function(ll){ return dprLatLngToFraction(ll, dprTrace); });
    /* close the ring */
    section.imageRing.push(Object.assign({}, section.imageRing[0]));
  } else {
    var ring = pts.map(function(ll){ return { lat: ll.lat, lng: ll.lng }; });
    ring.push({ lat: ring[0].lat, lng: ring[0].lng });
    section.ring = ring;
    section.areaSqFt = Math.round(dprRingAreaSqFt(ring) || 0) || null;
  }
  dprState.section = section;
  dprSectionCancel();
  dprRenderSectionStatus();
  toast("Section saved to today's report" + (section.areaSqFt ? " (~" + section.areaSqFt + " sq ft)" : "") + " — remember to Save the report");
}
function dprSectionCancel(){
  var modal = document.getElementById("dpr-section-modal");
  if (modal) modal.style.display = "none";
  unlockBodyScroll();
  if (dprTrace && dprTrace.map){ try{ dprTrace.map.remove(); }catch(e){} }
  dprTrace = null;
}
function dprClearSection(){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  if (!dprState.section) return;
  if (!confirm("Remove the traced section from today's report?")) return;
  dprState.section = null;
  dprRenderSectionStatus();
  toast("Section removed — Save the report to persist that.");
}
function dprRenderSectionStatus(){
  var host = document.getElementById("dpr-section-status");
  if (!host) return;
  var s = dprState.section;
  if (!s){
    host.innerHTML = '<span class="hint">No section traced yet.</span>';
    return;
  }
  var area = s.areaSqFt ? " · ~" + s.areaSqFt + " sq ft" : "";
  host.innerHTML = '<span style="color:#2E7D32">✓ Section traced' + esc(area) + '</span> ' +
    '<button class="btn" onclick="dprOpenSectionTrace()">Edit</button> ' +
    '<button class="btn danger" onclick="dprClearSection()">Remove</button>';
}

/* Progress Map — every DPR section for this building, stacked newest-brightest. */
async function dprShowProgressMap(){
  var buildingId = dprState.buildingId || dprBuildingId(val("dpr-billTo"), val("dpr-jobName"));
  if (!buildingId){ toast("Pick or type the job first so I know which building's progress to show."); return; }
  if (!fdb){ toast("The progress map needs an internet connection."); return; }
  var modal = dprEnsureSectionModal();
  document.getElementById("dpr-section-title").textContent = "Progress Map — all days";
  document.getElementById("dpr-section-tracebtns").style.display = "none";
  document.getElementById("dpr-section-hint").textContent = "Loading progress…";
  modal.style.display = "";
  lockBodyScroll();
  try{
    var roof = dprSelectedRoofObj();
    var ctx = await dprSetupSectionMap("dpr-section-map", roof, { readOnly: true });
    setTimeout(function(){ try{ ctx.map.invalidateSize(); }catch(e){} }, 60);
    var qs = await fdb.collection("daily_progress_reports")
      .where("buildingId", "==", buildingId).get();
    var reports = [];
    qs.forEach(function(d){ var r = d.data(); if (r && r.section) reports.push(r); });
    reports.sort(function(a, b){ return String(a.date).localeCompare(String(b.date)); });
    if (!reports.length){
      document.getElementById("dpr-section-hint").textContent = "No sections traced for this job yet.";
      return;
    }
    var drawn = 0, allPts = [];
    reports.forEach(function(r, idx){
      var s = r.section;
      var latlngs = null;
      if (s.mode === "image" && ctx.mode === "image" && s.imageFrameUrl === ctx.frameUrl){
        latlngs = (s.imageRing || []).map(function(p){ return dprFractionToLatLng(p, ctx); });
      } else if (s.mode === "geo" && ctx.mode === "geo"){
        latlngs = (s.ring || []).map(function(p){ return L.latLng(p.lat, p.lng); });
      }
      if (!latlngs || latlngs.length < 3) return;
      var color = DPR_SECTION_COLORS[idx % DPR_SECTION_COLORS.length];
      var recent = idx >= reports.length - 1; /* newest brightest */
      var poly = L.polygon(latlngs, { color: color, weight: 2, fillOpacity: recent ? 0.45 : 0.2 }).addTo(ctx.map);
      poly.bindTooltip((r.date || "") + (r.foreman ? " · " + r.foreman : ""), { permanent: false });
      latlngs.forEach(function(ll){ allPts.push(ll); });
      drawn++;
    });
    document.getElementById("dpr-section-hint").textContent = drawn +
      " day" + (drawn === 1 ? "" : "s") + " of progress shown" +
      (ctx.mode === "image" ? " (roof plan)" : "") + ".";
    if (allPts.length){ try{ ctx.map.fitBounds(L.latLngBounds(allPts).pad(0.2)); }catch(e){} }
  }catch(e){
    document.getElementById("dpr-section-hint").textContent = "Couldn't load the progress map: " + e.message;
  }
}

/* ================= sign-off + lock — INTEGRATION HOOKS ONLY =================
   The signature pad, "send to a selectable person," the CompanyCam copy, and
   CC↔Foundation matching are being built in a PARALLEL session and live in
   other files (companycam.js, the signature flow, backend). This module owns
   ONLY the DPR side: the lock state, read-only enforcement once locked, and a
   single stable entry point + decoupled DOM events the other work plugs into.
   Nothing here opens a signature pad, sends anything, or touches CompanyCam.

   CONTRACT for the parallel session (no function-name coupling either way):
   - To sign + lock a DPR: call  dprApplySignoff({ signedByName, signatureRef })
     — it persists the signature, marks the report locked, saves, applies the
     read-only UI, then dispatches a `dpr:signed` event.
   - To drive the signature pad from the DPR's "Sign & Lock" button: listen for
     the `dpr:request-signature` event, set detail.handled = true, capture the
     signature, then call detail.applySignoff({...}).
   - After lock, react to the `dpr:signed` event (detail: { id, buildingId,
     companyCamProjectId, doc, buildPdf }) to send the copy, push to CompanyCam,
     and match/lock CC + Foundation to the job. `buildPdf(doc)` returns the DPR
     jsPDF doc (same one Download uses). The building already carries
     companyCamProjectId; a Foundation job id can be stamped onto `doc` here too.
   The DPR doc's `signoff` field is the source of truth:
     { signed, locked, signedByName, signedAt, signatureRef,
       distributedAt?, distributedTo?, ccPushedAt?, foundationJobId? }  */
function dprIsLocked(){ return !!(dprState.signoff && dprState.signoff.locked); }
var DPR_LOCK_READONLY_FIELDS = ["dpr-foreman", "dpr-jobName", "dpr-billTo", "dpr-location",
  "dpr-jobNo", "dpr-roofSystem", "dpr-date", "dpr-headcount", "dpr-hours", "dpr-squares",
  "dpr-summary", "dpr-bld-search"];
function dprApplySignoffLock(){
  var locked = dprIsLocked();
  var s = dprState.signoff || {};
  var banner = document.getElementById("dpr-lock-banner");
  if (banner){
    banner.style.display = locked ? "" : "none";
    if (locked){
      banner.textContent = "🔒 Signed & locked" +
        (s.signedByName ? " by " + s.signedByName : "") +
        (s.signedAt ? " on " + new Date(s.signedAt).toLocaleDateString() : "") +
        " — this report can no longer be edited.";
    }
  }
  /* Save + the sign button disappear when locked; view-only actions (History,
     Download PDF, Progress Map, New) stay. */
  var saveBtn = document.getElementById("dpr-save-btn");
  if (saveBtn) saveBtn.style.display = (locked || !dprCanCreate()) ? "none" : "";
  var signBtn = document.getElementById("dpr-sign-btn");
  if (signBtn) signBtn.style.display = (locked || !dprCanCreate()) ? "none" : "";
  /* Freeze the always-on inputs. Crew/photo/section edits are additionally
     blocked at their entry points (dprIsLocked guards below), which also covers
     the dynamically-rendered rows. */
  DPR_LOCK_READONLY_FIELDS.forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.readOnly = locked;
  });
  var capRow = document.getElementById("dpr-capture-row");
  if (capRow && locked) capRow.style.display = "none";
  else if (capRow && dprCanCreate()) capRow.style.display = "";
}
/* The single entry point the parallel session calls to sign + lock a report. */
async function dprApplySignoff(signoff){
  if (!dprCanCreate()){ toast("Only field/foreman roles can sign off a report."); return false; }
  if (dprIsLocked()){ toast("This report is already signed and locked."); return false; }
  var o = dprCollect();
  var problem = dprValidate(o);
  if (problem){ toast(problem); return false; }
  if (!fdb){ toast("No internet — can't sign and lock the report right now."); return false; }
  var prev = dprState.signoff;
  dprState.signoff = Object.assign({ signed: true, locked: true, signedAt: Date.now() }, signoff || {});
  o.signoff = dprState.signoff;
  try{
    if (typeof ensureCustomerAndBuilding === "function"){ try{ await ensureCustomerAndBuilding(o); }catch(e){} }
    await dprCloudSave(o);
    dprState.id = o.id;
  }catch(e){ dprState.signoff = prev || null; toast(dprSaveErrMsg(e)); return false; }
  dprApplySignoffLock();
  toast("Report signed and locked ✓");
  dprDispatchSignoffEvent("dpr:signed", o);
  return true;
}
function dprDispatchSignoffEvent(name, o){
  try{
    document.dispatchEvent(new CustomEvent(name, { detail: {
      id: o.id, buildingId: o.buildingId, companyCamProjectId: o.companyCamProjectId || null,
      doc: o, buildPdf: generateDprPdf
    } }));
  }catch(e){ /* CustomEvent unsupported — non-fatal, the report is still saved+locked */ }
}
/* Wired to the DPR "✍️ Sign & Lock" button. Hands off to the parallel session's
   signature pad via a cancelable event; until that ships, it says so. */
function dprRequestSignature(){
  if (dprIsLocked()){ toast("This report is already signed and locked."); return; }
  if (!dprCanCreate()){ toast("Only field/foreman roles can sign a report."); return; }
  var o = dprCollect();
  var problem = dprValidate(o);
  if (problem){ toast(problem); return; }
  var ev = null;
  try{ ev = new CustomEvent("dpr:request-signature", { cancelable: true,
    detail: { id: o.id, doc: o, applySignoff: dprApplySignoff, handled: false } }); }catch(e){}
  if (ev) document.dispatchEvent(ev);
  if (!ev || !ev.detail.handled){
    toast("Signature & lock is being added in a separate update — this button activates once that ships.");
  }
}

/* ================= progressive-disclosure scaffolding =================
   The primitive later phases will use to reveal a Yes/No-gated section, mirroring
   onWoTypeChange()'s idiom (getElementById + style.display). A radio/select in a
   future card calls dprGate('dpr-delays-radio','dpr-delays-body','Yes') on change;
   nothing else changes. Kept live now (even though no gated sections exist yet) so
   Phase 2+ is purely additive. */
function dprGate(controlId, targetId, showValue){
  var control = document.getElementById(controlId);
  var target = document.getElementById(targetId);
  if (!control || !target) return;
  target.style.display = (control.value === showValue) ? "" : "none";
}

/* ================= basic PDF export =================
   Self-contained builder (own doc/heading/table locals), styled like the other
   RoofOps documents — same convention as generateChangeOrderPdf() in export.js:
   each document type gets its own builder rather than branching one template. */
var DPR_BRAND_RED = [180, 34, 63];
async function dprDownloadPdf(){
  if (!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autotable)){
    toast("PDF tools couldn't load — check your internet connection.");
    return;
  }
  var o = dprCollect();
  var problem = dprValidate(o);
  if (problem){ toast(problem); return; }
  toast("Building PDF…");
  try{
    var doc = await generateDprPdf(o);
    if (!doc) return;
    doc.save(dprPdfFileName(o));
  }catch(e){ toast("Couldn't build the PDF: " + e.message); }
}
function dprPdfFileName(o){
  var parts = ["DailyProgress", (o.jobName || "job").replace(/[^A-Za-z0-9]+/g, "_"), o.date || ""];
  return parts.filter(Boolean).join("_").replace(/_+/g, "_") + ".pdf";
}
async function generateDprPdf(o){
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  var M = 40, y = M;
  var RED = DPR_BRAND_RED;

  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(RED[0], RED[1], RED[2]);
  doc.text("DAILY PROGRESS REPORT", M, y + 16);
  doc.setDrawColor(RED[0], RED[1], RED[2]); doc.setLineWidth(1.4);
  doc.line(M, y + 26, W - M, y + 26);
  y += 44;

  function heading(t){
    if (y > H - 90){ doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(30, 39, 46);
    doc.text(t, M, y); y += 8;
  }
  function kvTable(rows){
    rows = rows.filter(function(r){ return r[1] != null && String(r[1]).trim() !== ""; });
    if (!rows.length) return;
    doc.autoTable({
      startY: y, body: rows, theme: "grid",
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 150 } }, margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 16;
  }
  function wrapped(text){
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(30, 39, 46);
    var lines = doc.splitTextToSize(String(text || ""), W - 2 * M);
    for (var i = 0; i < lines.length; i++){
      if (y > H - 50){ doc.addPage(); y = M; }
      doc.text(lines[i], M, y); y += 14;
    }
    y += 6;
  }

  heading("Job Information");
  kvTable([
    ["Job Name", o.jobName], ["Customer", o.billTo], ["Location", o.location],
    ["Job No.", o.jobNo], ["Roof System", o.roofSystem], ["Date", o.date], ["Foreman", o.foreman]
  ]);

  heading("Crew & Production");
  kvTable([
    ["Crew On Site", (o.crew || []).map(function(c){ return c.name; }).filter(Boolean).join(", ")],
    ["Headcount", o.headcount], ["Hours Worked", o.hoursWorked], ["Approx. Squares Applied", o.squares],
    ["Roof Section Traced", o.section ? (o.section.areaSqFt ? "Yes · ~" + o.section.areaSqFt + " sq ft" : "Yes") : ""]
  ]);

  if (o.summary && o.summary.trim()){
    heading("Summary of Work");
    wrapped(o.summary);
  }

  /* Photos — 2-up grid with numbered captions, images resolved on demand from
     Storage (or inline bytes) via the shared resolvePhotoImg(). */
  var photos = (o.photos || []).slice();
  if (photos.length){
    if (y > H - 120){ doc.addPage(); y = M; }
    heading("Photos");
    for (var pi = 0; pi < photos.length; pi++){
      try{ photos[pi]._img = await resolvePhotoImg(photos[pi]); }catch(e){ photos[pi]._img = null; }
    }
    var colW = (W - 2 * M - 12) / 2, imgH = 150;
    for (var i = 0; i < photos.length; i += 2){
      if (y > H - (imgH + 40)){ doc.addPage(); y = M; }
      for (var col = 0; col < 2; col++){
        var p = photos[i + col];
        if (!p) continue;
        var x = M + col * (colW + 12);
        if (p._img){
          try{ doc.addImage(p._img, "JPEG", x, y, colW, imgH); }catch(e){}
        }
        doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(30, 39, 46);
        var cap = doc.splitTextToSize((i + col + 1) + ". " + (p.caption || ""), colW);
        doc.text(cap, x, y + imgH + 12);
      }
      y += imgH + 12 + 22;
    }
  }

  var pages = doc.getNumberOfPages();
  for (var pg = 1; pg <= pages; pg++){
    doc.setPage(pg);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(120, 128, 134);
    doc.text("Daily Progress Report · " + (o.jobName || "") + " · Page " + pg + " of " + pages, M, H - 20);
  }
  return doc;
}
