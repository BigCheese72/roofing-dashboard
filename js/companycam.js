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
/* Whether the standalone building-level "Link / Import from CompanyCam" control
   (#wo-cc-link-row) shows for a work-order type. It exists to give the types
   whose per-finding capture HIDES the global import row (Leak, Inspection,
   Warranty) a visible way to link CompanyCam at the building level. Change Order
   has its own control (#cc-link-info-co); Repair keeps the global import row.
   The link itself is building-level regardless of where it's initiated --
   collect() writes companyCamProjectId for every type and it's saved onto the
   building, so all report types for that address inherit it (bpSelectBuilding). */
function ccBuildingLinkControlVisible(woType){
  return woType !== "Change Order" && woType !== "Repair";
}
/* ---- "Open in CompanyCam" deep link (Mark, approved 2026-07-18) ----
   A tech standing on the roof with the work order open should be one tap from
   that job's CompanyCam project, not hunting for it in another app.

   ccam://projects/<id> is CompanyCam's OWN documented mobile deep-link scheme
   (docs.companycam.com/docs/mobile-deep-links). Deliberately NOT paired with a
   guessed https://app.companycam.com/... web fallback: that URL is nowhere in
   CompanyCam's docs, and a link that 404s is worse on a roof than no link.
   See CC-1 on the coordination board -- if Mark confirms the web project URL,
   the fallback is a two-line change here and nowhere else.

   Consequence worth knowing: on a DESKTOP browser with no CompanyCam app
   registered for the scheme, tapping this does nothing visible. The hint text
   next to the button says "app" for exactly that reason. Field devices -- the
   ones that matter for this button -- have the app.

   Shared by the work-order form (renderCCLinkInfo below) and the DPR job
   header (dprRenderJobLink in js/dpr.js) so both surfaces agree on one URL
   shape and one label. */
function ccProjectDeepLink(projectId){
  var id = String(projectId || "").trim();
  if (!id) return null;
  /* Ids come from the CompanyCam API; keep the scheme URL free of anything
     that isn't plainly an id rather than trusting that blindly. */
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return "ccam://projects/" + id;
}
function ccOpenProjectButtonHtml(projectId, opts){
  var href = ccProjectDeepLink(projectId);
  if (!href) return "";
  opts = opts || {};
  return '<a class="btn' + (opts.primary ? ' primary' : '') + '" href="' + esc(href) + '"' +
    ' title="Open this project in the CompanyCam app">📷 Open in CompanyCam</a>';
}
function renderCCLinkInfo(){
  var linkedHtml = !ccLinkedProjectId ? "" :
    '<div class="cc-link">\ud83d\udd17 Locked to CompanyCam project: <b>' + esc(ccLinkedProjectName || ccLinkedProjectId) + '</b>' +
    '<span class="sp"></span><span class="hint" style="margin:0">Photos and history sync automatically.</span>' +
    '<span class="sp"></span>' + ccOpenProjectButtonHtml(ccLinkedProjectId) +
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
   building is picked, but WITHOUT requiring the picker at all (a work order
   started from the Home tile and typed straight into never touches it).
   buildings/{id}.companyCamProjectId is the durable link; this only ever
   READS it.

   ALL work-order types now (audit FIX 3, Mark-approved -- was Change Order
   only): a Leak/Inspection/Repair/Warranty WO on an already-linked building
   used to silently stay unlinked unless the tech went through the picker,
   exactly the "link follows the job" gap. NEVER creates a CompanyCam
   project -- it can only adopt one that already exists on the building (the
   established rule: link and push only, never auto-create from the field).
   Never clobbers an explicit link made in this session either: the
   !ccLinkedProjectId guard is re-checked after the await, so a link made
   mid-flight still wins. */
async function resolveBuildingCompanyCamLink(){
  if (ccLinkedProjectId) return { ok: true, alreadyLinked: true, projectId: ccLinkedProjectId };
  if (!fdb) return { skipped: true, reason: "offline" };
  var buildingId = (typeof currentWorkOrderBuildingId === "function") ? currentWorkOrderBuildingId() : null;
  if (!buildingId) return { skipped: true, reason: "no-building" };
  /* If the tech switches to a DIFFERENT order while the building read is in
     flight, the stale result must not link the wrong work order. */
  var orderAtStart = (typeof currentId !== "undefined") ? currentId : null;
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    if (!snap.exists) return { skipped: true, reason: "no-building-record" };
    var b = snap.data() || {};
    if (!b.companyCamProjectId) return { skipped: true, reason: "building-not-linked" };
    if (ccLinkedProjectId) return { ok: true, alreadyLinked: true, projectId: ccLinkedProjectId };
    if ((((typeof currentId !== "undefined") ? currentId : null)) !== orderAtStart) return { skipped: true, reason: "order-changed" };
    ccLinkedProjectId = b.companyCamProjectId;
    ccLinkedProjectName = b.companyCamProjectName || b.name || "";
    renderCCLinkInfo();
    return { ok: true, linked: true, projectId: ccLinkedProjectId };
  }catch(e){
    console.warn("CompanyCam link resolve from building failed", e);
    return { ok: false, error: e.message };
  }
}
/* Debounced entry point for the passive triggers (fill() on load; future
   field-edit hooks) so rapid changes coalesce into one Firestore read. The
   export path awaits resolveBuildingCompanyCamLink() directly instead — a
   PDF push needs the answer NOW, not 800ms later. */
