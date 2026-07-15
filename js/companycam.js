"use strict";
/* ================= CompanyCam import ================= */
var ccSelected = {};
/* findingId (optional) -- set when opened from a finding's own "Import from
   CompanyCam" button (see findingPhotoGalleryHtml()), so ccImport() below
   knows to attach every imported photo to that finding, same as camera/
   library captures already do. Opened from the global section (Repair
   only now — see onWoTypeChange()) leaves this null, same as before. */
var ccTargetFindingId = null;
function openCC(findingId){
  ccTargetFindingId = findingId || null;
  document.getElementById("cc-modal").style.display = "";
  ccShowProjects("");
}
function closeCC(){
  document.getElementById("cc-modal").style.display = "none";
  ccSelected = {};
  ccTargetFindingId = null;
}
/* ccApi()/ccApiPost() are the ONLY two places this app talks to
   netlify/functions/companycam.js -- every CompanyCam action (projects,
   project_detail, photos, image, upload_document) funnels through one of
   them, which is why attaching the token here covers every call site.

   As of 2026-07-13 companycam.js REQUIRES a verified Firebase ID token on
   every action and 401s without one (it was previously wide open to the
   internet -- project names, customer addresses, jobsite photos, and
   document upload into Mark's account, all on the server's own CompanyCam
   token). authHeaders() (js/core.js -- loaded before this file) attaches it
   as `Authorization: Bearer <token>` via getIdToken(), which auto-refreshes
   the ~1hr-lived token, so a tech with a tab open all day never sees a
   spurious 401. Note ccApi() is a GET and previously sent no headers at all;
   it sends the Authorization header now. The Content-Type authHeaders() also
   sets is harmless on a bodyless GET. */
async function ccApi(params){
  var qs = Object.keys(params).map(function(k){ return k + "=" + encodeURIComponent(params[k]); }).join("&");
  var r = await fetch("/.netlify/functions/companycam?" + qs, {
    headers: await authHeaders()
  });
  var out = null;
  try{ out = await r.json(); }catch(e){}
  if (!r.ok || !out) throw new Error((out && out.error) || ("server error " + r.status));
  return out;
}
async function ccApiPost(body){
  var r = await fetch("/.netlify/functions/companycam", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body)
  });
  var out = null;
  try{ out = await r.json(); }catch(e){}
  if (!r.ok || !out) throw new Error((out && out.error) || ("server error " + r.status));
  return out;
}
/* "Undo push" -- removes a photo THIS app pushed into the linked CompanyCam
   project's feed (CompanyCam's UI won't let a user delete an integration-owned
   photo, but our token can). The photo stays on the work order; only the copy
   in the CompanyCam feed is removed. Admin/owner only, and the server can only
   ever delete an id we ourselves stored (ccFeedPhotoId) -- see
   deletePushedPhotoFromCompanyCam(). Mark-triggered; never automatic. */
async function removePushedPhotoFromCC(i){
  if (!isAdmin){ toast("Admin required to remove a CompanyCam photo."); return; }
  var p = photos[i];
  if (!p || !p.ccFeedPhotoId){ toast("That photo isn't in the CompanyCam feed."); return; }
  if (!currentId){ toast("Save the work order first, then remove."); return; }
  if (!confirm("Remove this photo from the CompanyCam project feed?\n\nIt stays on the work order — only the copy the app pushed to CompanyCam is removed.")) return;
  toast("Removing from CompanyCam…");
  try{
    var out = await ccApiPost({ action: "remove_pushed_photo", workOrderId: currentId, photoIndex: i, expectedFeedPhotoId: p.ccFeedPhotoId });
    if (out && out.ok){
      p.ccFeedPhotoId = null;
      if (typeof renderPhotos === "function") renderPhotos();
      toast("Removed from CompanyCam ✓" + (out.alreadyGone ? " (was already gone)" : ""));
    } else if (out && out.skipped){
      toast(out.reason === "feed_id_mismatch" ? "Photo list changed since it was pushed — save and try again." : "Nothing to remove for that photo.");
    } else {
      toast("Couldn't remove that photo from CompanyCam.");
    }
  }catch(e){ toast("Couldn't remove from CompanyCam: " + e.message); }
}
async function removeAllPushedPhotosFromCC(){
  if (!isAdmin){ toast("Admin required."); return; }
  if (!currentId){ toast("Save the work order first, then remove."); return; }
  var pushed = [];
  (photos || []).forEach(function(p, i){ if (p && p.ccFeedPhotoId) pushed.push({ p: p, i: i }); });
  if (!pushed.length){ toast("No app-pushed photos to remove from CompanyCam."); return; }
  if (!confirm("Remove all " + pushed.length + " app-pushed photo" + (pushed.length === 1 ? "" : "s") +
    " from this work order's CompanyCam feed?\n\nThey stay on the work order.")) return;
  var removed = 0, failed = 0;
  for (var k = 0; k < pushed.length; k++){
    toast("Removing " + (k + 1) + " of " + pushed.length + " from CompanyCam…");
    try{
      var out = await ccApiPost({ action: "remove_pushed_photo", workOrderId: currentId, photoIndex: pushed[k].i, expectedFeedPhotoId: pushed[k].p.ccFeedPhotoId });
      if (out && out.ok){ pushed[k].p.ccFeedPhotoId = null; removed++; } else { failed++; }
    }catch(e){ failed++; }
  }
  if (typeof renderPhotos === "function") renderPhotos();
  toast(removed + " removed from CompanyCam ✓" + (failed ? ", " + failed + " couldn't be removed" : "") + ".");
}
/* Pulls CompanyCam project metadata + photo metadata (ids/urls/timestamps only —
   never re-downloads full images) and stores it in Firestore so this building's
   CompanyCam project history survives even if photos are later removed from
   the work order itself. CompanyCam's API does not expose a general activity
   log, so this is limited to project + photo/document metadata. */
