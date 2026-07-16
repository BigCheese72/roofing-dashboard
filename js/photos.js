"use strict";
/* ================= roof map pin placement (Phase 2) =================
   Design (see roof-map spec): lat/lng is authoritative — pins survive a
   future base-map swap. x/y stay null here; they're only used for
   non-georeferenced base maps (Phase 4). GPS from a linked CompanyCam
   photo is an initial guess only, never trusted without a tech confirming
   by dragging or tapping — see pin.source below. */
var geocodeCache = {};
async function geocodeAddress(text){
  text = (text || "").trim();
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(geocodeCache, text)) return geocodeCache[text];
  try{
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(text);
    var r = await fetch(url);
    if (!r.ok) throw new Error("geocode failed");
    var arr = await r.json();
    var result = (arr && arr[0]) ? { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) } : null;
    geocodeCache[text] = result;
    return result;
  }catch(e){
    geocodeCache[text] = null;
    return null;
  }
}
function findingById(id){
  return findings.find(function(f){ return f.id === id; });
}
function inspectionChecklistItemById(id){
  return inspectionChecklist.find(function(c){ return c.id === id; });
}
function inspectionComponentLabel(key){
  var c = INSPECTION_CHECKLIST_COMPONENTS.find(function(x){ return x.key === key; });
  return c ? c.label : key;
}
/* Backfills any of the 8 fixed components missing from a loaded/new work
   order (old data, or a brand-new Inspection) and keeps them in canonical
   order regardless of storage order -- safe to call any time, a no-op once
   all 8 already exist. */
function ensureInspectionChecklist(){
  INSPECTION_CHECKLIST_COMPONENTS.forEach(function(c){
    if (!inspectionChecklist.some(function(item){ return item.key === c.key; })){
      inspectionChecklist.push({ id: genId("chk"), key: c.key, rating: "N/A", notes: "", linkedFindingId: null, pin: null });
    }
  });
  /* Self-heals items saved before `pin` existed -- never fabricates a
     location, just ensures the field is there going forward (same pattern
     fill() already uses for findings' pin field). */
  inspectionChecklist.forEach(function(item){ if (item.pin === undefined) item.pin = null; });
  inspectionChecklist.sort(function(a, b){
    var ia = INSPECTION_CHECKLIST_COMPONENTS.findIndex(function(c){ return c.key === a.key; });
    var ib = INSPECTION_CHECKLIST_COMPONENTS.findIndex(function(c){ return c.key === b.key; });
    return ia - ib;
  });
}
/* Anything rated below Good "surfaces as a finding" per Mark -- keeps a
   single auto-managed entry in findings[] per checklist item, tracked via
   linkedFindingId so it can be found again, updated in place as the rating/
   notes change, and cleanly removed the moment the rating goes back to
   Good/N/A. Doesn't touch or interfere with findings a tech added manually
   ("+ Add Finding" still works exactly as it always has) -- only ever
   creates/updates/removes the ONE finding it itself created for this item. */
function syncInspectionFinding(item){
  var below = ["Fair", "Poor", "Critical"].indexOf(item.rating) > -1;
  var label = inspectionComponentLabel(item.key);
  if (below){
    var existing = item.linkedFindingId ? findingById(item.linkedFindingId) : null;
    var text = label + ": " + item.rating + (item.notes ? " — " + item.notes : "");
    if (existing){
      existing.condition = text;
      existing.location = label;
    } else {
      var f = { id: genId("fnd"), condition: text, location: label, warranty: "Undetermined", pin: null };
      findings.push(f);
      item.linkedFindingId = f.id;
    }
  } else if (item.linkedFindingId){
    var idx = findings.findIndex(function(f){ return f.id === item.linkedFindingId; });
    if (idx > -1){
      var removedId = findings[idx].id;
      findings.splice(idx, 1);
      photos.forEach(function(p){ if (p.finding_id === removedId) p.finding_id = null; });
    }
    item.linkedFindingId = null;
  }
  renderFindings();
}
function renderInspectionChecklist(){
  var host = document.getElementById("inspection-checklist-list");
  if (!host) return;
  host.innerHTML = inspectionChecklist.map(function(item, i){
    var flagged = ["Fair", "Poor", "Critical"].indexOf(item.rating) > -1;
    return '<div class="rowcard' + (flagged ? " nonwar" : "") + '">' +
      '<div class="rowhead"><b>' + esc(inspectionComponentLabel(item.key)) + '</b></div>' +
      '<div class="fld" style="max-width:200px"><label>Condition</label>' +
      '<select data-ci="' + i + '" data-cf="rating">' +
        INSPECTION_RATINGS.map(function(r){ return '<option' + (item.rating === r ? " selected" : "") + '>' + r + '</option>'; }).join("") +
      '</select></div>' +
      '<div class="fld"><label>Notes (optional)</label>' +
      '<textarea rows="2" data-ci="' + i + '" data-cf="notes">' + esc(item.notes) + '</textarea></div>' +
      inspectionItemPhotoGalleryHtml(item) +
      '</div>';
  }).join("");
  host.querySelectorAll("[data-cf]").forEach(function(el){
    el.addEventListener("input", function(){
      var item = inspectionChecklist[+el.dataset.ci];
      item[el.dataset.cf] = el.value;
      syncInspectionFinding(item);
      if (el.dataset.cf === "rating") renderInspectionChecklist();
    });
  });
  host.querySelectorAll("[data-findingphoto]").forEach(function(el){
    el.addEventListener("input", function(){
      photos[+el.dataset.findingphoto].caption = el.value;
    });
  });
}
/* Mark: "he may inspect the whole building or just one section" -- support
   ONE roof, SEVERAL, or ALL, not the single-roof-per-work-order model every
   other work order type still uses. A checkbox list (default: every roof
   checked, since "the whole building" is the least-surprising default for
   an inspection) rather than renderPinRoofPicker()'s single <select> --
   writes to the plural currentRoofIds, kept in sync with the singular
   currentRoofId (always currentRoofIds[0]) so every existing single-roof
   reader (lookupProspectiveBuildingBaseMap(), buildPinsForHistoryEvent()'s
   fallback, etc.) keeps working unchanged. Only ever shows up once the
   resolved building actually has more than one roof -- a single-roof
   building never sees this, never gets asked to pick. See "Inspection
   multi-roof selector" in DEV_NOTES.md. */
async function renderInspectionRoofPicker(){
  var host = document.getElementById("wo-inspection-roof-picker");
  if (!host) return;
  var info = await lookupProspectiveBuildingRoofInfo();
  if (!info || info.roofs.length <= 1){ host.innerHTML = ""; currentRoofIds = null; return; }
  if (!currentRoofIds || !currentRoofIds.length || !currentRoofIds.every(function(id){ return info.roofs.some(function(r){ return r.id === id; }); })){
    currentRoofIds = info.roofs.map(function(r){ return r.id; });
  }
  currentRoofId = currentRoofIds[0];
  host.innerHTML = '<div class="fld">' +
    '<label>Which roof(s) does this inspection cover?</label>' +
    info.roofs.map(function(r){
      var checked = currentRoofIds.indexOf(r.id) !== -1;
      return '<label class="hint" style="display:flex;align-items:center;gap:6px;margin:2px 0;font-weight:400">' +
        '<input type="checkbox" class="wo-inspection-roof-cb" value="' + esc(r.id) + '"' + (checked ? ' checked' : '') +
        ' onchange="onInspectionRoofToggle()"> ' + esc(r.label || "Roof") + '</label>';
    }).join('') + '</div>';
}
function onInspectionRoofToggle(){
  var boxes = Array.from(document.querySelectorAll(".wo-inspection-roof-cb"));
  var checked = boxes.filter(function(b){ return b.checked; }).map(function(b){ return b.value; });
  if (!checked.length){
    /* At least one roof must stay selected -- currentRoofIds hasn't been
       reassigned yet at this point, so re-rendering from it restores
       whichever box the tech just tried to uncheck. */
    toast("At least one roof must stay selected.");
    renderInspectionRoofPicker();
    return;
  }
  currentRoofIds = checked;
  currentRoofId = currentRoofIds[0];
}
function refreshInspectionRoofPickerIfNeeded(){
  if (val("woType") === "Inspection") renderInspectionRoofPicker();
}
/* Read-only lookup of the prospective building for the CURRENT work order
   (same id derivation as ensureCustomerAndBuilding), returning its full
   roofs[] list — never creates/writes anything. Shared by the base-map
   lookup below and the pin modal's roof picker, so both agree on exactly
   the same building/roofs without a second Firestore read. */
async function lookupProspectiveBuildingRoofInfo(){
  if (!fdb) return null;
  var o = collect();
  var custName = (o.billTo || "").trim();
  var bldName = (o.jobName || "").trim();
  if (!bldName) return null;
  var custId = custName ? ("cust_" + slugify(custName)) : null;
  var bldId = "bld_" + slugify((custId || "nocust") + "_" + bldName);
  /* The linked CompanyCam project is the durable, site-level anchor (it maps
     1:1 to a physical job site/address) — carried alongside the roofs so the
     base-map resolver can follow a site across forms whose customer/job-name
     resolve to a different building doc. Prefer the building's own saved link,
     then the current work order's, then the in-memory linked project. */
  var woCcId = (o.companyCamProjectId || (typeof ccLinkedProjectId !== "undefined" ? ccLinkedProjectId : null)) || null;
  try{
    var snap = await fdb.collection("buildings").doc(bldId).get();
    var result = !snap.exists
      ? { buildingId: bldId, roofs: [], companyCamProjectId: woCcId }
      : { buildingId: bldId, roofs: getBuildingRoofs(snap.data()),
          companyCamProjectId: (snap.data().companyCamProjectId || woCcId) };
    lastLookupRoofInfo = result; /* see the var's own comment -- collect() denormalizes roof LABELS from this */
    return result;
  }catch(e){ return null; }
}
/* roof_base_map_* are PER-ROOF fields (js/core.js, DATA_MODEL.md §roofs[]),
   but a base map -- a drone orthomosaic especially -- is one image of the
   whole BUILDING. The old resolver asked a single roof (the selected one,
   else roofs[0]) whether it had a base map and silently fell back to plain
   satellite when it didn't. Tri-Delta has 11 roofs: attach the ortho to
   roof 7, don't select a roof, and the saved base map simply never showed.
   Resolve at the building level instead, and when the map we use does NOT
   belong to the selected roof, SAY WHOSE IT IS. An honest label beats a
   silent substitution. See issue #39. */
