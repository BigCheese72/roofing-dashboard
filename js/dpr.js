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

/* Roles allowed to CREATE/SUBMIT a DPR. Display/UX gate only — the real
   enforcement is the daily_progress_reports Firestore rules (dpr.create
   permission, resolved server-side from the live roles doc). Mirrors the
   SEED_ROLES grants for dpr.create in netlify/functions/lib/permissions.js;
   owner always passes. Kept as a small explicit list here for the same reason
   recomputeIsAdmin() hardcodes owner/admin: the client only has the tiny
   {owner,role} claim, never the full permission grid. */
var DPR_CREATE_ROLES = ["admin", "service_manager", "superintendent", "ops_manager", "project_manager", "field_tech"];

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
  dprEnsureListeners();
  dprRenderCrew();
  dprRenderPhotos();
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
  if (!matches.length){ host.innerHTML = '<p class="hint">No matching buildings — type the job details in directly below.</p>'; return; }
  host.innerHTML = matches.map(function(b){
    return '<div class="bld-item" onclick="dprPickBuilding(\'' + esc(b.id) + '\')"><div class="info">' +
      '<div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta">' + esc(b.customerName || "") + (b.location ? ' · ' + esc(b.location) : "") +
      (b.roofSystem ? ' · ' + esc(b.roofSystem) : "") + '</div></div>' +
      '<button class="btn">Select</button></div>';
  }).join("");
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
      /* No report yet for this day — fresh, keyed but unsaved. */
      dprState.id = null;
      dprState.continuedExisting = false;
      if (notice) notice.style.display = "none";
    }
  }catch(e){ if (notice) notice.style.display = "none"; }
}

/* ================= crew roster + headcount ================= */
function dprAddCrewRow(name){
  dprCrew.push({ name: name || "" });
  dprRenderCrew();
  dprSyncHeadcount();
}
function dprRemoveCrewRow(idx){
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
        'list="dl-technician" style="flex:1;min-width:140px">' +
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
  dprPhotos.splice(idx, 1);
  dprRenderPhotos();
}
function dprMovePhoto(idx, dir){
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
    jobName: val("dpr-jobName"),
    billTo: val("dpr-billTo"),
    location: val("dpr-location"),
    jobNo: val("dpr-jobNo"),          /* manual for now; Foundation auto-fill is a LATER phase (hook only) */
    roofSystem: val("dpr-roofSystem"),
    crew: dprCrew.filter(function(c){ return (c.name || "").trim(); }).map(function(c){ return { name: c.name.trim() }; }),
    headcount: val("dpr-headcount"),
    hoursWorked: val("dpr-hours"),
    squares: val("dpr-squares"),
    summary: val("dpr-summary"),
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
  setVal("dpr-jobName", o.jobName || "");
  setVal("dpr-billTo", o.billTo || "");
  setVal("dpr-location", o.location || "");
  setVal("dpr-jobNo", o.jobNo || "");
  setVal("dpr-roofSystem", o.roofSystem || "");
  setVal("dpr-date", o.date || dprTodayStr());
  setVal("dpr-headcount", o.headcount || "");
  setVal("dpr-hours", o.hoursWorked || "");
  setVal("dpr-squares", o.squares || "");
  setVal("dpr-summary", o.summary || "");
  dprHeadcountAutoVal = String(o.headcount || "");
  dprCrew = (o.crew || []).map(function(c){ return { name: c.name || "" }; });
  dprPhotos = (o.photos || []).map(function(p){ return Object.assign({}, p); });
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
}

/* ================= new / reset ================= */
function dprNewReport(){
  if (dprHasContent() && !confirm("Start a new daily progress report? Anything not saved will be lost.")) return;
  dprState = { id: null, buildingId: null, roofs: [], continuedExisting: false };
  dprCrew = [];
  dprPhotos = [];
  dprHeadcountAutoVal = "";
  ["dpr-jobName", "dpr-billTo", "dpr-location", "dpr-jobNo", "dpr-headcount", "dpr-hours", "dpr-squares", "dpr-summary", "dpr-bld-search"].forEach(function(id){ setVal(id, ""); });
  setVal("dpr-roofSystem", "");
  setVal("dpr-date", dprTodayStr());
  var notice = document.getElementById("dpr-continue-notice");
  if (notice) notice.style.display = "none";
  dprRenderRoofPicker();
  dprRenderCrew();
  dprRenderPhotos();
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
  panel.style.display = "";
  host.innerHTML = '<p class="hint">Loading…</p>';
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
        (r.headcount ? ' · ' + esc(String(r.headcount)) + ' crew' : "") +
        (r.squares ? ' · ' + esc(String(r.squares)) + ' sq' : "") +
        (r.photoCount ? ' · ' + esc(String(r.photoCount)) + ' 📷' : "") + '</div></div>' +
        '<button class="btn">Open</button></div>';
    }).join("");
  }catch(e){ host.innerHTML = '<p class="hint">Couldn\'t load history: ' + esc(e.message) + '</p>'; }
}
function dprHideHistory(){
  var panel = document.getElementById("dpr-history-panel");
  if (panel) panel.style.display = "none";
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
    ["Job No.", o.jobNo], ["Roof System", o.roofSystem], ["Date", o.date]
  ]);

  heading("Crew & Production");
  kvTable([
    ["Crew On Site", (o.crew || []).map(function(c){ return c.name; }).filter(Boolean).join(", ")],
    ["Headcount", o.headcount], ["Hours Worked", o.hoursWorked], ["Approx. Squares Applied", o.squares]
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