async function syncCompanyCamHistory(opts){
  opts = opts || {};
  if (!ccLinkedProjectId){
    if (!opts.quiet) toast("No CompanyCam project linked yet — open a project and import at least one photo first.");
    return { ok: false, skipped: true };
  }
  if (!fdb){
    if (!opts.quiet) toast("Cloud not available — can't sync CompanyCam history without internet.");
    return { ok: false, skipped: true };
  }
  if (!opts.quiet) toast("Syncing CompanyCam history…");
  try{
    var detail = null;
    try{ detail = (await ccApi({ action:"project_detail", project_id: ccLinkedProjectId })).project; }catch(e){}
    var allPhotos = [];
    var page = 1;
    while (page <= 20){ /* safety cap ~600 photos per sync */
      var out = await ccApi({ action:"photos", project_id: ccLinkedProjectId, page: page });
      var ph = out.photos || [];
      allPhotos = allPhotos.concat(ph);
      if (ph.length < 30) break;
      page++;
    }
    await fdb.collection("companycam_projects").doc(ccLinkedProjectId).set({
      id: ccLinkedProjectId,
      name: (detail && detail.name) || ccLinkedProjectName || "",
      address: (detail && detail.address) || "",
      photoCount: allPhotos.length,
      photos: allPhotos.slice(0, 500).map(function(p){
        return { id: p.id, thumb: p.thumb, full: p.full, captured_at: p.captured_at };
      }),
      lastSyncedAt: Date.now()
    }, { merge: true });
    var ids = await ensureCustomerAndBuilding(collect());
    if (ids.buildingId){
      await fdb.collection("buildings").doc(ids.buildingId).set({
        companyCamProjectId: ccLinkedProjectId,
        companyCamLastSyncedAt: Date.now()
      }, { merge: true });
    }
    if (!opts.quiet) toast("Synced " + allPhotos.length + " CompanyCam photo record(s) ✓");
    return { ok: true, photoCount: allPhotos.length };
  }catch(e){
    if (!opts.quiet) toast("CompanyCam sync failed: " + e.message);
    return { ok: false, error: e.message };
  }
}
function ccShowProjects(q){
  document.getElementById("cc-title").textContent = "Import from CompanyCam";
  var b = document.getElementById("cc-body");
  b.innerHTML =
    '<div style="display:flex;gap:8px;margin-bottom:10px">' +
    '<input type="text" id="cc-search" placeholder="Search projects (job name, address\u2026)" style="flex:1" value="' + esc(q) + '">' +
    '<button class="btn primary" onclick="ccDoSearch()">Search</button></div>' +
    '<div id="cc-list" class="hint">Loading recent projects\u2026</div>';
  var inp = document.getElementById("cc-search");
  inp.addEventListener("keydown", function(e){ if (e.key === "Enter") ccDoSearch(); });
  ccLoadProjects(q);
}
function ccDoSearch(){
  var q = document.getElementById("cc-search") ? document.getElementById("cc-search").value : "";
  ccLoadProjects(q);
}
async function applyCompanyCamProjectDetail(id){
  try{
    var out = await ccApi({ action:"project_detail", project_id: id });
    var project = out.project || {};
    if (ccLinkedProjectId !== id) return;
    if (project.name){
      ccLinkedProjectName = project.name;
      var title = document.getElementById("cc-title");
      if (title) title.textContent = project.name;
    }
    /* jobName IS the building-identity field in this form — there is no
       separate "Building Name" input. ensureCustomerAndBuilding() sets
       buildings.name straight from o.jobName, so filling jobName here
       from the CompanyCam project's name is exactly "populate the
       building name from CompanyCam," not a generic job-title fill.
       Upgrades a short/partial Job Name / Location (e.g. typed before the
       CompanyCam project was linked, or filled in by the building picker
       from a shorter/older record) to the project's fuller name/address.
       Only overwrites when the current text is empty or is already
       contained in the fuller CompanyCam value, so a technician's — or
       the building picker's — deliberately different entry is never
       silently clobbered. Same rule on both fields, and the same rule
       openBuildingPicker() relies on to avoid a later CompanyCam link
       fighting an explicit building pick. "(unnamed project)" is
       mapProject()'s own fallback for a nameless CompanyCam project —
       never worth filling Job Name with that literal string. */
    var filled = [];
    var curJobName = (val("jobName") || "").trim();
    if (project.name && project.name !== "(unnamed project)" &&
      (!curJobName || project.name.toLowerCase().indexOf(curJobName.toLowerCase()) !== -1)){
      setVal("jobName", project.name);
      filled.push("Job Name");
    }
    var curLoc = (val("location") || "").trim();
    if (project.address && (!curLoc || project.address.toLowerCase().indexOf(curLoc.toLowerCase()) !== -1)){
      setVal("location", project.address);
      filled.push("Location");
    }
    if (filled.length) toast("CompanyCam " + filled.join(" & ") + " added");
    renderCCLinkInfo();
    return project;
  }catch(e){
    console.warn("CompanyCam project detail failed", e);
    return null;
  }
}
/* Holds the last-loaded project list so folder buttons can look a project
   up by array index instead of having its name interpolated straight into
   an onclick="..." attribute. A project name containing an apostrophe (e.g.
   "St. Mary's Hospital") broke that: the browser HTML-decodes the
   attribute value BEFORE handing it to the JS parser as the inline
   handler's source, so an HTML-escaped &#39; comes back as a literal '
   right where it terminates the JS string early \u2014 the handler then fails
   to parse at all, so tapping the button silently does nothing. Every
   other project (no apostrophe/quote in its name) "worked" because it
   never hit that edge case. Index-based lookup sidesteps the whole
   escaping problem rather than trying to get the encoding exactly right. */
