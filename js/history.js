"use strict";
/* ================= building history view (foundation) ================= */
function fmtTs(ms){
  if (!ms) return "";
  try{ return new Date(ms).toLocaleString(); }catch(e){ return ""; }
}
/* ================= timeline filters =================
   Client-side only: the events for a building are already fetched in full
   by openBuildingHistory() (single query, limit 50), so filtering is just
   an in-memory re-render of the same array — no new Firestore reads, no
   new indexes, no data model change. Filter dropdown options are derived
   from whatever values actually appear on this building's own events,
   rather than a hardcoded list, so a filter never offers a choice that
   would return zero results. */
var historyEvents = [];
var historyBuildingId = null;
var historySelectedRoofId = null;
function tlDistinctSorted(field){
  var set = {};
  historyEvents.forEach(function(e){ var v = (e[field] || "").trim(); if (v) set[v] = true; });
  return Object.keys(set).sort();
}
function populateTimelineFilterOptions(){
  [["tl-roof","roofType"], ["tl-tech","technician"], ["tl-warranty","warrantyStatus"],
   ["tl-reporttype","reportType"], ["tl-wotype","workOrderType"]]
    .forEach(function(spec){
      var sel = document.getElementById(spec[0]);
      if (!sel) return;
      var current = sel.value;
      /* The Work Order Type filter is built from the RAW stored values found
         in the data ("Repair", "Leak / Service", ...) — the option's value
         must stay raw, because filterTimelineEvents() compares it straight
         against e.workOrderType. Only the visible text gets the display
         label, so the tech picks "Work Order" and it still matches every
         record stored as "Repair". */
      var isWoType = spec[1] === "workOrderType";
      sel.innerHTML = '<option value="">All</option>' + tlDistinctSorted(spec[1]).map(function(v){
        return '<option value="' + esc(v) + '">' + esc(isWoType ? woTypeLabel(v) : v) + '</option>';
      }).join("");
      sel.value = Array.prototype.some.call(sel.options, function(o){ return o.value === current; }) ? current : "";
    });
}
function clearTimelineFilters(){
  ["tl-from","tl-to","tl-roof","tl-tech","tl-warranty","tl-reporttype","tl-wotype"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.value = "";
  });
  renderTimelineList();
}
function filterTimelineEvents(){
  var from = val("tl-from"), to = val("tl-to");
  var roof = val("tl-roof"), tech = val("tl-tech"), warranty = val("tl-warranty"), rtype = val("tl-reporttype");
  var wotype = val("tl-wotype");
  var fromTs = from ? new Date(from + "T00:00:00").getTime() : null;
  var toTs = to ? new Date(to + "T23:59:59").getTime() : null;
  return historyEvents.filter(function(e){
    if (fromTs !== null && (e.createdAt || 0) < fromTs) return false;
    if (toTs !== null && (e.createdAt || 0) > toTs) return false;
    if (roof && e.roofType !== roof) return false;
    if (tech && e.technician !== tech) return false;
    if (warranty && e.warrantyStatus !== warranty) return false;
    if (rtype && e.reportType !== rtype) return false;
    if (wotype && e.workOrderType !== wotype) return false;
    return true;
  });
}
function timelineFiltersHtml(){
  return '<p class="hint" style="margin:-4px 0 10px">Date filters by when the report was logged, not the typed “Date of Service.”</p>' +
    '<div class="grid" style="margin-bottom:6px">' +
    '<div class="fld"><label>From</label><input type="date" id="tl-from" onchange="renderTimelineList()"></div>' +
    '<div class="fld"><label>To</label><input type="date" id="tl-to" onchange="renderTimelineList()"></div>' +
    '<div class="fld"><label>Roof Area</label><select id="tl-roof" onchange="renderTimelineList()"><option value="">All</option></select></div>' +
    '<div class="fld"><label>Technician</label><select id="tl-tech" onchange="renderTimelineList()"><option value="">All</option></select></div>' +
    '<div class="fld"><label>Warranty Status</label><select id="tl-warranty" onchange="renderTimelineList()"><option value="">All</option></select></div>' +
    '<div class="fld"><label>Report Type</label><select id="tl-reporttype" onchange="renderTimelineList()"><option value="">All</option></select></div>' +
    '<div class="fld"><label>Work Order Type</label><select id="tl-wotype" onchange="renderTimelineList()"><option value="">All</option></select></div>' +
    '</div>' +
    '<div class="btnrow" style="margin:0 0 10px;align-items:center">' +
    '<button class="btn" onclick="clearTimelineFilters()">Clear Filters</button>' +
    '<span class="hint" id="tl-count" style="margin:0"></span></div>';
}
/* Persistent CompanyCam-upload indicator for a report/timeline entry — see
   companyCamUploadStatus in logReportAndHistoryEvent(). Deliberately says
   nothing when status is null (never attempted, e.g. entries logged before
   this shipped, or a manually logged activity) — only "saved" and
   "failed"/"not_linked" (both surfaced as "Not saved," since both mean the
   PDF genuinely isn't in CompanyCam) get a badge, per Mark's spec. */
function ccUploadBadgeHtml(status){
  if (status === "saved") return '<span class="evt-tag" style="background:#E8F5E9;color:#2E7D32">☁️ Saved to CompanyCam</span>';
  if (status === "failed" || status === "not_linked") return '<span class="evt-tag" style="background:#FBE2E2;color:#D64545">⚠️ Not saved to CompanyCam</span>';
  return "";
}
/* Subtle "added later" flag -- Mark: "so nobody mistakes a backfilled
   record for a live one." Only ever true for a manually logged activity
   with the new enteredAt field (old records and auto-generated reports,
   which are always entered the same day they happen, never have this) --
   compares calendar DAYS, not raw milliseconds, so an activity logged the
   evening of the same day it happened is never wrongly flagged. See
   "Retroactive backfill: back-dating" in DEV_NOTES.md. */
