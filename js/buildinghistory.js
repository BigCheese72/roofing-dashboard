/* ================= Building History (extracted from js/workorders.js) =================
   PURE MOVE -- Phase 1 of the workorders.js split (docs/agents/WORKORDERS_SPLIT_PLAN.md).
   Not one line of logic changed; only the file this code lives in.

   Why this block and not a work-order TYPE: Leak/Change Order/Inspection/
   Repair/Warranty are five display-gated variants of ONE form (see
   onWoTypeChange() in js/core.js), so splitting by type would move almost
   nothing. Building History was the one genuinely independent subsystem
   sitting inside workorders.js -- ~1,000 lines of it.

   It also fixes a real load-order smell: js/history.js calls
   renderBuildingMap(), which used to live in js/workorders.js -- a file that
   loads AFTER it. That only worked because the call happens at runtime. This
   file now loads BEFORE js/history.js, so the dependency runs the right way.

   Contains: the inline building-history card on the work-order form, the
   duplicate-building detection, Buildings Near Me, renderHistoryList(), the
   building admin archive/unarchive/delete actions, and the shared Leaflet
   building-map renderer. */

/* ================= inline building history on work orders =================
   Read-only companion to the full Building History page. It uses the same
   building id derivation and the same building_history_events query shape,
   but stays inside the current Leak / Inspection / Repair work order so a
   tech can review prior leaks, inspections, repairs, pins, and the base roof
   map without navigating away from the job they are writing. */
var woInlineHistorySeq = 0, woInlineHistoryTimer = null, woInlineHistoryListenersInstalled = false,
  woInlineHistoryBoundListeners = {}, woInlineHistoryHideExistingPins = false;
