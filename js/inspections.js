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