function isBackdatedEvent(e){
  if (!e.enteredAt || !e.date) return false;
  var eventDay = parseMDYDate(e.date);
  if (!eventDay) return false;
  var enteredDay = new Date(e.enteredAt); enteredDay.setHours(0,0,0,0);
  return eventDay < enteredDay.getTime();
}
function timelineEventHtml(e, buildingId, opts){
  opts = opts || {};
  var backdated = isBackdatedEvent(e);
  return '<div class="evt-item"' + (e._dup ? ' style="border-left-color:#D64545"' : '') + '><div class="evt-head">' +
    '<span class="evt-date">' + esc(e.date || fmtTs(e.createdAt)) + '</span>' +
    '<span class="evt-tag">' + esc(e.reportType || "") + '</span>' +
    (e.workOrderType && e.workOrderType !== WORK_ORDER_TYPES[0] ?
      '<span class="evt-tag" style="background:#FFF3E0;color:#8A5A00">' + esc(woTypeLabel(e.workOrderType)) + '</span>' : '') +
    (e.warrantyStatus ? '<span class="evt-tag">' + esc(e.warrantyStatus) + '</span>' : '') +
    (e.emailSent ? '<span class="evt-tag">Emailed ✓</span>' : '') +
    ccUploadBadgeHtml(e.companyCamUploadStatus) +
    (backdated ? '<span class="evt-tag" style="background:#ECEFF1;color:#5B6770" title="Entered ' +
      esc(fmtTs(e.enteredAt)) + ', for an event dated ' + esc(e.date) + '">🕓 Added later</span>' : '') +
    (e._dup ? '<span class="evt-tag" style="background:#FBE2E2;color:#D64545">Possible duplicate</span>' : '') +
    (isAdmin && !opts.readOnly ? '<span class="sp"></span><button class="btn danger" onclick="deleteHistoryEventAdmin(\'' + e._id + '\', \'' + buildingId + '\')">Delete (admin)</button>' : '') +
    '</div>' +
    (e.workOrderNo ? '<div class="evt-row">Job No. ' + esc(e.workOrderNo) + '</div>' : '') +
    (e.technician ? '<div class="evt-row">Technician: ' + esc(e.technician) + '</div>' : '') +
    (backdated && e.enteredBy && e.enteredBy !== e.technician ?
      '<div class="evt-row hint">Entered by ' + esc(e.enteredBy) + ' on ' + esc(fmtTs(e.enteredAt)) + '</div>' : '') +
    (e.roofType ? '<div class="evt-row">Roof: ' + esc(e.roofType) + '</div>' : '') +
    /* Multi-roof Inspection only (roofLabels set alongside roofIds -- see
       logReportAndHistoryEvent()); every other event still shows nothing
       extra here, unchanged. */
    (e.roofLabels && e.roofLabels.length ? '<div class="evt-row">Roofs Inspected: ' + esc(e.roofLabels.join(", ")) + '</div>' : '') +
    (e.emailSent && (e.emailRecipients || []).length ?
      '<div class="evt-row">📧 Emailed to ' + esc(e.emailRecipients.join(", ")) + '</div>' : '') +
    (e.companyCamUploadStatus === "failed" && e.companyCamUploadError ?
      '<div class="evt-row" style="color:#D64545">CompanyCam upload error: ' + esc(e.companyCamUploadError) + '</div>' : '') +
    (e.conditionsSummary ? '<div class="evt-row">Findings: ' + esc(e.conditionsSummary) + '</div>' : '') +
    (e.repairsSummary ? '<div class="evt-row">Repairs: ' + esc(e.repairsSummary) + '</div>' : '') +
    (e.notes ? '<div class="evt-row">' + esc(e.notes) + '</div>' : '') +
    /* Existing photos attached while backfilling this record -- see
       attachActivityPhotos() and "ATTACH EXISTING ARTIFACTS...
       retroactively" in DEV_NOTES.md. Absent for every event that never
       had any (the vast majority). */
    ((e.photos || []).length ? '<div class="evt-row" style="display:flex;gap:6px;flex-wrap:wrap">' +
      e.photos.map(function(p){
        return '<img src="' + esc(p.img) + '" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--line);border-radius:4px">';
      }).join('') + '</div>' : '') +
    (e.pdfRef && e.pdfRef.url ? '<div class="evt-row"><a href="' + esc(e.pdfRef.url) + '" target="_blank" rel="noopener">View saved PDF</a></div>' : '') +
    '</div>';
}
function renderTimelineList(){
  var host = document.getElementById("timeline-list");
  if (!host) return;
  var filtered = filterTimelineEvents();
  var countEl = document.getElementById("tl-count");
  if (countEl){
    countEl.textContent = filtered.length === historyEvents.length ?
      "Showing all " + historyEvents.length :
      "Showing " + filtered.length + " of " + historyEvents.length;
  }
  host.innerHTML = filtered.length ?
    filtered.map(function(e){ return timelineEventHtml(e, historyBuildingId); }).join("") :
    '<div class="empty">No timeline entries match these filters.</div>';
}
async function loadBuildingHistoryEvents(buildingId, limit){
  if (!fdb || !buildingId) return [];
  /* Keep this query shape identical to the main Building History page:
     buildingId equality + createdAt order + limit. Firestore rules already
     allow reads on building_history_events, and this is the existing indexed
     path instead of a new ad-hoc query for the work-order inline card. */
  var qs = await fdb.collection("building_history_events")
    .where("buildingId", "==", buildingId).orderBy("createdAt", "desc").limit(limit || 50).get();
  var events = [];
  qs.forEach(function(d){ events.push(Object.assign({ _id: d.id }, d.data())); });
  /* Mark: "show the timeline ordered by the EVENT date" -- the query
     above orders by createdAt (when it was ENTERED, a Firestore-native
     field) purely to fetch the most-recently-touched records; that's NOT
     the same as chronological order once a backfilled record's real date
     can be anywhere in the past. Re-sort client-side by the actual date
     field (parseMDYDate() -- plain string orderBy would sort "M/D/YY"
     lexicographically wrong) before anything renders. Same-day events keep
     their createdAt order as a stable tiebreak. */
  events.sort(function(a, b){
    var d = parseMDYDate(b.date) - parseMDYDate(a.date);
    return d !== 0 ? d : (b.createdAt || 0) - (a.createdAt || 0);
  });
  flagDuplicateEvents(events);
  return events;
}
async function openBuildingHistory(buildingId){
  var detail = document.getElementById("history-detail");
  detail.innerHTML = '<p class="hint">Loading timeline\u2026</p>';
  try{
    var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = bldSnap.exists ? bldSnap.data() : {};
    var warrantyReportsSnap = await fdb.collection("buildings").doc(buildingId)
      .collection("warranty_reports").orderBy("uploadedAt", "desc").limit(50).get();
    var warrantyReports = []; warrantyReportsSnap.forEach(function(d){ warrantyReports.push(d.data()); });
    var warrantyCardHtmlStr = renderWarrantyCardHtml(buildingId, warrantyReports);
    var roofs = getBuildingRoofs(bld);
    if (!roofs.some(function(r){ return r.id === historySelectedRoofId; })) historySelectedRoofId = roofs[0].id;
    var roof = getRoofById(bld, historySelectedRoofId);
    /* admin.js's set_building_roof_map now takes an optional roofId, so
       this targets whichever roof is currently selected — no longer
       limited to single-roof buildings (was disabled for multi-roof
       buildings in an earlier increment; re-enabled now that admin.js is
       roof-aware — see DATA_MODEL.md). */
    var baseMapCardHtml = isAdmin ?
      renderBaseMapAdminCard(buildingId, roof, bld.companyCamProjectId) : "";
    var profileCardHtml = renderRoofProfileCard(buildingId, roof);
    var hasCustomBaseMap = !!((roof.roof_base_map_type === "roof_plan" || roof.roof_base_map_type === "sketch") && roof.roof_base_map_url);
    var orthoOverlay = (roof.roof_base_map_type === "drone_ortho" && roof.roof_base_map_url && roof.roof_base_map_bounds) ?
      { url: roof.roof_base_map_url, bounds: roof.roof_base_map_bounds } : null;
    var roofAssets = (roof.roof_assets || []).map(function(a){
      return Object.assign({}, a, {
        _roofBaseMapSynthetic: !!roof.roof_base_map_synthetic,
        _roofBaseMapType: roof.roof_base_map_type || null
      });
    });
    /* Every roof's most recent outline, each tagged with its own roof's
       label -- lets Mark see every roof on this building at once, labeled,
       instead of switching one-at-a-time via the picker below. Only
       meaningful in satellite mode (hasCustomBaseMap forces a single
       roof's x/y image CRS, which the other roofs' lat/lng outlines can't
       be drawn onto at all -- same coordinate-system constraint already
       documented for pins/assets above). See "Individual-roof tracing +
       labels" in DEV_NOTES.md. */
    var allRoofOutlinesForMap = hasCustomBaseMap ? (function(){
      var ol = roof.roof_outlines || [];
      var latest = ol[ol.length - 1];
      return latest ? [Object.assign({}, latest, {
        _roofLabel: roof.label || "Roof",
        _roofLabelPos: roof.labelPos || null,
        _roofBaseMapSynthetic: !!roof.roof_base_map_synthetic,
        _roofBaseMapType: roof.roof_base_map_type || null
      })] : [];
    })() : roofs.reduce(function(acc, r){
      var ol = r.roof_outlines || [];
      var latest = ol[ol.length - 1];
      if (latest) acc.push(Object.assign({}, latest, {
        _roofLabel: r.label || "Roof",
        _roofLabelPos: r.labelPos || null,
        _roofBaseMapSynthetic: !!r.roof_base_map_synthetic,
        _roofBaseMapType: r.roof_base_map_type || null
      }));
      return acc;
    }, []);
    /* Roof selector only renders for a building with more than one real
       roof — a still-single-roof building (all of them, as of this
       writing) looks exactly like it did before roofs[] existed. Condition
       (if the admin has set one) shows right in the option label — a cheap
       way to surface a key profile fact without opening the profile card.
       "✏️ Rename" is new -- a roof's label was previously only ever set
       once, at creation (promptAddRoof()'s prompt), with no way to fix a
       typo or rename it later. Shown for a single-roof building too (its
       synthesized/default "Roof 1" is just as renameable). See
       "Individual-roof tracing + labels" in DEV_NOTES.md. */
    var renameBtnHtml = '<button class="btn" style="margin-left:6px" onclick="promptRenameRoof(\'' +
      buildingId + '\', \'' + historySelectedRoofId + '\')">✏️ Rename</button>';
    /* THE fix for "RoofMapper can't reopen a saved roof" -- Mark refreshed,
       came back to a roof Building History shows intact, and RoofMapper
       opened blank (no code path anywhere ever loaded a saved
       roof_outlines[] entry back onto the map -- every RoofMapper entry
       point only ever started a NEW trace). This is where he'll look for
       it, since this is where he can actually SEE the roof exists. Routes
       to rmOpenRoofInMapper(), the one real "open" path, shared with
       RoofMapper's own roof switcher. See "Reopen a saved roof in
       RoofMapper" in DEV_NOTES.md. */
    var openInMapperBtnHtml = '<button class="btn primary" style="margin-left:6px" onclick="rmOpenRoofInMapper(\'' +
      buildingId + '\', \'' + historySelectedRoofId + '\')">🗺️ Open in RoofMapper</button>';
    /* Mark: traced a roof onto the wrong building, no way to fix it. Not
       gated behind "more than one roof" -- the stuck roof is very often the
       ONLY roof on the wrong building, which is exactly Mark's case.
       Admin-gated (same as Archive) since a cross-building move touches
       every timeline entry/report tied to this roof, not just a label. See
       openMoveRoofModal() and "Move/reassign a roof to a different
       building" in DEV_NOTES.md. */
    var moveBtnHtml = isAdmin ? ('<button class="btn" style="margin-left:6px" onclick="openMoveRoofModal(\'' +
      buildingId + '\', \'' + historySelectedRoofId + '\', \'' + esc(roof.label || "Roof") +
      '\')">↔️ Move to Different Building</button>') : '';
    var roofPickerHtml = roofs.length > 1 ?
      '<div class="fld" style="max-width:320px;margin-bottom:8px">' +
        '<label>Roof</label><div class="btnrow" style="margin:0;align-items:center">' +
        '<select onchange="historySelectRoof(\'' + buildingId + '\', this.value)" style="flex:1">' +
        roofs.map(function(r){
          var cond = getRoofProfile(r).condition;
          return '<option value="' + esc(r.id) + '"' + (r.id === historySelectedRoofId ? ' selected' : '') + '>' +
            esc(r.label || "Roof") + (cond ? " — " + esc(cond) : "") + '</option>';
        }).join('') +
        '</select>' + renameBtnHtml + openInMapperBtnHtml + moveBtnHtml + '</div></div>' :
      '<p class="hint" style="margin:0 0 8px">Roof: <b>' + esc(roof.label || "Roof") + '</b>' + renameBtnHtml + openInMapperBtnHtml + moveBtnHtml + '</p>';
    var addRoofBtnHtml = '<button class="btn" onclick="promptAddRoof(\'' + buildingId + '\')">+ Add Roof</button>';
    var addFeatureBtnHtml = '<button class="btn" onclick="openAssetModal(\'' + buildingId + '\', null, \'' + historySelectedRoofId + '\')">+ Add Roof Feature</button>';
    var addActivityBtnHtml = '<button class="btn" onclick="openActivityModal(\'' + buildingId + '\')">+ Log Activity</button>';
    /* Mark's Tri-Delta recovery ask: run the SAME point-in-polygon logic
       that assigns a roof to a photo live at capture time
       (rmMaybeAutoAssignRoofForPin()) retroactively over every already-
       saved pin on this building that has real GPS -- recovers an
       inspection shot before roofs were traced/before this feature
       existed. Only offered once the building actually has more than one
       roof (a single-roof building has nothing to disambiguate). See
       rmAutoAssignExistingPinsToRoofs() and "GPS auto-assign photos to
       roofs" in DEV_NOTES.md. */
    var autoAssignBtnHtml = roofs.length > 1 ?
      '<button class="btn" onclick="rmAutoAssignExistingPinsToRoofs(\'' + buildingId + '\')">🎯 Auto-Assign Photos to Roofs</button>' : '';
    /* Manual counterpart to the automatic pass above -- see
       openBulkReassignModal() and "GPS auto-assign photos to roofs" in
       DEV_NOTES.md. Same multi-roof-only gating. */
    var bulkReassignBtnHtml = roofs.length > 1 ?
      '<button class="btn" onclick="openBulkReassignModal(\'' + buildingId + '\')">☑️ Bulk Reassign Pins</button>' : '';
    /* "Building History on Save" recovery ask: a work order Saved before
       this shipped (findings/pins/photos and all -- Mark's real Tri-Delta
       leak report from today, saved but never Downloaded/Emailed/Shared)
       has no building_history_events doc at all, so it won't show up just
       from opening this page again -- there's nothing to re-render. This
       button runs the one-time recovery pass: finds this building's
       already-saved work orders that are still missing an event and
       creates it, without requiring a re-export. See
       backfillMissingHistoryEvents() and "Building History on Save" in
       DEV_NOTES.md. */
    var recoverBtnHtml = '<button class="btn" onclick="backfillMissingHistoryEvents(\'' + buildingId + '\')">🔄 Recover Unlogged Work Orders</button>';
    var emptyMapCardHtml = '<div class="card"><h2 class="cond">Roof Map</h2>' + roofPickerHtml +
      '<p class="hint">No pins placed yet — they’ll show up here as findings get pinned on future reports. ' +
      'Permanent features (drains, HVAC units, hatches, etc.) can be added any time.</p>' +
      '<div id="building-map" style="height:min(50vh,420px);border-radius:6px;overflow:hidden;margin-bottom:10px"></div>' +
      addFeatureBtnHtml + ' ' + addRoofBtnHtml + ' ' + autoAssignBtnHtml + ' ' + bulkReassignBtnHtml + '</div>';
    var events = await loadBuildingHistoryEvents(buildingId, 50);
    if (!events.length){
      historyEvents = [];
      historyBuildingId = buildingId;
      detail.innerHTML = baseMapCardHtml + profileCardHtml + warrantyCardHtmlStr + emptyMapCardHtml + '<div class="card"><h2 class="cond">Timeline</h2>' +
        '<div class="btnrow" style="margin:0 0 10px">' + addActivityBtnHtml + ' ' + recoverBtnHtml + '</div>' +
        '<div class="empty">No reports logged for this building yet. If a work order was already Saved for this ' +
        'building but never Downloaded/Emailed/Shared, tap 🔄 Recover Unlogged Work Orders above.</div></div>';
      renderBuildingMap([], hasCustomBaseMap ? roof : null, bld.location, orthoOverlay, roofAssets, buildingId, allRoofOutlinesForMap);
      return;
    }
    var dupCount = events.filter(function(e){ return e._dup; }).length;
    historyEvents = events;
    historyBuildingId = buildingId;
    var allPins = [];
    /* Each pin carries the roofId of whichever roof its work order was for
       (buildPinsForHistoryEvent) — a pin saved before roofs[] existed has
       no roofId at all, which always means "roof_default" (the building's
       first/only roof), same convention used everywhere else. Filtering
       here is a no-op for every still-single-roof building, since
       historySelectedRoofId is always "roof_default" too in that case. */
    events.forEach(function(e){ (e.pins || []).forEach(function(p){
      if ((p.roofId || "roof_default") !== historySelectedRoofId) return;
      allPins.push(Object.assign({ eventDate: e.date }, p));
    }); });
    /* A building shows ONE map — either satellite (lat/lng pins) or its
       custom base map (x/y pins), not a mix, since those are two different
       coordinate systems that can't be merged onto one Leaflet CRS without
       the manual anchoring the spec explicitly says not to build. Pins
       placed before a custom base map existed (lat/lng) won't appear once
       one is set — a known, documented tradeoff, not a bug. */
    var mapPins = hasCustomBaseMap ?
      allPins.filter(function(p){ return typeof p.x === "number" && typeof p.y === "number"; }) :
      allPins.filter(function(p){ return typeof p.lat === "number" && typeof p.lng === "number"; });
    /* Always show the roof map, even with zero pins — it's the building's
       satellite/base-map view, not just a pin display. Pins fill in over
       time as reports get generated. */
    var mapCardHtml = '<div class="card"><h2 class="cond">Roof Map</h2>' + roofPickerHtml +
      '<p class="hint">' + (mapPins.length ?
        'Every pinned finding across every report for this building, plus any permanent roof features below. Tap a pin for details.' :
        'No pins placed yet — they’ll show up here as findings get pinned on future reports.') + '</p>' +
      '<div id="building-map" style="height:min(50vh,420px);border-radius:6px;overflow:hidden;margin-bottom:10px"></div>' +
      addFeatureBtnHtml + ' ' + addRoofBtnHtml + ' ' + autoAssignBtnHtml + ' ' + bulkReassignBtnHtml + '</div>';
    detail.innerHTML = baseMapCardHtml + profileCardHtml + warrantyCardHtmlStr + mapCardHtml +
      '<div class="card"><h2 class="cond">Timeline (' + events.length + ')</h2>' +
      '<div class="btnrow" style="margin:0 0 10px">' + addActivityBtnHtml + ' ' + recoverBtnHtml + '</div>' +
      (dupCount ? '<p class="hint">\u26a0 ' + dupCount + ' possible duplicate' + (dupCount === 1 ? "" : "s") +
        ' flagged below (same work order + report type within 5 minutes of another entry).</p>' : '') +
      timelineFiltersHtml() +
      '<div id="timeline-list"></div></div>';
    populateTimelineFilterOptions();
    renderTimelineList();
    renderBuildingMap(mapPins, hasCustomBaseMap ? roof : null, bld.location, orthoOverlay, roofAssets, buildingId, allRoofOutlinesForMap);
  }catch(e){
    detail.innerHTML = '<div class="card"><div class="empty">Couldn\u2019t load timeline: ' + esc(e.message) + '</div></div>';
  }
}
function historySelectRoof(buildingId, roofId){
  historySelectedRoofId = roofId;
  return openBuildingHistory(buildingId);
}