var ccProjectsCache = [];
async function ccLoadProjects(q){
  var list = document.getElementById("cc-list");
  list.className = "hint";
  list.textContent = "Loading\u2026";
  try{
    var out = await ccApi({ action:"projects", q: q || "" });
    var ps = out.projects || [];
    ccProjectsCache = ps;
    if (!ps.length){ list.textContent = "No projects found" + (q ? ' for "' + q + '"' : "") + "."; return; }
    list.className = "";
    list.innerHTML = ps.map(function(p, i){
      return '<button class="cc-proj" onclick="ccOpenProjectAt(' + i + ')">' +
        '<b>' + esc(p.name) + '</b>' +
        (p.address ? '<div class="addr">' + esc(p.address) + '</div>' : '') +
        '</button>';
    }).join("");
  }catch(e){
    list.textContent = "Couldn't load projects: " + e.message;
  }
}
function ccOpenProjectAt(i){
  var p = ccProjectsCache[i];
  if (!p) return;
  ccOpenProject(p.id, p.name);
}
var ccPage = 1, ccProjId = null, ccPhotos = [];
async function ccOpenProject(id, name){
  ccProjId = id; ccPage = 1; ccPhotos = []; ccSelected = {};
  ccLinkedProjectId = id; ccLinkedProjectName = name || "";
  document.getElementById("cc-title").textContent = name || "Project photos";
  applyCompanyCamProjectDetail(id);
  var b = document.getElementById("cc-body");
  b.innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<button class="btn" onclick="ccShowProjects(\'\')">\u2190 Back to projects</button>' +
    '<span class="hint" style="margin:0" id="cc-count">Tap photos to select</span>' +
    '<span style="flex:1"></span>' +
    '<button class="btn primary" onclick="ccImport()">Import Selected</button></div>' +
    '<div class="cc-grid" id="cc-grid"></div>' +
    '<div style="margin-top:10px"><button class="btn" id="cc-more" onclick="ccLoadPhotos()">Load more</button></div>';
  ccLoadPhotos();
}
async function ccLoadPhotos(){
  var grid = document.getElementById("cc-grid");
  var more = document.getElementById("cc-more");
  more.disabled = true; more.textContent = "Loading\u2026";
  try{
    var out = await ccApi({ action:"photos", project_id: ccProjId, page: ccPage });
    var ph = out.photos || [];
    ph.forEach(function(p){
      var i = ccPhotos.length;
      ccPhotos.push(p);
      var d = document.createElement("div");
      d.className = "cc-ph";
      d.id = "ccph-" + i;
      d.innerHTML = '<img src="' + esc(p.thumb) + '" loading="lazy">';
      d.onclick = function(){
        if (ccSelected[i]){ delete ccSelected[i]; d.classList.remove("sel"); }
        else { ccSelected[i] = true; d.classList.add("sel"); }
        var n = Object.keys(ccSelected).length;
        document.getElementById("cc-count").textContent = n ? (n + " selected") : "Tap photos to select";
      };
      grid.appendChild(d);
    });
    ccPage++;
    more.disabled = false;
    more.textContent = ph.length < 30 ? "No more photos" : "Load more";
    if (ph.length < 30) more.disabled = true;
    if (!ccPhotos.length) grid.innerHTML = '<p class="hint">No photos in this project yet.</p>';
  }catch(e){
    more.disabled = false; more.textContent = "Load more";
    toast("Couldn't load photos: " + e.message);
  }
}
function ccCompress(dataUrl){
  return new Promise(function(res, rej){
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
      res({ caption:"", img: c.toDataURL("image/jpeg", preset.q), thumb: makeThumbDataUrl(img), w: w, h: h, finding_id: null });
    };
    img.onerror = function(){ rej(new Error("bad image")); };
    img.src = dataUrl;
  });
}
async function ccImport(){
  var keys = Object.keys(ccSelected);
  if (!keys.length){ toast("Tap the photos you want first."); return; }
  var ok = 0, fail = 0;
  for (var k = 0; k < keys.length; k++){
    var p = ccPhotos[+keys[k]];
    toast("Importing photo " + (k+1) + " of " + keys.length + "\u2026");
    try{
      var out = await ccApi({ action:"image", url: p.full });
      var compressed = await ccCompress(out.dataUrl);
      compressed.ccPhotoId = p.id;
      if (p.gps) compressed.gps = p.gps; /* initial guess for pin placement — see placePin() */
      /* Imported straight into the finding that opened this modal, same as
         a camera/library capture already does (see findingPhotoGalleryHtml()
         above) — attach + auto-pin in one action, not a separate manual
         reassignment afterward. */
      compressed.finding_id = ccTargetFindingId || null;
      photos.push(compressed);
      if (ccTargetFindingId) maybeAutoPinFinding(compressed);
      ok++;
    }catch(e){ fail++; }
  }
  renderPhotos();
  renderFindings();
  if (ccTargetFindingId && inspectionChecklistItemById(ccTargetFindingId)) renderInspectionChecklist();
  renderCCLinkInfo();
  /* Mark: modal was staying open through the whole locking/save/history-sync
     tail below (several more awaited round-trips) after he'd already tapped
     Import Selected -- looked stuck/unresponsive. The photos themselves are
     already imported and rendered by this point, so close immediately; the
     rest (project lock, save, CompanyCam history sync) finishes in the
     background with its own toast, same as before, just not gating the
     modal. Read every ccTargetFindingId/ccSelected-dependent value above
     this line -- closeCC() clears both. */
  closeCC();
  if (ok){
    toast("Locking CompanyCam project and syncing history...");
    await applyCompanyCamProjectDetail(ccLinkedProjectId);
    await saveOrder({ quiet: true });
    var syncResult = await syncCompanyCamHistory({ quiet: true });
    var importSummary = "Imported " + ok + " photo" + (ok === 1 ? "" : "s") + " from CompanyCam" +
      (fail ? "; " + fail + " failed" : "") + ". ";
    if (syncResult.ok){
      toast(importSummary + "Project locked, saved, and synced.");
    } else if (syncResult.skipped){
      toast(importSummary + "Project locked and saved; cloud history sync will run when cloud is available.");
    } else {
      toast(importSummary + "Project locked and saved; history sync failed: " + syncResult.error);
    }
  } else {
    toast("No CompanyCam photos were imported" + (fail ? " (" + fail + " failed)" : "") + ".");
  }
}
/* The CompanyCam link banner now has TWO possible hosts, not one:
   #cc-link-info (inside the global Photo Documentation card, where it has
   always lived -- visible for every type EXCEPT Change Order) and
   #cc-link-info-co (inside the Change Order Details card). onWoTypeChange()
   hides the whole global photos card for a Change Order, which took the
   banner AND the "Import from CompanyCam" button down with it -- that card
   was the ONLY CompanyCam entry point a Change Order had (regression from
   cac0f84/88dded9). Rendering into every host that exists, rather than
   moving the element, keeps ONE link and ONE source of truth
   (ccLinkedProjectId) while showing it wherever the current form actually
   displays it. Whichever host sits inside a hidden card simply isn't seen.
   See "Change Order CompanyCam link" in DEV_NOTES.md. */