var ccResolveTimer = null;
function scheduleResolveBuildingCCLink(){
  if (ccResolveTimer) clearTimeout(ccResolveTimer);
  ccResolveTimer = setTimeout(function(){ resolveBuildingCompanyCamLink(); }, 800);
}
async function unlinkCC(){
  if (!isAdmin){ toast("Admin mode required to unlink."); return; }
  var oldId = ccLinkedProjectId;
  ccLinkedProjectId = null; ccLinkedProjectName = "";
  renderCCLinkInfo();
  toast("Unlinked CompanyCam project from this work order");
  /* Audit FIX 3b: unlink used to be work-order-local only, while
     ensureCustomerAndBuilding() is ADD-only on the building doc — a
     building-level link literally could not be removed from the app.
     Offer (confirm-gated; admin already required above) to clear the
     building's own link too when it still matches what was just unlinked.
     Known limit (flagged in the PR): another saved WO still carrying this
     project id re-stamps it on ITS next save via the add-only patch — a
     full scrub across old WOs is a fast-follow, not tonight. */
  if (!fdb || !oldId) return;
  var buildingId = (typeof currentWorkOrderBuildingId === "function") ? currentWorkOrderBuildingId() : null;
  if (!buildingId) return;
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    if (!snap.exists || (snap.data() || {}).companyCamProjectId !== oldId) return;
    if (!confirm("Also unlink CompanyCam from the BUILDING itself?\n\nOK — future work orders for this building stop inheriting this project.\nCancel — only this work order is unlinked; the building keeps the link.")) return;
    await fdb.collection("buildings").doc(buildingId).set(
      { companyCamProjectId: null, companyCamProjectName: "" }, { merge: true });
    toast("Building-level CompanyCam link cleared");
  }catch(e){ console.warn("building-level CompanyCam unlink failed", e); }
}

/* ================= re-link a BUILDING to a CompanyCam project =================
   Mark, field 2026-07-19: a building linked to the wrong CompanyCam project --
   or to one showing as "(unnamed project)" -- had no in-app fix. Building
   History's "Move to Different Building" re-points a ROOF at a different
   RoofOps building, which is a different axis entirely; nothing re-pointed the
   BUILDING at a different CompanyCam project.

   Why it matters beyond display: buildings.companyCamProjectId is what every
   push inherits (the building-link inheritance below, the DPR's job link, the
   signed-PDF upload). A wrong link doesn't just read wrong in history -- it
   sends photos and documents to the wrong customer's project.

   HONEST LIMIT: this re-points a building at the RIGHT project. It cannot
   rename a CompanyCam project. "(unnamed project)" is the proxy's fallback for
   an empty pr.name (netlify/functions/companycam.js), so a project that is
   genuinely unnamed IN CompanyCam still reads that way after re-linking. The
   fix for that is renaming it in CompanyCam; RoofOps deliberately never writes
   project names. */

/* ================= merge two building records into one =================
   Mark, 106 Orr St, 2026-07-19: one real building became TWO records --
   "(unnamed project)" holding the base map and all 4 roofs, and "Orr St
   Studios - Roof Eval" holding the correct name and nothing else.

   The building you open is the SURVIVOR; you pick the duplicate to absorb.
   That direction is deliberate: you navigate to the record you want to keep,
   which is far harder to get backwards than picking two from a list.

   Candidates are ranked by the identities that actually prove two records are
   the same site -- CompanyCam project, Foundation job, address -- rather than
   by name similarity. Name matching is precisely what MISSED this pair:
   buildingsLikelyDuplicate() (js/buildinghistory.js) requires the two records
   to share a customer name, and the "(unnamed project)" record had none. */