/* ================= Warranty / inspection reports =================
   Ingested from CCM Inspect emails (netlify/functions/inspection-
   reports.js, scheduled poll + manual "Check for New Inspection Reports")
   or uploaded directly here. See DEV_NOTES.md "Inspection report
   ingestion" for the full design. Buildings get re-inspected repeatedly
   (annually, sometimes twice a year) -- reports are NEVER overwritten,
   only added, newest first, with older ones tucked under a "Previous
   Reports" toggle so a tech sees the roof's whole inspection history, not
   just the latest. A report can be marked superseded (server-side only,
   never deleted) when a genuinely revised version of the same inspection
   arrives. */
var warrantyUploadBuildingId = null;
function warrantyReportRowHtml(r, buildingId){
  var dateLabel = r.inspectionDate || fmtTs(r.uploadedAt);
  var sourceLabel = r.sourceType === "manual" ? "Uploaded by " + esc(r.uploadedBy || "admin") :
    "Emailed" + (r.sourceEmailSubject ? ' — "' + esc(r.sourceEmailSubject) + '"' : "");
  var ccBadge = r.companyCamUploadStatus === "uploaded" ? '<span class="evt-tag">CompanyCam ✓</span>' :
    (r.companyCamUploadStatus === "failed" ? '<span class="evt-tag" style="background:#FBE2E2;color:#D64545">CompanyCam upload failed</span>' : "");
  return '<div class="evt-item">' +
    '<div class="evt-head"><span class="evt-date">' + esc(dateLabel) + '</span>' +
    '<span class="evt-tag">' + esc(r.fileName || "Inspection Report") + '</span>' + ccBadge + '</div>' +
    '<div class="evt-row">' + sourceLabel + '</div>' +
    '<div class="btnrow" style="margin:6px 0 0"><button class="btn" onclick="viewWarrantyReportPdf(\'' +
    esc(buildingId) + '\', \'' + esc(r.storageRef) + '\')">📄 View Report</button></div>' +
    '</div>';
}
function renderWarrantyCardHtml(buildingId, reports){
  var active = reports.filter(function(r){ return r.status !== "superseded"; });
  var superseded = reports.filter(function(r){ return r.status === "superseded"; });
  var uploadBtnHtml = '<button class="btn" onclick="openWarrantyUploadModal(\'' + esc(buildingId) + '\')">⬆️ Upload Report</button>';
  if (!active.length && !superseded.length){
    return '<div class="card"><h2 class="cond">Warranty — Inspection Reports</h2>' +
      '<p class="hint">No inspection reports on file for this building yet. They’ll appear here automatically when CCM Inspect emails one, or upload one directly.</p>' +
      uploadBtnHtml + '</div>';
  }
  var latestHtml = active.length ? warrantyReportRowHtml(active[0], buildingId) :
    '<p class="hint">No active report — see previous reports below.</p>';
  var olderActive = active.slice(1);
  var olderAll = olderActive.concat(superseded);
  var olderHtml = olderAll.length ?
    '<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--accent,#1976D2)">Previous Reports (' + olderAll.length + ')</summary>' +
    olderAll.map(function(r){ return warrantyReportRowHtml(r, buildingId); }).join('') + '</details>' : '';
  return '<div class="card"><h2 class="cond">Warranty — Inspection Reports</h2>' +
    latestHtml + olderHtml +
    '<div class="btnrow" style="margin:10px 0 0">' + uploadBtnHtml + '</div></div>';
}
async function viewWarrantyReportPdf(buildingId, storageRef){
  toast("Loading report…");
  try{
    var out = await callInspectionApi({ action: "get_report_pdf", storageRef: storageRef });
    var res = await fetch(out.dataUrl);
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  }catch(e){ toast("Couldn't load report: " + e.message); }
}
function openWarrantyUploadModal(buildingId){
  warrantyUploadBuildingId = buildingId;
  document.getElementById("warranty-upload-file").value = "";
  document.getElementById("warranty-upload-status").textContent = "";
  var fld = document.getElementById("warranty-upload-supersede-fld");
  var sel = document.getElementById("warranty-upload-supersede");
  sel.innerHTML = '<option value="">— New report, don’t replace anything —</option>';
  fld.style.display = "none";
  document.getElementById("warranty-upload-modal").style.display = "";
  lockBodyScroll();
  fdb.collection("buildings").doc(buildingId).collection("warranty_reports")
    .where("status", "==", "active").orderBy("uploadedAt", "desc").limit(20).get().then(function(qs){
      if (qs.empty) return;
      qs.forEach(function(d){
        var r = d.data();
        var opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = (r.inspectionDate || fmtTs(r.uploadedAt)) + " — " + (r.fileName || "Report");
        sel.appendChild(opt);
      });
      fld.style.display = "";
    }).catch(function(){});
}
function closeWarrantyUploadModal(){
  document.getElementById("warranty-upload-modal").style.display = "none";
  unlockBodyScroll();
  warrantyUploadBuildingId = null;
}
function submitWarrantyUpload(){
  var buildingId = warrantyUploadBuildingId;
  var fileInput = document.getElementById("warranty-upload-file");
  var file = fileInput.files && fileInput.files[0];
  var statusEl = document.getElementById("warranty-upload-status");
  if (!buildingId || !file){ statusEl.textContent = "Pick a PDF file first."; return; }
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)){
    statusEl.textContent = "That doesn't look like a PDF."; return;
  }
  statusEl.textContent = "Uploading…";
  var reader = new FileReader();
  reader.onload = async function(){
    try{
      var base64 = String(reader.result).split("base64,")[1] || "";
      var supersedesReportId = document.getElementById("warranty-upload-supersede").value || null;
      var out = await callInspectionApi({
        action: "manual_upload", buildingId: buildingId, fileName: file.name,
        base64: base64, supersedesReportId: supersedesReportId
      });
      var ccNote = out.companyCamUploadStatus === "uploaded" ? " Also saved to CompanyCam ✓" :
        (out.companyCamUploadStatus === "failed" ? " (CompanyCam upload failed: " + out.companyCamUploadError + ")" : "");
      toast("Report uploaded ✓" + ccNote);
      closeWarrantyUploadModal();
      openBuildingHistory(buildingId);
    }catch(e){ statusEl.textContent = "Upload failed: " + e.message; }
  };
  reader.onerror = function(){ statusEl.textContent = "Couldn't read that file."; };
  reader.readAsDataURL(file);
}