function photosRoofHasBaseMap(r){
  return !!(r && r.roof_base_map_url && (
    r.roof_base_map_type === "roof_plan" || r.roof_base_map_type === "sketch" ||
    (r.roof_base_map_type === "drone_ortho" && r.roof_base_map_bounds)));
}
/* A pin the tech can't be shown on a non-georeferenced drawing: it lives in
   real lat/lng and the drawing has no coordinate system to convert into. */
function photosPinIsGpsOnly(pin){
  return !!(pin && typeof pin.lat === "number" && typeof pin.lng === "number" &&
    !(typeof pin.x === "number" && typeof pin.y === "number"));
}
/* Stamps the frame a pin is about to be placed against, in the same shape
   savePinFromModal() (js/workorders.js) reads before writing the saved pin --
   pinXYSize.imageFrameUrl there takes priority over its own (narrower,
   single-roof) fallback lookup. Without this, a pin placed here degrades
   silently: rmOutlineImageFramePersistence() and rmAssetImageFramePersistence()
   already stamp outlines/assets so a later base-map swap can be detected and
   disclosed (buildingMapFrameMismatchDisclosure()), but a pin with no stamp
   reads as "legacy, always matches" and just re-anchors to the new picture
   with nothing to say so. See issue #45. */
function photosPinXYSizeFor(customBaseMap, w, h){
  return { w: w, h: h, imageFrameUrl: (customBaseMap && customBaseMap.url) || null };
}
function photosResolveBuildingBaseMap(roofs, selectedRoofId){
  roofs = roofs || [];
  var selected = roofs.find(function(r){ return r.id === selectedRoofId; }) || roofs[0] || null;
  var source = photosRoofHasBaseMap(selected) ? selected :
    (roofs.find(function(r){
      return r && photosRoofHasBaseMap(r) && !(selected && r.id === selected.id);
    }) || null);
  if (!source) return null;
  var georeferenced = source.roof_base_map_type === "drone_ortho" && !!source.roof_base_map_bounds;
  return {
    url: source.roof_base_map_url,
    type: source.roof_base_map_type,
    georeferenced: georeferenced,
    bounds: georeferenced ? source.roof_base_map_bounds : null,
    sourceRoofId: source.id || null,
    sourceRoofLabel: source.label || "Roof",
    fromSelectedRoof: !!(selected && source.id === selected.id)
  };
}
async function lookupProspectiveBuildingBaseMap(){
  try{
    var info = await lookupProspectiveBuildingRoofInfo();
    /* 1) The billTo+jobName building's own roofs -- if it already has a base
       map, that's the one, exactly as before. */
    if (info && info.roofs.length){
      var primary = photosResolveBuildingBaseMap(info.roofs, currentRoofId);
      if (primary) return primary;
    }
    /* 2) CompanyCam-project anchor (Mark: once a base map is made it follows
       the job SITE, into any form opened for it -- not just forms that happen
       to share the billTo+jobName key). The same physical site can resolve to a
       different building doc when the customer or job name is entered
       differently; the durable link tying them together is the CompanyCam
       project. When the primary building has no base map of its own, borrow one
       from any building sharing this CompanyCam project. Non-destructive: it
       only READS across buildings, nothing is re-keyed or moved. See "base-map
       anchor" in DEV_NOTES.md. */
    var ccId = info && info.companyCamProjectId;
    if (ccId){
      var ccRoofs = await photosRoofsForCompanyCamProject(ccId, info && info.buildingId);
      if (ccRoofs.length){
        var viaCc = photosResolveBuildingBaseMap(ccRoofs, currentRoofId);
        if (viaCc){
          viaCc.fromSelectedRoof = false; // it's from another building entirely
          viaCc.viaCompanyCam = true;     // so the honesty label says whose it is
          return viaCc;
        }
      }
    }
    return null;
  }catch(e){ return null; }
}
/* All roofs across every building linked to this CompanyCam project, minus the
   one we've already checked. A single-field equality query, so Firestore's
   automatic index covers it -- no composite index to deploy. */
async function photosRoofsForCompanyCamProject(companyCamProjectId, excludeBuildingId){
  if (!fdb || !companyCamProjectId) return [];
  try{
    var qs = await fdb.collection("buildings").where("companyCamProjectId", "==", companyCamProjectId).get();
    var roofs = [];
    qs.forEach(function(d){
      if (excludeBuildingId && d.id === excludeBuildingId) return;
      getBuildingRoofs(d.data()).forEach(function(r){ roofs.push(r); });
    });
    return roofs;
  }catch(e){ return []; }
}
function boundsToLatLngBounds(b){
  return [[b.south, b.west], [b.north, b.east]];
}
var pinMap = null, pinMarker = null, pinModalFindingId = null, pinInitialSource = null,
  pinInteracted = false, pinMapMode = "latlng", pinXYSize = null, pinDeviceGpsUsed = false,
  pendingPinFindingId = null;
/* The Building History roof map is a read-only aggregate across every
   report for a building — pins there were never draggable, by design (see
   DEV_NOTES.md). This is the bridge from that map to the actual editable
   pin: load the owning work order, then auto-open that finding's pin
   modal once the edit view is showing (see the showView hook below). */
function jumpToAdjustPin(workOrderId, findingId){
  pendingPinFindingId = findingId;
  loadOrder(workOrderId);
}
/* Mark's GPS-auto-assign design change: a finding's roof is now normally
   DERIVED (rmMaybeAutoAssignRoofForPin(), point-in-polygon against the
   photo's own GPS), not manually picked up front -- so this picker's job
   shifted from "the primary way to choose" to "the one-tap correction
   when the auto-assign got it wrong or was ambiguous." Always offers the
   FULL building roof list now (not narrowed to whatever a multi-roof
   Inspection's checkboxes happened to select) so ANY finding on ANY roof
   is correctable here, regardless of how it got its current roofId --
   scoping to currentRoofIds only applies as the DEFAULT pre-selection
   when nothing more specific (the finding's own roofId) is already known.
   Still only renders once the resolved building actually has more than
   one roof; a single-roof building never sees this at all. See "GPS
   auto-assign photos to roofs" in DEV_NOTES.md. */
async function renderPinRoofPicker(){
  var host = document.getElementById("pin-roof-picker");
  if (!host) return;
  var info = await lookupProspectiveBuildingRoofInfo();
  if (!info || info.roofs.length <= 1){ host.innerHTML = ""; return; }
  var f = findingById(pinModalFindingId);
  var activeId = (f && f.roofId && info.roofs.some(function(r){ return r.id === f.roofId; })) ? f.roofId :
    (currentRoofIds && currentRoofIds.length ? currentRoofIds[0] :
      ((currentRoofId && info.roofs.some(function(r){ return r.id === currentRoofId; })) ? currentRoofId : info.roofs[0].id));
  var ambiguous = f && f.roofIdAmbiguous;
  host.innerHTML = '<div class="fld" style="max-width:280px">' +
    '<label>Roof' + (ambiguous ?
      ' <span style="color:#D64545;font-weight:700">⚠️ GPS was near a boundary — please confirm</span>' : '') + '</label>' +
    '<select onchange="pinSelectFindingRoof(this.value, \'' + pinModalFindingId + '\')"' +
    (ambiguous ? ' style="border-color:#D64545"' : '') + '>' +
    info.roofs.map(function(r){ return '<option value="' + esc(r.id) + '"' + (r.id === activeId ? ' selected' : '') + '>' + esc(r.label || "Roof") + '</option>'; }).join('') +
    '</select></div>';
}
/* Clears the ambiguous flag the moment a tech confirms/corrects it --
   whatever they picked (even if it happens to match the auto-assigned
   guess) is now a real human confirmation, not a low-confidence guess. */