var mergeModalSurvivorId = null, mergeModalCandidates = [], mergeModalSurvivor = null;
async function openMergeBuildingModal(survivorId){
  if (!fdb){ toast("Merging buildings needs cloud sync."); return; }
  mergeModalSurvivorId = survivorId;
  var modal = document.getElementById("merge-bld-modal");
  if (!modal) return;
  modal.style.display = "";
  lockBodyScroll();
  var host = document.getElementById("merge-bld-list");
  if (host){ host.className = "hint"; host.textContent = "Finding possible duplicates…"; }
  try{
    var snap = await fdb.collection("buildings").doc(survivorId).get();
    mergeModalSurvivor = snap.exists ? snap.data() : {};
    var keepEl = document.getElementById("merge-bld-keep");
    if (keepEl){
      keepEl.innerHTML = "Keeping <b>" + esc(ccBuildingDisplayName(mergeModalSurvivor)) + "</b>" +
        (mergeModalSurvivor.location ? ' <span class="hint">— ' + esc(mergeModalSurvivor.location) + "</span>" : "");
    }
    var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(500).get();
    var all = [];
    qs.forEach(function(d){
      var v = d.data() || {};
      if (d.id === survivorId || v.archived) return;
      all.push(Object.assign({ id: d.id }, v));
    });
    mergeModalCandidates = mergeRankDuplicateBuildings(all, mergeModalSurvivor);
    mergeModalRender();
  }catch(e){
    if (host){ host.className = "hint"; host.textContent = "Couldn't load buildings."; }
  }
}
/* Same identity ladder as findExistingBuildingId() in js/core.js -- one rule
   for "these are the same site", used both to PREVENT duplicates on save and
   to FIND them afterwards. */
function mergeRankDuplicateBuildings(list, survivor){
  survivor = survivor || {};
  var addrKey = (typeof fdnAddressMatchKey === "function") ? fdnAddressMatchKey(survivor.location || "") : "";
  return (list || []).map(function(b){
    var rank = 9, why = "";
    if (survivor.companyCamProjectId && b.companyCamProjectId === survivor.companyCamProjectId){
      rank = 0; why = "same CompanyCam project";
    } else if (survivor.foundationJobNo && b.foundationJobNo === survivor.foundationJobNo){
      rank = 1; why = "same Foundation job";
    } else if (addrKey && typeof fdnAddressMatchKey === "function" &&
               fdnAddressMatchKey(b.location || "") === addrKey){
      rank = 2; why = "same address";
    }
    return { building: b, rank: rank, why: why };
  }).filter(function(r){ return r.rank < 9; })
    .sort(function(a, b){ return a.rank - b.rank; });
}
function mergeModalRender(){
  var host = document.getElementById("merge-bld-list");
  if (!host) return;
  if (!mergeModalCandidates.length){
    host.className = "hint";
    host.textContent = "No other building shares this one's CompanyCam project, Foundation job, or address.";
    return;
  }
  host.className = "";
  host.innerHTML = mergeModalCandidates.map(function(r, i){
    var b = r.building;
    var roofs = Array.isArray(b.roofs) ? b.roofs.length : 0;
    var hasMap = (b.roofs || []).some(function(x){ return x && x.roof_base_map_url; }) || !!b.roof_base_map_url;
    var bits = [roofs + (roofs === 1 ? " roof" : " roofs")];
    if (hasMap) bits.push("has base map");
    if (b.companyCamProjectId) bits.push("CompanyCam linked");
    return '<div class="bld-item"><div class="info">' +
      '<div class="name">' + esc(ccBuildingDisplayName(b)) + '</div>' +
      '<div class="meta">' + (b.location ? esc(b.location) + " · " : "") +
        esc(bits.join(" · ")) + ' · <b>' + esc(r.why) + '</b></div></div>' +
      '<button class="btn danger" onclick="mergeModalPick(' + i + ')">Merge into this building</button>' +
      '</div>';
  }).join("");
}
function closeMergeBuildingModal(){
  var modal = document.getElementById("merge-bld-modal");
  if (modal) modal.style.display = "none";
  unlockBodyScroll();
  mergeModalSurvivorId = null;
  mergeModalCandidates = [];
}
async function mergeModalPick(i){
  var r = mergeModalCandidates[i];
  if (!r || !mergeModalSurvivorId) return;
  var src = r.building;
  var roofs = Array.isArray(src.roofs) ? src.roofs.length : 0;
  var survivorName = ccBuildingDisplayName(mergeModalSurvivor);
  /* Spell out exactly what moves. A merge re-points every timeline entry and
     report and archives a record -- move_roof already warns its single-roof
     version "isn't instant to reverse", and this is that several times over. */
  var msg = "Merge \"" + ccBuildingDisplayName(src) + "\" INTO \"" + survivorName + "\"?\n\n" +
    "Moves onto " + survivorName + ":\n" +
    "  • " + roofs + " roof" + (roofs === 1 ? "" : "s") + " (with their base maps, outlines and features)\n" +
    "  • every timeline entry and report\n" +
    "  • its CompanyCam / Foundation link, if this building has none\n\n" +
    "\"" + ccBuildingDisplayName(src) + "\" is then ARCHIVED (not deleted).\n\n" +
    "This is not instant to reverse — check the names above are the right way round.";
  if (!confirm(msg)) return;
  toast("Merging buildings…");
  try{
    var out = await callAdminApi({ action: "merge_buildings",
      sourceBuildingId: src.id, destBuildingId: mergeModalSurvivorId,
      survivingName: survivorName });
    closeMergeBuildingModal();
    toast("Merged ✓ " + out.movedRoofs + " roof(s), " + out.movedEvents +
      " history entries, " + out.movedReports + " report(s) moved");
    if (typeof openBuildingHistory === "function") openBuildingHistory(mergeModalSurvivorId);
  }catch(e){ toast("Couldn't merge: " + e.message); }
}