var warrantyReviewBuildingCache = null;
function openWarrantyReviewModal(){
  document.getElementById("warranty-review-modal").style.display = "";
  lockBodyScroll();
  renderWarrantyReviewList();
}
function closeWarrantyReviewModal(){
  document.getElementById("warranty-review-modal").style.display = "none";
  unlockBodyScroll();
}
async function warrantyReviewLoadBuildingCache(){
  if (warrantyReviewBuildingCache) return warrantyReviewBuildingCache;
  var qs = await fdb.collection("buildings").orderBy("updatedAt", "desc").limit(300).get();
  var list = [];
  qs.forEach(function(d){
    var v = d.data();
    if (v.archived) return;
    list.push({ id: d.id, name: v.name || "", location: v.location || "" });
  });
  warrantyReviewBuildingCache = list;
  return list;
}
async function renderWarrantyReviewList(){
  var host = document.getElementById("warranty-review-list");
  host.className = "hint"; host.textContent = "Loading…";
  try{
    var out = await callInspectionApi({ action: "list_review_queue" });
    var items = out.items || [];
    if (!items.length){
      host.className = "empty"; host.textContent = "Nothing waiting for review right now.";
      return;
    }
    await warrantyReviewLoadBuildingCache();
    host.className = "";
    host.innerHTML = items.map(function(it){
      return '<div class="evt-item" id="wq-item-' + esc(it.id) + '">' +
        '<div class="evt-head"><span class="evt-tag">' + esc(it.fileName || "Inspection Report") + '</span></div>' +
        '<div class="evt-row">From email: "' + esc(it.sourceEmailSubject || "") + '"</div>' +
        (it.extractedAddress ? '<div class="evt-row">Extracted address: ' + esc(it.extractedAddress) + '</div>' : '') +
        '<div class="evt-row hint">Reason: ' + esc(it.matchReason || "no confident match") + '</div>' +
        '<div class="fld" style="margin:8px 0 0"><input type="text" placeholder="Search building by name or address…" ' +
        'oninput="warrantyReviewFilterBuildings(\'' + esc(it.id) + '\', this.value)" style="width:100%;box-sizing:border-box"></div>' +
        '<div id="wq-results-' + esc(it.id) + '" class="hint" style="margin-top:4px"></div>' +
        '<div class="btnrow" style="margin:8px 0 0"><button class="btn" onclick="viewWarrantyReportPdf(null, \'' + esc(it.storageRef) + '\')">📄 View PDF</button>' +
        '<button class="btn danger" onclick="dismissWarrantyReviewItem(\'' + esc(it.id) + '\')">Dismiss (not a real report)</button></div>' +
        '</div>';
    }).join('');
  }catch(e){ host.className = "empty"; host.textContent = "Couldn’t load the review queue: " + esc(e.message); }
}
function warrantyReviewFilterBuildings(itemId, q){
  var resultsHost = document.getElementById("wq-results-" + itemId);
  if (!resultsHost || !warrantyReviewBuildingCache) return;
  var norm = String(q || "").toLowerCase().trim();
  if (norm.length < 2){ resultsHost.innerHTML = ""; return; }
  var matches = warrantyReviewBuildingCache.filter(function(b){
    return (b.name + " " + b.location).toLowerCase().indexOf(norm) !== -1;
  }).slice(0, 8);
  resultsHost.innerHTML = matches.length ? matches.map(function(b){
    return '<div style="padding:6px 8px;border:1px solid var(--line);border-radius:4px;margin-top:4px;cursor:pointer" ' +
      'onclick="assignWarrantyReviewItem(\'' + esc(itemId) + '\', \'' + esc(b.id) + '\')">' +
      '<b>' + esc(b.name) + '</b><br><span class="hint">' + esc(b.location) + '</span></div>';
  }).join('') : '<span class="hint">No matching buildings.</span>';
}
async function assignWarrantyReviewItem(itemId, buildingId){
  toast("Filing report…");
  try{
    var out = await callInspectionApi({ action: "assign_review_item", itemId: itemId, buildingId: buildingId });
    var ccNote = out.companyCamUploadStatus === "uploaded" ? " Also saved to CompanyCam ✓" : "";
    toast("Filed ✓" + ccNote);
    renderWarrantyReviewList();
  }catch(e){ toast("Couldn't assign: " + e.message); }
}
async function dismissWarrantyReviewItem(itemId){
  if (!confirm("Dismiss this item? It won't be filed anywhere — use this only for junk/false-positive attachments.")) return;
  try{
    await callInspectionApi({ action: "dismiss_review_item", itemId: itemId });
    toast("Dismissed");
    renderWarrantyReviewList();
  }catch(e){ toast("Couldn't dismiss: " + e.message); }
}
async function checkForNewInspectionReports(){
  var statusEl = document.getElementById("warranty-check-status");
  var prevText = statusEl ? statusEl.textContent : "";
  if (statusEl) statusEl.textContent = "Checking mailbox for new inspection reports…";
  try{
    var out = await callInspectionApi({ action: "poll" });
    var s = out.summary;
    var msg = "Checked " + s.checked + " email(s) — filed " + s.filed.length + ", queued " + s.queued.length +
      " for review" + (s.errors.length ? ", " + s.errors.length + " error(s)" : "") + ".";
    if (statusEl) statusEl.textContent = msg;
    toast(msg);
    if (s.queued.length) updateWarrantyReviewBadge();
    if (historyBuildingId && s.filed.some(function(f){ return f.buildingId === historyBuildingId; })){
      openBuildingHistory(historyBuildingId);
    }
  }catch(e){
    if (statusEl) statusEl.textContent = "Check failed: " + e.message;
    toast("Couldn't check for new inspection reports: " + e.message);
  }
}
function updateWarrantyReviewBadge(){
  callInspectionApi({ action: "list_review_queue" }).then(function(out){
    var btn = document.getElementById("warranty-review-btn");
    if (btn) btn.textContent = "📋 Review Queue" + ((out.items || []).length ? " (" + out.items.length + ")" : "");
  }).catch(function(){});
}
/* Bug fix (2026-07-11) -- Mark: "it lets him ADD another roof, but then he
   CAN'T TRACE IT... a dead end." This used to prompt for a name and create
   a bare, empty roof record (roof_outlines: []) right here, then just
   re-render Building History showing that new, permanently-untraceable
   roof -- there was no path from this button into the actual trace flow.
   Fixed by routing straight into RoofMapper's real capture flow instead
   of pre-creating anything: rmEnterMultiRoofCapture() (shared with the
   in-RoofMapper "\u2795 Trace Another Roof" button -- see "Multi-roof: stay in
   RoofMapper, trace another roof" in DEV_NOTES.md) switches to RoofMapper,
   shows this building's already-traced roofs as a dimmed reference layer,
   zooms to them, and leaves him ready to trace outline + Square Up +
   vertex-edit + Calibrate + place features, same as tracing normally. The
   new roof's label is now assigned where it always was for every other
   roof -- the "+ Add a new roof\u2026" picker option at SAVE time
   (rmConfirmSaveToChosenRoof()) -- so there's no longer a way to end up
   with an empty, outline-less roof record from this button at all. */
function promptAddRoof(buildingId){
  rmEnterMultiRoofCapture(buildingId);
}
/* Retroactive recovery pass -- Mark's Tri-Delta case exactly: an
   inspection shot before this feature existed (or before roofs were even
   traced), so every pin/photo landed with its real GPS but no roofId
   (or the building's single default one). Runs the SAME point-in-polygon
   logic live capture uses (rmAssignPointToRoof()) over every already-
   saved GPS-tagged pin for this building, across both `reports` and
   `building_history_events` (same payload, same doc id, updated
   together -- matches every other writer of this pair). Plain client
   write, same tier as an individual pin correction (pinSelectFindingRoof())
   just applied in bulk -- not admin-gated, since it's not moving data
   between buildings, only correcting which roof WITHIN this one building
   each pin belongs to. Capped at the same 50-event fetch window every
   other building-wide query in this app already uses (rmFetchAllRoofsPinsGrouped()
   etc.) -- a real, documented limit, not silently unbounded. See "GPS
   auto-assign photos to roofs" in DEV_NOTES.md. */
/* Shared by rmAutoAssignExistingPinsToRoofs()/backfillMissingHistoryEvents()/
   countFindingsWithoutGps() below -- workorders has no buildingId field of
   its own (see DATA_MODEL.md), so every one of these recomputes the same
   cust_/bld_ slug ensureCustomerAndBuilding() uses at report-save time from
   each candidate's own jobName/billTo, rather than trusting a stored field.
   Capped at the same 100-most-recent-saved window cloudFetchIndex() already
   uses everywhere else in this file. Pure read, no writes. */
async function findBuildingWorkOrderCandidates(buildingId){
  var qs = await fdb.collection("workorders").orderBy("savedAt", "desc").limit(100).get();
  var candidates = [];
  qs.forEach(function(d){
    var v = d.data();
    var bldName = (v.jobName || "").trim();
    if (!bldName) return;
    var custId = (v.billTo || "").trim() ? ("cust_" + slugify(v.billTo.trim())) : null;
    var bldId = "bld_" + slugify((custId || "nocust") + "_" + bldName);
    if (bldId === buildingId) candidates.push({ id: d.id, jobName: bldName, savedAt: v.savedAt || 0 });
  });
  return candidates;
}
/* Splits findBuildingWorkOrderCandidates()'s result into candidates that
   already have a building_history_events doc vs. don't -- one existence
   check per candidate rather than a single big "in" query, since
   Firestore's whereIn caps at 30 values and candidates can exceed that for
   a busy building. Pure read, no writes. */
async function findMissingHistoryEventCandidates(buildingId){
  var candidates = await findBuildingWorkOrderCandidates(buildingId);
  var missing = [];
  for (var i = 0; i < candidates.length; i++){
    var snap = await fdb.collection("building_history_events").doc("evt_" + candidates[i].id).get();
    if (!snap.exists) missing.push(candidates[i]);
  }
  return { candidates: candidates, missing: missing };
}
/* Actually writes the missing events -- separated from the confirm/toast
   UX in backfillMissingHistoryEvents() so rmAutoAssignExistingPinsToRoofs()
   below can call it silently as a pre-step (purely additive, never
   overwrites a real report action -- see the sticky reportType logic in
   logReportAndHistoryEvent() -- same "safe enough to run without asking"
   reasoning as any other quiet autosave in this file). */
async function recoverHistoryEvents(missing){
  var recovered = 0, failed = 0;
  for (var j = 0; j < missing.length; j++){
    try{
      var o = await cloudFetchOrder(missing[j].id);
      if (!o) { failed++; continue; }
      await logReportAndHistoryEvent(o, "Saved", null, undefined);
      recovered++;
    }catch(e){ failed++; }
  }
  return { recovered: recovered, failed: failed };
}
/* Distinguishes "no photos at all" from "photos exist but none carry a
   location" for rmAutoAssignExistingPinsToRoofs()'s error messaging below
   -- Mark: a blanket "no GPS-linked photos" was both wrong (his photos DID
   have GPS, the scan just wasn't finding them -- see the backfill call in
   rmAutoAssignExistingPinsToRoofs()) and unhelpful when it WAS genuinely
   true (didn't say what to do about it). Walks the building's actual
   workorders (not just building_history_events.pins[], which only ever
   holds a finding that already got a pin -- a finding with a photo but NO
   pin at all isn't in that array to be counted) and splits findings/
   checklist items that have at least one photo by whether maybeAutoPinFinding()
   ever fired for them. A finding with a photo but no pin means either the
   photo carries no GPS at all (camera location denied, or a CompanyCam
   import with no location in CompanyCam's own metadata either -- ccImport()
   already uses CompanyCam's own photo.gps when CompanyCam provides it,
   see p.gps in ccImport()) or it predates auto-pin existing. Either way it
   needs a human to place the pin, not another automatic pass -- never
   silently guessed at. */