function pinSelectFindingRoof(roofId, findingId){
  var f = findingById(findingId);
  if (f){ f.roofId = roofId; f.roofIdAmbiguous = false; }
  currentRoofId = roofId;
  openPinModal(findingId);
}
async function openPinModal(findingId){
  var f = findingById(findingId);
  if (!f) return;
  pinModalFindingId = findingId;
  pinInteracted = false;
  pinDeviceGpsUsed = false;
  var pinModalEl = document.getElementById("pin-modal");
  /* pinSelectFindingRoof() reopens this same modal (to redraw for a
     different roof's base map) without closing it first — guard so that
     doesn't double-lock scrolling with no matching unlock. */
  if (pinModalEl.style.display !== "") lockBodyScroll();
  pinModalEl.style.display = "";
  document.getElementById("pin-clear-btn").style.display = f.pin ? "" : "none";
  document.getElementById("pin-mylocation-btn").style.display = "none"; /* re-shown in openPinModalSatellite — device GPS doesn't map onto a custom base map's pixel coords */
  document.getElementById("pin-hint").textContent = "Locating…";
  if (pinMap){ pinMap.remove(); pinMap = null; pinMarker = null; }

  await renderPinRoofPicker();
  var customBaseMap = await lookupProspectiveBuildingBaseMap();
  if (customBaseMap && customBaseMap.georeferenced){
    // Drone orthomosaic: real coordinates, so it's just a higher-detail
    // image layer on top of the normal lat/lng satellite map — pins still
    // save as lat/lng like any other satellite pin, no separate x/y mode.
    // Safe to use building-wide: a georeferenced ortho plots correctly no
    // matter which roof it happens to be attached to.
    pinMapMode = "latlng";
    await openPinModalSatellite(f, findingId, customBaseMap);
    return;
  }
  /* A non-georeferenced drawing (roof plan / sketch) has no coordinate system,
     so a finding whose existing pin is a real GPS location CANNOT be plotted on
     it. The old code switched to x/y mode anyway, dropped the marker at the
     image centre, and told the tech "Existing pin on the roof plan — drag to
     move" — which was a lie: that marker was the middle of the drawing, not the
     finding. savePinFromModal() then overwrote the real coordinate with the
     centre as {source:"tech_placed"}, fabricating a provenance for a placement
     no tech ever made. Mark's call: keep these findings on satellite, where
     their pin is real and visible, rather than show a drawing that can only
     destroy them. Findings with no pin, or an existing x/y pin, still get the
     drawing. See issue #39. */
  if (customBaseMap && photosPinIsGpsOnly(f.pin)){
    pinMapMode = "latlng";
    await openPinModalSatellite(f, findingId, null, { gpsPinKeptOffBaseMap: customBaseMap });
    return;
  }
  if (customBaseMap){
    pinMapMode = "xy";
    document.getElementById("pin-hint").textContent = "Loading base map…";
    var img = new Image();
    img.onload = function(){
      var w = img.naturalWidth, h = img.naturalHeight;
      pinXYSize = photosPinXYSizeFor(customBaseMap, w, h);
      var bounds = [[0,0],[h,w]];
      setTimeout(function(){
        pinMap = L.map("pin-map", { crs: L.CRS.Simple, minZoom: -5 });
        L.imageOverlay(customBaseMap.url, bounds).addTo(pinMap);
        pinMap.fitBounds(bounds);
        var start = (f.pin && typeof f.pin.x === "number") ? [f.pin.y * h, f.pin.x * w] : [h/2, w/2];
        pinMarker = L.marker(start, { draggable: true }).addTo(pinMap);
        pinMarker.on("dragend", function(){ pinInteracted = true; });
        pinMap.on("click", function(e){ pinMarker.setLatLng(e.latlng); pinInteracted = true; });
        pinMap.invalidateSize();
        setTimeout(function(){ if (pinMap) pinMap.invalidateSize(); }, 300);
      }, 50);
      /* Name the roof the drawing actually came from whenever it isn't the
         selected roof's own -- never present another roof's image as this
         roof's without saying so (issue #39). */
      var whose = customBaseMap.fromSelectedRoof ? "" :
        (customBaseMap.viaCompanyCam
          ? " (from this site's linked CompanyCam project)"
          : " (from " + customBaseMap.sourceRoofLabel + " — building-wide)");
      document.getElementById("pin-hint").textContent = (f.pin ?
        "Existing pin on the " + customBaseMap.type.replace("_"," ") + " — drag to move." :
        "Tap the " + customBaseMap.type.replace("_"," ") + " to place the pin.") + whose;
    };
    img.onerror = function(){
      toast("Couldn't load the custom base map — using satellite instead.");
      pinMapMode = "latlng";
      openPinModalSatellite(f, findingId);
    };
    img.src = customBaseMap.url;
    return;
  }
  pinMapMode = "latlng";
  await openPinModalSatellite(f, findingId);
}
/* Mark's screenshot: pin placement rendered raw satellite tiles only --
   none of his 11 hand-traced Tri-Delta roofs, no labels, no history pins
   for context, and a wide street-level zoom instead of framed on the
   roof. Same underlying gap as the missing Building History timeline --
   the traced roof data exists, it just wasn't being drawn where it
   mattered. Pulls the SAME roofs info the roof dropdown above this map
   already fetches (renderPinRoofPicker(), lookupProspectiveBuildingRoofInfo())
   so this map can actually show what that dropdown is choosing between.
   See "Pin placement map roof rendering" in DEV_NOTES.md. */
async function openPinModalSatellite(f, findingId, orthoOverlay, opts){
  opts = opts || {};
  document.getElementById("pin-mylocation-btn").style.display = navigator.geolocation ? "" : "none";
  var warnEl = document.getElementById("pin-roof-mismatch-warning");
  if (warnEl) warnEl.style.display = "none";

  var roofInfo = await lookupProspectiveBuildingRoofInfo();
  var roofs = (roofInfo && roofInfo.roofs) || [];
  /* Same "which roof is active" resolution renderPinRoofPicker() already
     uses, so this map highlights exactly whichever roof that dropdown
     shows selected. */
  var activeRoofId = (f.roofId && roofs.some(function(r){ return r.id === f.roofId; })) ? f.roofId :
    (currentRoofIds && currentRoofIds.length ? currentRoofIds[0] :
      ((currentRoofId && roofs.some(function(r){ return r.id === currentRoofId; })) ? currentRoofId :
        (roofs[0] ? roofs[0].id : null)));
  /* Every roof's most recent outline, tagged with its own label -- same
     reduction openBuildingHistory() uses for its "every roof at once" map
     (allRoofOutlinesForMap). _active flags the one the Roof dropdown has
     selected right now, drawn distinctly from the rest below. */
  var roofOutlines = roofs.reduce(function(acc, r){
    var ol = r.roof_outlines || [];
    var latest = ol[ol.length - 1];
    if (latest && latest.ring && latest.ring.length >= 3){
      acc.push(Object.assign({}, latest, {
        _roofLabel: r.label || "Roof", _roofLabelPos: r.labelPos || null, _active: r.id === activeRoofId
      }));
    }
    return acc;
  }, []);
  /* Existing pins from this building's history, for context -- dimmed,
     non-interactive besides their popup, same convention Building
     History's own map already uses for these. Best-effort: no cloud
     connection or no history yet just means none show up. */
  var historyPinsForContext = [];
  if (fdb && roofInfo && roofInfo.buildingId){
    try{
      var evtQs = await fdb.collection("building_history_events")
        .where("buildingId", "==", roofInfo.buildingId).limit(50).get();
      evtQs.forEach(function(d){
        ((d.data().pins) || []).forEach(function(p){
          if (typeof p.lat === "number" && typeof p.lng === "number") historyPinsForContext.push(p);
        });
      });
    }catch(e){ /* non-critical -- pin placement still works without this context layer */ }
  }

  var center, zoom = 17, hint, fitOrthoBounds = false, fitActiveRoofBounds = false;
  if (f.pin && typeof f.pin.lat === "number"){
    center = { lat: f.pin.lat, lng: f.pin.lng };
    pinInitialSource = f.pin.source || "tech_placed";
    zoom = 19;
    hint = "Existing pin — drag to move, or tap Save to keep it here.";
  } else {
    var linkedPhoto = photos.find(function(p){ return p.finding_id === findingId && p.gps; });
    if (linkedPhoto){
      center = linkedPhoto.gps;
      pinInitialSource = "photo_gps";
      zoom = 19;
      hint = "Placed from photo GPS — drag to correct if it's not quite right.";
    } else if (orthoOverlay){
      // No need to geocode — we already know exactly where this building is.
      pinInitialSource = "tech_placed";
      var b = orthoOverlay.bounds;
      center = { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
      fitOrthoBounds = true;
      hint = "Tap the orthomosaic to place the pin.";
    } else {
      /* Mark: "zoom/fit to the building's roofs on open, not a wide street
         view" -- the active roof's own traced outline is the tightest,
         most relevant thing to frame on, well before falling back to
         geocoding the whole address. */
      var activeOutline = roofOutlines.find(function(o){ return o._active; });
      if (activeOutline){
        pinInitialSource = "tech_placed";
        center = activeOutline.center || rmGeomRingCentroid(activeOutline.ring);
        fitActiveRoofBounds = true;
        hint = "Tap the roof to place the pin.";
      } else {
        pinInitialSource = "tech_placed";
        var addr = val("location") || val("jobName") || "";
        var geo = await geocodeAddress(addr);
        if (geo){
          center = geo;
          hint = "Centered on the job address — drag the pin to the exact spot.";
        } else {
          center = { lat: 39.8283, lng: -98.5795 }; /* generic US center fallback */
          zoom = 4;
          hint = "Couldn't find that address automatically — zoom/pan and drag the pin to the right spot.";
        }
      }
    }
  }
  if (orthoOverlay && !fitOrthoBounds) hint += " (drone orthomosaic loaded for extra detail)";
  /* This finding has a real GPS pin and the building's only base map is a
     non-georeferenced drawing, so we deliberately stayed on satellite (issue
     #39). Say that plainly -- a tech who knows a roof plan exists must not be
     left wondering why they aren't looking at it. */
  if (opts.gpsPinKeptOffBaseMap){
    var skipped = opts.gpsPinKeptOffBaseMap;
    hint += " Showing satellite: this finding's pin is a GPS location, which can't be plotted on " +
      (skipped.fromSelectedRoof ? "this roof's" :
        (skipped.viaCompanyCam ? "the linked CompanyCam project's" : (skipped.sourceRoofLabel + "'s"))) + " " +
      String(skipped.type || "drawing").replace("_", " ") + ". Clear the pin to place it on the drawing instead.";
  }
  document.getElementById("pin-hint").textContent = hint;

  setTimeout(function(){
    pinMap = L.map("pin-map").setView([center.lat, center.lng], zoom);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 22, maxNativeZoom: SAT_MAX_NATIVE_ZOOM, attribution: "Tiles &copy; Esri"
    }).addTo(pinMap);
    if (orthoOverlay){
      L.imageOverlay(orthoOverlay.url, boundsToLatLngBounds(orthoOverlay.bounds)).addTo(pinMap);
      if (fitOrthoBounds) pinMap.fitBounds(boundsToLatLngBounds(orthoOverlay.bounds));
    }
    /* Every traced roof drawn -- the active one bold/highlighted (same
       orange RoofMapper's own outline uses), every other one dimmed gray
       so the whole building still reads as context without competing with
       the roof actually being pinned right now. */
    var activeLayerBounds = null;
    roofOutlines.forEach(function(o){
      var layer = L.polygon(o.ring.map(function(p){ return [p.lat, p.lng]; }), o._active ?
        { color: "#E8600A", weight: 3, fillColor: "#E8600A", fillOpacity: 0.15 } :
        { color: "#888", weight: 1.5, fillColor: "#888", fillOpacity: 0.06, dashArray: "4,4" }
      ).addTo(pinMap);
      if (o._active) activeLayerBounds = layer.getBounds();
      var labelCenter = o._roofLabelPos || o.center || rmGeomRingCentroid(o.ring);
      roofLabelMarker(labelCenter.lat, labelCenter.lng, o._roofLabel).addTo(pinMap);
    });
    historyPinsForContext.forEach(function(p){
      L.circleMarker([p.lat, p.lng], {
        radius: 6, color: "#fff", weight: 1.5, fillColor: "#90A4AE", fillOpacity: 0.7
      }).addTo(pinMap).bindPopup(pinPopupHtml(p));
    });
    if (fitActiveRoofBounds && activeLayerBounds) pinMap.fitBounds(activeLayerBounds, { padding: [24, 24] });
    pinMarker = L.marker([center.lat, center.lng], { draggable: true }).addTo(pinMap);
    pinMarker.on("drag", function(e){ checkPinRoofMismatch(e.target.getLatLng(), roofs, activeRoofId); });
    pinMarker.on("dragend", function(e){ pinInteracted = true; checkPinRoofMismatch(e.target.getLatLng(), roofs, activeRoofId); });
    pinMap.on("click", function(e){ pinMarker.setLatLng(e.latlng); pinInteracted = true; checkPinRoofMismatch(e.latlng, roofs, activeRoofId); });
    checkPinRoofMismatch(pinMarker.getLatLng(), roofs, activeRoofId);
    pinMap.invalidateSize();
    setTimeout(function(){ if (pinMap) pinMap.invalidateSize(); }, 300);
  }, 50);
}
/* Mark: "if the pin is inside Roof 4 but the dropdown says Roof 10, flag
   the mismatch rather than silently disagreeing." Same point-in-polygon
   geometry the GPS auto-assign work already uses (rmAssignPointToRoof()),
   run live as the pin is dragged/tapped/placed. Never auto-corrects the
   dropdown -- just surfaces the disagreement so a tech notices and picks
   deliberately, same "flag, don't guess" spirit as the rest of GPS
   auto-assign. Silent no-op for a single-roof building (nothing to
   disagree about) or a point outside every polygon (not confidently on
   ANY roof, not specifically the wrong one). */
