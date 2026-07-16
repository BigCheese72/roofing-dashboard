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
var dprCrew = [];        /* roster rows: [{ name, hours, hoursSource }]  headcount + daily total derive from this.
                            hours is a form-style string ("8", "7.5", "" = not entered);
                            hoursSource is "foundation" when auto-filled from the time
                            clock (see dprAutofillCrewHours) or "" for manual entry —
                            a manual edit always wins and flips it back to "". */
var dprQuantities = [];  /* material-quantity rows: [{ item, qty, unit }] (Phase-2 gated section) */
var dprPhotos = [];      /* [{ caption, img, thumb, w, h, gps, storageRef, localId }] */
var dprHeadcountAutoVal = "";  /* last headcount we auto-filled — lets a manual edit stick (same trick as CO job-no autofill) */
var dprHoursAutoVal = "";      /* last "Hours Worked" total we auto-filled from crew hours — same manual-edit-wins trick */
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
   the field is a pick-list with autocomplete; typed names still work and are
   remembered (field-history 'dprForeman').
   Provided by Mark from Foundation, 2026-07 — the connector has no employee
   data (jobs + per-job hours only), so this list is maintained here by hand.
   Ask Mark for adds/removes; keep in sync with DPR_CREW_ROSTER below. */
var DPR_FOREMEN = [
  "Cletus Bagby",
  "Dax Dollens",
  "Dalean Germany",
  "Christopher Gravitt",
  "Benjamin Mudd",
  "Mendel Needham",
  "William Noga",
  "Mark Sheppard",
  "Kelly Walker"
];
/* Full field/roofer roster for the Crew pick-list (dl-dprCrew) — same source
   and maintenance story as DPR_FOREMEN above. Foremen are merged in when the
   datalist is built (a foreman on the roof is crew too). */
var DPR_CREW_ROSTER = [
  "Christian Abernathy",
  "Dustin Adkins",
  "Steven Arce Vazquez",
  "Nicholas Beckwith",
  "Bradley Belisle",
  "Guillermo Caliz",
  "James Cheek",
  "Mitchell Chilton",
  "Billy Coleman",
  "Brandon Dabney",
  "Brian Draper",
  "Leland Fitzgerald",
  "Aaron Fletcher",
  "Caydan Garner",
  "Gerald Ginnings",
  "Dale Griggs",
  "Kenneth Hancock",
  "Keith Hardecke",
  "Lorenzo Harris",
  "David Hendren",
  "Joe Hernandez",
  "Christopher Hubbard",
  "Matthew Lock",
  "Clinton Mahler",
  "Cameron Minor",
  "Gary Muse",
  "Cesar Nava",
  "Kyle Needham",
  "Gabriel Olmstead",
  "Jesse Pearman",
  "Roscoe Rowland",
  "Wade Sanderson",
  "Denis Seu",
  "Jacob Shackleford",
  "Darrin Stokes",
  "Juan Valdovinos",
  "Timothy Vanlandingham",
  "Steven Veverka",
  "Dalton Walker",
  "Kelly Walker",
  "Aaron West",
  "Bradley Wieberg",
  "Levi Workman"
];
function dprPopulateForemen(){
  var names = DPR_FOREMEN.slice();
  try{
    (getFieldHistory("dprForeman") || []).forEach(function(v){ if (names.indexOf(v) === -1) names.push(v); });
  }catch(e){}
  dprSetDatalist("dl-dprForeman", names);
}
/* Immediate (offline-safe) seed of the Crew pick-list: full roster + foremen +
   whatever's been typed on this device. dprPopulateDataLists() re-renders it
   later with prior-DPR crew names merged in. */
function dprPopulateCrewRoster(){
  var names = DPR_CREW_ROSTER.concat(DPR_FOREMEN);
  try{
    (getFieldHistory("technician") || []).forEach(function(v){ names.push(v); });
  }catch(e){}
  dprSetDatalist("dl-dprCrew", names);
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
  dprPopulateForemen();     /* immediate/offline: roster + device history */
  dprPopulateCrewRoster();  /* immediate/offline: full crew roster */
  dprSetDatalist("dl-dprRentedType", DPR_RENTED_TYPES); /* rented-equipment type pick-list */
  dprSetDatalist("dl-dprToolboxTalks", DPR_TOOLBOX_TALKS); /* toolbox-talk pick-list (free text still works) */
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
    dprSetDatalist("dl-dprCrew", DPR_CREW_ROSTER.concat(DPR_FOREMEN, crew, getFieldHistory("technician")));
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
    dprFdnJobsCache.sort(dprFdnJobCompare);
  }catch(e){ dprFdnJobsCache = dprFdnJobsCache || []; }
}
/* NEWEST job first (Mark: the picker listed old→new; the recent jobs are the
   ones a foreman actually wants). Primary key: job_start_date DESC — the
   cache carries it as an ISO string, so a plain string compare orders it;
   jobs with no start date sink to the bottom. Tie/fallback: job NUMBER
   descending, numeric-aware ("17476" above "9999") — the same proxy the WO
   picker's fdnLoadJobs() (js/foundation.js) already uses. */