/* ---- live CompanyCam name resolution for Building History ----
   Mark, 106 Orr St: RoofMapper showed the renamed project ("Orr Street
   Studios") while Building History still showed "(unnamed project)". Same
   building, two different name sources -- RoofMapper resolves LIVE by project
   id (applyCompanyCamProjectDetail above), Building History rendered the
   frozen buildings.name string, so a CompanyCam rename never reached it.

   This gives Building History the same live resolution, and writes the result
   back so the stored name self-heals for offline views and every other reader.

   Cached per project id for the session: openBuildingHistory() re-runs on every
   roof switch and timeline refresh, and re-fetching the same project each time
   would put a network round-trip in front of a view Mark opens constantly. */
var ccProjectNameCache = {};
function ccBuildingDisplayName(bld){
  /* Precedence, reconciling the Building History header's "auto-named from Job
     Name/Bill To" promise with the CompanyCam name source:
       stored real name -> live CompanyCam name -> Foundation job name -> ""
     "(unnamed project)" is mapProject()'s DISPLAY fallback for a nameless
     project and is treated as no-name at every step, never as a name. */
  bld = bld || {};
  var stored = String(bld.name || "").trim();
  if (stored && stored !== "(unnamed project)") return stored;
  var live = bld.companyCamProjectId ? ccProjectNameCache[bld.companyCamProjectId] : "";
  if (live && live !== "(unnamed project)") return live;
  var fdn = String(bld.foundationJobName || "").trim();
  if (fdn) return fdn;
  return stored || "Unnamed building";
}
/* Resolves the linked project's CURRENT name and, when it is better than what
   is stored, writes it onto the building so the fix persists. Returns the name
   it resolved, or "" if it could not. Never throws -- Building History must
   still render when CompanyCam is unreachable. */
async function ccResolveBuildingProjectName(buildingId, bld, opts){
  opts = opts || {};
  bld = bld || {};
  var projectId = bld.companyCamProjectId;
  if (!projectId) return "";
  if (!opts.force && ccProjectNameCache[projectId] !== undefined) return ccProjectNameCache[projectId];
  var name = "";
  try{
    var out = await ccApi({ action: "project_detail", project_id: projectId });
    name = ((out && out.project && out.project.name) || "").trim();
  }catch(e){ return ""; }
  ccProjectNameCache[projectId] = name;
  if (!name || name === "(unnamed project)") return name;
  var stored = String(bld.name || "").trim();
  /* Only overwrite a stored name that is absent or the placeholder. A tech's
     deliberate building name must never be clobbered by a CompanyCam rename --
     same restraint applyCompanyCamProjectDetail() shows on the Job Name field. */
  if (fdb && buildingId && (!stored || stored === "(unnamed project)")){
    try{
      await fdb.collection("buildings").doc(buildingId).set(
        { name: name, companyCamProjectName: name, updatedAt: Date.now() }, { merge: true });
    }catch(e){ /* display still improves this session even if the write fails */ }
  } else if (fdb && buildingId && (bld.companyCamProjectName || "") !== name){
    try{
      await fdb.collection("buildings").doc(buildingId).set(
        { companyCamProjectName: name, updatedAt: Date.now() }, { merge: true });
    }catch(e){}
  }
  return name;
}
/* Manual backup for the automatic resolution above -- Mark asked for one
   explicitly, and it is also the escape hatch when the cache is holding a name
   from before a rename. */