function checkPinRoofMismatch(latlng, roofs, activeRoofId){
  var warnEl = document.getElementById("pin-roof-mismatch-warning");
  if (!warnEl) return;
  if (!roofs || roofs.length <= 1){ warnEl.style.display = "none"; return; }
  var result = rmAssignPointToRoof(latlng.lat, latlng.lng, roofs);
  if (result && result.roofId && !result.outsideAll && result.roofId !== activeRoofId){
    warnEl.textContent = "⚠️ This pin looks like it's actually on " + (result.label || "another roof") +
      ", not the roof selected above.";
    warnEl.style.display = "";
  } else {
    warnEl.style.display = "none";
  }
}
function closePinModal(){
  document.getElementById("pin-modal").style.display = "none";
  unlockBodyScroll();
  if (pinMap){ pinMap.remove(); pinMap = null; pinMarker = null; }
  pinModalFindingId = null;
  pinXYSize = null;
}

/* ================= roof assets (permanent roof features) =================
   Distinct from finding pins: a finding pin is historical (tied to one
   report, denormalized onto building_history_events, frozen-but-fixable
   per the sync above). A roof asset is the opposite — a permanent feature
   of the roof itself (drain, HVAC unit, hatch, skylight, safety hazard,
   etc.) that exists independent of any single work order or report, and
   is expected to be added/moved/removed as the roof itself changes.
   Stored directly on the building doc as roof_assets[]; buildings allow
   open client create/update per firestore.rules (only delete is blocked),
   so this needs no admin gating — any tech can maintain the roof's living
   blueprint, same as they can place a finding pin. */
var ROOF_ASSET_TYPES = {
  drain: { label: "Drain", emoji: "💧", color: "#1565C0" },
  scupper: { label: "Scupper", emoji: "🌊", color: "#0277BD" },
  hvac: { label: "HVAC Unit", emoji: "❄️", color: "#00838F" },
  pipe_flashing: { label: "Pipe Flashing", emoji: "🔧", color: "#6D4C41" },
  vent: { label: "Vent", emoji: "🌀", color: "#546E7A" },
  hatch: { label: "Roof Hatch", emoji: "🚪", color: "#5D4037" },
  expansion_joint: { label: "Expansion Joint", emoji: "➰", color: "#8D6E63" },
  skylight: { label: "Skylight", emoji: "🔲", color: "#0288D1" },
  curb: { label: "Curb", emoji: "▬", color: "#795548" },
  penetration: { label: "Penetration", emoji: "⚠️", color: "#EF6C00" },
  core_cut: { label: "Core Cut", emoji: "✂️", color: "#AD1457" },
  test_cut: { label: "Test Cut", emoji: "🔬", color: "#6A1B9A" },
  safety_hazard: { label: "Safety Hazard", emoji: "☠️", color: "#C62828" },
  other: { label: "Other", emoji: "📌", color: "#455A64" }
};
function assetIcon(type){
  var t = ROOF_ASSET_TYPES[type] || ROOF_ASSET_TYPES.other;
  return L.divIcon({
    className: "", iconSize: [26,26], iconAnchor: [13,13], popupAnchor: [0,-15],
    html: '<div style="background:' + t.color + ';color:#fff;width:26px;height:26px;border-radius:6px;' +
      'display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid #fff;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.4)">' + t.emoji + '</div>'
  });
}
function assetPopupHtml(buildingId, a){
  var t = ROOF_ASSET_TYPES[a.type] || ROOF_ASSET_TYPES.other;
  /* This map only ever renders the currently-selected roof's assets (see
     openBuildingHistory), so historySelectedRoofId is always the right
     roof for this marker's Edit button. */
  return "<b>" + t.emoji + " " + esc(t.label) + "</b>" + (a.label ? " — " + esc(a.label) : "") + "<br>" +
    (a.notes ? esc(a.notes) + "<br>" : "") +
    "<button class=\"btn\" style=\"margin-top:6px\" onclick=\"openAssetModal('" + buildingId + "','" + a.id + "','" + historySelectedRoofId + "')\">Edit</button>";
}
var assetMap = null, assetMarker = null, assetModalBuildingId = null, assetModalAssetId = null,
  assetModalRoofId = null, assetMapMode = "latlng", assetXYSize = null;
/* Shared roof_assets[] read-modify-write, used by both this modal (Building
   History's "+ Add Roof Feature") and RoofMapper's own inline placement
   (Phase 2.5, rmSaveFeature()/rmDeleteFeature()) so there's exactly one
   place that knows how to persist a roof asset, not two copies that could
   drift apart. See "RoofMapper Phase 2.5" in DEV_NOTES.md. */