function dprFdnJobCompare(a, b){
  var da = String(a.job_start_date || ""), db_ = String(b.job_start_date || "");
  if (da !== db_){
    if (!da) return 1;         /* undated sinks */
    if (!db_) return -1;
    return da < db_ ? 1 : -1;  /* ISO strings — newest first */
  }
  var na = Number(a.job_no), nb = Number(b.job_no);
  if (isFinite(na) && isFinite(nb) && na !== nb) return nb - na;
  return String(b.job_no || "").localeCompare(String(a.job_no || ""));
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
  dprHideJobSelect();
  dprScheduleSameDayLoad();
  dprScheduleCrewHoursAutofill();
  dprRefreshLaborCard();
  dprPopulateCrewFromPunches(false);  /* empty roster fills itself from the clock */
  dprRefreshWeather();
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
/* Delegates to THE canonical derivation (buildingIdFor(), js/core.js —
   audit FIX 1 deduped the five hand-copied slug formulas into that one) so
   a DPR files under the EXACT building doc the work orders do — never a
   parallel/rogue building record. Wrapper kept so dpr.js call sites are
   untouched (crew-roster work is in-flight in this file). */
function dprBuildingId(billTo, jobName){
  return buildingIdFor(billTo, jobName);
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
  dprRenderQuantities();
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
  if (dateEl) dateEl.addEventListener("change", dprScheduleCrewHoursAutofill); /* punches are per-day */
  if (dateEl) dateEl.addEventListener("change", function(){ dprPopulateCrewFromPunches(false); });
  if (dateEl) dateEl.addEventListener("change", function(){ dprState.weather = null; dprRefreshWeather(); }); /* new day = new conditions */
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
   Same buildings collection, same read-only load.

   The "🔍 Select Job" BUTTON is the front door (Mark: the search box alone
   didn't read as a way to pick a job): tap it and the recent jobs list shows
   IMMEDIATELY — no typing needed — with the filter box above it. */
function dprShowJobSelect(){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  var wrap = document.getElementById("dpr-job-select");
  if (!wrap) return;
  if (wrap.style.display !== "none"){ wrap.style.display = "none"; return; } /* second tap closes */
  wrap.style.display = "";
  setVal("dpr-bld-search", "");
  dprSearchBuildings(); /* empty query = recent jobs, so there's a list to tap right away */
  var inp = document.getElementById("dpr-bld-search");
  if (inp) try{ inp.focus(); }catch(e){}
}
function dprHideJobSelect(){
  var wrap = document.getElementById("dpr-job-select");
  if (wrap) wrap.style.display = "none";
}
async function dprSearchBuildings(){
  var q = (val("dpr-bld-search") || "").trim().toLowerCase();
  var host = document.getElementById("dpr-bld-results");
  if (!host) return;
  if (!fdb){ host.innerHTML = '<p class="hint">The job list needs an internet connection.</p>'; return; }
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
  /* Empty query (fresh "Select Job" tap) = the recent list, labeled as such. */
  var html = (!q && matches.length) ? '<div class="hint" style="margin:0 0 4px;font-weight:600">Recent jobs</div>' : "";
  html += matches.map(function(b){
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
  dprHideJobSelect();
  dprState.buildingId = buildingId;
  dprState.roofs = getBuildingRoofs(b);
  dprRenderRoofPicker();
  /* Prefer the building's Foundation job number (the accounting system of
     record) for Job No.; fall back to the parent-job derivation only if the
     building has no Foundation link. */
  if (!dprApplyFoundationJobNo(b)) dprAutofillJobNo(buildingId);
  dprScheduleSameDayLoad();
  dprScheduleCrewHoursAutofill();
  dprRefreshLaborCard();
  dprPopulateCrewFromPunches(false);  /* empty roster fills itself from the clock */
  dprRefreshWeather();
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

/* ================= crew roster + per-person hours + headcount ================= */
function dprAddCrewRow(name){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  dprCrew.push({ name: name || "", hours: "", hoursSource: "" });
  dprRenderCrew();
  dprSyncHeadcount();
}
function dprRemoveCrewRow(idx){
  if (dprIsLocked()) return;
  dprCrew.splice(idx, 1);
  dprRenderCrew();
  dprSyncHeadcount();
  dprSyncHours();
}
function dprRenderCrew(){
  var host = document.getElementById("dpr-crew-list");
  if (!host) return;
  if (!dprCrew.length){
    host.innerHTML = '<p class="hint">No crew added yet. Add each person who worked this job today.</p>';
    return;
  }
  var locked = dprIsLocked();
  host.innerHTML = dprCrew.map(function(c, i){
    /* The ⏱ badge marks hours auto-filled from the time clock (Foundation) —
       it disappears the moment the foreman edits the value (manual wins). */
    var fdnBadge = '<span class="hint" data-dprcrewsrc="' + i + '" ' +
      'style="margin:0;align-self:center' + (c.hoursSource === "foundation" ? "" : ";display:none") + '" ' +
      'title="Auto-filled from the time clock — edit to override">⏱</span>';
    return '<div class="btnrow" style="margin:0 0 6px;gap:6px">' +
      '<input type="text" placeholder="Crew member name" data-dprcrew="' + i + '" value="' + esc(c.name) + '" ' +
        'list="dl-dprCrew" style="flex:1;min-width:140px"' + (locked ? " readonly" : "") + '>' +
      '<input type="number" placeholder="Hrs" min="0" step="0.25" data-dprcrewhrs="' + i + '" ' +
        'value="' + esc(c.hours == null ? "" : String(c.hours)) + '" ' +
        'title="Hours this person worked today" style="width:76px"' + (locked ? " readonly" : "") + '>' +
      fdnBadge +
      '<button class="btn danger" onclick="dprRemoveCrewRow(' + i + ')">✕</button>' +
      '</div>';
  }).join("") + '<div class="hint" id="dpr-crew-total" style="margin:2px 0 0"></div>';
  host.querySelectorAll("[data-dprcrew]").forEach(function(el){
    el.addEventListener("input", function(){ dprCrew[+el.dataset.dprcrew].name = el.value; dprSyncHeadcount(); });
    /* Name committed (blur/datalist pick) — a punch may now match this person. */
    el.addEventListener("change", function(){ dprScheduleCrewHoursAutofill(); });
  });
  host.querySelectorAll("[data-dprcrewhrs]").forEach(function(el){
    el.addEventListener("input", function(){
      var i = +el.getAttribute("data-dprcrewhrs");
      dprCrew[i].hours = el.value;
      dprCrew[i].hoursSource = "";   /* typed by hand — manual always wins */
      var badge = host.querySelector('[data-dprcrewsrc="' + i + '"]');
      if (badge) badge.style.display = "none";
      dprRenderCrewTotal();
      dprSyncHours();
    });
  });
  dprRenderCrewTotal();
  dprRenderToolboxSignins(); /* the sign-in list mirrors the crew roster */
}
function dprCrewCount(){
  return dprCrew.filter(function(c){ return (c.name || "").trim(); }).length;
}

/* ================= toolbox talk (gated) + crew sign-in =====================
   Records the day's toolbox/tailgate safety talk and each crew member's
   acknowledgement, so a signed daily carries the signed toolbox talk as part
   of its record (Mark). The sign-in list REUSES the crew roster — every named
   crew member gets an "acknowledged" check; who signed is captured on the doc
   and printed in the PDF. Gated Yes/No like the other Phase-2 sections.

   Ack state is kept keyed by nameKey (not row index) so it survives crew
   re-renders, reordering, and hour auto-fills. A short talk list seeds a
   datalist (free text still works) — extensible later from the safety-doc
   toolbox-talk libraries in docs/RoofingSafetyDocumentSources.md. */
var dprToolboxSigned = {};   /* nameKey -> true (this crew member acknowledged) */
var DPR_TOOLBOX_TALKS = [
  "Fall Protection", "Ladder Safety", "Heat Illness Prevention", "PPE",
  "Housekeeping", "Hot Work / Torch Safety", "Electrical / Overhead Power Lines",
  "Material Handling", "Scaffolding", "Aerial / Scissor Lift Safety",
  "Silica / Dust", "Fire Prevention & Extinguishers"
];
function dprToolboxNamedCrew(){
  return dprCrew.filter(function(c){ return (c.name || "").trim(); });
}
function dprRenderToolboxSignins(){
  var host = document.getElementById("dpr-toolbox-signins");
  if (!host) return;
  var crew = dprToolboxNamedCrew();
  if (!crew.length){
    host.innerHTML = '<p class="hint" style="margin:4px 0">Add crew above, then each person acknowledges the talk here.</p>';
    return;
  }
  var locked = dprIsLocked();
  host.innerHTML = '<div class="hint" style="margin:6px 0 4px">Crew sign-in — each person acknowledges the talk:</div>' +
    crew.map(function(c){
      var k = dprNameKey(c.name);
      return '<label style="display:flex;gap:8px;align-items:center;margin:0 0 4px">' +
        '<input type="checkbox" data-dprtbx="' + esc(k) + '"' + (dprToolboxSigned[k] ? " checked" : "") + (locked ? " disabled" : "") + '>' +
        '<span>' + esc(c.name.trim()) + '</span></label>';
    }).join("") +
    '<div class="hint" id="dpr-toolbox-count" style="margin:2px 0 0"></div>';
  host.querySelectorAll("[data-dprtbx]").forEach(function(el){
    el.addEventListener("change", function(){
      var k = el.getAttribute("data-dprtbx");
      if (el.checked) dprToolboxSigned[k] = true; else delete dprToolboxSigned[k];
      dprRenderToolboxCount();
    });
  });
  dprRenderToolboxCount();
}
function dprRenderToolboxCount(){
  var el = document.getElementById("dpr-toolbox-count");
  if (!el) return;
  var crew = dprToolboxNamedCrew();
  var signed = crew.filter(function(c){ return dprToolboxSigned[dprNameKey(c.name)]; }).length;
  el.innerHTML = '<b>' + signed + '</b> of ' + crew.length + ' signed in';
}
/* The saved toolbox record: which talk + the crew who acknowledged (names, in
   roster order). null when the section is toggled off. */
function dprToolboxCollect(){
  if (!dprToggleIsYes("dpr-toolbox-toggle")) return null;
  var talk = (val("dpr-toolbox-talk") || "").trim();
  var signedBy = dprToolboxNamedCrew()
    .filter(function(c){ return dprToolboxSigned[dprNameKey(c.name)]; })
    .map(function(c){ return c.name.trim(); });
  if (!talk && !signedBy.length) return null; /* nothing to record */
  return { talk: talk, signedBy: signedBy };
}
function dprToolboxFill(o){
  var tb = o && o.toolbox ? o.toolbox : null;
  dprSetGate("dpr-toolbox-toggle", "dpr-toolbox-body", !!tb);
  setVal("dpr-toolbox-talk", tb ? (tb.talk || "") : "");
  dprToolboxSigned = {};
  if (tb && tb.signedBy) tb.signedBy.forEach(function(n){ var k = dprNameKey(n); if (k) dprToolboxSigned[k] = true; });
  dprRenderToolboxSignins();
}
/* Sum of the per-person hours across named crew rows, rounded to 2dp (defensive
   against "" / garbage — same discipline as sumHours in the Foundation lib). */
function dprCrewHoursTotal(){
  var total = dprCrew.reduce(function(acc, c){
    if (!(c.name || "").trim()) return acc;
    var h = Number(c.hours);
    return acc + (isFinite(h) && h > 0 ? h : 0);
  }, 0);
  return Math.round(total * 100) / 100;
}
/* Live total line under the crew rows — updated in place on every keystroke so
   the foreman sees the day's total build as they enter hours. */
function dprRenderCrewTotal(){
  var el = document.getElementById("dpr-crew-total");
  if (!el) return;
  var total = dprCrewHoursTotal();
  var n = dprCrewCount();
  el.innerHTML = total > 0
    ? 'Total hours today: <b>' + esc(String(total)) + '</b> across ' + esc(String(n)) + (n === 1 ? ' person' : ' people')
    : 'Add each person’s hours — the day’s total sums here.';
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
function dprSyncHours(){
  /* Auto-fill the day's "Hours Worked" total from the per-person crew hours —
     same never-stomp trick as headcount above. Only kicks in once there ARE
     crew hours (total > 0), so a foreman who still types one total by hand
     keeps that workflow untouched. */
  var el = document.getElementById("dpr-hours");
  if (!el) return;
  var total = dprCrewHoursTotal();
  if (total <= 0){
    /* The summed hours are gone (rows removed / hours cleared) — clear the
       total too, but only if it's still exactly what we auto-filled. */
    if (el.value.trim() !== "" && el.value.trim() === dprHoursAutoVal){
      el.value = "";
      dprHoursAutoVal = "";
    }
    return;
  }
  var current = el.value.trim();
  if (current === "" || current === dprHoursAutoVal){
    var n = String(total);
    el.value = n;
    dprHoursAutoVal = n;
  }
}

/* ================= Foundation time-clock auto-fill (per-person daily hours) ====
   Employees punch in/out daily and those punches land in Foundation before
   payroll posts them to jobs. Where a punch total exists for a crew member on
   this job + date, their hours AUTO-FILL (marked with the ⏱ badge); a manual
   edit always wins and is never overwritten.

   SERVER SEAM: netlify/functions/foundation.js `action=day_hours&job_no&date` —
   per-employee summed hours for one job + one date, name included, gated
   server-side on foundation.read exactly like the WO labor card (attempt-fetch,
   fail closed): a 401/403 stops asking for the session, any other error skips
   that job+date pair, and manual entry is untouched either way. Until the
   server action ships, the fetch 400s and this whole path is a silent no-op. */
var dprDayHoursCache = {};      /* "jobNo|date" -> { byName: {nameKey -> hours} } | null (fetch failed, don't retry) */
var dprDayHoursDenied = false;  /* server said not authorized — stop asking this session */
var dprCrewHoursTimer = null;
function dprScheduleCrewHoursAutofill(){
  if (dprCrewHoursTimer) clearTimeout(dprCrewHoursTimer);
  dprCrewHoursTimer = setTimeout(function(){ dprAutofillCrewHours(); }, 250);
}
/* Case/spacing-insensitive name key; folds "Last, First" to "first last" so a
   Foundation-style name still matches the roster's "First Last". */
function dprNameKey(s){
  var t = String(s == null ? "" : s).trim();
  var parts = t.indexOf(",") > -1 ? t.split(",") : null;
  if (parts && parts.length === 2) t = parts[1].trim() + " " + parts[0].trim();
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
async function dprFetchDayHours(jobNo, date){
  var r = await fetch("/.netlify/functions/foundation?action=day_hours&job_no=" +
    encodeURIComponent(jobNo) + "&date=" + encodeURIComponent(date), { headers: await authHeaders() });
  var out = null;
  try{ out = await r.json(); }catch(e){}
  if (!r.ok){ var err = new Error((out && out.error) || ("server error " + r.status)); err.status = r.status; throw err; }
  return out;
}
/* Folds the server's rows into {nameKey -> hours}. Two rows for the same person
   (e.g. two cost codes that day) accumulate. Pure — unit-tested directly. */
function dprDayHoursByName(rows){
  var byName = {};
  (rows || []).forEach(function(rw){
    var k = dprNameKey(rw && rw.name);
    if (!k) return;
    var h = Number(rw.hours);
    if (!isFinite(h) || h <= 0) return;
    byName[k] = (byName[k] || 0) + h;
  });
  Object.keys(byName).forEach(function(k){ byName[k] = Math.round(byName[k] * 100) / 100; });
  return byName;
}
/* Decides one crew row's new hours given the punch total for their name.
   Returns the string to set, or null to leave the row alone. Manual wins:
   only an empty value or a previous auto-fill is ever replaced. Pure. */
function dprCrewHoursFillValue(row, punchHours){
  if (punchHours == null) return null;
  var hs = String(punchHours);
  var cur = (row.hours == null ? "" : String(row.hours)).trim();
  if (cur !== "" && row.hoursSource !== "foundation") return null; /* typed by hand — never touch */
  if (cur === hs && row.hoursSource === "foundation") return null; /* already current */
  return hs;
}
async function dprAutofillCrewHours(){
  if (dprIsLocked() || dprDayHoursDenied) return;
  if (typeof fetch !== "function" || typeof authHeaders !== "function") return;
  var jobNo = String(dprState.foundationJobNo || val("dpr-jobNo") || "").trim();
  var date = (val("dpr-date") || "").trim();
  if (!jobNo || !date) return;
  if (!dprCrew.some(function(c){ return (c.name || "").trim(); })) return;
  var key = jobNo + "|" + date;
  var entry = dprDayHoursCache[key];
  if (entry === undefined){
    try{
      var data = await dprFetchDayHours(jobNo, date);
      entry = dprDayHoursCache[key] = { byName: dprDayHoursByName(data && data.rows) };
    }catch(e){
      if (e && (e.status === 401 || e.status === 403)) dprDayHoursDenied = true;
      else dprDayHoursCache[key] = null; /* transient/unknown — don't hammer this pair */
      return;
    }
    /* The job/date may have moved on while the fetch was in flight — the
       result is cached for later, but don't apply it to the wrong report. */
    var nowJob = String(dprState.foundationJobNo || val("dpr-jobNo") || "").trim();
    if (nowJob + "|" + (val("dpr-date") || "").trim() !== key) return;
  }
  if (!entry) return;
  var changed = false;
  dprCrew.forEach(function(c){
    if (!(c.name || "").trim()) return;
    var fill = dprCrewHoursFillValue(c, entry.byName[dprNameKey(c.name)]);
    if (fill == null) return;
    c.hours = fill;
    c.hoursSource = "foundation";
    changed = true;
  });
  if (changed) dprApplyCrewHoursToDom();
}
/* Pushes auto-filled hours into the already-rendered rows IN PLACE (value +
   ⏱ badge) rather than re-rendering — a full innerHTML swap would steal focus
   from a foreman mid-typing in another row. */
function dprApplyCrewHoursToDom(){
  var host = document.getElementById("dpr-crew-list");
  if (host){
    dprCrew.forEach(function(c, i){
      var inp = host.querySelector('[data-dprcrewhrs="' + i + '"]');
      if (inp && inp.value !== String(c.hours || "")) inp.value = String(c.hours || "");
      var badge = host.querySelector('[data-dprcrewsrc="' + i + '"]');
      if (badge) badge.style.display = (c.hoursSource === "foundation") ? "" : "none";
    });
  }
  dprRenderCrewTotal();
  dprSyncHours();
}

/* ================= crew + foreman auto-populate from the time clock =========
   Mark: "can't the DPR auto fill the foreman and the crew foundation punches"
   — it can. WHO punched on this job+date comes from `action=day_crew`
   (names/ids only, NEVER hours — gated on dpr.create so foremen get it, not
   just admins; hours stay behind foundation.read via the existing day_hours
   path, which runs right after and fills them in for authorized users).

   AUTO mode (job pick / report load / date change) only populates an EMPTY
   roster — it never surprise-adds rows to a list the foreman is editing, and
   never re-adds someone they deliberately removed. The "⏱ From Time Clock"
   button is the deliberate path: it merges in whoever's missing (nameKey
   match, so "Garcia, Jose" and "Jose Garcia" are one person) and reports
   what it did. Same fail-closed manners as the hours auto-fill: 401/403
   latches quiet for the session, errors leave manual entry untouched, and a
   locked report is never touched. */
var dprDayCrewCache = {};      /* "jobNo|date" -> [names] | null (fetch failed — don't retry) */
var dprDayCrewDenied = false;  /* server said not authorized — stop asking this session */
async function dprFetchDayCrew(jobNo, date){
  var r = await fetch("/.netlify/functions/foundation?action=day_crew&job_no=" +
    encodeURIComponent(jobNo) + "&date=" + encodeURIComponent(date), { headers: await authHeaders() });
  var out = null;
  try{ out = await r.json(); }catch(e){}
  if (!r.ok){ var err = new Error((out && out.error) || ("server error " + r.status)); err.status = r.status; throw err; }
  return out;
}
async function dprPopulateCrewFromPunches(manual){
  if (dprIsLocked()){ if (manual) toast("This report is signed and locked."); return; }
  if (dprDayCrewDenied) return;
  if (typeof fetch !== "function" || typeof authHeaders !== "function") return;
  var jobNo = String(dprState.foundationJobNo || val("dpr-jobNo") || "").trim();
  var date = (val("dpr-date") || "").trim();
  if (!jobNo || !date){
    if (manual) toast("Pick the job (and date) first — the time clock is looked up per job per day.");
    return;
  }
  /* Auto mode respects a roster in progress; the button merges deliberately. */
  var hasNamed = dprCrew.some(function(c){ return (c.name || "").trim(); });
  if (!manual && hasNamed) return;
  var key = jobNo + "|" + date;
  var names = dprDayCrewCache[key];
  if (names === undefined){
    /* Cache the IN-FLIGHT promise, not just the result — several triggers can
       stack (report load + job pick + date change) and must share one fetch. */
    names = dprDayCrewCache[key] = (async function(){
      try{
        var data = await dprFetchDayCrew(jobNo, date);
        return ((data && data.crew) || [])
          .map(function(c){ return (c && c.name ? String(c.name).trim() : ""); })
          .filter(Boolean);
      }catch(e){
        if (e && (e.status === 401 || e.status === 403)) dprDayCrewDenied = true;
        return null; /* failed — settles to a null cache entry, never retried this session */
      }
    })();
  }
  if (names && typeof names.then === "function"){
    names = await names;
    dprDayCrewCache[key] = names; /* settle the cache: promise -> value */
    /* The job/date may have moved on while the fetch was in flight. */
    var nowJob = String(dprState.foundationJobNo || val("dpr-jobNo") || "").trim();
    if (nowJob + "|" + (val("dpr-date") || "").trim() !== key) return;
  }
  if (names === null){
    if (manual) toast("Couldn't reach the time clock — add the crew by hand.");
    return;
  }
  if (!names || !names.length){
    if (manual) toast("No punches on the clock for this job/date yet.");
    return;
  }
  var have = {};
  dprCrew.forEach(function(c){ var k = dprNameKey(c.name); if (k) have[k] = 1; });
  var added = 0;
  names.forEach(function(n){
    var k = dprNameKey(n);
    if (!k || have[k]) return;
    have[k] = 1;
    dprCrew.push({ name: n, hours: "", hoursSource: "" });
    added++;
  });
  if (added){
    dprRenderCrew();
    dprSyncHeadcount();
    dprScheduleCrewHoursAutofill();   /* hours ride in next for foundation.read holders */
  }
  dprAutofillForeman(names);
  if (manual) toast(added ? ("Added " + added + " from the time clock ✓") : "Crew already matches the time clock.");
}
/* Foreman auto-fill: if the field is empty and EXACTLY ONE of the day's
   punchers is on the DPR_FOREMEN roster, that's the foreman — fill it (with
   the roster's canonical spelling). Two roster foremen on one job = ambiguous,
   fill nothing. Never stomps a typed name. */
function dprAutofillForeman(names){
  if ((val("dpr-foreman") || "").trim()) return;
  var foremanByKey = {};
  DPR_FOREMEN.forEach(function(f){ foremanByKey[dprNameKey(f)] = f; });
  var hits = {};
  (names || []).forEach(function(n){
    var k = dprNameKey(n);
    if (foremanByKey[k]) hits[k] = foremanByKey[k];
  });
  var keys = Object.keys(hits);
  if (keys.length === 1) setVal("dpr-foreman", hits[keys[0]]);
}

/* ================= job-to-date labor card (admin-gated, live) =================
   The same "🕒 Labor Hours" card the WO/leak form shows, on the daily: current
   job-to-date hours for the linked job — the server blends the posted record
   with the not-yet-posted punch tail, so it's up to date, not payroll-lagged.
   Same self-gating pattern as fdnRefreshLaborCard (js/foundation.js): the card
   renders ONLY if the hours fetch comes back authorized (foundation.read);
   any 401/403/error hides it, so a non-admin foreman never sees it. Rendering
   is shared via fdnRenderLaborInto — resolved at call time, so script order
   doesn't matter. */
var dprLaborCardJobAtFetch = null;
async function dprRefreshLaborCard(){
  var card = document.getElementById("dpr-foundation-labor-card");
  var body = document.getElementById("dpr-foundation-labor-body");
  if (!card) return;
  var jobNo = String(dprState.foundationJobNo || val("dpr-jobNo") || "").trim();
  if (!jobNo || typeof fdnFetchHours !== "function" || typeof fdnRenderLaborInto !== "function"){
    card.style.display = "none";
    return;
  }
  if (body) body.innerHTML = "Loading…";
  card.style.display = "";
  dprLaborCardJobAtFetch = jobNo;
  try{
    var data = await fdnFetchHours(jobNo);
    if (dprLaborCardJobAtFetch !== jobNo) return; /* a newer job superseded this fetch */
    fdnRenderLaborInto(body, data);
  }catch(e){
    /* Not authorized or no hours path — hide entirely (fail closed on display;
       the server is the real gate). */
    if (dprLaborCardJobAtFetch === jobNo) card.style.display = "none";
  }
}

/* ================= day's weather at the job (Open-Meteo, free, no key) =====
   Auto-pulls the report day's weather for the JOB'S location and saves it
   with the DPR, so every daily carries a record of that day's conditions —
   temp high/low, conditions, max wind, precipitation. Coordinates come from
   the existing resolver dprResolveJobCenter() (photo GPS → traced centroid →
   cached building geocode → address geocode) — no new location plumbing.

   Never blocks the report: if coordinates can't be resolved or Open-Meteo is
   unreachable, a subtle "weather unavailable" note shows and everything else
   proceeds. Fetches are cached per (rounded coord, date) so switching fields
   doesn't hammer the API. A snapshot already SAVED on the report for the same
   date is trusted over a refetch (it's the record of the day), and a locked
   report never refetches. */
var dprWeatherCache = {};    /* "lat,lng|date" -> weather object | null (fetch failed — don't retry) */
var dprWeatherFetchSeq = 0;  /* guards a slow fetch against a newer job/date selection */

/* WMO weather-code → human label + glyph (Open-Meteo returns WMO codes). */
var DPR_WMO_CODES = {
  0: ["Clear", "☀️"], 1: ["Mainly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Freezing fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌦️"],
  56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌧️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "🌨️"], 77: ["Snow grains", "🌨️"],
  80: ["Rain showers", "🌦️"], 81: ["Rain showers", "🌦️"], 82: ["Violent rain showers", "🌧️"],
  85: ["Snow showers", "🌨️"], 86: ["Snow showers", "🌨️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm w/ hail", "⛈️"], 99: ["Thunderstorm w/ hail", "⛈️"]
};
function dprWeatherLabel(code){
  var e = DPR_WMO_CODES[code];
  return e ? { label: e[0], icon: e[1] } : { label: "", icon: "" };
}
/* Maps one Open-Meteo daily-forecast response to the snapshot we save. Pure —
   unit-tested directly. Returns null if the response has no usable day. */
function dprWeatherFromApi(body, dateStr){
  try{
    var d = body && body.daily;
    if (!d || !d.time || !d.time.length) return null;
    var i = d.time.indexOf(dateStr);
    if (i === -1) i = 0;
    var num = function(v){ var n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : null; };
    var code = (d.weather_code || [])[i];
    var lbl = dprWeatherLabel(code);
    return {
      date: dateStr,
      source: "open-meteo",
      code: (code == null ? null : Number(code)),
      conditions: lbl.label,
      icon: lbl.icon,
      tempMaxF: num((d.temperature_2m_max || [])[i]),
      tempMinF: num((d.temperature_2m_min || [])[i]),
      windMph: num((d.wind_speed_10m_max || [])[i]),
      precipIn: num((d.precipitation_sum || [])[i])
    };
  }catch(e){ return null; }
}
/* One compact human line — used by the on-form display and the PDF. Pass
   plain=true for the PDF: jsPDF's built-in helvetica can't draw emoji, so the
   glyph is dropped there and the conditions stay as words. */
function dprWeatherSummary(w, plain){
  if (!w) return "";
  var parts = [];
  var cond = plain ? (w.conditions || "") : [w.icon, w.conditions].filter(Boolean).join(" ");
  if (cond) parts.push(cond);
  if (w.tempMaxF != null || w.tempMinF != null){
    parts.push((w.tempMaxF != null ? w.tempMaxF + "°" : "–") + "/" + (w.tempMinF != null ? w.tempMinF + "°" : "–") + "F");
  }
  if (w.windMph != null) parts.push("wind " + w.windMph + " mph");
  if (w.precipIn != null) parts.push("precip " + w.precipIn + " in");
  return parts.join(" · ");
}
async function dprFetchWeather(lat, lng, dateStr){
  var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(4) +
    "&longitude=" + lng.toFixed(4) +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto" +
    "&start_date=" + dateStr + "&end_date=" + dateStr;
  var r = await fetch(url);
  if (!r.ok) throw new Error("weather fetch failed: " + r.status);
  var body = await r.json();
  return dprWeatherFromApi(body, dateStr);
}
function dprRenderWeather(){
  var el = document.getElementById("dpr-weather");
  if (!el) return;
  var w = dprState.weather;
  if (!w){ el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "";
  el.textContent = "Weather that day: " + dprWeatherSummary(w);
}
function dprRenderWeatherUnavailable(){
  var el = document.getElementById("dpr-weather");
  if (!el) return;
  /* Only say "unavailable" when there's nothing saved to show. */
  if (dprState.weather){ dprRenderWeather(); return; }
  el.style.display = "";
  el.textContent = "Weather unavailable for this job/date.";
}
async function dprRefreshWeather(){
  var dateStr = (val("dpr-date") || "").trim();
  var hasJob = !!((val("dpr-jobName") || "").trim() || dprState.buildingId);
  var el = document.getElementById("dpr-weather");
  if (!dateStr || !hasJob){
    if (el && !dprState.weather){ el.style.display = "none"; el.textContent = ""; }
    return;
  }
  /* A saved snapshot for this same date is the day's record — keep it. A
     locked report never refetches at all. */
  if (dprState.weather && dprState.weather.date === dateStr){ dprRenderWeather(); return; }
  if (dprIsLocked()){ dprRenderWeather(); return; }
  if (typeof fetch !== "function") return;
  var seq = ++dprWeatherFetchSeq;
  var center = null;
  try{ center = await dprResolveJobCenter(dprSelectedRoofObj()); }catch(e){}
  if (seq !== dprWeatherFetchSeq) return; /* superseded while resolving */
  if (!center){ dprRenderWeatherUnavailable(); return; }
  var key = center.lat.toFixed(2) + "," + center.lng.toFixed(2) + "|" + dateStr;
  var w = dprWeatherCache[key];
  if (w === undefined){
    try{ w = await dprFetchWeather(center.lat, center.lng, dateStr); }
    catch(e){ w = null; }
    dprWeatherCache[key] = w;
    if (seq !== dprWeatherFetchSeq) return;
  }
  if (!w){ dprRenderWeatherUnavailable(); return; }
  dprState.weather = Object.assign({ lat: Math.round(center.lat * 10000) / 10000, lng: Math.round(center.lng * 10000) / 10000 }, w);
  dprRenderWeather();
}

/* ================= material quantities (Phase-2 gated section) =================
   Repeatable {item, qty, unit} rows, same pattern as the crew roster. Only
   collected when the Quantities toggle is Yes. */
function dprAddQuantityRow(row){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  dprQuantities.push(row || { item: "", qty: "", unit: "" });
  dprRenderQuantities();
}
function dprRemoveQuantityRow(idx){
  if (dprIsLocked()) return;
  dprQuantities.splice(idx, 1);
  dprRenderQuantities();
}
function dprRenderQuantities(){
  var host = document.getElementById("dpr-quantities-list");
  if (!host) return;
  if (!dprQuantities.length){
    host.innerHTML = '<p class="hint">No quantities added yet — e.g. TPO 60mil, 24 squares.</p>';
    return;
  }
  host.innerHTML = dprQuantities.map(function(qr, i){
    return '<div class="btnrow" style="margin:0 0 6px;gap:6px">' +
      '<input type="text" placeholder="Material / item" data-dprqty-item="' + i + '" value="' + esc(qr.item || "") + '" style="flex:2;min-width:120px">' +
      '<input type="number" placeholder="Qty" step="0.01" data-dprqty-qty="' + i + '" value="' + esc(qr.qty || "") + '" style="flex:1;min-width:60px;max-width:110px">' +
      '<input type="text" placeholder="Unit (sq, rolls…)" data-dprqty-unit="' + i + '" value="' + esc(qr.unit || "") + '" style="flex:1;min-width:70px;max-width:130px">' +
      '<button class="btn danger" onclick="dprRemoveQuantityRow(' + i + ')">✕</button>' +
      '</div>';
  }).join("");
  ["item", "qty", "unit"].forEach(function(k){
    host.querySelectorAll("[data-dprqty-" + k + "]").forEach(function(el){
      el.addEventListener("input", function(){ dprQuantities[+el.getAttribute("data-dprqty-" + k)][k] = el.value; });
    });
  });
}

/* ================= rented equipment (gated) + pre-use checklist scaffold =====
   Structured record of RENTED equipment on site that day — SkyTrak/
   telehandler, boom lift, scissor lift, etc. Distinct from the existing
   "Equipment On Site" section, which is a free-text note of any equipment
   USED that day (crane, kettle, welder — owned or otherwise); rentals need
   fields (what, from whom, unit #) because they drive billing and the lift
   safety checklist below. Same repeatable-row pattern as the quantities
   section; same Yes/No gate so the daily stays uncluttered.

   PRE-USE SAFETY CHECKLIST (scaffold): when a rented LIFT is recorded
   (telehandler/boom/scissor/MEWP/forklift — see DPR_RENTED_LIFT_RX), a daily
   pre-use inspection checklist appears. The ITEM LIST is deliberately empty
   for now — a parallel research task is compiling the standard items (OSHA
   1910.178 forklift + ANSI A92 MEWP pre-use inspections); they drop straight
   into DPR_PREUSE_CHECKLIST as {id, label} rows and the section lights up
   with zero further wiring. Until then the checklist stays hidden, but the
   persistence (preUseChecklist on the doc), the lift gate, the PDF block and
   the tests are all live. */
var dprRented = [];   /* [{ type, company, unitId, note }] */
var dprPreUse = null; /* { completedBy, items: [{id, label, ok}] } — saved answers */
var DPR_RENTED_TYPES = ["SkyTrak / Telehandler", "Boom Lift", "Scissor Lift", "Aerial Lift",
  "Forklift", "Crane", "Generator", "Air Compressor", "Welder", "Kettle", "Dumpster", "Other"];
var DPR_RENTED_LIFT_RX = /skytrak|telehandler|boom|scissor|aerial|mewp|man\s*lift|manlift|forklift|lull|genie|jlg/i;
/* Daily pre-use inspection for rented lift equipment — the checklist from
   Mark's researched source list (docs/RoofingSafetyDocumentSources.md §4),
   which combines OSHA 29 CFR 1910.178(q)(7) daily-examination items for the
   telehandler/rough-terrain forklift (SkyTrak, Lull) with ANSI/SAIA A92 MEWP
   pre-use items for the boom/scissor lift. Four phases, in the order a crew
   actually inspects: walk-around engine OFF → operator station → function
   test engine ON → worksite before lifting. Machine-specific items are
   prefixed ("Boom:", "Telehandler:") and read as confirmed/n-a on the other
   machine. Per the source doc: complete for EACH machine, EACH day, before
   first use; any failed item = machine out of service (see the result field
   in dprCollectPreUse). The rented machine's own operator manual remains the
   controlling document.
   IDs are stable — saved reports key answers by id; never reuse or repurpose
   one, append new items to their group instead. */
var DPR_PREUSE_GROUPS = [
  { key: "walk",     label: "A. Walk-around — engine OFF" },
  { key: "station",  label: "B. Operator station & safety devices" },
  { key: "function", label: "C. Function test — engine ON (clear area)" },
  { key: "site",     label: "D. Worksite — before lifting" }
];
var DPR_PREUSE_CHECKLIST = [
  /* A. Walk-around — engine OFF */
  { id: "tires",         group: "walk", label: "Tires/tracks — inflation, cuts, wear; wheel lugs tight" },
  { id: "leaks",         group: "walk", label: "No fluid leaks under machine (oil, hydraulic, fuel, coolant)" },
  { id: "fluids",        group: "walk", label: "Fluid levels OK (engine oil, hydraulic, coolant, fuel); battery secure/charged" },
  { id: "hoses",         group: "walk", label: "Hoses, cylinders & fittings — no leaks, chafing, or damage" },
  { id: "forks_platform",group: "walk", label: "Forks/carriage or platform/basket — no cracks, bends, or damaged welds" },
  { id: "chains",        group: "walk", label: "Chains, cables & boom wear pads — intact, adjusted, lubricated" },
  { id: "load_chart",    group: "walk", label: "Data/capacity plate & load chart present and legible" },
  { id: "decals",        group: "walk", label: "Decals, warnings & control labels present and readable" },
  { id: "guards",        group: "walk", label: "Guards, covers & counterweight secure — no missing hardware" },
  { id: "anchors",       group: "walk", label: "Seatbelt/restraint/lanyard anchor points present and undamaged" },
  { id: "extinguisher",  group: "walk", label: "Fire extinguisher present & charged (if equipped/required)" },
  { id: "structure",     group: "walk", label: "Overall structure — no cracks, corrosion, or visible damage" },
  /* B. Operator station & safety devices */
  { id: "restraint",     group: "station", label: "Seat & seatbelt (telehandler) / harness anchor & gate (boom) functional" },
  { id: "horn",          group: "station", label: "Horn works" },
  { id: "alarms",        group: "station", label: "Backup alarm & warning lights/beacon work" },
  { id: "gauges",        group: "station", label: "Gauges/indicators & hour meter functional" },
  { id: "access",        group: "station", label: "Steps, grab rails & platform gate/chain secure and clean" },
  { id: "estop",         group: "station", label: "Emergency stop button works" },
  { id: "em_lowering",   group: "station", label: "Boom: emergency lowering / auxiliary power tested and working" },
  { id: "stability_sys", group: "station", label: "Telehandler: load/moment indicator or stability system functional (if equipped)" },
  /* C. Function test — engine ON */
  { id: "starts",        group: "function", label: "Starts normally — no unusual noise, smoke, or vibration" },
  { id: "brakes",        group: "function", label: "Service brakes hold; parking brake holds on a grade" },
  { id: "steering",      group: "function", label: "Steering responds normally (incl. crab/4-wheel modes on telehandler)" },
  { id: "lift_functions",group: "function", label: "Lift, lower, extend, retract — smooth through full range" },
  { id: "outriggers",    group: "function", label: "Tilt / frame level / outriggers or stabilizers deploy and hold" },
  { id: "boom_functions",group: "function", label: "Boom: rotate, articulate, jib & platform level all function; controls return to neutral" },
  { id: "dual_controls", group: "function", label: "Platform controls AND ground controls both work" },
  { id: "drift",         group: "function", label: "No hydraulic drift when holding a raised load/platform" },
  { id: "lights",        group: "function", label: "Lights / work lights operate" },
  /* D. Worksite — before lifting */
  { id: "ground",        group: "site", label: "Ground firm, level & rated for the load — no drop-offs or trenches" },
  { id: "overhead",      group: "site", label: "Overhead clearances checked — power lines (required clearance), structures" },
  { id: "capacity",      group: "site", label: "Load within rated capacity for boom angle/extension (check load chart)" },
  { id: "path",          group: "site", label: "Travel path clear of workers, obstructions & debris" },
  { id: "weather",       group: "site", label: "Weather acceptable — wind within rated limit; no lightning/ice" },
  { id: "tied_off",      group: "site", label: "Fall protection worn & tied off in boom platform per manufacturer" }
];

function dprRentedHasLift(){
  return dprRented.some(function(r){ return DPR_RENTED_LIFT_RX.test(String(r.type || "")); });
}
function dprAddRentedRow(row){
  if (dprIsLocked()){ toast("This report is signed and locked."); return; }
  dprRented.push(row || { type: "", company: "", unitId: "", note: "" });
  dprRenderRented();
}
function dprRemoveRentedRow(idx){
  if (dprIsLocked()) return;
  dprRented.splice(idx, 1);
  dprRenderRented();
}
function dprRenderRented(){
  var host = document.getElementById("dpr-rented-list");
  if (host){
    if (!dprRented.length){
      host.innerHTML = '<p class="hint">Nothing added yet — record each rented machine on site today (lift, telehandler, etc.).</p>';
    } else {
      var locked = dprIsLocked();
      var ro = locked ? " readonly" : "";
      host.innerHTML = dprRented.map(function(r, i){
        return '<div class="btnrow" style="margin:0 0 6px;gap:6px;flex-wrap:wrap">' +
          '<input type="text" placeholder="Equipment (e.g. SkyTrak)" list="dl-dprRentedType" data-dprrent-type="' + i + '" value="' + esc(r.type || "") + '" style="flex:2;min-width:150px"' + ro + '>' +
          '<input type="text" placeholder="Rental company" data-dprrent-company="' + i + '" value="' + esc(r.company || "") + '" style="flex:2;min-width:130px"' + ro + '>' +
          '<input type="text" placeholder="Unit / ID # (optional)" data-dprrent-unitId="' + i + '" value="' + esc(r.unitId || "") + '" style="flex:1;min-width:110px"' + ro + '>' +
          '<input type="text" placeholder="Note" data-dprrent-note="' + i + '" value="' + esc(r.note || "") + '" style="flex:2;min-width:120px"' + ro + '>' +
          '<button class="btn danger" onclick="dprRemoveRentedRow(' + i + ')">✕</button>' +
          '</div>';
      }).join("");
      ["type", "company", "unitId", "note"].forEach(function(k){
        host.querySelectorAll("[data-dprrent-" + k + "]").forEach(function(el){
          el.addEventListener("input", function(){
            dprRented[+el.getAttribute("data-dprrent-" + k)][k] = el.value;
            if (k === "type") dprRenderPreUse();   /* a lift may have appeared/gone */
          });
        });
      });
    }
  }
  dprRenderPreUse();
}
/* The checklist block shows ONLY when a rented lift is recorded AND the item
   list has been populated (see the scaffold note above). */
function dprRenderPreUse(){
  var block = document.getElementById("dpr-preuse-block");
  if (!block) return;
  var show = dprRentedHasLift() && DPR_PREUSE_CHECKLIST.length > 0;
  block.style.display = show ? "" : "none";
  if (!show){ return; }
  var locked = dprIsLocked();
  var saved = {};
  ((dprPreUse && dprPreUse.items) || []).forEach(function(it){ if (it && it.id) saved[it.id] = !!it.ok; });
  var html =
    '<h3 style="margin:14px 0 4px">Daily Pre-Use Safety Checklist (lift equipment)</h3>' +
    '<p class="hint" style="margin:0 0 8px">Complete for each machine, each day, before first use (OSHA 1910.178 / ANSI A92). ' +
    'Any failed item = machine out of service &amp; tagged. The machine’s own operator manual is the controlling document.</p>';
  DPR_PREUSE_GROUPS.forEach(function(g){
    html += '<h4 style="margin:12px 0 4px">' + esc(g.label) + '</h4>' +
      DPR_PREUSE_CHECKLIST.filter(function(it){ return it.group === g.key; }).map(function(it){
        return '<label style="display:flex;gap:8px;align-items:center;margin:0 0 6px">' +
          '<input type="checkbox" data-dprpreuse="' + esc(it.id) + '"' + (saved[it.id] ? " checked" : "") + (locked ? " disabled" : "") + '>' +
          '<span>' + esc(it.label) + '</span></label>';
      }).join("");
  });
  var savedResult = (dprPreUse && dprPreUse.result) || "";
  html +=
    '<div class="fld" style="max-width:320px;margin-top:10px"><label>Result</label>' +
    '<select id="dpr-preuse-result"' + (locked ? " disabled" : "") + '>' +
      '<option value=""' + (savedResult === "" ? " selected" : "") + '>— pick after inspecting —</option>' +
      '<option value="safe"' + (savedResult === "safe" ? " selected" : "") + '>Machine SAFE to operate</option>' +
      '<option value="defects"' + (savedResult === "defects" ? " selected" : "") + '>Defects found — REMOVED from service &amp; tagged</option>' +
    '</select></div>' +
    '<div class="fld"><label>Defects / notes</label>' +
    '<textarea id="dpr-preuse-notes" rows="2"' + (locked ? " readonly" : "") + '>' + esc((dprPreUse && dprPreUse.notes) || "") + '</textarea></div>' +
    '<div class="fld" style="max-width:260px"><label>Checklist completed by (operator)</label>' +
    '<input type="text" id="dpr-preuse-by" list="dl-dprCrew" value="' + esc((dprPreUse && dprPreUse.completedBy) || "") + '"' + (locked ? " readonly" : "") + '></div>';
  block.innerHTML = html;
  block.querySelectorAll("[data-dprpreuse]").forEach(function(el){
    el.addEventListener("change", function(){ dprPreUse = dprCollectPreUse(); });
  });
  ["dpr-preuse-by", "dpr-preuse-notes", "dpr-preuse-result"].forEach(function(id){
    var el = block.querySelector("#" + id);
    if (el) el.addEventListener(id === "dpr-preuse-result" ? "change" : "input", function(){ dprPreUse = dprCollectPreUse(); });
  });
}
/* Reads the checklist UI back into the saved shape. Pure-ish (DOM read). */
function dprCollectPreUse(){
  var block = document.getElementById("dpr-preuse-block");
  if (!block || !DPR_PREUSE_CHECKLIST.length) return dprPreUse || null;
  var byId = {};
  block.querySelectorAll("[data-dprpreuse]").forEach(function(el){
    byId[el.getAttribute("data-dprpreuse")] = !!el.checked;
  });
  var by = block.querySelector("#dpr-preuse-by");
  var res = block.querySelector("#dpr-preuse-result");
  var notes = block.querySelector("#dpr-preuse-notes");
  return {
    completedBy: by ? by.value : ((dprPreUse && dprPreUse.completedBy) || ""),
    result: res ? res.value : ((dprPreUse && dprPreUse.result) || ""),
    notes: notes ? notes.value : ((dprPreUse && dprPreUse.notes) || ""),
    items: DPR_PREUSE_CHECKLIST.map(function(it){ return { id: it.id, label: it.label, ok: !!byId[it.id] }; })
  };
}
/* What collect() persists: the current checklist state when the section is
   live; a previously SAVED checklist rides through untouched when the item
   list is empty (scaffold phase) so a re-save can't erase a filled one. */
function dprPreUseForSave(rentedRows){
  if (!rentedRows || !rentedRows.length) return null;
  if (DPR_PREUSE_CHECKLIST.length && dprRentedHasLift()) return dprCollectPreUse();
  return dprPreUse || null;
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
  /* Rented rows once, so the checklist decision sees the same filtered set. */
  var rentedRows = dprToggleIsYes("dpr-rented-toggle")
    ? dprRented
        .filter(function(r){ return [r.type, r.company, r.unitId, r.note].some(function(v){ return String(v || "").trim(); }); })
        .map(function(r){ return {
          type: String(r.type || "").trim(), company: String(r.company || "").trim(),
          unitId: String(r.unitId || "").trim(), note: String(r.note || "").trim()
        }; })
    : null;
  if (rentedRows && !rentedRows.length) rentedRows = null;
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
    crew: dprCrew.filter(function(c){ return (c.name || "").trim(); }).map(function(c){
      return {
        name: c.name.trim(),
        hours: (c.hours == null ? "" : String(c.hours)).trim(),
        hoursSource: c.hoursSource === "foundation" ? "foundation" : ""
      };
    }),
    crewHoursTotal: dprCrewHoursTotal(),   /* denormalized daily total (sum of crew hours) for lists/exports */
    headcount: val("dpr-headcount"),
    hoursWorked: val("dpr-hours"),
    squares: val("dpr-squares"),
    summary: val("dpr-summary"),
    section: dprState.section || null,   /* the roof area traced for today (progress overlay) */
    signoff: dprState.signoff || null,   /* signature + lock state (see sign-off/lock hooks below) */
    hoursAmendments: dprState.hoursAmendments || null,  /* late-hours amendment trail (nightly sync writes these; carried so the PDF prints them) */
    weather: dprState.weather || null,   /* the day's conditions at the job (Open-Meteo snapshot) */
    /* ---- Phase-2 gated sections: null = toggle on No (nothing to report) ---- */
    delays: dprToggleIsYes("dpr-delays-toggle") ? {
      cause: val("dpr-delays-cause"), hoursLost: val("dpr-delays-hours"), notes: val("dpr-delays-notes")
    } : null,
    quantities: dprToggleIsYes("dpr-quantities-toggle")
      ? dprQuantities
          .filter(function(q){ return (q.item || "").trim() || String(q.qty || "").trim(); })
          .map(function(q){ return { item: (q.item || "").trim(), qty: String(q.qty || "").trim(), unit: (q.unit || "").trim() }; })
      : null,
    jsa: dprToggleIsYes("dpr-jsa-toggle") ? {
      conductedBy: val("dpr-jsa-by"), crewPresent: val("dpr-jsa-crewpresent"), topics: val("dpr-jsa-topics")
    } : null,
    incidents: dprToggleIsYes("dpr-incidents-toggle") ? {
      type: val("dpr-incidents-type"), reportedTo: val("dpr-incidents-reportedto"), description: val("dpr-incidents-desc")
    } : null,
    equipment: dprToggleIsYes("dpr-equipment-toggle") ? { notes: val("dpr-equipment-notes") } : null,
    toolbox: dprToolboxCollect(),   /* toolbox/tailgate talk + crew sign-in (part of the signed daily record) */
    rentedEquipment: rentedRows,                    /* structured rentals (type/company/unit/note) */
    preUseChecklist: dprPreUseForSave(rentedRows),  /* lift pre-use inspection (scaffold — see DPR_PREUSE_CHECKLIST) */
    visitors: dprToggleIsYes("dpr-visitors-toggle") ? { notes: val("dpr-visitors-notes") } : null,
    photos: dprPhotos.slice()
    /* FUTURE gated sections follow the same shape: one dprToggleIsYes(...) line here,
       a card in index.html wired to dprGate(), and a dprSetGate(...) line in dprFill(). */
  };
  return o;
}
function dprToggleIsYes(id){ return val(id) === "Yes"; }
/* Sets a gated section's toggle + shows/hides its body — used by fill()/new(). */
function dprSetGate(toggleId, bodyId, yes){
  setVal(toggleId, yes ? "Yes" : "No");
  dprGate(toggleId, bodyId, "Yes");
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
  dprCrew = (o.crew || []).map(function(c){
    /* Old docs pre-date per-person hours ({name} only) — default them empty. */
    return {
      name: c.name || "",
      hours: (c.hours == null ? "" : String(c.hours)),
      hoursSource: c.hoursSource === "foundation" ? "foundation" : ""
    };
  });
  /* Treat the loaded "Hours Worked" as auto-filled ONLY if it equals the
     loaded crew sum (i.e. it WAS the derived total) — a deliberately
     different hand-typed total (say, drive time on top of roof hours) must
     survive a reopen, not get silently rewritten to the sum. */
  var loadedCrewTotal = dprCrewHoursTotal();
  dprHoursAutoVal = (loadedCrewTotal > 0 && String(o.hoursWorked || "") === String(loadedCrewTotal))
    ? String(o.hoursWorked || "") : "";
  dprPhotos = (o.photos || []).map(function(p){ return Object.assign({}, p); });
  dprState.section = o.section || null;
  dprState.signoff = o.signoff || null;
  dprState.hoursAmendments = (o.hoursAmendments && o.hoursAmendments.length) ? o.hoursAmendments : null;
  dprState.weather = o.weather || null;
  /* ---- Phase-2 gated sections (falsy / "" from Firestore's null-coercion = No) ---- */
  var dl = o.delays || null;
  dprSetGate("dpr-delays-toggle", "dpr-delays-body", !!dl);
  setVal("dpr-delays-cause", dl ? dl.cause : "");
  setVal("dpr-delays-hours", dl ? dl.hoursLost : "");
  setVal("dpr-delays-notes", dl ? dl.notes : "");
  var qt = (o.quantities && o.quantities.length) ? o.quantities : null;
  dprSetGate("dpr-quantities-toggle", "dpr-quantities-body", !!qt);
  dprQuantities = (qt || []).map(function(q){ return { item: q.item || "", qty: q.qty || "", unit: q.unit || "" }; });
  dprRenderQuantities();
  var js = o.jsa || null;
  dprSetGate("dpr-jsa-toggle", "dpr-jsa-body", !!js);
  setVal("dpr-jsa-by", js ? js.conductedBy : "");
  setVal("dpr-jsa-crewpresent", js ? js.crewPresent : "");
  setVal("dpr-jsa-topics", js ? js.topics : "");
  var inc = o.incidents || null;
  dprSetGate("dpr-incidents-toggle", "dpr-incidents-body", !!inc);
  setVal("dpr-incidents-type", inc ? inc.type : "");
  setVal("dpr-incidents-reportedto", inc ? inc.reportedTo : "");
  setVal("dpr-incidents-desc", inc ? inc.description : "");
  var eq = o.equipment || null;
  dprSetGate("dpr-equipment-toggle", "dpr-equipment-body", !!eq);
  setVal("dpr-equipment-notes", eq ? eq.notes : "");
  var re = (o.rentedEquipment && o.rentedEquipment.length) ? o.rentedEquipment : null;
  dprSetGate("dpr-rented-toggle", "dpr-rented-body", !!re);
  dprRented = (re || []).map(function(r){ return {
    type: r.type || "", company: r.company || "", unitId: r.unitId || "", note: r.note || ""
  }; });
  dprPreUse = o.preUseChecklist || null;
  dprRenderRented();
  dprToolboxFill(o);
  var vis = o.visitors || null;
  dprSetGate("dpr-visitors-toggle", "dpr-visitors-body", !!vis);
  setVal("dpr-visitors-notes", vis ? vis.notes : "");
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
  dprSyncHours();                  /* a loaded report's crew hours roll up too */
  dprScheduleCrewHoursAutofill();  /* punches may exist for this job + date */
  dprRefreshLaborCard();           /* job-to-date hours for the linked job (admin) */
  dprPopulateCrewFromPunches(false); /* a fresh (empty-crew) day fills itself from the clock */
  dprRenderWeather();              /* saved snapshot first… */
  dprRefreshWeather();             /* …then fetch only if the day has none yet */
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
  dprHoursAutoVal = "";
  dprJobNoAutoVal = "";
  dprState.foundationJobNo = null;
  dprState.foundationCustomerNo = null;
  dprRenderWeather(); /* dprState.weather is fresh-null — hides the line */
  ["dpr-foreman", "dpr-jobName", "dpr-billTo", "dpr-location", "dpr-jobNo", "dpr-headcount", "dpr-hours", "dpr-squares", "dpr-summary", "dpr-bld-search",
   "dpr-delays-cause", "dpr-delays-hours", "dpr-delays-notes", "dpr-jsa-by", "dpr-jsa-crewpresent", "dpr-jsa-topics",
   "dpr-incidents-type", "dpr-incidents-reportedto", "dpr-incidents-desc", "dpr-equipment-notes", "dpr-visitors-notes",
   "dpr-toolbox-talk"].forEach(function(id){ setVal(id, ""); });
  setVal("dpr-roofSystem", "");
  setVal("dpr-date", dprTodayStr());
  dprRefreshLaborCard(); /* job link + jobNo both cleared now -> hides the labor card */
  /* Gated sections back to No / hidden. */
  dprQuantities = [];
  dprRented = [];
  dprPreUse = null;
  dprToolboxSigned = {};
  dprSetGate("dpr-toolbox-toggle", "dpr-toolbox-body", false);
  dprSetGate("dpr-rented-toggle", "dpr-rented-body", false);
  dprRenderRented();
  dprRenderToolboxSignins();
  dprSetGate("dpr-delays-toggle", "dpr-delays-body", false);
  dprSetGate("dpr-quantities-toggle", "dpr-quantities-body", false);
  dprSetGate("dpr-jsa-toggle", "dpr-jsa-body", false);
  dprSetGate("dpr-incidents-toggle", "dpr-incidents-body", false);
  dprSetGate("dpr-equipment-toggle", "dpr-equipment-body", false);
  dprSetGate("dpr-visitors-toggle", "dpr-visitors-body", false);
  dprRenderQuantities();
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
  dprHideJobSelect();
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
        (r.crewHoursTotal ? ' · ' + esc(String(r.crewHoursTotal)) + ' hrs' : "") +
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
  "dpr-summary", "dpr-bld-search",
  "dpr-delays-hours", "dpr-delays-notes", "dpr-jsa-by", "dpr-jsa-topics",
  "dpr-incidents-reportedto", "dpr-incidents-desc", "dpr-equipment-notes", "dpr-visitors-notes",
  "dpr-toolbox-talk"];
/* <select> has no readOnly — the gated toggles + their dropdowns lock via disabled. */
var DPR_LOCK_DISABLED_SELECTS = ["dpr-delays-toggle", "dpr-quantities-toggle", "dpr-jsa-toggle",
  "dpr-incidents-toggle", "dpr-equipment-toggle", "dpr-rented-toggle", "dpr-toolbox-toggle", "dpr-visitors-toggle",
  "dpr-delays-cause", "dpr-jsa-crewpresent", "dpr-incidents-type", "dpr-roof"];
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
  dprRenderAmendments();
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
  DPR_LOCK_DISABLED_SELECTS.forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
  var capRow = document.getElementById("dpr-capture-row");
  if (capRow && locked) capRow.style.display = "none";
  else if (capRow && dprCanCreate()) capRow.style.display = "";
  dprRenderToolboxSignins(); /* re-render so the sign-in checkboxes lock too */
}
/* Visible amendment note — a signed report whose hours were corrected by the
   nightly late-punch sync says so, and when, so the finalized record is never
   silently changed (Mark's AMEND decision; the signature stays intact). Shown
   whether or not the report is locked. */
function dprRenderAmendments(){
  var el = document.getElementById("dpr-amend-note");
  if (!el) return;
  var list = dprState.hoursAmendments || [];
  if (!list.length){ el.style.display = "none"; el.textContent = ""; return; }
  var latest = list[list.length - 1];
  el.style.display = "";
  el.textContent = "✎ " + (latest.note || "Hours amended — late Foundation timecard entries") +
    (list.length > 1 ? " (" + list.length + " amendments)" : "");
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
    ["Job No.", o.jobNo], ["Roof System", o.roofSystem], ["Date", o.date], ["Foreman", o.foreman],
    ["Weather", dprWeatherSummary(o.weather, true)]   /* the day's saved snapshot (plain: no emoji in helvetica) */
  ]);

  heading("Crew & Production");
  /* With per-person hours on the roster, each crew member prints with what
     they worked that day; without any (older reports), the flat name list. */
  var crewRows = (o.crew || []).filter(function(c){ return c && c.name; });
  var anyCrewHours = crewRows.some(function(c){ return String(c.hours || "").trim() !== ""; });
  var crewCell = anyCrewHours
    ? crewRows.map(function(c){
        var h = String(c.hours || "").trim();
        return c.name + (h ? " — " + h + " hrs" : "");
      }).join("\n")
    : crewRows.map(function(c){ return c.name; }).join(", ");
  kvTable([
    ["Crew On Site", crewCell],
    ["Headcount", o.headcount],
    ["Total Crew Hours", anyCrewHours && o.crewHoursTotal ? String(o.crewHoursTotal) : ""],
    ["Hours Worked", o.hoursWorked], ["Approx. Squares Applied", o.squares],
    ["Roof Section Traced", o.section ? (o.section.areaSqFt ? "Yes · ~" + o.section.areaSqFt + " sq ft" : "Yes") : ""]
  ]);
  /* Late-hours amendment trail on the record itself — so a signed PDF that was
     corrected by the nightly sync carries the note, in order. */
  if (o.hoursAmendments && o.hoursAmendments.length){
    kvTable(o.hoursAmendments.map(function(a){
      var when = a && a.at ? new Date(a.at).toLocaleDateString() : "";
      return ["Hours Amendment", (a && a.note ? a.note : "Late Foundation timecard entries") + (when ? " (" + when + ")" : "")];
    }));
  }

  /* Phase-2 gated sections — only the ones the foreman flipped to Yes print. */
  if (o.delays){
    heading("Delays");
    kvTable([["Cause", o.delays.cause], ["Hours Lost", o.delays.hoursLost]]);
    if (o.delays.notes && o.delays.notes.trim()) wrapped(o.delays.notes);
  }
  if (o.quantities && o.quantities.length){
    heading("Material Quantities");
    kvTable(o.quantities.map(function(q){
      return [q.item || "(item)", [q.qty, q.unit].filter(Boolean).join(" ")];
    }));
  }
  if (o.jsa){
    heading("Job Safety Analysis (JSA)");
    kvTable([["Conducted By", o.jsa.conductedBy], ["All Crew Present", o.jsa.crewPresent]]);
    if (o.jsa.topics && o.jsa.topics.trim()) wrapped(o.jsa.topics);
  }
  if (o.incidents){
    heading("Incidents / Near Misses");
    kvTable([["Type", o.incidents.type], ["Reported To", o.incidents.reportedTo]]);
    if (o.incidents.description && o.incidents.description.trim()) wrapped(o.incidents.description);
  }
  if (o.equipment && o.equipment.notes && o.equipment.notes.trim()){
    heading("Equipment On Site");
    wrapped(o.equipment.notes);
  }
  if (o.rentedEquipment && o.rentedEquipment.length){
    heading("Rented Equipment");
    kvTable(o.rentedEquipment.map(function(r){
      return [r.type || "(item)", [r.company, r.unitId ? "Unit " + r.unitId : "", r.note].filter(Boolean).join(" · ")];
    }));
    var pc = o.preUseChecklist;
    if (pc && pc.items && pc.items.length){
      heading("Pre-Use Safety Checklist (lift equipment)");
      kvTable(pc.items.map(function(it){ return [it.label, it.ok ? "Pass" : "NOT CHECKED"]; })
        .concat([[
          "Result",
          pc.result === "safe" ? "Machine SAFE to operate"
            : pc.result === "defects" ? "DEFECTS FOUND - removed from service & tagged" : ""
        ]])
        .concat(pc.notes ? [["Defects / Notes", pc.notes]] : [])
        .concat(pc.completedBy ? [["Completed By (operator)", pc.completedBy]] : []));
    }
  }
  if (o.toolbox && (o.toolbox.talk || (o.toolbox.signedBy && o.toolbox.signedBy.length))){
    heading("Toolbox Talk");
    var tbSigned = (o.toolbox.signedBy || []).filter(Boolean);
    kvTable([
      ["Talk Given", o.toolbox.talk || ""],
      ["Crew Signed In", tbSigned.length ? String(tbSigned.length) + " — " + tbSigned.join(", ") : "None recorded"]
    ]);
  }
  if (o.visitors && o.visitors.notes && o.visitors.notes.trim()){
    heading("Site Visitors");
    wrapped(o.visitors.notes);
  }

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
