"use strict";
/* ================= Inspections checklist engine =================
   Phase 2 of docs/agents/WORKORDERS_SPLIT_PLAN.md. PURE MOVE out of
   js/photos.js -- not one line of logic changed, only the file it lives in.

   Why it lived in photos.js at all: the checklist rows ARE findings[] rows,
   and findings were photo-adjacent, so the engine accreted there. That made
   every Inspections change a shared-file edit inside another section lane.

   Protected by tests/inspectionChecklistRules.test.js (PR #173), landed
   FIRST precisely so this move had a behavioural safety net under it rather
   than being eyeballed.

   DELIBERATELY LEFT BEHIND in js/photos.js: maybeAutoPinInspectionItem().
   It reads as Inspections code but it is a photo-pipeline function -- it runs
   inside the capture/EXIF path and shares GPS/roof-assignment helpers with
   maybeAutoPinFinding(). Moving it would split that pipeline in half, which
   is more than a pure move is allowed to do. Follow-up INS-2 on the board. */

function inspectionChecklistItemById(id){
  return inspectionChecklist.find(function(c){ return c.id === id; });
}
function inspectionComponentLabel(key){
  var c = INSPECTION_CHECKLIST_COMPONENTS.find(function(x){ return x.key === key; });
  return c ? c.label : key;
}
/* ---- which roofs this inspection covers ----
   The multi-roof structure is NOT new: buildings have carried roofs[] --
   { id, label, roofSystem, base-map fields, ... } -- since RoofMapper needed
   it (getBuildingRoofs(), js/core.js). currentRoofIds is the inspector's
   multi-select from renderInspectionRoofPicker() below. This just gives the
   checklist one honest answer for "which roofs am I covering right now",
   falling back to the single currentRoofId and finally to the default roof so
   a single-roof building behaves exactly as it always has. */
/* Returns [] when the inspector has made no roof selection at all -- a
   single-roof building, which is the overwhelming common case. That empty
   answer matters: it means "one roof, unspecified", NOT "roof_default". An
   earlier revision of this returned ["roof_default"] as a convenience and the
   characterization suite immediately caught the consequence -- every checklist
   item got stamped with a roof id the user never chose, and a pin dropped in
   the parking lot started claiming it belonged to roof_default instead of
   being honestly flagged ambiguous. Never fabricate a roof. */
function inspectionRoofIds(){
  if (currentRoofIds && currentRoofIds.length) return currentRoofIds.slice();
  if (currentRoofId) return [currentRoofId];
  return [];
}
function inspectionRoofLabel(roofId){
  var ctx = inspectionRoofLabelCache[roofId];
  if (ctx) return ctx;
  return roofId === "roof_default" ? "Roof 1" : "Roof";
}
/* Populated by renderInspectionRoofPicker() from the building's real roofs[]
   so the checklist headings and the printed report can name a roof without
   another Firestore read. Never invents a label -- an unknown roofId falls
   back through inspectionRoofLabel() above. */
var inspectionRoofLabelCache = {};
/* Backfills the 8 fixed components for EVERY roof this inspection covers, and
   keeps them in canonical order (roof order, then component order) regardless
   of storage order. Safe to call any time; a no-op once each covered roof has
   all 8.

   MULTI-ROOF (Mark, field gap 2026-07-19): a facility routinely has several
   roofs of different systems -- EPDM here, TPO there, mod-bit over the old
   wing -- and one flat 8-row checklist could not say which roof a rating was
   about. Items are now keyed by (roofId, key), so a 3-roof inspection carries
   3 x 8 rows.

   Legacy self-heal: an item saved before roofId existed is adopted by the
   FIRST covered roof rather than being dropped or duplicated. That is the
   honest reading -- those inspections were single-roof by construction, so
   their ratings genuinely describe that one roof. Same never-fabricate rule
   the `pin` backfill below follows. */