async function persistRoofAsset(buildingId, roofId, asset){
  var snap = await fdb.collection("buildings").doc(buildingId).get();
  var roofs = getBuildingRoofs(snap.exists ? snap.data() : {});
  var roof = getRoofById(snap.exists ? snap.data() : {}, roofId);
  var assets = roof.roof_assets || [];
  var idx = assets.findIndex(function(a){ return a.id === asset.id; });
  if (idx >= 0){ asset.createdAt = assets[idx].createdAt || Date.now(); assets[idx] = asset; }
  else { asset.createdAt = Date.now(); assets.push(asset); }
  roof.roof_assets = assets;
  var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
  if (roofIdx >= 0) roofs[roofIdx] = roof; else roofs.push(roof);
  await saveBuildingRoofs(buildingId, roofs);
}
async function removeRoofAsset(buildingId, roofId, assetId){
  var snap = await fdb.collection("buildings").doc(buildingId).get();
  var roofs = getBuildingRoofs(snap.exists ? snap.data() : {});
  var roof = getRoofById(snap.exists ? snap.data() : {}, roofId);
  roof.roof_assets = (roof.roof_assets || []).filter(function(a){ return a.id !== assetId; });
  var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
  if (roofIdx >= 0) roofs[roofIdx] = roof; else roofs.push(roof);
  await saveBuildingRoofs(buildingId, roofs);
}
function populateAssetTypeSelect(){
  var sel = document.getElementById("asset-type");
  if (sel.options.length) return;
  Object.keys(ROOF_ASSET_TYPES).forEach(function(k){
    var opt = document.createElement("option");
    opt.value = k; opt.textContent = ROOF_ASSET_TYPES[k].emoji + " " + ROOF_ASSET_TYPES[k].label;
    sel.appendChild(opt);
  });
}
async function openAssetModal(buildingId, assetId, roofId){
  populateAssetTypeSelect();
  assetModalBuildingId = buildingId;
  assetModalAssetId = assetId || null;
  document.getElementById("asset-modal-title").textContent = assetId ? "Edit Roof Feature" : "Add Roof Feature";
  document.getElementById("asset-delete-btn").style.display = assetId ? "" : "none";
  document.getElementById("asset-hint").textContent = "Loading…";
  document.getElementById("asset-modal").style.display = "";
  lockBodyScroll();
  if (assetMap){ assetMap.remove(); assetMap = null; assetMarker = null; }
  /* Leaflet's tile panes use transform:translate3d for pan/zoom animation
     — on some mobile browsers that can composite ABOVE a position:fixed
     modal despite a lower z-index (a known Leaflet/mobile-Safari
     stacking-context quirk), which is what let the underlying Building
     History roof map visibly bleed through this modal's backdrop.
     Destroying it outright while this modal is open removes the
     compositing layer entirely rather than just trying to out-z-index
     it — closeAssetModal() rebuilds it via openBuildingHistory() every
     time this modal closes, save or not, so there's nothing left blank
     underneath once it's gone. */
  if (buildingMap){ buildingMap.remove(); buildingMap = null; }

  var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
  var bld = bldSnap.exists ? bldSnap.data() : {};
  var roof = getRoofById(bld, roofId);
  assetModalRoofId = roof.id;
  var assets = roof.roof_assets || [];
  var existing = assetId ? assets.find(function(a){ return a.id === assetId; }) : null;
  document.getElementById("asset-type").value = existing ? existing.type : "drain";
  document.getElementById("asset-label").value = existing ? (existing.label || "") : "";
  document.getElementById("asset-notes").value = existing ? (existing.notes || "") : "";

  var hasCustomBaseMap = !!((roof.roof_base_map_type === "roof_plan" || roof.roof_base_map_type === "sketch") && roof.roof_base_map_url);
  var orthoOverlay = (roof.roof_base_map_type === "drone_ortho" && roof.roof_base_map_url && roof.roof_base_map_bounds) ?
    { url: roof.roof_base_map_url, bounds: roof.roof_base_map_bounds } : null;

  if (hasCustomBaseMap){
    assetMapMode = "xy";
    var img = new Image();
    img.onload = function(){
      var w = img.naturalWidth, h = img.naturalHeight;
      assetXYSize = { w: w, h: h };
      var bounds = [[0,0],[h,w]];
      setTimeout(function(){
        assetMap = L.map("asset-map", { crs: L.CRS.Simple, minZoom: -5 });
        L.imageOverlay(roof.roof_base_map_url, bounds).addTo(assetMap);
        assets.forEach(function(a){
          if (a.id === assetId || typeof a.x !== "number") return;
          L.marker([a.y * h, a.x * w], { icon: assetIcon(a.type), opacity: 0.55 }).addTo(assetMap);
        });
        assetMap.fitBounds(bounds);
        var start = existing && typeof existing.x === "number" ? [existing.y * h, existing.x * w] : [h/2, w/2];
        assetMarker = L.marker(start, { draggable: true, icon: assetIcon(document.getElementById("asset-type").value) }).addTo(assetMap);
        assetMap.on("click", function(e){ assetMarker.setLatLng(e.latlng); });
        assetMap.invalidateSize();
        setTimeout(function(){ if (assetMap) assetMap.invalidateSize(); }, 300);
      }, 50);
      document.getElementById("asset-hint").textContent = "Tap the base map to place this feature.";
    };
    img.onerror = function(){
      toast("Couldn't load the custom base map — using satellite instead.");
      assetMapMode = "latlng";
      openAssetModalSatellite(bld, assets, existing, orthoOverlay, roof.roof_outlines);
    };
    img.src = roof.roof_base_map_url;
    return;
  }
  assetMapMode = "latlng";
  await openAssetModalSatellite(bld, assets, existing, orthoOverlay, roof.roof_outlines);
}
async function openAssetModalSatellite(bld, assets, existing, orthoOverlay, outlines){
  var center, zoom = 18;
  if (existing && typeof existing.lat === "number"){
    center = { lat: existing.lat, lng: existing.lng };
    zoom = 19;
  } else {
    var withCoords = assets.filter(function(a){ return typeof a.lat === "number"; });
    if (withCoords.length){
      center = { lat: withCoords[0].lat, lng: withCoords[0].lng };
      zoom = 19;
    } else if (orthoOverlay){
      var b = orthoOverlay.bounds;
      center = { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
    } else if (outlines && outlines.length && outlines[outlines.length - 1].ring && outlines[outlines.length - 1].ring.length){
      // No assets placed yet — center on the most recently saved outline
      // (fresh from RoofMapper) rather than a generic address geocode.
      var ring = outlines[outlines.length - 1].ring;
      var sumLat = 0, sumLng = 0;
      ring.forEach(function(p){ sumLat += p.lat; sumLng += p.lng; });
      center = { lat: sumLat / ring.length, lng: sumLng / ring.length };
      zoom = 19;
    } else {
      center = await geocodeAddress(bld.location || bld.name || "");
      if (!center){ center = { lat: 39.8283, lng: -98.5795 }; zoom = 4; }
    }
  }
  document.getElementById("asset-hint").textContent = "Tap the map to place this feature, or drag it into position.";
  setTimeout(function(){
    assetMap = L.map("asset-map").setView([center.lat, center.lng], zoom);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 22, maxNativeZoom: SAT_MAX_NATIVE_ZOOM, attribution: "Tiles &copy; Esri"
    }).addTo(assetMap);
    if (orthoOverlay) L.imageOverlay(orthoOverlay.url, boundsToLatLngBounds(orthoOverlay.bounds)).addTo(assetMap);
    /* RoofMapper <-> Roof Map unification, Phase 1: show the roof outline
       here too (same style as the Building History map) so the outline is
       visible as the canvas while actually placing the feature, not just
       on the read-only map you passed through to get here. */
    (outlines || []).forEach(function(o){
      if (!o.ring || o.ring.length < 3) return;
      L.polygon(o.ring.map(function(p){ return [p.lat, p.lng]; }), {
        color: "#E8600A", weight: 2, fillColor: "#E8600A", fillOpacity: 0.1
      }).addTo(assetMap);
    });
    assets.forEach(function(a){
      if ((existing && a.id === existing.id) || typeof a.lat !== "number") return;
      L.marker([a.lat, a.lng], { icon: assetIcon(a.type), opacity: 0.55 }).addTo(assetMap);
    });
    assetMarker = L.marker([center.lat, center.lng], { draggable: true, icon: assetIcon(document.getElementById("asset-type").value) }).addTo(assetMap);
    assetMap.on("click", function(e){ assetMarker.setLatLng(e.latlng); });
    assetMap.invalidateSize();
    setTimeout(function(){ if (assetMap) assetMap.invalidateSize(); }, 300);
  }, 50);
}
document.getElementById("asset-type") && document.getElementById("asset-type").addEventListener("change", function(){
  if (assetMarker) assetMarker.setIcon(assetIcon(this.value));
});
function closeAssetModal(){
  var buildingId = assetModalBuildingId;
  document.getElementById("asset-modal").style.display = "none";
  unlockBodyScroll();
  if (assetMap){ assetMap.remove(); assetMap = null; assetMarker = null; }
  assetModalBuildingId = null;
  assetModalAssetId = null;
  assetModalRoofId = null;
  assetXYSize = null;
  /* openAssetModal() destroyed the underlying Building History map
     entirely (see the comment there) — rebuild it every time this modal
     closes, save/delete or plain Cancel/Close alike, so the page never
     sits there with the map missing underneath. RoofMapper no longer opens
     this modal at all as of Phase 2.5 (it places features inline on its
     own map instead), so this path is Building History-only again. */
  if (buildingId) openBuildingHistory(buildingId);
}
async function saveAssetFromModal(){
  if (!assetMarker || !assetModalBuildingId) return;
  var ll = assetMarker.getLatLng();
  var asset = {
    id: assetModalAssetId || genId("ast"),
    type: document.getElementById("asset-type").value,
    label: document.getElementById("asset-label").value.trim(),
    notes: document.getElementById("asset-notes").value.trim(),
    lat: null, lng: null, x: null, y: null,
    updatedAt: Date.now()
  };
  if (assetMapMode === "xy" && assetXYSize){
    asset.x = ll.lng / assetXYSize.w;
    asset.y = ll.lat / assetXYSize.h;
  } else {
    asset.lat = ll.lat;
    asset.lng = ll.lng;
  }
  var buildingId = assetModalBuildingId, roofId = assetModalRoofId;
  try{
    await persistRoofAsset(buildingId, roofId, asset);
    toast("Roof feature saved ✓");
    closeAssetModal(); /* also rebuilds the underlying map — see closeAssetModal() */
  }catch(e){ toast("Couldn't save: " + e.message); }
}
async function deleteAssetFromModal(){
  if (!assetModalBuildingId || !assetModalAssetId) return;
  if (!confirm("Remove this roof feature?")) return;
  var buildingId = assetModalBuildingId, assetId = assetModalAssetId, roofId = assetModalRoofId;
  try{
    await removeRoofAsset(buildingId, roofId, assetId);
    toast("Roof feature removed");
    closeAssetModal(); /* also rebuilds the underlying map — see closeAssetModal() */
  }catch(e){ toast("Couldn't remove: " + e.message); }
}

function addRepair(data){
  repairs.push(data || {repair:"",location:""});
  renderRepairs();
}
function removeRepair(i){ repairs.splice(i,1); renderRepairs(); }
function renderRepairs(){
  var host = document.getElementById("repairs-list");
  host.innerHTML = "";
  repairs.forEach(function(r,i){
    var d = document.createElement("div");
    d.className = "rowcard";
    d.style.borderLeftColor = "#546E7A";
    d.innerHTML =
      '<div class="rowhead"><b>Repair #' + (i+1) + '</b><span class="sp"></span>' +
      '<button class="btn danger" onclick="removeRepair(' + i + ')">Remove</button></div>' +
      '<div class="fld"><label>Repair Performed</label>' +
      '<textarea rows="1" data-i="' + i + '" data-f="repair">' + esc(r.repair) + '</textarea></div>' +
      '<div class="fld"><label>Location / Detail</label>' +
      '<input type="text" data-i="' + i + '" data-f="location" value="' + esc(r.location) + '" list="dl-roofLocationDetail" onblur="rememberFieldValue(\'roofLocationDetail\', this.value)"></div>';
    host.appendChild(d);
  });
  host.querySelectorAll("[data-f]").forEach(function(el){
    el.addEventListener("input", function(){
      repairs[+el.dataset.i][el.dataset.f] = el.value;
    });
  });
}

