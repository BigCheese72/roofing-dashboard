"use strict";
/* ================= custom base maps (Phase 4, admin-only) =================
   A building's base map is shared/building-wide (affects every future
   report's pin placement and the history map), not per-work-order draft
   data, so both setting and clearing it go through the same admin-gated,
   server-enforced path as the delete actions — see set_building_roof_map
   in netlify/functions/admin.js. Images are stored as CompanyCam project
   documents (per DEV_NOTES.md — no Firebase Storage), so this requires
   the building to already have a linked CompanyCam project. */
function renderBaseMapAdminCard(buildingId, roof, companyCamProjectId){
  var hasMap = roof.roof_base_map_type && roof.roof_base_map_url;
  var hasProject = !!companyCamProjectId;
  var safeId = buildingId.replace(/[^A-Za-z0-9_-]/g, "") + "_" + roof.id.replace(/[^A-Za-z0-9_-]/g, "");
  var b = roof.roof_base_map_bounds;
  return '<div class="card"><h2 class="cond">Roof Base Map (admin)</h2>' +
    '<p class="hint">By default, pins on this roof are placed on a live satellite photo. A ' +
      'custom base map replaces that with your own image instead — useful when satellite ' +
      'detail isn’t good enough (heavy rooftop equipment, complex multi-section roofs, etc).</p>' +
    (hasMap ?
      '<p class="hint">Current base map: ' + esc(roof.roof_base_map_type.replace("_"," ")) +
        ' — <a href="' + esc(roof.roof_base_map_url) + '" target="_blank" rel="noopener">view image</a>' +
        (b ? ' (bounds: N ' + b.north.toFixed(5) + ', S ' + b.south.toFixed(5) + ', E ' + b.east.toFixed(5) + ', W ' + b.west.toFixed(5) + ')' : '') +
        '</p>' +
      '<div class="btnrow"><button class="btn danger" onclick="clearRoofBaseMap(\'' + buildingId + '\', \'' + roof.id + '\')">Clear Base Map</button> ' +
        '<span class="hint">Clearing goes back to satellite.</span></div>'
      : '<p class="hint"><b>No base map set — this roof is using satellite.</b></p>') +
    (hasProject ?
      '<input type="file" id="basemap-file-' + safeId + '" accept="image/*" style="display:none" ' +
        'onchange="uploadRoofBaseMap(\'' + buildingId + '\', this.files, \'' + roof.id + '\'); this.value=\'\';">' +
      '<p class="hint" style="margin-bottom:4px">Two ways to add one:</p>' +
      '<div class="fld" style="max-width:320px">' +
        '<label>Type</label>' +
        '<select id="basemap-type-' + safeId + '" onchange="toggleBaseMapBoundsFields(\'' + safeId + '\')">' +
          '<option value="roof_plan">Roof Plan — upload an image, ready to use</option>' +
          '<option value="sketch">Sketch — upload an image, ready to use</option>' +
          '<option value="drone_ortho">Drone Orthomosaic — needs an extra step first, see below</option>' +
        '</select></div>' +
      '<div id="basemap-simple-hint-' + safeId + '">' +
        '<p class="hint">Just a photo of the roof plan or a hand-drawn sketch. Tap ' +
          '<b>Upload Base Map</b> below and pick the image — that’s it, no extra tools needed.</p>' +
      '</div>' +
      '<div id="basemap-bounds-' + safeId + '" style="display:none">' +
        '<p class="hint">A drone orthomosaic gives pin placement real GPS accuracy, but the raw ' +
          'file is too large for the app to read directly. First, on a computer, run the ' +
          'companion tool (<code>tools/geotiff_to_webmap.py</code>) against the raw drone file — ' +
          'it prints the exact North/South/East/West numbers below and produces a smaller image ' +
          'to upload. This building’s ID for that tool: <code>' + esc(buildingId) + '</code> ' +
          '<button class="btn" style="padding:2px 8px;font-size:11px" onclick="copyBuildingId(\'' + buildingId + '\')">Copy</button></p>' +
        '<p class="hint">Then paste the bounds it printed here:</p>' +
        '<div class="grid">' +
          '<div class="fld"><label>North</label><input type="text" id="basemap-north-' + safeId + '"></div>' +
          '<div class="fld"><label>South</label><input type="text" id="basemap-south-' + safeId + '"></div>' +
          '<div class="fld"><label>East</label><input type="text" id="basemap-east-' + safeId + '"></div>' +
          '<div class="fld"><label>West</label><input type="text" id="basemap-west-' + safeId + '"></div>' +
        '</div></div>' +
      '<div class="btnrow">' +
        '<button class="btn" onclick="document.getElementById(\'basemap-file-' + safeId + '\').click()">Upload Base Map</button>' +
      '</div>'
      : '<p class="hint">Uploading a base map needs a CompanyCam project linked to this building ' +
        'first — the image itself is stored as a CompanyCam document, the same way generated ' +
        'PDF reports are. Import photos from any work order for this building via ' +
        '<b>Import from CompanyCam</b> and it’ll link automatically — then this card will let ' +
        'you upload here.</p>') +
    '</div>';
}
/* Visible to everyone (read-only) — every field falls back to a muted
   "Not set" so a roof with no profile yet (all of them, before an admin
   fills one in) still renders cleanly, no blanks or crashes. Editing
   (the button below) is admin-only; see the roof profile section above
   for why saves route through admin.js instead of a direct client write. */
function profileFieldRow(label, value, suffix){
  var shown = (value === null || value === undefined || value === "") ?
    '<span class="hint">Not set</span>' : esc(String(value)) + (suffix || "");
  return '<div class="evt-row"><b>' + esc(label) + ':</b> ' + shown + '</div>';
}
function renderRoofProfileCard(buildingId, roof){
  var p = getRoofProfile(roof);
  var editBtnHtml = isAdmin ?
    '<button class="btn" onclick="openRoofProfileModal(\'' + buildingId + '\', \'' + roof.id + '\')">Edit Profile</button>' : '';
  return '<div class="card"><h2 class="cond">Roof Profile</h2>' +
    '<div class="grid">' +
      '<div>' +
        profileFieldRow("Roof System", roof.roofSystem) +
        profileFieldRow("Install Date", p.installDate) +
        profileFieldRow("Estimated Age", p.estimatedAgeYears, " years") +
        profileFieldRow("Health Score", p.healthScore, "/100") +
        profileFieldRow("Condition", p.condition) +
        profileFieldRow("Manufacturer", p.manufacturer) +
        profileFieldRow("Deck Type", p.deckType) +
        profileFieldRow("Insulation Type", p.insulationType) +
      '</div>' +
      '<div>' +
        profileFieldRow("Warranty Provider", p.warrantyProvider) +
        profileFieldRow("Warranty Expiration", p.warrantyExpiration) +
        profileFieldRow("Warranty Status", p.warrantyStatus) +
        profileFieldRow("Estimated Remaining Life", p.estimatedRemainingLifeYears, " years") +
        profileFieldRow("Drainage Notes", p.drainageNotes) +
        profileFieldRow("Customer Contacts", p.customerContacts) +
        profileFieldRow("Internal Notes", p.internalNotes) +
        profileFieldRow("Replacement History", p.replacementHistory) +
      '</div>' +
    '</div>' +
    (editBtnHtml ? '<div class="btnrow">' + editBtnHtml + '</div>' : '') +
    '</div>';
}
function toggleBaseMapBoundsFields(safeId){
  var typeSel = document.getElementById("basemap-type-" + safeId);
  var isDrone = typeSel && typeSel.value === "drone_ortho";
  var boundsDiv = document.getElementById("basemap-bounds-" + safeId);
  if (boundsDiv) boundsDiv.style.display = isDrone ? "" : "none";
  var simpleHintDiv = document.getElementById("basemap-simple-hint-" + safeId);
  if (simpleHintDiv) simpleHintDiv.style.display = isDrone ? "none" : "";
}
function copyBuildingId(id){
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = id; document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); toast("Building ID copied ✓"); }
    catch(e){ toast("Copy failed — select the ID text manually"); }
    document.body.removeChild(ta);
  }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(id).then(function(){ toast("Building ID copied ✓"); }, fallback);
  } else fallback();
}
function resizeImageFile(file, maxDim, quality){
  return new Promise(function(res, rej){
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var w = img.width, h = img.height;
        if (w > maxDim || h > maxDim){
          if (w >= h){ h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        res(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = function(){ rej(new Error("Couldn't read the image")); };
      img.src = reader.result;
    };
    reader.onerror = function(){ rej(new Error("Couldn't read the file")); };
    reader.readAsDataURL(file);
  });
}
async function uploadRoofBaseMap(buildingId, files, roofId){
  if (!isAdmin){ toast("Admin mode required."); return; }
  var f = files && files[0];
  if (!f) return;
  var safeId = buildingId.replace(/[^A-Za-z0-9_-]/g, "") + "_" + String(roofId || "").replace(/[^A-Za-z0-9_-]/g, "");
  var typeSel = document.getElementById("basemap-type-" + safeId);
  var type = typeSel ? typeSel.value : "roof_plan";
  var bounds = null;
  if (type === "drone_ortho"){
    var n = parseFloat(val("basemap-north-" + safeId));
    var s = parseFloat(val("basemap-south-" + safeId));
    var e = parseFloat(val("basemap-east-" + safeId));
    var w = parseFloat(val("basemap-west-" + safeId));
    if (![n,s,e,w].every(function(x){ return isFinite(x); }) || n <= s || e <= w){
      toast("Enter valid North/South/East/West bounds first (from tools/geotiff_to_webmap.py's output).");
      return;
    }
    bounds = { north: n, south: s, east: e, west: w };
  }
  toast("Uploading base map…");
  try{
    var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = bldSnap.exists ? bldSnap.data() : {};
    if (!bld.companyCamProjectId) throw new Error("no CompanyCam project linked to this building");
    var dataUrl = await resizeImageFile(f, 2000, 0.85);
    var base64 = dataUrl.split("base64,")[1];
    if (!base64) throw new Error("couldn't encode the image");
    var out = await ccApiPost({ action: "upload_document", project_id: bld.companyCamProjectId,
      name: (f.name || "roof-base-map") + ".jpg", attachment: base64 });
    var url = out.document && out.document.url;
    if (!url) throw new Error("CompanyCam didn't return a URL for the uploaded file");
    var apiBody = { action: "set_building_roof_map", buildingId: buildingId, roofId: roofId || null,
      roof_base_map_type: type, roof_base_map_url: url };
    if (bounds) apiBody.roof_base_map_bounds = bounds;
    await callAdminApi(apiBody);
    toast("Base map saved ✓");
    openBuildingHistory(buildingId);
  }catch(e){
    toast("Base map upload failed: " + e.message);
  }
}
async function clearRoofBaseMap(buildingId, roofId){
  if (!isAdmin){ toast("Admin mode required."); return; }
  if (!confirm("Clear this building's custom base map? Pins will fall back to satellite.")) return;
  toast("Clearing…");
  try{
    await callAdminApi({ action: "set_building_roof_map", buildingId: buildingId, roofId: roofId || null,
      roof_base_map_type: null, roof_base_map_url: null });
    toast("Base map cleared ✓");
    openBuildingHistory(buildingId);
  }catch(e){
    toast("Failed: " + e.message);
  }
}
var profileModalBuildingId = null, profileModalRoofId = null;
async function openRoofProfileModal(buildingId, roofId){
  if (!isAdmin){ toast("Admin mode required."); return; }
  profileModalBuildingId = buildingId;
  profileModalRoofId = roofId;
  var condSel = document.getElementById("profile-condition");
  if (!condSel.options.length){
    condSel.appendChild(new Option("(not set)", ""));
    ROOF_CONDITION_OPTIONS.forEach(function(c){ condSel.appendChild(new Option(c, c)); });
  }
  var warrSel = document.getElementById("profile-warrantystatus");
  if (!warrSel.options.length){
    warrSel.appendChild(new Option("(not set)", ""));
    ROOF_WARRANTY_STATUS_OPTIONS.forEach(function(w){ warrSel.appendChild(new Option(w, w)); });
  }
  document.getElementById("profile-modal").style.display = "";
  lockBodyScroll();
  var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
  var roof = getRoofById(bldSnap.exists ? bldSnap.data() : {}, roofId);
  var p = getRoofProfile(roof);
  setVal("profile-roofsystem", roof.roofSystem || "");
  setVal("profile-installdate", p.installDate || "");
  setVal("profile-estimatedage", p.estimatedAgeYears != null ? p.estimatedAgeYears : "");
  setVal("profile-healthscore", p.healthScore != null ? p.healthScore : "");
  setVal("profile-condition", p.condition || "");
  setVal("profile-manufacturer", p.manufacturer || "");
  setVal("profile-decktype", p.deckType || "");
  setVal("profile-insulationtype", p.insulationType || "");
  setVal("profile-warrantyprovider", p.warrantyProvider || "");
  setVal("profile-warrantyexpiration", p.warrantyExpiration || "");
  setVal("profile-warrantystatus", p.warrantyStatus || "");
  setVal("profile-remaininglife", p.estimatedRemainingLifeYears != null ? p.estimatedRemainingLifeYears : "");
  setVal("profile-drainagenotes", p.drainageNotes || "");
  setVal("profile-customercontacts", p.customerContacts || "");
  setVal("profile-internalnotes", p.internalNotes || "");
  setVal("profile-replacementhistory", p.replacementHistory || "");
}
function closeRoofProfileModal(){
  document.getElementById("profile-modal").style.display = "none";
  unlockBodyScroll();
  profileModalBuildingId = null;
  profileModalRoofId = null;
}
function numOrNull(id){
  var v = val(id).trim();
  if (v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
async function saveRoofProfileFromModal(){
  if (!profileModalBuildingId) return;
  var buildingId = profileModalBuildingId, roofId = profileModalRoofId;
  var profile = {
    installDate: val("profile-installdate").trim(),
    estimatedAgeYears: numOrNull("profile-estimatedage"),
    healthScore: numOrNull("profile-healthscore"),
    condition: val("profile-condition"),
    manufacturer: val("profile-manufacturer").trim(),
    deckType: val("profile-decktype").trim(),
    insulationType: val("profile-insulationtype").trim(),
    warrantyProvider: val("profile-warrantyprovider").trim(),
    warrantyExpiration: val("profile-warrantyexpiration").trim(),
    warrantyStatus: val("profile-warrantystatus"),
    estimatedRemainingLifeYears: numOrNull("profile-remaininglife"),
    drainageNotes: val("profile-drainagenotes").trim(),
    customerContacts: val("profile-customercontacts").trim(),
    internalNotes: val("profile-internalnotes").trim(),
    replacementHistory: val("profile-replacementhistory").trim()
  };
  toast("Saving roof profile…");
  try{
    await callAdminApi({ action: "set_roof_profile", buildingId: buildingId, roofId: roofId,
      profile: profile, roofSystem: val("profile-roofsystem").trim() });
    toast("Roof profile saved ✓");
    closeRoofProfileModal();
    openBuildingHistory(buildingId);
  }catch(e){ toast("Couldn't save profile: " + e.message); }
}
/* ================= RoofMapper (Phase 1) =================
   Adapted from a component/hook/service folder structure to this app's
   single-file architecture. Each section below stands in for what would
   otherwise be a separate module file:
     types/roofMapperTypes    -> plain comment block just below (no TS build step here)
     utils/geometry           -> rmGeom* functions
     hooks/useGeolocation      -> rmGeoRequest()
     services/overpassService  -> rmFetchNearbyBuildings() + rmParseOverpassElements()
     services/exportService    -> rmExport*() / rmBuildOutlineSvg()
     components/RoofMapper     -> rm* state + view/render functions

   Shapes used throughout (documented here since there's no TS compiler):
     RmLatLng    = { lat, lng }
     RmFootprint = { id, osmType: "way"|"relation", ring: RmLatLng[], center: RmLatLng, tags }
     RmOutline   = { id?, ring: RmLatLng[], center, areaSqFt, perimeterFt,
                     source: "osm", osmId, osmType, tags, createdAt }

   Saved outlines live in `roof_outlines[]` directly on the `buildings`
   Firestore doc (see DATA_MODEL.md) — same additive, non-admin-gated
   pattern already used for `roof_assets[]` (drains/HVAC/etc): any tech can
   add one, `firestore.rules` already allows client `update` on a building
   doc, and nothing here ever deletes or rewrites unrelated building fields. */

/* ---- utils/geometry ---- */
function rmGeomHaversineMeters(a, b){
  var R = 6371000, toRad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  var la1 = a.lat * toRad, la2 = b.lat * toRad;
  var h = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
function rmGeomToLocalXY(point, origin){
  /* Flat-earth approximation, meters east/north of origin — fine at
     building scale, not meant for anything larger. */
  var mPerDegLat = 111320;
  var mPerDegLng = 111320 * Math.cos(origin.lat * Math.PI / 180);
  return { x: (point.lng - origin.lng) * mPerDegLng, y: (point.lat - origin.lat) * mPerDegLat };
}
/* Inverse of rmGeomToLocalXY -- turns a local meters-from-origin offset back
   into {lat,lng}. Used by calibration to scale points about a centroid. */
function rmGeomFromLocalXY(xy, origin){
  var mPerDegLat = 111320;
  var mPerDegLng = 111320 * Math.cos(origin.lat * Math.PI / 180);
  return { lat: origin.lat + xy.y / mPerDegLat, lng: origin.lng + xy.x / mPerDegLng };
}
/* Scales a single point toward/away from origin by factor (origin itself is
   unmoved). Building block for calibrate-by-known-edge -- see
   rmCalibrateEdge() below. */
function rmGeomScalePoint(point, origin, factor){
  var xy = rmGeomToLocalXY(point, origin);
  return rmGeomFromLocalXY({ x: xy.x * factor, y: xy.y * factor }, origin);
}
function rmGeomRingCentroid(ring){
  var lat = 0, lng = 0, n = ring.length;
  ring.forEach(function(p){ lat += p.lat; lng += p.lng; });
  return { lat: lat / n, lng: lng / n };
}
/* ---- GPS auto-assign: point-in-polygon against traced roof outlines ----
   Mark's design change: don't make him manually pick a roof per photo --
   a photo already carries GPS (captureDeviceGps()), and roofs are traced
   polygons with real coordinates, so the assignment is derivable. Used
   both live (maybeAutoPinFinding()/maybeAutoPinInspectionItem() below, at
   photo-capture time) and retroactively (rmAutoAssignExistingPinsToRoofs(),
   over already-saved historical pins). See "GPS auto-assign photos to
   roofs" in DEV_NOTES.md.

   Standard ray-casting test, lat/lng treated as planar -- valid at roof
   scale (a few hundred feet), same flat-earth approximation every other
   rmGeom* helper here already makes. */
function rmPointInRing(lat, lng, ring){
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++){
    var xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
    var intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
/* Shortest distance in METERS from a point to a ring's own boundary
   (nearest edge, clamped to each segment's actual extent) -- used to
   decide whether an assignment is confidently inside one roof or close
   enough to another that phone GPS (~3-5m accuracy) could plausibly have
   it wrong. Projects into a local meters-from-point tangent plane
   (rmGeomToLocalXY, same approximation the rest of this app already
   uses at this scale) rather than doing trig in lat/lng degrees directly. */
function rmDistanceToRingMeters(lat, lng, ring){
  var origin = { lat: lat, lng: lng };
  var minDistSq = Infinity;
  for (var i = 0; i < ring.length - 1; i++){
    var a = rmGeomToLocalXY(ring[i], origin), b = rmGeomToLocalXY(ring[i + 1], origin);
    var abx = b.x - a.x, aby = b.y - a.y;
    var lenSq = abx * abx + aby * aby;
    var t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (-a.x * abx + -a.y * aby) / lenSq));
    var px = a.x + t * abx, py = a.y + t * aby;
    var distSq = px * px + py * py;
    if (distSq < minDistSq) minDistSq = distSq;
  }
  return Math.sqrt(minDistSq);
}
/* Phone GPS accuracy floor -- his RTK drone is cm-accurate, his phone is
   not (~3-5m typical). A point within this distance of a DIFFERENT roof's
   boundary than the one it's assigned to gets flagged for review rather
   than silently trusted, even when it's technically inside exactly one
   polygon. */
var RM_GPS_AMBIGUITY_METERS = 6;
/* Best-effort roof assignment for one lat/lng against a building's roofs
   (each with roof_outlines[] -- uses the latest one, same "newest is
   current" convention as everywhere else). Returns null if no roof has a
   usable outline at all. Otherwise { roofId, label, ambiguous, outsideAll }:
   ambiguous means "assigned, but confirm this" (near a boundary, or fell
   outside every polygon but one roof was close); outsideAll means the
   point wasn't near anything and the returned roofId is just the
   nearest-by-distance fallback, weakest confidence. */
function rmAssignPointToRoof(lat, lng, roofs){
  var candidates = [];
  (roofs || []).forEach(function(roof){
    var outlines = roof.roof_outlines || [];
    var outline = outlines[outlines.length - 1];
    if (!outline || !outline.ring || outline.ring.length < 3) return;
    candidates.push({
      roofId: roof.id, label: roof.label || "Roof",
      inside: rmPointInRing(lat, lng, outline.ring),
      dist: rmDistanceToRingMeters(lat, lng, outline.ring)
    });
  });
  if (!candidates.length) return null;
  var insideOnes = candidates.filter(function(c){ return c.inside; });
  if (insideOnes.length >= 1){
    /* Exactly one match is the normal, confident case. More than one
       (overlapping polygons -- shouldn't happen once vertex/edge snapping
       ships, but handled gracefully in the meantime) picks the closest-
       to-center and flags it, rather than picking arbitrarily. */
    insideOnes.sort(function(a, b){ return a.dist - b.dist; });
    var best = insideOnes[0];
    var nearAnotherBoundary = candidates.some(function(c){
      return c.roofId !== best.roofId && c.dist < RM_GPS_AMBIGUITY_METERS;
    });
    return { roofId: best.roofId, label: best.label, ambiguous: insideOnes.length > 1 || nearAnotherBoundary, outsideAll: false };
  }
  /* Outside every polygon -- fall back to nearest by distance, but only
     trust it (even as a flagged guess) within the GPS ambiguity floor;
     beyond that, don't guess at all. */
  candidates.sort(function(a, b){ return a.dist - b.dist; });
  var nearest = candidates[0];
  if (nearest.dist < RM_GPS_AMBIGUITY_METERS){
    return { roofId: nearest.roofId, label: nearest.label, ambiguous: true, outsideAll: false };
  }
  return { roofId: null, label: null, ambiguous: true, outsideAll: true };
}
/* Persistent roof-name label -- distinct styling from the per-edge
   dimension labels (blue instead of dark slate, larger/bolder) so the two
   read as different kinds of information at a glance. Shared by RoofMapper
   itself and Building History's roof map -- both draw one of these per
   roof, at that roof's most recent outline centroid, non-interactive (the
   outline polygon underneath keeps its own tap/popup). See "Individual-
   roof tracing + labels" in DEV_NOTES.md. */
/* onClick is optional -- when passed (RoofMapper's own linked-roof label
   only, see rmSaveOutlineToBuilding()/rmRenameLinkedRoof() below), the
   label becomes tappable with a visible pencil hint, so renaming a roof
   is discoverable right on the map itself, not buried in a menu. Building
   History's own use of this same helper (renderBuildingMap(), viewing
   every roof on a building at once) omits onClick and stays exactly as
   before -- non-interactive, purely a label there. See "Rename a roof,
   discoverable from RoofMapper" in DEV_NOTES.md.
   onDragEnd is also optional (RoofMapper's own linked-roof label only,
   same as onClick) -- Mark: "he must be able to MOVE THE ROOF LABEL
   AROUND." Makes the marker Leaflet-draggable (cursor:move) and fires
   onDragEnd({lat,lng}) with wherever it was dropped; Leaflet's own drag
   handler already suppresses the click event for a real drag, so tap-to-
   rename and drag-to-reposition coexist on the same marker with no extra
   logic needed here. See "Draggable roof labels" in DEV_NOTES.md. */
function roofLabelMarker(lat, lng, text, onClick, onDragEnd){
  var marker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: "", iconSize: null,
      html: '<div style="background:#1976D2;color:#fff;padding:4px 10px;border-radius:5px;' +
        'font-size:12px;font-weight:700;white-space:nowrap;transform:translate(-50%,-50%);' +
        'box-shadow:0 1px 4px rgba(0,0,0,.45);border:1.5px solid rgba(255,255,255,.85)' +
        (onDragEnd ? ';cursor:move' : (onClick ? ';cursor:pointer' : '')) + '">' +
        esc(text) + (onClick ? ' ✏️' : '') + '</div>'
    }),
    interactive: !!(onClick || onDragEnd),
    draggable: !!onDragEnd
  });
  if (onClick) marker.on("click", onClick);
  if (onDragEnd) marker.on("dragend", function(){ var p = marker.getLatLng(); onDragEnd({ lat: p.lat, lng: p.lng }); });
  return marker;
}
function rmGeomPolygonAreaSqMeters(ring){
  var origin = rmGeomRingCentroid(ring);
  var pts = ring.map(function(p){ return rmGeomToLocalXY(p, origin); });
  var area = 0;
  for (var i = 0; i < pts.length; i++){
    var a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}
function rmGeomPolygonPerimeterMeters(ring){
  var total = 0;
  for (var i = 0; i < ring.length - 1; i++) total += rmGeomHaversineMeters(ring[i], ring[i + 1]);
  return total;
}
/* ---- Split a roof outline into multiple labeled sections ("blob-splitting")
   Mark: an auto-pulled OSM footprint (or a hand trace) is often really
   several distinct roof sections -- a warehouse + office annex, several
   buildings on one parcel -- captured as one blob. This lets him draw a
   straight split line between two points on the outline's own boundary
   and get two independent sections back, each re-splittable again, each
   becoming its own real roof (own roofId/label/area/features) on save.
   See "Split a roof outline into labeled sections" in DEV_NOTES.md and
   rmStartSplitting() below for the interactive/UI side. */

/* Point-in-polygon (ray casting), same flat-earth local-XY approximation
   as every other roof-scale geometry helper above -- used only as a
   sanity check that a proposed split line's midpoint actually lies inside
   the shape being split (rejects a chord that would cut outside it, e.g.
   corner-to-corner across an L-shaped outline). */
function rmGeomPointInRing(pt, ring){
  var origin = rmGeomRingCentroid(ring);
  var p = rmGeomToLocalXY(pt, origin);
  var verts = ring.map(function(v){ return rmGeomToLocalXY(v, origin); });
  var inside = false;
  for (var i = 0, j = verts.length - 1; i < verts.length; j = i++){
    var vi = verts[i], vj = verts[j];
    var intersects = ((vi.y > p.y) !== (vj.y > p.y)) &&
      (p.x < (vj.x - vi.x) * (p.y - vi.y) / (vj.y - vi.y) + vi.x);
    if (intersects) inside = !inside;
  }
  return inside;
}
/* Nearest point ON the ring's own boundary (any edge) to latlng, plus
   which edge it's on and how far along it (t: 0 = exactly ring[edgeIndex],
   1 = exactly ring[edgeIndex+1]) -- distinct from rmFindSnapTarget() above
   (which searches OTHER roofs' rings within a fixed screen-pixel radius
   and can return "nothing close enough"); this always returns a result,
   snapped exactly onto the boundary so rmSplitInsertVertex() can cleanly
   insert it as a new vertex. */
function rmNearestRingBoundaryPoint(ring, latlng){
  var origin = rmGeomRingCentroid(ring);
  var p = rmGeomToLocalXY(latlng, origin);
  var best = null, bestDist = Infinity, bestEdge = -1, bestT = 0;
  for (var i = 0; i < ring.length - 1; i++){
    var a = rmGeomToLocalXY(ring[i], origin), b = rmGeomToLocalXY(ring[i + 1], origin);
    var abx = b.x - a.x, aby = b.y - a.y;
    var lenSq = abx * abx + aby * aby;
    var t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
    var projX = a.x + t * abx, projY = a.y + t * aby;
    var d = Math.sqrt((p.x - projX) * (p.x - projX) + (p.y - projY) * (p.y - projY));
    if (d < bestDist){
      bestDist = d; bestEdge = i; bestT = t;
      best = rmGeomFromLocalXY({ x: projX, y: projY }, origin);
    }
  }
  return { lat: best.lat, lng: best.lng, edgeIndex: bestEdge, t: bestT };
}
/* Inserts a split point onto verts (an OPEN vertex list, no closing
   duplicate) at the correct position, snapping onto an existing vertex
   instead of inserting a near-duplicate one if it landed within ~2% of an
   edge's own length of that vertex -- avoids degenerate zero-length edges
   in the resulting sections. Returns the vertex's index in the (possibly
   now longer) array. */
function rmSplitInsertVertex(verts, hit){
  var EPS_T = 0.02;
  if (hit.t <= EPS_T) return hit.edgeIndex;
  if (hit.t >= 1 - EPS_T) return (hit.edgeIndex + 1) % verts.length;
  verts.splice(hit.edgeIndex + 1, 0, { lat: hit.lat, lng: hit.lng });
  return hit.edgeIndex + 1;
}
/* The actual split: given a CLOSED ring (ring[0]===ring[last]) and two
   points (not necessarily already on the boundary -- they're snapped onto
   it here), returns { ringA, ringB } -- two new closed rings sharing the
   p1->p2 chord as a new edge -- or { error } if the two points resolve to
   the same vertex, land too close to a corner to form a real section, or
   the chord's midpoint falls outside the original shape. Standard
   "split a simple polygon by two boundary points" technique: insert both
   points as real vertices, then the two arcs between them (walked each
   direction around the ring) are the two resulting polygons. */
function rmSplitRingByChord(ring, p1, p2){
  var verts = ring.slice(0, ring.length - 1);
  var hit1 = rmNearestRingBoundaryPoint(ring, p1);
  var i1 = rmSplitInsertVertex(verts, hit1);
  /* Re-locate p2 against the ring AS UPDATED so far (now possibly one
     vertex longer) so its edgeIndex lines up with the current `verts`. */
  var ringSoFar = verts.concat([verts[0]]);
  var hit2 = rmNearestRingBoundaryPoint(ringSoFar, p2);
  var i2 = rmSplitInsertVertex(verts, hit2);
  if (i1 === i2) return { error: "Those two points are the same spot — tap two different points on the outline." };
  var lo = Math.min(i1, i2), hi = Math.max(i1, i2);
  var arcA = verts.slice(lo, hi + 1);
  var arcB = verts.slice(hi).concat(verts.slice(0, lo + 1));
  if (arcA.length < 3 || arcB.length < 3){
    return { error: "That split line is too close to a corner — tap two points further apart." };
  }
  var mid = { lat: (p1.lat + p2.lat) / 2, lng: (p1.lng + p2.lng) / 2 };
  if (!rmGeomPointInRing(mid, ring)){
    return { error: "That split line goes outside the roof outline — pick two points where a straight line between them stays inside the shape." };
  }
  return { ringA: arcA.concat([arcA[0]]), ringB: arcB.concat([arcB[0]]) };
}
/* Builds a pending-section object (not yet a saved roof) from a ring --
   same area/perimeter math every saved outline uses, so the numbers shown
   in the split review panel match exactly what gets saved. */
function rmMakeSplitSection(ring, label){
  return {
    id: genId("split"), label: label, ring: ring,
    areaSqFt: rmGeomPolygonAreaSqMeters(ring) * 10.7639,
    perimeterFt: rmGeomPolygonPerimeterMeters(ring) * 3.28084,
    center: rmGeomRingCentroid(ring)
  };
}
/* ---- Square Up (orthogonal snapping) ----
   Mark: roofs are mostly rectilinear, so a traced outline should "look
   square" -- snap near-90° corners and near-axis edges clean, UNLESS a
   segment is an obvious intentional angle (e.g. a 45° cut) or an arc/curve.
   Manual button, not automatic -- see rmSquareUpOutline() below. Pure
   geometry function here (no rmState/map access) so it's independently
   testable. See "Square Up" in DEV_NOTES.md. */
var RM_SQUARE_TOLERANCE_DEG = 12; /* requirement: ~10-15° */
var RM_SQUARE_CURVE_SINGLE_TURN_MAX = 35; /* a per-vertex turn under this reads as "not a sharp corner" */
var RM_SQUARE_CURVE_CUMULATIVE_MIN = 40; /* but a RUN of small turns summing past this reads as an arc, not GPS/trace noise */
function rmGeomComputeSquaredRing(ring){
  if (!ring || ring.length < 4) return null; /* need at least 3 real edges */
  var origin = rmGeomRingCentroid(ring);
  var n = ring.length - 1; /* ring[n] === ring[0] (closed) */
  var pts = ring.map(function(p){ return rmGeomToLocalXY(p, origin); });

  var edges = [];
  for (var i = 0; i < n; i++){
    var a = pts[i], b = pts[i + 1];
    var dx = b.x - a.x, dy = b.y - a.y;
    edges.push({ dx: dx, dy: dy, len: Math.sqrt(dx * dx + dy * dy), angle: Math.atan2(dy, dx) * 180 / Math.PI });
  }

  /* Dominant axis: length-weighted circular mean of every edge's angle,
     reduced mod 90° (a rectilinear shape's edges alternate between two
     perpendicular directions, which collapse to ONE value under mod-90 --
     e.g. 0° and 90° both reduce to 0°). Scaling angle*4 before the
     standard sin/cos circular mean turns a 90°-period wraparound into a
     360°-period one so opposite-but-equivalent angles (like 89° and 1°)
     don't cancel each other out the way a naive arithmetic mean would. */
  var sumSin = 0, sumCos = 0;
  edges.forEach(function(e){
    var scaled = (e.angle * 4) * Math.PI / 180;
    sumSin += e.len * Math.sin(scaled);
    sumCos += e.len * Math.cos(scaled);
  });
  var dominantAxis = (sumCos === 0 && sumSin === 0) ? 0 : (Math.atan2(sumSin, sumCos) * 180 / Math.PI) / 4;

  /* Exterior turn angle at each vertex, between the incoming and outgoing
     edge -- used for curve/arc detection below. */
  var turns = [];
  for (var i = 0; i < n; i++){
    var prev = edges[(i - 1 + n) % n], cur = edges[i];
    var d = cur.angle - prev.angle;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    turns.push(d);
  }

  /* Curve/arc detection: a single sharp corner is ONE big turn at one
     vertex with straight edges on either side. An arc/curve, as traced,
     instead shows up as a RUN of several consecutive small turns that
     cumulatively sweep a real angle. Flag every edge inside such a run as
     "never snap," regardless of its own mod-90 alignment. Simplification
     (documented, not a bug): a run that happens to straddle the ring's
     start/end index isn't merged across that boundary -- an edge case of
     an edge case; the per-edge tolerance + short-edge fallback below still
     catch most of what this misses. */
  var inCurveRun = new Array(n).fill(false);
  var runStart = null, runSum = 0;
  for (var i = 0; i < n; i++){
    var isSmallTurn = Math.abs(turns[i]) > 2 && Math.abs(turns[i]) < RM_SQUARE_CURVE_SINGLE_TURN_MAX;
    if (isSmallTurn){
      if (runStart === null) runStart = i;
      runSum += Math.abs(turns[i]);
    } else {
      if (runStart !== null && runSum >= RM_SQUARE_CURVE_CUMULATIVE_MIN){
        for (var k = runStart; k < i; k++) inCurveRun[k] = true;
      }
      runStart = null; runSum = 0;
    }
  }
  if (runStart !== null && runSum >= RM_SQUARE_CURVE_CUMULATIVE_MIN){
    for (var k2 = runStart; k2 < n; k2++) inCurveRun[k2] = true;
  }

  function nearestAxis(angle){
    var rel = angle - dominantAxis;
    while (rel > 180) rel -= 360;
    while (rel < -180) rel += 360;
    var nearest90 = Math.round(rel / 90) * 90;
    return { delta: rel - nearest90, target: dominantAxis + nearest90 };
  }
  var avgLen = edges.reduce(function(s, e){ return s + e.len; }, 0) / n;
  var snapDecision = edges.map(function(e, i){
    if (inCurveRun[i]) return false; /* arc/curve -- preserved, never snapped */
    var na = nearestAxis(e.angle);
    if (Math.abs(na.delta) > RM_SQUARE_TOLERANCE_DEG) return false; /* real diagonal, e.g. a 45° cut -- kept as drawn */
    /* Simple fallback safety net: a very short edge flanked by other short
       edges reads more like curve/trace noise than an intentional straight
       segment, even if it happens to land within tolerance -- skip it. */
    if (e.len < avgLen * 0.3){
      var prevLen = edges[(i - 1 + n) % n].len, nextLen = edges[(i + 1) % n].len;
      if (prevLen < avgLen * 0.3 && nextLen < avgLen * 0.3) return false;
    }
    return true;
  });
  var snappedCount = snapDecision.filter(Boolean).length;
  if (!snappedCount) return null; /* nothing in tolerance -- e.g. a genuinely round/irregular trace */

  /* Sequential walk-and-snap: for each edge, in ring order, either rotate
     it to the nearest axis direction (keeping its ORIGINAL LENGTH exactly
     -- corners move, real measured lengths don't) or carry its original
     vector through unchanged. The final closing edge (back to the start
     point) is forced to close exactly rather than independently
     recomputed -- it absorbs whatever small drift accumulated around the
     loop, a deliberate, documented simplification rather than solving a
     full line-intersection system for every corner. */
  var newPts = new Array(n + 1);
  newPts[0] = pts[0];
  for (var i = 0; i < n - 1; i++){
    var e = edges[i];
    if (snapDecision[i]){
      var na2 = nearestAxis(e.angle);
      var rad = na2.target * Math.PI / 180;
      newPts[i + 1] = { x: newPts[i].x + Math.cos(rad) * e.len, y: newPts[i].y + Math.sin(rad) * e.len };
    } else {
      newPts[i + 1] = { x: newPts[i].x + e.dx, y: newPts[i].y + e.dy };
    }
  }
  newPts[n] = newPts[0];

  return {
    ring: newPts.map(function(p){ return rmGeomFromLocalXY(p, origin); }),
    snappedCount: snappedCount,
    curveEdgeCount: inCurveRun.filter(Boolean).length
  };
}
function rmGeomCleanRing(ring){
  /* Overpass geometry sometimes repeats/near-duplicates nodes; drop points
     under ~15cm apart and make sure the ring is explicitly closed. */
  var out = [];
  ring.forEach(function(p){
    var prev = out[out.length - 1];
    if (!prev || rmGeomHaversineMeters(prev, p) > 0.15) out.push(p);
  });
  if (out.length > 1){
    var first = out[0], last = out[out.length - 1];
    if (rmGeomHaversineMeters(first, last) > 0.15) out.push(first);
    else out[out.length - 1] = first;
  }
  return out;
}

/* ---- hooks/useGeolocation ---- */
function rmGeoRequest(onSuccess, onError){
  if (!navigator.geolocation){
    onError({ friendly: "Location isn't available on this device/browser." });
    return;
  }
  navigator.geolocation.getCurrentPosition(onSuccess, function(err){
    var friendly;
    if (err.code === 1) friendly = "Location access was denied. Enable location for this site in your browser/phone settings and try again.";
    else if (err.code === 2) friendly = "Couldn't determine your location (no GPS signal). Try again outdoors or near a window.";
    else if (err.code === 3) friendly = "Location request timed out — try again, this can happen with a weak GPS signal.";
    else friendly = "Couldn't get your location: " + (err.message || "unknown error");
    err.friendly = friendly;
    onError(err);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

/* ---- services/overpassService ----
   Public, free, no API key. Two endpoints so a single mirror outage
   doesn't block the whole feature. */
var RM_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
function rmOverpassQuery(lat, lng, radiusMeters){
  /* Field test at a hospital campus (St. Joseph Hospital, Lake Saint Louis MO)
     found the real footprint has NO building=* tag at all — only
     amenity=hospital/healthcare=hospital. Very common OSM pattern: a mapper
     tags a structure by what it *is* (hospital, school, shop, office) and
     never adds a redundant building=* tag on top. A building-only filter
     silently misses these no matter how large the radius. Broadened to also
     match structure-by-use tags, excluding amenity/leisure values that are
     open ground (parking lots, parks, pitches) rather than an actual roof. */
  var around = "(around:" + radiusMeters + "," + lat + "," + lng + ")";
  var nonBuildingAmenity = "^(parking|parking_space|parking_entrance|bicycle_parking|motorcycle_parking|fountain|bench|waste_basket|charging_station)$";
  var nonBuildingLeisure = "^(park|pitch|garden|nature_reserve|playground|golf_course|track)$";
  return "[out:json][timeout:25];(" +
    "way[\"building\"]" + around + ";" +
    "relation[\"building\"]" + around + ";" +
    "way[\"amenity\"][\"amenity\"!~\"" + nonBuildingAmenity + "\"]" + around + ";" +
    "relation[\"amenity\"][\"amenity\"!~\"" + nonBuildingAmenity + "\"]" + around + ";" +
    "way[\"healthcare\"]" + around + ";" +
    "way[\"shop\"]" + around + ";" +
    "way[\"office\"]" + around + ";" +
    "way[\"leisure\"][\"leisure\"!~\"" + nonBuildingLeisure + "\"]" + around + ";" +
  ");out body geom;";
}
function rmParseOverpassElements(elements){
  var footprints = [];
  elements.forEach(function(el){
    var ring = null;
    if (el.type === "way" && el.geometry && el.geometry.length > 2){
      ring = el.geometry.map(function(g){ return { lat: g.lat, lng: g.lon }; });
    } else if (el.type === "relation" && el.members){
      /* Naive multipolygon handling: concatenate every "outer" member's
         geometry into one ring. Correct for the common single-outer-way
         case; complex multi-outer relations (rare for a single building)
         may render approximately. Documented limitation, not a bug. */
      var pts = [];
      el.members.forEach(function(m){
        if (m.role === "outer" && m.geometry) m.geometry.forEach(function(g){ pts.push({ lat: g.lat, lng: g.lon }); });
      });
      if (pts.length > 2) ring = pts;
    }
    if (!ring) return;
    ring = rmGeomCleanRing(ring);
    if (ring.length < 4) return;
    var tags = el.tags || {};
    var hasBuildingTag = !!(tags.building || tags["building:part"]);
    var areaSqFt = rmGeomPolygonAreaSqMeters(ring) * 10.7639;
    /* A polygon with no building tag (building= or building:part=) that's
       bigger than ~4.6 acres is almost certainly a property/site boundary
       (hospital campus, school grounds, shopping center parcel) rather
       than a single roof — real-world field test found a hospital mapped
       only as amenity=hospital/healthcare=hospital with NO building tag
       at all, and its polygon traced the whole ~22-acre site (parking,
       grounds, waterfront) since OSM had zero individual building
       footprints for it. 200,000 sq ft is generous enough not to misflag
       a genuinely huge single building (e.g. a big-box store) that IS
       tagged with a building key — this only catches the
       untagged-as-a-building case. */
    var isSite = !hasBuildingTag && areaSqFt > 200000;
    footprints.push({
      id: el.type + "/" + el.id,
      osmType: el.type,
      ring: ring,
      center: rmGeomRingCentroid(ring),
      tags: tags,
      hasBuildingTag: hasBuildingTag,
      areaSqFt: areaSqFt,
      isSite: isSite
    });
  });
  return footprints;
}
async function rmFetchNearbyBuildings(lat, lng, radiusMeters){
  var query = rmOverpassQuery(lat, lng, radiusMeters);
  var lastErr = null;
  for (var i = 0; i < RM_OVERPASS_ENDPOINTS.length; i++){
    try{
      var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 25000) : null;
      var res = await fetch(RM_OVERPASS_ENDPOINTS[i], {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl ? ctrl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("Overpass returned HTTP " + res.status);
      var json = await res.json();
      return rmParseOverpassElements(json.elements || []);
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("Overpass request failed");
}

/* ---- services/exportService ----
   Client-side only, no paid rendering service. SVG is the source of truth;
   PNG is rasterized from the same SVG so the two always match. */
function rmExportProjectPoint(point, origin){
  var xy = rmGeomToLocalXY(point, origin);
  return { x: xy.x * 3.28084, y: xy.y * 3.28084 };
}
function rmExportProjectFeet(ring){
  var origin = rmGeomRingCentroid(ring);
  return ring.map(function(p){ return rmExportProjectPoint(p, origin); });
}
/* Full-roof export: pulls in the linked roof's permanent features
   (roof_assets[]) and its historical finding pins (from
   building_history_events[].pins[], same source Building History's own Roof
   Map reads) so the export is the outline PLUS everything marked up on it,
   not just the bare shape. Also carries the building name/address and roof
   label so the export header can show them (Mark: "Header/footer block:
   roof label, building name/address, area, perimeter, date"). Returns null
   (outline-only export, unchanged from before Phase 2) when the outline was
   never saved to a building, or there's no connection to fetch with. Only
   lat/lng-placed assets/pins are included -- ones placed on a roof's custom
   base map (x/y, no georeference) have no coordinate to plot on this
   lat/lng-based export, same limitation as rmDrawLinkedAssets(). */
async function rmFetchExportOverlayData(){
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId || !fdb) return null;
  try{
    var snap = await fdb.collection("buildings").doc(rmState.linkedBuildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roof = getRoofById(bld, rmState.linkedRoofId);
    var assets = (roof.roof_assets || []).filter(function(a){
      return typeof a.lat === "number" && typeof a.lng === "number";
    });
    var pins = [];
    var qs = await fdb.collection("building_history_events")
      .where("buildingId", "==", rmState.linkedBuildingId).orderBy("createdAt", "desc").limit(50).get();
    qs.forEach(function(d){
      var e = d.data();
      (e.pins || []).forEach(function(p){
        if ((p.roofId || "roof_default") !== rmState.linkedRoofId) return;
        if (typeof p.lat !== "number" || typeof p.lng !== "number") return;
        pins.push(p);
      });
    });
    var buildingName = bld.name || null;
    var buildingAddress = bld.address || null;
    var roofLabel = (roof && roof.label) || null;
    if (!assets.length && !pins.length && !buildingName && !buildingAddress && !roofLabel) return null;
    return { assets: assets, pins: pins, buildingName: buildingName, buildingAddress: buildingAddress, roofLabel: roofLabel };
  }catch(e){
    toast("Couldn't load placed features for export — exporting outline only. (" + e.message + ")");
    return null;
  }
}
function rmEscXml(s){
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function rmDownloadBlob(filename, blob){
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}
function rmExportFilenameBase(){
  var tags = (rmState.outline && rmState.outline.tags) || {};
  var name = tags.name || tags["addr:housenumber"] || "roof-outline";
  return "roofmapper_" + String(name).replace(/[^a-z0-9]+/gi, "_").toLowerCase() + "_" + Date.now();
}
function rmOutlineTitle(outline){
  var tags = outline.tags || {};
  var addr = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  var base = tags.name || addr || "Roof Outline";
  return outline.isSiteBoundary ? "⚠ Site Boundary — " + base : base;
}
/* Bug fix (2026-07-11): a fixed 20px/ft scale meant a large roof (tens of
   thousands of sq ft) produced an SVG many thousands of pixels across --
   Mark's report of a "huge mostly-empty canvas" with everything crammed
   into one corner traces back to this (compounded by the OLD separate PDF
   implementation below, which drew an unfilled, undimensioned, unlabeled
   outline through totally different code that could silently diverge from
   what Preview showed). Capping the long edge of the canvas keeps exports
   a sane, predictable size regardless of roof size; MAX_SCALE keeps a tiny
   roof from being blown up past a sensible px/ft (a former MIN_SCALE floor
   was removed -- see the scale-clamp fix note below rmBuildOutlineSvg()'s
   own `scale` line -- it fought the canvas-size cap instead of serving it). */
var RM_EXPORT_MAX_CANVAS_DIM = 2200;
var RM_EXPORT_MAX_SCALE = 20; /* px per foot */
/* overlay ({assets, pins, buildingName, buildingAddress, roofLabel}, from
   rmFetchExportOverlayData()) is optional -- omitting it (or passing null)
   produces the original outline-only export, so a locally-saved/unlinked
   outline still exports fine without a building link. This is the SINGLE
   source of truth for what an outline+features export looks like -- Export
   Preview, SVG, PNG, and PDF (rasterizes this same SVG, see rmExportPDF)
   all call this one function, so they're guaranteed to render identically
   rather than risk drifting out of sync the way the old hand-rolled jsPDF
   vector drawing did. See "RoofMapper export: single shared render path"
   in DEV_NOTES.md. */
/* Label declutter pass, shared by the single- and multi-roof export
   renderers. Mark's real Tri-Delta export (11 roofs) had bad label
   collisions: "Pebble Beach" (a roof name) overlapping "Roof 2", an
   HVAC/Vent/Pipe Flashing cluster stacked unreadable, "Roof 1"/"Roof 10"
   colliding in a tight cluster of small sections. Draggable per-roof
   labels don't scale to fixing 11 roofs by hand every export, so this is
   an automatic pass: each label has a fixed ANCHOR (a roof's centroid/
   dragged position, or an asset marker's real lat/lng -- never moves) and
   a natural desired label-box position relative to that anchor. Tries the
   natural spot first; if it collides with an already-placed label, walks
   an expanding ring of candidate offsets AROUND THE ANCHOR (not around the
   natural spot, so leader lines radiate cleanly outward from the true
   point rather than compounding drift) until a free spot is found or the
   search gives up and falls back to the natural spot anyway (rare, only
   with extremely dense clusters -- an accepted overlap beats vanishing or
   drifting off the page). Order matters: earlier items get first claim on
   their natural position, so callers should list higher-priority labels
   (roof names) before lower-priority ones (asset labels). Returns each
   item's final label-box CENTER plus `moved` so the caller knows whether
   to draw a leader line back to the anchor. Pure geometry, no rendering --
   testable in isolation.

   `obstacles` (optional, [{x,y,r}]) are fixed circular footprints -- asset
   marker dots -- that participate in collision-avoidance but are never
   themselves placed or returned. Without this, a label could win against
   every OTHER label yet still land squarely on top of a neighboring
   asset's marker glyph, which is exactly what a real tight cluster (an
   HVAC unit, a vent, and a pipe flashing a couple feet apart) produced in
   testing: labels correctly avoided each other but still overlapped a
   nearby marker's emoji icon. */
function rmDeconflictLabels(items, svgW, svgH, obstacles){
  var placedBoxes = (obstacles || []).map(function(o){
    return { x0: o.x - o.r, x1: o.x + o.r, y0: o.y - o.r, y1: o.y + o.r };
  });
  function fits(cx, cy, w, h){
    var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    if (x0 < 2 || x1 > svgW - 2 || y0 < 2 || y1 > svgH - 2) return false;
    for (var i = 0; i < placedBoxes.length; i++){
      var p = placedBoxes[i];
      if (x0 < p.x1 + 3 && x1 > p.x0 - 3 && y0 < p.y1 + 3 && y1 > p.y0 - 3) return false;
    }
    return true;
  }
  return items.map(function(it){
    var w = it.width, h = it.height;
    var naturalCx = it.anchorX + it.dx, naturalCy = it.anchorY + it.dy;
    var finalPos = fits(naturalCx, naturalCy, w, h) ? { x: naturalCx, y: naturalCy } : null;
    if (!finalPos){
      for (var ring = 1; ring <= 7 && !finalPos; ring++){
        var radius = ring * 18;
        for (var a = 0; a < 12 && !finalPos; a++){
          var ang = (a / 12) * Math.PI * 2;
          var cx = it.anchorX + Math.cos(ang) * radius, cy = it.anchorY + Math.sin(ang) * radius;
          if (fits(cx, cy, w, h)) finalPos = { x: cx, y: cy };
        }
      }
    }
    if (!finalPos) finalPos = { x: naturalCx, y: naturalCy };
    placedBoxes.push({ x0: finalPos.x - w / 2, x1: finalPos.x + w / 2, y0: finalPos.y - h / 2, y1: finalPos.y + h / 2 });
    var moved = Math.abs(finalPos.x - naturalCx) > 1 || Math.abs(finalPos.y - naturalCy) > 1;
    return Object.assign({}, it, { x: finalPos.x, y: finalPos.y, moved: moved });
  });
}
function rmBuildOutlineSvg(outline, overlay){
  var origin = rmGeomRingCentroid(outline.ring);
  var pts = outline.ring.map(function(p){ return rmExportProjectPoint(p, origin); });
  var assetPts = ((overlay && overlay.assets) || []).map(function(a){
    return Object.assign({}, rmExportProjectPoint(a, origin), { type: a.type, label: a.label });
  });
  var pinPts = ((overlay && overlay.pins) || []).map(function(p){
    return Object.assign({}, rmExportProjectPoint(p, origin), { warranty: p.warranty });
  });
  var allXs = pts.concat(assetPts, pinPts).map(function(p){ return p.x; });
  var allYs = pts.concat(assetPts, pinPts).map(function(p){ return p.y; });
  var minX = Math.min.apply(null, allXs), maxX = Math.max.apply(null, allXs);
  var minY = Math.min.apply(null, allYs), maxY = Math.max.apply(null, allYs);
  var padFt = Math.max(6, (maxX - minX) * 0.08);
  var w = (maxX - minX) + padFt * 2, h = (maxY - minY) + padFt * 2;
  /* Real bug, caught while building the multi-roof export below and
     confirmed to affect this single-roof path too (just never triggered --
     no single roof traced through RoofMapper so far has exceeded ~550ft on
     its long side): Math.max(RM_EXPORT_MIN_SCALE, ...) wrapped AROUND the
     whole clamp forces scale back UP to 4px/ft whenever the natural
     shrink-to-fit ratio (RM_EXPORT_MAX_CANVAS_DIM / longest side) comes out
     below that floor -- which is exactly backwards for a roof large enough
     to need it, and directly contradicts this cap's whole documented
     purpose ("caps the canvas regardless of roof size" -- see the export
     fix entry in DEV_NOTES.md). RM_EXPORT_MIN_SCALE never actually needs to
     raise the scale: MAX_SCALE already prevents a small roof's ratio from
     going too high, so the floor was dead weight at best and cap-breaking
     at worst. Plain Math.min(MAX_SCALE, fitRatio) is the correct clamp. */
  var scale = Math.min(RM_EXPORT_MAX_SCALE, RM_EXPORT_MAX_CANVAS_DIM / Math.max(w, h));
  var hasBuildingInfo = !!(overlay && (overlay.buildingName || overlay.buildingAddress));
  var headerH = hasBuildingInfo ? 76 : 60;
  var footerH = overlay ? 64 : 40; /* extra room for the legend line when features are included */
  var svgW = Math.max(240, w * scale), svgH = Math.max(240, h * scale) + headerH + footerH;
  function toSvg(p){
    return { x: (p.x - minX + padFt) * scale, y: headerH + (h * scale) - ((p.y - minY + padFt) * scale) };
  }
  /* Satellite basemap, drawn FIRST so the outline/dimensions/markers all
     render on top of it. The stitched tile image's corners are projected
     through the exact same origin+toSvg pipeline as everything else, so
     it lines up with the line art regardless of scale/roof size --
     preserveAspectRatio="none" because the target rect (computed from
     real corner projections) is already the correct aspect; stretching
     to fill it exactly beats letterboxing a near-identical aspect. */
  var basemapSvg = "";
  if (overlay && overlay.basemap){
    var bm = overlay.basemap;
    var bmNw = toSvg(rmExportProjectPoint({ lat: bm.nwLat, lng: bm.nwLng }, origin));
    var bmSe = toSvg(rmExportProjectPoint({ lat: bm.seLat, lng: bm.seLng }, origin));
    basemapSvg = '<image href="' + bm.dataUrl + '" x="' + Math.min(bmNw.x, bmSe.x).toFixed(1) + '" y="' + Math.min(bmNw.y, bmSe.y).toFixed(1) +
      '" width="' + Math.abs(bmSe.x - bmNw.x).toFixed(1) + '" height="' + Math.abs(bmSe.y - bmNw.y).toFixed(1) + '" preserveAspectRatio="none"/>';
  }
  var pathPts = pts.map(toSvg);
  var pathD = "M " + pathPts.map(function(p){ return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" L ") + " Z";
  var title = (overlay && overlay.buildingName) || rmOutlineTitle(outline);
  if (overlay && overlay.roofLabel) title += " — " + overlay.roofLabel;
  var scaleBarFt = 20, scaleBarPx = scaleBarFt * scale;
  /* Edge dimension labels -- same real-world lengths rmDrawEdgeDimensions()
     shows on the live map (haversine on the ORIGINAL ring, so a calibrated
     outline's real measured lengths carry through correctly), just
     re-rendered as SVG pills instead of Leaflet divIcons. Mark: "No edge
     dimensions are drawn on the outline, even though we built calibration/
     dimensions" -- true gap, never wired into export before this fix. */
  var calibratedIdx = outline.calibration ? outline.calibration.edgeIndex : -1;
  var dimSvg = "";
  for (var i = 0; i < outline.ring.length - 1; i++){
    var ea = outline.ring[i], eb = outline.ring[i + 1];
    var distFt = rmGeomHaversineMeters(ea, eb) * 3.28084;
    if (distFt < 1) continue; /* skip degenerate/near-zero edges from ring cleanup */
    var midFeet = { x: (rmExportProjectPoint(ea, origin).x + rmExportProjectPoint(eb, origin).x) / 2,
                     y: (rmExportProjectPoint(ea, origin).y + rmExportProjectPoint(eb, origin).y) / 2 };
    var svgMid = toSvg(midFeet);
    var isCal = i === calibratedIdx;
    var dimLabel = (isCal ? "✓ " : "") + Math.round(distFt) + " ft";
    var dimW = Math.max(38, dimLabel.length * 8 + 12);
    dimSvg += '<rect x="' + (svgMid.x - dimW / 2).toFixed(1) + '" y="' + (svgMid.y - 12).toFixed(1) + '" width="' +
      dimW.toFixed(1) + '" height="24" rx="5" fill="' + (isCal ? "#2E7D32" : "#263238") + '"/>' +
      '<text x="' + svgMid.x.toFixed(1) + '" y="' + (svgMid.y + 5).toFixed(1) +
      '" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">' +
      rmEscXml(dimLabel) + '</text>';
  }
  /* Asset markers stay pinned at their exact real position; only the
     TEXT label next to each one is free to move for de-collision (a
     marker without its label reading "HVAC Unit" instead of "Vent" would
     be worse than a slightly-offset label with a leader line back to the
     real marker). See rmDeconflictLabels() above -- same helper the
     multi-roof export uses for its roof-name labels. */
  var markersSvg = "";
  var assetLabelItems = [], markerObstacles = [];
  assetPts.forEach(function(a, ai){
    var svgP = toSvg(a);
    var t = ROOF_ASSET_TYPES[a.type] || ROOF_ASSET_TYPES.other;
    var labelText = a.label || t.label;
    markersSvg += '<circle cx="' + svgP.x.toFixed(1) + '" cy="' + svgP.y.toFixed(1) + '" r="9" fill="' + t.color +
      '" stroke="#fff" stroke-width="2"/><text x="' + svgP.x.toFixed(1) + '" y="' + (svgP.y + 4).toFixed(1) +
      '" font-family="Arial, sans-serif" font-size="11" text-anchor="middle">' + rmEscXml(t.emoji) + '</text>';
    markerObstacles.push({ x: svgP.x, y: svgP.y, r: 9 });
    var labelW = labelText.length * 12 * 0.58 + 6;
    assetLabelItems.push({
      id: "asset-" + ai, text: labelText, anchorX: svgP.x, anchorY: svgP.y,
      dx: 15 + labelW / 2, dy: 0, width: labelW, height: 17
    });
  });
  var placedAssetLabels = rmDeconflictLabels(assetLabelItems, svgW, svgH, markerObstacles);
  placedAssetLabels.forEach(function(pl){
    if (pl.moved){
      markersSvg += '<line x1="' + pl.anchorX.toFixed(1) + '" y1="' + pl.anchorY.toFixed(1) + '" x2="' + pl.x.toFixed(1) + '" y2="' + pl.y.toFixed(1) +
        '" stroke="#8a8f93" stroke-width="1" stroke-dasharray="2,2"/>';
    }
    /* stroke+paint-order gives the label text a white halo so it stays
       readable over the orange outline fill or any marker it crosses,
       without needing a separate background pill like the dimension
       labels get. */
    markersSvg += '<text x="' + pl.x.toFixed(1) + '" y="' + (pl.y + 4).toFixed(1) +
      '" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="#263238" text-anchor="middle" ' +
      'stroke="#ffffff" stroke-width="3" paint-order="stroke fill">' + rmEscXml(pl.text) + '</text>';
  });
  pinPts.forEach(function(p){
    var svgP = toSvg(p);
    markersSvg += '<circle cx="' + svgP.x.toFixed(1) + '" cy="' + svgP.y.toFixed(1) + '" r="7" fill="' +
      warrantyColor(p.warranty) + '" stroke="#fff" stroke-width="2"/>';
  });
  var legendSvg = "";
  if (overlay){
    var typesPresent = {};
    assetPts.forEach(function(a){ typesPresent[a.type] = true; });
    var legendParts = Object.keys(typesPresent).map(function(k){
      var t = ROOF_ASSET_TYPES[k] || ROOF_ASSET_TYPES.other; return t.emoji + " " + t.label;
    });
    if (pinPts.length) legendParts.push("● Finding pin (color = warranty status)");
    if (legendParts.length){
      legendSvg = '<text x="16" y="' + (svgH - footerH + 16) + '" font-family="Arial, sans-serif" font-size="12" fill="#5B6770">' +
        rmEscXml(legendParts.join("   ·   ")) + '</text>';
    }
  }
  var statsY = hasBuildingInfo ? 62 : 46;
  var headerSvg = '<text x="16" y="27" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#263238">' +
    rmEscXml(title) + '</text>';
  if (hasBuildingInfo && overlay.buildingAddress){
    headerSvg += '<text x="16" y="46" font-family="Arial, sans-serif" font-size="13" fill="#5B6770">' +
      rmEscXml(overlay.buildingAddress) + '</text>';
  }
  headerSvg += '<text x="16" y="' + statsY + '" font-family="Arial, sans-serif" font-size="13" fill="#5B6770">Area: ' +
    outline.areaSqFt.toFixed(0) + ' sq ft &#183; Perimeter: ' + outline.perimeterFt.toFixed(0) + ' ft &#183; Generated ' +
    rmEscXml(new Date(outline.createdAt || Date.now()).toLocaleDateString()) + '</text>';
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">' +
    '<rect width="100%" height="100%" fill="#ffffff"/>' +
    headerSvg + basemapSvg +
    '<path d="' + pathD + '" fill="rgba(232,96,10,0.15)" stroke="#E8600A" stroke-width="2.5" stroke-linejoin="round"/>' +
    dimSvg + markersSvg + legendSvg +
    '<g transform="translate(16,' + (svgH - 18) + ')">' +
      '<line x1="0" y1="0" x2="' + scaleBarPx + '" y2="0" stroke="#263238" stroke-width="2"/>' +
      '<line x1="0" y1="-4" x2="0" y2="4" stroke="#263238" stroke-width="2"/>' +
      '<line x1="' + scaleBarPx + '" y1="-4" x2="' + scaleBarPx + '" y2="4" stroke="#263238" stroke-width="2"/>' +
      '<text x="' + (scaleBarPx / 2) + '" y="-8" font-family="Arial, sans-serif" font-size="12" fill="#263238" text-anchor="middle">' + scaleBarFt + ' ft</text>' +
    '</g>' +
  '</svg>';
  return { svg: svg, width: svgW, height: svgH };
}
/* ---- Multi-roof export selection ----
   Mark: "he must be able to CHOOSE which roofs are included in an export
   -- e.g. checkboxes... export one roof, a couple, or the whole
   building." Only meaningful for a building with more than one roof --
   wired in at the same two places rmRenderRoofSwitcher() is (right after
   rmOpenRoofInMapper()/rmSaveOutlineToBuilding() finish), same
   roofs.length<=1 guard. Default all checked, per Mark's explicit ask. */
function rmRenderExportRoofSelect(buildingId, roofs, activeRoofId){
  var host = document.getElementById("rm-export-roof-select");
  if (!host) return;
  if (!roofs || roofs.length <= 1){ host.innerHTML = ""; return; }
  host.innerHTML = '<div class="fld" style="margin:0 0 10px">' +
    '<label>Include in export</label>' +
    roofs.map(function(r){
      return '<label class="hint" style="display:flex;align-items:center;gap:6px;margin:2px 0">' +
        '<input type="checkbox" class="rm-export-roof-cb" value="' + esc(r.id) + '" checked' +
        (r.id === activeRoofId ? ' data-active="1"' : '') + '> ' + esc(r.label || "Roof") + '</label>';
    }).join('') + '</div>';
}
/* Empty/absent means "no checklist showing" (a still-single-roof building,
   or an outline never saved to a building at all) -- rmBuildExportOutput()
   below treats that as "use the original single-outline path," so nothing
   about today's single-roof export changes. */
function rmGetSelectedExportRoofIds(){
  var boxes = document.querySelectorAll("#rm-export-roof-select .rm-export-roof-cb");
  if (!boxes.length) return null;
  return Array.from(boxes).filter(function(b){ return b.checked; }).map(function(b){ return b.value; });
}
/* Fetches every SELECTED roof's latest outline + its own permanent
   features + its own historical finding pins -- one building_history_events
   query for the whole building (rmFetchAllRoofsPinsGrouped(), already
   built for the reference-layer/RoofMapper drawing, reused here instead of
   one query per roof) grouped client-side by roofId, same pattern
   rmDrawReferenceRoofs() already established. */
async function rmFetchMultiRoofExportData(buildingId, roofIds){
  var snap = await fdb.collection("buildings").doc(buildingId).get();
  var bld = snap.exists ? snap.data() : {};
  var allRoofs = getBuildingRoofs(bld);
  var pinsByRoof = await rmFetchAllRoofsPinsGrouped(buildingId);
  var roofsData = roofIds.map(function(roofId){
    var roof = allRoofs.find(function(r){ return r.id === roofId; });
    if (!roof) return null;
    var outlines = roof.roof_outlines || [];
    var outline = outlines[outlines.length - 1];
    if (!outline || !outline.ring || outline.ring.length < 3) return null;
    return {
      roofId: roofId, label: roof.label || "Roof", outline: outline, labelPos: roof.labelPos || null,
      assets: (roof.roof_assets || []).filter(function(a){ return typeof a.lat === "number" && typeof a.lng === "number"; }),
      pins: pinsByRoof[roofId] || []
    };
  }).filter(Boolean);
  return { buildingName: bld.name || null, buildingAddress: bld.address || null, roofs: roofsData };
}
/* Multi-roof counterpart to rmBuildOutlineSvg() above -- same overall
   design (one shared render path for Preview/SVG/PNG/PDF, capped canvas
   size, edge dimensions, feature/pin markers, legend) but for SEVERAL
   roofs on one page instead of one. Projects every roof into ONE shared
   local-feet coordinate space (a single origin -- the centroid of every
   selected roof's combined vertices -- rather than each roof centered on
   its own) so the roofs render in their real position/orientation
   RELATIVE TO EACH OTHER, like an actual site plan, not as disconnected
   individually-centered shapes. See "Multi-roof export selection" in
   DEV_NOTES.md. */
function rmBuildMultiRoofOutlineSvg(data){
  var allRingPts = [];
  data.roofs.forEach(function(r){ allRingPts = allRingPts.concat(r.outline.ring); });
  var origin = rmGeomRingCentroid(allRingPts);
  var roofsProjected = data.roofs.map(function(r, i){
    var pts = r.outline.ring.map(function(p){ return rmExportProjectPoint(p, origin); });
    var assetPts = r.assets.map(function(a){ return Object.assign({}, rmExportProjectPoint(a, origin), { type: a.type, label: a.label }); });
    var pinPts = r.pins.map(function(p){ return Object.assign({}, rmExportProjectPoint(p, origin), { warranty: p.warranty }); });
    /* Mark: "the custom position must CARRY THROUGH TO THE EXPORT... not
       at a recomputed centroid." Same wherever-he-dragged-it position the
       live map uses, falling back to the recomputed centroid for a roof
       that was never repositioned. See "Draggable roof labels" in
       DEV_NOTES.md. */
    var labelPt = rmExportProjectPoint(r.labelPos || r.outline.center || rmGeomRingCentroid(r.outline.ring), origin);
    return { label: r.label, outline: r.outline, pts: pts, assetPts: assetPts, pinPts: pinPts, labelPt: labelPt };
  });
  var allXs = [], allYs = [];
  roofsProjected.forEach(function(r){
    r.pts.concat(r.assetPts, r.pinPts).forEach(function(p){ allXs.push(p.x); allYs.push(p.y); });
  });
  var minX = Math.min.apply(null, allXs), maxX = Math.max.apply(null, allXs);
  var minY = Math.min.apply(null, allYs), maxY = Math.max.apply(null, allYs);
  var padFt = Math.max(10, (maxX - minX) * 0.08);
  var w = (maxX - minX) + padFt * 2, h = (maxY - minY) + padFt * 2;
  var scale = Math.min(RM_EXPORT_MAX_SCALE, RM_EXPORT_MAX_CANVAS_DIM / Math.max(w, h)); /* see the same fix + explanation in rmBuildOutlineSvg() above */
  var hasBuildingInfo = !!(data.buildingName || data.buildingAddress);
  var headerH = hasBuildingInfo ? 84 : 66;
  var footerH = 84; /* legend + disclaimer, taller than the single-roof footer */
  var svgW = Math.max(240, w * scale), svgH = Math.max(240, h * scale) + headerH + footerH;
  function toSvg(p){
    return { x: (p.x - minX + padFt) * scale, y: headerH + (h * scale) - ((p.y - minY + padFt) * scale) };
  }
  /* Satellite basemap -- same approach as rmBuildOutlineSvg() above, just
     projected against this function's own shared multi-roof origin. */
  var basemapSvg = "";
  if (data.basemap){
    var bm = data.basemap;
    var bmNw = toSvg(rmExportProjectPoint({ lat: bm.nwLat, lng: bm.nwLng }, origin));
    var bmSe = toSvg(rmExportProjectPoint({ lat: bm.seLat, lng: bm.seLng }, origin));
    basemapSvg = '<image href="' + bm.dataUrl + '" x="' + Math.min(bmNw.x, bmSe.x).toFixed(1) + '" y="' + Math.min(bmNw.y, bmSe.y).toFixed(1) +
      '" width="' + Math.abs(bmSe.x - bmNw.x).toFixed(1) + '" height="' + Math.abs(bmSe.y - bmNw.y).toFixed(1) + '" preserveAspectRatio="none"/>';
  }
  var totalAreaSqFt = data.roofs.reduce(function(sum, r){ return sum + (r.outline.areaSqFt || 0); }, 0);
  /* Two passes: first draw every fixed shape (outlines, dimension pills,
     asset/pin markers -- none of these can move, they're pinned to real
     coordinates), collecting label items as we go. THEN run
     rmDeconflictLabels() once over every label from every roof combined
     (roof names before asset labels, so roof names -- Mark's worst
     collisions, "Pebble Beach"/"Roof 2", "Roof 1"/"Roof 10" -- get first
     claim on their natural spot) and render the labels last, on top,
     with leader lines back to whichever roof/asset a displaced label
     belongs to. See rmDeconflictLabels() above and "Vertex + edge
     snapping fix" / "Export layout pass" in DEV_NOTES.md. */
  var shapeSvg = "", legendTypesPresent = {}, anyPins = false;
  var roofLabelItems = [], assetLabelItems = [], markerObstacles = [];
  roofsProjected.forEach(function(r, i){
    var pathPts = r.pts.map(toSvg);
    var pathD = "M " + pathPts.map(function(p){ return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" L ") + " Z";
    shapeSvg += '<path d="' + pathD + '" fill="rgba(232,96,10,0.15)" stroke="#E8600A" stroke-width="2.5" stroke-linejoin="round"/>';
    /* Edge dimensions, same real-world haversine lengths the single-roof
       export/live map both use. */
    var calibratedIdx = r.outline.calibration ? r.outline.calibration.edgeIndex : -1;
    for (var e = 0; e < r.outline.ring.length - 1; e++){
      var ea = r.outline.ring[e], eb = r.outline.ring[e + 1];
      var distFt = rmGeomHaversineMeters(ea, eb) * 3.28084;
      if (distFt < 1) continue;
      var midFeet = { x: (rmExportProjectPoint(ea, origin).x + rmExportProjectPoint(eb, origin).x) / 2,
                       y: (rmExportProjectPoint(ea, origin).y + rmExportProjectPoint(eb, origin).y) / 2 };
      var svgMid = toSvg(midFeet);
      var isCal = e === calibratedIdx;
      var dimLabel = (isCal ? "✓ " : "") + Math.round(distFt) + " ft";
      var dimW = Math.max(36, dimLabel.length * 8 + 12);
      shapeSvg += '<rect x="' + (svgMid.x - dimW / 2).toFixed(1) + '" y="' + (svgMid.y - 11).toFixed(1) + '" width="' +
        dimW.toFixed(1) + '" height="22" rx="5" fill="' + (isCal ? "#2E7D32" : "#263238") + '"/>' +
        '<text x="' + svgMid.x.toFixed(1) + '" y="' + (svgMid.y + 5).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">' +
        rmEscXml(dimLabel) + '</text>';
    }
    r.assetPts.forEach(function(a, ai){
      var svgP = toSvg(a);
      var t = ROOF_ASSET_TYPES[a.type] || ROOF_ASSET_TYPES.other;
      legendTypesPresent[a.type] = true;
      var labelText = a.label || t.label;
      shapeSvg += '<circle cx="' + svgP.x.toFixed(1) + '" cy="' + svgP.y.toFixed(1) + '" r="9" fill="' + t.color +
        '" stroke="#fff" stroke-width="2"/><text x="' + svgP.x.toFixed(1) + '" y="' + (svgP.y + 4).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="11" text-anchor="middle">' + rmEscXml(t.emoji) + '</text>';
      markerObstacles.push({ x: svgP.x, y: svgP.y, r: 9 });
      var labelW = labelText.length * 12 * 0.58 + 6;
      assetLabelItems.push({
        id: "asset-" + i + "-" + ai, kind: "asset", text: labelText,
        anchorX: svgP.x, anchorY: svgP.y, dx: 15 + labelW / 2, dy: 0, width: labelW, height: 17
      });
    });
    r.pinPts.forEach(function(p){
      anyPins = true;
      var svgP = toSvg(p);
      shapeSvg += '<circle cx="' + svgP.x.toFixed(1) + '" cy="' + svgP.y.toFixed(1) + '" r="7" fill="' +
        warrantyColor(p.warranty) + '" stroke="#fff" stroke-width="2"/>';
    });
    /* Roof label + its own area, anchored at its outline's centroid (or
       wherever Mark dragged it) -- "each selected roof drawn, labeled,
       with its area/dimensions" per Mark's exact ask. */
    var lp = toSvg(r.labelPt);
    var areaText = Math.round(r.outline.areaSqFt || 0) + ' sq ft';
    var labelBoxW = Math.max(r.label.length * 17 * 0.6, areaText.length * 13 * 0.55) + 6;
    roofLabelItems.push({
      id: "roof-" + i, kind: "roof", name: r.label, areaText: areaText,
      anchorX: lp.x, anchorY: lp.y, dx: 0, dy: 0, width: labelBoxW, height: 38
    });
  });
  /* Roof labels first (higher priority, get first claim on their natural
     spot), then asset labels -- see the two-pass comment above. */
  var placedLabels = rmDeconflictLabels(roofLabelItems.concat(assetLabelItems), svgW, svgH, markerObstacles);
  var labelSvg = "";
  placedLabels.forEach(function(pl){
    if (pl.kind === "roof"){
      if (pl.moved){
        labelSvg += '<line x1="' + pl.anchorX.toFixed(1) + '" y1="' + pl.anchorY.toFixed(1) + '" x2="' + pl.x.toFixed(1) + '" y2="' + pl.y.toFixed(1) +
          '" stroke="#8a8f93" stroke-width="1" stroke-dasharray="2,2"/>' +
          '<circle cx="' + pl.anchorX.toFixed(1) + '" cy="' + pl.anchorY.toFixed(1) + '" r="3" fill="#263238"/>';
      }
      /* White-halo text (not a background pill like the roof label marker
         on the live map) so it sits cleanly over the outline fill or a
         leader line regardless of roof size/shape. */
      labelSvg += '<text x="' + pl.x.toFixed(1) + '" y="' + (pl.y - 5).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#263238" text-anchor="middle" ' +
        'stroke="#ffffff" stroke-width="4" paint-order="stroke fill">' + rmEscXml(pl.name) + '</text>' +
        '<text x="' + pl.x.toFixed(1) + '" y="' + (pl.y + 14).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="13" fill="#263238" text-anchor="middle" ' +
        'stroke="#ffffff" stroke-width="4" paint-order="stroke fill">' + rmEscXml(pl.areaText) + '</text>';
    } else {
      if (pl.moved){
        labelSvg += '<line x1="' + pl.anchorX.toFixed(1) + '" y1="' + pl.anchorY.toFixed(1) + '" x2="' + pl.x.toFixed(1) + '" y2="' + pl.y.toFixed(1) +
          '" stroke="#8a8f93" stroke-width="1" stroke-dasharray="2,2"/>';
      }
      labelSvg += '<text x="' + pl.x.toFixed(1) + '" y="' + (pl.y + 4).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="#263238" text-anchor="middle" ' +
        'stroke="#ffffff" stroke-width="3" paint-order="stroke fill">' + rmEscXml(pl.text) + '</text>';
    }
  });
  var bodySvg = shapeSvg + labelSvg;
  var legendParts = Object.keys(legendTypesPresent).map(function(k){
    var t = ROOF_ASSET_TYPES[k] || ROOF_ASSET_TYPES.other; return t.emoji + " " + t.label;
  });
  if (anyPins) legendParts.push("● Finding pin (color = warranty status)");
  var legendSvg = legendParts.length ?
    '<text x="16" y="' + (svgH - footerH + 18) + '" font-family="Arial, sans-serif" font-size="12" fill="#5B6770">' +
      rmEscXml(legendParts.join("   ·   ")) + '</text>' : '';
  var disclaimerSvg = '<text x="16" y="' + (svgH - 12) + '" font-family="Arial, sans-serif" font-size="9.5" fill="#8a8f93" font-style="italic">' +
    'Measurements are derived from GPS/mapped data and are approximate -- verify critical dimensions in the field before ordering materials.</text>';
  var title = (data.buildingName || "Roof Export") + " — " + data.roofs.length + " Roof" + (data.roofs.length === 1 ? "" : "s");
  var headerSvg = '<text x="16" y="27" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#263238">' +
    rmEscXml(title) + '</text>';
  var statsY = hasBuildingInfo ? 62 : 46;
  if (hasBuildingInfo && data.buildingAddress){
    headerSvg += '<text x="16" y="46" font-family="Arial, sans-serif" font-size="13" fill="#5B6770">' +
      rmEscXml(data.buildingAddress) + '</text>';
  }
  headerSvg += '<text x="16" y="' + statsY + '" font-family="Arial, sans-serif" font-size="13" fill="#5B6770">Total area: ' +
    Math.round(totalAreaSqFt) + ' sq ft &#183; Generated ' + rmEscXml(new Date().toLocaleDateString()) + '</text>';
  var scaleBarFt = 20, scaleBarPx = scaleBarFt * scale;
  /* North arrow -- this projection's "up" (toSvg's y flip) genuinely is
     geographic north (rmExportProjectPoint/rmGeomToLocalXY use a plain
     x=east/y=north local tangent-plane projection throughout this app), so
     a simple up-pointing arrow is accurate, not decorative-only. Placed in
     the top-right corner, clear of the title/stats block on the left. */
  var naX = svgW - 34, naY = headerH + 8;
  var northArrowSvg = '<g transform="translate(' + naX + ',' + naY + ')">' +
    '<line x1="0" y1="26" x2="0" y2="0" stroke="#263238" stroke-width="2.5"/>' +
    '<path d="M -6,8 L 0,0 L 6,8 Z" fill="#263238"/>' +
    '<text x="0" y="40" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#263238" text-anchor="middle">N</text>' +
    '</g>';
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">' +
    '<rect width="100%" height="100%" fill="#ffffff"/>' +
    headerSvg + basemapSvg + northArrowSvg + bodySvg + legendSvg + disclaimerSvg +
    '<g transform="translate(16,' + (svgH - footerH + 34) + ')">' +
      '<line x1="0" y1="0" x2="' + scaleBarPx + '" y2="0" stroke="#263238" stroke-width="2"/>' +
      '<line x1="0" y1="-4" x2="0" y2="4" stroke="#263238" stroke-width="2"/>' +
      '<line x1="' + scaleBarPx + '" y1="-4" x2="' + scaleBarPx + '" y2="4" stroke="#263238" stroke-width="2"/>' +
      '<text x="' + (scaleBarPx / 2) + '" y="-8" font-family="Arial, sans-serif" font-size="12" fill="#263238" text-anchor="middle">' + scaleBarFt + ' ft</text>' +
    '</g>' +
  '</svg>';
  return { svg: svg, width: svgW, height: svgH };
}
/* Single decision point every export format AND Preview call, so they stay
   guaranteed identical to each other -- same "one shared render path"
   principle rmBuildOutlineSvg() itself already established for the
   single-roof case. Falls back to the ORIGINAL single-outline path
   (byte-for-byte the same code that ran before this feature existed)
   whenever the multi-roof checklist isn't showing at all -- a still-
   single-roof building, or an outline never saved to a building -- so nothing
   about today's single-roof export can regress. */
async function rmBuildExportOutput(){
  var selectedIds = rmGetSelectedExportRoofIds();
  if (rmState.linkedBuildingId && selectedIds && selectedIds.length){
    var data = await rmFetchMultiRoofExportData(rmState.linkedBuildingId, selectedIds);
    if (data && data.roofs.length){
      if (rmState.exportIncludeBasemap){
        var allRingPts = [];
        data.roofs.forEach(function(r){ allRingPts = allRingPts.concat(r.outline.ring); });
        /* Basemap is a nice-to-have, not the point of the export -- a
           flaky/offline tile fetch must never block or blank the actual
           roof outline export, so failures here are swallowed and the
           export just proceeds without imagery. */
        try{ data.basemap = await rmFetchBasemapImage(rmComputeLatLngBounds(allRingPts)); }catch(e){}
      }
      return rmBuildMultiRoofOutlineSvg(data);
    }
  }
  var overlay = await rmFetchExportOverlayData();
  if (rmState.exportIncludeBasemap){
    overlay = overlay || {};
    try{ overlay.basemap = await rmFetchBasemapImage(rmComputeLatLngBounds(rmState.outline.ring)); }catch(e){}
  }
  return rmBuildOutlineSvg(rmState.outline, overlay);
}
async function rmExportSVG(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  var built = await rmBuildExportOutput();
  rmDownloadBlob(rmExportFilenameBase() + ".svg", new Blob([built.svg], { type: "image/svg+xml" }));
}
/* Shared by PNG and PDF export -- rasterizes rmBuildOutlineSvg()'s SVG onto
   a canvas at ITS OWN declared pixel size (already capped by
   RM_EXPORT_MAX_CANVAS_DIM), so both formats -- and the PDF page it gets
   embedded into -- show the exact same pixels Export Preview already
   showed. Resolves with the canvas itself so callers can pull either a
   Blob (PNG download) or a data URL (jsPDF's addImage). */
function rmRasterizeSvgToCanvas(svgStr, w, h){
  return new Promise(function(resolve, reject){
    var img = new Image();
    var url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = function(){
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("Couldn't render the export image")); };
    img.src = url;
  });
}
async function rmExportPNG(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  var built = await rmBuildExportOutput();
  try{
    var canvas = await rmRasterizeSvgToCanvas(built.svg, built.width, built.height);
    var blob = await new Promise(function(res){ canvas.toBlob(res, "image/png"); });
    rmDownloadBlob(rmExportFilenameBase() + ".png", blob);
  }catch(e){ toast("Couldn't render PNG export."); }
}
/* PDF export used to be a completely separate, hand-rolled drawing built
   straight from jsPDF's vector primitives (lines/circles/text) -- a second
   implementation of the exact same drawing that could (and did) silently
   drift out of sync with what SVG/PNG/Preview actually showed: no fill on
   the outline, no edge dimensions, features as bare unlabeled dots, no
   building name/address. Bug report from Mark (2026-07-11): the outline
   didn't render at all, features were unlabeled floating dots, layout was
   crammed in a corner of an otherwise-empty page, dark background. Fixed
   by rasterizing the SAME rmBuildOutlineSvg() output every other format
   uses and embedding that single image on the PDF page -- there is no
   longer a second drawing implementation to drift out of sync, so Export
   Preview is guaranteed to be exactly what the PDF (and SVG/PNG) produce.
   See "RoofMapper export: single shared render path" in DEV_NOTES.md. */
async function rmExportPDF(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  if (!(window.jspdf && window.jspdf.jsPDF)){ toast("PDF export isn't available right now."); return; }
  var built = await rmBuildExportOutput();
  try{
    var canvas = await rmRasterizeSvgToCanvas(built.svg, built.width, built.height);
    var pngDataUrl = canvas.toDataURL("image/png");
    var JsPdf = window.jspdf.jsPDF;
    /* compress:true is essential now that a raster image is embedded --
       jsPDF stores image XObject streams RAW (no deflate) unless this is
       set, which turned a ~110KB PNG into a ~22MB PDF in testing (a mostly-
       white 2200x1865 image stored byte-for-byte uncompressed). With it,
       the same export comes out under 100KB. */
    /* Orientation picked to match the drawing's own aspect ratio, not
       hardcoded portrait. Mark's real Tri-Delta export (11 roofs, wider
       than tall) came out on a portrait page with the drawing shrunk to
       fit the narrower dimension, leaving huge empty margins top/bottom
       and the actual content occupying a squeezed band in the middle --
       exactly what you'd get forcing a landscape-shaped drawing onto a
       portrait page. Choosing landscape for a wide drawing (and portrait
       for a tall one) means the fit-to-available-area math below almost
       always maxes out BOTH dimensions instead of just one. */
    var aspect = built.width / built.height;
    var orientation = aspect > 1 ? "landscape" : "portrait";
    var doc = new JsPdf({ unit: "pt", format: "letter", orientation: orientation, compress: true });
    var pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
    var margin = 36;
    var availW = pageW - margin * 2, availH = pageH - margin * 2;
    var drawW = availW, drawH = drawW / aspect;
    if (drawH > availH){ drawH = availH; drawW = drawH * aspect; }
    var offX = margin + (availW - drawW) / 2, offY = margin + (availH - drawH) / 2;
    doc.addImage(pngDataUrl, "PNG", offX, offY, drawW, drawH);
    doc.save(rmExportFilenameBase() + ".pdf");
  }catch(e){ toast("Couldn't render PDF export: " + e.message); }
}
/* Preview before export -- Mark: a way to see the map/drawing (outline +
   labels + features) as it will look exported, before actually exporting.
   Reuses rmBuildOutlineSvg() directly -- the SAME function SVG, PNG, AND
   (as of 2026-07-11) PDF export all call -- so the preview is guaranteed to
   be exactly what every export format produces, not a separate
   approximation that could drift out of sync. See "Export preview" and
   "RoofMapper export: single shared render path" in DEV_NOTES.md. */
async function rmPreviewExport(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  toast("Building preview…");
  var built = await rmBuildExportOutput();
  var host = document.getElementById("rm-preview-svg-host");
  host.innerHTML = built.svg;
  var svgEl = host.querySelector("svg");
  if (svgEl){ svgEl.style.width = "100%"; svgEl.style.height = "auto"; svgEl.style.display = "block"; }
  document.getElementById("rm-preview-modal").style.display = "";
  lockBodyScroll();
}
function closeRmPreviewModal(){
  document.getElementById("rm-preview-modal").style.display = "none";
  document.getElementById("rm-preview-svg-host").innerHTML = "";
  unlockBodyScroll();
}

/* ---- components/RoofMapper (view/state) ---- */
var rmState = {
  map: null, userMarker: null, accuracyCircle: null,
  lat: null, lng: null, accuracy: null,
  footprints: [], footprintLayers: {}, outlineLayer: null,
  selectedId: null, outline: null, radiusIndex: 0,
  /* Phase 2 (unified surface): once the outline is saved to a building,
     these point at that building+roof so features can be placed and the
     full-roof export can pull them in, without leaving RoofMapper.
     assetLayerGroup holds the markers drawn inline on rmState.map.
     linkedAssetsCache (Phase 2.5) is the last-fetched roof_assets[] array,
     kept so tapping a marker to edit it doesn't need a fresh Firestore
     read just to know what it is. */
  linkedBuildingId: null, linkedRoofId: null, assetLayerGroup: null, linkedAssetsCache: [],
  /* Markup layer (arrows/text/shapes/clouds/measurements/count) drawn on
     this same map -- rmDrawMarkups()/"Markup layer" in DEV_NOTES.md. */
  markupLayerGroup: null,
  /* Phase 3: which base tile layer is currently showing (rmSetBaseLayer()). */
  baseLayer: null, baseLayerType: "osm",
  /* Export panel: whether to stitch + embed satellite imagery beneath the
     line art (rm-export-basemap-cb checkbox, rmFetchBasemapImage()).
     Default off -- opt-in weight/load-time tradeoff. */
  exportIncludeBasemap: false,
  /* Per-edge dimension labels drawn on the current outline (rmDrawEdgeDimensions()). */
  dimensionLayerGroup: null,
  /* This roof's persistent name label, once saved (roofLabelMarker()). */
  roofLabelLayer: null,
  /* Whether the CURRENTLY linked roof has a custom dragged label position
     (roof.labelPos on the Firestore record) -- drives rm-reset-label-btn's
     visibility. See rmSaveRoofLabelPos()/"Draggable roof labels" in
     DEV_NOTES.md. */
  roofLabelHasCustomPos: false,
  /* Pre-Square-Up ring, kept only for Undo (rmSquareUpOutline()/
     rmUndoSquareUp()) -- null whenever the current outline hasn't been
     squared, or after an undo. */
  preSquareRing: null,
  /* Vertex (per-corner) edit mode -- rmToggleVertexEdit(). vertexHandleLayerGroup
     holds the draggable per-vertex markers, only populated while active. */
  vertexEditActive: false,
  vertexHandleLayerGroup: null,
  /* Trace-on-your-own-drone-image mode (Finding A -- Mark: "no way to use
     my orthomosaic as the base for roof tracing"). orthoOverlayLayer is
     the L.imageOverlay itself; orthoDataUrl/orthoBounds are kept so the
     image can be re-persisted with the roof once saved (see
     rmSaveOutlineToBuilding()). orthoActive just tracks whether the
     CURRENT session is tracing on an uploaded image vs. GPS/satellite, so
     a fresh location-based search knows to tear the overlay down. See
     "Ortho upload + flat-canvas tracing" in DEV_NOTES.md. */
  orthoActive: false,
  orthoOverlayLayer: null,
  orthoDataUrl: null,
  orthoBounds: null,
  /* Multi-roof workflow (Mark, live on a roof: "I should be able to save,
     label, add another trace outline on the same page. I shouldn't have
     to go back."). referenceLayerGroup holds the dimmed outlines/pins/
     assets of a building's ALREADY-traced roofs while tracing the next
     one -- deliberately kept SEPARATE from every other layer group (never
     touched by rmClearFootprintLayers()/rmClearGeneratedOutline(), which
     reset per-search/per-trace state) so it survives across "search here
     again" / "trace manually instead" while adding a new roof, and is
     only redrawn/cleared by its own dedicated functions.
     pendingBuildingId/pendingBuildingName are set by rmEnterMultiRoofCapture()
     right before a fresh trace starts on a KNOWN building, so the next
     "Save Outline to Building" can fast-path straight back to that same
     building instead of making him search for it again -- cleared once
     that save completes (rmSaveOutlineToBuilding() sets linkedBuildingId
     instead at that point). See "Multi-roof: stay in RoofMapper, trace
     another roof" in DEV_NOTES.md. */
  referenceLayerGroup: null,
  pendingBuildingId: null,
  pendingBuildingName: null,
  /* Scale inheritance -- see rmFinishTrace()/rmCalibrateEdge(). A
     dimensionless rescale factor (1 = no correction learned yet),
     compounded (multiplied in, not replaced) each time a manual_trace/
     ortho_trace outline on this SAME building gets calibrated, so a later
     fine-tune stacks on top of an earlier inherited correction rather than
     discarding it. inheritedScaleFactorBuildingId guards against applying
     a factor learned for one building to a different one. */
  inheritedScaleFactor: 1,
  inheritedScaleFactorBuildingId: null,
  /* Set momentarily by rmEnterMultiRoofCapture() around its
     rmClearFootprintLayers() call when continuing to trace on the SAME
     already-uploaded ortho for the SAME building -- see
     rmClearFootprintLayers() and "Scale inheritance" in DEV_NOTES.md. */
  preserveOrthoOnClear: false,
  /* Vertex snapping (Mark: "adjoining sections share EXACT shared
     vertices with no gaps or overlaps"). referenceRings is a flat array
     of {lat,lng} rings (one per already-traced roof shown in the
     reference layer), rebuilt alongside the visual reference layer by
     rmDrawReferenceRoofs() -- the actual snap targets rmFindSnapTarget()
     searches. snapEnabled is user-toggleable (checkbox in the trace
     panel); snapIndicatorLayer is the brief visual "you snapped here"
     marker. See "Vertex snapping" in DEV_NOTES.md. */
  snapEnabled: true,
  referenceRings: [],
  snapIndicatorLayer: null,
  /* True georeferenced GeoTIFF tracing (Mark: DJI Mavic 3T + WebODM + RTK
     orthos are real georeferenced GeoTIFFs, not flattened images) --
     deliberately SEPARATE from the orthoActive/orthoOverlayLayer/etc.
     state above, which is specifically the synthetic-origin flat-canvas
     system for a plain PNG/JPG with no geodata. A geoTiffLayer renders at
     its TRUE geographic position via georaster-layer-for-leaflet, so
     points traced on it are already real, accurate lat/lng straight from
     the map -- no synthetic origin, no scale guess, no Calibrate step
     needed. See "GeoTIFF georeferenced ortho support" in DEV_NOTES.md. */
  geoTiffActive: false,
  geoTiffLayer: null,
  /* KMZ/KML GroundOverlay tracing -- same georeferenced Leaflet-overlay
     path as GeoTIFF, but the geodata comes from KML LatLonBox metadata and
     the image is extracted from the KMZ ZIP or paired KML+image upload. */
  kmlOverlayActive: false,
  kmlOverlayLayer: null,
  kmlOverlayDataUrl: null,
  kmlOverlayMeta: null
};
var RM_LOCAL_KEY = "roofmapper-local-outlines-v1";
/* A commercial building — especially a hospital/medical campus — can easily
   be 100m+ from where a tech parks. 500ft-to-a-quarter-mile per the spec;
   "Search Wider" steps through this ladder without re-requesting GPS. */
var RM_RADIUS_STEPS = [150, 300, 500];
function rmPickInitialRadiusIndex(accuracy){
  /* Poor GPS accuracy shouldn't produce a false "nothing found" — start at
     whichever step already covers the reported error radius. */
  var needed = Math.max(150, (accuracy || 0) * 2.2);
  for (var i = 0; i < RM_RADIUS_STEPS.length; i++){
    if (RM_RADIUS_STEPS[i] >= needed) return i;
  }
  return RM_RADIUS_STEPS.length - 1;
}
function rmUpdateWidenButton(){
  var btn = document.getElementById("rm-widen-btn");
  if (!btn) return;
  var hasMore = rmState.radiusIndex < RM_RADIUS_STEPS.length - 1;
  btn.style.display = hasMore ? "" : "none";
  if (hasMore) btn.textContent = "🔎 Search Wider (" + RM_RADIUS_STEPS[rmState.radiusIndex + 1] + "m)";
}
function rmWidenSearch(){
  if (rmState.radiusIndex < RM_RADIUS_STEPS.length - 1) rmState.radiusIndex++;
  rmSearchBuildings();
}
/* Recovers from bad GPS (very common on desktop — IP-based location can
   be miles off — and not unheard of on phones either): after the user
   pans/zooms the map to the actual building by hand, this re-runs the
   exact same Overpass search rmSearchBuildings() already does, just
   centered on wherever the map currently sits instead of the original
   (possibly wrong) GPS fix. Resets to the narrowest radius step, same
   as a fresh GPS lock, since this is effectively "start over, but here"
   — rmClearFootprintLayers() inside rmSearchBuildings() already removes
   the previous search's polygons first, so there's never a stale
   overlap between an old and new result set. */
function rmSearchThisArea(){
  var map = rmState.map;
  if (!map){ toast("Use My Location first to open the map."); return; }
  var center = map.getCenter();
  rmState.lat = center.lat;
  rmState.lng = center.lng;
  rmState.radiusIndex = 0;
  rmSearchBuildings();
}

function rmOnShow(){
  if (rmState.map) setTimeout(function(){ rmState.map.invalidateSize(); }, 60);
  rmRenderLocalSaves();
}
function rmSetStatus(msg, kind, extraHtml){
  var el = document.getElementById("rm-status");
  el.textContent = msg || "";
  el.className = "rm-status" + (kind ? " " + kind : "");
  if (extraHtml) el.innerHTML += extraHtml;
}
/* Phase 3: RoofMapper can show either free OSM street tiles (best for
   reading building outlines/labels) or free Esri satellite imagery (best
   for tracing a roof OSM has no footprint for at all -- the St. Joseph's
   Hospital case). Same tile source already used elsewhere in the app
   (asset/pin placement) -- no new/paid service. */
var RM_TILE_OSM = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
var RM_TILE_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
/* ---- Export base imagery (satellite/ortho beneath the line art) ----
   Mark's fourth export complaint: "no base image (ortho/satellite) under
   the outlines... needs a toggle to include one beneath the line-art."
   Fetches + stitches just the tiles covering the drawing's own bounding
   box from the SAME free Esri World_Imagery tiles the live map already
   uses (RM_TILE_SAT) -- no new/paid service. Standard slippy-map tile
   math (see e.g. OSM's "Slippy map tilenames" wiki page). Confirmed this
   tile server allows canvas use cross-origin (drawImage + toDataURL, no
   tainted-canvas SecurityError) with img.crossOrigin="anonymous" before
   building this out. */
function rmLatLngToTile(lat, lng, z){
  var latRad = lat * Math.PI / 180;
  var n = Math.pow(2, z);
  return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n };
}
function rmTileToLatLng(x, y, z){
  var n = Math.pow(2, z);
  var latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return { lat: latRad * 180 / Math.PI, lng: x / n * 360 - 180 };
}
function rmComputeLatLngBounds(points){
  var lats = points.map(function(p){ return p.lat; }), lngs = points.map(function(p){ return p.lng; });
  var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
  var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
  var padLat = (maxLat - minLat) * 0.15 || 0.0003, padLng = (maxLng - minLng) * 0.15 || 0.0003;
  return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng };
}
/* Tile-count cap keeps a big multi-roof site from triggering hundreds of
   fetches -- picks the HIGHEST zoom (sharpest imagery) whose tile grid for
   this bbox still fits under the cap, walking down from 20 (typical max
   for this tile set) rather than using one fixed zoom for every roof size. */
var RM_BASEMAP_MAX_TILES = 64;
async function rmFetchBasemapImage(bounds){
  var z = 20, tl, br, tilesX, tilesY;
  for (; z >= 14; z--){
    tl = rmLatLngToTile(bounds.maxLat, bounds.minLng, z);
    br = rmLatLngToTile(bounds.minLat, bounds.maxLng, z);
    tilesX = Math.floor(br.x) - Math.floor(tl.x) + 1;
    tilesY = Math.floor(br.y) - Math.floor(tl.y) + 1;
    if (tilesX * tilesY <= RM_BASEMAP_MAX_TILES) break;
  }
  var x0 = Math.floor(tl.x), y0 = Math.floor(tl.y), x1 = Math.floor(br.x), y1 = Math.floor(br.y);
  var canvas = document.createElement("canvas");
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  var ctx = canvas.getContext("2d");
  var loads = [];
  for (var ty = y0; ty <= y1; ty++){
    for (var tx = x0; tx <= x1; tx++){
      loads.push(new Promise(function(resolve){
        var img = new Image();
        img.crossOrigin = "anonymous";
        var px = (tx - x0) * 256, py = (ty - y0) * 256;
        img.onload = function(){ ctx.drawImage(img, px, py); resolve(); };
        img.onerror = function(){ resolve(); }; /* missing tile -- leave that patch blank rather than fail the whole basemap */
        img.src = RM_TILE_SAT.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
      }));
    }
  }
  await Promise.all(loads);
  var nw = rmTileToLatLng(x0, y0, z), se = rmTileToLatLng(x1 + 1, y1 + 1, z);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), nwLat: nw.lat, nwLng: nw.lng, seLat: se.lat, seLng: se.lng };
}
function rmEnsureMap(){
  if (rmState.map) return rmState.map;
  document.getElementById("rm-map-wrap").style.display = "";
  /* Explicit zoomControl/scrollWheelZoom/touchZoom -- these already default
     true in Leaflet, spelled out here so it's clear real zoom in/out (mouse
     wheel, pinch, +/- buttons) is intentionally on, not an accident of
     defaults. bounceAtZoomLimits:false + zoomSnap:0.5 (finer increments,
     matches how a pinch gesture actually lands) round out the "easier
     navigation" pass -- see "Easier map navigation" in DEV_NOTES.md. */
  rmState.map = L.map("rm-map", {
    zoomControl: true, scrollWheelZoom: true, touchZoom: true,
    bounceAtZoomLimits: false, zoomSnap: 0.5, tap: true
  });
  rmSetBaseLayer("osm");
  return rmState.map;
}
function rmSetBaseLayer(type){
  var map = rmEnsureMap();
  if (rmState.baseLayer) map.removeLayer(rmState.baseLayer);
  if (type === "satellite"){
    rmState.baseLayer = L.tileLayer(RM_TILE_SAT, {
      maxZoom: 22, maxNativeZoom: SAT_MAX_NATIVE_ZOOM, attribution: "Tiles &copy; Esri"
    }).addTo(map);
  } else {
    type = "osm";
    rmState.baseLayer = L.tileLayer(RM_TILE_OSM, {
      maxZoom: 20, attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
  }
  rmState.baseLayer.bringToBack(); /* outlines/footprints/features stay on top */
  rmState.baseLayerType = type;
  var btn = document.getElementById("rm-baselayer-btn");
  if (btn) btn.textContent = type === "satellite" ? "🗺️ Map View" : "🛰️ Satellite View";
}
/* Explicitly setting the map's own maxZoom overrides Leaflet's default
   "derive it from whatever layers are currently added" behavior entirely
   -- so this is what actually lets a tech zoom in past whichever base
   tile layer's own cap (satellite 22, OSM 20) is lower, once an ortho or
   GeoTIFF is loaded. The ortho/GeoTIFF layer itself (L.imageOverlay /
   GeoRasterLayer) keeps rendering sharp at any zoom regardless -- neither
   is a zoom-bound tile layer with a resolution ceiling of its own, so this
   one call is the whole fix. Called at every point ortho/geoTiffActive
   flips (rmStartOrthoTrace/rmStartGeoTiffTrace/rmOpenRoofInMapper turning
   one on, rmClearOrthoOverlay/rmClearGeoTiffLayer turning it back off) so
   plain satellite-only tracing keeps its existing, already-tuned ceiling
   unchanged. See RM_ORTHO_MAX_ZOOM above and "Ortho zoom cap" in
   DEV_NOTES.md. */
function rmUpdateMapZoomCap(){
  if (!rmState.map) return;
  rmState.map.setMaxZoom((rmState.orthoActive || rmState.geoTiffActive || rmState.kmlOverlayActive) ? RM_ORTHO_MAX_ZOOM : 22);
}
function rmToggleBaseLayer(){
  rmSetBaseLayer(rmState.baseLayerType === "satellite" ? "osm" : "satellite");
}
function rmZoomToOutline(){
  if (!rmState.map || !rmState.outlineLayer) return;
  rmState.map.fitBounds(rmState.outlineLayer.getBounds(), { padding: [40, 40] });
}
/* Floating 🎯 button on the map itself -- always does the most useful
   "get back to where I should be looking" thing for whatever phase
   RoofMapper is currently in, so it's one obvious control regardless of
   whether an outline exists yet: fit to the outline if one's been drawn,
   else fit to the footprint search results if any are showing, else
   recenter on the located point, else nothing to do yet. See "Easier map
   navigation" in DEV_NOTES.md. */
function rmRecenter(){
  if (!rmState.map) return;
  if (rmState.outlineLayer){ rmZoomToOutline(); return; }
  var footprintIds = Object.keys(rmState.footprintLayers || {});
  if (footprintIds.length){
    var bounds = [];
    footprintIds.forEach(function(id){ bounds.push(rmState.footprintLayers[id].getBounds()); });
    rmState.map.fitBounds(bounds.reduce(function(acc, b){ return acc ? acc.extend(b) : b; }, null), { padding: [30, 30] });
    return;
  }
  if (typeof rmState.lat === "number"){ rmState.map.setView([rmState.lat, rmState.lng], 19); return; }
  toast("Nothing to center on yet — locate or search first.");
}
function rmSetDisp(id, show){
  var el = document.getElementById(id);
  if (el) el.style.display = show ? "" : "none";
}
/* Centralizes visibility for every control that's only relevant during ONE
   phase of the capture flow -- called at every phase transition so nothing
   lingers once it's no longer needed. Mark's real-world feedback tracing
   an outline: the search-again buttons stayed on screen after tracing
   started, and all the earlier capture controls (search/mode-switch) were
   still cluttering the screen even after the outline was saved. Does NOT
   touch #rm-footprint-panel's normal show/hide (that's driven by footprint
   selection itself -- rmSelectFootprint()/rmDeselectFootprint()) except to
   force it closed once saved, since "which building" is moot by then. */
function rmUpdateControlVisibility(){
  var located = rmState.lat != null;
  var tracing = rmTraceState.active;
  var hasOutline = !!rmState.outline;
  var saved = !!rmState.linkedBuildingId;
  /* Search-again buttons: only relevant during the "find a footprint"
     step -- gone once an outline exists (generated OR traced) or while
     actively tracing. */
  rmSetDisp("rm-search-again-wrap", located && !hasOutline && !tracing);
  rmSetDisp("rm-search-here-hint", located && !hasOutline && !tracing);
  /* Mode-switch row (satellite/trace/walk): stays available through the
     whole capture phase (including once an outline exists but isn't saved
     yet, in case the tech wants to redo it a different way), but goes away
     entirely once saved -- "no sense in having all this other stuff on
     here" once you're placing features. */
  rmSetDisp("rm-basemap-wrap", located && !saved);
  rmSetDisp("rm-trace-hint", located && !saved && !hasOutline && !tracing);
  /* Starting a NEW trace while already mid-trace doesn't make sense --
     hide just those two (keep the satellite toggle, still useful for
     checking imagery mid-trace). */
  rmSetDisp("rm-trace-btn", !tracing);
  rmSetDisp("rm-walk-btn", !tracing);
  /* Trace controls: only while actively tracing -- now living right below
     the map (see the HTML), not a separate card several scrolls away. */
  rmSetDisp("rm-trace-panel", tracing);
  if (saved) rmSetDisp("rm-footprint-panel", false);
  /* Rename control: only meaningful once this outline belongs to an
     actual saved/linked roof (see rmRenameLinkedRoof()). */
  rmSetDisp("rm-rename-roof-btn", !!rmState.linkedRoofId);
  /* Split control: used to be hidden once saved -- splitting an ALREADY-
     saved roof is now supported (rmSaveSplitSectionsToExistingRoof(), see
     "Split an already-saved roof" in DEV_NOTES.md), so this now shows
     whenever there's an outline to split at all, saved or not. */
  rmSetDisp("rm-split-btn", hasOutline);
}
function rmUseMyLocation(){
  var btn = document.getElementById("rm-locate-btn");
  btn.disabled = true; btn.textContent = "Locating…";
  rmSetStatus("Requesting GPS location — allow location access if your browser asks.");
  rmGeoRequest(function(pos){
    btn.disabled = false; btn.textContent = "📍 Use My Location";
    var lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy || 0;
    rmState.lat = lat; rmState.lng = lng; rmState.accuracy = acc;
    rmState.radiusIndex = rmPickInitialRadiusIndex(acc);
    var map = rmEnsureMap();
    if (rmState.userMarker) map.removeLayer(rmState.userMarker);
    if (rmState.accuracyCircle) map.removeLayer(rmState.accuracyCircle);
    rmState.userMarker = L.circleMarker([lat, lng], { radius: 7, color: "#fff", weight: 2, fillColor: "#1976D2", fillOpacity: 1 }).addTo(map);
    rmState.accuracyCircle = L.circle([lat, lng], { radius: acc, color: "#1976D2", weight: 1, fillOpacity: 0.08 }).addTo(map);
    map.setView([lat, lng], 19);
    setTimeout(function(){ map.invalidateSize(); }, 60);
    var accKind = acc <= 15 ? "good" : (acc <= 35 ? "ok" : "poor");
    var accLabel = acc <= 15 ? "Good" : (acc <= 35 ? "Fair" : "Poor");
    rmSetStatus("Located — accuracy ±" + Math.round(acc) + "m.", accKind === "poor" ? "warn" : null,
      ' <span class="rm-accuracy ' + accKind + '">' + accLabel + ' GPS</span>');
    rmUpdateControlVisibility();
    if (accKind === "poor") toast("GPS accuracy is poor (±" + Math.round(acc) + "m) — searching anyway, open sky helps.");
    rmSearchBuildings();
  }, function(err){
    btn.disabled = false; btn.textContent = "📍 Use My Location";
    rmSetStatus(err.friendly || "Couldn't get your location.", "error");
  });
}
/* Free-typed address search -- Mark's ask: RoofMapper (and the "find a
   place to work" flow generally) shouldn't require standing at the GPS
   location OR a match against CompanyCam/an existing building. Any typed
   address geocodes via the same geocodeAddress()/Nominatim path pin
   placement already uses, and lands in the exact same rmState.lat/lng +
   rmSearchBuildings() pipeline rmUseMyLocation() uses on GPS success -- so
   everything downstream (footprint search, manual trace, walk-the-corners,
   save-to-new-building) works identically regardless of which entry point
   located the map. See "Address search" in DEV_NOTES.md. */
async function rmSearchByAddress(){
  var addr = val("rm-address-search").trim();
  if (!addr){ toast("Type an address to search."); return; }
  var btn = document.getElementById("rm-address-search-btn");
  btn.disabled = true; btn.textContent = "Searching…";
  rmSetStatus("Looking up that address…");
  try{
    var geo = await geocodeAddress(addr);
    if (!geo){
      rmSetStatus("Couldn't find that address — try a more complete one (street, city, state).", "error");
      return;
    }
    /* No real GPS accuracy for a geocoded address -- rmState.accuracy gets
       a nominal placeholder just so rmPickInitialRadiusIndex() (expects a
       meters value) behaves sensibly; no accuracy circle is drawn since
       showing a fake "±Nm GPS accuracy" would be misleading for a
       street-address lookup. */
    rmState.lat = geo.lat; rmState.lng = geo.lng; rmState.accuracy = 30;
    rmState.radiusIndex = rmPickInitialRadiusIndex(rmState.accuracy);
    var map = rmEnsureMap();
    if (rmState.userMarker) map.removeLayer(rmState.userMarker);
    if (rmState.accuracyCircle) map.removeLayer(rmState.accuracyCircle);
    rmState.userMarker = L.circleMarker([geo.lat, geo.lng], { radius: 7, color: "#fff", weight: 2, fillColor: "#1976D2", fillOpacity: 1 }).addTo(map);
    rmState.accuracyCircle = null;
    map.setView([geo.lat, geo.lng], 19);
    setTimeout(function(){ map.invalidateSize(); }, 60);
    rmSetStatus("Found “" + addr + "” — searching for footprints nearby.");
    rmUpdateControlVisibility();
    rmSearchBuildings();
  }catch(e){
    rmSetStatus("Couldn't search that address: " + e.message, "error");
  }finally{
    btn.disabled = false; btn.textContent = "🔍 Search";
  }
}
function rmClearLinkedFeatures(){
  /* Drops the "linked to a building" state (and its feature markers) --
     called whenever the outline itself is about to change (new search, or
     loading a different local save) so stale features from a PREVIOUS
     building never bleed into a new one. */
  rmCloseFeatureForm(); /* don't leave an in-progress add/edit orphaned */
  if (rmMarkupState.active) rmCancelMarkup(); /* don't leave an in-progress markup placement orphaned either */
  if (rmState.map && rmState.assetLayerGroup) rmState.map.removeLayer(rmState.assetLayerGroup);
  rmState.assetLayerGroup = null;
  rmState.linkedAssetsCache = [];
  if (rmState.map && rmState.markupLayerGroup) rmState.map.removeLayer(rmState.markupLayerGroup);
  rmState.markupLayerGroup = null;
  rmMarkupState.cache = [];
  rmMarkupState.periodFilter = "All";
  rmState.linkedBuildingId = null;
  rmState.linkedRoofId = null;
  if (rmState.map && rmState.roofLabelLayer) rmState.map.removeLayer(rmState.roofLabelLayer);
  rmState.roofLabelLayer = null;
  rmSetDisp("rm-rename-roof-btn", false);
  rmState.roofLabelHasCustomPos = false;
  rmSetDisp("rm-reset-label-btn", false);
  var switcherHost = document.getElementById("rm-roof-switcher");
  if (switcherHost) switcherHost.innerHTML = "";
  var exportSelectHost = document.getElementById("rm-export-roof-select");
  if (exportSelectHost) exportSelectHost.innerHTML = "";
  var panel = document.getElementById("rm-features-panel");
  if (panel) panel.style.display = "none";
  var markupPanel = document.getElementById("rm-markup-panel");
  if (markupPanel) markupPanel.style.display = "none";
  var bmStatus = document.getElementById("rm-basemap-status");
  if (bmStatus) bmStatus.innerHTML = "";
}
function rmUpdateExportHint(){
  var el = document.getElementById("rm-export-hint");
  if (!el) return;
  el.textContent = rmState.linkedBuildingId ?
    "Exports include the outline plus every placed feature and pinned finding on this roof." :
    "Exports include the outline only — save to a building and add features to include them too.";
}
function rmClearGeneratedOutline(){
  /* Drops the generated outline itself (and everything tied to it -- the
     drawn polygon, any building link, its feature markers) without
     touching footprint search results -- shared by a fresh search,
     switching to a different footprint, and the explicit "wrong building"
     clear button, so none of them can leave a stale outline from whichever
     footprint was selected before. */
  if (rmState.map && rmState.outlineLayer) rmState.map.removeLayer(rmState.outlineLayer);
  rmState.outlineLayer = null;
  rmState.outline = null;
  if (rmState.map && rmState.dimensionLayerGroup) rmState.map.removeLayer(rmState.dimensionLayerGroup);
  rmState.dimensionLayerGroup = null;
  rmState.preSquareRing = null;
  var undoBtn = document.getElementById("rm-undo-square-btn");
  if (undoBtn) undoBtn.style.display = "none";
  var squareStatus = document.getElementById("rm-square-status");
  if (squareStatus) squareStatus.textContent = "";
  rmState.preResnapRing = null;
  var undoResnapBtn = document.getElementById("rm-undo-resnap-btn");
  if (undoResnapBtn) undoResnapBtn.style.display = "none";
  var resnapStatus = document.getElementById("rm-resnap-status");
  if (resnapStatus) resnapStatus.textContent = "";
  rmState.preAlignRing = null;
  var undoAlignBtn = document.getElementById("rm-undo-align-btn");
  if (undoAlignBtn) undoAlignBtn.style.display = "none";
  if (rmAlignState.active) rmExitAlignMode(false); /* discard, nothing left to save it to */
  if (rmState.vertexEditActive) rmExitVertexEdit(false); /* discard, nothing left to save it to */
  rmClearLinkedFeatures();
  rmClearSplitState(); /* a torn-down outline takes any pending split sections of it down too */
  document.getElementById("rm-outline-panel").style.display = "none";
  rmUpdateExportHint();
  rmUpdateControlVisibility();
}
/* Mark: "there's not anything to get rid of it... you still don't have the
   delete button to get rid of anything that you generate on RoofMapper."
   This clears the WORKING outline on this screen -- if it was never saved
   to a building, that's the whole story, it's just gone. If it WAS already
   saved (rmState.linkedBuildingId set -- pushed into that roof's
   roof_outlines[] by rmSaveOutlineToBuilding()), this does NOT delete that
   saved copy: roof_outlines[] is an append-only, no-delete-anywhere design
   (same as Building History's own Roof Map -- there's no "delete a saved
   outline" button there either), and adding real delete-from-Firestore for
   permanent roof history records is a bigger decision than this fix, not
   something to quietly bolt on. The confirm text makes that distinction
   explicit rather than implying more than this button actually does. */
function rmDeleteOutline(){
  if (!rmState.outline) return;
  var wasSaved = !!rmState.linkedBuildingId;
  var msg = wasSaved ?
    "This outline (and any features on it) was already saved to a building. Clearing it here only resets this screen -- it will NOT remove the saved copy from the building's record. Continue?" :
    "Delete this outline and start over?";
  if (!confirm(msg)) return;
  rmClearGeneratedOutline();
  toast(wasSaved ? "Cleared here — the saved copy on the building is unchanged." : "Outline deleted.");
}
function rmClearFootprintLayers(){
  rmCancelTrace(); /* starting fresh (new search, or a new trace) aborts any in-progress trace too */
  /* GPS/address search means a real location, not the ortho's synthetic
     Null Island one -- BUT rmEnterMultiRoofCapture() sets
     preserveOrthoOnClear when "Trace Another Roof" is continuing on the
     SAME already-uploaded ortho for the SAME building, so he isn't forced
     to re-upload/re-pick the same image for every roof section on it.
     See "Scale inheritance" in DEV_NOTES.md. */
  if (!rmState.preserveOrthoOnClear){
    rmClearOrthoOverlay();
    rmClearGeoTiffLayer(); /* same "continuing the same building's already-uploaded base" exception as the ortho overlay above */
    rmClearKmlOverlay();
  }
  var map = rmState.map;
  if (map){
    Object.keys(rmState.footprintLayers).forEach(function(id){ map.removeLayer(rmState.footprintLayers[id]); });
  }
  rmState.footprintLayers = {};
  rmState.selectedId = null;
  rmClearGeneratedOutline();
  document.getElementById("rm-footprint-panel").style.display = "none";
}
async function rmSearchBuildings(){
  if (rmState.lat == null){ toast("Get your location first."); return; }
  var radius = RM_RADIUS_STEPS[rmState.radiusIndex];
  rmSetStatus("Searching within " + radius + "m for building footprints…");
  rmClearFootprintLayers();
  rmUpdateControlVisibility();
  try{
    var results = await rmFetchNearbyBuildings(rmState.lat, rmState.lng, radius);
    var hasMore = rmState.radiusIndex < RM_RADIUS_STEPS.length - 1;
    if (!results.length){
      rmSetStatus("No building footprints found within " + radius + "m." +
        (hasMore ? " Tap Search Wider to expand, or move closer." : " Try moving closer, or Re-locate & Search Again."), "warn");
      rmUpdateWidenButton();
      return;
    }
    /* Prioritize real building footprints over large untagged site/campus
       polygons (see rmParseOverpassElements's isSite classification) — a
       tech should never have to pick between "the actual roof" and "the
       whole property" if a real building footprint exists at all. Only
       fall back to showing the site polygon when nothing else was found. */
    var realBuildings = results.filter(function(f){ return !f.isSite; });
    var sitesOnly = results.filter(function(f){ return f.isSite; });
    var toShow = realBuildings.length ? realBuildings : sitesOnly;
    rmState.footprints = toShow;
    rmRenderFootprints();
    if (!realBuildings.length){
      rmSetStatus("No individual building footprints within " + radius + "m — OpenStreetMap only has an approximate property/site boundary here. Showing " +
        toShow.length + " site boundar" + (toShow.length === 1 ? "y" : "ies") + " instead; treat it as a rough reference, not an exact roof.", "warn");
    } else {
      rmSetStatus(toShow.length + " building" + (toShow.length === 1 ? "" : "s") + " found within " + radius + "m — tap the correct outline on the map.");
    }
    rmUpdateWidenButton();
  }catch(e){
    rmSetStatus("Couldn't reach OpenStreetMap (Overpass) — check your connection and tap Re-locate & Search Again. (" + e.message + ")", "error");
    rmUpdateWidenButton();
  }
}
function rmFootprintStyle(fp, isSel){
  if (isSel) return { color: "#E8600A", weight: 3, dashArray: fp.isSite ? "6,6" : null, fillColor: "#E8600A", fillOpacity: 0.3 };
  if (fp.isSite) return { color: "#B45309", weight: 2, dashArray: "6,6", fillColor: "#FBBF24", fillOpacity: 0.15 };
  return { color: "#37474F", weight: 2, dashArray: null, fillColor: "#90A4AE", fillOpacity: 0.35 };
}
function rmRenderFootprints(){
  var map = rmEnsureMap();
  var bounds = [[rmState.lat, rmState.lng]];
  rmState.footprints.forEach(function(fp){
    var latlngs = fp.ring.map(function(p){ return [p.lat, p.lng]; });
    var layer = L.polygon(latlngs, rmFootprintStyle(fp, false));
    layer.on("click", function(){ rmSelectFootprint(fp.id); });
    layer.addTo(map);
    rmState.footprintLayers[fp.id] = layer;
    latlngs.forEach(function(ll){ bounds.push(ll); });
  });
  map.fitBounds(bounds, { padding: [30, 30] });
  setTimeout(function(){ map.invalidateSize(); }, 60);
}
function rmSelectFootprint(id){
  var fp = rmState.footprints.find(function(f){ return f.id === id; });
  if (!fp) return;
  rmState.selectedId = id;
  /* Switching selection (tapping a different footprint directly, without
     going through the explicit deselect button first) must not leave an
     outline/features from the PREVIOUSLY selected footprint hanging
     around. */
  rmClearGeneratedOutline();
  Object.keys(rmState.footprintLayers).forEach(function(fid){
    var f = rmState.footprints.find(function(x){ return x.id === fid; });
    rmState.footprintLayers[fid].setStyle(rmFootprintStyle(f, fid === id));
  });
  var tags = fp.tags || {};
  var addrParts = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  var infoHtml = "<b>" + esc(tags.name || (fp.osmType === "way" ? "Unnamed building" : "Unnamed building group")) + "</b>";
  if (addrParts) infoHtml += "<br>" + esc(addrParts);
  var typeLabel = (tags.building && tags.building !== "yes" && tags.building) ||
    tags.healthcare || tags.amenity || tags.shop || tags.office || tags.leisure || null;
  if (typeLabel) infoHtml += "<br>Type: " + esc(typeLabel.replace(/_/g, " "));
  infoHtml += "<br><span style='color:var(--muted);font-size:12px'>OSM " + esc(fp.osmType) + "/" + esc(fp.id.split("/")[1]) +
    " · ~" + Math.round(fp.areaSqFt).toLocaleString() + " sq ft</span>";
  if (fp.isSite){
    infoHtml += '<br><span style="color:#B45309;font-weight:700">⚠️ This looks like the overall property/site ' +
      'boundary, not a single building roof — OpenStreetMap has no individual building footprint here yet.</span>';
  }
  document.getElementById("rm-footprint-info").innerHTML = infoHtml;
  var genBtn = document.getElementById("rm-generate-btn");
  genBtn.textContent = fp.isSite ? "⚠️ Use Site Boundary Anyway (Not a Roof)" : "✏️ Generate Roof Outline";
  genBtn.classList.toggle("primary", !fp.isSite);
  genBtn.classList.toggle("danger", !!fp.isSite);
  document.getElementById("rm-footprint-panel").style.display = "";
  document.getElementById("rm-footprint-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function rmDeselectFootprint(){
  rmState.selectedId = null;
  rmClearGeneratedOutline();
  Object.keys(rmState.footprintLayers).forEach(function(fid){
    var f = rmState.footprints.find(function(x){ return x.id === fid; });
    if (f) rmState.footprintLayers[fid].setStyle(rmFootprintStyle(f, false));
  });
  document.getElementById("rm-footprint-panel").style.display = "none";
  document.getElementById("rm-footprint-info").innerHTML = "";
  toast("Selection cleared — tap the correct building's outline on the map, or search again.");
}
function rmRenderOutlineStats(outline){
  document.getElementById("rm-outline-warning").innerHTML = outline.isSiteBoundary ?
    '<p class="rm-status warn" style="margin:0 0 10px">⚠️ This traces the property/site boundary from ' +
    'OpenStreetMap, not a single roof — the numbers below cover the whole site. Use only as a rough reference; ' +
    'trace or measure the actual roof separately.</p>' : '';
  /* Scale inheritance indicator -- Mark: "show the user that the scale is
     inherited." outline.calibration.inherited (set by rmFinishTrace() when
     it auto-applies a factor learned from an earlier roof on this same
     building) is distinct from a manually-tapped edge calibration
     (calibration.edgeIndex set instead) -- only the inherited case gets
     this note; a real edge tap already has its own green-highlighted
     label on the map. */
  var scaleNote = "";
  if (outline.calibration && outline.calibration.inherited){
    scaleNote = '<p class="hint" style="margin:0 0 8px">📏 Scale inherited from this building’s earlier ' +
      'calibration — no need to re-measure. Tap any edge’s length to override it for just this roof.</p>';
  }
  document.getElementById("rm-outline-stats").innerHTML = scaleNote +
    '<div class="stat"><b>' + outline.areaSqFt.toFixed(0) + '</b><span>Sq Ft</span></div>' +
    '<div class="stat"><b>' + outline.perimeterFt.toFixed(0) + '</b><span>Perimeter Ft</span></div>' +
    '<div class="stat"><b>' + outline.ring.length + '</b><span>Points</span></div>';
  document.getElementById("rm-outline-panel").style.display = "";
}
/* Shared by rmGenerateOutline() (OSM footprint) and rmFinishTrace() (Phase
   3 manual trace) -- draws whatever outline object was built, zooms to it,
   and updates the surrounding UI, so both capture methods end up on
   identical footing for save/export/feature-placement. */
/* Auto per-edge dimensions -- the base "show per-edge lengths" piece of the
   Dimensions roadmap item (calibrate-by-known-edge, the tap-to-edit-and-
   rescale piece, comes later alongside walk-the-corners refinement; this
   just SHOWS the GPS/geometry-derived length of every edge, on the map,
   right now). One small label per edge, at its midpoint, reusing the same
   haversine distance helper the perimeter total already uses -- so the
   sum of these labels always matches the perimeter stat exactly. */
function rmDrawEdgeDimensions(outline){
  var map = rmState.map;
  if (!map) return;
  if (rmState.dimensionLayerGroup) map.removeLayer(rmState.dimensionLayerGroup);
  rmState.dimensionLayerGroup = L.layerGroup().addTo(map);
  var ring = outline.ring;
  var calibratedIdx = outline.calibration ? outline.calibration.edgeIndex : -1;
  for (var i = 0; i < ring.length - 1; i++){
    var a = ring[i], b = ring[i + 1];
    var distFt = rmGeomHaversineMeters(a, b) * 3.28084;
    if (distFt < 1) continue; /* skip degenerate/near-zero edges from ring cleanup */
    var midLat = (a.lat + b.lat) / 2, midLng = (a.lng + b.lng) / 2;
    var isCalibrated = i === calibratedIdx;
    var bg = isCalibrated ? "#2E7D32" : "#263238";
    var label = (isCalibrated ? "✓ " : "") + Math.round(distFt) + " ft" +
      (isCalibrated && outline.calibration && outline.calibration.verified ? " VERIFIED" : "");
    var marker = L.marker([midLat, midLng], {
      icon: L.divIcon({
        className: "", iconSize: null,
        html: '<div style="background:' + bg + ';color:#fff;padding:3px 7px;border-radius:4px;' +
          'font-size:11px;font-weight:700;white-space:nowrap;transform:translate(-50%,-50%);' +
          'box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:pointer' +
          (isCalibrated ? ";border:1.5px solid #fff" : "") + '">' + label + '</div>'
      }),
      interactive: true
    }).addTo(rmState.dimensionLayerGroup);
    /* Closure over i so each label's tap targets its own edge -- tapping
       opens the calibrate-by-known-edge prompt for that edge specifically.
       See "Self-scaling dimension calibration" in DEV_NOTES.md. */
    (function(edgeIndex){
      marker.on("click", function(){ rmCalibrateEdge(edgeIndex); });
    })(i);
  }
}
/* ---- Vertex (per-corner) editing ----
   Mark asked how to adjust an already-traced outline -- there was
   previously no way to move one specific point (Square Up auto-cleans
   angles across the whole shape, Calibrate rescales the whole shape off
   one edge; neither lets you drag a single corner). This is that missing
   capability, made deliberately visible rather than a hidden gesture: a
   primary "✏️ Edit Shape" button, explicit hint text, and handles styled
   distinctly from both the edge-dimension labels and asset markers.
   Scope: MOVING existing vertices only -- adding/removing a vertex
   entirely is a bigger follow-up, not built here. See "Vertex editing"
   in DEV_NOTES.md. */
function rmToggleVertexEdit(){
  if (rmState.vertexEditActive) rmExitVertexEdit(true);
  else rmEnterVertexEdit();
}
function rmEnterVertexEdit(){
  if (!rmState.outline || !rmState.map) return;
  rmState.vertexEditActive = true;
  document.getElementById("rm-edit-shape-btn").textContent = "✓ Done Editing";
  document.getElementById("rm-edit-shape-hint").style.display = "";
  document.getElementById("rm-square-up-btn").disabled = true; /* two edit modes fighting over the same ring mid-drag is asking for trouble */
  document.getElementById("rm-resnap-btn").disabled = true;
  document.getElementById("rm-align-btn").disabled = true;
  rmSetPrecisionMode(true);
  rmDrawVertexHandles();
}
function rmExitVertexEdit(persist){
  rmState.vertexEditActive = false;
  var btn = document.getElementById("rm-edit-shape-btn");
  if (btn) btn.textContent = "✏️ Edit Shape";
  var hint = document.getElementById("rm-edit-shape-hint");
  if (hint) hint.style.display = "none";
  var sqBtn = document.getElementById("rm-square-up-btn");
  if (sqBtn) sqBtn.disabled = false;
  var resnapBtn = document.getElementById("rm-resnap-btn");
  if (resnapBtn) resnapBtn.disabled = false;
  var alignBtn = document.getElementById("rm-align-btn");
  if (alignBtn) alignBtn.disabled = false;
  if (rmState.map && rmState.vertexHandleLayerGroup) rmState.map.removeLayer(rmState.vertexHandleLayerGroup);
  rmState.vertexHandleLayerGroup = null;
  rmClearSnapIndicator();
  rmSetPrecisionMode(false);
  if (persist) rmPersistVertexEdit();
}
function rmDrawVertexHandles(){
  var map = rmState.map, outline = rmState.outline;
  if (!map || !outline) return;
  if (rmState.vertexHandleLayerGroup) map.removeLayer(rmState.vertexHandleLayerGroup);
  rmState.vertexHandleLayerGroup = L.layerGroup().addTo(map);
  var ring = outline.ring;
  var n = ring.length - 1; /* real vertex count -- ring[n] === ring[0], the closing duplicate */
  for (var i = 0; i < n; i++){
    var marker = L.marker([ring[i].lat, ring[i].lng], {
      draggable: true,
      icon: L.divIcon({
        className: "", iconSize: [24, 24], iconAnchor: [12, 12],
        html: '<div style="width:20px;height:20px;border-radius:50%;background:#fff;' +
          'border:3px solid #E8600A;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>'
      })
    }).addTo(rmState.vertexHandleLayerGroup);
    /* "drag" (continuous, every move) only moves the polygon outline
       itself -- cheap (setLatLngs). "dragend" (once, on release) is where
       area/perimeter/edge-labels actually recompute -- redrawing the
       edge-dimension divIcons on every drag frame would be needless churn
       mid-gesture and risks feeling laggy on a phone, the opposite of
       what was asked for. */
    (function(vertexIndex, marker2){
      marker.on("drag", function(e){ rmOnVertexDrag(vertexIndex, e.target.getLatLng()); });
      marker.on("dragend", function(e){ rmOnVertexDragEnd(vertexIndex, e.target.getLatLng(), marker2); });
    })(i, marker);
  }
}
function rmOnVertexDrag(vertexIndex, latlng){
  var outline = rmState.outline;
  if (!outline) return;
  var ring = outline.ring;
  var n = ring.length - 1;
  ring[vertexIndex] = { lat: latlng.lat, lng: latlng.lng };
  if (vertexIndex === 0) ring[n] = { lat: latlng.lat, lng: latlng.lng }; /* keep the ring explicitly closed */
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(ring.map(function(p){ return [p.lat, p.lng]; }));
}
/* vertexIndex/droppedLatLng/marker are only used for the snap check --
   same rmFindSnapTarget() the trace-tap path uses, so dragging a corner
   near an existing roof's vertex/edge locks it exactly onto that shared
   boundary too. Snapped or not, the outline.ring was already updated
   live during "drag" (rmOnVertexDrag) -- this just possibly nudges it
   those last few pixels onto an exact match before recomputing stats. */
function rmOnVertexDragEnd(vertexIndex, droppedLatLng, marker){
  var outline = rmState.outline;
  if (!outline) return;
  var ring = outline.ring;
  var n = ring.length - 1;
  var snap = rmFindSnapTarget(droppedLatLng);
  if (snap){
    ring[vertexIndex] = { lat: snap.lat, lng: snap.lng };
    if (vertexIndex === 0) ring[n] = { lat: snap.lat, lng: snap.lng };
    if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(ring.map(function(p){ return [p.lat, p.lng]; }));
    if (marker) marker.setLatLng([snap.lat, snap.lng]);
    rmShowSnapIndicator(snap);
    toast("Snapped to existing roof " + snap.type + " ✓");
  } else {
    rmClearSnapIndicator();
  }
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(outline.ring) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(outline.ring) * 3.28084;
  outline.center = rmGeomRingCentroid(outline.ring);
  /* A manual point move invalidates any prior "this shape is square" /
     "this edge is calibrated" guarantee -- clearing both rather than
     silently leaving stale metadata that no longer matches the actual
     shape. Also drops the Square Up, Re-Snap to Neighbors, and Align
     undo snapshots, since "undo" against a ring that's since been
     hand-edited wouldn't mean what any of them used to. */
  delete outline.squared;
  delete outline.calibration;
  rmState.preSquareRing = null;
  var undoBtn = document.getElementById("rm-undo-square-btn");
  if (undoBtn) undoBtn.style.display = "none";
  rmState.preResnapRing = null;
  var undoResnapBtn = document.getElementById("rm-undo-resnap-btn");
  if (undoResnapBtn) undoResnapBtn.style.display = "none";
  rmState.preAlignRing = null;
  var undoAlignBtn = document.getElementById("rm-undo-align-btn");
  if (undoAlignBtn) undoAlignBtn.style.display = "none";
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
}
/* Same "only writes if already saved" pattern as Calibrate/Square Up. */
async function rmPersistVertexEdit(){
  var outline = rmState.outline;
  if (!outline) return;
  rmUpdateExportHint();
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId || !outline.id){
    toast("Shape updated ✓ — will save with the outline.");
    return;
  }
  if (!fdb){ toast("Shape updated ✓ — will save with the outline."); return; }
  toast("Saving shape…");
  try{
    var snap = await fdb.collection("buildings").doc(rmState.linkedBuildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var roof = roofs.find(function(r){ return r.id === rmState.linkedRoofId; });
    if (!roof){ toast("Couldn't find the linked roof to save."); return; }
    roof.roof_outlines = (roof.roof_outlines || []).map(function(o){
      return o.id === outline.id ? Object.assign({}, o, {
        ring: outline.ring, areaSqFt: outline.areaSqFt, perimeterFt: outline.perimeterFt,
        center: outline.center, calibration: null, squared: null
      }) : o;
    });
    var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
    roofs[roofIdx] = roof;
    await saveBuildingRoofs(rmState.linkedBuildingId, roofs);
    toast("Shape saved ✓");
  }catch(e){ toast("Updated on screen, but couldn't save: " + e.message); }
}
function rmDrawFinalOutline(outline){
  rmState.outline = outline;
  rmClearLinkedFeatures(); /* a freshly captured outline is never linked yet */
  rmClearSplitState(); /* and never has a pending split from whatever outline was showing before */
  rmState.preSquareRing = null; /* a fresh outline was never squared -- no stale Undo button */
  var undoBtn = document.getElementById("rm-undo-square-btn");
  if (undoBtn) undoBtn.style.display = "none";
  var squareStatus = document.getElementById("rm-square-status");
  if (squareStatus) squareStatus.textContent = "";
  rmState.preResnapRing = null; /* a fresh outline was never re-snapped -- no stale Undo button */
  var undoResnapBtn = document.getElementById("rm-undo-resnap-btn");
  if (undoResnapBtn) undoResnapBtn.style.display = "none";
  var resnapStatus = document.getElementById("rm-resnap-status");
  if (resnapStatus) resnapStatus.textContent = "";
  rmState.preAlignRing = null; /* a fresh outline was never aligned -- no stale Undo button */
  var undoAlignBtn = document.getElementById("rm-undo-align-btn");
  if (undoAlignBtn) undoAlignBtn.style.display = "none";
  if (rmAlignState.active) rmExitAlignMode(false); /* a fresh outline replaces whatever was being aligned */
  if (rmState.vertexEditActive) rmExitVertexEdit(false); /* a fresh outline replaces whatever was being hand-edited */
  var map = rmEnsureMap();
  if (rmState.outlineLayer) map.removeLayer(rmState.outlineLayer);
  rmState.outlineLayer = L.polygon(outline.ring.map(function(p){ return [p.lat, p.lng]; }), {
    color: "#E8600A", weight: 3, dashArray: outline.isSiteBoundary ? "6,6" : null, fillColor: "#E8600A", fillOpacity: 0.15
  }).addTo(map);
  rmDrawEdgeDimensions(outline);
  /* Search results just left the map fit to EVERY candidate footprint --
     zoom straight into the one actually chosen so there's real room to
     work (Mark: "the current map feels small"), instead of leaving the
     view zoomed out to fit buildings that no longer matter. */
  rmZoomToOutline();
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  rmUpdateControlVisibility();
  document.getElementById("rm-outline-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
/* ---- Calibrate-by-known-edge (self-scaling dimension calibration) ----
   GPS corner-walking (and OSM/manual-trace to a lesser degree) gives an
   accurate SHAPE but only a rough absolute SIZE. Mark's exact UX: the tech
   taps ONE edge's dimension label, enters the real tape-measured length,
   and the WHOLE footprint rescales proportionally off that one edge --
   every other edge, area, and perimeter update to match. One field
   measurement, one edit, the whole outline becomes accurate. Works on any
   outline (OSM/manual_trace/walk_corners) since it's pure geometry on the
   ring -- see "Dimensions" > "Calibrate-by-known-edge" in ROADMAP.md. */
function rmCalibrateEdge(edgeIndex){
  var outline = rmState.outline;
  if (!outline) return;
  var ring = outline.ring;
  var a = ring[edgeIndex], b = ring[edgeIndex + 1];
  if (!a || !b) return;
  var currentFt = rmGeomHaversineMeters(a, b) * 3.28084;
  var overlayText = outline.groundOverlay ?
    [outline.groundOverlay.sourceFileName, outline.groundOverlay.imageFileName, outline.groundOverlay.name].filter(Boolean).join(" ") : "";
  var isNorthCollege = /north[\s_-]*college/i.test(overlayText);
  var defaultMeasuredFt = isNorthCollege ? 28 : Math.round(currentFt);
  var input = prompt("Real field-measured length of this edge, in feet (currently ~" +
    Math.round(currentFt) + " ft):", String(defaultMeasuredFt));
  if (input === null) return; /* canceled */
  var measuredFt = parseFloat(input);
  if (!isFinite(measuredFt) || measuredFt <= 0){ toast("Enter a length greater than 0."); return; }
  var verifiedNorthCollegeMeasurement = isNorthCollege && Math.abs(measuredFt - 28) < 0.01;
  if (verifiedNorthCollegeMeasurement && !confirm("Inside parapet to inside parapet?")){
    return;
  }
  var factor = measuredFt / currentFt;
  /* Uniform scale about the ring's own centroid -- preserves shape/angles,
     changes only size, exactly matching "rescales proportionally." Fresh
     centroid each call so repeated recalibrations (off the same or a
     different edge) compound correctly with no drift. */
  var centroid = rmGeomRingCentroid(ring);
  var newRing = ring.map(function(p){ return rmGeomScalePoint(p, centroid, factor); });
  outline.ring = newRing;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(newRing) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(newRing) * 3.28084;
  outline.center = centroid;
  outline.calibration = { edgeIndex: edgeIndex, measuredFt: measuredFt, calibratedAt: Date.now() };
  if (verifiedNorthCollegeMeasurement){
    outline.calibration.verified = true;
    outline.calibration.description = "Northeasternmost west-to-east wall, inside parapet";
  }
  /* Scale inheritance -- learn from this calibration so the NEXT roof
     traced on this same building (manual_trace/ortho_trace only --
     OSM footprints are independently georeferenced, walk_corners has no
     shared scale to learn) can skip re-measuring. Compounds (multiplies
     in) rather than replaces, so recalibrating a second roof on the same
     building stacks on top of what the first one already taught, instead
     of discarding it. See rmFinishTrace() and "Scale inheritance" in
     DEV_NOTES.md. */
  if ((outline.source === "manual_trace" || outline.source === "ortho_trace") && rmState.linkedBuildingId){
    var carryOver = rmState.inheritedScaleFactorBuildingId === rmState.linkedBuildingId ? rmState.inheritedScaleFactor : 1;
    rmState.inheritedScaleFactor = carryOver * factor;
    rmState.inheritedScaleFactorBuildingId = rmState.linkedBuildingId;
  }
  /* If features are already placed on a saved roof, keep them visually
     anchored to the roof by applying the identical transform -- otherwise
     a rescale would visibly detach drains/HVAC markers from the edges they
     were placed against. */
  var rescaledAssets = null;
  if (rmState.linkedAssetsCache && rmState.linkedAssetsCache.length){
    rescaledAssets = rmState.linkedAssetsCache.map(function(asset){
      var p = rmGeomScalePoint({ lat: asset.lat, lng: asset.lng }, centroid, factor);
      return Object.assign({}, asset, { lat: p.lat, lng: p.lng });
    });
    rmState.linkedAssetsCache = rescaledAssets;
    rmDrawLinkedAssets(rescaledAssets);
  }
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(newRing.map(function(p){ return [p.lat, p.lng]; }));
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  rmPersistCalibration(rescaledAssets);
}
/* Only writes to Firestore if this outline is already linked+saved (has an
   .id -- see rmSaveOutlineToBuilding()). Calibrating BEFORE the first save
   just updates rmState.outline in memory; the next "Save Outline" tap picks
   up the calibrated ring like any other edit, no separate write needed. */
async function rmPersistCalibration(rescaledAssets){
  var outline = rmState.outline;
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId || !outline.id){
    toast("Recalibrated ✓ — will save with the outline.");
    return;
  }
  if (!fdb){ toast("Recalibrated ✓ — will save with the outline."); return; }
  toast("Saving calibration…");
  try{
    var snap = await fdb.collection("buildings").doc(rmState.linkedBuildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var roof = roofs.find(function(r){ return r.id === rmState.linkedRoofId; });
    if (!roof){ toast("Couldn't find the linked roof to save calibration."); return; }
    roof.roof_outlines = (roof.roof_outlines || []).map(function(o){
      return o.id === outline.id ? Object.assign({}, o, {
        ring: outline.ring, areaSqFt: outline.areaSqFt, perimeterFt: outline.perimeterFt,
        center: outline.center, calibration: outline.calibration
      }) : o;
    });
    if (rescaledAssets) roof.roof_assets = rescaledAssets;
    var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
    roofs[roofIdx] = roof;
    await saveBuildingRoofs(rmState.linkedBuildingId, roofs);
    toast("Recalibrated and saved ✓");
  }catch(e){ toast("Recalibrated on screen, but couldn't save: " + e.message); }
}
/* ---- Square Up (Mark's ask) -- manual button, with undo. Recommended
   flow: trace -> Square Up (fixes shape/angles) -> Calibrate (fixes true
   scale off one now-clean edge, run LAST so whatever edge gets calibrated
   reflects its final post-square length regardless of what squaring did
   upstream). Not automatic on every trace -- an intentionally irregular
   roof should never get altered without Mark asking for it. See "Square
   Up" in DEV_NOTES.md. */
function rmSquareUpOutline(){
  var outline = rmState.outline;
  if (!outline) return;
  var result = rmGeomComputeSquaredRing(outline.ring);
  if (!result){
    toast("Nothing to square up — no edges are close enough to 90°/axis-aligned.");
    return;
  }
  rmState.preSquareRing = outline.ring; /* for Undo -- one level, matches Calibrate's own no-history-stack simplicity */
  outline.ring = result.ring;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(result.ring) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(result.ring) * 3.28084;
  outline.center = rmGeomRingCentroid(result.ring);
  outline.squared = { at: Date.now(), tolerance: RM_SQUARE_TOLERANCE_DEG, snappedEdges: result.snappedCount };
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(result.ring.map(function(p){ return [p.lat, p.lng]; }));
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  document.getElementById("rm-undo-square-btn").style.display = "";
  var msg = "Squared " + result.snappedCount + " edge" + (result.snappedCount === 1 ? "" : "s") +
    (result.curveEdgeCount ? " — " + result.curveEdgeCount + " curved/arc edge" + (result.curveEdgeCount === 1 ? "" : "s") + " left as traced" : "") + ".";
  document.getElementById("rm-square-status").textContent = msg;
  toast("Square Up applied ✓");
  rmPersistOutlineGeometryEdit();
}
function rmUndoSquareUp(){
  var outline = rmState.outline;
  if (!outline || !rmState.preSquareRing) return;
  outline.ring = rmState.preSquareRing;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(outline.ring) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(outline.ring) * 3.28084;
  outline.center = rmGeomRingCentroid(outline.ring);
  delete outline.squared;
  rmState.preSquareRing = null;
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(outline.ring.map(function(p){ return [p.lat, p.lng]; }));
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  document.getElementById("rm-undo-square-btn").style.display = "none";
  document.getElementById("rm-square-status").textContent = "";
  toast("Square Up undone ✓");
  rmPersistOutlineGeometryEdit();
}
/* Same "only writes if already saved" pattern as rmPersistCalibration() --
   editing an unsaved outline just updates rmState.outline in memory, the
   next Save Outline tap picks it up like any other edit. Deliberately does
   NOT touch roof_assets -- unlike calibration's uniform scale-about-
   centroid (a well-defined transform to also apply to placed features),
   both Square Up and Re-Snap to Neighbors move vertices non-uniformly, so
   there's no unambiguous way to carry that onto point features without
   real risk of misplacing them. Shared by rmSquareUpOutline()/
   rmUndoSquareUp() above and rmSnapExistingOutlineToNeighbors()/
   rmUndoResnapToNeighbors() below -- both are "edit the current outline's
   ring, then persist it" in exactly the same shape, only the geometry
   computation differs. */
async function rmPersistOutlineGeometryEdit(){
  var outline = rmState.outline;
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId || !outline.id){
    toast("Will save with the outline.");
    return;
  }
  if (!fdb){ toast("Will save with the outline."); return; }
  try{
    var snap = await fdb.collection("buildings").doc(rmState.linkedBuildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var roof = roofs.find(function(r){ return r.id === rmState.linkedRoofId; });
    if (!roof){ toast("Couldn't find the linked roof to save."); return; }
    roof.roof_outlines = (roof.roof_outlines || []).map(function(o){
      return o.id === outline.id ? Object.assign({}, o, {
        ring: outline.ring, areaSqFt: outline.areaSqFt, perimeterFt: outline.perimeterFt,
        center: outline.center, squared: outline.squared || null
      }) : o;
    });
    var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
    roofs[roofIdx] = roof;
    await saveBuildingRoofs(rmState.linkedBuildingId, roofs);
  }catch(e){ toast("Updated on screen, but couldn't save: " + e.message); }
}
/* Mark's "can an EXISTING badly-traced roof be cleaned up in place?" ask
   (11 roofs at Tri-Delta with sliver gaps/overlaps between adjoining
   sections, traced before vertex snapping shipped). Square Up above
   already applies to a REOPENED roof with zero new code -- it just
   operates on whatever rmState.outline currently holds, new trace or
   reopened save alike -- but it only fixes a roof's OWN angles, not gaps
   against its neighbors. This is the other half: checks every corner of
   the roof currently open against every neighboring roof's already-traced
   corners (rmState.referenceRings -- populated for a reopened roof by
   rmOpenRoofInMapper()'s rmDrawReferenceRoofs() call, same reference layer
   live tracing already draws) and snaps whichever are close enough.

   Deliberately scoped to the ONE roof currently open, never a blind
   whole-building batch -- Mark reopens each of the 11, runs this, reviews
   the result (or Undoes it), moves to the next. Deliberately real-world
   METERS, not rmFindSnapTarget()'s screen PIXELS -- a one-shot batch pass
   has no single "current zoom" to anchor a pixel threshold to, so this
   reuses the same meters-based geometry rmDistanceToRingMeters() already
   uses elsewhere in this file. Same "apply, then offer one-level Undo"
   pattern as Square Up. See "Re-snap existing roof to neighbors" in
   DEV_NOTES.md. */
var RM_RESNAP_METERS = 2; /* Tight on purpose -- this answers "is this
   probably the SAME corner, just hand-traced with a bit of drift," not
   "which roof is this GPS point on" (RM_GPS_AMBIGUITY_METERS is 3x looser
   and answers that different question). A vertex farther than this from
   every neighbor is more likely a real, intentional jog in the roofline
   than the same point -- left alone rather than guessed at, same
   "flag/skip rather than silently guess" spirit as the GPS auto-assign
   work. */
function rmSnapExistingOutlineToNeighbors(){
  var outline = rmState.outline;
  if (!outline) return;
  if (!rmState.referenceRings.length){
    toast("No neighboring roofs on this building to snap to.");
    return;
  }
  var ring = outline.ring;
  var n = ring.length - 1; /* ring is closed: ring[n] === ring[0] */
  var newRing = ring.map(function(p){ return { lat: p.lat, lng: p.lng }; });
  var movedCount = 0;
  for (var i = 0; i < n; i++){
    var pt = ring[i];
    var best = null, bestDist = RM_RESNAP_METERS;
    rmState.referenceRings.forEach(function(refRing){
      for (var j = 0; j < refRing.length - 1; j++){
        var c = refRing[j];
        var local = rmGeomToLocalXY(c, pt);
        var dist = Math.sqrt(local.x * local.x + local.y * local.y);
        if (dist < bestDist){ bestDist = dist; best = c; }
      }
    });
    if (best && (best.lat !== pt.lat || best.lng !== pt.lng)){
      newRing[i] = { lat: best.lat, lng: best.lng };
      if (i === 0) newRing[n] = { lat: best.lat, lng: best.lng }; /* keep the ring explicitly closed */
      movedCount++;
    }
  }
  if (!movedCount){
    toast("Checked every corner against neighboring roofs — nothing within " + RM_RESNAP_METERS + "m to snap.");
    return;
  }
  rmState.preResnapRing = ring; /* one-level Undo, same simplicity as Square Up/Calibrate */
  outline.ring = newRing;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(newRing) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(newRing) * 3.28084;
  outline.center = rmGeomRingCentroid(newRing);
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(newRing.map(function(p){ return [p.lat, p.lng]; }));
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  document.getElementById("rm-undo-resnap-btn").style.display = "";
  document.getElementById("rm-resnap-status").textContent =
    "Snapped " + movedCount + " corner" + (movedCount === 1 ? "" : "s") + " to a neighboring roof's traced edge.";
  toast("Re-Snap to Neighbors applied ✓");
  rmPersistOutlineGeometryEdit();
}
function rmUndoResnapToNeighbors(){
  var outline = rmState.outline;
  if (!outline || !rmState.preResnapRing) return;
  outline.ring = rmState.preResnapRing;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(outline.ring) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(outline.ring) * 3.28084;
  outline.center = rmGeomRingCentroid(outline.ring);
  rmState.preResnapRing = null;
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(outline.ring.map(function(p){ return [p.lat, p.lng]; }));
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  document.getElementById("rm-undo-resnap-btn").style.display = "none";
  document.getElementById("rm-resnap-status").textContent = "";
  toast("Re-Snap to Neighbors undone ✓");
  rmPersistOutlineGeometryEdit();
}
/* ---- Whole-outline alignment (translate/rotate/scale as one unit) ----
   Mark's real Tri-Delta case: traced a building's outline on satellite
   (which commonly has several METRES of registration error), then
   uploaded his georeferenced RTK orthomosaic (centimetre-accurate -- the
   ortho is right, the satellite trace is wrong). The offset between the
   two is usually a near-uniform shift, so dragging the WHOLE outline once
   gets him ~90% aligned; individual-vertex Edit Shape (already usable on
   a reopened outline -- see the empty state of rmEnterVertexEdit(), no
   ortho-blocking condition anywhere in it) finishes the last few corners.
   Without this he'd be dragging 20 vertices one at a time across the same
   offset.

   Three transforms, composed together and reapplied to the ORIGINAL ring
   captured at align-mode entry (never applied cumulatively/incrementally,
   which would drift with rounding over many small drags) -- current state
   is always "originalRing rotated by angle, scaled by scale, both around
   origin, then translated by translateOffset":
   - translate: pure shift, preserves every distance/angle/area exactly --
     never "corrupts" a measurement, same reasoning already documented for
     Square Up/Re-Snap moving vertices non-uniformly (this doesn't).
   - rotate: also preserves every distance/area exactly, just orientation
     changes.
   - scale: the one transform that DOES change dimensions -- deliberately
     optional, a tech choosing to resize, not an accident. With a
     georeferenced ortho the true scale already comes from the ortho's own
     geodata (see "GeoTIFF georeferenced ortho support"/rmOpenRoofInMapper's
     drone_ortho branch), so scale is rarely needed there; it matters more
     for the older flattened/non-georeferenced ortho path where the
     meters-per-pixel is a guess (RM_ORTHO_METERS_PER_PIXEL_GUESS).

   Math done in a local meters-from-centroid frame (rmGeomToLocalXY/
   rmGeomFromLocalXY, the same flat-earth-at-building-scale approximation
   already used throughout this file), not naively in lat/lng degrees,
   which distort non-uniformly with latitude and would skew the shape.
   Works identically whether the outline is a fresh trace or reopened from
   Building History with an ortho attached (rmOpenRoofInMapper()) -- this
   only ever touches rmState.outline/rmState.map, the exact same state
   Square Up/vertex-edit already operate on regardless of how it got
   there. See "Whole-outline alignment" in DEV_NOTES.md. */
var rmAlignState = {
  active: false, originalRing: null, origin: null, handleDist: 0,
  translateOffset: { dLat: 0, dLng: 0 }, angle: 0, scale: 1,
  moveMarker: null, rotateMarker: null, scaleMarker: null
};
function rmToggleAlignMode(){
  if (rmAlignState.active) rmExitAlignMode(true);
  else rmEnterAlignMode();
}
function rmEnterAlignMode(){
  var outline = rmState.outline;
  if (!outline || !rmState.map) return;
  if (rmState.vertexEditActive) rmExitVertexEdit(false); /* two edit modes fighting over the same ring is asking for trouble, same guard Edit Shape already uses against Square Up */
  rmAlignState.active = true;
  rmAlignState.originalRing = outline.ring.map(function(p){ return { lat: p.lat, lng: p.lng }; });
  rmAlignState.origin = outline.center || rmGeomRingCentroid(outline.ring);
  rmAlignState.translateOffset = { dLat: 0, dLng: 0 };
  rmAlignState.angle = 0;
  rmAlignState.scale = 1;
  /* Handle distance from centroid: a bit beyond the ring's own farthest
     corner, so the rotate/scale handles sit clear of the shape itself
     instead of overlapping it. */
  var maxDist = 0;
  rmAlignState.originalRing.forEach(function(p){
    var xy = rmGeomToLocalXY(p, rmAlignState.origin);
    var d = Math.sqrt(xy.x * xy.x + xy.y * xy.y);
    if (d > maxDist) maxDist = d;
  });
  rmAlignState.handleDist = Math.max(maxDist * 1.3, 5); /* 5m floor so a tiny roof still gets usable, separated handles */

  document.getElementById("rm-edit-shape-btn").disabled = true;
  document.getElementById("rm-square-up-btn").disabled = true;
  document.getElementById("rm-resnap-btn").disabled = true;
  document.getElementById("rm-align-btn").textContent = "✓ Done Aligning";
  document.getElementById("rm-align-hint").style.display = "";

  var moveIcon = L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: '<div style="width:22px;height:22px;border-radius:50%;background:#E8600A;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>' });
  var rotateIcon = L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11],
    html: '<div style="width:18px;height:18px;border-radius:50%;background:#1976D2;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>' });
  var scaleIcon = L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11],
    html: '<div style="width:18px;height:18px;border-radius:3px;background:#2E7D32;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>' });

  rmAlignState.moveMarker = L.marker([rmAlignState.origin.lat, rmAlignState.origin.lng], { draggable: true, icon: moveIcon }).addTo(rmState.map);
  var rotateStart = rmGeomFromLocalXY({ x: 0, y: rmAlignState.handleDist }, rmAlignState.origin); /* due north of centroid */
  rmAlignState.rotateMarker = L.marker([rotateStart.lat, rotateStart.lng], { draggable: true, icon: rotateIcon }).addTo(rmState.map);
  var scaleStart = rmGeomFromLocalXY({ x: rmAlignState.handleDist, y: 0 }, rmAlignState.origin); /* due east of centroid */
  rmAlignState.scaleMarker = L.marker([scaleStart.lat, scaleStart.lng], { draggable: true, icon: scaleIcon }).addTo(rmState.map);

  rmAlignState.moveMarker.on("drag", function(e){ rmApplyAlignFromMove(e.target.getLatLng()); });
  rmAlignState.moveMarker.on("dragend", rmFinalizeAlignTransform);
  rmAlignState.rotateMarker.on("drag", function(e){ rmApplyAlignFromRotate(e.target.getLatLng()); });
  rmAlignState.rotateMarker.on("dragend", rmFinalizeAlignTransform);
  rmAlignState.scaleMarker.on("drag", function(e){ rmApplyAlignFromScale(e.target.getLatLng()); });
  rmAlignState.scaleMarker.on("dragend", rmFinalizeAlignTransform);
}
/* Recomputes the ring from originalRing + the current
   {translateOffset, angle, scale} and pushes it onto the live polygon --
   called on every drag frame of any of the three handles for immediate
   visual feedback, cheap enough (a handful of points) to run continuously. */
function rmRecomputeAlignedRing(){
  var rotatedScaled = rmRotateScaleRing(rmAlignState.originalRing, rmAlignState.origin, rmAlignState.angle, rmAlignState.scale);
  var ring = rmTranslateRing(rotatedScaled, rmAlignState.translateOffset.dLat, rmAlignState.translateOffset.dLng);
  rmState.outline.ring = ring;
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(ring.map(function(p){ return [p.lat, p.lng]; }));
  return ring;
}
/* rmRotateScaleRing() above only knows how to rotate/scale points that are
   already real ring points (it re-derives their local offset from origin
   itself), which doesn't work for repositioning the handles at their own
   FIXED local offsets -- this is that same rotate/scale math applied
   directly to an arbitrary local {x,y} offset instead of a lat/lng point. */
function rmRotateScaleLocalPoint(localX, localY, origin, angleRad, scaleFactor){
  var cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  var sx = localX * scaleFactor, sy = localY * scaleFactor;
  var rx = sx * cos - sy * sin, ry = sx * sin + sy * cos;
  return rmGeomFromLocalXY({ x: rx, y: ry }, origin);
}
/* The rotate/scale handles orbit the shape's CURRENT centroid at their own
   fixed local offset (0,handleDist) / (handleDist,0) from origin,
   transformed by the same angle/scale/translate as the ring itself, so
   they visually stay attached to the shape as it moves/rotates/resizes
   instead of drifting away from it. */
function rmRepositionAlignHandles(){
  var newCenter = { lat: rmAlignState.origin.lat + rmAlignState.translateOffset.dLat, lng: rmAlignState.origin.lng + rmAlignState.translateOffset.dLng };
  if (rmAlignState.moveMarker) rmAlignState.moveMarker.setLatLng([newCenter.lat, newCenter.lng]);
  if (rmAlignState.rotateMarker){
    var rp = rmRotateScaleLocalPoint(0, rmAlignState.handleDist, rmAlignState.origin, rmAlignState.angle, rmAlignState.scale);
    rmAlignState.rotateMarker.setLatLng([rp.lat + rmAlignState.translateOffset.dLat, rp.lng + rmAlignState.translateOffset.dLng]);
  }
  if (rmAlignState.scaleMarker){
    var sp = rmRotateScaleLocalPoint(rmAlignState.handleDist, 0, rmAlignState.origin, rmAlignState.angle, rmAlignState.scale);
    rmAlignState.scaleMarker.setLatLng([sp.lat + rmAlignState.translateOffset.dLat, sp.lng + rmAlignState.translateOffset.dLng]);
  }
}
function rmApplyAlignFromMove(newLatLng){
  rmAlignState.translateOffset = { dLat: newLatLng.lat - rmAlignState.origin.lat, dLng: newLatLng.lng - rmAlignState.origin.lng };
  rmRecomputeAlignedRing();
  rmRepositionAlignHandles();
}
function rmApplyAlignFromRotate(newLatLng){
  /* The handle's CURRENT position (undoing the current translate, since
     angle is defined relative to the untranslated origin) directly gives
     the new absolute angle -- not a cumulative delta, so repeated small
     drags never drift/compound rounding error. */
  var untranslated = { lat: newLatLng.lat - rmAlignState.translateOffset.dLat, lng: newLatLng.lng - rmAlignState.translateOffset.dLng };
  var xy = rmGeomToLocalXY(untranslated, rmAlignState.origin);
  rmAlignState.angle = Math.atan2(xy.x, xy.y); /* angle from north (matches how the handle starts due north at angle 0) */
  rmRecomputeAlignedRing();
  rmRepositionAlignHandles();
}
function rmApplyAlignFromScale(newLatLng){
  var untranslated = { lat: newLatLng.lat - rmAlignState.translateOffset.dLat, lng: newLatLng.lng - rmAlignState.translateOffset.dLng };
  var xy = rmGeomToLocalXY(untranslated, rmAlignState.origin);
  var dist = Math.sqrt(xy.x * xy.x + xy.y * xy.y);
  rmAlignState.scale = Math.max(0.1, dist / rmAlignState.handleDist); /* floor so a wild drag can't collapse the shape to nothing */
  rmRecomputeAlignedRing();
  rmRepositionAlignHandles();
}
function rmFinalizeAlignTransform(){
  var outline = rmState.outline;
  if (!outline) return;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(outline.ring) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(outline.ring) * 3.28084;
  outline.center = rmGeomRingCentroid(outline.ring);
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  var moved = rmAlignState.translateOffset.dLat !== 0 || rmAlignState.translateOffset.dLng !== 0 ||
    rmAlignState.angle !== 0 || rmAlignState.scale !== 1;
  document.getElementById("rm-align-status").textContent = moved ?
    "Outline " + (rmAlignState.translateOffset.dLat !== 0 || rmAlignState.translateOffset.dLng !== 0 ? "moved" : "") +
    (rmAlignState.angle !== 0 ? (rmAlignState.translateOffset.dLat !== 0 ? ", rotated" : "rotated") : "") +
    (rmAlignState.scale !== 1 ? ((rmAlignState.translateOffset.dLat !== 0 || rmAlignState.angle !== 0) ? ", resized" : "resized") : "") + "." :
    "";
}
function rmExitAlignMode(persist){
  if (!rmAlignState.active) return;
  var outline = rmState.outline;
  var moved = rmAlignState.translateOffset.dLat !== 0 || rmAlignState.translateOffset.dLng !== 0 ||
    rmAlignState.angle !== 0 || rmAlignState.scale !== 1;
  rmAlignState.active = false;
  document.getElementById("rm-edit-shape-btn").disabled = false;
  document.getElementById("rm-square-up-btn").disabled = false;
  document.getElementById("rm-resnap-btn").disabled = false;
  document.getElementById("rm-align-btn").textContent = "↔️ Move/Rotate/Scale Outline";
  document.getElementById("rm-align-hint").style.display = "none";
  if (rmState.map){
    if (rmAlignState.moveMarker) rmState.map.removeLayer(rmAlignState.moveMarker);
    if (rmAlignState.rotateMarker) rmState.map.removeLayer(rmAlignState.rotateMarker);
    if (rmAlignState.scaleMarker) rmState.map.removeLayer(rmAlignState.scaleMarker);
  }
  rmAlignState.moveMarker = null; rmAlignState.rotateMarker = null; rmAlignState.scaleMarker = null;
  if (persist && moved && outline){
    /* A transform invalidates any prior "square"/"calibrated" guarantee,
       same reasoning already applied to a manual vertex drag -- and drops
       the Square Up/Re-Snap undo snapshots for the same reason ("undo"
       against a ring that's since moved wouldn't mean what it used to). */
    delete outline.squared;
    delete outline.calibration;
    rmState.preSquareRing = null;
    document.getElementById("rm-undo-square-btn").style.display = "none";
    rmState.preResnapRing = null;
    document.getElementById("rm-undo-resnap-btn").style.display = "none";
    rmState.preAlignRing = rmAlignState.originalRing;
    document.getElementById("rm-undo-align-btn").style.display = "";
    toast("Outline aligned ✓");
    rmPersistOutlineGeometryEdit();
  } else if (!persist && outline && rmAlignState.originalRing){
    /* Cancel path (rmClearGeneratedOutline() etc. calling this with
       persist=false) -- discard whatever was mid-drag, restore exactly
       what was there before align mode started. */
    outline.ring = rmAlignState.originalRing;
    outline.areaSqFt = rmGeomPolygonAreaSqMeters(outline.ring) * 10.7639;
    outline.perimeterFt = rmGeomPolygonPerimeterMeters(outline.ring) * 3.28084;
    outline.center = rmGeomRingCentroid(outline.ring);
    if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(outline.ring.map(function(p){ return [p.lat, p.lng]; }));
    rmDrawEdgeDimensions(outline);
    rmRenderOutlineStats(outline);
  }
  rmAlignState.originalRing = null;
  document.getElementById("rm-align-status").textContent = "";
}
function rmUndoAlign(){
  var outline = rmState.outline;
  if (!outline || !rmState.preAlignRing) return;
  outline.ring = rmState.preAlignRing;
  outline.areaSqFt = rmGeomPolygonAreaSqMeters(outline.ring) * 10.7639;
  outline.perimeterFt = rmGeomPolygonPerimeterMeters(outline.ring) * 3.28084;
  outline.center = rmGeomRingCentroid(outline.ring);
  rmState.preAlignRing = null;
  if (rmState.outlineLayer) rmState.outlineLayer.setLatLngs(outline.ring.map(function(p){ return [p.lat, p.lng]; }));
  rmDrawEdgeDimensions(outline);
  rmRenderOutlineStats(outline);
  rmUpdateExportHint();
  document.getElementById("rm-undo-align-btn").style.display = "none";
  toast("Alignment undone ✓");
  rmPersistOutlineGeometryEdit();
}
function rmTranslateRing(ring, dLat, dLng){
  return ring.map(function(p){ return { lat: p.lat + dLat, lng: p.lng + dLng }; });
}
function rmRotateScaleRing(ring, origin, angleRad, scaleFactor){
  return ring.map(function(p){
    var xy = rmGeomToLocalXY(p, origin);
    var r = rmRotateScaleLocalPoint(xy.x, xy.y, origin, angleRad, scaleFactor);
    return r;
  });
}
function rmGenerateOutline(){
  var fp = rmState.footprints.find(function(f){ return f.id === rmState.selectedId; });
  if (!fp) return;
  var ring = rmGeomCleanRing(fp.ring);
  var outline = {
    ring: ring,
    center: fp.center,
    areaSqFt: rmGeomPolygonAreaSqMeters(ring) * 10.7639,
    perimeterFt: rmGeomPolygonPerimeterMeters(ring) * 3.28084,
    source: "osm",
    osmId: fp.id,
    osmType: fp.osmType,
    tags: fp.tags || {},
    isSiteBoundary: !!fp.isSite,
    createdAt: Date.now()
  };
  rmDrawFinalOutline(outline);
  toast(outline.isSiteBoundary ? "Site boundary captured — not a single roof, see warning below ⚠️" : "Roof outline generated ✓");
}

/* ---- Phase 3: manual trace + walk-the-corners (no OSM footprint needed) ----
   Two capture methods, one shared point-collection engine. rmTraceState.mode
   ("manual" | "walk") is the only thing that differs: manual trace collects
   points from map taps (satellite view, auto-switched); walk-the-corners
   collects points from navigator.geolocation each time the tech physically
   stands at a corner and taps Record -- no map-click handler at all, since
   the tech is looking at the roof, not necessarily the screen. Both produce
   the exact same rmState.outline shape as the OSM path (just a different
   `source` tag, no tags/osmId since there's no OSM feature behind either),
   so everything downstream -- save, export, inline feature placement --
   works completely unchanged regardless of which method captured it. */
var rmTraceState = { active: false, mode: "manual", points: [], previewLayer: null, vertexLayers: [] };
var rmTraceClickHandler = null;
/* Precision cursor (Mark: "big HAND cursor... as accurate as possible")
   -- toggles the crosshair CSS + fixed center reticle (see the
   #rm-map-wrap.rm-precision-active rules and .rm-crosshair-reticle in the
   stylesheet) on for the duration of placing/tracing/editing a vertex.
   Applies uniformly to trace, vertex-edit, and feature placement; the
   "⊕ Place at Crosshair" quick-action button (rmPlaceAtCrosshair()) is
   trace-specific -- vertex-edit is drag-based (you already see the handle
   move) and feature placement already has its own click-to-reposition, so
   the cursor/reticle alone covers those two without a redundant button.
   See "Precision cursor" in DEV_NOTES.md. */
function rmSetPrecisionMode(active){
  var wrap = document.getElementById("rm-map-wrap");
  if (wrap) wrap.classList.toggle("rm-precision-active", !!active);
  var btn = document.getElementById("rm-place-crosshair-btn");
  if (btn) btn.style.display = active ? "" : "none";
}
function rmPlaceAtCrosshair(){
  if (!rmState.map || !rmTraceState.active) return;
  rmTraceAddPoint(rmState.map.getCenter());
}
function rmShowTracePanel(){
  document.getElementById("rm-footprint-panel").style.display = "none";
  var isWalk = rmTraceState.mode === "walk";
  document.getElementById("rm-trace-title").textContent = isWalk ? "Walk the Corners" : "Trace Roof Outline";
  document.getElementById("rm-trace-mode-hint").textContent = isWalk ?
    "Walk to each corner of the roof and tap “📍 Record This Corner” there. Consumer GPS is " +
    "accurate to roughly ±10–30 ft per corner — good for a rough, adjustable footprint when " +
    "satellite/OSM aren’t usable here, not survey-grade. Undo and re-record a corner if a reading looks off." :
    "Tap the roof's corners in order, all the way around, right on the satellite map above.";
  document.getElementById("rm-walk-record-btn").style.display = isWalk ? "" : "none";
  /* Crosshair/reticle + "Place at Crosshair" only apply to map-tap tracing
     -- walk-corners points come from an actual GPS fix at the tech's
     physical position, not a map tap, so there's nothing on the map to
     aim a crosshair at. */
  rmSetPrecisionMode(!isWalk);
  rmUpdateTraceButtons();
  rmUpdateControlVisibility(); /* shows #rm-trace-panel (rmTraceState.active is already true here), hides search buttons */
  document.getElementById("rm-trace-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function rmStartManualTrace(){
  rmClearFootprintLayers(); /* same clean-slate as starting a new search */
  rmTraceState.active = true;
  rmTraceState.mode = "manual";
  rmTraceState.points = [];
  rmSetBaseLayer("satellite");
  var map = rmEnsureMap();
  rmTraceClickHandler = function(e){ rmTraceAddPoint(e.latlng); };
  map.on("click", rmTraceClickHandler);
  if (rmState.lat != null) map.setView([rmState.lat, rmState.lng], 20);
  rmSetStatus("Tracing manually — tap the roof's corners in order below, then Finish Outline.");
  rmShowTracePanel();
}
/* ---- Trace on your own drone image (Finding A) ----
   Mark: "no way to use my orthomosaic as the base for roof tracing" --
   drone orthos are far sharper than satellite, and tracing on them is the
   whole point of flying them. Primary path is a local upload (no
   CompanyCam project required first); pulling one FROM an already-linked
   CompanyCam project is a separate, later piece.

   Architecture: a plain exported ortho (JPG/PNG) carries no geodata, so
   this does NOT attempt real georeferencing. Instead it reuses the SAME
   map/trace/Square-Up/vertex-edit/Calibrate pipeline everything else in
   RoofMapper already uses, just anchored at a fixed SYNTHETIC origin
   (0,0 -- "Null Island," a deliberately obvious non-real GIS convention)
   with a guessed initial pixels-per-meter scale. That works because the
   whole outline pipeline already computes in LOCAL METERS relative to a
   centroid (rmGeomToLocalXY/rmGeomFromLocalXY), not real-world lat/lng
   directly -- it doesn't care whether the origin is a real GPS fix or a
   synthetic anchor. The shape/angles/proportions traced are exactly
   correct from the start; only the ABSOLUTE scale is a guess until
   Calibrate (tap an edge, enter its real measured length) fixes it --
   exactly the "flat canvas + calibrate" path Mark asked for. See "Ortho
   upload + flat-canvas tracing" in DEV_NOTES.md. */
var RM_ORTHO_MAX_DIM = 3200; /* sharper than the 2000px cap used for hand-drawn
  roof_plan/sketch base maps -- ortho sharpness is the entire point of this
  feature -- but still bounded to stay well under CompanyCam's ~30MB upload
  cap and a safe margin under typical serverless function payload limits.
  Tunable; flagged as a real constraint, not a hard technical ceiling, in
  DEV_NOTES.md. */
var RM_ORTHO_QUALITY = 0.82;
var RM_ORTHO_ORIGIN = { lat: 0, lng: 0 };
var RM_ORTHO_METERS_PER_PIXEL_GUESS = 0.05; /* arbitrary -- only affects the
  shape's initial on-screen size before Calibrate corrects it to a real
  measurement; never affects final accuracy. */
/* Shared by both ortho paths -- local file upload (rmLoadAndResizeOrtho,
   below) and picking an existing CompanyCam photo (rmSelectCcOrthoPhoto)
   both end up with a data URL one way or another and just need it resized
   the same way before rmStartOrthoTrace(). */
function rmResizeDataUrlToOrtho(dataUrl, maxDim, quality){
  return new Promise(function(res, rej){
    var img = new Image();
    img.onload = function(){
      var w = img.width, h = img.height;
      if (w > maxDim || h > maxDim){
        if (w >= h){ h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      res({ dataUrl: c.toDataURL("image/jpeg", quality), w: w, h: h });
    };
    img.onerror = function(){ rej(new Error("Couldn't read the image")); };
    img.src = dataUrl;
  });
}
function rmLoadAndResizeOrtho(file, maxDim, quality){
  return new Promise(function(res, rej){
    var reader = new FileReader();
    reader.onload = function(){ rmResizeDataUrlToOrtho(reader.result, maxDim, quality).then(res, rej); };
    reader.onerror = function(){ rej(new Error("Couldn't read the file")); };
    reader.readAsDataURL(file);
  });
}
/* Georeferenced GeoTIFF flagged as a real (not hard) constraint per
   Mark's ask -- full-res WebODM orthos can be large, and the whole file
   has to land in the browser's memory as an ArrayBuffer regardless (a
   local file upload, unlike a COG served over HTTP, has no URL to
   range-request against for true streaming). Rather than silently
   attempt a huge file and risk the tab running out of memory (worse on a
   phone), a clear size cap with an explicit explanation and a fallback
   suggestion. Tunable; see "GeoTIFF georeferenced ortho support" in
   DEV_NOTES.md for the full reasoning and what true COG-tile-streaming
   would take if this cap becomes a real practical problem. */
var RM_GEOTIFF_MAX_BYTES = 120 * 1024 * 1024;
/* Returns a parsed `georaster` object if arrayBuffer is a valid GeoTIFF
   with usable embedded geodata (either a Geographic — plain lat/lng — or
   Projected — e.g. UTM, what WebODM/RTK output actually uses — CRS), or
   null for anything else (not a TIFF at all, e.g. a plain JPG/PNG; or a
   TIFF with no geo tags at all, e.g. a hand-exported flattened image).
   Never throws -- every failure mode just means "fall back to the flat-
   canvas path," never a hard error. Reprojection from a projected CRS
   (UTM etc.) to the lat/lng GeoRasterLayer needs for Leaflet is handled
   internally by georaster-layer-for-leaflet itself -- verified directly
   (not assumed) by round-tripping a synthetic UTM-zone-15N GeoTIFF
   through this exact pipeline before building on it; see DEV_NOTES.md. */
async function rmTryParseGeoreferencedTiff(arrayBuffer){
  try{
    var tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    var image = await tiff.getImage();
    var geoKeys = image.getGeoKeys ? image.getGeoKeys() : null;
    if (!geoKeys || (!geoKeys.GeographicTypeGeoKey && !geoKeys.ProjectedCSTypeGeoKey)) return null;
    /* Caught in testing: some TIFF-writing tools (including the geotiff.js
       library used to build the test fixtures for this exact feature)
       inject a DEFAULT WGS84 GeographicTypeGeoKey even when no real geo
       metadata was ever supplied -- geoKeys alone being present isn't
       proof of REAL geodata. The telltale sign of a meaningless default
       is a bounding box spanning most/all of the planet -- a drone photo
       of a roof is at most a few hundred meters across (a small fraction
       of a degree), never anywhere close to a full degree of latitude or
       longitude. Reject anything that implausible as "not really
       georeferenced" and fall back to the flat-canvas path instead of
       trusting a bogus placeholder location. */
    var bbox = image.getBoundingBox ? image.getBoundingBox() : null;
    if (!bbox || bbox.length !== 4) return null;
    var isProjected = !!geoKeys.ProjectedCSTypeGeoKey;
    var spanX = Math.abs(bbox[2] - bbox[0]), spanY = Math.abs(bbox[3] - bbox[1]);
    var maxPlausibleSpan = isProjected ? 20000 : 1; /* meters for a projected CRS, degrees for geographic */
    if (spanX > maxPlausibleSpan || spanY > maxPlausibleSpan) return null;
    return await parseGeoraster(arrayBuffer);
  }catch(e){
    return null;
  }
}
function rmClearGeoTiffLayer(){
  if (rmState.map && rmState.geoTiffLayer) rmState.map.removeLayer(rmState.geoTiffLayer);
  rmState.geoTiffLayer = null;
  rmState.geoTiffActive = false;
  rmUpdateMapZoomCap();
}
function rmClearKmlOverlay(){
  if (rmState.map && rmState.kmlOverlayLayer) rmState.map.removeLayer(rmState.kmlOverlayLayer);
  rmState.kmlOverlayLayer = null;
  rmState.kmlOverlayActive = false;
  rmState.kmlOverlayDataUrl = null;
  rmState.kmlOverlayMeta = null;
  rmUpdateMapZoomCap();
}
/* Starts a trace session directly on a rendered, correctly-georeferenced
   GeoTIFF -- deliberately much simpler than rmStartOrthoTrace() (the
   flat-canvas/synthetic-origin path): the layer is already positioned at
   its TRUE geographic bounds, so every map click during this trace is
   already real, accurate lat/lng -- no synthetic origin, no meters-per-
   pixel guess, nothing to Calibrate. */
function rmStartGeoTiffTrace(georaster){
  var map = rmEnsureMap();
  rmClearFootprintLayers(); /* same clean-slate as any other fresh capture start */
  rmState.geoTiffLayer = new GeoRasterLayer({ georaster: georaster, resolution: 128 }).addTo(map);
  rmState.geoTiffActive = true;
  rmUpdateMapZoomCap();
  var bounds = rmState.geoTiffLayer.getBounds();
  map.fitBounds(bounds);
  var center = bounds.getCenter();
  rmState.lat = center.lat; rmState.lng = center.lng; rmState.accuracy = null;
  rmTraceState.active = true;
  rmTraceState.mode = "manual";
  rmTraceState.points = [];
  rmTraceClickHandler = function(e){ rmTraceAddPoint(e.latlng); };
  map.on("click", rmTraceClickHandler);
  rmShowTracePanel();
  document.getElementById("rm-trace-mode-hint").textContent =
    "Tap the roof's corners in order, right on your georeferenced drone image above. Real GPS geodata means the " +
    "shape, position, and scale are all accurate automatically — no calibration step needed.";
  rmSetStatus("✅ Georeferenced (RTK) — scale set automatically, no calibration needed.");
  rmUpdateControlVisibility();
}
function rmFileToDataUrl(file){
  return new Promise(function(res, rej){
    var reader = new FileReader();
    reader.onload = function(){ res(reader.result); };
    reader.onerror = function(){ rej(new Error("Couldn't read the file")); };
    reader.readAsDataURL(file);
  });
}
function rmNormalizeKmlPath(path){
  return String(path || "").replace(/^\.?\//, "").replace(/\\/g, "/");
}
function rmKmlChildText(parent, tagName){
  var el = parent && parent.getElementsByTagName(tagName)[0];
  return el && el.textContent ? el.textContent.trim() : "";
}
function rmKmlElementsByLocalName(parent, localName){
  return Array.prototype.slice.call(parent ? parent.getElementsByTagName("*") : [])
    .filter(function(el){ return el.localName === localName || el.nodeName === localName; });
}
function rmKmlFirstByLocalName(parent, localName){
  return rmKmlElementsByLocalName(parent, localName)[0] || null;
}
function rmKmlParseBoundsFromBox(box){
  if (!box) return null;
  var north = parseFloat(rmKmlChildText(box, "north"));
  var south = parseFloat(rmKmlChildText(box, "south"));
  var east = parseFloat(rmKmlChildText(box, "east"));
  var west = parseFloat(rmKmlChildText(box, "west"));
  if (![north, south, east, west].every(isFinite) || north <= south || east === west) return null;
  return { north: north, south: south, east: east, west: west };
}
function rmKmlParseLatLonQuad(overlay){
  var quad = rmKmlFirstByLocalName(overlay, "LatLonQuad");
  var coordsText = quad ? rmKmlChildText(quad, "coordinates") : "";
  if (!coordsText) return null;
  var points = coordsText.trim().split(/\s+/).map(function(part){
    var bits = part.split(",");
    return { lng: parseFloat(bits[0]), lat: parseFloat(bits[1]) };
  }).filter(function(p){ return isFinite(p.lat) && isFinite(p.lng); });
  if (points.length < 4) return null;
  var lats = points.map(function(p){ return p.lat; });
  var lngs = points.map(function(p){ return p.lng; });
  return {
    quad: points,
    bounds: {
      north: Math.max.apply(null, lats),
      south: Math.min.apply(null, lats),
      east: Math.max.apply(null, lngs),
      west: Math.min.apply(null, lngs)
    }
  };
}
function rmKmlBoundsUnion(boundsList){
  var valid = (boundsList || []).filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce(function(acc, b){
    if (!acc) return Object.assign({}, b);
    return {
      north: Math.max(acc.north, b.north),
      south: Math.min(acc.south, b.south),
      east: Math.max(acc.east, b.east),
      west: Math.min(acc.west, b.west)
    };
  }, null);
}
function rmResolveKmlHref(kmlPath, href){
  var cleanHref = rmNormalizeKmlPath(href);
  if (/^[a-z]+:\/\//i.test(cleanHref) || cleanHref.indexOf("data:") === 0) return cleanHref;
  var base = rmNormalizeKmlPath(kmlPath || "").split("/");
  base.pop();
  cleanHref.split("/").forEach(function(part){
    if (!part || part === ".") return;
    if (part === "..") base.pop();
    else base.push(part);
  });
  return base.join("/");
}
function rmParseKmlGroundOverlays(kmlText, sourceName, kmlPath){
  var doc = new DOMParser().parseFromString(kmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("KML is malformed");
  return Array.prototype.slice.call(doc.getElementsByTagName("GroundOverlay")).map(function(overlay){
    var href = rmNormalizeKmlPath(rmKmlChildText(overlay, "href"));
    if (!href) return null;
    var box = overlay.getElementsByTagName("LatLonBox")[0];
    var bounds = rmKmlParseBoundsFromBox(box);
    var quadInfo = rmKmlParseLatLonQuad(overlay);
    if (!bounds && quadInfo) bounds = quadInfo.bounds;
    if (!bounds) return null;
    var rotationText = box ? rmKmlChildText(box, "rotation") : "";
    var rotation = rotationText ? parseFloat(rotationText) : 0;
    return {
      sourceType: /\.kmz$/i.test(sourceName || "") ? "kmz_groundoverlay" : "kml_groundoverlay",
      sourceFileName: sourceName || "",
      imageHref: href,
      resolvedImageHref: rmResolveKmlHref(kmlPath || "", href),
      imageFileName: href.split("/").pop(),
      name: rmKmlChildText(overlay, "name"),
      bounds: bounds,
      latLonQuad: quadInfo ? quadInfo.quad : null,
      rotation: isFinite(rotation) ? rotation : 0
    };
  }).filter(Boolean);
}
function rmParseKmlGroundOverlay(kmlText, sourceName){
  var overlays = rmParseKmlGroundOverlays(kmlText, sourceName);
  if (!overlays.length) throw new Error("No GroundOverlay found in the KML");
  return overlays[0];
}
function rmImageFileLooksLike(path){
  return /\.(png|jpe?g|webp|gif)$/i.test(path || "");
}
function rmMimeForImagePath(path){
  if (/\.png$/i.test(path || "")) return "image/png";
  if (/\.webp$/i.test(path || "")) return "image/webp";
  if (/\.gif$/i.test(path || "")) return "image/gif";
  return "image/jpeg";
}
async function rmReadKmzImageDataUrl(zip, imageKey){
  var bytes = await zip.files[imageKey].async("uint8array");
  return await rmFileToDataUrl(new Blob([bytes], { type: rmMimeForImagePath(imageKey) }));
}
function rmFindKmzEntry(zip, wantedPath){
  var normalized = rmNormalizeKmlPath(wantedPath);
  var wantedLower = normalized.toLowerCase();
  var wantedBase = wantedLower.split("/").pop();
  var keys = Object.keys(zip.files || {});
  return keys.find(function(k){ return !zip.files[k].dir && rmNormalizeKmlPath(k).toLowerCase() === wantedLower; }) ||
    keys.find(function(k){ return !zip.files[k].dir && rmNormalizeKmlPath(k).toLowerCase().split("/").pop() === wantedBase; }) ||
    keys.find(function(k){ return !zip.files[k].dir && rmImageFileLooksLike(k); });
}
function rmFindPairedImageFile(files, wantedPath){
  var wanted = rmNormalizeKmlPath(wantedPath).toLowerCase();
  var wantedBase = wanted.split("/").pop();
  return files.find(function(f){ return rmNormalizeKmlPath(f.name).toLowerCase() === wanted; }) ||
    files.find(function(f){ return rmNormalizeKmlPath(f.name).toLowerCase().split("/").pop() === wantedBase; }) ||
    files.find(function(f){ return /^image\//i.test(f.type || "") || rmImageFileLooksLike(f.name); });
}
function rmStartKmlGroundOverlayTrace(dataUrl, meta){
  var map = rmEnsureMap();
  rmClearFootprintLayers();
  var b = meta.bounds;
  var bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
  rmState.kmlOverlayLayer = L.imageOverlay(dataUrl, bounds).addTo(map);
  rmState.kmlOverlayActive = true;
  rmState.kmlOverlayDataUrl = dataUrl;
  rmState.kmlOverlayMeta = meta;
  rmUpdateMapZoomCap();
  map.fitBounds(bounds);
  var center = bounds.getCenter();
  rmState.lat = center.lat; rmState.lng = center.lng; rmState.accuracy = null;
  rmTraceState.active = true;
  rmTraceState.mode = "manual";
  rmTraceState.points = [];
  rmTraceClickHandler = function(e){ rmTraceAddPoint(e.latlng); };
  map.on("click", rmTraceClickHandler);
  rmShowTracePanel();
  document.getElementById("rm-trace-mode-hint").textContent =
    "Tap the roof's corners in order, right on the KMZ/KML orthomosaic above. The overlay's KML bounds set the " +
    "starting position and scale; if Mark has a field measurement, calibrate the matching edge after tracing.";
  var msg = "KML GroundOverlay loaded";
  if (meta.imageFileName) msg += " (" + meta.imageFileName + ")";
  msg += " -- trace the roof on the orthomosaic.";
  if (Math.abs(meta.rotation || 0) > 0.001){
    msg += " Note: KML rotation " + meta.rotation + " degrees was detected; Leaflet's image overlay does not rotate it, so verify alignment before saving.";
  }
  rmSetStatus(msg, Math.abs(meta.rotation || 0) > 0.001 ? "warn" : null);
  rmUpdateControlVisibility();
}
function rmStartKmlSuperOverlayTrace(tiles, meta){
  var map = rmEnsureMap();
  rmClearFootprintLayers();
  var group = L.layerGroup().addTo(map);
  tiles.forEach(function(tile){
    var b = tile.meta.bounds;
    L.imageOverlay(tile.dataUrl, [[b.south, b.west], [b.north, b.east]]).addTo(group);
  });
  rmState.kmlOverlayLayer = group;
  rmState.kmlOverlayActive = true;
  rmState.kmlOverlayDataUrl = meta.persistDataUrl || null;
  delete meta.persistDataUrl;
  rmState.kmlOverlayMeta = meta;
  rmUpdateMapZoomCap();
  var bAll = meta.bounds;
  var bounds = L.latLngBounds([bAll.south, bAll.west], [bAll.north, bAll.east]);
  map.fitBounds(bounds);
  var center = bounds.getCenter();
  rmState.lat = center.lat; rmState.lng = center.lng; rmState.accuracy = null;
  rmTraceState.active = true;
  rmTraceState.mode = "manual";
  rmTraceState.points = [];
  rmTraceClickHandler = function(e){ rmTraceAddPoint(e.latlng); };
  map.on("click", rmTraceClickHandler);
  rmShowTracePanel();
  document.getElementById("rm-trace-mode-hint").textContent =
    "Tap the roof's corners in order, right on the KMZ orthomosaic above. This KMZ is a tiled Google Earth " +
    "overlay, so RoofMapper loaded the highest-detail tile set for tracing.";
  rmSetStatus("KMZ super-overlay loaded (" + tiles.length + " tiles) -- trace the roof on the orthomosaic.");
  rmUpdateControlVisibility();
}
function rmKmzKmlLevel(path){
  var m = rmNormalizeKmlPath(path).match(/^(\d+)\//);
  return m ? parseInt(m[1], 10) : -1;
}
async function rmUploadKmzFile(file, allFiles){
  if (!window.JSZip) throw new Error("KMZ support did not load yet. Refresh and try again.");
  var zip = await JSZip.loadAsync(await file.arrayBuffer());
  var keys = Object.keys(zip.files || {});
  var kmlKey = keys.find(function(k){ return !zip.files[k].dir && /(^|\/)doc\.kml$/i.test(k); }) ||
    keys.find(function(k){ return !zip.files[k].dir && /\.kml$/i.test(k); });
  if (!kmlKey) throw new Error("KMZ has no KML file");
  var kmlText = await zip.files[kmlKey].async("text");
  var docBounds = null;
  try{
    var doc = new DOMParser().parseFromString(kmlText, "application/xml");
    docBounds = rmKmlBoundsUnion(rmKmlElementsByLocalName(doc, "LatLonAltBox").map(rmKmlParseBoundsFromBox));
  }catch(e){}
  var docOverlays = rmParseKmlGroundOverlays(kmlText, file.name, kmlKey);
  if (docOverlays.length){
    var meta = docOverlays[0];
    var imageKey = rmFindKmzEntry(zip, meta.resolvedImageHref || meta.imageHref);
    if (!imageKey) throw new Error("KMZ GroundOverlay image was not found");
    meta.kmlFileName = kmlKey;
    meta.imageFileName = imageKey.split("/").pop();
    var dataUrl = await rmReadKmzImageDataUrl(zip, imageKey);
    var result = await rmResizeDataUrlToOrtho(dataUrl, RM_ORTHO_MAX_DIM, RM_ORTHO_QUALITY);
    rmStartKmlGroundOverlayTrace(result.dataUrl, meta);
    return;
  }
  var overlayKmlKeys = keys.filter(function(k){ return !zip.files[k].dir && /\.kml$/i.test(k); })
    .filter(function(k){ return k !== kmlKey; });
  var maxLevel = Math.max.apply(null, overlayKmlKeys.map(rmKmzKmlLevel));
  if (!isFinite(maxLevel) || maxLevel < 0) throw new Error("KMZ has no GroundOverlay image tiles");
  var tileKmlKeys = overlayKmlKeys.filter(function(k){ return rmKmzKmlLevel(k) === maxLevel; });
  var tiles = [];
  for (var i = 0; i < tileKmlKeys.length; i++){
    var tileKmlKey = tileKmlKeys[i];
    var tileKml = await zip.files[tileKmlKey].async("text");
    var overlays = rmParseKmlGroundOverlays(tileKml, file.name, tileKmlKey);
    if (!overlays.length) continue;
    var tileMeta = overlays[0];
    var tileImageKey = rmFindKmzEntry(zip, tileMeta.resolvedImageHref || tileMeta.imageHref);
    if (!tileImageKey) continue;
    tileMeta.kmlFileName = tileKmlKey;
    tileMeta.imageFileName = tileImageKey.split("/").pop();
    tiles.push({ meta: tileMeta, dataUrl: await rmReadKmzImageDataUrl(zip, tileImageKey) });
  }
  if (!tiles.length) throw new Error("KMZ GroundOverlay image tiles were not found");
  var paired = rmFindPairedImageFile((allFiles || []).filter(function(f){ return f !== file; }), file.name.replace(/\.kmz$/i, ".jpg"));
  var persistDataUrl = null;
  var persistImageName = null;
  if (paired){
    var pairedResult = await rmLoadAndResizeOrtho(paired, RM_ORTHO_MAX_DIM, RM_ORTHO_QUALITY);
    persistDataUrl = pairedResult.dataUrl;
    persistImageName = paired.name;
  }
  rmStartKmlSuperOverlayTrace(tiles, {
    sourceType: "kmz_superoverlay",
    sourceFileName: file.name,
    imageFileName: persistImageName || (tiles.length + " KMZ tiles"),
    tileCount: tiles.length,
    kmlLevel: maxLevel,
    bounds: docBounds || rmKmlBoundsUnion(tiles.map(function(t){ return t.meta.bounds; })),
    tiles: tiles.map(function(t){ return { kmlFileName: t.meta.kmlFileName, imageFileName: t.meta.imageFileName, bounds: t.meta.bounds }; }),
    persistDataUrl: persistDataUrl
  });
}
async function rmUploadKmlFiles(files){
  var kmlFile = files.find(function(f){ return /\.kml$/i.test(f.name || ""); });
  if (!kmlFile) throw new Error("Choose a KML file");
  var kmlText = await kmlFile.text();
  var meta = rmParseKmlGroundOverlay(kmlText, kmlFile.name);
  var imageFile = rmFindPairedImageFile(files.filter(function(f){ return f !== kmlFile; }), meta.imageHref);
  if (!imageFile) throw new Error("Choose the image referenced by the KML too (" + meta.imageHref + ")");
  meta.imageFileName = imageFile.name;
  var result = await rmLoadAndResizeOrtho(imageFile, RM_ORTHO_MAX_DIM, RM_ORTHO_QUALITY);
  rmStartKmlGroundOverlayTrace(result.dataUrl, meta);
}
async function rmUploadOrthoFile(input){
  var files = Array.prototype.slice.call(input.files || []);
  var file = files[0];
  input.value = "";
  if (!file) return;
  try{
    var hasKmz = files.find(function(f){ return /\.kmz$/i.test(f.name || ""); });
    var hasKml = files.find(function(f){ return /\.kml$/i.test(f.name || ""); });
    if (hasKmz){
      toast("Reading KMZ...");
      await rmUploadKmzFile(hasKmz, files);
      return;
    }
    if (hasKml){
      toast("Reading KML GroundOverlay...");
      await rmUploadKmlFiles(files);
      return;
    }
    /* Only bother attempting the (slower) GeoTIFF parse for files that
       look like a TIFF at all -- a plain JPG/PNG skips straight to the
       existing flat-canvas path without wasting time on a parse attempt
       that would just fail anyway. */
    if (/\.tiff?$/i.test(file.name || "")){
      if (file.size > RM_GEOTIFF_MAX_BYTES){
        toast("This file is " + Math.round(file.size / 1024 / 1024) + "MB — large enough that loading it fully " +
          "into the browser risks running out of memory, especially on a phone. Try a downsampled/lower-resolution " +
          "export from WebODM, or use “☁️ Trace From CompanyCam Photo” instead if it's already uploaded there.");
        return;
      }
      toast("Reading GeoTIFF…");
      var arrayBuffer = await file.arrayBuffer();
      var georaster = await rmTryParseGeoreferencedTiff(arrayBuffer);
      if (georaster){
        rmStartGeoTiffTrace(georaster);
        return;
      }
      /* Caught in testing: a .tif with no usable geodata can't just fall
         through to the flat-canvas path below the way a JPG/PNG can --
         most browsers have NO native TIFF image decoder at all (TIFF
         isn't a web-standard <img>/Canvas format the way PNG/JPG/WebP
         are), so rmLoadAndResizeOrtho() would silently fail with an
         unhelpful "Couldn't read the image" instead of ever starting a
         trace. Stopping here with a clear, actionable message instead of
         attempting something that's essentially guaranteed to fail. */
      toast("This TIFF has no usable GPS data, and most browsers can't display a plain TIFF directly. Re-export it " +
        "as a JPG or PNG to trace it as a flat image with manual Calibrate, or use a real georeferenced GeoTIFF.");
      return;
    }
    toast("Preparing image…");
    var result = await rmLoadAndResizeOrtho(file, RM_ORTHO_MAX_DIM, RM_ORTHO_QUALITY);
    rmStartOrthoTrace(result.dataUrl, result.w, result.h);
  }catch(e){ toast("Couldn't load that image: " + e.message); }
}
/* Ortho, secondary path -- Mark: "pulling from a linked CompanyCam
   project is the secondary path" (local upload above is primary). Only
   makes sense once a building (and therefore its CompanyCam project) is
   already known, so this is offered from the features panel after the
   first roof is linked, and from the multi-roof re-entry flow -- not on
   RoofMapper's very first, cold-start capture card where no building is
   known yet. Reuses the exact same photos/image proxy actions the
   existing (multi-select, different purpose) CompanyCam photo picker
   uses, and feeds the result into the SAME rmStartOrthoTrace() pipeline
   local upload uses -- Square Up/vertex-edit/Calibrate all work on it
   identically either way. See "Ortho, secondary path: pick from an
   existing CompanyCam photo" in DEV_NOTES.md. */
var rmCcOrthoProjectId = null, rmCcOrthoPage = 1, rmCcOrthoLoading = false;
async function rmOpenCcOrthoPicker(){
  var buildingId = rmState.linkedBuildingId || rmState.pendingBuildingId;
  if (!buildingId){ toast("Save this roof to a building first, or use Trace Another Roof — this needs a known building's CompanyCam project."); return; }
  document.getElementById("rm-cc-ortho-modal").style.display = "";
  lockBodyScroll();
  var grid = document.getElementById("rm-cc-ortho-grid");
  grid.innerHTML = '<p class="hint">Loading…</p>';
  document.getElementById("rm-cc-ortho-more").style.display = "none";
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    if (!bld.companyCamProjectId){
      grid.innerHTML = '<p class="hint">This building has no CompanyCam project linked, so there’s nothing here to pick from.</p>';
      return;
    }
    rmCcOrthoProjectId = bld.companyCamProjectId;
    rmCcOrthoPage = 1;
    grid.innerHTML = "";
    await rmLoadMoreCcOrthoPhotos();
  }catch(e){
    grid.innerHTML = '<p class="hint">Couldn’t load this building: ' + esc(e.message) + '</p>';
  }
}
function closeRmCcOrthoModal(){
  document.getElementById("rm-cc-ortho-modal").style.display = "none";
  document.getElementById("rm-cc-ortho-grid").innerHTML = "";
  unlockBodyScroll();
}
async function rmLoadMoreCcOrthoPhotos(){
  if (rmCcOrthoLoading || !rmCcOrthoProjectId) return;
  rmCcOrthoLoading = true;
  var more = document.getElementById("rm-cc-ortho-more");
  more.disabled = true; more.textContent = "Loading…";
  try{
    var out = await ccApi({ action: "photos", project_id: rmCcOrthoProjectId, page: rmCcOrthoPage });
    var photos = out.photos || [];
    var grid = document.getElementById("rm-cc-ortho-grid");
    if (!photos.length && rmCcOrthoPage === 1){
      grid.innerHTML = '<p class="hint">No photos in this CompanyCam project yet.</p>';
    }
    photos.forEach(function(p){
      var d = document.createElement("div");
      d.className = "cc-ph";
      d.innerHTML = '<img src="' + esc(p.thumb || p.full) + '" loading="lazy">';
      d.onclick = function(){ rmSelectCcOrthoPhoto(p); };
      grid.appendChild(d);
    });
    rmCcOrthoPage++;
    more.style.display = photos.length >= 30 ? "" : "none";
  }catch(e){
    toast("Couldn't load more photos: " + e.message);
  }finally{
    rmCcOrthoLoading = false;
    more.disabled = false; more.textContent = "Load More";
  }
}
async function rmSelectCcOrthoPhoto(photo){
  closeRmCcOrthoModal();
  toast("Loading photo…");
  try{
    var out = await ccApi({ action: "image", url: photo.full });
    if (!out.dataUrl) throw new Error("CompanyCam didn't return the image");
    var result = await rmResizeDataUrlToOrtho(out.dataUrl, RM_ORTHO_MAX_DIM, RM_ORTHO_QUALITY);
    rmStartOrthoTrace(result.dataUrl, result.w, result.h);
  }catch(e){ toast("Couldn't load that photo: " + e.message); }
}
function rmClearOrthoOverlay(){
  if (rmState.map && rmState.orthoOverlayLayer) rmState.map.removeLayer(rmState.orthoOverlayLayer);
  rmState.orthoOverlayLayer = null;
  rmState.orthoDataUrl = null;
  rmState.orthoBounds = null;
  rmState.orthoActive = false;
  rmUpdateMapZoomCap();
}
/* Image pixel (0,0) is the top-left / north-west corner; local XY here
   follows the same x=east/y=north convention rmGeomToLocalXY/
   rmGeomFromLocalXY already use everywhere else. Extracted out of
   rmStartOrthoTrace() so rmOpenRoofInMapper() can reconstruct the IDENTICAL
   bounds when reopening a previously-persisted synthetic ortho: neither
   RM_ORTHO_ORIGIN nor RM_ORTHO_METERS_PER_PIXEL_GUESS are persisted
   per-upload (they're fixed constants), so re-running this exact math
   against the same pixel dimensions is deterministic -- no separate
   bounds field needs to be stored in Firestore at all. See "Reopen a
   saved roof in RoofMapper" in DEV_NOTES.md. */
function rmComputeOrthoBounds(pixelW, pixelH){
  var mpp = RM_ORTHO_METERS_PER_PIXEL_GUESS;
  var halfWM = (pixelW * mpp) / 2, halfHM = (pixelH * mpp) / 2;
  var origin = RM_ORTHO_ORIGIN;
  var nw = rmGeomFromLocalXY({ x: -halfWM, y: halfHM }, origin);
  var se = rmGeomFromLocalXY({ x: halfWM, y: -halfHM }, origin);
  return {
    latLngBounds: L.latLngBounds([se.lat, nw.lng], [nw.lat, se.lng]),
    orthoBounds: { north: nw.lat, south: se.lat, east: se.lng, west: nw.lng }
  };
}
function rmStartOrthoTrace(dataUrl, pixelW, pixelH){
  var map = rmEnsureMap();
  rmClearFootprintLayers(); /* same clean-slate as any other fresh capture start --
    MUST run before the overlay is built below: this also calls
    rmClearOrthoOverlay(), which would otherwise wipe the overlay we're
    about to create if called after. */
  var computed = rmComputeOrthoBounds(pixelW, pixelH);
  rmState.orthoOverlayLayer = L.imageOverlay(dataUrl, computed.latLngBounds).addTo(map);
  rmState.orthoActive = true;
  rmUpdateMapZoomCap();
  rmState.orthoDataUrl = dataUrl;
  rmState.orthoBounds = computed.orthoBounds;
  rmState.lat = RM_ORTHO_ORIGIN.lat; rmState.lng = RM_ORTHO_ORIGIN.lng; rmState.accuracy = null;
  map.fitBounds(computed.latLngBounds);
  rmTraceState.active = true;
  rmTraceState.mode = "manual";
  rmTraceState.points = [];
  rmTraceClickHandler = function(e){ rmTraceAddPoint(e.latlng); };
  map.on("click", rmTraceClickHandler);
  rmShowTracePanel();
  document.getElementById("rm-trace-mode-hint").textContent =
    "Tap the roof's corners in order, right on your uploaded image above. Once finished, use Calibrate on any " +
    "edge (tap its length label, enter the real measurement) to set the true scale — this image has no GPS data, " +
    "so the shape starts at an arbitrary size until you do.";
  rmUpdateControlVisibility();
}
/* Finding A, part 2 -- retain the uploaded ortho WITH the roof so it can
   be reopened later. Reuses the exact upload-to-CompanyCam-then-
   set_building_roof_map path uploadRoofBaseMap() already uses for a
   hand-drawn base map (same companyCamProjectId requirement -- the
   building needs a linked CompanyCam project to have somewhere durable
   to put the image -- same claims/permission-gated server call).

   Deliberately saved as roof_base_map_type "sketch" (x/y pixel space),
   NOT "drone_ortho" (real lat/lng bounds), even though it visually IS a
   drone photo. "drone_ortho" is treated as GEOREFERENCED everywhere else
   in the app -- lookupProspectiveBuildingBaseMap() and the pin/asset
   placement it feeds both assume a drone_ortho's bounds are real GPS
   coordinates and save future pins/features against it as real lat/lng.
   This ortho's bounds are SYNTHETIC (Null Island -- see
   RM_ORTHO_ORIGIN/rmStartOrthoTrace() above): treating it as
   georeferenced would silently save any future pin placed on it during a
   LATER work order as a real-world lat/lng near 0,0, completely
   disconnected from the actual building -- a real correctness bug, not
   just a display quirk. The existing x/y "sketch" path already handles
   "base map with no real coordinate system" correctly and is fully
   wired everywhere (pin placement, asset placement, Building History's
   own roof map), so this reuses it as-is rather than adding a new type
   value and auditing every drone_ortho call site for this edge case.
   roof_base_map_synthetic:true is a purely cosmetic flag (admin.js
   allow-lists and stores it, unused by any type-dispatch logic) so a
   future status/label can say "drone photo, not geo-referenced" instead
   of implying a hand sketch. See "Ortho upload: persist with the roof
   for reopening" in DEV_NOTES.md. */
async function rmPersistOrthoBaseMap(buildingId, roofId){
  if (!isAdmin){
    toast("Roof outline saved. Sign in as admin to also keep this drone image with the roof for reopening later.");
    return;
  }
  if (!rmState.orthoDataUrl) return;
  try{
    var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = bldSnap.exists ? bldSnap.data() : {};
    if (!bld.companyCamProjectId){
      toast("Roof outline saved. This building has no CompanyCam project linked, so the drone image itself " +
        "can't be retained (the traced outline is saved either way).");
      return;
    }
    toast("Saving the drone image with this roof…");
    var base64 = rmState.orthoDataUrl.split("base64,")[1];
    if (!base64) throw new Error("couldn't encode the image");
    var out = await ccApiPost({ action: "upload_document", project_id: bld.companyCamProjectId,
      name: "roof-ortho-" + roofId + ".jpg", attachment: base64 });
    var url = out.document && out.document.url;
    if (!url) throw new Error("CompanyCam didn't return a URL for the uploaded file");
    await callAdminApi({ action: "set_building_roof_map", buildingId: buildingId, roofId: roofId,
      roof_base_map_type: "sketch", roof_base_map_url: url, roof_base_map_synthetic: true });
    toast("Drone image saved with the roof — reopen it any time from Building History ✓");
  }catch(e){
    toast("Roof outline saved, but couldn't keep the drone image with it: " + e.message);
  }
}
async function rmPersistKmlGroundOverlayBaseMap(buildingId, roofId){
  if (!isAdmin){
    toast("Roof outline saved. Sign in as admin to also keep this KMZ/KML orthomosaic with the roof for reopening later.");
    return;
  }
  if (!rmState.kmlOverlayDataUrl || !rmState.kmlOverlayMeta || !rmState.kmlOverlayMeta.bounds) return;
  try{
    var bldSnap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = bldSnap.exists ? bldSnap.data() : {};
    if (!bld.companyCamProjectId){
      toast("Roof outline saved. This building has no CompanyCam project linked, so the KMZ/KML image itself " +
        "can't be retained (the traced outline and overlay metadata are saved either way).");
      return;
    }
    toast("Saving the KMZ/KML orthomosaic with this roof...");
    var base64 = rmState.kmlOverlayDataUrl.split("base64,")[1];
    if (!base64) throw new Error("couldn't encode the image");
    var safeName = (rmState.kmlOverlayMeta.imageFileName || rmState.kmlOverlayMeta.sourceFileName || "roof-kmz").replace(/[^\w.-]+/g, "-");
    var out = await ccApiPost({ action: "upload_document", project_id: bld.companyCamProjectId,
      name: "roof-groundoverlay-" + roofId + "-" + safeName + ".jpg", attachment: base64 });
    var url = out.document && out.document.url;
    if (!url) throw new Error("CompanyCam didn't return a URL for the uploaded file");
    await callAdminApi({ action: "set_building_roof_map", buildingId: buildingId, roofId: roofId,
      roof_base_map_type: "drone_ortho", roof_base_map_url: url, roof_base_map_bounds: rmState.kmlOverlayMeta.bounds });
    toast("KMZ/KML orthomosaic saved with the roof -- reopen it any time from Building History.");
  }catch(e){
    toast("Roof outline saved, but couldn't keep the KMZ/KML image with it: " + e.message);
  }
}
/* Walk-the-corners: no map-click handler -- points come from a GPS fix each
   time the tech taps Record, not from tapping the map (satellite imagery
   may be blank/wrong/unavailable here at all, which is exactly the case
   this method exists for). Still switches to satellite so there's SOME
   visual reference and the accumulating preview polygon is visible, but
   nothing about capture depends on the map itself. */
function rmStartWalkCorners(){
  rmClearFootprintLayers();
  rmTraceState.active = true;
  rmTraceState.mode = "walk";
  rmTraceState.points = [];
  rmSetBaseLayer("satellite");
  var map = rmEnsureMap();
  if (rmState.lat != null) map.setView([rmState.lat, rmState.lng], 19);
  rmSetStatus("Walking the corners — stand at each corner of the roof and tap Record This Corner below.");
  rmShowTracePanel();
}
function rmWalkRecordCorner(){
  var btn = document.getElementById("rm-walk-record-btn");
  btn.disabled = true; btn.textContent = "Locating…";
  rmGeoRequest(function(pos){
    btn.disabled = false; btn.textContent = "📍 Record This Corner";
    var lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy || 0;
    rmTraceAddPoint(L.latLng(lat, lng));
    var accFt = Math.round(acc * 3.28084);
    toast("Corner " + rmTraceState.points.length + " recorded (±" + accFt + " ft accuracy).");
  }, function(err){
    btn.disabled = false; btn.textContent = "📍 Record This Corner";
    toast(err.friendly || "Couldn't get your location.");
  });
}
function rmTraceAddPoint(latlng){
  if (!rmTraceState.active) return;
  /* Snap only applies to map-tap tracing (manual/ortho) -- walk-corners
     points come from an actual GPS fix at the tech's real physical
     position, which must never be silently swapped for a nearby existing
     vertex (that would defeat the entire point of walking to the real
     corner). See "Vertex snapping" in DEV_NOTES.md. */
  if (rmTraceState.mode !== "walk"){
    var snap = rmFindSnapTarget(latlng);
    if (snap){
      latlng = L.latLng(snap.lat, snap.lng);
      rmShowSnapIndicator(snap);
    } else {
      rmClearSnapIndicator();
    }
  }
  rmTraceState.points.push({ lat: latlng.lat, lng: latlng.lng });
  rmRenderTracePreview();
  rmUpdateTraceButtons();
}
function rmTraceUndo(){
  rmTraceState.points.pop();
  rmRenderTracePreview();
  rmUpdateTraceButtons();
}
function rmRenderTracePreview(){
  var map = rmState.map;
  if (!map) return;
  rmTraceState.vertexLayers.forEach(function(l){ map.removeLayer(l); });
  rmTraceState.vertexLayers = rmTraceState.points.map(function(p){
    return L.circleMarker([p.lat, p.lng], { radius: 5, color: "#fff", weight: 2, fillColor: "#E8600A", fillOpacity: 1 }).addTo(map);
  });
  if (rmTraceState.previewLayer){ map.removeLayer(rmTraceState.previewLayer); rmTraceState.previewLayer = null; }
  if (rmTraceState.points.length >= 2){
    rmTraceState.previewLayer = L.polygon(rmTraceState.points.map(function(p){ return [p.lat, p.lng]; }), {
      color: "#E8600A", weight: 2, dashArray: "4,4", fillColor: "#E8600A", fillOpacity: 0.1
    }).addTo(map);
  }
  /* Walk-the-corners only -- keep the growing polygon in view as the tech
     physically moves around a building. Manual trace deliberately does NOT
     auto-pan: the tech is intentionally tapping a fixed view, and yanking
     the map after every tap would fight their own panning/zooming. */
  if (rmTraceState.mode === "walk" && rmTraceState.points.length){
    var last = rmTraceState.points[rmTraceState.points.length - 1];
    map.panTo([last.lat, last.lng], { animate: true });
  }
}
function rmUpdateTraceButtons(){
  document.getElementById("rm-trace-finish-btn").disabled = rmTraceState.points.length < 3;
  document.getElementById("rm-trace-undo-btn").disabled = rmTraceState.points.length === 0;
  document.getElementById("rm-trace-count").textContent = rmTraceState.points.length + " point" + (rmTraceState.points.length === 1 ? "" : "s");
}
function rmCancelTrace(){
  rmTraceState.active = false;
  var map = rmState.map;
  if (map){
    rmTraceState.vertexLayers.forEach(function(l){ map.removeLayer(l); });
    if (rmTraceState.previewLayer) map.removeLayer(rmTraceState.previewLayer);
    if (rmTraceClickHandler){ map.off("click", rmTraceClickHandler); rmTraceClickHandler = null; }
  }
  rmClearSnapIndicator(); /* covers both an explicit Cancel and rmFinishTrace()'s internal call to this same function */
  rmSetPrecisionMode(false);
  rmTraceState.points = [];
  rmTraceState.vertexLayers = [];
  rmTraceState.previewLayer = null;
  rmTraceState.mode = "manual";
  document.getElementById("rm-walk-record-btn").style.display = "none";
  rmUpdateTraceButtons();
  rmUpdateControlVisibility(); /* hides #rm-trace-panel (rmTraceState.active is already false here), restores search buttons if still relevant */
}
function rmFinishTrace(){
  var isWalk = rmTraceState.mode === "walk";
  if (rmTraceState.points.length < 3){
    toast((isWalk ? "Record" : "Tap") + " at least 3 " + (isWalk ? "corners" : "points") + " to form a roof outline.");
    return;
  }
  var ring = rmGeomCleanRing(rmTraceState.points.concat([rmTraceState.points[0]]));
  if (ring.length < 4){ toast("Those points are too close together — try " + (isWalk ? "spacing corners further apart" : "tracing wider corners") + "."); return; }
  var tracedOnOrtho = rmState.orthoActive;
  var tracedOnGeoTiff = rmState.geoTiffActive;
  var tracedOnKmlOverlay = rmState.kmlOverlayActive;
  var outline = {
    ring: ring,
    center: rmGeomRingCentroid(ring),
    areaSqFt: rmGeomPolygonAreaSqMeters(ring) * 10.7639,
    perimeterFt: rmGeomPolygonPerimeterMeters(ring) * 3.28084,
    source: isWalk ? "walk_corners" : (tracedOnKmlOverlay ? "kml_groundoverlay_trace" : (tracedOnGeoTiff ? "geotiff_trace" : (tracedOnOrtho ? "ortho_trace" : "manual_trace"))),
    osmId: null, osmType: null, tags: {},
    isSiteBoundary: false,
    createdAt: Date.now()
  };
  /* geotiff_trace is the OPPOSITE of tracedOnOrtho below -- real GPS
     geodata means the ring is already an accurate, real-world position,
     not a placeholder. Flagged explicitly so future code (and Mark) can
     tell at a glance this one didn't need Calibrate and won't inherit a
     scale factor learned from some other, less-accurate roof on the same
     building (rmCalibrateEdge()'s inheritance-learning check only matches
     source "manual_trace"/"ortho_trace", so geotiff_trace is naturally
     excluded without extra code). See "GeoTIFF georeferenced ortho
     support" in DEV_NOTES.md. */
  if (tracedOnGeoTiff || tracedOnKmlOverlay) outline.georeferencedSource = true;
  if (tracedOnKmlOverlay && rmState.kmlOverlayMeta){
    outline.groundOverlay = Object.assign({}, rmState.kmlOverlayMeta);
  }
  /* tracedOnOrtho'd outlines carry a synthetic (Null Island) origin, not a
     real-world position -- flagged explicitly rather than silently baked
     into `source` alone, so any future code inspecting an outline can
     tell at a glance not to trust its absolute position on a real-world
     map until manual alignment (not yet built) happens. Shape/area/
     perimeter are exactly correct once calibrated; only WHERE on Earth
     it sits is a placeholder. See "Ortho upload + flat-canvas tracing" in
     DEV_NOTES.md. */
  if (tracedOnOrtho) outline.tracedOnOrtho = true;
  /* Scale inheritance (Mark: "he should not have to re-calibrate for every
     roof... scale is a property of the building/base image, not of an
     individual roof") -- applies to manual_trace/ortho_trace only (OSM
     footprints are already independently georeferenced; walk_corners is
     each a fresh independent GPS fix, nothing shared to inherit). If a
     PRIOR roof on this same continuing multi-roof session was calibrated
     (rmCalibrateEdge() sets rmState.inheritedScaleFactor), auto-apply that
     exact correction to this brand-new ring immediately -- same uniform
     rescale-about-centroid math Calibrate itself uses -- so it comes out
     accurate without asking him to re-measure an edge he's already
     measured once for this building. See "Scale inheritance" in
     DEV_NOTES.md. */
  var canInheritScale = (outline.source === "manual_trace" || outline.source === "ortho_trace") &&
    rmState.inheritedScaleFactor !== 1 && rmState.inheritedScaleFactorBuildingId === rmState.pendingBuildingId;
  if (canInheritScale){
    var centroid = rmGeomRingCentroid(ring);
    var scaledRing = ring.map(function(p){ return rmGeomScalePoint(p, centroid, rmState.inheritedScaleFactor); });
    outline.ring = scaledRing;
    outline.center = centroid;
    outline.areaSqFt = rmGeomPolygonAreaSqMeters(scaledRing) * 10.7639;
    outline.perimeterFt = rmGeomPolygonPerimeterMeters(scaledRing) * 3.28084;
    outline.calibration = { inherited: true, factor: rmState.inheritedScaleFactor, calibratedAt: Date.now() };
  }
  rmCancelTrace();
  rmDrawFinalOutline(outline);
  toast(isWalk ? "Roof outline captured from walked corners ✓" :
    (canInheritScale ? "Roof outline traced ✓ — scale inherited from this building, no need to re-measure" : "Roof outline traced ✓"));
}

/* ---- save to building (existing or new) ---- */
var rmBpCache = null;
function openRmSaveModal(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  document.getElementById("rm-save-modal").style.display = "";
  lockBodyScroll();
  rmRenderContinueBuildingBanner();
  document.getElementById("rm-bp-search").value = "";
  document.getElementById("rm-roof-picker").innerHTML = "";
  var list = document.getElementById("rm-bp-list");
  list.className = "hint";
  list.textContent = "Loading buildings…";
  rmBpCcCache = [];
  rmBpRenderCcList(); /* clears/resets the CC section's state from a previous open */
  if (!fdb){
    list.textContent = "Linking to a building needs cloud sync (internet connection). You can still Save on This Device Only.";
    return;
  }
  fdb.collection("buildings").orderBy("updatedAt", "desc").limit(200).get().then(function(qs){
    rmBpCache = [];
    qs.forEach(function(d){
      var b = Object.assign({ id: d.id }, d.data());
      if (!b.archived) rmBpCache.push(b); /* archived buildings stay out of every default picker -- see "Building archive" in DEV_NOTES.md */
    });
    rmBpRender(rmBpCache);
  }).catch(function(e){
    list.className = "hint";
    list.textContent = "Couldn't load buildings: " + e.message;
  });
  /* Independent of the app-buildings load above -- a slow/unavailable
     CompanyCam API never holds up the (usually much faster) existing-
     buildings list. See "RoofMapper save flow: full CompanyCam picker" in
     DEV_NOTES.md. */
  rmBpSearchCompanyCam("");
}
function closeRmSaveModal(){
  document.getElementById("rm-save-modal").style.display = "none";
  unlockBodyScroll();
  if (rmBpCcDebounceTimer) clearTimeout(rmBpCcDebounceTimer);
  rmSplitState.savingAll = false;
}
/* Multi-roof fast path -- Mark: shouldn't have to search for the same
   building again when saving roof #2/#3/etc right after roof #1.
   rmState.pendingBuildingId is set by rmEnterMultiRoofCapture() right
   before the new trace starts; this banner (top of the modal, above the
   normal search/list) offers a one-tap way to reuse it, without removing
   the normal search below in case he genuinely wants a different
   building this time. */
function rmRenderContinueBuildingBanner(){
  var el = document.getElementById("rm-continue-building-banner");
  if (!el) return;
  if (!rmState.pendingBuildingId){ el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  el.innerHTML = '<div class="rm-footprint-info" style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
    '<span>↩️ Continuing on <b>' + esc(rmState.pendingBuildingName || "the same building") +
    '</b> — the building your last roof on this page was saved to</span>' +
    '<button class="btn primary" onclick="rmContinueOnPendingBuilding()" style="margin-left:auto">Use This Building</button></div>';
}
async function rmContinueOnPendingBuilding(){
  var buildingId = rmState.pendingBuildingId;
  if (!buildingId) return;
  var picker = document.getElementById("rm-roof-picker");
  picker.innerHTML = '<p class="hint">Loading…</p>';
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? Object.assign({ id: buildingId }, snap.data()) : {};
    rmRenderRoofPickerFor(buildingId, bld);
    picker.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }catch(e){ toast("Couldn't load that building: " + e.message); }
}
function rmBpFilter(){
  if (!rmBpCache) return;
  document.getElementById("rm-roof-picker").innerHTML = "";
  var q = document.getElementById("rm-bp-search").value.trim().toLowerCase();
  if (!q){ rmBpRender(rmBpCache); return; }
  rmBpRender(rmBpCache.filter(function(b){
    return (b.name || "").toLowerCase().indexOf(q) > -1 ||
      (b.customerName || "").toLowerCase().indexOf(q) > -1 ||
      (b.location || "").toLowerCase().indexOf(q) > -1;
  }));
}
function rmBpRender(list){
  var host = document.getElementById("rm-bp-list");
  if (!list.length){ host.className = "hint"; host.textContent = "No buildings found."; return; }
  host.className = "";
  host.innerHTML = list.map(function(b){
    return '<div class="bld-item" onclick="rmChooseBuildingForSave(\'' + b.id + '\')"><div class="info">' +
      '<div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta">' + esc(b.customerName || "") + (b.location ? ' · ' + esc(b.location) : "") + '</div></div>' +
      '<button class="btn">Save Here</button></div>';
  }).join("");
}
/* ---- CompanyCam merge (Mark: "no way to attach a traced outline to an
   EXISTING CompanyCam project" -- this picker previously only searched
   app-created buildings). Mirrors the Change Order picker's CompanyCam
   merge (openBuildingPicker() / commit 098ae77) exactly -- same debounced
   search, same dedupe-against-already-linked-buildings logic, same "index
   into the deduped/VISIBLE list, not the raw fetch result" fix for the
   bug caught in that earlier build. Kept as its own rm-prefixed copy
   rather than a shared helper, matching this file's existing precedent of
   a parallel rm-prefixed picker for RoofMapper's save flow (rmBpFilter/
   rmBpRender already duplicate bpFilter/bpRender the same way). See
   "RoofMapper save flow: full CompanyCam picker" in DEV_NOTES.md. */
var rmBpCcCache = [];
var rmBpCcVisibleCache = [];
var rmBpCcDebounceTimer = null;
function rmBpDebouncedCcSearch(){
  if (rmBpCcDebounceTimer) clearTimeout(rmBpCcDebounceTimer);
  var q = document.getElementById("rm-bp-search").value.trim();
  rmBpCcDebounceTimer = setTimeout(function(){ rmBpSearchCompanyCam(q); }, 400);
}
async function rmBpSearchCompanyCam(q){
  var host = document.getElementById("rm-bp-cc-list");
  if (host){ host.className = "hint"; host.textContent = "Searching CompanyCam…"; }
  try{
    var out = await ccApi({ action: "projects", q: q || "" });
    rmBpCcCache = out.projects || [];
    rmBpRenderCcList();
  }catch(e){
    rmBpCcCache = [];
    if (host){
      host.className = "hint";
      host.textContent = "Couldn't reach CompanyCam right now — showing existing buildings only.";
    }
  }
}
function rmBpRenderCcList(){
  var host = document.getElementById("rm-bp-cc-list");
  if (!host) return;
  var linkedIds = {};
  (rmBpCache || []).forEach(function(b){ if (b.companyCamProjectId) linkedIds[b.companyCamProjectId] = true; });
  rmBpCcVisibleCache = rmBpCcCache.filter(function(p){ return !linkedIds[p.id]; });
  if (!rmBpCcVisibleCache.length){
    host.className = "hint";
    host.textContent = "No other CompanyCam projects found.";
    return;
  }
  host.className = "";
  host.innerHTML = rmBpCcVisibleCache.map(function(p, i){
    return '<div class="bld-item" onclick="rmBpSelectCompanyCamProject(' + i + ')"><div class="info">' +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="meta">' + (p.address ? esc(p.address) : "") + ' · ☁️ CompanyCam only</div></div>' +
      '<button class="btn">Select</button></div>';
  }).join("");
}
/* Selecting a CompanyCam-only project creates/links a real building record
   right away (ensureCustomerAndBuilding() -- same idempotent upsert every
   other CompanyCam-building linkage in this app uses), then goes straight
   to the roof picker so Mark can pick or add a roof for THIS building --
   unlike the Change Order picker (which just fills form fields and
   closes), RoofMapper's flow still needs a roof chosen before the outline
   actually saves. Deliberately does a FRESH Firestore read of the
   just-created/linked building rather than trusting rmBpCache (which was
   fetched before this building existed, or before it had this
   CompanyCam link) -- matters if the jobName+billTo happened to already
   match an existing app building with its own real roofs already saved;
   the roof picker needs to see those, not a stale/empty synthesized
   default. */
async function rmBpSelectCompanyCamProject(i){
  var p = rmBpCcVisibleCache[i];
  if (!p) return;
  toast("Linking CompanyCam project…");
  try{
    var ids = await ensureCustomerAndBuilding({
      jobName: p.name || "", billTo: "", location: p.address || "", companyCamProjectId: p.id
    });
    if (!ids.buildingId) throw new Error("couldn't create/link building (need internet connection)");
    var freshBld = {};
    if (fdb){
      var snap = await fdb.collection("buildings").doc(ids.buildingId).get();
      freshBld = snap.exists ? snap.data() : {};
    }
    rmRenderRoofPickerFor(ids.buildingId, freshBld);
    toast("Linked “" + p.name + "” — pick or add a roof below ✓");
  }catch(e){ toast("Couldn't link CompanyCam project: " + e.message); }
}
/* Always shows a picker for an EXISTING building, even a currently
   single-roof one -- previously a single-roof building saved immediately
   with zero taps, which silently meant a second distinct roof traced later
   for the same building just appended into roof #1's roof_outlines[]
   instead of becoming its own roof. Mark: "no way to trace individual
   roofs." "+ Add a new roof…" is always offered alongside whatever roofs
   already exist, so creating roof #2/#3/etc never requires leaving
   RoofMapper first. See "Individual-roof tracing + labels" in
   DEV_NOTES.md. (rmCreateBuildingAndSave(), for a BRAND-NEW building, is
   unaffected -- its first roof is unambiguous, no picker needed there.) */
function rmRenderRoofPickerFor(buildingId, b){
  /* Batch path: rmSaveAllSplitSections() is saving N pending split
     sections as N brand-new roofs at once, not picking a single existing
     roof for one outline -- the normal picker below doesn't apply. */
  if (rmSplitState.savingAll){
    var sections = rmSplitState.sections || [];
    document.getElementById("rm-roof-picker").innerHTML =
      '<div class="rm-footprint-info" style="margin-bottom:10px">This will create <b>' + sections.length +
      '</b> new roofs on this building: ' + sections.map(function(s){ return esc(s.label); }).join(", ") + '.</div>' +
      '<div class="btnrow"><button class="btn primary" onclick="rmSaveSplitSectionsToBuilding(\'' + buildingId +
      '\')">Save All ' + sections.length + ' Sections</button></div>';
    return;
  }
  /* Mark, hitting this every save: "need to move the name of roof when
     saving up so when you click save here on the job it allows you to
     name roof then." Naming used to be deferred to a native prompt()
     popup that only appeared AFTER tapping Save (rmConfirmSaveToChosenRoof()
     below, previously). Now the name field renders inline, right here,
     the moment "+ Add a new roof…" is picked -- one screen, in order:
     pick the building (already done, this whole modal) -> pick/name the
     roof -> Save. Pre-filled with a sensible unique default ("Roof N",
     skipping any already used) so he can just tap through, or type over
     it right there. See "Save-modal: move roof naming up" in DEV_NOTES.md. */
  var roofs = getBuildingRoofs(b || {});
  var defaultLabel = rmNextDefaultRoofLabel(roofs);
  document.getElementById("rm-roof-picker").innerHTML =
    '<div class="fld" style="max-width:260px"><label>Which roof is this outline for?</label>' +
    '<select id="rm-roof-select" onchange="rmOnRoofSelectChange()">' +
    roofs.map(function(r){ return '<option value="' + esc(r.id) + '">' + esc(r.label || "Roof") + '</option>'; }).join('') +
    '<option value="__new__">+ Add a new roof…</option>' +
    '</select></div>' +
    '<div class="fld" id="rm-new-roof-name-fld" style="max-width:260px;display:none">' +
    '<label>Name this roof</label>' +
    '<input type="text" id="rm-new-roof-name" value="' + esc(defaultLabel) + '"></div>' +
    '<div class="btnrow"><button class="btn primary" onclick="rmConfirmSaveToChosenRoof(\'' + buildingId +
    '\')">Save Outline</button></div>';
  rmOnRoofSelectChange();
}
/* "Roof N" for the smallest N not already used by this building's roofs
   (case/whitespace-insensitive) -- e.g. existing "Roof 1"/"Roof 3" yields
   "Roof 2", not "Roof 4", so the default itself never trips the duplicate
   guard in the ordinary case. rmResolveUniqueRoofLabel() at save time is
   still the real backstop (handles a manually-typed collision, or a roof
   added by someone else in the meantime). */
function rmNextDefaultRoofLabel(roofs){
  var taken = (roofs || []).map(function(r){ return String(r.label || "").trim().toLowerCase(); });
  var n = 1;
  while (taken.indexOf(("roof " + n).toLowerCase()) !== -1) n++;
  return "Roof " + n;
}
/* Shows/hides the inline name field to match the select -- called on
   render (so "+ Add a new roof…" being the ONLY option, e.g. a brand-new
   building's picker, starts with the field already visible) and on every
   manual change. */
function rmOnRoofSelectChange(){
  var sel = document.getElementById("rm-roof-select");
  var fld = document.getElementById("rm-new-roof-name-fld");
  if (!sel || !fld) return;
  fld.style.display = sel.value === "__new__" ? "" : "none";
}
function rmChooseBuildingForSave(buildingId){
  var b = (rmBpCache || []).find(function(x){ return x.id === buildingId; }) || {};
  rmRenderRoofPickerFor(buildingId, b);
}
function rmConfirmSaveToChosenRoof(buildingId){
  var sel = document.getElementById("rm-roof-select").value;
  if (sel === "__new__"){
    var label = val("rm-new-roof-name").trim();
    if (!label){ toast("Enter a name for the roof."); return; }
    rmAddRoofAndSave(buildingId, label);
    return;
  }
  rmSaveOutlineToBuilding(buildingId, sel);
}
async function rmAddRoofAndSave(buildingId, label){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  toast("Adding roof…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    label = rmResolveUniqueRoofLabel(roofs, label, null);
    if (label === null){ toast("Add roof cancelled."); return; }
    var newRoof = {
      id: genId("roof"), label: label, roofSystem: "",
      roof_base_map_type: null, roof_base_map_url: null, roof_base_map_bounds: null,
      roof_assets: [], roof_outlines: [], createdAt: Date.now(), updatedAt: Date.now()
    };
    roofs.push(newRoof);
    await saveBuildingRoofs(buildingId, roofs);
    await rmSaveOutlineToBuilding(buildingId, newRoof.id);
  }catch(e){ toast("Couldn't add the new roof: " + e.message); }
}
/* Rename the CURRENTLY LINKED roof without leaving RoofMapper -- unlike
   promptRenameRoof() (Building History's own rename, which finishes by
   navigating to openBuildingHistory()), this stays right here: updates the
   roof's label in Firestore, then redraws the on-map label + roof-select
   dropdown in place. Reachable two ways per Mark's explicit ask: tapping
   the roof's own label on the map (roofLabelMarker's onClick, wired in
   rmSaveOutlineToBuilding above) and the "🏷️ Rename Roof" button in the
   outline panel (visible whenever a roof is linked, including through Edit
   Shape mode -- see rmUpdateControlVisibility()). Covers "any roof at any
   time" per Mark's ask #2 by acting on whichever roof is currently linked
   -- the realistic path, since renaming requires the roof to be open in
   RoofMapper first (from Building History's "Continue" or a fresh trace).
   See "Rename a roof, discoverable from RoofMapper" in DEV_NOTES.md. */
/* Mark: "he must be able to MOVE THE ROOF LABEL AROUND" -- off a cluttered
   area, onto a clear part of the roof, wherever it reads best. Stored on
   the ROOF record itself (roof.labelPos, {lat,lng} or null/absent =
   "use the default centroid"), not per-outline -- a deliberate position
   choice should survive Edit Shape/re-tracing the same roof, not silently
   reset just because the shape changed. Same plain client write every
   other roof-level tweak in this app uses (rename, feature placement) --
   cosmetic metadata, not admin-gated. Called from roofLabelMarker()'s
   onDragEnd wherever the currently-linked roof's label is drawn. See
   "Draggable roof labels" in DEV_NOTES.md. */
async function rmSaveRoofLabelPos(buildingId, roofId, pos){
  if (!fdb) return;
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var idx = roofs.findIndex(function(r){ return r.id === roofId; });
    if (idx === -1) return;
    roofs[idx] = Object.assign({}, roofs[idx], { labelPos: { lat: pos.lat, lng: pos.lng }, updatedAt: Date.now() });
    await saveBuildingRoofs(buildingId, roofs);
    /* Surface the reset option immediately -- shouldn't take a reopen to
       discover it after the very drag that created a custom position. */
    if (rmState.linkedRoofId === roofId){
      rmState.roofLabelHasCustomPos = true;
      rmSetDisp("rm-reset-label-btn", true);
    }
  }catch(e){ toast("Label moved on screen, but couldn't save the position: " + e.message); }
}
/* Reset button (rm-reset-label-btn) -- only shown once a custom position
   actually exists (rmState.roofLabelHasCustomPos). Clears labelPos and
   redraws at the recomputed centroid, same as a roof that was never
   dragged in the first place. */
async function rmResetRoofLabelPos(){
  var buildingId = rmState.linkedBuildingId, roofId = rmState.linkedRoofId;
  if (!buildingId || !roofId || !rmState.outline) return;
  toast("Resetting label position…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var idx = roofs.findIndex(function(r){ return r.id === roofId; });
    if (idx === -1) return;
    roofs[idx] = Object.assign({}, roofs[idx], { labelPos: null, updatedAt: Date.now() });
    await saveBuildingRoofs(buildingId, roofs);
    var center = rmState.outline.center || rmGeomRingCentroid(rmState.outline.ring);
    if (rmState.map && rmState.roofLabelLayer){
      rmState.map.removeLayer(rmState.roofLabelLayer);
      rmState.roofLabelLayer = roofLabelMarker(center.lat, center.lng, roofs[idx].label || "Roof", rmRenameLinkedRoof,
        function(pos){ rmSaveRoofLabelPos(buildingId, roofId, pos); }).addTo(rmState.map);
    }
    rmState.roofLabelHasCustomPos = false;
    rmSetDisp("rm-reset-label-btn", false);
    toast("Label reset to default position ✓");
  }catch(e){ toast("Couldn't reset label position: " + e.message); }
}
async function rmRenameLinkedRoof(){
  var buildingId = rmState.linkedBuildingId, roofId = rmState.linkedRoofId;
  if (!buildingId || !roofId){ toast("Save this roof first, then you can rename it."); return; }
  toast("Loading roof…");
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
    /* Redraw in place at the same spot -- getLatLng() rather than
       re-deriving from rmState.outline, so this works even if the outline
       object has since changed shape (e.g. mid Edit Shape). */
    if (rmState.map && rmState.roofLabelLayer){
      var pos = rmState.roofLabelLayer.getLatLng();
      rmState.map.removeLayer(rmState.roofLabelLayer);
      rmState.roofLabelLayer = roofLabelMarker(pos.lat, pos.lng, label, rmRenameLinkedRoof,
        function(newPos){ rmSaveRoofLabelPos(buildingId, roofId, newPos); }).addTo(rmState.map);
    }
    var sel = document.getElementById("rm-roof-select");
    if (sel){
      var opt = sel.querySelector('option[value="' + roofId + '"]');
      if (opt) opt.textContent = label;
    }
    toast("Roof renamed ✓");
  }catch(e){ toast("Couldn't rename roof: " + e.message); }
}

/* ---- Split a roof outline into multiple labeled roof sections
   ("blob-splitting") -- interactive/UI side. See rmSplitRingByChord() and
   its neighboring geometry helpers above for the actual math, and "Split
   a roof outline into labeled sections" in DEV_NOTES.md for the full
   picture. Only offered BEFORE an outline is saved to a real roof --
   #rm-split-btn is hidden once linked (rmUpdateControlVisibility()). */
var rmSplitState = {
  active: false,     /* currently picking the two boundary points for a split-in-progress */
  targetIndex: -1,   /* -1 = splitting rmState.outline itself (the very first split); >=0 = splitting sections[targetIndex] further */
  points: [],        /* 0-2 {lat,lng} points tapped so far for the split-in-progress, already snapped onto the boundary */
  pointMarkers: [],
  chordLine: null,
  clickHandler: null,
  sections: null,    /* null until the first split is confirmed; then an array of {id,label,ring,areaSqFt,perimeterFt,center} */
  displayLayerGroup: null,
  savingAll: false   /* true only while rm-save-modal is open FOR a "Save All Sections" action -- see rmSaveAllSplitSections() */
};
var RM_SPLIT_COLORS = ["#8E24AA", "#00897B", "#3949AB", "#C0CA33", "#D81B60", "#546E7A", "#6D4C41", "#00ACC1"];
function rmSplitCurrentRing(){
  return rmSplitState.targetIndex === -1 ? rmState.outline.ring : rmSplitState.sections[rmSplitState.targetIndex].ring;
}
function rmStartSplitting(targetIndex){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  if (targetIndex === -1 && rmSplitState.sections){
    toast('Already splitting this outline — use "Split Further" on one of the sections below.');
    return;
  }
  rmSplitCancelPicking(); /* clean up any stray in-progress state from a previous attempt */
  rmSplitState.active = true;
  rmSplitState.targetIndex = targetIndex;
  rmSplitState.points = [];
  var map = rmEnsureMap();
  rmSplitState.clickHandler = function(e){ rmSplitAddPoint(e.latlng); };
  map.on("click", rmSplitState.clickHandler);
  rmSetPrecisionMode(true);
  rmRenderSplitPanel();
}
function rmSplitAddPoint(latlng){
  var ring = rmSplitCurrentRing();
  var hit = rmNearestRingBoundaryPoint(ring, latlng);
  rmSplitState.points.push({ lat: hit.lat, lng: hit.lng });
  var marker = L.circleMarker([hit.lat, hit.lng], {
    radius: 8, color: "#fff", weight: 2, fillColor: "#212121", fillOpacity: 1
  }).addTo(rmState.map);
  rmSplitState.pointMarkers.push(marker);
  if (rmSplitState.points.length === 2){
    var p1 = rmSplitState.points[0], p2 = rmSplitState.points[1];
    if (rmSplitState.chordLine) rmState.map.removeLayer(rmSplitState.chordLine);
    rmSplitState.chordLine = L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], {
      color: "#212121", weight: 3, dashArray: "8,6"
    }).addTo(rmState.map);
  }
  rmRenderSplitPanel();
}
function rmSplitUndoPoint(){
  if (!rmSplitState.points.length) return;
  rmSplitState.points.pop();
  var marker = rmSplitState.pointMarkers.pop();
  if (marker && rmState.map) rmState.map.removeLayer(marker);
  if (rmSplitState.chordLine){ rmState.map.removeLayer(rmSplitState.chordLine); rmSplitState.chordLine = null; }
  rmRenderSplitPanel();
}
function rmSplitCancelPicking(){
  if (rmSplitState.clickHandler && rmState.map) rmState.map.off("click", rmSplitState.clickHandler);
  rmSplitState.clickHandler = null;
  rmSplitState.active = false;
  rmSplitState.points = [];
  if (rmState.map){
    rmSplitState.pointMarkers.forEach(function(m){ rmState.map.removeLayer(m); });
    if (rmSplitState.chordLine) rmState.map.removeLayer(rmSplitState.chordLine);
  }
  rmSplitState.pointMarkers = [];
  rmSplitState.chordLine = null;
  rmSetPrecisionMode(false);
  rmRenderSplitPanel();
}
function rmConfirmSplit(){
  if (rmSplitState.points.length !== 2){ toast("Tap two points on the outline first."); return; }
  var ring = rmSplitCurrentRing();
  var result = rmSplitRingByChord(ring, rmSplitState.points[0], rmSplitState.points[1]);
  if (result.error){ toast(result.error); return; }
  var baseLabel = rmSplitState.targetIndex === -1 ? null : rmSplitState.sections[rmSplitState.targetIndex].label;
  var labelA = baseLabel === null ? "Roof A" : (baseLabel + "1");
  var labelB = baseLabel === null ? "Roof B" : (baseLabel + "2");
  var sectionA = rmMakeSplitSection(result.ringA, labelA);
  var sectionB = rmMakeSplitSection(result.ringB, labelB);
  if (rmSplitState.targetIndex === -1) rmSplitState.sections = [sectionA, sectionB];
  else rmSplitState.sections.splice(rmSplitState.targetIndex, 1, sectionA, sectionB);
  rmSplitCancelPicking(); /* clears points/handler; leaves rmSplitState.sections intact */
  rmDrawSplitSections();
  toast("Split into " + rmSplitState.sections.length + " sections ✓");
}
function rmSplitSetLabel(index, value){
  if (!rmSplitState.sections || !rmSplitState.sections[index]) return;
  rmSplitState.sections[index].label = value;
}
function rmDiscardSplit(){
  rmSplitCancelPicking();
  rmSplitState.sections = null;
  rmSplitState.targetIndex = -1;
  if (rmState.map && rmSplitState.displayLayerGroup) rmState.map.removeLayer(rmSplitState.displayLayerGroup);
  rmSplitState.displayLayerGroup = null;
  rmRenderSplitPanel();
}
/* Full reset -- called whenever a fresh outline is captured/loaded or the
   working outline is torn down (same principle as rmClearLinkedFeatures()),
   and after a split-sections save completes, so stale split state never
   bleeds into an unrelated later outline. */
function rmClearSplitState(){
  rmSplitCancelPicking();
  rmSplitState.sections = null;
  rmSplitState.targetIndex = -1;
  rmSplitState.savingAll = false;
  if (rmState.map && rmSplitState.displayLayerGroup) rmState.map.removeLayer(rmSplitState.displayLayerGroup);
  rmSplitState.displayLayerGroup = null;
  var panel = document.getElementById("rm-split-panel");
  if (panel) panel.innerHTML = "";
}
function rmDrawSplitSections(){
  var map = rmState.map;
  if (!map || !rmSplitState.sections) return;
  if (rmSplitState.displayLayerGroup) map.removeLayer(rmSplitState.displayLayerGroup);
  rmSplitState.displayLayerGroup = L.layerGroup().addTo(map);
  rmSplitState.sections.forEach(function(sec, i){
    var color = RM_SPLIT_COLORS[i % RM_SPLIT_COLORS.length];
    L.polygon(sec.ring.map(function(p){ return [p.lat, p.lng]; }), {
      color: color, weight: 3, fillColor: color, fillOpacity: 0.35
    }).addTo(rmSplitState.displayLayerGroup);
    L.marker([sec.center.lat, sec.center.lng], {
      icon: L.divIcon({
        className: "", iconSize: null,
        html: '<div style="background:' + color + ';color:#fff;padding:3px 8px;border-radius:5px;' +
          'font-size:11px;font-weight:700;white-space:nowrap;transform:translate(-50%,-50%);' +
          'box-shadow:0 1px 4px rgba(0,0,0,.45);border:1.5px solid rgba(255,255,255,.85)">' +
          esc(sec.label) + '</div>'
      }),
      interactive: false
    }).addTo(rmSplitState.displayLayerGroup);
  });
}
/* Case/whitespace-insensitive duplicate check among the PENDING sections
   themselves -- nothing in Firestore to compare against yet at this point.
   rmSuggestUniqueRoofLabel() is reused for the same collision logic once
   they're actually being saved to a building's EXISTING roofs, see
   rmSaveSplitSectionsToBuilding() below. */
function rmSplitFindDuplicateLabels(){
  if (!rmSplitState.sections) return [];
  var seen = {}, dupes = [];
  rmSplitState.sections.forEach(function(sec){
    var key = String(sec.label || "").trim().toLowerCase();
    if (seen[key]) dupes.push(sec.label);
    seen[key] = true;
  });
  return dupes;
}
function rmRenderSplitPanel(){
  var panel = document.getElementById("rm-split-panel");
  if (!panel) return;
  if (rmSplitState.active){
    var n = rmSplitState.points.length;
    panel.innerHTML = '<div class="card" style="margin-top:10px">' +
      '<p class="hint" style="margin:0 0 8px">✂️ Tap two points on the roof’s outline to draw a split line (' +
      n + '/2 picked).</p>' +
      '<div class="btnrow" style="margin:0">' +
      (n > 0 ? '<button class="btn" onclick="rmSplitUndoPoint()">↩️ Undo Last Point</button>' : '') +
      (n === 2 ? '<button class="btn primary" onclick="rmConfirmSplit()">✓ Confirm Split</button>' : '') +
      '<button class="btn" onclick="rmSplitCancelPicking()">✕ Cancel</button>' +
      '</div></div>';
    return;
  }
  if (!rmSplitState.sections){ panel.innerHTML = ""; return; }
  var dupes = rmSplitFindDuplicateLabels();
  panel.innerHTML = '<div class="card" style="margin-top:10px">' +
    '<h2 class="cond" style="font-size:15px;margin:0 0 8px">Roof Sections (' + rmSplitState.sections.length + ')</h2>' +
    (dupes.length ? '<p class="rm-status warn" style="margin:0 0 8px">⚠️ Two or more sections are named "' +
      esc(dupes[0]) + '" — rename one before saving.</p>' : '') +
    rmSplitState.sections.map(function(sec, i){
      var color = RM_SPLIT_COLORS[i % RM_SPLIT_COLORS.length];
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
        '<span style="width:14px;height:14px;border-radius:3px;background:' + color + ';flex:none"></span>' +
        '<input type="text" value="' + esc(sec.label) + '" style="flex:1;min-width:120px" ' +
        'onchange="rmSplitSetLabel(' + i + ', this.value)">' +
        '<span class="hint" style="margin:0">' + sec.areaSqFt.toFixed(0) + ' sq ft</span>' +
        '<button class="btn" onclick="rmStartSplitting(' + i + ')">✂️ Split Further</button>' +
        '</div>';
    }).join('') +
    '<div class="btnrow" style="margin-top:8px">' +
    '<button class="btn primary" onclick="rmSaveAllSplitSections()">💾 Save All ' + rmSplitState.sections.length +
    ' Sections as Roofs</button>' +
    '<button class="btn" onclick="rmDiscardSplit()">✕ Discard Split, Keep Single Outline</button>' +
    '</div></div>';
}
function rmSaveAllSplitSections(){
  if (!rmSplitState.sections || !rmSplitState.sections.length){ toast("Nothing to save — split the outline first."); return; }
  var dupes = rmSplitFindDuplicateLabels();
  if (dupes.length){ toast('Two sections are named "' + dupes[0] + '" — rename one before saving.'); return; }
  /* Splitting an outline that's ALREADY a saved, linked roof (opened via
     rmOpenRoofInMapper() or just-saved) -- the building is already known,
     no picker needed. See rmSaveSplitSectionsToExistingRoof() below. */
  if (rmState.linkedBuildingId && rmState.linkedRoofId){
    rmSaveSplitSectionsToExistingRoof(rmState.linkedBuildingId, rmState.linkedRoofId);
    return;
  }
  rmSplitState.savingAll = true;
  openRmSaveModal();
}
/* Saves every pending section as its OWN new roof on buildingId, in one
   Firestore write (mirrors rmAddRoofAndSave()'s shape for each roof, but
   batched -- one saveBuildingRoofs() call for all of them rather than N
   separate round-trips). Duplicate-name collisions against roofs that
   ALREADY exist on this building (not visible to the tech until they pick
   it) are auto-resolved silently via the same rmSuggestUniqueRoofLabel()
   used everywhere else, then reported by name in the final toast rather
   than interrupting a batch save with N blocking dialogs -- collisions
   among the pending sections THEMSELVES are still caught up front by
   rmSplitFindDuplicateLabels() in rmSaveAllSplitSections(), where a
   blocking dialog is actually actionable (the tech is looking right at
   both names). */
async function rmSaveSplitSectionsToBuilding(buildingId){
  var sections = rmSplitState.sections;
  if (!sections || !sections.length){ toast("Nothing to save."); return; }
  toast("Saving " + sections.length + " roof sections…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var baseOutline = rmState.outline || {};
    var renamed = [];
    var created = sections.map(function(sec){
      var check = rmSuggestUniqueRoofLabel(roofs, sec.label, null);
      var label = check.isDuplicate ? check.suggestion : sec.label;
      if (check.isDuplicate) renamed.push(sec.label + " → " + label);
      var outlineEntry = {
        id: genId("rmo"), ring: sec.ring, areaSqFt: sec.areaSqFt, perimeterFt: sec.perimeterFt,
        center: sec.center, source: baseOutline.source, tags: baseOutline.tags || {},
        isSiteBoundary: false, calibration: baseOutline.calibration || null, createdAt: Date.now()
      };
      var newRoof = {
        id: genId("roof"), label: label, roofSystem: "",
        roof_base_map_type: null, roof_base_map_url: null, roof_base_map_bounds: null,
        roof_assets: [], roof_outlines: [outlineEntry], createdAt: Date.now(), updatedAt: Date.now()
      };
      roofs.push(newRoof); /* so later sections' dup-check sees earlier ones from THIS SAME batch too */
      return { roof: newRoof, outlineEntry: outlineEntry };
    });
    await saveBuildingRoofs(buildingId, roofs);
    toast(sections.length + " roof sections saved" +
      (renamed.length ? " (" + renamed.join(", ") + " — already used on this building)" : "") + " ✓");
    closeRmSaveModal();
    /* Land on the LAST new roof -- same "stay in RoofMapper" pattern as a
       normal single-outline save (rmSaveOutlineToBuilding()). */
    var last = created[created.length - 1];
    rmState.linkedBuildingId = buildingId;
    rmState.linkedRoofId = last.roof.id;
    rmState.pendingBuildingId = null;
    rmState.pendingBuildingName = null;
    rmState.outline = Object.assign({}, last.outlineEntry);
    if (rmState.map){
      if (rmState.outlineLayer) rmState.map.removeLayer(rmState.outlineLayer);
      rmState.outlineLayer = L.polygon(last.outlineEntry.ring.map(function(p){ return [p.lat, p.lng]; }), {
        color: "#E8600A", weight: 3, fillColor: "#E8600A", fillOpacity: 0.15
      }).addTo(rmState.map);
      rmDrawEdgeDimensions(rmState.outline);
      if (rmState.roofLabelLayer) rmState.map.removeLayer(rmState.roofLabelLayer);
      rmState.roofLabelLayer = roofLabelMarker(
        last.outlineEntry.center.lat, last.outlineEntry.center.lng, last.roof.label, rmRenameLinkedRoof,
        function(pos){ rmSaveRoofLabelPos(buildingId, last.roof.id, pos); }
      ).addTo(rmState.map);
    }
    rmState.roofLabelHasCustomPos = false;
    rmSetDisp("rm-reset-label-btn", false);
    rmClearSplitState();
    rmRenderOutlineStats(rmState.outline);
    rmShowFeaturePanel(bld.name);
    await rmLoadLinkedAssets();
    rmUpdateExportHint();
    rmUpdateControlVisibility();
  }catch(e){ toast("Couldn't save the split sections: " + e.message); }
}
/* Splitting a roof that's ALREADY saved/linked -- the gap the previous
   pass deliberately left ("replacing one real roof's history with several
   is a different, more involved operation"). Rather than discard the
   existing roof and create N fresh ones (which would orphan its
   roof_assets[]/building_history_events history for no reason), the FIRST
   section keeps the existing roof's id/label/history — its outline just
   gets a new roof_outlines[] entry (same "append-only, newest is current"
   convention every other outline edit uses) reflecting the split shape.
   Only sections[1..] become genuinely NEW roofs, same per-section shape
   rmSaveSplitSectionsToBuilding() already builds for the never-saved case.
   Existing features/pins on the original roof are NOT reassigned to
   whichever new section they might now geometrically sit in -- that's a
   real, flagged limitation (see the confirm text below), not a silent
   gap: automatically figuring out which section an existing pin now
   belongs to is a materially harder point-in-polygon problem, and the
   tech can already move a feature by hand via the existing asset editor
   if a split roof needs it. See "Split an already-saved roof" in
   DEV_NOTES.md. */
async function rmSaveSplitSectionsToExistingRoof(buildingId, roofId){
  var sections = rmSplitState.sections;
  if (!sections || !sections.length){ toast("Nothing to save."); return; }
  var extraCount = sections.length - 1;
  if (!confirm("Split this roof into " + sections.length + " sections?\n\n" +
    "“" + sections[0].label + "” keeps this roof's existing history/features. " +
    extraCount + " new roof" + (extraCount === 1 ? "" : "s") + " " +
    (extraCount === 1 ? "gets" : "get") + " created for the rest, starting with no history of " +
    "its own. Any EXISTING feature/pin on this roof stays with “" + sections[0].label +
    "” — move it by hand afterward (tap it → Edit) if it actually belongs on a different section.")) return;
  toast("Saving " + sections.length + " roof sections…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var origIdx = roofs.findIndex(function(r){ return r.id === roofId; });
    if (origIdx === -1) throw new Error("couldn't find the original roof");
    var origRoof = roofs[origIdx];
    var baseOutline = rmState.outline || {};

    /* Section 0 -- update the EXISTING roof in place: new outline entry
       appended (never overwrites/removes the old one -- append-only, same
       as every other outline edit), rename only if the split panel's label
       for this section actually differs from what the roof's already
       called (dup-checked against every OTHER roof, excluding itself). */
    var primaryOutline = {
      id: genId("rmo"), ring: sections[0].ring, areaSqFt: sections[0].areaSqFt, perimeterFt: sections[0].perimeterFt,
      center: sections[0].center, source: baseOutline.source, tags: baseOutline.tags || {},
      isSiteBoundary: false, calibration: baseOutline.calibration || null, createdAt: Date.now()
    };
    origRoof.roof_outlines = (origRoof.roof_outlines || []).concat([primaryOutline]);
    var renamed = [];
    if ((origRoof.label || "Roof").trim() !== sections[0].label.trim()){
      var otherRoofs = roofs.filter(function(r){ return r.id !== roofId; });
      var check0 = rmSuggestUniqueRoofLabel(otherRoofs, sections[0].label, null);
      var newLabel0 = check0.isDuplicate ? check0.suggestion : sections[0].label;
      if (check0.isDuplicate) renamed.push(sections[0].label + " → " + newLabel0);
      origRoof.label = newLabel0;
    }
    /* A split fundamentally changes this roof's shape/size -- any custom
       label position dragged for the OLD (unsplit, larger) outline could
       easily land outside or make no sense on the new, smaller section.
       Reset to the recomputed centroid rather than carry over a
       now-potentially-nonsensical position; still draggable again from
       there if it needs a further nudge. */
    origRoof.labelPos = null;
    origRoof.updatedAt = Date.now();
    roofs[origIdx] = origRoof;

    /* Sections 1..N -- brand new roofs, same shape/dup-checking
       rmSaveSplitSectionsToBuilding() already uses for the never-saved
       case, just starting from index 1 instead of 0. */
    var createdExtra = sections.slice(1).map(function(sec){
      var check = rmSuggestUniqueRoofLabel(roofs, sec.label, null);
      var label = check.isDuplicate ? check.suggestion : sec.label;
      if (check.isDuplicate) renamed.push(sec.label + " → " + label);
      var outlineEntry = {
        id: genId("rmo"), ring: sec.ring, areaSqFt: sec.areaSqFt, perimeterFt: sec.perimeterFt,
        center: sec.center, source: baseOutline.source, tags: baseOutline.tags || {},
        isSiteBoundary: false, calibration: baseOutline.calibration || null, createdAt: Date.now()
      };
      var newRoof = {
        id: genId("roof"), label: label, roofSystem: "",
        roof_base_map_type: null, roof_base_map_url: null, roof_base_map_bounds: null,
        roof_assets: [], roof_outlines: [outlineEntry], createdAt: Date.now(), updatedAt: Date.now()
      };
      roofs.push(newRoof);
      return newRoof;
    });

    await saveBuildingRoofs(buildingId, roofs);
    toast(sections.length + " roof sections saved" +
      (renamed.length ? " (" + renamed.join(", ") + " — already used on this building)" : "") + " ✓");

    /* Stay on the PRIMARY section (same roof id as before the split) --
       redraw its (possibly renamed) label and updated outline in place. */
    rmState.outline = Object.assign({}, primaryOutline);
    var map = rmEnsureMap();
    if (rmState.outlineLayer) map.removeLayer(rmState.outlineLayer);
    rmState.outlineLayer = L.polygon(primaryOutline.ring.map(function(p){ return [p.lat, p.lng]; }), {
      color: "#E8600A", weight: 3, fillColor: "#E8600A", fillOpacity: 0.15
    }).addTo(map);
    rmDrawEdgeDimensions(rmState.outline);
    if (rmState.roofLabelLayer) map.removeLayer(rmState.roofLabelLayer);
    rmState.roofLabelLayer = roofLabelMarker(
      primaryOutline.center.lat, primaryOutline.center.lng, origRoof.label, rmRenameLinkedRoof,
      function(pos){ rmSaveRoofLabelPos(buildingId, roofId, pos); }
    ).addTo(map);
    rmState.roofLabelHasCustomPos = false;
    rmSetDisp("rm-reset-label-btn", false);
    rmClearSplitState();
    rmRenderOutlineStats(rmState.outline);
    await rmLoadLinkedAssets();
    rmUpdateExportHint();
    rmUpdateControlVisibility();
    rmRenderRoofSwitcher(buildingId, roofs, roofId);
    rmRenderExportRoofSelect(buildingId, roofs, roofId);
    await rmDrawReferenceRoofs(buildingId, bld, roofId);
  }catch(e){ toast("Couldn't save the split sections: " + e.message); }
}

function rmConfirmSiteBoundarySave(){
  if (!rmState.outline || !rmState.outline.isSiteBoundary) return true;
  return confirm("This outline is the property/site boundary, not an individual building roof — " +
    "OpenStreetMap doesn't have a building footprint here yet. Save it anyway as a rough placeholder?");
}
async function rmSaveOutlineToBuilding(buildingId, roofId){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  if (!rmConfirmSiteBoundarySave()) return;
  toast("Saving…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    /* roofId comes from rmChooseBuildingForSave's picker (always shown for
       an existing building, including "+ Add a new roof…" -- see
       "Individual-roof tracing + labels" in DEV_NOTES.md); undefined only
       for a brand-new building from rmCreateBuildingAndSave, where the
       first roof is unambiguous. */
    var roof = roofs.find(function(r){ return r.id === roofId; }) || roofs[0];
    var entry = Object.assign({}, rmState.outline, { id: genId("rmo") });
    roof.roof_outlines = (roof.roof_outlines || []).concat([entry]);
    /* Record the saved id back onto the in-memory outline so a later
       rmCalibrateEdge() call can find+update this exact saved entry
       instead of only updating the on-screen copy. See "Self-scaling
       dimension calibration" in DEV_NOTES.md. */
    rmState.outline.id = entry.id;
    var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
    roofs[roofIdx] = roof;
    await saveBuildingRoofs(buildingId, roofs);
    toast("Roof outline saved — add features to it right here ✓");
    closeRmSaveModal();
    rmClearSplitState(); /* this outline is now itself a saved roof -- any pending split of it (a different way of saving the same shape) no longer applies */
    /* Phase 2 of the RoofMapper <-> Roof Map unification: RoofMapper is now
       the unified surface, so stay right here instead of routing away to
       Building History (Phase 1's behavior, superseded) -- map the roof,
       then mark it up on that same roof. rmShowFeaturePanel() reveals the
       "+ Add Feature" card and rmLoadLinkedAssets() draws any existing
       features for this roof inline on rmState.map. Building History's own
       Roof Map still shows the same outline/features unchanged (it reads
       the same roof_outlines[]/roof_assets[] arrays) for anyone who opens
       the building from there instead. */
    rmState.linkedBuildingId = buildingId;
    rmState.linkedRoofId = roof.id;
    /* This save just consumed whatever fast-path rmEnterMultiRoofCapture()
       set up (if any) -- linkedBuildingId above is now the authoritative
       "what building am I on" for the next "Trace Another Roof" tap, which
       re-derives a fresh pendingBuildingId of its own. Clearing here stops
       a stale "Continuing on X" banner from lingering into an unrelated
       later outline. */
    rmState.pendingBuildingId = null;
    rmState.pendingBuildingName = null;
    /* Persistent label on the outline just saved, using the roof it was
       actually saved to -- so Mark sees which roof this is at a glance,
       not just in the picker dropdown. See "Individual-roof tracing +
       labels" in DEV_NOTES.md. */
    if (rmState.map){
      if (rmState.roofLabelLayer) rmState.map.removeLayer(rmState.roofLabelLayer);
      /* Custom dragged position (roof.labelPos) wins over the recomputed
         centroid if this roof already has one -- e.g. re-saving a new
         outline version onto a roof that was already positioned/labeled
         earlier. See rmSaveRoofLabelPos()/"Draggable roof labels" in
         DEV_NOTES.md. */
      var labelCenter = roof.labelPos || rmState.outline.center || rmGeomRingCentroid(rmState.outline.ring);
      /* onClick makes this specific label (RoofMapper's own linked-roof
         label, not Building History's read-only map) tappable to rename --
         see rmRenameLinkedRoof() and roofLabelMarker()'s comment above.
         onDragEnd makes it draggable, persisting the new position. */
      rmState.roofLabelLayer = roofLabelMarker(labelCenter.lat, labelCenter.lng, roof.label || "Roof", rmRenameLinkedRoof,
        function(pos){ rmSaveRoofLabelPos(buildingId, roof.id, pos); }).addTo(rmState.map);
      rmState.roofLabelHasCustomPos = !!roof.labelPos;
      rmSetDisp("rm-reset-label-btn", !!roof.labelPos);
    }
    rmRenderRoofSwitcher(buildingId, roofs, roof.id);
    rmRenderExportRoofSelect(buildingId, roofs, roof.id);
    rmShowFeaturePanel(bld.name);
    await rmLoadLinkedAssets();
    rmUpdateExportHint();
    /* Mark: "after I saved it, the add features should just pop up right
       below the map -- there's no sense in having all this other stuff on
       here." rmState.linkedBuildingId is set above, so this now hides the
       search/mode-switch controls and the footprint panel -- #rm-features-
       panel (already shown by rmShowFeaturePanel() above) sits right after
       the map in the DOM, so it's the very next thing visible. */
    rmUpdateControlVisibility();
    /* Finding A, part 2: if this outline was traced on an uploaded drone
       image, retain that image with the roof so it can be reopened later
       -- deliberately AFTER the outline itself is confirmed saved (the
       outline always saves regardless of whether this next step
       succeeds). See rmPersistOrthoBaseMap() and "Ortho upload: persist
       with the roof for reopening" in DEV_NOTES.md. */
    if (rmState.orthoActive) rmPersistOrthoBaseMap(buildingId, roof.id);
    if (rmState.kmlOverlayActive) rmPersistKmlGroundOverlayBaseMap(buildingId, roof.id);
  }catch(e){ toast("Couldn't save: " + e.message); }
}
/* THE fix for "RoofMapper can't reopen a saved roof" -- Mark refreshed,
   went back into RoofMapper for a roof Building History shows intact and
   saved, and got a blank map: NO code path anywhere in RoofMapper ever
   loaded a previously-saved roof_outlines[] entry back onto the map --
   every entry point (address search, GPS, rmEnterMultiRoofCapture) only
   ever starts a NEW trace. A saved roof was effectively stranded: visible,
   but not editable/exportable/addable-to without retracing from scratch.
   This is the one real "open" path, shared by Building History's "Open in
   RoofMapper" button and RoofMapper's own roof switcher. Deliberately
   never touches GPS/rmUseMyLocation/rmSearchBuildings -- Mark's other live
   complaint, "don't re-locate a building I already mapped" -- the saved
   outline's own coordinates ARE the location; there's nothing to search
   for. See "Reopen a saved roof in RoofMapper" in DEV_NOTES.md. */
async function rmOpenRoofInMapper(buildingId, roofId){
  if (currentViewName !== "roofmapper") showView("roofmapper");
  if (!fdb){ toast("Opening a saved roof needs cloud sync (internet connection)."); return; }
  toast("Opening roof…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roofs = getBuildingRoofs(bld);
    var roof = roofs.find(function(r){ return r.id === roofId; }) || roofs[0];
    if (!roof){ toast("Couldn't find that roof."); return; }
    var outlines = roof.roof_outlines || [];
    var outline = outlines[outlines.length - 1]; /* newest is current, same convention as everywhere else */
    if (!outline || !outline.ring || outline.ring.length < 3){
      toast((roof.label || "This roof") + " has no traced outline yet — use Trace Another Roof to add one.");
      return;
    }
    var map = rmEnsureMap();
    rmState.preserveOrthoOnClear = false; /* opening a roof always rebuilds its OWN base image below, never inherits whatever was on screen before */
    rmClearFootprintLayers(); /* full reset -- footprints/outline/linked state/ortho/geotiff, same clean slate rmEnterMultiRoofCapture() uses */
    var center = outline.center || rmGeomRingCentroid(outline.ring);
    rmState.lat = center.lat; rmState.lng = center.lng; rmState.accuracy = null;

    /* Base image, if this roof has one persisted -- BEFORE rmDrawFinalOutline()
       below so it's already on the map underneath the outline, not layered
       on top of it. */
    if (roof.roof_base_map_type === "drone_ortho" && roof.roof_base_map_url && roof.roof_base_map_bounds){
      var b = roof.roof_base_map_bounds;
      rmState.orthoOverlayLayer = L.imageOverlay(roof.roof_base_map_url, [[b.south, b.west], [b.north, b.east]]).addTo(map);
      rmState.orthoActive = true;
      rmState.orthoBounds = b;
    } else if (roof.roof_base_map_type === "sketch" && roof.roof_base_map_synthetic && roof.roof_base_map_url){
      /* RoofMapper's own persisted flat-canvas ortho (Finding A, part 2) --
         its lat/lng bounds were never stored in Firestore (only the image
         URL), but they're fully reconstructible: reload the image to read
         its real pixel dimensions, then rerun rmComputeOrthoBounds() with
         those same fixed constants -- deterministically identical to the
         bounds computed the day it was uploaded. A failure here (e.g. the
         image URL no longer resolves) doesn't block the roof itself from
         opening -- the outline loads regardless, just without its photo. */
      try{
        var dims = await new Promise(function(res, rej){
          var img = new Image();
          img.onload = function(){ res({ w: img.naturalWidth, h: img.naturalHeight }); };
          img.onerror = function(){ rej(new Error("couldn't reload the saved image")); };
          img.src = roof.roof_base_map_url;
        });
        var computed = rmComputeOrthoBounds(dims.w, dims.h);
        rmState.orthoOverlayLayer = L.imageOverlay(roof.roof_base_map_url, computed.latLngBounds).addTo(map);
        rmState.orthoActive = true;
        rmState.orthoDataUrl = roof.roof_base_map_url;
        rmState.orthoBounds = computed.orthoBounds;
      }catch(e){
        toast("Roof opened, but couldn't reload its saved drone image: " + e.message);
      }
    }
    /* Covers both branches above (and the plain-satellite "neither" case,
       where rmClearFootprintLayers() already reset orthoActive to false)
       in one call, now that this roof's base image state is fully
       resolved -- reopening a roof that HAS an ortho attached needs the
       same raised zoom ceiling a freshly-traced one gets. */
    rmUpdateMapZoomCap();
    /* roof_plan / hand-sketch base maps are x/y CRS.Simple -- Building
       History's own separate map instance only, a different/incompatible
       coordinate system from RoofMapper's real lat/lng map -- nothing to
       overlay here, the outline (always real lat/lng) still loads
       correctly below regardless. geotiff_trace outlines have no
       persisted base image at all yet (documented gap, see "GeoTIFF
       georeferenced ortho support" in DEV_NOTES.md) -- same result: outline
       loads on plain satellite, no photo underneath. */

    rmDrawFinalOutline(outline); /* draws the polygon, edge dims, zooms to it, renders stats -- also resets linked state, restored right after */
    rmState.linkedBuildingId = buildingId;
    rmState.linkedRoofId = roof.id;
    rmState.pendingBuildingId = null;
    rmState.pendingBuildingName = null;
    if (rmState.roofLabelLayer) map.removeLayer(rmState.roofLabelLayer);
    /* Restore wherever this roof's label was dragged to, if anywhere --
       see rmSaveRoofLabelPos()/"Draggable roof labels" in DEV_NOTES.md. */
    var labelCenter = roof.labelPos || outline.center || rmGeomRingCentroid(outline.ring);
    rmState.roofLabelLayer = roofLabelMarker(labelCenter.lat, labelCenter.lng, roof.label || "Roof", rmRenameLinkedRoof,
      function(pos){ rmSaveRoofLabelPos(buildingId, roof.id, pos); }).addTo(map);
    rmState.roofLabelHasCustomPos = !!roof.labelPos;
    rmSetDisp("rm-reset-label-btn", !!roof.labelPos);
    rmShowFeaturePanel(bld.name);
    await rmLoadLinkedAssets();
    rmUpdateExportHint();
    rmUpdateControlVisibility();
    rmRenderBaseMapStatus(roof.roof_base_map_type || null);
    /* Other roofs on this building as the dimmed reference layer -- same
       "see everything else while you work" a fresh trace gets, just as
       useful for context/vertex-snapping while editing an existing one. */
    await rmDrawReferenceRoofs(buildingId, bld, roof.id);
    rmRenderRoofSwitcher(buildingId, roofs, roof.id);
    rmRenderExportRoofSelect(buildingId, roofs, roof.id);
    rmSetStatus("Opened " + (roof.label || "this roof") + (rmState.orthoActive ? " on its saved drone image." : ".") +
      (roofs.length > 1 ? " " + roofs.length + " roofs on this building." : ""));
    setTimeout(function(){ map.invalidateSize(); }, 60);
  }catch(e){ toast("Couldn't open that roof: " + e.message); }
}
/* Mark: "on a multi-roof building he must be able to clearly pick WHICH
   roof he's editing... not obvious right now." A plain <select> at the top
   of the outline panel -- every roof on the building, current one
   pre-selected, switching calls rmOpenRoofInMapper() (the same "open" path
   Building History's own button uses) for whichever one is picked. Never
   shown for a single-roof building (nothing to switch between -- roofs.length
   check mirrors every other multi-roof-only control in this app, e.g.
   Building History's own roof picker). Cleared by rmClearLinkedFeatures()
   alongside the rest of the "roof is linked" UI whenever that link drops.
   See "Roof switcher" in DEV_NOTES.md. */
function rmRenderRoofSwitcher(buildingId, roofs, activeRoofId){
  var host = document.getElementById("rm-roof-switcher");
  if (!host) return;
  if (!roofs || roofs.length <= 1){ host.innerHTML = ""; return; }
  /* A light bordered box of its own -- not just a bare <select> -- so it
     reads as an intentional, prominent control sitting between the map
     and Roof Features, not a stray dropdown. Blue tint deliberately
     matches the roof-label marker's own color on the map (#1976D2), tying
     the two together visually as "the same roof-identity concept." */
  host.innerHTML = '<div style="background:#EAF2FB;border:1px solid #BBD6F0;border-radius:6px;padding:10px 12px;margin-bottom:12px">' +
    '<label style="display:block;font-size:12px;font-weight:700;color:#1976D2;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px">' +
    '🔀 Editing roof (' + roofs.length + ' on this building)</label>' +
    '<select onchange="rmOpenRoofInMapper(\'' + buildingId + '\', this.value)" style="width:100%;max-width:320px">' +
    roofs.map(function(r){
      return '<option value="' + esc(r.id) + '"' + (r.id === activeRoofId ? ' selected' : '') + '>' + esc(r.label || "Roof") + '</option>';
    }).join('') +
    '</select></div>';
}
async function rmCreateBuildingAndSave(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  var jobName = val("rm-new-jobname").trim();
  if (!jobName){ toast("Enter a building/job name."); return; }
  var billTo = val("rm-new-billto").trim();
  var tags = rmState.outline.tags || {};
  var addr = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  toast("Creating building…");
  try{
    var ids = await ensureCustomerAndBuilding({ jobName: jobName, billTo: billTo, location: addr });
    if (!ids.buildingId) throw new Error("couldn't create building (need internet connection)");
    if (rmSplitState.savingAll) await rmSaveSplitSectionsToBuilding(ids.buildingId);
    else await rmSaveOutlineToBuilding(ids.buildingId);
  }catch(e){ toast("Couldn't create building: " + e.message); }
}

/* ---- Phase 2: inline feature placement (drains, HVAC, scuppers, etc.) on
   the roof once its outline is linked to a building. Reuses the existing
   roof-asset placement engine (openAssetModal/openAssetModalSatellite) as-is
   -- nothing about placement itself is rebuilt, only routed to stay on
   RoofMapper instead of Building History (see closeAssetModal()'s
   assetModalReturnTo branch). Finding pins (leak/repair markup, tied to a
   specific work order's finding) aren't placeable from here -- there's no
   "current work order" in RoofMapper's context for a pin to belong to --
   they still get pinned from their work order as always, but do show up
   pulled into the full-roof export below once they exist. See "RoofMapper
   Phase 2" in DEV_NOTES.md. */
function rmShowFeaturePanel(buildingName){
  var panel = document.getElementById("rm-features-panel");
  if (!panel) return;
  panel.style.display = "";
  var markupPanel = document.getElementById("rm-markup-panel");
  if (markupPanel){ markupPanel.style.display = ""; rmRenderMarkupColorRow(); }
  var hint = document.getElementById("rm-features-hint");
  if (hint){
    hint.textContent = (buildingName ? "Linked to " + buildingName + ". " : "") +
      "Tap a marker on the map above to edit it, or add a new one. These are permanent roof fixtures " +
      "(drains, HVAC, scuppers, etc.); leak/repair findings still get pinned from their work order as before, " +
      "and everything shows up together in the exports above.";
  }
}
async function rmLoadLinkedAssets(){
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId || !fdb) return;
  try{
    var snap = await fdb.collection("buildings").doc(rmState.linkedBuildingId).get();
    var bld = snap.exists ? snap.data() : {};
    var roof = getRoofById(bld, rmState.linkedRoofId);
    rmDrawLinkedAssets(roof.roof_assets || []);
    rmDrawMarkups(roof.roof_markups || []);
    rmRenderBaseMapStatus(roof.roof_base_map_type || null);
  }catch(e){ toast("Couldn't load roof features: " + e.message); }
}
/* Custom base maps (roof plan/sketch/drone ortho) are a per-roof, admin-
   managed setting (renderBaseMapAdminCard() in Building History,
   clearRoofBaseMap() -> the SAME admin-gated set_building_roof_map path
   reused here, not rebuilt). RoofMapper's own map always shows satellite/
   street tiles regardless of this setting -- it never switches into the
   custom-base-map xy/CRS.Simple mode the way the Building History
   placement modal does. Surfaced here (admin-only, same as the Building
   History card) since Mark hit this while working from RoofMapper and had
   no obvious way to clear it from there. */
function rmRenderBaseMapStatus(baseMapType){
  var el = document.getElementById("rm-basemap-status");
  if (!el) return;
  if (!baseMapType){ el.innerHTML = ""; return; }
  el.innerHTML = "This roof has a custom base map set (" + esc(baseMapType.replace(/_/g," ")) +
    ") used for feature placement in Building History -- RoofMapper's own map above always shows " +
    "satellite/street imagery regardless." +
    (isAdmin ? ' <button class="btn danger" style="margin-left:6px" onclick="rmClearBaseMap()">🗑️ Clear Base Map (admin)</button>' : '');
}
function rmClearBaseMap(){
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId) return;
  clearRoofBaseMap(rmState.linkedBuildingId, rmState.linkedRoofId).then(rmLoadLinkedAssets);
}
function rmDrawLinkedAssets(assets){
  rmState.linkedAssetsCache = assets;
  var map = rmEnsureMap();
  if (rmState.assetLayerGroup) map.removeLayer(rmState.assetLayerGroup);
  rmState.assetLayerGroup = L.layerGroup().addTo(map);
  assets.forEach(function(a){
    /* Assets placed via a roof's custom base map (roof plan/sketch) have
       x/y, not lat/lng -- RoofMapper's map is always real lat/lng (OSM),
       same limitation as the outline itself, so those simply don't have a
       spot to show here. They're still saved correctly and still show on
       Building History's own roof map (which supports both coordinate
       systems) -- just not inline on this screen. */
    if (typeof a.lat !== "number" || typeof a.lng !== "number") return;
    var m = L.marker([a.lat, a.lng], { icon: assetIcon(a.type) }).addTo(rmState.assetLayerGroup);
    m._rmAssetId = a.id; /* so rmOpenFeatureForm can hide this exact marker while it's being edited */
    m.on("click", function(){ rmEditFeature(a.id); });
    /* Fast duplicate path (Mark: "point is speed when a roof has several of
       the same thing" -- multiple RTUs, a run of roof-fence sections,
       etc.) -- alongside the "📋 Duplicate" button in the edit form below,
       which is the more discoverable path for the same action. A dblclick
       is preceded by two ordinary click events (standard DOM behavior,
       not Leaflet-specific) so the edit form will briefly open/re-open
       before the duplicate itself fires and closes it again -- a minor
       visual blip, not a functional issue, and the form button avoids it
       entirely. stopPropagation keeps the double-click from ALSO
       triggering the map's own double-click-to-zoom underneath. See
       "Duplicate roof feature" in DEV_NOTES.md. */
    m.on("dblclick", function(e){
      L.DomEvent.stopPropagation(e);
      rmDuplicateFeature(a.id);
    });
  });
}

/* ---- Multi-roof: reference layer + "trace another roof" without leaving
   RoofMapper ----
   Mark, live on a roof: traced one roof, saved it, added features -- and
   had NO way to trace a SECOND roof without backing all the way out and
   re-entering RoofMapper (which also meant re-searching for the same
   building from scratch). This section fixes both the re-entry
   friction AND the "tracing roof #2 blind next to roof #1" problem by
   drawing the building's already-traced roofs (outlines AND their pins/
   features, not just outlines) on the map as a dimmed, labeled reference
   layer while the NEW roof is being traced. See "Multi-roof: stay in
   RoofMapper, trace another roof" in DEV_NOTES.md. */
function rmClearReferenceLayer(){
  if (rmState.map && rmState.referenceLayerGroup) rmState.map.removeLayer(rmState.referenceLayerGroup);
  rmState.referenceLayerGroup = null;
  rmState.referenceRings = [];
}
/* Dimmed variant of assetIcon() -- same shape/icon so a feature is still
   instantly recognizable, but muted color + reduced opacity so it reads as
   "already there" rather than competing with whatever's being placed on
   the roof actively being traced. */
function rmRefAssetIcon(type){
  var t = ROOF_ASSET_TYPES[type] || ROOF_ASSET_TYPES.other;
  return L.divIcon({
    className: "", iconSize: [22,22], iconAnchor: [11,11],
    html: '<div style="background:' + t.color + ';opacity:.55;color:#fff;width:22px;height:22px;border-radius:6px;' +
      'display:flex;align-items:center;justify-content:center;font-size:12px;border:1.5px solid #fff;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.3)">' + t.emoji + '</div>'
  });
}
/* Muted gray label -- deliberately distinct from BOTH roofLabelMarker()'s
   blue (the roof actively linked/being marked up) and the active trace's
   orange outline, so at a glance: gray = already mapped, orange = what
   you're tracing right now. */
function rmRefLabelMarker(lat, lng, text){
  return L.marker([lat, lng], {
    icon: L.divIcon({
      className: "", iconSize: null,
      html: '<div style="background:#607D8B;opacity:.85;color:#fff;padding:3px 9px;border-radius:5px;' +
        'font-size:11px;font-weight:700;white-space:nowrap;transform:translate(-50%,-50%);' +
        'box-shadow:0 1px 3px rgba(0,0,0,.35)">' + esc(text) + '</div>'
    }),
    interactive: false
  });
}
/* One query for every roof's pins (not one query per roof) -- same
   building_history_events source rmFetchExportOverlayData() reads,
   grouped by roofId client-side. */
async function rmFetchAllRoofsPinsGrouped(buildingId){
  var byRoof = {};
  if (!fdb) return byRoof;
  var qs = await fdb.collection("building_history_events")
    .where("buildingId", "==", buildingId).orderBy("createdAt", "desc").limit(50).get();
  qs.forEach(function(d){
    var e = d.data();
    (e.pins || []).forEach(function(p){
      if (typeof p.lat !== "number" || typeof p.lng !== "number") return; /* x/y custom-base-map pins have no spot here, same limitation as rmDrawLinkedAssets() */
      var rid = p.roofId || "roof_default";
      (byRoof[rid] = byRoof[rid] || []).push(p);
    });
  });
  return byRoof;
}
/* Draws every roof already on this building (each one's LATEST outline,
   its permanent roof_assets[], and its historical finding pins) as a
   dimmed reference layer. excludeRoofId skips one roof entirely (for the
   rare case this gets called while a roof is still actively linked);
   pass null to show all of them, which is the normal "about to trace a
   new one" case. Returns the combined lat/lng bounds of everything drawn
   (or null if the building has no traceable roofs yet), so the caller can
   fit/zoom the map to it. */
async function rmDrawReferenceRoofs(buildingId, bld, excludeRoofId){
  rmClearReferenceLayer();
  var map = rmEnsureMap();
  rmState.referenceLayerGroup = L.layerGroup().addTo(map);
  var roofs = getBuildingRoofs(bld || {}).filter(function(r){ return r.id !== excludeRoofId; });
  var pinsByRoof = await rmFetchAllRoofsPinsGrouped(buildingId);
  var bounds = [];
  roofs.forEach(function(roof){
    var outlines = roof.roof_outlines || [];
    var outline = outlines[outlines.length - 1]; /* newest is current, same convention as everywhere else */
    if (outline && outline.ring && outline.ring.length >= 3){
      L.polygon(outline.ring.map(function(p){ return [p.lat, p.lng]; }), {
        color: "#607D8B", weight: 2, dashArray: "6,4", fillColor: "#607D8B", fillOpacity: 0.08
      }).addTo(rmState.referenceLayerGroup);
      var labelCenter = roof.labelPos || outline.center || rmGeomRingCentroid(outline.ring);
      rmRefLabelMarker(labelCenter.lat, labelCenter.lng, roof.label || "Roof").addTo(rmState.referenceLayerGroup);
      outline.ring.forEach(function(p){ bounds.push([p.lat, p.lng]); });
      rmState.referenceRings.push(outline.ring); /* snap targets -- see rmFindSnapTarget() */
    }
    (roof.roof_assets || []).forEach(function(a){
      if (typeof a.lat !== "number" || typeof a.lng !== "number") return;
      L.marker([a.lat, a.lng], { icon: rmRefAssetIcon(a.type) }).addTo(rmState.referenceLayerGroup);
      bounds.push([a.lat, a.lng]);
    });
    (pinsByRoof[roof.id] || []).forEach(function(p){
      L.circleMarker([p.lat, p.lng], {
        radius: 6, color: "#fff", weight: 1.5, fillColor: warrantyColor(p.warranty), fillOpacity: 0.5
      }).addTo(rmState.referenceLayerGroup);
      bounds.push([p.lat, p.lng]);
    });
  });
  return bounds.length ? bounds : null;
}
/* ---- Vertex snapping ----
   Mark: "roof sections on a real building share boundaries exactly" --
   when tracing a new roof section adjacent to one already mapped, lock
   onto its existing corners (and, since a new section often butts partway
   along a wall rather than exactly at a corner, its edges too) so
   adjoining sections share EXACT vertices with no gaps or overlaps.
   Pixel-distance threshold (not a fixed real-world distance) so the snap
   radius feels the same regardless of zoom level -- "close enough
   on-screen to obviously mean this corner," not "close enough in feet,"
   which would feel wildly different zoomed in vs. out. Toggleable
   (rmState.snapEnabled, checkbox in the trace panel) since Mark explicitly
   wants a way to place a genuinely free point when that's intentional.
   See "Vertex snapping" in DEV_NOTES.md. */
var RM_SNAP_PIXEL_THRESHOLD = 18;
function rmProjectPointOntoSegment(p, a, b){
  var abx = b.x - a.x, aby = b.y - a.y;
  var lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return null;
  var t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  if (t < 0 || t > 1) return null; /* only the segment itself, not its infinite extension -- an edge doesn't attract a tap way past its own endpoint */
  return L.point(a.x + t * abx, a.y + t * aby);
}
/* Returns {lat, lng, type:"corner"|"edge"} for the closest snap candidate
   within RM_SNAP_PIXEL_THRESHOLD screen pixels of latlng, across every
   ring in rmState.referenceRings PLUS the current in-progress trace's own
   already-placed points (self-closure: Mark's own vertices need to lock
   to each other too, most importantly closing the loop back to the first
   point, but also any mid-trace point an outline happens to revisit), or
   null if nothing's close enough (the normal case away from any existing
   roof or own point -- most taps snap to nothing). */
function rmFindSnapTarget(latlng){
  if (!rmState.snapEnabled || !rmState.map) return null;
  var ownPoints = (rmTraceState.active && rmTraceState.points) ? rmTraceState.points : [];
  if (!rmState.referenceRings.length && !ownPoints.length) return null;
  var map = rmState.map;
  var tapPt = map.latLngToContainerPoint(latlng);
  /* Corners always win over edges when within threshold -- a tap near a
     vertex must land on that vertex's exact stored {lat,lng}, not on a
     numerically-nearby point re-derived from a pixel round-trip through
     the edge projection. Without this, the edge candidate for the segment
     touching that same corner (projected near its t=0/t=1 endpoint) can
     come out fractionally closer than the corner due to floating-point
     noise and win the "strictly less than" comparison, producing a snap
     that LOOKS locked but is off by a hair -- exactly the kind of drift
     that compounds into visible slivers/overlaps across many roof
     sections. So: find the best corner first; only fall back to edge
     search if no corner is within threshold at all. */
  var bestCorner = null, bestCornerDist = RM_SNAP_PIXEL_THRESHOLD;
  rmState.referenceRings.forEach(function(ring){
    for (var i = 0; i < ring.length - 1; i++){ /* ring is closed: ring[length-1] === ring[0] */
      var a = ring[i];
      var aPt = map.latLngToContainerPoint([a.lat, a.lng]);
      var dCorner = tapPt.distanceTo(aPt);
      if (dCorner < bestCornerDist){ bestCornerDist = dCorner; bestCorner = { lat: a.lat, lng: a.lng, type: "corner" }; }
    }
  });
  ownPoints.forEach(function(a){
    var aPt = map.latLngToContainerPoint([a.lat, a.lng]);
    var dCorner = tapPt.distanceTo(aPt);
    if (dCorner < bestCornerDist){ bestCornerDist = dCorner; bestCorner = { lat: a.lat, lng: a.lng, type: "corner" }; }
  });
  if (bestCorner) return bestCorner;
  var bestEdge = null, bestEdgeDist = RM_SNAP_PIXEL_THRESHOLD;
  rmState.referenceRings.forEach(function(ring){
    for (var i = 0; i < ring.length - 1; i++){
      var a = ring[i], b = ring[i + 1];
      var aPt = map.latLngToContainerPoint([a.lat, a.lng]);
      var bPt = map.latLngToContainerPoint([b.lat, b.lng]);
      var proj = rmProjectPointOntoSegment(tapPt, aPt, bPt);
      if (proj){
        var dEdge = tapPt.distanceTo(proj);
        if (dEdge < bestEdgeDist){
          bestEdgeDist = dEdge;
          var snappedLatLng = map.containerPointToLatLng(proj);
          bestEdge = { lat: snappedLatLng.lat, lng: snappedLatLng.lng, type: "edge" };
        }
      }
    }
  });
  return bestEdge;
}
/* Brief visual confirmation of where a snap landed -- a distinct yellow
   ring (not orange/blue/gray, all already meaning something else on this
   map: active trace, linked-roof label, reference layer) at the exact
   snapped point. Left in place (not auto-faded) until the next trace
   action replaces or clears it, so it's still visible as a reference
   while placing the next point nearby. */
function rmShowSnapIndicator(latlng){
  if (!rmState.map) return;
  if (rmState.snapIndicatorLayer) rmState.map.removeLayer(rmState.snapIndicatorLayer);
  rmState.snapIndicatorLayer = L.circleMarker([latlng.lat, latlng.lng], {
    radius: 11, color: "#FFD600", weight: 3, fillOpacity: 0, interactive: false
  }).addTo(rmState.map);
}
function rmClearSnapIndicator(){
  if (rmState.map && rmState.snapIndicatorLayer) rmState.map.removeLayer(rmState.snapIndicatorLayer);
  rmState.snapIndicatorLayer = null;
}
/* Best-known location for a building with no active trace yet -- tries,
   in order: (1) any existing roof's latest outline centroid [already-
   traced roofs are the most reliable signal, exactly what's about to be
   shown as the reference layer anyway], (2) a cached/geocoded address
   (geoCache, same field Buildings Near Me populates and reads), (3) a
   fresh geocode of the building's address if neither exists yet. Returns
   null (caller falls back to GPS) only if all three come up empty. */
async function rmGetBuildingKnownLocation(bld){
  var roofs = getBuildingRoofs(bld || {});
  for (var i = 0; i < roofs.length; i++){
    var outlines = roofs[i].roof_outlines || [];
    var outline = outlines[outlines.length - 1];
    if (outline && outline.center) return outline.center;
    if (outline && outline.ring && outline.ring.length) return rmGeomRingCentroid(outline.ring);
  }
  if (bld && bld.geoCache && typeof bld.geoCache.lat === "number") return { lat: bld.geoCache.lat, lng: bld.geoCache.lng };
  if (bld && bld.address){
    try{ var geo = await geocodeAddress(bld.address); if (geo) return geo; }catch(e){ /* fall through to GPS */ }
  }
  return null;
}
/* The shared entry point for BOTH ways into "trace another roof on this
   building": the "➕ Trace Another Roof" button shown right after a save
   (already inside RoofMapper), and Building History -> View Timeline ->
   "+ Add Roof" (previously a dead end -- see promptAddRoof() below).
   Switches to RoofMapper if needed, resets any in-progress
   trace/search/linked-roof state (but NOT the reference layer, which this
   function draws fresh right after), shows every already-traced roof on
   this building dimmed for reference, and zooms/fits the map to the best
   known location instead of leaving it at whatever wide/default view it
   would otherwise start at -- Mark: "it should open zoomed TO THE ROOF."
   rmState.pendingBuildingId/pendingBuildingName carry through to the next
   Save Outline modal so he doesn't have to search for this same building
   again either. */
async function rmEnterMultiRoofCapture(buildingId){
  if (currentViewName !== "roofmapper") showView("roofmapper");
  /* Continuing to trace on the SAME already-uploaded ortho for the SAME
     building (e.g. "Trace Another Roof" tapped right after saving a roof
     that was itself traced on an ortho)? Keep the image up instead of
     tearing it down -- he shouldn't have to re-upload/re-pick the same
     photo for every roof section on it, and it's what makes scale
     inheritance actually save him a step rather than just being a nice-
     to-know. See "Scale inheritance" in DEV_NOTES.md. */
  var continuingOrtho = (rmState.orthoActive || rmState.geoTiffActive || rmState.kmlOverlayActive) && rmState.linkedBuildingId === buildingId;
  rmState.preserveOrthoOnClear = continuingOrtho;
  rmClearFootprintLayers(); /* wipes any in-progress trace/search/linked-roof state */
  rmState.preserveOrthoOnClear = false;
  toast("Loading this building's roofs…");
  try{
    var snap = await fdb.collection("buildings").doc(buildingId).get();
    var bld = snap.exists ? snap.data() : {};
    rmState.pendingBuildingId = buildingId;
    rmState.pendingBuildingName = bld.name || "this building";
    var bounds = await rmDrawReferenceRoofs(buildingId, bld, null);
    if (continuingOrtho){
      /* Ortho/GeoTIFF overlay + its map position/zoom are already exactly
         right -- just restart tracing directly on it, same tail end
         rmStartOrthoTrace()/rmStartGeoTiffTrace() itself uses, no re-
         center/re-search. */
      var map2 = rmEnsureMap();
      rmTraceState.active = true;
      rmTraceState.mode = "manual";
      rmTraceState.points = [];
      rmTraceClickHandler = function(e){ rmTraceAddPoint(e.latlng); };
      map2.on("click", rmTraceClickHandler);
      rmShowTracePanel();
      rmSetStatus((rmState.geoTiffActive || rmState.kmlOverlayActive) ?
        "Tracing another roof on the same georeferenced image — existing roofs shown dimmed for reference. " +
          "✅ Scale set automatically, no calibration needed." :
        "Tracing another roof on the same drone image — existing roofs shown dimmed for reference." +
          (rmState.inheritedScaleFactorBuildingId === buildingId ? " Scale inherited — no need to re-measure." : ""));
      rmUpdateControlVisibility();
      return;
    }
    var map = rmEnsureMap();
    var center = await rmGetBuildingKnownLocation(bld);
    if (center){
      rmState.lat = center.lat; rmState.lng = center.lng; rmState.accuracy = 30;
      if (bounds && bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
      else map.setView([center.lat, center.lng], 20);
      setTimeout(function(){ map.invalidateSize(); }, 60);
      rmSetStatus("Tracing another roof on " + (bld.name || "this building") +
        " — existing roofs shown dimmed for reference. Search for a footprint here, or trace manually.", null,
        bounds ? ' <span class="rm-accuracy good">' + (getBuildingRoofs(bld).length) + ' roof' +
          (getBuildingRoofs(bld).length === 1 ? "" : "s") + ' already mapped</span>' : '');
      rmUpdateControlVisibility();
      rmSearchBuildings(); /* auto-search footprints here, same pattern rmUseMyLocation()/rmSearchByAddress() already use */
    } else {
      rmSetStatus("Tracing another roof on " + (bld.name || "this building") +
        " — couldn't find a known location yet, requesting GPS…");
      rmUseMyLocation();
    }
  }catch(e){ toast("Couldn't load this building: " + e.message); }
}
/* "➕ Trace Another Roof" -- shown in the features panel right after a
   save, alongside "🔧 Add Feature". Reads the building this outline was
   JUST saved to (rmState.linkedBuildingId) since that's the whole point:
   staying on the SAME building for the next roof without a fresh search. */
async function rmTraceAnotherRoof(){
  var buildingId = rmState.linkedBuildingId;
  if (!buildingId){ toast("Save this roof to a building first."); return; }
  await rmEnterMultiRoofCapture(buildingId);
}

/* ---- Phase 2.5: place features RIGHT ON RoofMapper's own map, no modal ----
   rmFeatureMarker is the single draggable marker for whichever feature is
   currently being added/edited; rmFeatureMapClickHandler is the specific
   map click listener that repositions it, tracked so it can be removed
   again on close instead of stacking a new one every time the form opens.
   Persistence goes through the SAME persistRoofAsset()/removeRoofAsset()
   helpers the Building History modal uses (see their definition above) --
   this only replaces the placement UI, not the data layer. */
var rmFeatureMarker = null, rmFeatureMapClickHandler = null, rmFeatureEditingId = null;
function rmPopulateFeatureTypeSelect(){
  var sel = document.getElementById("rm-feature-type");
  if (sel.options.length) return;
  Object.keys(ROOF_ASSET_TYPES).forEach(function(k){
    var opt = document.createElement("option");
    opt.value = k; opt.textContent = ROOF_ASSET_TYPES[k].emoji + " " + ROOF_ASSET_TYPES[k].label;
    sel.appendChild(opt);
  });
}
document.getElementById("rm-feature-type") && document.getElementById("rm-feature-type").addEventListener("change", function(){
  if (rmFeatureMarker) rmFeatureMarker.setIcon(assetIcon(this.value));
});
function rmOpenFeatureForm(existingAsset){
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId){ toast("Save this outline to a building first."); return; }
  rmPopulateFeatureTypeSelect();
  document.getElementById("rm-feature-type").value = existingAsset ? existingAsset.type : "drain";
  document.getElementById("rm-feature-label").value = existingAsset ? (existingAsset.label || "") : "";
  document.getElementById("rm-feature-notes").value = existingAsset ? (existingAsset.notes || "") : "";
  document.getElementById("rm-feature-delete-btn").style.display = existingAsset ? "" : "none";
  document.getElementById("rm-feature-dup-btn").style.display = existingAsset ? "" : "none";
  document.getElementById("rm-feature-form").style.display = "";
  document.getElementById("rm-features-actions").style.display = "none";
  rmSetPrecisionMode(true);
  var map = rmEnsureMap();
  /* Idempotent re-entry: clear any marker/handler from a previous open
     (e.g. tapping a different existing marker while already adding one)
     before setting up the new one, so nothing stacks or leaks. Redraw the
     full (cached, no fetch) marker set fresh every time first, so a
     PREVIOUS edit's hidden marker is always restored before deciding what
     to hide this time -- guarantees exactly one marker is ever missing
     (the one currently being edited), never zero and never two. */
  if (rmFeatureMarker){ map.removeLayer(rmFeatureMarker); rmFeatureMarker = null; }
  if (rmFeatureMapClickHandler){ map.off("click", rmFeatureMapClickHandler); rmFeatureMapClickHandler = null; }
  rmDrawLinkedAssets(rmState.linkedAssetsCache);
  /* Hide the existing (non-draggable) marker for whatever's being edited so
     it doesn't sit duplicated underneath the new draggable one while the
     form is open -- rmCloseFeatureForm() redraws the full set again once
     it's done, restoring this one (updated or not, add/edit/cancel alike). */
  if (existingAsset && rmState.assetLayerGroup){
    rmState.assetLayerGroup.eachLayer(function(l){
      if (l._rmAssetId === existingAsset.id) rmState.assetLayerGroup.removeLayer(l);
    });
  }
  var start;
  if (existingAsset && typeof existingAsset.lat === "number"){
    start = [existingAsset.lat, existingAsset.lng];
  } else if (rmState.outline){
    var c = rmGeomRingCentroid(rmState.outline.ring);
    start = [c.lat, c.lng];
  } else {
    var mc = map.getCenter();
    start = [mc.lat, mc.lng];
  }
  rmFeatureMarker = L.marker(start, { draggable: true, icon: assetIcon(document.getElementById("rm-feature-type").value) }).addTo(map);
  rmFeatureMapClickHandler = function(e){ rmFeatureMarker.setLatLng(e.latlng); };
  map.on("click", rmFeatureMapClickHandler);
  rmZoomToOutline();
  document.getElementById("rm-feature-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function rmCloseFeatureForm(refresh){
  var form = document.getElementById("rm-feature-form");
  if (form) form.style.display = "none";
  var actions = document.getElementById("rm-features-actions");
  if (actions) actions.style.display = "";
  if (rmFeatureMarker){ if (rmState.map) rmState.map.removeLayer(rmFeatureMarker); rmFeatureMarker = null; }
  if (rmFeatureMapClickHandler){ if (rmState.map) rmState.map.off("click", rmFeatureMapClickHandler); rmFeatureMapClickHandler = null; }
  rmFeatureEditingId = null;
  rmSetPrecisionMode(false);
  if (!rmState.map || !rmState.linkedBuildingId) return; /* whole roof link is being torn down -- nothing to restore */
  /* refresh=true (Save/Delete -- the data actually changed) re-fetches;
     plain Cancel just redraws from the already-held cache (no data
     changed, no need for a fresh read) -- either way this is what restores
     the marker that was hidden in rmOpenFeatureForm() while editing it. */
  if (refresh) rmLoadLinkedAssets(); else rmDrawLinkedAssets(rmState.linkedAssetsCache);
}
function rmCancelFeatureForm(){ rmCloseFeatureForm(false); }
function rmAddFeature(){
  rmFeatureEditingId = null;
  rmOpenFeatureForm(null);
}
function rmEditFeature(assetId){
  var asset = (rmState.linkedAssetsCache || []).find(function(a){ return a.id === assetId; });
  rmFeatureEditingId = assetId;
  rmOpenFeatureForm(asset || null);
}
async function rmSaveFeature(){
  if (!rmFeatureMarker || !rmState.linkedBuildingId) return;
  var ll = rmFeatureMarker.getLatLng();
  var asset = {
    id: rmFeatureEditingId || genId("ast"),
    type: document.getElementById("rm-feature-type").value,
    label: document.getElementById("rm-feature-label").value.trim(),
    notes: document.getElementById("rm-feature-notes").value.trim(),
    lat: ll.lat, lng: ll.lng, x: null, y: null,
    updatedAt: Date.now()
  };
  try{
    await persistRoofAsset(rmState.linkedBuildingId, rmState.linkedRoofId, asset);
    toast("Roof feature saved ✓");
    rmCloseFeatureForm(true);
  }catch(e){ toast("Couldn't save: " + e.message); }
}
async function rmDeleteFeature(){
  if (!rmFeatureEditingId || !rmState.linkedBuildingId) return;
  if (!confirm("Remove this roof feature?")) return;
  try{
    await removeRoofAsset(rmState.linkedBuildingId, rmState.linkedRoofId, rmFeatureEditingId);
    toast("Roof feature removed");
    rmCloseFeatureForm(true);
  }catch(e){ toast("Couldn't remove: " + e.message); }
}
/* Mark: "point is speed when a roof has several of the same thing" --
   multiple RTUs, a run of roof-fence sections, etc. Copies EVERY field
   (type/label/notes) of any placeable feature type with a fresh id, offset
   a short distance from the original so the copy doesn't sit exactly on
   top of it -- drag it the rest of the way into position, same as placing
   any feature. Reachable two ways: the "📋 Duplicate" button in the edit
   form, and double-clicking a placed marker directly (rmDrawLinkedAssets()
   above). Goes through the same persistRoofAsset() every other roof-asset
   write already uses -- no new data path. See "Duplicate roof feature" in
   DEV_NOTES.md. */
async function rmDuplicateFeature(assetId){
  var asset = (rmState.linkedAssetsCache || []).find(function(a){ return a.id === assetId; });
  if (!asset || !rmState.linkedBuildingId || !rmState.linkedRoofId) return;
  if (typeof asset.lat !== "number" || typeof asset.lng !== "number"){
    toast("Can't duplicate this feature here — it's placed on a custom base map, not on this satellite map.");
    return;
  }
  var offsetFt = 12;
  var mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos(asset.lat * Math.PI / 180);
  var offsetM = offsetFt / 3.28084;
  var copy = Object.assign({}, asset, {
    id: genId("ast"),
    lat: asset.lat + offsetM / mPerDegLat,
    lng: asset.lng + offsetM / mPerDegLng
  });
  try{
    await persistRoofAsset(rmState.linkedBuildingId, rmState.linkedRoofId, copy);
    toast("Feature duplicated ✓ — drag it into place");
    rmCloseFeatureForm(true);
  }catch(e){ toast("Couldn't duplicate: " + e.message); }
}

/* ---- Markup layer: Bluebeam-style annotations on the roof map ----
   Mark (approved): arrows, text callouts, shapes, revision clouds,
   measurements, and a count tool, each recording who added it and when,
   filterable by period, drawn right on RoofMapper's own map -- works over
   whatever base layer is showing (satellite, or a drone ortho set as this
   roof's custom base, same surface roof features already use). A THIRD
   surface Mark asked for -- an uploaded drawing/PDF -- isn't available yet
   because "drawings/documents as attachable artifacts" doesn't exist as a
   concept in this app yet (see that item in ROADMAP.md); this ships for
   the two surfaces that already do exist and can pick up the third once
   that lands. Persisted as roof.roof_markups[], same read-modify-write
   pattern as roof_assets[] (persistRoofAsset/removeRoofAsset above) --
   plain client writes, not admin-gated, for the same reason: a within-one-
   roof addition any tech should be able to make, firestore.rules already
   allows it. See "Markup layer" in DEV_NOTES.md/DATA_MODEL.md. */
async function persistRoofMarkup(buildingId, roofId, markup){
  var snap = await fdb.collection("buildings").doc(buildingId).get();
  var roofs = getBuildingRoofs(snap.exists ? snap.data() : {});
  var roof = getRoofById(snap.exists ? snap.data() : {}, roofId);
  var markups = roof.roof_markups || [];
  markups.push(markup);
  roof.roof_markups = markups;
  var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
  if (roofIdx >= 0) roofs[roofIdx] = roof; else roofs.push(roof);
  await saveBuildingRoofs(buildingId, roofs);
}
async function removeRoofMarkup(buildingId, roofId, markupId){
  var snap = await fdb.collection("buildings").doc(buildingId).get();
  var roofs = getBuildingRoofs(snap.exists ? snap.data() : {});
  var roof = getRoofById(snap.exists ? snap.data() : {}, roofId);
  roof.roof_markups = (roof.roof_markups || []).filter(function(m){ return m.id !== markupId; });
  var roofIdx = roofs.findIndex(function(r){ return r.id === roof.id; });
  if (roofIdx >= 0) roofs[roofIdx] = roof; else roofs.push(roof);
  await saveBuildingRoofs(buildingId, roofs);
}
var RM_MARKUP_COLORS = ["#E53935", "#FB8C00", "#43A047", "#1E88E5", "#8E24AA", "#263238"];
/* -1 means "finishes on demand" (cloud: 3+ points, tech taps Finish when done);
   any positive number auto-finishes the instant that many points are placed,
   so a 2-point arrow/rect/circle/measure or a 1-point text/count never needs
   an extra "done" tap. */
var RM_MARKUP_POINTS_NEEDED = { arrow: 2, text: 1, rect: 2, circle: 2, measure: 2, count: 1, cloud: -1 };
var rmMarkupState = { active: false, type: null, points: [], color: RM_MARKUP_COLORS[0], cache: [], periodFilter: "All" };
var rmMarkupDraftLayer = null, rmMarkupMapClickHandler = null;
function rmMarkupLabel(type){
  return { arrow: "Arrow", text: "Text", rect: "Rectangle", circle: "Circle", cloud: "Cloud", measure: "Measurement", count: "Count marker" }[type] || type;
}
/* "Period" groups markups for the Show filter -- today's date, matching
   Mark's ask ("period-based layer toggling") without depending on there
   being an active work order in RoofMapper's context (there often isn't
   one -- this screen isn't tied to any single work order). */
function rmMarkupCurrentPeriod(){ return new Date().toLocaleDateString(); }
function rmMarkupCurrentAuthor(){ return getFieldHistory("technician")[0] || "Unknown"; }
function rmRenderMarkupColorRow(){
  var host = document.getElementById("rm-markup-color-row");
  if (!host) return;
  host.innerHTML = RM_MARKUP_COLORS.map(function(c){
    var sel = c === rmMarkupState.color;
    return '<button type="button" style="width:28px;height:28px;padding:0;background:' + c + ';border-radius:50%;cursor:pointer;' +
      'border:' + (sel ? "3px solid #263238" : "1px solid #ccc") + '" onclick="rmSetMarkupColor(\'' + c + '\')"></button>';
  }).join("");
}
function rmSetMarkupColor(c){ rmMarkupState.color = c; rmRenderMarkupColorRow(); }
function rmStartMarkup(type){
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId){ toast("Save this outline to a building first."); return; }
  if (rmMarkupState.active) rmCancelMarkup();
  rmMarkupState.active = true;
  rmMarkupState.type = type;
  rmMarkupState.points = [];
  var textRow = document.getElementById("rm-markup-text-row");
  if (textRow) textRow.style.display = type === "text" ? "" : "none";
  if (type === "text") document.getElementById("rm-markup-text-input").value = "";
  document.getElementById("rm-markup-placing").style.display = "";
  document.getElementById("rm-markup-toolbar").style.display = "none";
  document.getElementById("rm-markup-finish-btn").style.display = type === "cloud" ? "" : "none";
  rmUpdateMarkupPlacingHint();
  var map = rmEnsureMap();
  if (rmMarkupMapClickHandler) map.off("click", rmMarkupMapClickHandler);
  rmMarkupMapClickHandler = function(e){ rmMarkupAddPoint(e.latlng); };
  map.on("click", rmMarkupMapClickHandler);
}
function rmUpdateMarkupPlacingHint(){
  var el = document.getElementById("rm-markup-placing-hint");
  if (!el) return;
  var type = rmMarkupState.type, n = rmMarkupState.points.length;
  if (type === "cloud"){
    el.textContent = n < 3 ? ("Tap at least 3 points around the area (" + n + " placed), then Finish.") :
      (n + " points placed — tap Finish when the outline is closed, or keep tapping to add more.");
  } else if (type === "text" || type === "count"){
    el.textContent = "Tap the map to place it.";
  } else {
    el.textContent = n === 0 ? "Tap the start point." : "Tap the end point.";
  }
}
function rmMarkupAddPoint(latlng){
  rmMarkupState.points.push({ lat: latlng.lat, lng: latlng.lng });
  rmMarkupDrawDraft();
  var needed = RM_MARKUP_POINTS_NEEDED[rmMarkupState.type];
  if (needed > 0 && rmMarkupState.points.length >= needed){ rmFinishMarkup(); return; }
  rmUpdateMarkupPlacingHint();
}
function rmUndoMarkupPoint(){
  rmMarkupState.points.pop();
  rmMarkupDrawDraft();
  rmUpdateMarkupPlacingHint();
}
function rmCancelMarkup(){
  rmMarkupState.active = false;
  rmMarkupState.points = [];
  var map = rmState.map;
  if (map && rmMarkupMapClickHandler) map.off("click", rmMarkupMapClickHandler);
  rmMarkupMapClickHandler = null;
  if (map && rmMarkupDraftLayer){ map.removeLayer(rmMarkupDraftLayer); rmMarkupDraftLayer = null; }
  var placing = document.getElementById("rm-markup-placing");
  if (placing) placing.style.display = "none";
  var toolbar = document.getElementById("rm-markup-toolbar");
  if (toolbar) toolbar.style.display = "";
  var textRow = document.getElementById("rm-markup-text-row");
  if (textRow) textRow.style.display = "none";
}
function rmMarkupDrawDraft(){
  var map = rmEnsureMap();
  if (rmMarkupDraftLayer){ map.removeLayer(rmMarkupDraftLayer); rmMarkupDraftLayer = null; }
  if (!rmMarkupState.points.length) return;
  rmMarkupDraftLayer = rmRenderMarkupShape({ type: rmMarkupState.type, points: rmMarkupState.points, color: rmMarkupState.color, text: "…" }, true);
  if (rmMarkupDraftLayer) rmMarkupDraftLayer.addTo(map);
}
async function rmFinishMarkup(){
  var type = rmMarkupState.type;
  var minPoints = type === "cloud" ? 3 : (RM_MARKUP_POINTS_NEEDED[type] || 1);
  if (rmMarkupState.points.length < minPoints){ toast("Tap at least " + minPoints + " point" + (minPoints > 1 ? "s" : "") + " first."); return; }
  var text = type === "text" ? document.getElementById("rm-markup-text-input").value.trim() : "";
  if (type === "text" && !text){ toast("Add a caption first."); return; }
  var markup = {
    id: genId("mkp"), type: type, points: rmMarkupState.points.slice(), color: rmMarkupState.color, text: text,
    author: rmMarkupCurrentAuthor(), createdAt: Date.now(), period: rmMarkupCurrentPeriod(), roofId: rmState.linkedRoofId
  };
  if (type === "count"){
    markup.count = (rmMarkupState.cache || []).filter(function(m){ return m.type === "count"; }).length + 1;
  }
  var map = rmState.map;
  if (map && rmMarkupMapClickHandler) map.off("click", rmMarkupMapClickHandler);
  rmMarkupMapClickHandler = null;
  if (map && rmMarkupDraftLayer){ map.removeLayer(rmMarkupDraftLayer); rmMarkupDraftLayer = null; }
  rmMarkupState.active = false;
  rmMarkupState.points = [];
  document.getElementById("rm-markup-placing").style.display = "none";
  document.getElementById("rm-markup-toolbar").style.display = "";
  var textRow = document.getElementById("rm-markup-text-row");
  if (textRow) textRow.style.display = "none";
  try{
    await persistRoofMarkup(rmState.linkedBuildingId, rmState.linkedRoofId, markup);
    toast(rmMarkupLabel(type) + " added ✓");
    rmLoadLinkedAssets();
  }catch(e){ toast("Couldn't save markup: " + e.message); }
}
/* Real-world-meter direction math (same rmGeomToLocalXY/FromLocalXY
   tangent-plane projection used everywhere else in RoofMapper) so the
   arrowhead is a fixed real-world size that scales with zoom exactly like
   the rest of the drawing, rather than a fixed screen-pixel size that
   would need its own zoom/pan redraw wiring to stay attached. */
function rmMarkupArrowHeadLatLngs(p1, p2){
  var origin = p1;
  var xy2 = rmGeomToLocalXY(p2, origin);
  var len = Math.sqrt(xy2.x * xy2.x + xy2.y * xy2.y) || 1e-6;
  var ux = xy2.x / len, uy = xy2.y / len;
  var headLen = Math.min(len * 0.3, 3); /* meters, capped so a long arrow doesn't get an oversized head */
  var ang = 28 * Math.PI / 180;
  function rot(vx, vy, a){ return { x: vx * Math.cos(a) - vy * Math.sin(a), y: vx * Math.sin(a) + vy * Math.cos(a) }; }
  var back1 = rot(-ux, -uy, ang), back2 = rot(-ux, -uy, -ang);
  var wing1 = { x: xy2.x + back1.x * headLen, y: xy2.y + back1.y * headLen };
  var wing2 = { x: xy2.x + back2.x * headLen, y: xy2.y + back2.y * headLen };
  return [rmGeomFromLocalXY(wing1, origin), rmGeomFromLocalXY(wing2, origin)];
}
/* Cheap-but-correct scalloped "revision cloud": a light polygon fill plus
   a ring of unfilled circles (real-world meter radius, so they scale with
   zoom like everything else) traced along the perimeter at roughly even
   spacing -- overlapping circle arcs read as the familiar Bluebeam cloud
   bump pattern using only stock Leaflet primitives (L.polygon + L.circle),
   each of which already redraws itself correctly on pan/zoom. A hand-built
   scalloped SVG path would look marginally crisper but needs its own
   zoom/moveend redraw wiring for a live pannable map; not worth it here. */
function rmMarkupCloudLayer(points, color, opacity){
  var group = L.layerGroup();
  L.polygon(points.map(function(p){ return [p.lat, p.lng]; }), { color: color, weight: 0, fillOpacity: 0.10 * opacity, fillColor: color }).addTo(group);
  var n = points.length;
  var perimeterM = 0;
  for (var i = 0; i < n; i++) perimeterM += rmGeomHaversineMeters(points[i], points[(i + 1) % n]);
  if (perimeterM < 0.1) return group;
  var bumpCount = Math.max(8, Math.min(60, Math.round(perimeterM / 2.5)));
  var spacing = perimeterM / bumpCount;
  var bumpRadius = Math.max(0.6, spacing / 1.8);
  var edgeIdx = 0, edgeStart = points[0], edgeEnd = points[1 % n];
  var edgeLen = rmGeomHaversineMeters(edgeStart, edgeEnd) || 1e-6;
  var traveled = 0;
  for (var placed = 0; placed < bumpCount; placed++){
    while (traveled > edgeLen && edgeIdx < n - 1){
      traveled -= edgeLen;
      edgeIdx++;
      edgeStart = points[edgeIdx % n];
      edgeEnd = points[(edgeIdx + 1) % n];
      edgeLen = rmGeomHaversineMeters(edgeStart, edgeEnd) || 1e-6;
    }
    var t = Math.min(1, traveled / edgeLen);
    var lat = edgeStart.lat + (edgeEnd.lat - edgeStart.lat) * t;
    var lng = edgeStart.lng + (edgeEnd.lng - edgeStart.lng) * t;
    L.circle([lat, lng], { radius: bumpRadius, color: color, weight: 2, fill: false, opacity: opacity }).addTo(group);
    traveled += spacing;
  }
  return group;
}
/* Renders any ONE markup as a Leaflet layer/layerGroup -- shared by the
   live in-progress draft (rmMarkupDrawDraft, dimmed opacity) and the
   committed layer (rmDrawMarkups, full opacity), so a placed markup never
   looks different from its own preview. */
function rmRenderMarkupShape(m, isDraft){
  var opacity = isDraft ? 0.55 : 1;
  var latlngs = m.points.map(function(p){ return [p.lat, p.lng]; });
  if (m.type === "arrow"){
    if (m.points.length < 2) return L.layerGroup();
    var g = L.layerGroup();
    L.polyline(latlngs, { color: m.color, weight: 3, opacity: opacity }).addTo(g);
    var wings = rmMarkupArrowHeadLatLngs(m.points[0], m.points[1]);
    L.polygon([latlngs[1], [wings[0].lat, wings[0].lng], [wings[1].lat, wings[1].lng]],
      { color: m.color, weight: 0, fillOpacity: opacity, fillColor: m.color }).addTo(g);
    return g;
  }
  if (m.type === "text"){
    return L.marker(latlngs[0], {
      icon: L.divIcon({
        className: "", iconSize: null, iconAnchor: [0, 12],
        html: '<div style="background:' + m.color + ';color:#fff;padding:4px 8px;border-radius:5px;font-size:12px;' +
          'font-weight:600;max-width:220px;box-shadow:0 1px 3px rgba(0,0,0,.4);opacity:' + opacity + '">' + esc(m.text || "") + '</div>'
      })
    });
  }
  if (m.type === "rect"){
    if (m.points.length < 2) return L.layerGroup();
    return L.rectangle(latlngs, { color: m.color, weight: 2, fillOpacity: 0.08, opacity: opacity });
  }
  if (m.type === "circle"){
    if (m.points.length < 2) return L.layerGroup();
    return L.circle(latlngs[0], { radius: rmGeomHaversineMeters(m.points[0], m.points[1]), color: m.color, weight: 2, fillOpacity: 0.08, opacity: opacity });
  }
  if (m.type === "cloud"){
    if (m.points.length < 3) return L.layerGroup();
    return rmMarkupCloudLayer(m.points, m.color, opacity);
  }
  if (m.type === "measure"){
    if (m.points.length < 2) return L.layerGroup();
    var g2 = L.layerGroup();
    L.polyline(latlngs, { color: m.color, weight: 2, dashArray: "5,5", opacity: opacity }).addTo(g2);
    var distFt = rmGeomHaversineMeters(m.points[0], m.points[1]) * 3.28084;
    var mid = { lat: (m.points[0].lat + m.points[1].lat) / 2, lng: (m.points[0].lng + m.points[1].lng) / 2 };
    L.marker([mid.lat, mid.lng], {
      icon: L.divIcon({
        className: "", iconSize: null,
        html: '<div style="background:#263238;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;' +
          'font-weight:700;white-space:nowrap;transform:translate(-50%,-50%);opacity:' + opacity + '">' + Math.round(distFt) + ' ft</div>'
      })
    }).addTo(g2);
    return g2;
  }
  if (m.type === "count"){
    return L.marker(latlngs[0], {
      icon: L.divIcon({
        className: "", iconSize: [24, 24], iconAnchor: [12, 12],
        html: '<div style="background:' + m.color + ';color:#fff;width:24px;height:24px;border-radius:50%;' +
          'display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;' +
          'border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);opacity:' + opacity + '">' + (m.count || "•") + '</div>'
      })
    });
  }
  return L.layerGroup();
}
function rmMarkupPeriods(markups){
  var seen = {}, list = [];
  markups.forEach(function(m){ if (!seen[m.period]){ seen[m.period] = true; list.push(m.period); } });
  return list;
}
function rmRenderMarkupPeriodFilter(markups){
  var row = document.getElementById("rm-markup-filter-row");
  var sel = document.getElementById("rm-markup-period-filter");
  if (!row || !sel) return;
  var periods = rmMarkupPeriods(markups);
  if (periods.length <= 1){ row.style.display = "none"; return; }
  row.style.display = "";
  sel.innerHTML = '<option value="All">All (' + markups.length + ')</option>' +
    periods.map(function(p){
      var count = markups.filter(function(m){ return m.period === p; }).length;
      return '<option value="' + esc(p) + '">' + esc(p) + ' (' + count + ')</option>';
    }).join("");
  sel.value = rmMarkupState.periodFilter;
}
function rmFilterMarkupsByPeriod(period){
  rmMarkupState.periodFilter = period;
  rmDrawMarkups(rmMarkupState.cache);
}
function rmDrawMarkups(markups){
  rmMarkupState.cache = markups || [];
  var map = rmEnsureMap();
  if (rmState.markupLayerGroup) map.removeLayer(rmState.markupLayerGroup);
  rmState.markupLayerGroup = L.layerGroup().addTo(map);
  var filter = rmMarkupState.periodFilter;
  var visible = filter === "All" ? rmMarkupState.cache : rmMarkupState.cache.filter(function(m){ return m.period === filter; });
  visible.forEach(function(m){
    var layer = rmRenderMarkupShape(m, false);
    layer.addTo(rmState.markupLayerGroup);
    /* Every markup renders as either a single Path or a LayerGroup of a
       few -- both support .on(), and only a LayerGroup has .eachLayer --
       so this recurses into whichever it actually got without needing to
       know which shape types are "simple" vs "grouped". */
    (function attachClick(l){
      if (l.on) l.on("click", function(){ rmOpenMarkupInfo(m); });
      if (l.eachLayer) l.eachLayer(attachClick);
    })(layer);
  });
  rmRenderMarkupPeriodFilter(rmMarkupState.cache);
  rmRenderMarkupList(visible);
}
function rmRenderMarkupList(markups){
  var host = document.getElementById("rm-markup-list");
  if (!host) return;
  if (!markups.length){ host.innerHTML = '<p class="hint">No markups on this roof yet.</p>'; return; }
  host.innerHTML = markups.slice().sort(function(a, b){ return b.createdAt - a.createdAt; }).map(function(m){
    return '<div class="hint" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid #eee">' +
      '<span><b style="color:' + m.color + '">●</b> ' + esc(rmMarkupLabel(m.type)) + (m.text ? " — " + esc(m.text) : "") +
      '<br><span style="color:#8a8f93">' + esc(m.author || "Unknown") + ' · ' + esc(m.period || "") + '</span></span>' +
      '<button class="btn danger" style="padding:4px 8px" onclick="rmDeleteMarkup(\'' + m.id + '\')">🗑️</button></div>';
  }).join("");
}
function rmOpenMarkupInfo(m){
  if (confirm(rmMarkupLabel(m.type) + (m.text ? ": " + m.text : "") + "\nAdded by " + (m.author || "Unknown") + " on " + (m.period || "") + "\n\nDelete this markup?")){
    rmDeleteMarkup(m.id);
  }
}
async function rmDeleteMarkup(markupId){
  if (!rmState.linkedBuildingId || !rmState.linkedRoofId) return;
  try{
    await removeRoofMarkup(rmState.linkedBuildingId, rmState.linkedRoofId, markupId);
    toast("Markup removed");
    rmLoadLinkedAssets();
  }catch(e){ toast("Couldn't remove: " + e.message); }
}

/* ---- save locally (localStorage fallback — offline or not linked yet) ---- */
function rmLoadLocalOutlines(){
  try{ return JSON.parse(localStorage.getItem(RM_LOCAL_KEY) || "[]"); }catch(e){ return []; }
}
function rmSaveLocalOutlines(list){
  try{ localStorage.setItem(RM_LOCAL_KEY, JSON.stringify(list)); }catch(e){ toast("Couldn't save locally: " + e.message); }
}
function rmSaveLocally(){
  if (!rmState.outline){ toast("Generate a roof outline first."); return; }
  if (!rmConfirmSiteBoundarySave()) return;
  var list = rmLoadLocalOutlines();
  list.unshift(Object.assign({}, rmState.outline, { id: genId("rmo_local") }));
  rmSaveLocalOutlines(list.slice(0, 50));
  toast("Roof outline saved on this device ✓");
  rmRenderLocalSaves();
}
function rmRenderLocalSaves(){
  var list = rmLoadLocalOutlines();
  var panel = document.getElementById("rm-local-panel");
  var host = document.getElementById("rm-local-list");
  if (!list.length){ panel.style.display = "none"; return; }
  panel.style.display = "";
  host.innerHTML = list.map(function(o){
    return '<div class="rm-local-item"><div class="info"><b>' + esc(rmOutlineTitle(o)) + '</b>' +
      o.areaSqFt.toFixed(0) + ' sq ft · ' + new Date(o.createdAt).toLocaleDateString() + '</div>' +
      '<button class="btn" onclick="rmLoadLocalOutline(\'' + o.id + '\')">Load</button>' +
      '<button class="btn danger" onclick="rmDeleteLocalOutline(\'' + o.id + '\')">Delete</button></div>';
  }).join("");
}
function rmLoadLocalOutline(id){
  var o = rmLoadLocalOutlines().find(function(x){ return x.id === id; });
  if (!o) return;
  rmCancelTrace();
  rmState.outline = o;
  rmClearLinkedFeatures(); /* a locally-saved outline has no building link -- clear any previous one */
  var map = rmEnsureMap();
  if (rmState.outlineLayer) map.removeLayer(rmState.outlineLayer);
  rmState.outlineLayer = L.polygon(o.ring.map(function(p){ return [p.lat, p.lng]; }), {
    color: "#E8600A", weight: 3, fillColor: "#E8600A", fillOpacity: 0.15
  }).addTo(map);
  rmDrawEdgeDimensions(o);
  map.fitBounds(rmState.outlineLayer.getBounds(), { padding: [30, 30] });
  setTimeout(function(){ map.invalidateSize(); }, 60);
  rmRenderOutlineStats(o);
  rmUpdateExportHint();
  rmUpdateControlVisibility();
  toast("Loaded saved outline — ready to save to a building or export.");
}
function rmDeleteLocalOutline(id){
  rmSaveLocalOutlines(rmLoadLocalOutlines().filter(function(x){ return x.id !== id; }));
  rmRenderLocalSaves();
}

/* Mobile: auto-hide the header on scroll-down, show again on scroll-up --
   Mark: "maximize usable area... consider collapsing or auto-hiding the
   banner... on scroll." Mobile-only (matchMedia gate, same 640px cutoff as
   the mobile header CSS) so desktop behavior is completely unchanged.
   Timestamp-throttled (not requestAnimationFrame -- rAF can be starved or
   never fire at all on a backgrounded/inactive tab in some browsers,
   which would silently disable this entirely) so it doesn't add scroll
   jank; a small DOWN_THRESHOLD avoids the header flickering on tiny/
   accidental scroll wiggles. Doesn't fire while scrolled to the very top
   (header always visible there) or while a modal has locked body scroll
   (lockBodyScroll() sets this same overflow:hidden the check below reads,
   so there's no separate flag to keep in sync). */
(function(){
  var DOWN_THRESHOLD = 12, THROTTLE_MS = 80;
  var lastY = window.scrollY, lastRun = 0, header = document.querySelector("header");
  function onScroll(){
    var now = Date.now();
    if (now - lastRun < THROTTLE_MS) return;
    lastRun = now;
    if (!window.matchMedia("(max-width:640px)").matches){ header.classList.remove("header-collapsed"); lastY = window.scrollY; return; }
    if (document.body.style.overflow === "hidden") return; /* a modal is open (lockBodyScroll) */
    var y = window.scrollY;
    if (y <= 0){ header.classList.remove("header-collapsed"); }
    else if (y > lastY + DOWN_THRESHOLD){ header.classList.add("header-collapsed"); lastY = y; }
    else if (y < lastY - DOWN_THRESHOLD){ header.classList.remove("header-collapsed"); lastY = y; }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
})();