var CC_LINK_INFO_HOST_IDS = ["cc-link-info", "cc-link-info-co"];
function renderCCLinkInfo(){
  var linkedHtml = !ccLinkedProjectId ? "" :
    '<div class="cc-link">\ud83d\udd17 Locked to CompanyCam project: <b>' + esc(ccLinkedProjectName || ccLinkedProjectId) + '</b>' +
    '<span class="sp"></span><span class="hint" style="margin:0">Photos and history sync automatically.</span>' +
    (isAdmin ? '<button class="btn danger" onclick="unlinkCC()">Unlink (admin)</button>' : '') +
    '</div>';
  CC_LINK_INFO_HOST_IDS.forEach(function(id){
    var host = document.getElementById(id);
    if (!host) return;
    if (ccLinkedProjectId){ host.innerHTML = linkedHtml; return; }
    /* Unlinked: the global host stays empty exactly as before (it sits
       directly under an "Import from CompanyCam" button that already says
       what to do). The Change Order host says it out loud instead, because
       "not linked" is precisely the state that silently skips the PDF push
       -- uploadLinkedPdfToCompanyCam() returns { skipped:true } with no
       linked project, which is exactly the failure Mark could never see. */
    host.innerHTML = (id === "cc-link-info-co") ?
      '<p class="hint" style="margin:8px 0 0">No CompanyCam project linked yet \u2014 the signed PDF will not be saved to CompanyCam until one is.</p>' : "";
  });
}
/* Inherits the building's durable CompanyCam link onto the work order that's
   currently open -- exactly what bpSelectBuilding() already does when a
   building is picked, but WITHOUT requiring the picker at all (a Change Order
   started from the Home tile and typed straight into never touches it).
   buildings/{id}.companyCamProjectId is the durable link; this only ever
   READS it.

   Change Order only, deliberately: every other type still shows the global
   card's own banner and Import button, so nothing about their behavior
   changes. NEVER creates a CompanyCam project -- it can only adopt one that
   already exists on the building (the established rule: link and push only,
   never auto-create from the field). Never clobbers an explicit link made in
   this session either: the !ccLinkedProjectId guard is re-checked after the
   await, so a link made mid-flight still wins. */