/* Repair work order type only (see wo-repair-card / onWoTypeChange()) — an
   itemized scope list, e.g. "2x Curb", "1x Pipe Boot / Flashing". Type
   options are worded to align with the existing roof-asset vocabulary
   (ROOF_ASSET_TYPES) without being coupled to it — repair items aren't map
   pins, just line items on the report. Easy to extend: add a string here. */
var REPAIR_ITEM_TYPES = ["Curb","Pipe Boot / Flashing","Seam","Vent","Drain","Scupper",
  "Expansion Joint","Skylight","Roof Hatch","Penetration","Other"];
function addRepairItem(data){
  repairItems.push(data || {type:REPAIR_ITEM_TYPES[0], qty:"", notes:""});
  renderRepairItems();
}
function removeRepairItem(i){ repairItems.splice(i,1); renderRepairItems(); }
function renderRepairItems(){
  var host = document.getElementById("repairitems-list");
  if (!host) return;
  host.innerHTML = "";
  repairItems.forEach(function(it,i){
    var d = document.createElement("div");
    d.className = "rowcard";
    d.style.borderLeftColor = "#795548";
    d.innerHTML =
      '<div class="rowhead"><b>Item #' + (i+1) + '</b><span class="sp"></span>' +
      '<button class="btn danger" onclick="removeRepairItem(' + i + ')">Remove</button></div>' +
      '<div class="grid">' +
      '<div class="fld"><label>Type</label><select data-i="' + i + '" data-f="type">' +
        REPAIR_ITEM_TYPES.map(function(t){
          return '<option' + (it.type === t ? " selected" : "") + '>' + t + '</option>';
        }).join("") +
      '</select></div>' +
      '<div class="fld"><label>Quantity</label><input type="number" min="0" step="1" data-i="' + i + '" data-f="qty" value="' + esc(it.qty) + '"></div>' +
      '</div>' +
      '<div class="fld"><label>Notes / Location</label>' +
      '<input type="text" data-i="' + i + '" data-f="notes" value="' + esc(it.notes) + '" list="dl-repairItemNotes" onblur="rememberFieldValue(\'repairItemNotes\', this.value)"></div>';
    host.appendChild(d);
  });
  host.querySelectorAll("[data-f]").forEach(function(el){
    el.addEventListener("input", function(){
      repairItems[+el.dataset.i][el.dataset.f] = el.value;
    });
  });
}

var SIZE_PRESETS = {
  small:  { max: 900,  q: 0.62 },
  medium: { max: 1200, q: 0.72 },
  large:  { max: 1600, q: 0.80 }
};
/* Photo size used to be a per-user localStorage preference (photoSize
   select in the Photo Documentation card) — now it's a single
   admin-controlled global setting (app_settings/global in Firestore, via
   netlify/functions/admin.js's set_photo_size_pref action) so every
   user's photos come out the same size. globalPhotoSizePref defaults to
   "small" and is only ever changed by loadGlobalPhotoSizePref() (on
   startup) or saveGlobalPhotoSizePref() (admin only) below — see "Global
   photo size setting" in DEV_NOTES.md. The old "photo-size-pref"
   localStorage key is simply never read anymore; an existing value left
   over on a tech's device is harmless, orphaned data, not an error. */
var globalPhotoSizePref = "small";
function photoPreset(){
  return SIZE_PRESETS[globalPhotoSizePref] || SIZE_PRESETS.small;
}
/* Small, fast-loading companion to the full compressed photo -- stored in
   Firestore alongside a storageRef (see cloudSaveOrder() in core.js) so
   the photo gallery renders instantly without a Storage round-trip for
   every thumbnail; the full-resolution image is only fetched on demand
   (lightbox, PDF/preview export -- see resolvePhotoImg()/
   ensurePhotosLoadedForExport() in js/export.js). Drawn from the SAME
   already-decoded <img> element the full-size compression already loaded,
   never a second file read. See "Photo storage migration" in
   DEV_NOTES.md. */
var PHOTO_THUMB_MAX_DIM = 200;
var PHOTO_THUMB_QUALITY = 0.6;
function makeThumbDataUrl(img){
  var w = img.width, h = img.height;
  if (w > PHOTO_THUMB_MAX_DIM || h > PHOTO_THUMB_MAX_DIM){
    if (w >= h){ h = Math.round(h * PHOTO_THUMB_MAX_DIM / w); w = PHOTO_THUMB_MAX_DIM; }
    else { w = Math.round(w * PHOTO_THUMB_MAX_DIM / h); h = PHOTO_THUMB_MAX_DIM; }
  }
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", PHOTO_THUMB_QUALITY);
}
async function loadGlobalPhotoSizePref(){
  if (!fdb) return;
  try{
    var snap = await fdb.collection("app_settings").doc("global").get();
    if (snap.exists && snap.data().photoSizePref && SIZE_PRESETS[snap.data().photoSizePref]){
      globalPhotoSizePref = snap.data().photoSizePref;
    }
  }catch(e){
    /* No app_settings/global doc yet, offline, or Firestore rules for
       this collection haven't been applied in this environment yet —
       any of those just mean "keep the small default," never a hard
       error the user needs to see. */
  }
  var sel = document.getElementById("adminPhotoSize");
  if (sel) sel.value = globalPhotoSizePref;
}
async function saveGlobalPhotoSizePref(){
  if (!isAdmin) return;
  var v = document.getElementById("adminPhotoSize").value;
  try{
    await callAdminApi({ action: "set_photo_size_pref", value: v });
    globalPhotoSizePref = v;
    toast("Photo size updated for everyone ✓ (applies to new photos going forward)");
  }catch(e){
    toast("Couldn't update photo size: " + e.message);
  }
}
/* findingId (optional) -- passed when this is called from a finding's own
   card (increment 2 of the photo-capture rework) so the photo is
   associated with that finding from the moment it's added, instead of
   needing the separate dropdown in the global Photo Documentation
   section. Omitted (existing call sites) behaves exactly as before --
   finding_id: null, "General / no specific finding". */
/* EXIF GPS extraction for LIBRARY IMPORTS (addPhotosFromFiles). A photo the
   tech shot on their phone carries its location in EXIF, but our canvas resize
   re-encodes the image and drops ALL EXIF -- so a photo that HAD a GPS fix used
   to reach CompanyCam unpinned (Mark, 2026-07-15: "the photos I took then
   uploaded directly to CC have gps coords, the same photos the app uploaded do
   not"). Camera captures already carry device geolocation (addPhotosFromCamera);
   this recovers the coordinate for imports by parsing the EXIF GPS IFD out of the
   ORIGINAL file bytes BEFORE the resize throws them away. Pure, dependency-free,
   fully non-fatal: any malformed/absent EXIF returns null and the photo imports
   exactly as before. Rejects (0,0) and out-of-range, like everywhere else. */
function rmExifGpsFromTiff(view, tiff){
  var bo = view.getUint16(tiff);
  var little = bo === 0x4949; /* "II" little-endian; "MM" (0x4D4D) big-endian */
  if (!little && bo !== 0x4D4D) return null;
  var u16 = function(o){ return view.getUint16(o, little); };
  var u32 = function(o){ return view.getUint32(o, little); };
  if (u16(tiff + 2) !== 0x002A) return null;
  function entryFor(ifd, tag){
    var n = u16(ifd);
    for (var i = 0; i < n; i++){ var e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
    return -1;
  }
  var gpsPtr = entryFor(tiff + u32(tiff + 4), 0x8825);
  if (gpsPtr < 0) return null;
  var gps = tiff + u32(gpsPtr + 8);
  function ref(tag){ var e = entryFor(gps, tag); return e < 0 ? "" : String.fromCharCode(view.getUint8(e + 8)); }
  function dms(tag){
    var e = entryFor(gps, tag);
    if (e < 0 || u32(e + 4) < 3) return null;
    var base = tiff + u32(e + 8), out = 0, weight = [1, 1 / 60, 1 / 3600];
    for (var i = 0; i < 3; i++){
      var den = u32(base + i * 8 + 4);
      out += (den ? u32(base + i * 8) / den : 0) * weight[i];
    }
    return out;
  }
  var lat = dms(0x0002), lng = dms(0x0004);
  if (lat == null || lng == null) return null;
  if (ref(0x0001) === "S") lat = -lat;
  if (ref(0x0003) === "W") lng = -lng;
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: lat, lng: lng };
}
function parseExifGps(buffer){
  try{
    var view = new DataView(buffer);
    if (view.byteLength < 12 || view.getUint16(0) !== 0xFFD8) return null; /* not a JPEG */
    var offset = 2;
    while (offset + 4 <= view.byteLength){
      var marker = view.getUint16(offset);
      if ((marker & 0xFF00) !== 0xFF00) return null;
      if (marker === 0xFFE1){ /* APP1 -- Exif */
        var exif = offset + 4;
        if (exif + 6 <= view.byteLength && view.getUint32(exif) === 0x45786966 && view.getUint16(exif + 4) === 0){
          return rmExifGpsFromTiff(view, exif + 6);
        }
        return null;
      }
      if (marker === 0xFFDA) return null; /* start of scan -- image data, no EXIF beyond here */
      offset += 2 + view.getUint16(offset + 2); /* skip this segment */
    }
    return null;
  }catch(e){ return null; }
}
/* Parses EXIF GPS from a data-URL's leading bytes (the APP1 Exif segment sits
   right after SOI, so the first ~150KB always covers it -- no need to decode a
   multi-MB image in full). */