async function ccRefreshBuildingProjectName(buildingId){
  if (!fdb) return;
  toast("Refreshing from CompanyCam…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    if (!bld.companyCamProjectId){ toast("This building has no CompanyCam project linked."); return; }
    var name = await ccResolveBuildingProjectName(buildingId, bld, { force: true });
    if (!name){ toast("Couldn't reach CompanyCam — try again in a moment."); return; }
    if (name === "(unnamed project)"){
      toast("That CompanyCam project still has no name — rename it in CompanyCam.");
    } else {
      toast("Updated to " + name + " ✓");
    }
    if (typeof openBuildingHistory === "function") openBuildingHistory(buildingId);
  }catch(e){ toast("Couldn't refresh from CompanyCam."); }
}

/* Ranks CompanyCam projects against a building's address + name, best first,
   tagging each with WHY it matched so the picker shows its reasoning rather
   than an unexplained order.

   The matching rule is not new -- it is smMatchCompanyCamProject()'s
   address-first-then-name logic (js/servicemanager.js), which exists because of
   the Prairie Farms case: the CompanyCam site name routinely differs from the
   Foundation customer name, so ADDRESS is the reliable key and name is the
   fallback. The difference here is that a picker needs every candidate ranked,
   not the single unambiguous auto-match that function returns. */
function ccRankProjectsForBuilding(projects, address, name){
  var norm = function(s){
    if (typeof fdnNormalizeText === "function") return fdnNormalizeText(s);
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  };
  var addrKey = (typeof fdnAddressMatchKey === "function") ? fdnAddressMatchKey(address) : "";
  var nameKey = norm(name);
  return (projects || []).map(function(p){
    var pAddrKey = (typeof fdnAddressMatchKey === "function") ? fdnAddressMatchKey(p.address || "") : "";
    var pName = norm(p.name);
    var rank = 4, why = "";
    if (addrKey && pAddrKey && pAddrKey === addrKey){ rank = 0; why = "address match"; }
    else if (nameKey && pName && pName === nameKey){ rank = 1; why = "name match"; }
    else if (nameKey && pName && (pName.indexOf(nameKey) !== -1 || nameKey.indexOf(pName) !== -1)){
      rank = 2; why = "partial name match";
    } else if (addrKey && pAddrKey && (pAddrKey.split("|")[0] === addrKey.split("|")[0])){
      /* Same street line, different city/state token -- worth surfacing but
         deliberately NOT called an address match, because a bare street-number
         collision across towns is exactly how the wrong project gets linked. */
      rank = 3; why = "same street, different city/state";
    }
    return { project: p, rank: rank, why: why };
  }).sort(function(a, b){
    if (a.rank !== b.rank) return a.rank - b.rank;
    return String(a.project.name || "").localeCompare(String(b.project.name || ""));
  });
}