async function countFindingsWithoutGps(buildingId){
  var candidates = await findBuildingWorkOrderCandidates(buildingId);
  var withGps = 0, withoutGps = 0;
  for (var i = 0; i < candidates.length; i++){
    var o = await cloudFetchOrder(candidates[i].id);
    if (!o) continue;
    var photoFindingIds = {};
    (o.photos || []).forEach(function(p){ if (p.finding_id) photoFindingIds[p.finding_id] = true; });
    (o.findings || []).forEach(function(f){
      if (!photoFindingIds[f.id]) return;
      if (f.pin && typeof f.pin.lat === "number") withGps++; else withoutGps++;
    });
    (o.inspectionChecklist || []).forEach(function(item){
      if (!photoFindingIds[item.id]) return;
      if (item.pin && typeof item.pin.lat === "number") withGps++; else withoutGps++;
    });
  }
  return { withGps: withGps, withoutGps: withoutGps, totalWithPhotos: withGps + withoutGps };
}
async function rmAutoAssignExistingPinsToRoofs(buildingId){
  if (!fdb){ toast("Needs cloud sync (internet connection)."); return; }
  toast("Checking roofs and existing pins…");
  try{
    var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = bldSnap.exists ? bldSnap.data() : {};
    var roofs = getBuildingRoofs(bld);
    if (roofs.length <= 1){ toast("This building only has one roof — nothing to reassign."); return; }
    var hasTracedRoof = roofs.some(function(r){ return (r.roof_outlines || []).length > 0; });
    if (!hasTracedRoof){ toast("None of this building's roofs have a traced outline yet — trace them in RoofMapper first."); return; }

    /* Same root cause as the empty Building History timeline (see
       "Building History on Save" in DEV_NOTES.md): this scan reads pins
       from building_history_events, which used to only get written on a
       PDF Download/Email/Share. A work order Saved but never exported
       (Mark's real Tri-Delta leak report) had photos/pins sitting in
       `workorders` with real GPS but nothing in building_history_events
       for this scan to find, so it wrongly reported "no GPS-linked
       photos" when GPS-linked photos genuinely existed. Silently backfill
       any missing history events first -- no confirm dialog here, unlike
       the explicit "Recover Unlogged Work Orders" button, since this is
       purely additive and never overwrites a real report action -- so the
       scan below sees everything that's actually saved for this building,
       not just whatever happened to get exported. */
    var missingInfo = await findMissingHistoryEventCandidates(buildingId);
    if (missingInfo.missing.length) await recoverHistoryEvents(missingInfo.missing);

    var evtQs = await fdb.collection("building_history_events").where("buildingId", "==", buildingId).limit(50).get();
    var updates = []; /* { id, pins } -- one per event doc that actually changed */
    var reassignedCount = 0, ambiguousCount = 0, uncheckedCount = 0;
    evtQs.forEach(function(d){
      var e = d.data();
      var pins = e.pins || [];
      var changed = false;
      var newPins = pins.map(function(p){
        if (typeof p.lat !== "number" || typeof p.lng !== "number") { uncheckedCount++; return p; }
        var result = rmAssignPointToRoof(p.lat, p.lng, roofs);
        if (!result || !result.roofId) return p;
        if (result.roofId !== p.roofId) { changed = true; reassignedCount++; }
        if (result.ambiguous) ambiguousCount++;
        return Object.assign({}, p, { roofId: result.roofId, roofIdAmbiguous: !!result.ambiguous });
      });
      if (changed) updates.push({ id: d.id, pins: newPins });
    });

    if (!updates.length){
      /* Three real cases behind "nothing to reassign," each needing a
         different message: no photos logged for this building at all;
         photos logged but genuinely none carry a location (needs manual
         assignment, not a repeat of this button); or everything's already
         correctly assigned. */
      var noGpsInfo = await countFindingsWithoutGps(buildingId);
      if (noGpsInfo.totalWithPhotos === 0){
        toast("No photos found for this building yet.");
      } else if (reassignedCount === 0 && uncheckedCount === 0 && noGpsInfo.withGps === 0){
        toast(noGpsInfo.withoutGps + " photo" + (noGpsInfo.withoutGps === 1 ? "" : "s") + " found, but none carry " +
          "location data (e.g. imported from CompanyCam with no GPS of its own) — assign " +
          (noGpsInfo.withoutGps === 1 ? "it" : "them") + " to a roof manually from that finding's pin picker.");
      } else if (noGpsInfo.withoutGps > 0){
        toast("Checked every pin — they’re already on the right roof. " + noGpsInfo.withoutGps + " other photo" +
          (noGpsInfo.withoutGps === 1 ? "" : "s") + " " + (noGpsInfo.withoutGps === 1 ? "has" : "have") +
          " no location data and need" + (noGpsInfo.withoutGps === 1 ? "s" : "") + " manual assignment.");
      } else {
        toast("Checked every pin — they’re already on the right roof, nothing to change.");
      }
      return;
    }
    if (!confirm(updates.length + " report" + (updates.length === 1 ? "" : "s") + " have pins that will move to a " +
      "different roof (" + reassignedCount + " pin" + (reassignedCount === 1 ? "" : "s") + " total" +
      (ambiguousCount ? ", " + ambiguousCount + " flagged for you to double-check — GPS was near a boundary" : "") +
      "). Apply this now? Building History will refresh with the corrected roofs.")) return;

    toast("Reassigning " + reassignedCount + " pins…");
    var batch = fdb.batch();
    updates.forEach(function(u){
      batch.set(fdb.collection("building_history_events").doc(u.id), { pins: u.pins }, { merge: true });
      batch.set(fdb.collection("reports").doc(u.id), { pins: u.pins }, { merge: true });
    });
    await batch.commit();
    toast(reassignedCount + " pin" + (reassignedCount === 1 ? "" : "s") + " reassigned" +
      (ambiguousCount ? " (" + ambiguousCount + " flagged — check the ⚠️ badge on those findings)" : "") + " ✓");
    openBuildingHistory(buildingId);
  }catch(e){ toast("Couldn't auto-assign pins: " + e.message); }
}
/* Manual counterpart to the automatic pass above -- for whatever it flags
   ambiguous/outside-all, or simply gets wrong, lets Mark check several
   pins across ANY past report for this building and move them to the
   right roof in one action, instead of opening each finding's pin picker
   one at a time (pinSelectFindingRoof() already covers that single-pin
   case, but only for a finding on the work order currently open for
   editing -- this reaches every already-saved pin on every past report).
   See "GPS auto-assign photos to roofs" in DEV_NOTES.md. */
var bulkReassignBuildingId = null;
var bulkReassignRows = [];
function openBulkReassignModal(buildingId){
  bulkReassignBuildingId = buildingId;
  renderBulkReassignBody();
  document.getElementById("bulk-reassign-modal").style.display = "";
  lockBodyScroll();
}
function closeBulkReassignModal(){
  document.getElementById("bulk-reassign-modal").style.display = "none";
  unlockBodyScroll();
  bulkReassignBuildingId = null;
}
async function renderBulkReassignBody(){
  var host = document.getElementById("bulk-reassign-body");
  host.innerHTML = '<p class="hint">Loading pins…</p>';
  var bldSnap = await fdb.collection("buildings").doc(bulkReassignBuildingId).get();
  var bld = bldSnap.exists ? bldSnap.data() : {};
  var roofs = getBuildingRoofs(bld);
  var roofLabel = {};
  roofs.forEach(function(r){ roofLabel[r.id] = r.label || "Roof"; });
  var rows = [];
  (historyEvents || []).forEach(function(e){
    (e.pins || []).forEach(function(p, i){
      if (typeof p.lat !== "number" && typeof p.x !== "number") return;
      rows.push({ eventId: e._id, idx: i, roofId: p.roofId || "roof_default",
        ambiguous: !!p.roofIdAmbiguous, label: p.condition || "(finding)",
        date: e.date || "", workOrderNo: e.workOrderNo || "" });
    });
  });
  bulkReassignRows = rows;
  if (!rows.length){
    host.innerHTML = '<p class="hint">No pins on this building yet.</p>';
    return;
  }
  host.innerHTML =
    '<p class="hint" style="margin:0 0 10px">Check the pins that are on the wrong roof, pick where they actually ' +
    'belong, then Apply. For just one pin it’s usually faster to fix it right on that finding’s own pin picker.</p>' +
    '<div style="max-height:40vh;overflow:auto;border:1px solid var(--line);border-radius:6px;margin-bottom:10px">' +
    rows.map(function(r, ri){
      return '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line)">' +
        '<input type="checkbox" data-bulk-idx="' + ri + '">' +
        '<span style="flex:1">' + esc(r.label) + (r.workOrderNo ? ' — Job ' + esc(r.workOrderNo) : '') +
        (r.date ? ' — ' + esc(r.date) : '') + '</span>' +
        '<span class="evt-tag"' + (r.ambiguous ? ' style="background:#FBE2E2;color:#D64545"' : '') + '>' +
        esc(roofLabel[r.roofId] || r.roofId) + (r.ambiguous ? ' ⚠️' : '') + '</span>' +
        '</label>';
    }).join('') +
    '</div>' +
    '<div class="btnrow" style="align-items:center">' +
    '<label style="margin:0">Move checked to:</label>' +
    '<select id="bulk-reassign-target">' +
    roofs.map(function(r){ return '<option value="' + esc(r.id) + '"' +
      (r.id === historySelectedRoofId ? ' selected' : '') + '>' + esc(r.label || "Roof") + '</option>'; }).join('') +
    '</select>' +
    '<button class="btn primary" onclick="applyBulkReassign()">Apply</button>' +
    '</div>';
}
async function applyBulkReassign(){
  var targetRoofId = val("bulk-reassign-target");
  if (!targetRoofId) return;
  var checked = Array.prototype.slice.call(document.querySelectorAll('#bulk-reassign-body [data-bulk-idx]:checked'))
    .map(function(cb){ return bulkReassignRows[+cb.getAttribute("data-bulk-idx")]; });
  if (!checked.length){ toast("Check at least one pin first."); return; }
  var byEvent = {};
  checked.forEach(function(r){ (byEvent[r.eventId] = byEvent[r.eventId] || []).push(r.idx); });
  toast("Reassigning " + checked.length + " pin" + (checked.length === 1 ? "" : "s") + "…");
  try{
    var batch = fdb.batch();
    Object.keys(byEvent).forEach(function(eventId){
      var event = historyEvents.find(function(e){ return e._id === eventId; });
      if (!event) return;
      var idxSet = byEvent[eventId];
      var newPins = (event.pins || []).map(function(p, i){
        if (idxSet.indexOf(i) === -1) return p;
        return Object.assign({}, p, { roofId: targetRoofId, roofIdAmbiguous: false });
      });
      batch.set(fdb.collection("building_history_events").doc(eventId), { pins: newPins }, { merge: true });
      batch.set(fdb.collection("reports").doc(eventId), { pins: newPins }, { merge: true });
    });
    await batch.commit();
    toast(checked.length + " pin" + (checked.length === 1 ? "" : "s") + " reassigned ✓");
    closeBulkReassignModal();
    openBuildingHistory(bulkReassignBuildingId);
  }catch(e){ toast("Couldn't reassign: " + e.message); }
}
/* "Building History on Save" recovery pass -- Mark's real Tri-Delta case:
   a work order Saved (findings, pins, photos, GPS and all) before this
   shipped, but never Downloaded/Emailed/Shared, has NO building_history_events
   doc at all (that write used to be PDF-action-only -- see
   logReportAndHistoryEvent()/saveOrder()). One-time, one-tap recovery for
   whatever's already sitting in `workorders` for this building -- the
   explicit, confirm-first UI version of the same silent pre-step
   rmAutoAssignExistingPinsToRoofs() now runs automatically before its own
   scan (see findMissingHistoryEventCandidates()/recoverHistoryEvents()
   above, shared by both). */
async function backfillMissingHistoryEvents(buildingId){
  if (!fdb){ toast("Needs cloud sync (internet connection)."); return; }
  toast("Checking saved work orders for unlogged reports…");
  try{
    var info = await findMissingHistoryEventCandidates(buildingId);
    if (!info.candidates.length){
      toast("No saved work orders found for this building in the last 100 saved.");
      return;
    }
    if (!info.missing.length){
      toast("Checked " + info.candidates.length + " saved work order" + (info.candidates.length === 1 ? "" : "s") +
        " for this building — every one already has a history entry.");
      return;
    }
    if (!confirm(info.missing.length + " saved work order" + (info.missing.length === 1 ? "" : "s") +
      " for this building " + (info.missing.length === 1 ? "has" : "have") + " no Building History entry yet " +
      "(saved but never Downloaded/Emailed/Shared). Recover " + (info.missing.length === 1 ? "it" : "them") +
      " now?")) return;
    toast("Recovering " + info.missing.length + " report" + (info.missing.length === 1 ? "" : "s") + "…");
    var result = await recoverHistoryEvents(info.missing);
    toast(result.recovered + " report" + (result.recovered === 1 ? "" : "s") + " recovered into Building History" +
      (result.failed ? " (" + result.failed + " couldn't be read — try again)" : "") + " ✓");
    openBuildingHistory(buildingId);
  }catch(e){ toast("Couldn't check for unlogged work orders: " + e.message); }
}
/* A roof's label was previously only ever set once, at promptAddRoof()
   creation time -- no way to fix a typo or rename it later. Same
   prompt-based pattern as promptAddRoof(), pre-filled with the current
   label. See "Individual-roof tracing + labels" in DEV_NOTES.md. */