function dataUrlExifGps(dataUrl){
  try{
    var comma = String(dataUrl || "").indexOf(",");
    if (comma < 0) return null;
    var bin = atob(dataUrl.slice(comma + 1, comma + 1 + 200000));
    var n = bin.length, bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return parseExifGps(bytes.buffer);
  }catch(e){ return null; }
}
function addPhotosFromFiles(files, findingId){
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  var results = new Array(list.length);
  var pending = list.length;
  function done(){
    pending--;
    if (pending === 0){
      results.forEach(function(r){
        if (!r) return;
        photos.push(r);
        /* Offline-first (Mark, 2026-07-12): mirror into IndexedDB the
           instant a photo exists, before Save is ever tapped -- see the
           block comment on idbPutPhoto() in js/core.js. Fire-and-forget on
           purpose: never delay the tech seeing the photo in the gallery
           waiting on this. Once the IDB write is CONFIRMED, flag the photo
           _idbBacked so saveDb (leanDbReplacer) can drop its bytes from
           localStorage -- this is what lets a big batch of photos stop
           overflowing the ~5MB cache (Phase 1). */
        idbPutPhoto(r.localId, r.img).then(function(){ r._idbBacked = true; }).catch(function(){});
      });
      renderPhotos();
      if (findingId){
        if (findingById(findingId)) renderFindings();
        if (inspectionChecklistItemById(findingId)) renderInspectionChecklist();
      }
    }
  }
  list.forEach(function(file, idx){
    var reader = new FileReader();
    reader.onload = function(){
      /* EXIF GPS off the ORIGINAL bytes, before the canvas resize below strips
         it (see parseExifGps). null when the photo has no location -- then it
         behaves exactly as an import did before. */
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
        results[idx] = { caption:"", img: c.toDataURL("image/jpeg", preset.q), thumb: makeThumbDataUrl(img), w: w, h: h,
          finding_id: findingId || null, gps: exifGps, localId: makeLocalPhotoId() };
        done();
      };
      img.onerror = function(){ toast("Couldn't read one of the photos"); done(); };
      img.src = reader.result;
    };
    reader.onerror = function(){ toast("Couldn't read one of the photos"); done(); };
    reader.readAsDataURL(file);
  });
}
/* Mark's real Tri-Delta leak report: 11 of 12 photos had NO gps at all --
   confirmed against live data. captureDeviceGps() already fired on every
   camera capture (addPhotosFromCamera() below), but every failure reason
   (permission denied, no fix in time, position unavailable, no
   geolocation API at all) collapsed to the same bare `null`, and the only
   signal was a transient toast, easy to miss mid-shoot on a roof. A
   DENIED permission is the critical case: once blocked, EVERY future
   call on that device fails the exact same way, instantly, forever,
   until the tech fixes it in browser/OS settings -- which is exactly
   what a 100%-of-one-visit failure rate looks like. See "Photo GPS
   capture: explicit permission + persistent no-location indicator" in
   DEV_NOTES.md.

   captureDeviceGpsRaw() resolves { ok:true, lat, lng, accuracy } or
   { ok:false, reason } -- reason is "denied" | "timeout" | "unavailable" |
   "unsupported", NEVER rejects, so a capture flow can always just await
   it and keep going ("handle no-GPS/denied gracefully" per spec: the
   photo still saves either way, this only decides whether there's
   anything to auto-pin from / what to tell the tech). captureDeviceGps()
   wraps it: a high-accuracy GPS fix can genuinely take several seconds
   on a cold start (raised 8s -> RM_GPS_TIMEOUT_MS=12s to give it a real
   chance) -- and specifically on a TIMEOUT (not denied/unsupported,
   which will just fail identically again) retries ONCE at low accuracy
   (fast WiFi/cell-tower fix, coarse but far better than nothing) before
   giving up. Same accuracy expectations as useMyLocationForPin() above
   (~10-30ft, consumer GPS) -- this is a starting point for the pin, not
   a final placement. */