var ccLinkModalBuildingId = null, ccLinkModalResults = [], ccLinkModalDebounce = null, ccLinkModalCurrentId = null;
async function openCcProjectPicker(buildingId){
  if (!fdb){ toast("Linking a CompanyCam project needs cloud sync."); return; }
  ccLinkModalBuildingId = buildingId;
  ccLinkModalResults = [];
  var modal = document.getElementById("cc-link-modal");
  if (!modal) return;
  modal.style.display = "";
  lockBodyScroll();
  var bld = {};
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    bld = snap.exists ? snap.data() : {};
  }catch(e){}
  ccLinkModalCurrentId = bld.companyCamProjectId || null;
  var cur = document.getElementById("cc-link-current");
  if (cur){
    cur.innerHTML = ccLinkModalCurrentId ?
      "Currently linked to <b>" + esc(bld.companyCamProjectName || ccLinkModalCurrentId) + "</b>" :
      "This building is <b>not linked</b> to a CompanyCam project yet.";
  }
  /* Prefill from the building's own address, falling back to its name -- the
     search the user would have typed by hand, already typed for them. */
  var seed = bld.location || bld.address || bld.name || "";
  setVal("cc-link-search", seed);
  ccLinkModalSearch(seed, bld);
}
function closeCcProjectPicker(){
  var modal = document.getElementById("cc-link-modal");
  if (modal) modal.style.display = "none";
  unlockBodyScroll();
  ccLinkModalBuildingId = null;
  ccLinkModalResults = [];
}
function ccLinkModalOnInput(){
  clearTimeout(ccLinkModalDebounce);
  var q = val("cc-link-search");
  ccLinkModalDebounce = setTimeout(function(){ ccLinkModalSearch(q); }, 400);
}
async function ccLinkModalSearch(q, bldHint){
  var host = document.getElementById("cc-link-results");
  if (host){ host.className = "hint"; host.textContent = "Searching CompanyCam…"; }
  var bld = bldHint;
  if (!bld && ccLinkModalBuildingId && fdb){
    try{
      var snap = await fdb.collection("buildings").doc(ccLinkModalBuildingId).get();
      bld = snap.exists ? snap.data() : {};
    }catch(e){ bld = {}; }
  }
  bld = bld || {};
  try{
    var out = await ccApi({ action: "projects", q: q || "" });
    /* Ranked against the BUILDING's own address/name, not against the raw
       query -- so clearing the search box still surfaces the best candidates
       for this building rather than an arbitrary 100. */
    ccLinkModalResults = ccRankProjectsForBuilding(out.projects || [],
      bld.location || bld.address || "", bld.name || "");
    ccLinkModalRender();
  }catch(e){
    ccLinkModalResults = [];
    if (host){
      host.className = "hint";
      host.textContent = "Couldn't reach CompanyCam right now — try again in a moment.";
    }
  }
}
function ccLinkModalRender(){
  var host = document.getElementById("cc-link-results");
  if (!host) return;
  if (!ccLinkModalResults.length){
    host.className = "hint";
    host.textContent = "No CompanyCam projects found for that search.";
    return;
  }
  host.className = "";
  host.innerHTML = ccLinkModalResults.map(function(r, i){
    var p = r.project;
    var isCurrent = ccLinkModalCurrentId && String(p.id) === String(ccLinkModalCurrentId);
    var unnamed = !p.name || p.name === "(unnamed project)";
    return '<div class="bld-item"><div class="info">' +
      '<div class="name">' + esc(p.name || "(unnamed project)") +
        (unnamed ? ' <span class="hint" style="margin:0">· unnamed in CompanyCam</span>' : "") +
        (isCurrent ? ' <span class="evt-tag" style="background:#E8F5E9;color:#2E7D32">current</span>' : "") +
      '</div>' +
      '<div class="meta">' + (p.address ? esc(p.address) : '<span class="hint">no address</span>') +
        (r.why ? " · " + esc(r.why) : "") + '</div></div>' +
      (isCurrent ? '<button class="btn" disabled>Linked</button>' :
        '<button class="btn primary" onclick="ccLinkModalPick(' + i + ')">Link</button>') +
      '</div>';
  }).join("");
}
async function ccLinkModalPick(i){
  var r = ccLinkModalResults[i];
  if (!r || !ccLinkModalBuildingId) return;
  var p = r.project;
  var name = p.name || "(unnamed project)";
  /* Re-pointing decides where this building's photos and signed PDFs land, so
     it is confirmed rather than one-tap -- the same care openMoveRoofModal()
     takes over a cross-building move. */
  var msg = "Link this building to CompanyCam project:\n\n" + name +
    (p.address ? "\n" + p.address : "") +
    "\n\nFuture photos and documents for this building will push to this project.";
  if (!confirm(msg)) return;
  try{
    await fdb.collection("buildings").doc(ccLinkModalBuildingId).set(
      { companyCamProjectId: String(p.id), companyCamProjectName: p.name || "" }, { merge: true });
  }catch(e){
    toast("Couldn't save the link — check your connection.");
    return;
  }
  toast("Linked to " + name + " ✓");
  var buildingId = ccLinkModalBuildingId;
  closeCcProjectPicker();
  if (typeof openBuildingHistory === "function" && currentViewName === "history") openBuildingHistory(buildingId);
}