async function promptRenameRoof(buildingId, roofId){
  toast("Loading roof\u2026");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var roof = roofs.find(function(r){ return r.id === roofId; });
    if (!roof){ toast("Couldn't find that roof."); return; }
    var label = prompt("Rename this roof:", roof.label || "");
    if (label === null) return;
    label = label.trim();
    if (!label){ toast("Enter a name for the roof."); return; }
    label = rmResolveUniqueRoofLabel(roofs, label, roofId);
    if (label === null) return;
    roof.label = label;
    roof.updatedAt = Date.now();
    var idx = roofs.findIndex(function(r){ return r.id === roofId; });
    roofs[idx] = roof;
    await saveBuildingRoofs(buildingId, roofs);
    toast("Roof renamed \u2713");
    openBuildingHistory(buildingId);
  }catch(e){ toast("Couldn't rename roof: " + e.message); }
}
async function deleteHistoryEventAdmin(eventId, buildingId){
  if (!isAdmin){ toast("Admin mode required to delete."); return; }
  if (!confirm("Delete this timeline entry? This can't be undone.")) return;
  toast("Deleting\u2026");
  try{
    await callAdminApi({ action: "delete_history_event", eventId: eventId });
    toast("Deleted \u2713");
    openBuildingHistory(buildingId);
  }catch(e){
    toast("Delete failed: " + e.message);
  }
}

/* ================= all reports (cross-building, read-only) =================
   Phase 4 "Dashboard" seed. reports is a flat, append-only collection
   already written by logReportAndHistoryEvent() on every report — this is
   the first time anything actually reads it. Single query, no where
   clause, so no composite index is needed (unlike building_history_events'
   per-building query). Filtering (search + date range + 4 dropdowns) is
   entirely client-side over that one fetch, same pattern as the Building
   History timeline filters. Read-only — no writes, no admin gating. */
var reportsCache = [];
function rpDistinctSorted(field){
  var set = {};
  reportsCache.forEach(function(r){ var v = (r[field] || "").trim(); if (v) set[v] = true; });
  return Object.keys(set).sort();
}
function populateReportsFilterOptions(){
  [["rp-roof","roofType"], ["rp-tech","technician"], ["rp-warranty","warrantyStatus"],
   ["rp-reporttype","reportType"], ["rp-wotype","workOrderType"]]
    .forEach(function(spec){
      var sel = document.getElementById(spec[0]);
      if (!sel) return;
      var current = sel.value;
      /* Same raw-value / display-label split as populateTimelineFilterOptions()
         above — filterReports() compares the option value against the raw
         stored r.workOrderType. */
      var isWoType = spec[1] === "workOrderType";
      sel.innerHTML = '<option value="">All</option>' + rpDistinctSorted(spec[1]).map(function(v){
        return '<option value="' + esc(v) + '">' + esc(isWoType ? woTypeLabel(v) : v) + '</option>';
      }).join("");
      sel.value = Array.prototype.some.call(sel.options, function(o){ return o.value === current; }) ? current : "";
    });
}
function clearReportsFilters(){
  ["rp-search","rp-from","rp-to","rp-roof","rp-tech","rp-warranty","rp-reporttype","rp-wotype"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.value = "";
  });
  rpRenderList();
}
function filterReports(){
  var q = val("rp-search").trim().toLowerCase();
  var from = val("rp-from"), to = val("rp-to");
  var roof = val("rp-roof"), tech = val("rp-tech"), warranty = val("rp-warranty"), rtype = val("rp-reporttype");
  var wotype = val("rp-wotype");
  var fromTs = from ? new Date(from + "T00:00:00").getTime() : null;
  var toTs = to ? new Date(to + "T23:59:59").getTime() : null;
  return reportsCache.filter(function(r){
    if (q && (r.buildingName || "").toLowerCase().indexOf(q) === -1 &&
      (r.customerName || "").toLowerCase().indexOf(q) === -1) return false;
    if (fromTs !== null && (r.createdAt || 0) < fromTs) return false;
    if (toTs !== null && (r.createdAt || 0) > toTs) return false;
    if (roof && r.roofType !== roof) return false;
    if (tech && r.technician !== tech) return false;
    if (warranty && r.warrantyStatus !== warranty) return false;
    if (rtype && r.reportType !== rtype) return false;
    if (wotype && r.workOrderType !== wotype) return false;
    return true;
  });
}
function rpReportItemHtml(r){
  return '<div class="evt-item" style="cursor:pointer" onclick="rpJumpToBuilding(\'' + (r.buildingId || "") +
    '\')"><div class="evt-head">' +
    '<span class="evt-date">' + esc(r.date || fmtTs(r.createdAt)) + '</span>' +
    '<span class="evt-tag">' + esc(r.reportType || "") + '</span>' +
    (r.workOrderType && r.workOrderType !== WORK_ORDER_TYPES[0] ?
      '<span class="evt-tag" style="background:#FFF3E0;color:#8A5A00">' + esc(woTypeLabel(r.workOrderType)) + '</span>' : '') +
    (r.warrantyStatus ? '<span class="evt-tag">' + esc(r.warrantyStatus) + '</span>' : '') +
    (r.emailSent ? '<span class="evt-tag">Emailed ✓</span>' : '') +
    ccUploadBadgeHtml(r.companyCamUploadStatus) +
    '</div>' +
    '<div class="evt-row"><b>' + esc(r.buildingName || "(unknown building)") + '</b>' +
    (r.customerName ? ' — ' + esc(r.customerName) : '') + '</div>' +
    (r.workOrderNo ? '<div class="evt-row">Job No. ' + esc(r.workOrderNo) + '</div>' : '') +
    (r.technician ? '<div class="evt-row">Technician: ' + esc(r.technician) + '</div>' : '') +
    (r.roofType ? '<div class="evt-row">Roof: ' + esc(r.roofType) + '</div>' : '') +
    (r.emailSent && (r.emailRecipients || []).length ?
      '<div class="evt-row">📧 Emailed to ' + esc(r.emailRecipients.join(", ")) + '</div>' : '') +
    (r.companyCamUploadStatus === "failed" && r.companyCamUploadError ?
      '<div class="evt-row" style="color:#D64545">CompanyCam upload error: ' + esc(r.companyCamUploadError) + '</div>' : '') +
    (r.notes ? '<div class="evt-row">' + esc(r.notes) + '</div>' : '') +
    '</div>';
}
function rpRenderList(){
  var host = document.getElementById("reports-list");
  if (!host) return;
  var filtered = filterReports();
  var countEl = document.getElementById("reports-count");
  if (countEl){
    countEl.textContent = filtered.length === reportsCache.length ?
      "Showing all " + reportsCache.length :
      "Showing " + filtered.length + " of " + reportsCache.length;
  }
  host.innerHTML = filtered.length ?
    filtered.map(rpReportItemHtml).join("") :
    '<div class="empty">No reports match these filters.</div>';
}
function rpJumpToBuilding(buildingId){
  if (!buildingId){ toast("No building linked to this report."); return; }
  showView("history");
  openBuildingHistory(buildingId);
}
async function renderReportsList(){
  var host = document.getElementById("reports-list");
  if (!fdb){
    host.innerHTML = '<div class="empty">Reports need cloud sync (internet connection) to load.</div>';
    return;
  }
  host.innerHTML = '<p class="hint">Loading reports…</p>';
  try{
    var qs = await fdb.collection("reports").orderBy("createdAt", "desc").limit(200).get();
    reportsCache = [];
    qs.forEach(function(d){ reportsCache.push(Object.assign({ _id: d.id }, d.data())); });
    populateReportsFilterOptions();
    rpRenderList();
  }catch(e){
    host.innerHTML = '<div class="empty">Couldn’t load reports: ' + esc(e.message) + '</div>';
  }
}

/* ================= building history logging + CompanyCam PDF persistence =================
   PDF persistence intentionally does NOT use Firebase Storage — CompanyCam
   (via uploadPdfToCompanyCam below) is the system of record for saved PDFs.
   pdfRef on a history event is therefore always null; it's kept in the
   schema in case that changes later. */
/* CompanyCam's v2 API has no direct "attach to project" for arbitrary
   generated files other than its Documents endpoint (base64, ~30MB limit,
   see netlify/functions/companycam.js). If that ever changes shape, this
   is the only place that needs updating. */
async function uploadPdfToCompanyCam(doc, o){
  if (!o.companyCamProjectId) return { skipped: true };
  try{
    var base64 = doc.output("datauristring").split("base64,")[1] || "";
    if (!base64) throw new Error("couldn't encode PDF");
    await ccApiPost({ action: "upload_document", project_id: o.companyCamProjectId,
      name: pdfFileName(), attachment: base64 });
    return { ok: true };
  }catch(e){
    return { ok: false, error: e.message };
  }
}
async function uploadLinkedPdfToCompanyCam(doc, o, doneLabel){
  if (!o.companyCamProjectId) return { skipped: true };
  toast(doneLabel + ". Saving PDF to CompanyCam\u2026");
  var ccUp = await uploadPdfToCompanyCam(doc, o);
  if (ccUp.ok) toast(doneLabel + " \u2014 PDF saved to CompanyCam project \u2713");
  else if (!ccUp.skipped) toast(doneLabel + " \u2014 CompanyCam PDF upload failed: " + ccUp.error);
  return ccUp;
}
function summarizeRows(rows, keyA, keyB){
  return rows.filter(function(r){ return r[keyA] || r[keyB]; })
    .map(function(r){ return r[keyA] + (r[keyB] ? " \u2014 " + r[keyB] : ""); })
    .join("; ").slice(0, 600);
}
/* Saves one history record to both `reports` (per-work-order log) and
   `building_history_events` (per-building timeline) so a future
   building/roof history view can query either. Never blocks or fails
   the user-facing PDF action \u2014 logging errors are swallowed.
   ONE entry per work order (shipped 2026-07-09, replacing a design where
   every download/email/share created its own new entry \u2014 see "One
   timeline entry per work order" in DEV_NOTES.md for the full
   before/after). logReportAndHistoryEvent()'s doc id is now deterministic
   ("evt_" + workOrderId) instead of a random auto-id, so a resend to more
   people, a reshare, or a resave on the same work order upserts the same
   doc instead of inserting a new one \u2014 this also makes it race-safe:
   even two near-simultaneous sends resolve to the same doc id, so the
   result is still exactly one document (a last-write-wins merge), never
   two. createdAt is preserved from the first time a work order is logged
   (so the timeline entry doesn't jump to "just now" every resend);
   updatedAt is new and always reflects the latest action. emailRecipients
   accumulates every distinct address ever sent to (deduped); emailSent is
   sticky-true once set. Everything else (reportType, summaries, warranty,
   pins, CompanyCam refs) is a plain snapshot of the most recent action. */
/* Denormalizes pins onto the history event so the building history map
   (Phase 3) can render from one query across all past reports instead of
   walking every work order. Per pin schema, x/y stay null here — those
   are only meaningful for non-georeferenced base maps (Phase 4). */