async function resolveChangeOrderCompanyCamLink(){
  if (typeof val !== "function" || val("woType") !== "Change Order") return { skipped: true, reason: "not-a-change-order" };
  if (ccLinkedProjectId) return { ok: true, alreadyLinked: true, projectId: ccLinkedProjectId };
  if (!fdb) return { skipped: true, reason: "offline" };
  var buildingId = (typeof currentWorkOrderBuildingId === "function") ? currentWorkOrderBuildingId() : null;
  if (!buildingId) return { skipped: true, reason: "no-building" };
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    if (!snap.exists) return { skipped: true, reason: "no-building-record" };
    var b = snap.data() || {};
    if (!b.companyCamProjectId) return { skipped: true, reason: "building-not-linked" };
    if (ccLinkedProjectId) return { ok: true, alreadyLinked: true, projectId: ccLinkedProjectId };
    ccLinkedProjectId = b.companyCamProjectId;
    ccLinkedProjectName = b.companyCamProjectName || b.name || "";
    renderCCLinkInfo();
    return { ok: true, linked: true, projectId: ccLinkedProjectId };
  }catch(e){
    console.warn("CompanyCam link resolve from building failed", e);
    return { ok: false, error: e.message };
  }
}
function unlinkCC(){
  if (!isAdmin){ toast("Admin mode required to unlink."); return; }
  ccLinkedProjectId = null; ccLinkedProjectName = "";
  renderCCLinkInfo();
  toast("Unlinked CompanyCam project from this work order");
}