function ensureInspectionChecklist(){
  var roofIds = inspectionRoofIds();
  if (!roofIds.length){
    /* No roof selection -- single-roof building. Behaves EXACTLY as it did
       before multi-roof existed: one set of 8, and no roofId stamped on
       anything. Adding a roofId here would be inventing an answer the user
       never gave, and it would propagate into findings and the report. */
    INSPECTION_CHECKLIST_COMPONENTS.forEach(function(c){
      if (!inspectionChecklist.some(function(item){ return item.key === c.key; })){
        inspectionChecklist.push({ id: genId("chk"), key: c.key, rating: "N/A", notes: "", linkedFindingId: null, pin: null });
      }
    });
  } else {
    /* Legacy rows predate roofId and were single-roof by construction, so the
       first covered roof is their honest owner -- adopted rather than dropped
       or duplicated across every roof. */
    var primary = roofIds[0];
    inspectionChecklist.forEach(function(item){
      if (!item.roofId) item.roofId = primary;
    });
    roofIds.forEach(function(roofId){
      INSPECTION_CHECKLIST_COMPONENTS.forEach(function(c){
        var exists = inspectionChecklist.some(function(item){
          return item.key === c.key && item.roofId === roofId;
        });
        if (!exists){
          inspectionChecklist.push({
            id: genId("chk"), key: c.key, roofId: roofId,
            rating: "N/A", notes: "", linkedFindingId: null, pin: null
          });
        }
      });
    });
  }
  /* Self-heals items saved before `pin` existed -- never fabricates a
     location, just ensures the field is there going forward (same pattern
     fill() already uses for findings' pin field). */
  inspectionChecklist.forEach(function(item){ if (item.pin === undefined) item.pin = null; });
  inspectionChecklist.sort(function(a, b){
    /* Roof order follows the inspector's own selection order; a roof no
       longer selected (deselected mid-inspection -- its ratings are kept, not
       silently binned) sorts after the covered ones rather than vanishing. */
    var ra = roofIds.indexOf(a.roofId), rb = roofIds.indexOf(b.roofId);
    if (ra === -1) ra = roofIds.length;
    if (rb === -1) rb = roofIds.length;
    if (ra !== rb) return ra - rb;
    var ia = INSPECTION_CHECKLIST_COMPONENTS.findIndex(function(c){ return c.key === a.key; });
    var ib = INSPECTION_CHECKLIST_COMPONENTS.findIndex(function(c){ return c.key === b.key; });
    return ia - ib;
  });
}
/* Groups the checklist for display/print: [{ roofId, label, items[] }] in the
   sorted order ensureInspectionChecklist() just established. Shared by the UI
   below and by the report builders in js/export.js so the two can never
   disagree about which rating belongs to which roof. */