function buildPinsForHistoryEvent(o){
  /* Every pin on a work order shares that work order's single roofId
     (see currentRoofId above) — falls back to "roof_default" for a work
     order saved before roofs[] existed, which is always the correct id
     for a building's first/only roof (see getBuildingRoofs/DATA_MODEL.md),
     so this is a no-op for every still-single-roof building. A multi-roof
     Inspection (o.roofIds set) is the one exception -- a finding with its
     OWN f.roofId (set via pinSelectFindingRoof(), see renderPinRoofPicker())
     overrides this shared fallback, so pins correctly split across
     whichever of the selected roofs each finding actually belongs to. */
  var roofId = o.roofId || "roof_default";
  var findingPins = (o.findings || []).filter(function(f){ return f.pin && typeof f.pin.lat === "number"; }).map(function(f){
    return {
      finding_id: f.id, condition: f.condition || "", warranty: f.warranty || "",
      lat: f.pin.lat, lng: f.pin.lng, x: f.pin.x, y: f.pin.y, source: f.pin.source,
      work_order_id: o.id, work_order_no: o.jobNo || "", service_date: o.serviceDate || "",
      photo_ids: (o.photos || []).filter(function(p){ return p.finding_id === f.id && p.ccPhotoId; }).map(function(p){ return p.ccPhotoId; }),
      roofId: f.roofId || roofId
    };
  });
  /* Inspection checklist items pin the same way findings do (their own
     `pin` field, set by maybeAutoPinInspectionItem() on camera capture) --
     included here too so a checklist item's photo shows up on the roof
     map exactly like a finding's would, "reviewable by someone else" per
     Mark, not just saved data with no visible anchor. This is the "before"
     half of before/after-at-a-pin -- see "Inspection checklist photo
     pinning" in DEV_NOTES.md/ROADMAP.md. */
  var checklistPins = (o.inspectionChecklist || []).filter(function(item){ return item.pin && typeof item.pin.lat === "number"; }).map(function(item){
    return {
      finding_id: item.id, condition: inspectionComponentLabel(item.key) + ": " + item.rating, warranty: "",
      lat: item.pin.lat, lng: item.pin.lng, x: item.pin.x, y: item.pin.y, source: item.pin.source,
      work_order_id: o.id, work_order_no: o.jobNo || "", service_date: o.serviceDate || "",
      photo_ids: (o.photos || []).filter(function(p){ return p.finding_id === item.id && p.ccPhotoId; }).map(function(p){ return p.ccPhotoId; }),
      roofId: roofId
    };
  });
  return findingPins.concat(checklistPins);
}
/* ccUploadResult is the return value of uploadLinkedPdfToCompanyCam() —
   { ok:true } | { ok:false, error } | { skipped:true } (no linked
   project) | undefined (this action never attempted an upload, e.g. a
   manually logged activity). Recorded durably (companyCamUploadStatus/
   companyCamUploadError) so the timeline/reports UI can show a persistent
   "saved to CompanyCam" / "not saved" indicator instead of the one-time
   toast being the only signal — see "CompanyCam PDF upload gaps" in
   DEV_NOTES.md. Sticky like emailSent: a call that doesn't pass a result
   (nothing new to report) preserves whatever was already recorded rather
   than overwriting it with "unknown." */
async function logReportAndHistoryEvent(o, kind, emailInfo, ccUploadResult){
  if (!fdb) return;
  try{
    var ids = await ensureCustomerAndBuilding(o);
    /* kind === "Saved" comes from the plain Save button/autosave path (see
       saveOrder()) -- fires on every save of every work order type, long
       before a job name is necessarily filled in yet. Nothing to attach a
       history event to without a building, so skip silently rather than
       writing a buildingId:null record -- a real PDF action (kind !== "Saved")
       already implied a filled-in job name every time this ran before, so
       this guard changes nothing for those call sites. */
    if (!ids.buildingId) return;
    var pdfRef = null; /* no Firebase Storage — see comment above */
    var sharedId = "evt_" + o.id;
    var existing = null;
    try{
      var existingSnap = await fdb.collection("building_history_events").doc(sharedId).get();
      if (existingSnap.exists) existing = existingSnap.data();
    }catch(e){ /* treat as no prior entry — still safe to write a fresh one */ }
    var mergedRecipients = (existing && Array.isArray(existing.emailRecipients)) ? existing.emailRecipients.slice() : [];
    ((emailInfo && emailInfo.to) || []).forEach(function(addr){
      if (mergedRecipients.indexOf(addr) === -1) mergedRecipients.push(addr);
    });
    var ccStatus = (existing && existing.companyCamUploadStatus) || null;
    var ccError = (existing && existing.companyCamUploadError) || "";
    if (ccUploadResult){
      ccStatus = ccUploadResult.ok ? "saved" : (ccUploadResult.skipped ? "not_linked" : "failed");
      ccError = (!ccUploadResult.ok && !ccUploadResult.skipped) ? (ccUploadResult.error || "") : "";
    }
    var nowTs = Date.now();
    var payload = {
      buildingId: ids.buildingId, buildingName: o.jobName || "",
      customerId: ids.customerId, customerName: o.billTo || "",
      workOrderId: o.id, workOrderNo: o.jobNo || "",
      date: o.serviceDate || "", technician: o.technician || "",
      roofId: o.roofId || "roof_default",
      /* Every distinct roof this report's findings actually touch -- null
         for a single-roof case, so this doesn't change the shape of any
         existing event doc. Generalized beyond a multi-select Inspection
         to ANY work order type (reportDistinctRoofIds(), same helper
         renderLeakReportDoc() uses) since GPS auto-assign can give
         findings different roofIds regardless of type. roofId above stays
         the PRIMARY roof for backward compat with every reader that only
         knows the singular field; roofLabels lets Building History's
         timeline show real names instead of raw ids without a lookup (see
         timelineEventHtml()). See "GPS auto-assign photos to roofs" in
         DEV_NOTES.md. */
      roofIds: (function(){ var ids = reportDistinctRoofIds(o); return ids.length > 1 ? ids : null; })(),
      roofLabels: (function(){
        var ids = reportDistinctRoofIds(o);
        return (ids.length > 1 && o.roofLabels) ? ids.map(function(id){ return o.roofLabels[id] || id; }) : null;
      })(),
      workOrderType: o.woType || WORK_ORDER_TYPES[0],
      roofType: o.roofSystem || "",
      /* "Saved" (plain-save path) is deliberately the LOWEST-priority label
         -- never downgrades a real report action (PDF Downloaded/Emailed/
         Shared) that already happened for this work order. A genuine report
         action always overwrites, exactly as before this existed. */
      reportType: kind === "Saved" ? ((existing && existing.reportType) || kind) : kind,
      conditionsSummary: summarizeRows(o.findings || [], "condition", "location"),
      repairsSummary: summarizeRows(o.repairs || [], "repair", "location"),
      warrantyStatus: computeWarrantyStatus(o),
      companyCamProjectId: o.companyCamProjectId || null,
      companyCamPhotoIds: (o.photos || []).filter(function(p){ return p.ccPhotoId; }).map(function(p){ return p.ccPhotoId; }),
      companyCamUploadStatus: ccStatus,   // "saved" | "failed" | "not_linked" | null (never attempted)
      companyCamUploadError: ccError,     // set only when status === "failed"
      pins: buildPinsForHistoryEvent(o),
      pdfRef: pdfRef,
      emailSent: !!(emailInfo && emailInfo.sent) || !!(existing && existing.emailSent),
      emailRecipients: mergedRecipients,
      emailSubject: (emailInfo && emailInfo.subject) || (existing && existing.emailSubject) || "",
      isActivity: false,
      createdAt: (existing && existing.createdAt) || nowTs,
      updatedAt: nowTs
    };
    var batch = fdb.batch();
    batch.set(fdb.collection("reports").doc(sharedId), payload);
    batch.set(fdb.collection("building_history_events").doc(sharedId), payload);
    await batch.commit();
  }catch(e){ console.warn("history log failed", e); }
}

/* ================= manually logged activities =================
   A "log activity" entry is a building history timeline entry that isn't
   tied to a generated PDF report at all — a service call, a drone flight,
   a customer conversation, etc. Deliberately does NOT go through
   logReportAndHistoryEvent()'s evt_<workOrderId> upsert: two activities
   logged close together are genuinely two separate things that happened
   (not a retried Send/Share/Download of the same report), so each gets
   its own random id and is never merged with another. isActivity: true
   distinguishes these from real report entries (isActivity: false above)
   for any code that needs to tell them apart. Written to both `reports`
   (so the cross-building Reports tab/filters pick them up too) and
   `building_history_events` (the per-building timeline), same pairing
   convention as logReportAndHistoryEvent — see DATA_MODEL.md. */
var ACTIVITY_TYPES = ["Service Call", "Leak Investigation", "Repair", "Roof Replacement",
  "Warranty Inspection", "Drone Flight", "Thermal Scan", "Moisture Survey",
  "Customer Conversation", "Note/Other"];
async function logActivityEvent(buildingId, activity){
  if (!fdb) throw new Error("cloud not available");
  var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
  var bld = bldSnap.exists ? bldSnap.data() : {};
  var roof = getRoofById(bld, activity.roofId);
  var id = genId("act");
  var nowTs = Date.now();
  /* Mark: "record BOTH: the event date (when it happened) and the
     entered-at date (when it was added), plus who added it — so the
     record is honest and auditable." date is the real/original date the
     tech picked (may be well in the past, see openActivityModal()'s
     backfill hint); enteredAt/enteredBy capture the truth about THIS
     save action, separately, so a backfilled record never masquerades as
     a live one. enteredBy falls back to technician when left blank (the
     common case: the person entering it IS the technician). See
     "Retroactive backfill: back-dating" in DEV_NOTES.md. */
  var payload = {
    buildingId: buildingId, buildingName: bld.name || "",
    customerId: bld.customerId || null, customerName: bld.customerName || "",
    workOrderId: null, workOrderNo: "",
    date: activity.date || todayStr(), technician: activity.technician || "",
    enteredAt: nowTs, enteredBy: activity.enteredBy || activity.technician || "",
    roofId: roof.id, roofType: roof.roofSystem || "",
    reportType: activity.type, notes: activity.notes || "",
    conditionsSummary: "", repairsSummary: "", warrantyStatus: "",
    /* Existing photos attached while backfilling this record -- see
       attachActivityPhotos()/"ATTACH EXISTING ARTIFACTS... retroactively"
       in DEV_NOTES.md. Empty array for every activity logged before this
       existed, and for the common case of not attaching anything. */
    photos: activity.photos || [],
    companyCamProjectId: null, companyCamPhotoIds: [], pins: [],
    pdfRef: null, emailSent: false, emailRecipients: [], emailSubject: "",
    isActivity: true,
    createdAt: nowTs, updatedAt: nowTs
  };
  var batch = fdb.batch();
  batch.set(fdb.collection("reports").doc(id), payload);
  batch.set(fdb.collection("building_history_events").doc(id), payload);
  await batch.commit();
  return id;
}
var activityModalBuildingId = null;
/* Existing photos attached to the activity currently being logged -- see
   "ATTACH EXISTING ARTIFACTS... retroactively" and
   attachActivityPhotos()/logActivityEvent() below. Each entry:
   {img (base64 data URL)}, same minimal shape work-order photos use
   (caption omitted here -- an activity's own Notes field already covers
   that, no need for a second free-text field per photo). */