var RM_GPS_TIMEOUT_MS = 12000;
function captureDeviceGpsRaw(opts){
  return new Promise(function(resolve){
    if (!navigator.geolocation){ resolve({ ok: false, reason: "unsupported" }); return; }
    var settled = false;
    var timeoutMs = (opts && opts.timeout) || RM_GPS_TIMEOUT_MS;
    var timer = setTimeout(function(){
      if (settled) return; settled = true; resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
    navigator.geolocation.getCurrentPosition(function(pos){
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
    }, function(err){
      if (settled) return; settled = true; clearTimeout(timer);
      /* GeolocationPositionError codes: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT. */
      var reason = (err && err.code === 1) ? "denied" : (err && err.code === 3) ? "timeout" : "unavailable";
      resolve({ ok: false, reason: reason });
    }, Object.assign({ enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }, opts || {}));
  });
}
async function captureDeviceGps(){
  var result = await captureDeviceGpsRaw();
  if (result.ok || result.reason !== "timeout") return result;
  var fallback = await captureDeviceGpsRaw({ enableHighAccuracy: false, timeout: 5000 });
  return fallback;
}
/* Camera capture (input[capture=environment]) -- a deliberate separate
   path from addPhotosFromFiles() above, not a shared refactor: a photo
   taken right now, standing at the job, gets the device's current GPS
   attached; a photo picked from the library could be old or from
   somewhere else entirely, so that path is intentionally left untouched
   with no GPS guess attached. Same resize/compress pipeline either way.
   findingId (optional) -- same meaning as on addPhotosFromFiles() above.
   When present, auto-pin fires immediately (the photo already belongs to
   the finding the moment it's captured), instead of only once a tech
   later picks the finding from the global section's dropdown. */
function addPhotosFromCamera(files, findingId){
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  captureDeviceGps().then(function(result){
    var gps = result.ok ? { lat: result.lat, lng: result.lng, accuracy: result.accuracy } : null;
    var gpsFailReason = result.ok ? null : result.reason;
    /* "denied" gets its own, more direct message -- it's the persistent
       case: every future photo on this device will fail the exact same
       way until the tech fixes it in browser/OS settings, unlike a
       one-off timeout/unavailable. The transient toast either way is
       supplementary now, not the only signal -- see photoGpsBadgeHtml()
       for the lasting per-photo indicator that doesn't disappear after a
       few seconds. */
    if (gpsFailReason === "denied"){
      toast("📍 Location permission is blocked for this app — photos won't auto-place on the map. Enable location for this site in your browser/phone settings, then reopen the app.");
    } else if (gpsFailReason){
      toast("Photo added — location wasn't available, place the pin manually if needed.");
    }
    var results = new Array(list.length);
    var pending = list.length;
    async function done(){
      pending--;
      if (pending === 0){
        /* Sequential, not Promise.all -- maybeAutoPinFinding()/
           maybeAutoPinInspectionItem() are now async (GPS roof
           auto-assign, see rmMaybeAutoAssignRoofForPin()); awaiting each
           in order keeps this whole batch's photos processed before the
           renders below run, same net effect the old synchronous forEach
           had, just correctly waiting on the now-async roof lookup too. */
        for (var i = 0; i < results.length; i++){
          var r = results[i];
          if (!r) continue;
          photos.push(r);
          /* Offline-first (Mark, 2026-07-12) -- see the block comment on
             idbPutPhoto() in js/core.js. Fire-and-forget, never blocks the
             gallery/auto-pin flow below on it. Flag _idbBacked once the IDB
             write is confirmed so saveDb can drop the bytes from localStorage
             (Phase 1). IIFE binds this iteration's photo (var-scoped loop). */
          (function(pp){ idbPutPhoto(pp.localId, pp.img).then(function(){ pp._idbBacked = true; }).catch(function(){}); })(r);
          if (findingId){
            /* Exactly one of these actually does anything -- each checks
               its own array (findings[] vs inspectionChecklist[]) and
               no-ops if findingId doesn't match anything there. */
            await maybeAutoPinFinding(r);
            await maybeAutoPinInspectionItem(r);
          }
          /* Change Order has no findings to hang a pin off of, so a
             photo captured while editing a Change Order gets its own
             pin instead (see maybeAutoPinPhoto() below) -- scoped to
             that type only, so a Leak/Service photo added through the
             global section (findingId not yet set) doesn't pick up a
             pin it has no use for. */
          else if (val("woType") === "Change Order") maybeAutoPinPhoto(r);
        }
        renderPhotos();
        if (findingId){
          if (findingById(findingId)) renderFindings();
          if (inspectionChecklistItemById(findingId)) renderInspectionChecklist();
        }
      }
    }
    list.forEach(function(file, idx){
      var reader = new FileReader();
      reader.onload = function(){
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
          results[idx] = { caption:"", img: c.toDataURL("image/jpeg", preset.q), thumb: makeThumbDataUrl(img), w: w, h: h,
            finding_id: findingId || null, gps: gps, gpsFailReason: gpsFailReason, localId: makeLocalPhotoId() };
          done();
        };
        img.onerror = function(){ toast("Couldn't read the photo"); done(); };
        img.src = reader.result;
      };
      reader.onerror = function(){ toast("Couldn't read the photo"); done(); };
      reader.readAsDataURL(file);
    });
  });
}
/* Shared by maybeAutoPinFinding()/maybeAutoPinInspectionItem() below --
   Mark's design change: don't make him manually pick a roof per photo,
   derive it from the photo's own GPS via point-in-polygon
   (rmAssignPointToRoof()) against the resolved building's traced roofs.
   Single-roof building (or no roofs traced at all yet): nothing to
   compute, returns null -- the existing "roof_default" convention already
   handles that case everywhere downstream, no assignment needed. See
   "GPS auto-assign photos to roofs" in DEV_NOTES.md. */
async function rmMaybeAutoAssignRoofForPin(lat, lng){
  try{
    var info = await lookupProspectiveBuildingRoofInfo();
    if (!info || info.roofs.length <= 1) return null;
    return rmAssignPointToRoof(lat, lng, info.roofs);
  }catch(e){ return null; }
}
/* Auto-drops a finding's pin from a photo's captured GPS the moment a
   GPS-tagged photo becomes associated with that finding -- reuses the
   exact same finding.pin shape/field the manual pin modal already writes
   (source:"device_gps" matches useMyLocationForPin()'s convention), so
   nothing downstream (roof map rendering, PDF pin refs, warrantyColor)
   needs to know this pin came from a photo instead of a manual tap.
   Never overwrites an existing pin -- a tech's manual placement or an
   earlier auto-pin always wins. Also auto-assigns f.roofId from the same
   GPS on a multi-roof building -- f.roofIdAmbiguous flags a low-confidence
   guess for review (renderFindings()'s roof badge, renderPinRoofPicker())
   rather than trusting it silently; pinSelectFindingRoof() clears the flag
   once a tech confirms/corrects it. */
async function maybeAutoPinFinding(photo){
  if (!photo || !photo.gps || !photo.finding_id) return;
  var f = findingById(photo.finding_id);
  if (!f || f.pin) return;
  f.pin = { lat: photo.gps.lat, lng: photo.gps.lng, x: null, y: null, source: "device_gps" };
  var assignment = await rmMaybeAutoAssignRoofForPin(photo.gps.lat, photo.gps.lng);
  var roofMsg = "";
  if (assignment && assignment.roofId){
    f.roofId = assignment.roofId;
    f.roofIdAmbiguous = !!assignment.ambiguous;
    roofMsg = " — assigned to " + assignment.label + (assignment.ambiguous ? " (please confirm)" : "");
  } else if (assignment && assignment.outsideAll){
    f.roofIdAmbiguous = true;
    roofMsg = " — couldn't tell which roof, please pick one";
  }
  renderFindings();
  toast("📍 Pin auto-placed on the roof map from the photo's location" + roofMsg + ".");
}
/* Inspection-checklist equivalent of maybeAutoPinFinding() above -- a
   checklist item's own `pin` field (independent of linkedFindingId/
   findings[], see ensureInspectionChecklist()), same shape/source
   convention, same never-overwrite rule. This is the anchor for
   before/after comparison: the inspection photo is the "before" at this
   pin, a later repair photo at the same spot is the "after" -- see
   "Inspection checklist photo pinning" in DEV_NOTES.md/ROADMAP.md. No
   manual drag-to-adjust UI for a checklist item's pin (unlike findings) --
   scoped to "captures, auto-pins" per spec, not full pin-modal parity.
   Same GPS roof auto-assign as maybeAutoPinFinding() above. */
async function maybeAutoPinInspectionItem(photo){
  if (!photo || !photo.gps || !photo.finding_id) return;
  var item = inspectionChecklistItemById(photo.finding_id);
  if (!item || item.pin) return;
  item.pin = { lat: photo.gps.lat, lng: photo.gps.lng, x: null, y: null, source: "device_gps" };
  var assignment = await rmMaybeAutoAssignRoofForPin(photo.gps.lat, photo.gps.lng);
  if (assignment && assignment.roofId){
    item.roofId = assignment.roofId;
    item.roofIdAmbiguous = !!assignment.ambiguous;
  } else if (assignment && assignment.outsideAll){
    item.roofIdAmbiguous = true;
  }
  renderInspectionChecklist();
  toast("📍 Pin auto-placed on the roof map from the photo's location" +
    (assignment && assignment.roofId ? " — assigned to " + assignment.label + (assignment.ambiguous ? " (please confirm)" : "") : "") + ".");
}
/* Change Order equivalent of maybeAutoPinFinding() above -- a Change
   Order has no findings, so each photo carries its own pin instead of
   sharing one. Same shape/source convention, same never-overwrite rule.
   photo.pin is new and additive: unused/absent for every other work
   order type and for photos added before this shipped. Deliberately NOT
   wired into the roof map or Building History aggregate view yet (no
   drag-to-adjust UI either) -- scoped to "captured, auto-pinned, shown
   on the change order and its PDF" per spec, not a full parity feature
   with finding pins. A natural follow-up if Mark wants it. */
function maybeAutoPinPhoto(photo){
  if (!photo || !photo.gps || photo.pin) return;
  photo.pin = { lat: photo.gps.lat, lng: photo.gps.lng, x: null, y: null, source: "device_gps" };
}
function removePhoto(i){
  var removed = photos[i];
  photos.splice(i,1);
  renderPhotos();
  /* A removed photo might have been shown in its finding's (or inspection
     checklist item's) embedded gallery -- refresh whichever one so it
     doesn't linger there after being removed globally. */
  if (removed && removed.finding_id){
    if (findingById(removed.finding_id)) renderFindings();
    if (inspectionChecklistItemById(removed.finding_id)) renderInspectionChecklist();
  }
  /* Housekeeping only -- the photo is already fully gone from the order
     the moment it's removed from the in-memory array above and (once
     Saved) from Firestore/Storage; this just clears its now-orphaned
     IndexedDB backup instead of leaving it forever. Safe to fire-and-
     forget: nothing downstream depends on this completing. */
  if (removed && removed.localId) idbDeletePhoto(removed.localId);
}
/* Replace a photo IN PLACE at its existing slot, rather than appending a
   fresh one to the end. This is the recovery path for a dead slot (an image
   whose bytes were lost — see photoSlotIsEmpty/ensurePhotosLoadedForExport):
   the tech picks a replacement and it lands in the SAME position, keeping the
   slot's caption and finding assignment instead of leaving a blank behind and
   adding a stray photo at the bottom. Same decode/resize/compress pipeline as
   addPhotosFromFiles(); GPS comes from the NEW image's EXIF (the old slot had
   no usable data anyway). Opens its own one-shot file picker so it can be
   wired to a single per-slot button. */
function replacePhotoAt(i){
  if (i < 0 || i >= photos.length) return;
  var input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  input.onchange = function(){
    var file = input.files && input.files[0];
    if (file) processReplacementPhoto(i, file);
    if (input.parentNode) input.parentNode.removeChild(input);
  };
  document.body.appendChild(input);
  input.click();
}
function processReplacementPhoto(i, file){
  var old = photos[i] || {};
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
      /* Keep the slot's caption + finding assignment; the new image supplies
         everything else. A brand-new localId so it can't collide with the
         dead slot's orphaned IndexedDB key. */
      photos[i] = { caption: old.caption || "", img: c.toDataURL("image/jpeg", preset.q),
        thumb: makeThumbDataUrl(img), w: w, h: h,
        finding_id: old.finding_id || null, gps: exifGps, localId: makeLocalPhotoId() };
      idbPutPhoto(photos[i].localId, photos[i].img);
      renderPhotos();
      if (photos[i].finding_id){
        if (findingById(photos[i].finding_id)) renderFindings();
        if (inspectionChecklistItemById(photos[i].finding_id)) renderInspectionChecklist();
      }
      toast("Photo " + (i + 1) + " replaced");
    };
    img.onerror = function(){ toast("Couldn't read that photo"); };
    img.src = reader.result;
  };
  reader.onerror = function(){ toast("Couldn't read that photo"); };
  reader.readAsDataURL(file);
}
/* Swaps two photos in place — works identically for a device-uploaded photo
   or a CompanyCam import, since both end up in the same photos[] shape
   (caption/img/w/h/finding_id, +ccPhotoId/gps for CompanyCam ones). The
   whole photo object moves together, so caption/finding/ccPhotoId always
   stay attached to the right image. Nothing downstream needs to know this
   happened — buildText()/the PDF builder/filledPhotos() all just iterate
   the photos[] array in order, so a reorder here is automatically the
   report order too. Tap-to-move (▲▼) is the primary, mobile-reliable path
   — HTML5 drag-and-drop below is a desktop-only bonus layered on top,
   since touch drag-and-drop is notoriously unreliable on iOS. */
function movePhoto(i, dir){
  var j = i + dir;
  if (j < 0 || j >= photos.length) return;
  var tmp = photos[i];
  photos[i] = photos[j];
  photos[j] = tmp;
  renderPhotos();
}
var photoDragFromIndex = null;
function photoDragStart(i){ photoDragFromIndex = i; }
function photoDragOver(e){ e.preventDefault(); }
function photoDrop(e, i){
  e.preventDefault();
  if (photoDragFromIndex === null || photoDragFromIndex === i) return;
  var moved = photos.splice(photoDragFromIndex, 1)[0];
  photos.splice(i, 0, moved);
  photoDragFromIndex = null;
  renderPhotos();
}
/* Photos off base64/localStorage onto Storage (see "Photo storage
   migration" in DEV_NOTES.md) means p.img is no longer guaranteed to
   already be in memory -- shows the small thumb instantly as a
   placeholder (if one's cached) while resolvePhotoImg() fetches the real
   full-resolution image from Storage in the background, then swaps to it
   once loaded. */
async function openPhotoLightbox(i){
  var p = photos[i];
  if (!p) return;
  if (p.thumb || p.imgFallback || p.img) openImageLightbox(p.thumb || p.imgFallback || p.img);
  var full = await resolvePhotoImg(p);
  if (full) openImageLightbox(full);
  else if (!p.thumb && !p.imgFallback && !p.img) toast("Couldn't load this photo — check your internet connection.");
}
/* Pulled out of openPhotoLightbox() so anything with a bare image data-URL
   (not necessarily an index into the global photos[] array -- e.g. a
   feedback screenshot in the admin backlog) can reuse the same lightbox
   UI. See "Send Feedback" in DEV_NOTES.md. */
function openImageLightbox(src){
  document.getElementById("photo-lightbox-img").src = src;
  document.getElementById("photo-lightbox").style.display = "";
  lockBodyScroll();
}
function closePhotoLightbox(){
  document.getElementById("photo-lightbox").style.display = "none";
  document.getElementById("photo-lightbox-img").src = "";
  unlockBodyScroll();
}