function inspectionChecklistByRoof(list, labels){
  list = list || [];
  labels = labels || {};
  var order = [], groups = {};
  list.forEach(function(item){
    var rid = item.roofId || "roof_default";
    if (!groups[rid]){
      groups[rid] = { roofId: rid, label: labels[rid] || inspectionRoofLabel(rid), items: [] };
      order.push(rid);
    }
    groups[rid].items.push(item);
  });
  return order.map(function(rid){ return groups[rid]; });
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
    /* The finding inherits the checklist item's roof. Findings already carried
       roofId (js/photos.js's pin/roof picker uses it, and js/export.js groups
       the report by it) -- before multi-roof checklists there was simply
       nothing to inherit it FROM, so an auto-created finding landed roofless
       and fell back to the work order's single roof. On a 3-roof facility
       that silently mislabelled which roof a Critical came from. */
    if (existing){
      existing.condition = text;
      existing.location = label;
      if (item.roofId) existing.roofId = item.roofId;
    } else {
      var f = { id: genId("fnd"), condition: text, location: label, warranty: "Undetermined", pin: null };
      if (item.roofId) f.roofId = item.roofId;
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
/* Which roof's form is on screen. Mark, 2026-07-20: stacking every roof's five
   sections made a 4-5 roof building "a mile long", so ONE roof's form shows at
   a time and a tab strip switches between them.

   THIS MUST LIVE IN A MODULE VARIABLE, NOT THE DOM. renderInspectionChecklist()
   rebuilds innerHTML wholesale and is called from ten places -- including on
   every rating change (below) and on every photo add/remove/caption edit in
   js/photos.js. Reading the active tab back out of the DOM would reset it to
   the first roof the instant a condition is set, which is the single most
   common action on this screen. */
var inspectionActiveRoofId = null;
function onInspectionRoofTab(roofId){
  inspectionActiveRoofId = roofId;
  renderInspectionChecklist();
}
/* What a tab can HONESTLY say about a roof at a glance.

   Deliberately not a "% complete": items are seeded with rating "N/A", and N/A
   is also a legitimate answer (the component isn't on this roof). Treating N/A
   as unfinished would brand a correctly-completed roof incomplete forever.

   So only two claims, both defensible:
     flagged   -- how many components are Fair/Poor/Critical. A real signal,
                  the same test renderInspectionChecklistRow() uses to shade a
                  row, and the reason you'd revisit a roof.
     untouched -- literally NOTHING recorded: every rating still the seeded
                  N/A, no notes, no pin, no linked finding. Answers "have I
                  started this roof?" without claiming to know if it's done. */
function inspectionRoofTabStatus(items){
  items = items || [];
  var flagged = 0, touched = false;
  items.forEach(function(it){
    if (["Fair", "Poor", "Critical"].indexOf(it.rating) > -1) flagged++;
    if (it.rating !== "N/A" || (it.notes && it.notes.trim()) || it.pin || it.linkedFindingId) touched = true;
  });
  return { flagged: flagged, untouched: !touched };
}
function inspectionRoofTabBadge(st){
  if (st.flagged) return '<span style="margin-left:6px;padding:0 6px;border-radius:8px;' +
    'background:#B4501E;color:#fff;font-size:11px;font-weight:700">' + st.flagged + '</span>';
  if (st.untouched) return '<span style="margin-left:6px;color:var(--muted);font-size:11px">not started</span>';
  return '<span style="margin-left:6px;color:#1B7F4B;font-size:12px">&#10003;</span>';
}
function renderInspectionChecklist(){
  var host = document.getElementById("inspection-checklist-list");
  if (!host) return;
  /* Index by identity, not by position: the rows are grouped by roof below, so
     a row's place in the rendered list no longer matches its index in
     inspectionChecklist[]. data-ci carries the real array index. */
  var groups = inspectionChecklistByRoof(inspectionChecklist, inspectionRoofLabelCache);
  var multiRoof = groups.length > 1;

  /* Single roof looks exactly as it always has -- no tabs, no banner, no new
     chrome for the common case (field-first). */
  if (!multiRoof){
    host.innerHTML = groups.map(function(g){
      return g.items.map(function(item){
        return renderInspectionChecklistRow(item, inspectionChecklist.indexOf(item));
      }).join("");
    }).join("");
    bindInspectionChecklistInputs(host);
    return;
  }

  /* Resolve the active tab against the roofs actually on screen. Deselecting
     the active roof in the picker (or loading a different order) must land on
     a real roof rather than render an empty form. */
  var active = null;
  for (var i = 0; i < groups.length; i++){
    if (groups[i].roofId === inspectionActiveRoofId){ active = groups[i]; break; }
  }
  if (!active) active = groups[0];
  inspectionActiveRoofId = active.roofId;

  var tabs = '<div class="btnrow" style="margin:0 0 10px;flex-wrap:wrap;gap:6px">' +
    groups.map(function(g){
      var on = g.roofId === active.roofId;
      var st = inspectionRoofTabStatus(g.items);
      return '<button type="button" class="btn" onclick="onInspectionRoofTab(\'' + esc(g.roofId) + '\')" ' +
        'style="padding:6px 10px;' +
        (on ? "background:#0d3c61;color:#fff;border-color:#0d3c61" : "background:#fff") + '">' +
        esc(g.label) + inspectionRoofTabBadge(st) + '</button>';
    }).join("") + '</div>';

  var summary = inspectionRoofProfileSummary(active.roofId);
  var head = '<div class="rowhead" style="margin:0 0 6px;padding:6px 10px;background:#EAF4FF;' +
    'border-left:4px solid #0d3c61;border-radius:4px">' +
    '<b>' + esc(active.label) + '</b>' +
    (summary ? ' <span class="hint" style="margin:0">· ' + esc(summary) + '</span>' : "") +
    '</div>';

  /* Only the active roof's rows are rendered. The other roofs' answers are NOT
     lost: bindInspectionChecklistInputs() writes straight into
     inspectionChecklist[] on every keystroke, so switching tabs re-renders from
     saved data. The printed report is unaffected either way -- js/export.js
     builds from inspectionChecklist[] via inspectionChecklistByRoof(), not from
     what happens to be on screen, so every roof still prints. */
  host.innerHTML = tabs + head + active.items.map(function(item){
    return renderInspectionChecklistRow(item, inspectionChecklist.indexOf(item));
  }).join("");
  bindInspectionChecklistInputs(host);
}
function renderInspectionChecklistRow(item, i){
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
}
function bindInspectionChecklistInputs(host){
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
  if (!info){ host.innerHTML = ""; return; }
  cacheInspectionRoofMeta(info.roofs);
  /* The picker used to hide itself entirely on a single-roof building. It no
     longer can: "Add roof" is how a SECOND roof gets created without going
     near RoofMapper, so a one-roof building is exactly where it's needed
     (Mark's 3-roof facility starts as a 1-roof record). The checkbox list
     still only appears once there's a genuine choice to make. */
  var multi = info.roofs.length > 1;
  if (multi){
    if (!currentRoofIds || !currentRoofIds.length || !currentRoofIds.every(function(id){ return info.roofs.some(function(r){ return r.id === id; }); })){
      currentRoofIds = info.roofs.map(function(r){ return r.id; });
    }
    currentRoofId = currentRoofIds[0];
  } else {
    currentRoofIds = null;
    currentRoofId = info.roofs[0] ? info.roofs[0].id : currentRoofId;
  }
  var list = !multi ? "" :
    info.roofs.map(function(r){
      var checked = currentRoofIds.indexOf(r.id) !== -1;
      var summary = inspectionRoofProfileSummary(r.id);
      return '<label class="hint" style="display:flex;align-items:center;gap:6px;margin:2px 0;font-weight:400">' +
        '<input type="checkbox" class="wo-inspection-roof-cb" value="' + esc(r.id) + '"' + (checked ? ' checked' : '') +
        ' onchange="onInspectionRoofToggle()"> ' + esc(r.label || "Roof") +
        (summary ? ' <span class="hint" style="margin:0">· ' + esc(summary) + '</span>' : "") +
        '</label>';
    }).join('');
  var soleSummary = info.roofs[0] ? inspectionRoofProfileSummary(info.roofs[0].id) : "";
  host.innerHTML = '<div class="fld">' +
    '<label>' + (multi ? "Which roof(s) does this inspection cover?" : "Roofs on this building") + '</label>' +
    (multi ? list :
      '<p class="hint" style="margin:2px 0">' + esc((info.roofs[0] && info.roofs[0].label) || "Roof 1") +
      (soleSummary ? ' · ' + esc(soleSummary) : "") +
      '</p>') +
    '<button class="btn" type="button" style="margin-top:6px" onclick="inspectionAddRoof()">➕ Add roof</button>' +
    '</div>';
  if (val("woType") === "Inspection"){ ensureInspectionChecklist(); renderInspectionChecklist(); }
}
/* Roof label/system lookup for the checklist headings and the printed report,
   filled from the building's real roofs[] so neither has to re-read Firestore
   or guess a name. */
var inspectionRoofSystemCache = {};
/* The roof's persistent PROFILE (age, warranty, area, condition -- see
   getRoofProfile() in js/core.js and the Roof Profile card in
   js/roofmapper.js, which Building History already renders). Cached here so
   the inspection form can SHOW what each roof actually is while it's being
   rated, without a second Firestore read per roof. */
var inspectionRoofProfileCache = {};
function cacheInspectionRoofMeta(roofs){
  (roofs || []).forEach(function(r){
    if (!r || !r.id) return;
    inspectionRoofLabelCache[r.id] = r.label || "Roof";
    inspectionRoofSystemCache[r.id] = r.roofSystem || "";
    inspectionRoofProfileCache[r.id] = (typeof getRoofProfile === "function") ? getRoofProfile(r) : (r.profile || {});
  });
}
/* One-line "what is this roof" summary: system · area · age · warranty.
   Mark's framing -- "Roof 1 = EPDM 5yr under warranty, Roof 2 = TPO" -- is
   exactly this line, and it is the thing a tech needs in front of them while
   deciding whether a condition is warrantable.

   Only ever renders facts that are actually recorded. A roof with an empty
   profile shows nothing rather than a row of "Not set" placeholders: on a
   phone, in the field, blank space is better than noise. Age prefers the
   explicit estimatedAgeYears and falls back to deriving from installDate --
   never invents one from nothing. */
function inspectionRoofProfileSummary(roofId){
  var p = inspectionRoofProfileCache[roofId] || {};
  var bits = [];
  var system = inspectionRoofSystemCache[roofId];
  if (system) bits.push(system);
  if (p.areaSquares != null && p.areaSquares !== "") bits.push(p.areaSquares + " sq");
  var age = inspectionRoofAgeYears(p);
  if (age != null) bits.push(age + (age === 1 ? " yr" : " yrs"));
  if (p.warrantyStatus) bits.push(p.warrantyStatus);
  else if (p.warrantyProvider) bits.push(p.warrantyProvider + " warranty");
  if (p.condition) bits.push(p.condition);
  return bits.join(" · ");
}
function inspectionRoofAgeYears(p){
  if (p && p.estimatedAgeYears != null && p.estimatedAgeYears !== "") return p.estimatedAgeYears;
  if (p && p.installDate){
    var t = Date.parse(p.installDate);
    if (!isNaN(t)){
      var yrs = Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
      if (yrs >= 0) return yrs;
    }
  }
  return null;
}
/* ---- add a roof WITHOUT a base map (Mark, 2026-07-19) ----
   Until now the only way to add a roof was promptAddRoof() ->
   rmEnterMultiRoofCapture(), which switches to RoofMapper and expects the user
   to trace an outline. That is the right flow when there IS imagery, and the
   wrong one for the common case Mark described: a 3-roof facility with no base
   map at all, where the inspector just needs to say "there are three roofs,
   this is the TPO one" and get on with the inspection.

   So: name + system only, written straight onto the building's roofs[]. It is
   the SAME structure RoofMapper writes (id/label/roofSystem, base-map fields
   simply absent until someone traces one), so a roof created here is a
   first-class roof -- RoofMapper can adopt it later and attach an outline,
   and every existing reader (getRoofById, the report's roof grouping, the pin
   pickers) already understands it. Deliberately NOT a separate "lightweight
   roof" concept; a second structure would be the thing that rots. */
async function inspectionAddRoof(){
  var info = await lookupProspectiveBuildingRoofInfo();
  if (!info || !info.buildingId){
    toast("Save the job name and address first — a roof belongs to a building.");
    return;
  }
  var suggested = "Roof " + (info.roofs.length + 1);
  var label = prompt("Name this roof (e.g. \"Roof A\", \"North EPDM\"):", suggested);
  if (label === null) return;
  label = String(label).trim();
  if (!label){ toast("A roof needs a name."); return; }
  /* Reuses the SAME duplicate-name guard every other roof-naming path uses
     (new-roof creation, rename from Building History, rename from RoofMapper)
     so two roofs can't both end up called "Roof 1" -- the exact confusion that
     made Mark's earlier multi-roof building unreadable. It warns, auto-suggests
     "{label} (2)" and loops on a retyped duplicate; null means the tech backed
     out, which must abort rather than save something they rejected. */
  if (typeof rmResolveUniqueRoofLabel === "function"){
    label = rmResolveUniqueRoofLabel(info.roofs, label);
    if (label === null) return;
  }
  var types = (typeof allRoofTypes === "function") ? allRoofTypes() : [];
  var system = prompt(
    "Roof system for \"" + label + "\" (optional).\n\n" +
    (types.length ? "Known systems: " + types.join(", ") : ""), "");
  if (system === null) system = "";
  system = String(system).trim();
  /* An unrecognised system is KEPT, not rejected -- the roof-type list is
     explicitly a growing one (SSM and friends were added the same way), and
     refusing a tech's word for a system on a roof would be the wrong failure. */
  if (system && typeof addRoofType === "function") addRoofType(system);
  var roof = { id: genId("roof"), label: label, roofSystem: system,
    roof_base_map_type: null, roof_base_map_url: null, roof_base_map_bounds: null,
    roof_base_map_synthetic: false, roof_assets: [], roof_outlines: [] };
  try{
    await persistBuildingRoof(info.buildingId, roof);
  }catch(e){
    console.warn("Couldn't save the new roof", e);
    toast("Couldn't save that roof — check your connection and try again.");
    return;
  }
  if (currentRoofIds && currentRoofIds.length) currentRoofIds.push(roof.id);
  toast("Added " + label + ".");
  await renderInspectionRoofPicker();
}
/* Appends a roof to buildings/{id}.roofs[] without disturbing the roofs
   already there. Read-modify-write on the whole array, matching
   persistRoofAsset()/removeRoofAsset() in js/photos.js -- same collection,
   same shape, same tier of client write. */
async function persistBuildingRoof(buildingId, roof){
  if (!fdb) throw new Error("offline");
  var ref = fdb.collection("buildings").doc(buildingId);
  var snap = await ref.get();
  var data = snap.exists ? snap.data() : {};
  var roofs = getBuildingRoofs(data).slice();
  /* getBuildingRoofs() SYNTHESISES a default roof for a building that has
     never had an explicit roofs[]. Persisting that synthesised roof alongside
     the new one is deliberate: it makes the implicit first roof real, so it
     can be named and typed like any other instead of staying a phantom. */
  roofs.push(roof);
  await ref.set({ roofs: roofs }, { merge: true });
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