var activityPhotos = [];
function attachActivityPhotos(input){
  var files = input.files ? Array.from(input.files) : [];
  input.value = "";
  if (!files.length) return;
  Promise.all(files.map(function(f){ return resizeImageFile(f, 1400, 0.72); })).then(function(dataUrls){
    dataUrls.forEach(function(dataUrl){ activityPhotos.push({ img: dataUrl }); });
    renderActivityPhotosStatus();
    toast(dataUrls.length + " photo" + (dataUrls.length === 1 ? "" : "s") + " attached ✓");
  }).catch(function(e){ toast("Couldn't read one of those photos: " + e.message); });
}
function renderActivityPhotosStatus(){
  var host = document.getElementById("activity-photos-status");
  if (!host) return;
  if (!activityPhotos.length){ host.innerHTML = ""; return; }
  host.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    activityPhotos.map(function(p, i){
      return '<div style="position:relative"><img src="' + p.img + '" style="width:84px;height:84px;object-fit:cover;' +
        'border:1px solid var(--line);border-radius:4px;display:block">' +
        '<button class="btn danger" style="position:absolute;top:2px;right:2px;padding:1px 6px;font-size:11px" ' +
        'onclick="removeActivityPhoto(' + i + ')">✕</button></div>';
    }).join('') + '</div>';
}
function removeActivityPhoto(i){
  activityPhotos.splice(i, 1);
  renderActivityPhotosStatus();
}
/* The rest of the app stores dates as typed "M/D/YY" (see todayStr()),
   but a native <input type="date"> needs ISO "YYYY-MM-DD" — these just
   convert between the two for the activity modal's date field. */
function isoDateFromMDY(mdy){
  var parts = (mdy || "").split("/");
  if (parts.length !== 3) return "";
  var y = parts[2].length === 2 ? "20" + parts[2] : parts[2];
  return y + "-" + ("0" + parts[0]).slice(-2) + "-" + ("0" + parts[1]).slice(-2);
}
function mdyFromIsoDate(iso){
  var parts = (iso || "").split("-");
  if (parts.length !== 3) return "";
  return parseInt(parts[1], 10) + "/" + parseInt(parts[2], 10) + "/" + parts[0].slice(-2);
}
async function openActivityModal(buildingId){
  activityModalBuildingId = buildingId;
  var sel = document.getElementById("activity-type");
  if (!sel.options.length){
    ACTIVITY_TYPES.forEach(function(t){
      var opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      sel.appendChild(opt);
    });
  }
  setVal("activity-date", isoDateFromMDY(todayStr()));
  document.getElementById("activity-technician").value = "";
  document.getElementById("activity-entered-by").value = "";
  document.getElementById("activity-notes").value = "";
  activityPhotos = [];
  renderActivityPhotosStatus();
  document.getElementById("activity-modal").style.display = "";
  lockBodyScroll();
  /* Only worth mentioning which roof this logs to once a building
     actually has more than one — a single-roof building's modal stays
     exactly as simple as the rest of this feature. */
  var hint = document.getElementById("activity-roof-hint");
  hint.textContent = "";
  try{
    var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
    var roofs = getBuildingRoofs(bldSnap.exists ? bldSnap.data() : {});
    if (roofs.length > 1){
      var roof = getRoofById(bldSnap.data(), historySelectedRoofId);
      hint.textContent = "Logging for: " + (roof.label || "Roof");
    }
  }catch(e){ /* non-critical — save still defaults correctly without this hint */ }
}
function closeActivityModal(){
  document.getElementById("activity-modal").style.display = "none";
  unlockBodyScroll();
  activityModalBuildingId = null;
}
async function saveActivityFromModal(){
  if (!activityModalBuildingId) return;
  var buildingId = activityModalBuildingId;
  var isoDate = val("activity-date");
  var activity = {
    type: val("activity-type"),
    date: isoDate ? mdyFromIsoDate(isoDate) : todayStr(),
    technician: val("activity-technician").trim(),
    enteredBy: val("activity-entered-by").trim(),
    notes: val("activity-notes").trim(),
    photos: activityPhotos.slice(),
    /* Logs to whichever roof is currently showing in Building History —
       defaults to the building's first roof (see historySelectedRoofId),
       so a single-roof building's activities need no extra picker. */
    roofId: historySelectedRoofId
  };
  toast("Saving activity…");
  try{
    await logActivityEvent(buildingId, activity);
    toast("Activity logged ✓");
    closeActivityModal();
    openBuildingHistory(buildingId);
  }catch(e){ toast("Couldn't log activity: " + e.message); }
}

/* Durable, VISIBLE "email sent" marker on the work order itself — separate
   from logReportAndHistoryEvent()'s history-timeline entry, which is real
   and durable but easy to miss unless you already know to open Building
   History -> the right building -> scroll the timeline. This is a small
   merge-only patch on the workorders doc (lastEmailedAt/lastEmailedTo) so
   the Saved tab list — the page both office and techs already use to find
   a work order — shows it directly, no digging required. Fire-and-forget
   from sendEmailNow(): never blocks the send confirmation, and a failure
   here doesn't mean the email didn't send (logReportAndHistoryEvent's
   history entry above is the durable record of record either way). */
async function markWorkOrderEmailed(workOrderId, addrs){
  var when = Date.now();
  try{
    var db = loadDb();
    var entry = db.index.find(function(e){ return e.id === workOrderId; });
    if (entry){ entry.lastEmailedAt = when; entry.lastEmailedTo = addrs; saveDb(db); }
    var cloudEntry = cloudIndexCache.find(function(e){ return e.id === workOrderId; });
    if (cloudEntry){ cloudEntry.lastEmailedAt = when; cloudEntry.lastEmailedTo = addrs; }
    drawSaved();
  }catch(e){ console.warn("local emailed-marker update failed", e); }
  if (!fdb) return;
  try{
    await fdb.collection("workorders").doc(workOrderId).set(
      { lastEmailedAt: when, lastEmailedTo: addrs }, { merge: true });
  }catch(e){ console.warn("cloud emailed-marker update failed", e); }
}

async function downloadPdf(){
  toast("Building PDF\u2026");
  var d = await generatePdf();
  if (!d) return;
  d.save(pdfFileName());
  var o = collect();
  /* Previously the one PDF-producing action that never saved to
     CompanyCam at all, even when the work order was linked \u2014 see
     "CompanyCam PDF upload gaps" in DEV_NOTES.md. Now matches Send/Share. */
  var ccUp = await uploadLinkedPdfToCompanyCam(d, o, "PDF downloaded");
  if (!o.companyCamProjectId) toast("PDF downloaded \u2014 attach it to your email.");
  logReportAndHistoryEvent(o, "PDF Downloaded", null, ccUp);
}
async function sendEmailNow(){
  var addrs = parseEmailRecipients(val("emailTo"));
  if (!addrs.length){
    toast("Pick someone from the Send to list (or type an email) first.");
    return;
  }
  toast("Saving work order\u2026");
  if (!(await autoSaveBeforeReport("sending email"))) return;
  toast("Building PDF\u2026");
  var d = await generatePdf();
  if (!d) return;
  toast("Sending email\u2026");
  var o = collect();
  var isCO = o.woType === "Change Order";
  var subject = emailTypeSubject(o.woType) + " \u2014 " + (o.jobName || "Job") +
    (o.jobNo ? " #" + o.jobNo : "") + (o.location ? " (" + o.location + ")" : "");
  var body = (isCO ?
      "Change order documentation for " + (o.jobName || "the job") +
      (o.jobNo ? " (Job No. " + o.jobNo + ")" : "") + " is attached as a PDF." :
      emailTypeNoun(o.woType) + " documentation for " + (o.jobName || "the job") +
      (o.jobNo ? " (Job No. " + o.jobNo + ")" : "") + " is attached as a PDF, including photo documentation.") +
    "\n\nDate of Service: " + (o.serviceDate || "") +
    "\nLocation: " + (o.location || "") +
    "\n\nSent from the RoofOps app.";
  var pdfBase64 = "";
  try{ pdfBase64 = d.output("datauristring").split("base64,")[1] || ""; }catch(e){}
  if (!pdfBase64){ toast("Couldn't prepare the PDF for sending \u2014 try Download PDF instead."); return; }
  try{
    var resp = await fetch("/.netlify/functions/send-workorder", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ to: addrs, subject: subject, body: body,
        filename: pdfFileName(), pdfBase64: pdfBase64, jobNo: o.jobNo || "" })
    });
    var out = null;
    try{ out = await resp.json(); }catch(e){}
    if (resp.ok && out && out.ok){
      markWorkOrderEmailed(o.id, addrs);
      rememberEmailRecipients(addrs);
      var ccUp = { skipped: true };
      if (o.companyCamProjectId){
        ccUp = await uploadLinkedPdfToCompanyCam(d, o, "Email sent \u2713");
      } else {
        toast("Email sent \u2713 to " + addrs.join(", "));
      }
      await logReportAndHistoryEvent(o, "PDF Emailed", { sent: true, to: addrs, subject: subject }, ccUp);
    } else {
      toast("Send failed: " + ((out && out.error) || ("server error " + resp.status)));
    }
  }catch(e){
    toast("Couldn't reach the send service \u2014 this button only works from your Netlify site with internet. Use Share / Email PDF as backup.");
  }
}
async function sharePdf(){
  toast("Saving work order\u2026");
  if (!(await autoSaveBeforeReport("sharing email"))) return;
  var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.userAgentData && navigator.userAgentData.mobile);
  if (!isMobile){
    /* Open the email app before building the PDF so desktop browsers do not block it. */
    var o = collect();
    var subject = emailTypeSubject(o.woType) + " \u2014 " + (o.jobName || "Job") +
      (o.jobNo ? " #" + o.jobNo : "") + (o.location ? " (" + o.location + ")" : "");
    var body = emailTypeNoun(o.woType) + " documentation for " + (o.jobName || "the job") +
      (o.jobNo ? " (Job No. " + o.jobNo + ")" : "") +
      " is attached as a PDF, including photo documentation." +
      "\n\nDate of Service: " + (o.serviceDate || "") +
      "\nLocation: " + (o.location || "");
    var addrList = parseEmailRecipients(val("emailTo"));
    var alreadyHasBcc = addrList.some(function(a){ return a.toLowerCase() === EMAIL_ALWAYS_BCC.toLowerCase(); });
    var addrs = addrList.map(encodeURIComponent).join(",");
    window.location.href = "mailto:" + addrs +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body) +
      (alreadyHasBcc ? "" : "&bcc=" + encodeURIComponent(EMAIL_ALWAYS_BCC));
  }
  toast("Building PDF\u2026");
  var d = await generatePdf();
  if (!d) return;
  var o = collect();
  var fname = pdfFileName();
  if (isMobile){
    try{
      var blob = d.output("blob");
      var file = new File([blob], fname, { type: "application/pdf" });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], title: fname });
        var ccUp1 = await uploadLinkedPdfToCompanyCam(d, o, "PDF shared");
        await logReportAndHistoryEvent(o, "PDF Shared", null, ccUp1);
        return;
      }
    }catch(e){
      if (e && e.name === "AbortError") return; /* user closed the share sheet */
    }
    d.save(fname);
    var ccUp2 = await uploadLinkedPdfToCompanyCam(d, o, "PDF downloaded");
    await logReportAndHistoryEvent(o, "PDF Shared", null, ccUp2);
    if (!o.companyCamProjectId) toast("Sharing isn't supported on this device \u2014 PDF downloaded instead. Attach it to your email.");
    return;
  }
  d.save(fname);
  var ccUp3 = await uploadLinkedPdfToCompanyCam(d, o, "PDF downloaded");
  await logReportAndHistoryEvent(o, "PDF Shared", null, ccUp3);
  if (!o.companyCamProjectId) toast("PDF downloaded \u2014 drag it from Downloads into the email that just opened, then send.");
}

