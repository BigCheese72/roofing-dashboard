/* ============================================================================
   Leak Work Order — Roof Base Map quick-attach  (Leak WO lane; owner: Leak agent)

   Mark's field feedback (from using the Leak Work Order in production): he
   hasn't been putting the roof base map on leak work orders because there was
   no easy way to do it right from the leak form. The roof map already FOLLOWS
   THE JOB — a base map made once is resolved onto any form for that site by
   CompanyCam-project / building linkage (see lookupProspectiveBuildingBaseMap()
   in js/photos.js) and prints on the report roof-plan automatically
   (rmFetchReportRoofOutlines() in js/export.js). What was missing was a clear,
   in-form surface that (a) tells the tech whether this job's map is ready and
   will print, and (b) is a one/two-tap jump to draw one when it isn't.

   This file OWNS that surface (#wo-basemap-card, gated to the Leak type in
   onWoTypeChange()). It only READS via the existing job-centric resolver and
   ROUTES into the existing RoofMapper draw flow — it defines no base-map storage
   of its own and edits none of the shared photo / roofmapper / building-history
   files. Every cross-module call is typeof-guarded so load order and a
   keyless/no-Firestore deploy both degrade quietly (the card simply shows the
   "draw one" call to action).
   ========================================================================== */

/* Last base map resolved for the form now on screen, cached so the "View" and
   "Redraw" buttons open the right roof without a second Firestore read. */
var leakBaseMapResolved = null;
/* Monotonic guard: lookupProspectiveBuildingBaseMap() is async, so a fast type
   switch or job edit can leave an older resolve in flight. Only the newest
   render is allowed to paint. */
var leakBaseMapRenderSeq = 0;

function leakBaseMapCardVisible(){
  var card = document.getElementById("wo-basemap-card");
  return !!(card && card.style.display !== "none");
}

/* Resolve this job's base map and paint the card's status + buttons. Safe to
   call fire-and-forget from onWoTypeChange(); it no-ops when the card is hidden
   (non-leak types) and swallows resolver errors to a clean "draw one" state. */
async function renderLeakBaseMap(){
  var card = document.getElementById("wo-basemap-card");
  if (!card) return;
  var statusEl = document.getElementById("wo-basemap-status");
  var viewBtn = document.getElementById("wo-basemap-view-btn");
  var drawBtn = document.getElementById("wo-basemap-draw-btn");
  if (card.style.display === "none"){ leakBaseMapResolved = null; return; }

  var seq = ++leakBaseMapRenderSeq;
  if (statusEl) statusEl.innerHTML = '<span class="hint" style="margin:0">Checking for this job’s roof map…</span>';
  if (viewBtn) viewBtn.style.display = "none";

  var base = null;
  if (typeof lookupProspectiveBuildingBaseMap === "function"){
    try { base = await lookupProspectiveBuildingBaseMap(); } catch(e){ base = null; }
  }
  if (seq !== leakBaseMapRenderSeq) return; /* a newer render superseded this one */
  leakBaseMapResolved = base;
  if (!statusEl) return;

  if (base && base.url){
    /* Say WHOSE map it is when it isn't this roof's own — same honesty rule the
       resolver and the inline history label follow (js/photos.js:65-73). */
    var whose = base.viaCompanyCam
      ? "from this job’s CompanyCam site"
      : (base.fromSelectedRoof ? "for this roof"
         : ("from " + esc(base.sourceRoofLabel || "another roof")));
    statusEl.innerHTML =
      '<div style="background:#E8F5E9;border:1px solid #66BB6A;color:#1B5E20;border-radius:8px;padding:9px 11px;font-weight:600">' +
        '✓ Roof map ready ' + whose + ' — it prints on this report automatically.' +
      '</div>';
    if (viewBtn) viewBtn.style.display = "";
    if (drawBtn) drawBtn.textContent = "✏️ Edit roof map";
  } else {
    statusEl.innerHTML =
      '<p class="hint" style="margin:0">No roof map for this job yet — it won’t appear on the report. ' +
      'Tap <b>Draw roof map</b> to make one; it then follows this job onto every form and report.</p>';
    if (drawBtn) drawBtn.textContent = "✏️ Draw roof map";
  }
}

/* Resolve the building this leak WO is tied to, following a merge to the
   survivor doc the same way the resolver does. */
async function leakBaseMapBuildingId(){
  var bldId = (typeof currentWorkOrderBuildingId === "function") ? currentWorkOrderBuildingId() : null;
  if (bldId && typeof resolveMergedBuildingId === "function"){
    try { bldId = (await resolveMergedBuildingId(bldId)) || bldId; } catch(e){ /* keep the un-resolved id */ }
  }
  return bldId || null;
}

/* Jump straight into RoofMapper for THIS job to trace/draw a roof. showView()
   is a pure show/hide and the never-lose-edits-on-back-out autosave (PR #171)
   has already persisted the in-progress leak WO locally, so leaving to the
   mapper and coming back never drops what the tech has typed. When the job has
   no building doc yet, fall back to the mapper's own job picker. */
async function leakBaseMapDraw(){
  var bldId = await leakBaseMapBuildingId();
  if (bldId && typeof rmEnterMultiRoofCapture === "function"){ rmEnterMultiRoofCapture(bldId); return; }
  if (typeof rmOpenJobPicker === "function"){ rmOpenJobPicker(); return; }
  if (typeof toast === "function") toast("Open the RoofMapper tab to draw a roof map for this job.");
}

/* Open the existing resolved base map. Prefer opening its own source roof in
   RoofMapper (editable); fall back to the multi-roof capture for the building,
   then the job picker. */
async function leakBaseMapView(){
  var base = leakBaseMapResolved;
  var bldId = await leakBaseMapBuildingId();
  if (base && base.sourceRoofId && bldId && typeof rmOpenRoofInMapper === "function"){
    rmOpenRoofInMapper(bldId, base.sourceRoofId); return;
  }
  if (bldId && typeof rmEnterMultiRoofCapture === "function"){ rmEnterMultiRoofCapture(bldId); return; }
  if (typeof rmOpenJobPicker === "function"){ rmOpenJobPicker(); }
}

/* Keep the status honest as the tech fills in the job: when the customer or job
   name changes (that's what decides which building/site we resolve), re-check —
   but only while the leak card is actually on screen. Attaching our own listener
   here keeps this self-contained in the Leak lane; it edits no other file. */
document.addEventListener("DOMContentLoaded", function(){
  var t = null;
  function scheduleLeakBaseMapRefresh(){
    if (!leakBaseMapCardVisible()) return;
    if (t) clearTimeout(t);
    t = setTimeout(function(){ if (typeof renderLeakBaseMap === "function") renderLeakBaseMap(); }, 400);
  }
  ["jobName", "billTo"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", scheduleLeakBaseMapRefresh);
  });
});