function woInlineHistorySupportedType(){
  var t = val("woType") || WORK_ORDER_TYPES[0];
  return t === WORK_ORDER_TYPES[0] || t === "Inspection" || t === "Repair";
}
function ensureInlineBuildingHistoryCard(){
  var existing = document.getElementById("wo-inline-history-card");
  if (existing){
    installInlineBuildingHistoryListeners();
    return existing;
  }
  var editView = document.getElementById("view-edit");
  if (!editView) return null;
  var card = document.createElement("div");
  card.className = "card";
  card.id = "wo-inline-history-card";
  card.style.display = "none";
  card.innerHTML =
    '<h2 class="cond">Building History</h2>' +
    '<div id="wo-inline-history-body"><p class="hint">Loading building history...</p></div>';
  var ref = document.getElementById("wo-inspection-card") || document.getElementById("wo-findings-card");
  editView.insertBefore(card, ref || editView.children[1] || null);
  installInlineBuildingHistoryListeners();
  return card;
}
function installInlineBuildingHistoryListeners(){
  if (woInlineHistoryListenersInstalled) return;
  var ids = ["jobName", "billTo", "woType", "roofSystem"];
  ids.forEach(function(id){
    if (woInlineHistoryBoundListeners[id]) return;
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(id === "woType" ? "change" : "blur", scheduleInlineBuildingHistoryRefresh);
    woInlineHistoryBoundListeners[id] = true;
  });
  woInlineHistoryListenersInstalled = ids.every(function(id){ return woInlineHistoryBoundListeners[id]; });
}
function scheduleInlineBuildingHistoryRefresh(){
  ensureInlineBuildingHistoryCard();
  if (woInlineHistoryTimer) clearTimeout(woInlineHistoryTimer);
  woInlineHistoryTimer = setTimeout(refreshInlineBuildingHistory, 80);
}
function inlineBuildingIdFromCurrentFields(){
  return currentWorkOrderBuildingId();
}
async function lookupInlineBuildingContext(){
  if (!fdb) return null;
  var buildingId = inlineBuildingIdFromCurrentFields();
  if (!buildingId) return null;
  var snap = await fdb.collection("buildings").doc(buildingId).get();
  var bld = snap.exists ? snap.data() : {};
  return {
    buildingId: buildingId,
    exists: snap.exists,
    building: bld,
    roofs: getBuildingRoofs(bld)
  };
}
function inlineSelectedRoofId(roofs){
  roofs = roofs || [];
  if (currentRoofId && roofs.some(function(r){ return r.id === currentRoofId; })) return currentRoofId;
  if (currentRoofIds && currentRoofIds.length){
    var selected = roofs.find(function(r){ return currentRoofIds.indexOf(r.id) !== -1; });
    if (selected) return selected.id;
  }
  return roofs[0] ? roofs[0].id : "roof_default";
}
function inlineRoofById(ctx, roofId){
  return (ctx.roofs || []).find(function(r){ return r.id === roofId; }) ||
    (ctx.roofs && ctx.roofs[0]) || getRoofById(ctx.building || {}, roofId);
}
function inlineRoofHasBaseMap(roof){
  return !!(roof && roof.roof_base_map_url &&
    (roof.roof_base_map_type === "roof_plan" || roof.roof_base_map_type === "sketch" ||
     (roof.roof_base_map_type === "drone_ortho" && roof.roof_base_map_bounds)));
}
function inlineRoofHasGeoreferencedBaseMap(roof){
  return !!(roof && roof.roof_base_map_url &&
    roof.roof_base_map_type === "drone_ortho" && roof.roof_base_map_bounds);
}
function inlineRoofHasSyntheticOrthoBaseMap(roof){
  return !!(roof && roof.roof_base_map_url &&
    roof.roof_base_map_type === "sketch" && roof.roof_base_map_synthetic);
}
function inlineValidComputedOrthoBounds(bounds){
  return !!bounds &&
    Number.isFinite(Number(bounds.north)) && Number.isFinite(Number(bounds.south)) &&
    Number.isFinite(Number(bounds.east)) && Number.isFinite(Number(bounds.west)) &&
    Number(bounds.north) !== Number(bounds.south) && Number(bounds.east) !== Number(bounds.west);
}
async function inlineSyntheticOrthoOverlay(roof){
  if (!inlineRoofHasSyntheticOrthoBaseMap(roof)) return null;
  if (typeof rmComputeOrthoBoundsForImageUrl !== "function") return null;
  try{
    var computed = await rmComputeOrthoBoundsForImageUrl(roof.roof_base_map_url);
    var bounds = computed && computed.orthoBounds;
    if (!inlineValidComputedOrthoBounds(bounds)) return null;
    return { url: roof.roof_base_map_url, bounds: bounds };
  }catch(e){
    console.warn("Could not compute inline synthetic RoofMapper ortho bounds.", e);
    return null;
  }
}
async function inlineFirstOtherRoofWithSyntheticOrthoOverlay(roofs, selectedRoofId){
  roofs = roofs || [];
  for (var i = 0; i < roofs.length; i++){
    var roof = roofs[i];
    if (!roof || roof.id === selectedRoofId) continue;
    var orthoOverlay = await inlineSyntheticOrthoOverlay(roof);
    if (orthoOverlay) return { roof: roof, orthoOverlay: orthoOverlay };
  }
  return null;
}
async function inlineResolveBuildingBaseMap(roofs, selectedRoofId){
  roofs = roofs || [];
  var selectedRoof = roofs.find(function(r){ return r.id === selectedRoofId; }) || roofs[0] || null;
  var base = {
    selectedRoof: selectedRoof,
    sourceRoof: null,
    fromSelectedRoof: false,
    customBld: null,
    orthoOverlay: null,
    syntheticOrtho: false
  };
  if (!inlineRoofHasBaseMap(selectedRoof)){
    var siblingOrtho = inlineFirstOtherRoofWithGeoreferencedBaseMap(roofs, selectedRoofId);
    if (siblingOrtho){
      base.sourceRoof = siblingOrtho;
      base.orthoOverlay = { url: siblingOrtho.roof_base_map_url, bounds: siblingOrtho.roof_base_map_bounds };
      return base;
    }
    var siblingSyntheticOrtho = await inlineFirstOtherRoofWithSyntheticOrthoOverlay(roofs, selectedRoofId);
    if (siblingSyntheticOrtho){
      base.sourceRoof = siblingSyntheticOrtho.roof;
      base.orthoOverlay = siblingSyntheticOrtho.orthoOverlay;
      return base;
    }
    return base;
  }
  base.sourceRoof = selectedRoof;
  base.fromSelectedRoof = true;
  if (selectedRoof.roof_base_map_type === "drone_ortho" && selectedRoof.roof_base_map_bounds){
    base.orthoOverlay = { url: selectedRoof.roof_base_map_url, bounds: selectedRoof.roof_base_map_bounds };
    return base;
  }
  var selectedSyntheticOrtho = await inlineSyntheticOrthoOverlay(selectedRoof);
  if (selectedSyntheticOrtho){
    base.orthoOverlay = selectedSyntheticOrtho;
    return base;
  }
  base.syntheticOrtho = !!inlineRoofHasSyntheticOrthoBaseMap(selectedRoof);
  base.customBld = selectedRoof;
  return base;
}
function inlineFirstOtherRoofWithBaseMap(roofs, selectedRoofId){
  return (roofs || []).find(function(r){
    return r && r.id !== selectedRoofId && inlineRoofHasBaseMap(r);
  }) || null;
}
function inlineFirstOtherRoofWithGeoreferencedBaseMap(roofs, selectedRoofId){
  return (roofs || []).find(function(r){
    return r && r.id !== selectedRoofId && inlineRoofHasGeoreferencedBaseMap(r);
  }) || null;
}
function inlineNoBaseMapNotice(roofs, selectedRoofId, selectedRoof){
  selectedRoof = selectedRoof || (roofs || []).find(function(r){ return r.id === selectedRoofId; }) || (roofs && roofs[0]) || null;
  if (inlineRoofHasBaseMap(selectedRoof)) return "";
  var siblingRoof = inlineFirstOtherRoofWithBaseMap(roofs, selectedRoofId);
  if (!siblingRoof) return "No base map has been drawn for this building yet.";
  return "No base map drawn for " + ((selectedRoof && selectedRoof.label) || "this roof") + ". " +
    ((siblingRoof && siblingRoof.label) || "Another roof") + " has one - switch roofs to view it.";
}
function inlineHistoryMapLabel(hasCustomBaseMap, orthoOverlay, baseMap, mapRoof){
  baseMap = baseMap || {};
  var sourceRoofLabel = (baseMap.sourceRoof && baseMap.sourceRoof.label) || (mapRoof && mapRoof.label) || "Roof";
  if (hasCustomBaseMap){
    return 'Roof map using <b>' + esc(sourceRoofLabel) + '</b>\'s saved base image' +
      (baseMap.syntheticOrtho ? ' (RoofMapper image, not georeferenced).' : '.');
  }
  if (orthoOverlay && baseMap.sourceRoof && !baseMap.fromSelectedRoof){
    return 'Base map from <b>' + esc(sourceRoofLabel) + '</b> (building-wide).';
  }
  return 'Building-wide roof map' + (orthoOverlay ? ' on the saved drone orthophoto.' : '.');
}
function inlineAllHistoryPins(events){
  var allPins = [];
  (events || []).forEach(function(e, eventIndex){ (e.pins || []).forEach(function(p, pinIndex){
    p = p || {};
    allPins.push(Object.assign({}, p, {
      eventDate: e.date,
      _inlineKey: eventIndex + ":" + pinIndex
    }));
  }); });
  return allPins;
}
function inlineHistorySetCoverage(full, rendered, disclosureFn){
  var shown = {};
  rendered.forEach(function(item){ shown[item._inlineKey] = true; });
  var disclosed = full.filter(function(item){ return !shown[item._inlineKey]; });
  return {
    full: full,
    rendered: rendered,
    disclosed: disclosed,
    disclosure: disclosureFn ? disclosureFn(disclosed) : ""
  };
}
function setWoInlineHistoryHideExistingPins(checked){
  woInlineHistoryHideExistingPins = !!checked;
  refreshInlineBuildingHistory();
}
function inlineHistoryHiddenSessionPinDisclosure(disclosedPins){
  var count = (disclosedPins || []).length;
  if (!count) return "";
  return count + " existing pin" + (count === 1 ? "" : "s") +
    " hidden for this Inspection session.";
}
function inlineHistoryHiddenSessionPinCoverage(fullPins){
  return inlineHistorySetCoverage(fullPins || [], [], inlineHistoryHiddenSessionPinDisclosure);
}
function inlineHistoryPinToggleHtml(isInspection, pinCount, hideExistingPins){
  if (!isInspection || !pinCount) return "";
  return '<label class="hint" style="display:inline-flex;align-items:center;gap:6px;margin:0 0 8px">' +
    '<input type="checkbox" ' + (hideExistingPins ? 'checked ' : '') +
    'onchange="setWoInlineHistoryHideExistingPins(this.checked)">Hide existing pins</label>';
}
function inlineHistoryPinCoverage(events, roofId, hasCustomBaseMap){
  var full = inlineAllHistoryPins(events);
  var rendered = full.filter(function(p){
    var pinRoofId = p.roofId || "roof_default";
    return hasCustomBaseMap ?
      (pinRoofId === roofId && typeof p.x === "number" && typeof p.y === "number") :
      (typeof p.lat === "number" && typeof p.lng === "number");
  });
  return inlineHistorySetCoverage(full, rendered, function(disclosed){
    return inlineHiddenPinDisclosure(disclosed, roofId, hasCustomBaseMap);
  });
}
function inlineHistoryPinsForMap(events, roofId, hasCustomBaseMap){
  return inlineHistoryPinCoverage(events, roofId, hasCustomBaseMap).rendered;
}
function inlineHiddenPinDisclosure(disclosedPins, roofId, hasCustomBaseMap){
  var hiddenGps = 0, hiddenOtherRoof = 0, hiddenUnassigned = 0, hiddenXY = 0, hiddenNoLocation = 0;
  /* Pins are written in either x/y image space or lat/lng GPS space. These
     checks keep the disclosure tied to the stored coordinate frame. */
  (disclosedPins || []).forEach(function(p){
    var pinRoofId = p.roofId || "roof_default";
    var hasXY = typeof p.x === "number" && typeof p.y === "number";
    var hasGps = typeof p.lat === "number" && typeof p.lng === "number";
    if (!hasXY && !hasGps) hiddenNoLocation++;
    else if (!hasCustomBaseMap && hasXY) hiddenXY++;
    else if (pinRoofId === "roof_default" && roofId !== "roof_default") hiddenUnassigned++;
    else if (pinRoofId !== roofId) hiddenOtherRoof++;
    else if (hasCustomBaseMap && hasGps) hiddenGps++;
  });
  var notes = [];
  if (hiddenOtherRoof) notes.push(hiddenOtherRoof + " finding" + (hiddenOtherRoof === 1 ? "" : "s") +
    " pinned to other roofs " + (hiddenOtherRoof === 1 ? "is" : "are") + " not shown here");
  if (hiddenUnassigned) notes.push(hiddenUnassigned + " legacy unassigned finding" + (hiddenUnassigned === 1 ? "" : "s") +
    " " + (hiddenUnassigned === 1 ? "needs" : "need") + " roof assignment from the bulk-reassign pass before " +
    (hiddenUnassigned === 1 ? "it can" : "they can") + " be shown on this roof");
  if (hiddenGps) notes.push(hiddenGps + " GPS-placed finding" + (hiddenGps === 1 ? "" : "s") +
    " can't be shown on a non-georeferenced drawing");
  if (hiddenXY) notes.push(hiddenXY + " image-placed finding" + (hiddenXY === 1 ? "" : "s") +
    " can't be shown on the satellite map");
  if (hiddenNoLocation) notes.push(hiddenNoLocation + " finding" + (hiddenNoLocation === 1 ? "" : "s") +
    " " + (hiddenNoLocation === 1 ? "has" : "have") + " no saved location");
  return notes.length ? notes.join(". ") + "." : "";
}
function inlineAllRoofAssets(roofs){
  var allAssets = [];
  (roofs || []).forEach(function(r, roofIndex){
    (r.roof_assets || []).forEach(function(a, assetIndex){
      a = a || {};
      allAssets.push(Object.assign({}, a, {
        _roofId: r.id || "roof_default",
        _roofLabel: r.label || "Roof",
        _roofBaseMapSynthetic: !!r.roof_base_map_synthetic,
        _roofBaseMapType: r.roof_base_map_type || null,
        _inlineKey: roofIndex + ":" + assetIndex
      }));
    });
  });
  return allAssets;
}
function inlineHistoryAssetCoverage(roofs, roof, hasCustomBaseMap){
  roof = roof || {};
  var selectedRoofId = roof.id || "roof_default";
  var full = inlineAllRoofAssets(roofs);
  var rendered = full.filter(function(a){
    return hasCustomBaseMap ?
      (a._roofId === selectedRoofId && typeof a.x === "number" && typeof a.y === "number") :
      (typeof a.lat === "number" && typeof a.lng === "number");
  });
  return inlineHistorySetCoverage(full, rendered, function(disclosed){
    return inlineHiddenAssetDisclosure(disclosed, selectedRoofId, hasCustomBaseMap);
  });
}
function inlineHiddenAssetDisclosure(disclosedAssets, roofId, hasCustomBaseMap){
  var hiddenGps = 0, hiddenOtherRoof = 0, hiddenXY = 0, hiddenNoLocation = 0;
  (disclosedAssets || []).forEach(function(a){
    var hasXY = typeof a.x === "number" && typeof a.y === "number";
    var hasGps = typeof a.lat === "number" && typeof a.lng === "number";
    if (!hasXY && !hasGps) hiddenNoLocation++;
    else if (!hasCustomBaseMap && hasXY) hiddenXY++;
    /* Other-roof disclosure applies only to selected-roof image maps. Satellite
       mode renders GPS assets building-wide, so remaining satellite misses are
       x/y-only image features caught above. */
    else if (a._roofId !== roofId) hiddenOtherRoof++;
    else if (hasCustomBaseMap && hasGps) hiddenGps++;
  });
  var notes = [];
  if (hiddenOtherRoof) notes.push(hiddenOtherRoof + " feature" + (hiddenOtherRoof === 1 ? "" : "s") +
    " from other roofs " + (hiddenOtherRoof === 1 ? "is" : "are") + " not shown here");
  if (hiddenGps) notes.push(hiddenGps + " GPS-placed feature" + (hiddenGps === 1 ? "" : "s") +
    " can't be shown on a non-georeferenced drawing");
  if (hiddenXY) notes.push(hiddenXY + " image-placed feature" + (hiddenXY === 1 ? "" : "s") +
    " can't be shown on the satellite map");
  if (hiddenNoLocation) notes.push(hiddenNoLocation + " feature" + (hiddenNoLocation === 1 ? "" : "s") +
    " " + (hiddenNoLocation === 1 ? "has" : "have") + " no saved location");
  return notes.length ? notes.join(". ") + "." : "";
}
function inlineHistoryAssetsForMap(roofs, roof, hasCustomBaseMap){
  return inlineHistoryAssetCoverage(roofs, roof, hasCustomBaseMap).rendered;
}
function inlineHistoryMapHtml(hasMapVisual, mapLabel, noBaseMapNotice, hiddenDisclosure){
  if (!hasMapVisual && !noBaseMapNotice && !hiddenDisclosure){
    return '<p class="hint">No saved roof base map, outline, feature, or pin is available for this building yet.</p>';
  }
  return '<div style="margin:8px 0 12px">' +
    (hasMapVisual ? '<p class="hint" style="margin:0 0 6px">' + mapLabel + '</p>' : '') +
    (noBaseMapNotice ? '<p class="hint" style="margin:0 0 6px;color:#8A5A00">' + esc(noBaseMapNotice) + '</p>' : '') +
    (hiddenDisclosure ? '<p class="hint" style="margin:0 0 6px;color:#8A5A00">' + esc(hiddenDisclosure) + '</p>' : '') +
    (hasMapVisual ? '<div id="wo-inline-building-map" style="height:min(38vh,320px);border-radius:6px;overflow:hidden;border:1px solid var(--line)"></div>' : '') +
  '</div>';
}
function inlineHistoryOutlines(roofs, hasCustomBaseMap, selectedRoof){
  if (hasCustomBaseMap){
    var selectedOutlines = (selectedRoof && selectedRoof.roof_outlines) || [];
    var selectedLatest = selectedOutlines[selectedOutlines.length - 1];
    return selectedLatest ? [Object.assign({}, selectedLatest, {
      _roofLabel: selectedRoof.label || "Roof",
      _roofLabelPos: selectedRoof.labelPos || null,
      _roofBaseMapSynthetic: !!selectedRoof.roof_base_map_synthetic,
      _roofBaseMapType: selectedRoof.roof_base_map_type || null
    })] : [];
  }
  return (roofs || []).reduce(function(acc, r){
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
}
async function refreshInlineBuildingHistory(){
  var card = ensureInlineBuildingHistoryCard();
  if (!card) return;
  if (!woInlineHistorySupportedType()){
    card.style.display = "none";
    return;
  }
  var body = document.getElementById("wo-inline-history-body");
  var jobName = (val("jobName") || "").trim();
  if (!jobName){
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  if (!fdb){
    body.innerHTML = '<p class="hint">Building history needs cloud sync to load prior reports and roof maps.</p>';
    return;
  }
  var seq = ++woInlineHistorySeq;
  body.innerHTML = '<p class="hint">Loading building history...</p>';
  try{
    var ctx = await lookupInlineBuildingContext();
    if (seq !== woInlineHistorySeq) return;
    if (!ctx){
      card.style.display = "none";
      return;
    }
    var events = (typeof loadBuildingHistoryEvents === "function") ?
      await loadBuildingHistoryEvents(ctx.buildingId, 50) : [];
    if (seq !== woInlineHistorySeq) return;
    var roofId = inlineSelectedRoofId(ctx.roofs);
    var roof = inlineRoofById(ctx, roofId);
    var baseMap = await inlineResolveBuildingBaseMap(ctx.roofs, roofId);
    var mapRoof = roof;
    var mapRoofId = roofId;
    var hasCustomBaseMap = !!baseMap.customBld;
    var orthoOverlay = baseMap.orthoOverlay;
    var fullPins = inlineAllHistoryPins(events);
    var isInspection = val("woType") === "Inspection";
    var hideExistingPins = isInspection && woInlineHistoryHideExistingPins && fullPins.length > 0;
    var pinCoverage = hideExistingPins ?
      inlineHistoryHiddenSessionPinCoverage(fullPins) :
      inlineHistoryPinCoverage(events, mapRoofId, hasCustomBaseMap);
    var assetCoverage = inlineHistoryAssetCoverage(ctx.roofs, mapRoof, hasCustomBaseMap);
    var roofAssets = assetCoverage.rendered;
    var outlines = inlineHistoryOutlines(ctx.roofs, hasCustomBaseMap, mapRoof);
    /* Render mode decides only what can be plotted. Disclosure is always
       derived from the full history set minus this rendered set. */
    var mapPins = pinCoverage.rendered;
    var latestEvents = events.slice(0, 8);
    var hiddenDisclosure = [pinCoverage.disclosure, assetCoverage.disclosure].filter(Boolean).join(" ");
    var mapLabel = inlineHistoryMapLabel(hasCustomBaseMap, orthoOverlay, baseMap, mapRoof);
    var noBaseMapNotice = !hasCustomBaseMap && !orthoOverlay ? inlineNoBaseMapNotice(ctx.roofs, roofId, baseMap.selectedRoof) : "";
    var hasMapVisual = !!(hasCustomBaseMap || orthoOverlay || outlines.length || mapPins.length || roofAssets.length);
    var eventCountLabel = latestEvents.length && latestEvents.length < events.length ?
      'Showing ' + latestEvents.length + ' of ' + events.length + ' prior events' :
      (events.length ? events.length + ' prior event' + (events.length === 1 ? '' : 's') : '');
    var mapHtml = inlineHistoryMapHtml(hasMapVisual, mapLabel, noBaseMapNotice, hiddenDisclosure);
    var pinToggleHtml = inlineHistoryPinToggleHtml(isInspection, fullPins.length, hideExistingPins);
    var eventsHtml = latestEvents.length ?
      latestEvents.map(function(e){ return timelineEventHtml(e, ctx.buildingId, { readOnly: true }); }).join("") :
      '<div class="empty">No prior leak, inspection, or repair history is logged for this building yet.</div>';
    body.innerHTML = mapHtml + pinToggleHtml +
      '<div class="evt-head" style="margin:0 0 6px"><span class="evt-tag">Read-only</span>' +
      (eventCountLabel ? '<span class="evt-tag">' + eventCountLabel + '</span>' : '') +
      '</div>' +
      '<div>' + eventsHtml + '</div>';
    if (hasMapVisual){
      renderBuildingMap(mapPins, hasCustomBaseMap ? mapRoof : null, (ctx.building && ctx.building.location) || val("location"),
        orthoOverlay, roofAssets, ctx.buildingId, outlines, { mapElementId: "wo-inline-building-map", readOnly: true });
    }
  }catch(e){
    if (seq !== woInlineHistorySeq) return;
    body.innerHTML = '<div class="empty">Couldn\'t load building history: ' + esc(e.message) + '</div>';
  }
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
var buildingMapByElementId = {};
var buildingMapRenderSeqByElementId = {};
function getBuildingMapHandle(mapElementId){
  return mapElementId === "building-map" ? buildingMap : buildingMapByElementId[mapElementId];
}
function setBuildingMapHandle(mapElementId, map){
  if (mapElementId === "building-map") buildingMap = map;
  else buildingMapByElementId[mapElementId] = map;
}
function removeBuildingMapHandle(mapElementId){
  var m = getBuildingMapHandle(mapElementId);
  if (m) m.remove();
  if (mapElementId === "building-map") buildingMap = null;
  else delete buildingMapByElementId[mapElementId];
}
function pinPopupHtml(p, opts){
  opts = opts || {};
  var photoNote = p.photo_ids && p.photo_ids.length ?
    "📷 " + p.photo_ids.length + " photo" + (p.photo_ids.length === 1 ? "" : "s") + " — open the work order to view" : "";
  var html = "<b>" + esc(p.eventDate || p.service_date || "") + "</b>" +
    (p.work_order_no ? " — Job No. " + esc(p.work_order_no) : "") + "<br>" +
    (p.condition ? esc(p.condition) + "<br>" : "") +
    "<span style='color:" + warrantyColor(p.warranty) + ";font-weight:600'>" + esc(p.warranty || "") + "</span><br>" +
    (photoNote ? photoNote + "<br>" : "");
  /* READ-ONLY means "you can't EDIT this pin", not "you can't NAVIGATE from
     it" -- navigation is read-only by definition. Mark, KOMU leak 2026-07-19:
     a history pin showed the finding text and the right job number, he tapped
     it expecting to reach the work order it came from, and nothing happened.
     The button below already existed; this branch simply returned before it,
     with p.work_order_id sitting unused right beside the job number he could
     see.

     "Adjust Pin" stays withheld -- that one mutates. This is the same
     distinction the timeline entries already draw (tappable to open the WO,
     not editable in place).

     Safe to navigate from the inline card even though it sits INSIDE an open
     work order: loadOrder is wrapped in js/workorders.js with
     confirmLeaveUnclouded("Open the other work order anyway?"), so an
     in-progress leak report can't be silently discarded by a stray tap. */
  if (opts.readOnly){
    return html + (p.work_order_id ?
      "<div style=\"margin-top:6px\">" +
      "<button class=\"btn\" onclick=\"loadOrder('" + p.work_order_id + "')\">View Work Order</button>" +
      "</div>" : "") +
      "<span style='color:var(--muted);font-size:12px'>Read-only history pin</span>";
  }
  return html +
    "<div style=\"display:flex;gap:6px;margin-top:6px;flex-wrap:wrap\">" +
    "<button class=\"btn\" onclick=\"loadOrder('" + p.work_order_id + "')\">View Work Order</button>" +
    (p.finding_id ? "<button class=\"btn\" onclick=\"jumpToAdjustPin('" + p.work_order_id + "','" + p.finding_id + "')\">Adjust Pin</button>" : "") +
    "</div>";
}
function assetPopupReadonlyHtml(a){
  var t = ROOF_ASSET_TYPES[a.type] || ROOF_ASSET_TYPES.other;
  return "<b>" + t.emoji + " " + esc(t.label) + "</b>" + (a.label ? " - " + esc(a.label) : "") + "<br>" +
    (a.notes ? esc(a.notes) + "<br>" : "") +
    "<span style='color:var(--muted);font-size:12px'>Read-only roof feature</span>";
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
function buildingMapIsFiniteNumber(value){
  return typeof value === "number" && Number.isFinite(value);
}
function buildingMapIsFiniteLatLng(point){
  return !!point && buildingMapIsFiniteNumber(point.lat) && buildingMapIsFiniteNumber(point.lng);
}
function buildingMapIsNearNullIsland(point){
  return buildingMapIsFiniteLatLng(point) && Math.abs(point.lat) < 0.05 && Math.abs(point.lng) < 0.05;
}
function buildingMapIsSyntheticImageGeometry(item){
  item = item || {};
  var capture = item.captureSource || {};
  var methodCapture = item.measurementMethod && item.measurementMethod.captureSource || {};
  return !!(item.tracedOnOrtho || item.imageFrame === "roof_base_map" ||
    item._roofBaseMapSynthetic || capture.mechanism === "ortho_image" ||
    methodCapture.mechanism === "ortho_image");
}
function buildingMapImageFrameMatches(item, frameUrl){
  if (!item || !item.imageFrameUrl) return true;
  return !!frameUrl && item.imageFrameUrl === frameUrl;
}
function buildingMapHasWrongImageFrame(item, frameUrl){
  return !!(item && item.imageFrameUrl && !buildingMapImageFrameMatches(item, frameUrl));
}
function buildingMapFrameMismatchDisclosure(outlines, assets, pins, frameUrl){
  var outlineCount = (outlines || []).filter(function(o){
    return Array.isArray(o.imageRing) && o.imageRing.length >= 3 && buildingMapHasWrongImageFrame(o, frameUrl);
  }).length;
  var assetCount = (assets || []).filter(function(a){
    return buildingMapIsFiniteNumber(a && a.x) && buildingMapIsFiniteNumber(a && a.y) &&
      buildingMapHasWrongImageFrame(a, frameUrl);
  }).length;
  var pinCount = (pins || []).filter(function(p){
    return buildingMapIsFiniteNumber(p && p.x) && buildingMapIsFiniteNumber(p && p.y) &&
      buildingMapHasWrongImageFrame(p, frameUrl);
  }).length;
  return { outlines: outlineCount, assets: assetCount, pins: pinCount, total: outlineCount + assetCount + pinCount };
}
function buildingMapFrameMismatchPartsText(parts){
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] + " and " + parts[1];
  return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
}
function buildingMapFrameMismatchText(disclosure){
  disclosure = disclosure || {};
  var parts = [];
  if (disclosure.outlines) parts.push(disclosure.outlines + " outline" + (disclosure.outlines === 1 ? "" : "s"));
  if (disclosure.assets) parts.push(disclosure.assets + " feature" + (disclosure.assets === 1 ? "" : "s"));
  if (disclosure.pins) parts.push(disclosure.pins + " pin" + (disclosure.pins === 1 ? "" : "s"));
  if (!parts.length) return "";
  return buildingMapFrameMismatchPartsText(parts) + " were placed on a different base image and can't be shown here.";
}
function buildingMapSetFrameMismatchDisclosure(el, disclosure){
  if (!el || !el.id || !el.parentNode) return;
  var id = el.id + "-frame-disclosure";
  var existing = document.getElementById(id);
  var text = buildingMapFrameMismatchText(disclosure);
  if (!text){
    if (existing) existing.remove();
    return;
  }
  var node = existing || document.createElement("p");
  node.id = id;
  node.className = "hint";
  node.style.margin = "6px 0 0";
  node.textContent = text;
  if (!existing) el.insertAdjacentElement("afterend", node);
}
function buildingMapShouldUseWorldPoint(point, owner){
  if (!buildingMapIsFiniteLatLng(point)) return false;
  return !(buildingMapIsSyntheticImageGeometry(owner) && buildingMapIsNearNullIsland(point));
}
function buildingMapRenderableOutline(outline){
  if (!outline || !Array.isArray(outline.ring) || outline.ring.length < 3) return false;
  return outline.ring.every(function(p){ return buildingMapShouldUseWorldPoint(p, outline); });
}
function buildingMapImageOutlineRing(outline, width, height, frameUrl){
  if (!outline || !Array.isArray(outline.imageRing) || outline.imageRing.length < 3) return null;
  if (!buildingMapImageFrameMatches(outline, frameUrl)) return null;
  var ring = outline.imageRing.map(function(p){
    if (!p || !buildingMapIsFiniteNumber(p.x) || !buildingMapIsFiniteNumber(p.y)) return null;
    return [p.y * height, p.x * width];
  }).filter(Boolean);
  return ring.length >= 3 ? ring : null;
}
function buildingMapImageOutlineCenter(ring){
  if (!Array.isArray(ring) || !ring.length) return null;
  var sumY = 0, sumX = 0;
  ring.forEach(function(p){ sumY += p[0]; sumX += p[1]; });
  return [sumY / ring.length, sumX / ring.length];
}
function renderBuildingMap(pins, customBld, bldAddress, orthoOverlay, assets, buildingId, outlines, mapOptions){
  assets = assets || [];
  var opts = (typeof mapOptions === "string") ? { mapElementId: mapOptions } : (mapOptions || {});
  var mapElementId = opts.mapElementId || "building-map";
  var readOnly = !!opts.readOnly;
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
  var el = document.getElementById(mapElementId);
  if (!el) return;
  removeBuildingMapHandle(mapElementId);
  var renderSeq = (buildingMapRenderSeqByElementId[mapElementId] || 0) + 1;
  buildingMapRenderSeqByElementId[mapElementId] = renderSeq;
  if (customBld){
    buildingMapSetFrameMismatchDisclosure(el,
      buildingMapFrameMismatchDisclosure(outlines, assets, pins, customBld.roof_base_map_url));
    var img = new Image();
    img.onload = function(){
      var w = img.naturalWidth, h = img.naturalHeight;
      var bounds = [[0,0],[h,w]];
      setTimeout(function(){
        if (buildingMapRenderSeqByElementId[mapElementId] !== renderSeq) return;
        var map = L.map(mapElementId, { crs: L.CRS.Simple, minZoom: -5 });
        setBuildingMapHandle(mapElementId, map);
        L.imageOverlay(customBld.roof_base_map_url, bounds).addTo(map);
        outlines.forEach(function(o){
          var ring = buildingMapImageOutlineRing(o, w, h, customBld.roof_base_map_url);
          if (!ring) return;
          L.polygon(ring, {
            color: "#E8600A", weight: 2, fillColor: "#E8600A", fillOpacity: 0.1
          }).addTo(map).bindPopup(outlinePopupHtml(o, o._roofLabel));
          if (o._roofLabel) roofLabelMarker.apply(null, buildingMapImageOutlineCenter(ring).concat([o._roofLabel])).addTo(map);
        });
        pins.forEach(function(p){
          if (!buildingMapImageFrameMatches(p, customBld.roof_base_map_url)) return;
          L.circleMarker([p.y * h, p.x * w], {
            radius: 9, color: "#fff", weight: 2, fillColor: warrantyColor(p.warranty), fillOpacity: 0.95
          }).addTo(map).bindPopup(pinPopupHtml(p, { readOnly: readOnly }));
        });
        assets.forEach(function(a){
          if (typeof a.x !== "number") return;
          if (!buildingMapImageFrameMatches(a, customBld.roof_base_map_url)) return;
          L.marker([a.y * h, a.x * w], { icon: assetIcon(a.type) }).addTo(map)
            .bindPopup(readOnly ? assetPopupReadonlyHtml(a) : assetPopupHtml(buildingId, a));
        });
        map.fitBounds(bounds);
        map.invalidateSize();
        setTimeout(function(){ var latest = getBuildingMapHandle(mapElementId); if (latest) latest.invalidateSize(); }, 300);
      }, 50);
    };
    img.onerror = function(){
      if (buildingMapRenderSeqByElementId[mapElementId] !== renderSeq) return;
      el.innerHTML = '<p class="hint">Couldn’t load the custom base map image.</p>';
    };
    img.src = customBld.roof_base_map_url;
    return;
  }
  buildingMapSetFrameMismatchDisclosure(el, null);
  (async function(){
    var bounds = [];
    var renderableOutlines = outlines.filter(buildingMapRenderableOutline);
    pins.forEach(function(p){ if (buildingMapIsFiniteLatLng(p)) bounds.push([p.lat, p.lng]); });
    assets.forEach(function(a){ if (buildingMapShouldUseWorldPoint(a, a)) bounds.push([a.lat, a.lng]); });
    renderableOutlines.forEach(function(o){ (o.ring || []).forEach(function(p){ bounds.push([p.lat, p.lng]); }); });
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
      if (buildingMapRenderSeqByElementId[mapElementId] !== renderSeq) return;
      var map = center ? L.map(mapElementId).setView([center.lat, center.lng], zoom) : L.map(mapElementId);
      setBuildingMapHandle(mapElementId, map);
      L.tileLayer(satelliteTileUrlTemplate(), {
        maxZoom: 22, maxNativeZoom: SAT_MAX_NATIVE_ZOOM, attribution: "Tiles &copy; Esri"
      }).addTo(map);
      if (orthoOverlay) L.imageOverlay(orthoOverlay.url, boundsToLatLngBounds(orthoOverlay.bounds)).addTo(map);
      renderableOutlines.forEach(function(o){
        L.polygon(o.ring.map(function(p){ return [p.lat, p.lng]; }), {
          color: "#E8600A", weight: 2, fillColor: "#E8600A", fillOpacity: 0.1
        }).addTo(map).bindPopup(outlinePopupHtml(o, o._roofLabel));
        if (o._roofLabel){
          /* Respects wherever the roof's label was dragged to in
             RoofMapper (o._roofLabelPos, set alongside _roofLabel below)
             -- read-only here (no onClick/onDragEnd), same as before, just
             positioned correctly instead of always the recomputed
             centroid. See "Draggable roof labels" in DEV_NOTES.md. */
          var labelCenter = o._roofLabelPos || o.center || rmGeomRingCentroid(o.ring);
          roofLabelMarker(labelCenter.lat, labelCenter.lng, o._roofLabel).addTo(map);
        }
      });
      pins.forEach(function(p){
        if (!buildingMapIsFiniteLatLng(p)) return;
        L.circleMarker([p.lat, p.lng], {
          radius: 9, color: "#fff", weight: 2, fillColor: warrantyColor(p.warranty), fillOpacity: 0.95
        }).addTo(map).bindPopup(pinPopupHtml(p, { readOnly: readOnly }));
      });
      assets.forEach(function(a){
        if (!buildingMapShouldUseWorldPoint(a, a)) return;
        L.marker([a.lat, a.lng], { icon: assetIcon(a.type) }).addTo(map)
          .bindPopup(readOnly ? assetPopupReadonlyHtml(a) : assetPopupHtml(buildingId, a));
      });
      if (bounds.length === 1) map.setView(bounds[0], 19);
      else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
      else if (orthoOverlay) map.fitBounds(boundsToLatLngBounds(orthoOverlay.bounds));
      map.invalidateSize();
      setTimeout(function(){ var latest = getBuildingMapHandle(mapElementId); if (latest) latest.invalidateSize(); }, 300);
    }, 50);
  })();
}

