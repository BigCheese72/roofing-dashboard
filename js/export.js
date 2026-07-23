"use strict";
/* ================= document build ================= */
/* A finding shows in the report if it has any text OR any photos attached.
   The has-photos clause is a safeguard (Mark): a finding a tech photographed
   but hasn't captioned yet must NOT silently vanish from the report and drag
   its photos out with it -- better to print the finding (blank text is a
   visible prompt to fill it) than to drop documented photos. */
function findingHasPhotos(f){
  return !!(f && f.id && (photos || []).some(function(p){ return p && p.finding_id === f.id; }));
}
function filledFindings(){ return findings.filter(function(f){ return f.condition || f.location || findingHasPhotos(f); }); }
function filledRepairs(){ return repairs.filter(function(r){ return r.repair || r.location; }); }
function filledRepairItems(){ return repairItems.filter(function(it){ return it.qty || it.notes; }); }
function filledMaterials(){ return materials.filter(function(m){ return m.material || m.qty || m.notes; }); }
/* "Repair #N" exactly as the Work Performed section numbers it
   (filledRepairs() order) for a material row linked to that repair area —
   "" when the row isn't linked, or the linked repair was emptied out and
   no longer prints (a dangling number would point at nothing). */
function materialRepairRefLabel(repairId){
  if (!repairId) return "";
  var fr = filledRepairs();
  for (var i = 0; i < fr.length; i++){
    if (fr[i].id === repairId) return "Repair #" + (i + 1);
  }
  return "";
}
/* One itemized Material List row as a single human line — "Roofing cement
   x2 tube — sealed flashing". Shared by the three Change Order report
   builders (text / HTML doc / PDF) so their Materials section renders the
   itemized materials[] identically. The repair-area ref label is
   deliberately omitted: a Change Order has no Work Performed / repair-area
   card to reference. */
function materialLineLabel(m){
  return m.material + (m.qty ? " x" + m.qty : "") + (m.unit ? " " + m.unit : "") + (m.notes ? " — " + m.notes : "");
}
/* "Finding #N" as the report's findings section numbers it
   (filledFindings() order) for a repair paired to that finding
   (before/after — see the pairing block in js/workorders.js). "" when the
   repair isn't linked, or the linked finding no longer prints. */
function repairResolvesLabel(findingId){
  if (!findingId) return "";
  var ff = filledFindings();
  for (var i = 0; i < ff.length; i++){
    if (ff[i].id === findingId) return "Finding #" + (i + 1);
  }
  return "";
}
function filledPhotos(){ return photos.filter(function(p){ return p.img || (p.caption||"").trim(); }); }
/* ================= return visits (amendments) in the report =================
   An amended work order has to SAY it was amended and print what was
   completed on each return visit (see the amendments block in
   js/workorders.js). Reads o.amendments -- the record being rendered --
   rather than the module global, so a report built from a passed-in order is
   never quietly rendered from whatever is currently on the edit form.

   An entry prints if it has ANY content. Photos are NOT re-embedded here: a
   return visit's photos are ordinary photos[] entries tagged amendment_id, so
   they already print once in Photo Documentation (through the thumbnail grid
   that keeps a photo-heavy preview from freezing the tab -- ece2568). This
   section only cross-references their numbers, exactly like the findings
   table's Photos column. */
function filledAmendments(o){
  return ((o && o.amendments) || []).filter(function(a){
    return a && ((a.workCompleted || "").trim() || (a.hours || "").trim() || (a.crew || "").trim() ||
      amendmentPhotoNos(o, a.id).length);
  });
}
/* Photo numbers (1-based, filledPhotos() order — the same numbering the
   report's Photo Documentation section prints) for one amendment. */
function amendmentPhotoNos(o, amendmentId){
  if (!amendmentId) return [];
  var nos = [];
  filledPhotos().forEach(function(p, i){ if (p && p.amendment_id === amendmentId) nos.push(i + 1); });
  return nos;
}
/* "Visit N" for a photo taken on a return visit, matching this section's own
   numbering (Visit 1 is the original work order, so amendment i is Visit i+2).
   "" for an ordinary first-visit photo. */
function amendmentVisitLabelForPhoto(o, p){
  if (!p || !p.amendment_id) return "";
  var fa = filledAmendments(o);
  for (var i = 0; i < fa.length; i++){
    if (fa[i].id === p.amendment_id) return "Visit " + (i + 2);
  }
  return "";
}
/* The one-line "this work order has been amended" statement for the Job
   Information block. "" when there are no return visits, so an ordinary
   report is byte-for-byte what it always was. */
function amendmentSummaryLine(o){
  var fa = filledAmendments(o);
  if (!fa.length) return "";
  var latest = fa[fa.length - 1];
  return fa.length + " return visit" + (fa.length === 1 ? "" : "s") +
    (latest && latest.date ? " (latest " + latest.date + ")" : "");
}
/* One amendment as report table cells, shared by the HTML and PDF builders so
   the two can never drift: [Visit, Date, Work Completed, Hours, Crew, Photos]. */
function amendmentReportRow(o, a, i){
  var nos = amendmentPhotoNos(o, a.id);
  return ["Visit " + (i + 2), a.date || "", a.workCompleted || "", a.hours || "", a.crew || "",
    nos.length ? nos.map(function(n){ return "#" + n; }).join(", ") : "—"];
}
/* The whole Return Visits section as plain-text lines. "" (no lines) when the
   work order has none, so an unamended report is byte-for-byte unchanged.
   Shared by the leak/work-order and Change Order text builders. */
function amendmentReportTextLines(o){
  var famd = filledAmendments(o);
  if (!famd.length) return [];
  var L = ["RETURN VISITS (AMENDMENTS)",
    "Visit 1 — " + (o.serviceDate || "") + " — original work order (above)"];
  famd.forEach(function(a, i){
    var meta = [];
    if (a.hours) meta.push("Hours: " + a.hours);
    if (a.crew) meta.push("Crew: " + a.crew);
    var nos = amendmentPhotoNos(o, a.id);
    if (nos.length) meta.push("Photos: " + nos.map(function(n){ return "#" + n; }).join(", "));
    L.push("Visit " + (i + 2) + " — " + (a.date || "") + (a.createdBy ? " — logged by " + a.createdBy : ""));
    if (a.workCompleted) L.push("  " + a.workCompleted);
    if (meta.length) L.push("  " + meta.join("  |  "));
  });
  L.push("");
  return L;
}
/* The whole Return Visits section as report HTML. "" when there are none.
   Visit 1 is the ORIGINAL work order, derived from o.serviceDate for context
   — it is not stored in amendments[] and is never rewritten by one. Photos
   are referenced by number only; the images print once in the report's photo
   grid, as thumbnails (see ece2568) so an amended, photo-heavy report can't
   freeze the Preview tab. */
function amendmentReportTableHtml(o){
  var famd = filledAmendments(o);
  if (!famd.length) return "";
  return "<h3 class='cond'>Return Visits (Amendments)</h3>" +
    "<p style='font-size:13px'>This work order was returned to after the original service date. " +
    "The original visit is unchanged; each return visit below records the work completed that day.</p>" +
    "<table><thead><tr><th style='width:60px'>Visit</th><th style='width:80px'>Date</th>" +
    "<th>Work Completed</th><th style='width:60px'>Hours</th><th style='width:110px'>Crew</th>" +
    "<th style='width:80px'>Photos</th></tr></thead><tbody>" +
    "<tr><td>Visit 1</td><td>" + esc(o.serviceDate || "") +
      "</td><td><i>Original work order (see the sections above)</i></td><td>—</td><td>" +
      esc(o.technician || "—") + "</td><td>—</td></tr>" +
    famd.map(function(a, i){
      var cells = amendmentReportRow(o, a, i);
      return "<tr><td>" + esc(cells[0]) + "</td><td>" + esc(cells[1]) +
        "</td><td style='white-space:pre-wrap'>" + esc(cells[2]) +
        (a.createdBy ? "<div style='color:#5B6770;font-size:12px;margin-top:2px'>Logged by " + esc(a.createdBy) + "</div>" : "") +
        "</td><td>" + (esc(cells[3]) || "—") + "</td><td>" + (esc(cells[4]) || "—") +
        "</td><td>" + esc(cells[5]) + "</td></tr>";
    }).join("") + "</tbody></table>";
}
/* autoTable body rows for the same section — Visit 1 first, then each
   amendment. Shared by both PDF builders; head columns match
   amendmentReportRow()'s order. */
function amendmentReportPdfBody(o){
  return [["Visit 1", o.serviceDate || "", "Original work order (see above)", "—", o.technician || "—", "—"]]
    .concat(filledAmendments(o).map(function(a, i){
      var cells = amendmentReportRow(o, a, i);
      return [cells[0], cells[1], cells[2] + (a.createdBy ? "\n(logged by " + a.createdBy + ")" : ""),
        cells[3] || "—", cells[4] || "—", cells[5]];
    }));
}
var AMENDMENT_PDF_HEAD = [["Visit", "Date", "Work Completed", "Hours", "Crew", "Photos"]];
var AMENDMENT_PDF_COLUMN_STYLES = { 0: { cellWidth: 44 }, 1: { cellWidth: 55 }, 3: { cellWidth: 40 }, 5: { cellWidth: 55 } };

/* Routes by work order type — Change Order gets its own distinct
   document (buildChangeOrderText/renderChangeOrderDoc/
   generateChangeOrderPdf), not a bolted-on section of the leak report.
   See "Change Order gets its own PDF template" in DEV_NOTES.md. Repair
   reuses this same leak-report builder (see buildLeakReportText below) —
   Mark asked for "most of the same info," just with the findings section
   swapped for repair scope, not a fully separate template like Change
   Order. Inspection/Warranty still use it completely unchanged. */
function buildText(){
  var o = collect();
  return o.woType === "Change Order" ? buildChangeOrderText(o) : buildLeakReportText(o);
}
function buildLeakReportText(o){
  var isRepair = o.woType === "Repair";
  var isInspection = o.woType === "Inspection";
  var L = [];
  L.push(isRepair ? "WORK ORDER REPORT" : (isInspection ? "ROOFING INSPECTION REPORT" : "LEAK WORK ORDER / REPAIR DOCUMENTATION"));
  L.push(o.jobName + (o.location ? " - " + o.location : ""));
  L.push("");
  L.push("JOB INFORMATION");
  /* woTypeLabel(), never the raw o.woType — an existing record still stores
     "Repair" and must print as "Work Order". See WORK_ORDER_TYPE_LABELS. */
  L.push("Work Order Type: " + woTypeLabel(o.woType));
  L.push("Job Name: " + o.jobName);
  L.push("Location: " + o.location);
  if (o.suite) L.push("Suite: " + o.suite);
  L.push("Date of Service: " + o.serviceDate);
  L.push("Job No.: " + o.jobNo);
  L.push("Bill To: " + o.billTo);
  if (o.billContact) L.push((o.billTo || "Billing") + " Contact: " + o.billContact);
  if (o.billPhone) L.push("Contact Phone: " + o.billPhone);
  L.push("Site Contact: " + o.siteContact);
  if (o.technician) L.push("Technician: " + o.technician);
  if (!isInspection) L.push("Reported Leak Area: " + o.reportedArea);
  L.push("Roof System: " + o.roofSystem);
  /* States up front that this is an amended work order — the Date of Service
     above is the ORIGINAL visit and stays that way, so without this line a
     reader has no signal until the Return Visits section further down. */
  var amdLine = amendmentSummaryLine(o);
  if (amdLine) L.push("Return Visits: " + amdLine);
  L.push("");
  if (isRepair){
    L.push("REPAIR SCOPE");
    if (o.repairDescription) L.push(o.repairDescription);
    var ri = filledRepairItems();
    if (ri.length){
      L.push("");
      ri.forEach(function(it,i){
        L.push((i+1) + ". " + it.type + (it.qty ? " x" + it.qty : "") + (it.notes ? " — " + it.notes : ""));
      });
    }
  } else {
    if (isInspection){
      L.push("INSPECTION CHECKLIST");
      (o.inspectionChecklist || []).forEach(function(item){
        L.push(inspectionComponentLabel(item.key) + ": " + item.rating + (item.notes ? " — " + item.notes : ""));
      });
      L.push("");
    }
    L.push(isInspection ? "ROOFING INSPECTION FINDINGS" : "ROOF INVESTIGATION FINDINGS");
    filledFindings().forEach(function(f,i){
      L.push((i+1) + ". " + f.condition + (f.location ? " — " + f.location : "") + " [" + f.warranty + "]");
    });
  }
  /* Print-if-present, NOT gated by type. The Leak form no longer offers a
     "Work Performed" card (a leak work order is a pure investigation now —
     see onWoTypeChange()), so a NEW leak simply has no repairs[] rows and
     this section never appears. But a LEGACY leak record saved before that
     change may genuinely contain repair rows, and its report must still
     print what it actually contains — hard-gating this by type would
     silently drop real data out of old reports. Matches renderLeakReportDoc()
     and generateLeakReportPdf(), which already gate on filledRepairs().length.
     Previously this header printed unconditionally for every non-Change-Order
     type, even with zero rows. */
  var fr = filledRepairs();
  if (fr.length){
    L.push("");
    L.push("WORK PERFORMED");
    fr.forEach(function(r,i){
      var resolves = repairResolvesLabel(r.finding_id);
      L.push((i+1) + ". " + r.repair + (r.location ? " — " + r.location : "") +
        (resolves ? " [resolves " + resolves + " — before/after]" : ""));
    });
    L.push("");
  }
  /* Return visits, in the order they were logged — after the original visit's
     work, before materials. Each is its own labeled entry; the original above
     is never rewritten by one. */
  amendmentReportTextLines(o).forEach(function(ln){ L.push(ln); });
  /* Print-if-present like WORK PERFORMED above — the Material List card is
     only OFFERED on the Repair form (see onWoTypeChange()), but any record
     that has rows prints them. */
  var fmat = filledMaterials();
  if (fmat.length){
    L.push("MATERIAL LIST");
    fmat.forEach(function(m,i){
      var ref = materialRepairRefLabel(m.repair_id);
      L.push((i+1) + ". " + m.material + (m.qty ? " x" + m.qty : "") + (m.unit ? " " + m.unit : "") +
        (m.notes ? " — " + m.notes : "") + (ref ? " [" + ref + "]" : ""));
    });
    L.push("");
  }
  if (!isInspection){
    L.push("WARRANTY DETERMINATION");
    if (o.warrantable) L.push("Warrantable Repairs: " + o.warrantable);
    if (o.nonWarrantable) L.push("Non-Warrantable Repairs: " + o.nonWarrantable);
    if (o.mfgServiceNo) L.push("Manufacturer Service #: " + o.mfgServiceNo);
    L.push("");
  }
  L.push("SUMMARY");
  if (o.summary) L.push(o.summary);
  var caps = filledPhotos();
  if (caps.length){
    L.push(""); L.push("PHOTO DOCUMENTATION");
    L.push("(" + caps.length + " photo" + (caps.length > 1 ? "s" : "") + " — see attached PDF for images)");
    caps.forEach(function(p,i){ L.push("Photo " + (i+1) + ": " + (p.caption || "")); });
  }
  L.push("");
  L.push(o.jobName + " - " + o.location + " | Job No. " + o.jobNo + " | Date of Service: " + o.serviceDate);
  return L.join("\n");
}
/* Deliberately does NOT include findings/warranty framing — a change
   order is a work-authorization document, not a leak inspection
   report. Photos are secondary here (see spec) so they're mentioned
   but not itemized like the leak report does. */
function buildChangeOrderText(o){
  var L = [];
  L.push("CHANGE ORDER");
  L.push(o.jobName + (o.location ? " - " + o.location : ""));
  L.push("");
  L.push("JOB INFORMATION");
  L.push("Job Name: " + o.jobName);
  L.push("Location: " + o.location);
  if (o.suite) L.push("Suite: " + o.suite);
  L.push("Date: " + o.serviceDate);
  L.push("Job No.: " + o.jobNo);
  L.push("Bill To: " + o.billTo);
  if (o.billContact) L.push((o.billTo || "Billing") + " Contact: " + o.billContact);
  if (o.billPhone) L.push("Contact Phone: " + o.billPhone);
  L.push("Site Contact: " + o.siteContact);
  if (o.technician) L.push("Technician: " + o.technician);
  if (o.woPONumber) L.push("PO Number: " + o.woPONumber);
  if (o.woDateCompleted) L.push("Date Completed: " + o.woDateCompleted);
  L.push("");
  L.push("DESCRIPTION OF WORK PERFORMED");
  if (o.woDescription) L.push(o.woDescription);
  L.push("");
  L.push("MATERIALS");
  /* Itemized Material List (materials[]) is the primary materials entry on a
     Change Order now; the legacy free-text #woMaterials still prints below it
     as "Additional Material Notes" whenever a record carries it, so no
     historical CO loses its data. */
  var coMat = filledMaterials();
  coMat.forEach(function(m,i){ L.push((i+1) + ". " + materialLineLabel(m)); });
  if (o.woMaterials){
    if (coMat.length) L.push("");
    L.push("Additional Material Notes:");
    L.push(o.woMaterials);
  }
  L.push("");
  /* Return visits print here too, for the same print-if-present reason
     Materials does: a change order that was returned to must not silently
     drop those records just because this is a different template. */
  amendmentReportTextLines(o).forEach(function(ln){ L.push(ln); });
  L.push("MAN-HOURS: " + (o.woManHours || ""));
  L.push("COST: " + (o.woCost ? "$" + o.woCost : ""));
  L.push("TOTAL: " + (o.woCost ? "$" + o.woCost : ""));
  var caps = filledPhotos();
  if (caps.length){
    L.push(""); L.push("PHOTOS");
    L.push("(" + caps.length + " photo" + (caps.length > 1 ? "s" : "") + " — see attached PDF for images)");
  }
  L.push("");
  if (o.changeOrderSignature && o.changeOrderSignature.img){
    L.push("Signed by: " + o.changeOrderSignature.printName + "   Date: " + o.changeOrderSignature.date +
      "  (signature captured on device — see attached PDF)");
  } else {
    L.push("Approved by: _______________________________   Date: ______________");
  }
  L.push("");
  L.push(o.jobName + " - " + o.location + " | Job No. " + o.jobNo + " | Date: " + o.serviceDate);
  return L.join("\n");
}

function kvTable(rows){
  var body = rows.filter(function(r){ return r[1]; }).map(function(r){
    return "<tr><td class='k'>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>";
  }).join("");
  return body ? "<table><tbody>" + body + "</tbody></table>" : "";
}

/* Preview and every export path share the exact same photo-integrity risk
   -- see ensurePhotosLoadedForExport()'s own comment below. Preview/Edit
   tabs call this instead of showView('preview') directly so a photo-
   stripped record gets the same loud warning before rendering, not just
   before generating a PDF. */
/* Populated by goToPreview() BEFORE showView("preview") triggers core.js's
   synchronous renderDoc() -- js/core.js is out of scope for this change
   (showView() lives there, unmodified), so the roof plan fetch has to
   happen entirely on this side of that call: renderLeakReportDoc() stays
   deliberately synchronous (no Firestore access mid-render, same as
   always) and just reads whatever this module-level var already holds by
   the time it runs.

   PR #17 review, QUESTION 1: this used to be a bare array with no
   identity check. If renderDoc() ever fires again for a DIFFERENT work
   order before a fresh goToPreview() completes for it, the previous
   order's roof plan and field-measurement table would render on the new
   order's customer-facing document -- a wrong-roof provenance block.
   Keyed to `currentId` (js/workorders.js's own module-level "which order
   is currently loaded" var) rather than collect().id: collect() builds a
   FRESH id (`"wo_" + Date.now()`) on every call for a not-yet-saved order
   (currentId still null), so comparing against collect().id would treat
   the SAME unsaved order as stale on every single render. currentId stays
   stable until the order is actually saved/loaded/reset, which is the
   identity that actually matters here. rmReportRoofPlanEntriesFor() is
   the single read path -- nothing should read rmReportRoofPlanData
   directly. */
var rmReportRoofPlanData = null; /* { woId, entries } | null */
function rmReportRoofPlanEntriesFor(){
  if (!rmReportRoofPlanData || rmReportRoofPlanData.woId !== currentId) return [];
  return rmReportRoofPlanData.entries;
}
async function goToPreview(){
  var photoCheck = await ensurePhotosLoadedForExport();
  if (!photoCheck.ok){
    /* Preview is intentionally non-blocking (unlike generatePdf) -- the tech
       may want to look before deciding. For a genuinely dead slot, offer the
       one-tap cleanup; whether they take it or not, continue to Preview. */
    if (photoCheck.reason === "dead"){
      if (!offerRemoveDeadPhotos(photoCheck)) alert(deadPhotosWarning(photoCheck.deadNums));
    } else {
      alert(photosMissingWarning(photoCheck.missingCount));
    }
  }
  var roofPlanResult = await rmFetchReportRoofOutlines(collect());
  if (roofPlanResult.error) toast("Roof plan couldn't be loaded: " + roofPlanResult.error);
  rmReportRoofPlanData = { woId: currentId, entries: roofPlanResult.roofEntries };
  showView("preview");
}
function renderDoc(){
  var o = collect();
  document.getElementById("doc-output").innerHTML =
    o.woType === "Change Order" ? renderChangeOrderDoc(o) : renderLeakReportDoc(o);
  populateEmailPick();
  /* Default "Send to" -- marks@ on every work order type, plus charlottew@
     for Leak / Service specifically. Only fills an EMPTY box so it never
     clobbers a recipient list the user already picked/typed (e.g. flipping
     back and forth between Edit and Preview on the same order). */
  var toBox = document.getElementById("emailTo");
  if (toBox && !toBox.value.trim()){
    /* Leak / Service already defaults to Charlotte (she handles billing).
       A "Leak – No Job" ticket defaults to her too, whatever its type —
       she's the Foundation record-keeper who has to create the real job
       (see isLeakNoJobOrder() in js/workorders.js). Still just a DEFAULT
       into an empty box: the tech sees it and can adjust before sending. */
    var defaultToCharlotte = o.woType === WORK_ORDER_TYPES[0] ||
      (typeof isLeakNoJobOrder === "function" && isLeakNoJobOrder(o));
    toBox.value = (defaultToCharlotte ? EMAIL_DEFAULT_TO_LEAK : EMAIL_DEFAULT_TO).join(", ");
  }
}
/* Every DISTINCT roofId actually present among this report's findings
   (falling back to the work order's own single roofId for a finding with
   none of its own), in a stable, sensible order: o.roofIds' own selection
   order first (a multi-select Inspection), then any further roofIds
   first-seen among the findings themselves (GPS auto-assign can produce a
   roofId that was never part of a manual multi-select at all, on ANY
   work order type). Length <= 1 means "nothing to group/state" -- the
   report renders exactly as it always did for a single-roof case. See
   "GPS auto-assign photos to roofs" in DEV_NOTES.md. */
function reportDistinctRoofIds(o){
  var ids = (o.roofIds || []).slice();
  filledFindings().forEach(function(f){
    var rid = f.roofId || o.roofId;
    if (rid && ids.indexOf(rid) === -1) ids.push(rid);
  });
  return ids;
}

/* ================= roof plan + capture/scale provenance =================
   Codex's field-measured-dimensions work (js/roofmapper.js, merged to dev
   via PR #7) gives every roof_outlines[] entry two independent, persisted
   fields -- outline.captureSource (how the geometry was traced; immutable,
   a tape never changes it) and outline.scaleSource (how the SCALE FACTOR
   was determined; independent, not a rung on the capture confidence
   ladder) -- plus outline.edgeMeasurements[] (per-edge tape readings,
   archived not deleted). This section is the REPORT-FACING render of that
   data: nothing here recomputes a factor or re-derives a classification --
   every function below either reads outline.* fields directly, or calls
   roofmapper.js's own read-only accessors (rmOutlineMeasurementMethod(),
   rmGetMeasuredEdge(), rmAllMeasuredEdgeRecords(), rmMeasurementDecisionLabel())
   so the exact same classification logic Codex built and tested drives what
   the customer sees -- no second, drifting copy of that logic lives here.
   See "Report provenance rendering" in DEV_NOTES.md. */

/* Fetches the report's linked building — STRICTLY READ-ONLY. Fixed
   (2026-07-13, PR #17 review) after a real bug: this used to call
   ensureCustomerAndBuilding() (js/core.js), which despite its name WRITES
   -- customers.set(), buildings.set() (creates the doc if it doesn't
   exist), and saveBuildingRoofs() (rewrites the entire roofs[] array,
   including the edgeMeasurements/captureSource/scaleSource fields PR #7
   just landed). Called from two READ-ONLY entry points -- opening Preview,
   tapping Download PDF -- that means just LOOKING at a report was
   mutating production data: conjuring a phantom buildings/ doc from a
   typo'd job name, and rewriting the roofs array on every single preview.
   Both failure directions were silent (both layers swallowed errors).

   Fixed by deriving the SAME deterministic bld_/cust_ id
   (slugify() is a pure string utility, safe to call directly -- this is
   NOT a re-derivation of business logic, it's the literal id-formation
   formula, which has to live somewhere read-only-safe since
   ensureCustomerAndBuilding() itself can't be used here) and doing exactly
   ONE read: fdb.collection("buildings").doc(bldId).get(). No .set(), no
   .update(), no saveBuildingRoofs(), no side effects of any kind. If the
   building genuinely doesn't exist, this returns roofEntries:[] and the
   report renders from the work order's own data alone, same as it always
   did before this feature existed -- it does NOT create the building to
   make the roof plan render.

   Errors are NOT swallowed: a real lookup failure (network error,
   permissions) returns `error` for the caller to surface (see
   goToPreview()/generatePdf()) rather than silently rendering as if there
   were simply no linked building -- those are different states and a
   report reader deserves to know which one happened. This function itself
   still never THROWS (a bad Firestore read must not crash Preview/PDF
   generation entirely -- the roof plan is a valuable addition to the
   report, not a hard requirement for it to render at all). */
/* Classifies a roof's latest outline for the report roof plan (issue #44).
   - world-coordinate ring (>=3 pts): drawable to scale.
   - image-frame-only (PR #43 / #40 synthetic-ortho shape: ring:[] + imageRing,
     imageFrame:"roof_base_map"/tracedOnOrtho): INCLUDED but planUnavailable --
     the report still quotes its area/perimeter, so it must be NAMED with a
     notice, never dropped. It can't be drawn to scale here: imageRing x/y are
     image-fractional and anisotropic, and the source image's pixel aspect
     isn't stored on the outline, so drawing it would distort the roof. */
function rmReportOutlineDrawability(outline){
  if (!outline) return { include: false, planUnavailable: false };
  var hasWorldRing = Array.isArray(outline.ring) && outline.ring.length >= 3;
  if (hasWorldRing) return { include: true, planUnavailable: false };
  var hasImageFrame = outline.imageFrame === "roof_base_map" || outline.tracedOnOrtho === true ||
    (Array.isArray(outline.imageRing) && outline.imageRing.length >= 3);
  return { include: hasImageFrame, planUnavailable: hasImageFrame };
}
async function rmFetchReportRoofOutlines(o){
  /* Stored id first (audit FIX 1), canonical name-slug (buildingIdFor(),
     js/core.js) as the legacy fallback. */
  var bldId = o.buildingId || buildingIdFor(o.billTo, o.jobName);
  if (!fdb || !bldId) return { roofEntries: [], error: null };
  try{
    var snap = await fdb.collection("buildings").doc(bldId).get(); /* READ ONLY -- see comment above; never .set()/.update() from this path */
    if (!snap.exists) return { roofEntries: [], error: null };
    var bld = snap.data();
    var roofs = getBuildingRoofs(bld); /* pure in-memory transform, no I/O -- confirmed by reading its body */
    if (!roofs.length) return { roofEntries: [], error: null };
    var ids = reportDistinctRoofIds(o);
    if (!ids.length && roofs.length === 1) ids = [roofs[0].id];
    var out = [];
    ids.forEach(function(id){
      var roof = roofs.find(function(r){ return r.id === id; });
      if (!roof) return;
      var outlines = roof.roof_outlines || [];
      var outline = outlines[outlines.length - 1];
      var draw = rmReportOutlineDrawability(outline);
      if (!draw.include) return;
      out.push({
        roofId: id,
        roofLabel: roof.label || (o.roofLabels && o.roofLabels[id]) || "Roof",
        outline: outline,
        assets: (roof.roof_assets || []).filter(function(a){ return typeof a.lat === "number" && typeof a.lng === "number"; }),
        planUnavailable: draw.planUnavailable
      });
    });
    return { roofEntries: out, error: null };
  }catch(e){
    /* NOT swallowed -- returned for the caller to surface (toast), per
       PR #17 review. A failed lookup and "no linked building" are
       different states; the report reader deserves to know which. */
    return { roofEntries: [], error: e.message || "Couldn't load the roof plan." };
  }
}

/* Two independent sentences -- capture, then scale -- NEVER merged into
   one confidence claim (Mark's explicit ask: "the second sentence must
   never upgrade the first"). Reads outline.captureSource/.scaleSource via
   rmOutlineMeasurementMethod() (roofmapper.js, pure/read-only -- confirmed
   it neither mutates the outline nor touches Firestore) rather than
   reimplementing the source-code-to-label mapping here, so a change to
   Codex's classification logic (e.g. a new capture mechanism) shows up
   here automatically instead of silently drifting out of sync. */
function rmReportMethodSentences(outline){
  if (typeof rmOutlineMeasurementMethod !== "function"){
    return { captureSentence: "Capture source unknown.", scaleSentence: "Scale source unknown.", captureSource: null, scaleSource: null };
  }
  var method = rmOutlineMeasurementMethod(outline) || {};
  var cs = method.captureSource || null;
  var ss = method.scaleSource || null;
  return {
    captureSentence: rmReportCaptureSentence(cs),
    scaleSentence: rmReportScaleSentence(ss, outline),
    captureSource: cs,
    scaleSource: ss
  };
}
function rmReportFeetLabel(ft){
  if (typeof ft !== "number" || !isFinite(ft)) return null;
  var rounded = Math.round(ft);
  return (Math.abs(ft - rounded) < 0.05 ? String(rounded) : String(Math.round(ft * 10) / 10)) + " ft";
}
function rmReportCaptureSentence(cs){
  if (!cs || cs.mechanism === "unknown") return "Capture source unknown.";
  var PHRASES = {
    geotiff: "an RTK orthomosaic (survey-grade)",
    kmz_overlay: "a KMZ/KML ground overlay (approximate)",
    ortho_image: "satellite/flat imagery (estimated)",
    manual_map: "satellite/flat imagery (estimated)",
    walk_corners: "corners walked with a phone GPS (field GPS, approximate)",
    osm: "OpenStreetMap public footprint data (public map)"
  };
  var phrase = PHRASES[cs.mechanism];
  var sentence = "Traced from " + (phrase || (cs.label || "an unspecified source")) + ".";
  /* KMZ ground overlays carry their own worst-case error figure --
     genuinely useful provenance, not decoration, so it's surfaced rather
     than left buried in cs.label's longer internal string. */
  if (typeof cs.maxQuadBBoxErrorFt === "number" && cs.maxQuadBBoxErrorFt > 0){
    sentence += " Max quad error ~" + (Math.round(cs.maxQuadBBoxErrorFt * 10) / 10) + " ft.";
  }
  return sentence;
}
/* ---- Scale sentence: built by COMPOSING independent clauses, never by
   an if/else that picks one and assumes it's alone. This replaced two
   earlier branch-based attempts (PR #17 review REQUIRED 3, then REQUIRED
   4) that each fixed one interaction and broke another -- REQUIRED 3's
   fix preempted the inherited/image disclosure; REQUIRED 4's fix (a
   single optional "supplemental" slot that refused to fire whenever
   ss.kind==="measured") had no way to disclose a THIRD fact once PR #25/
   #26 landed measurementStale: a roof that was taped, then re-snapped
   (which invalidates the tape's specific edge/length but keeps its SCALE
   in force -- see rmMeasurementScaleStillApplied()'s "keeps scale"
   reason list in roofmapper.js), then taped again, has THREE facts on
   record (an applied-but-now-edge-stale reading, and whatever superseded
   it) and the old one-slot model could only ever surface one.

   The fix: the scale sentence is TWO independent clauses, computed
   separately and concatenated, never selected between:

   CLAUSE 2 (applied scale) -- how the drawing's CURRENTLY-APPLIED scale
   was determined: measured / inherited / image, or absent entirely when
   ss.kind is "none"/unknown (absent is not the same as "not verified" --
   see the fallback at the bottom). When measured AND NOT stale, names the
   exact edge/length AND marks that record as fully disclosed (so clause 3
   doesn't repeat it). When measured but ss.measurementStale (PR #25/#26
   deliberately nulls the specific edge/length in this case, since the
   original edge no longer corresponds to current geometry after the
   edit) states that plainly without inventing a number, and does NOT mark
   anything as disclosed -- the real number still needs to reach the
   reader, which is clause 3's job.

   CLAUSE 3 (additional measurements on record) -- every OTHER measurement
   record (rmAllMeasuredEdgeRecords(), same source of truth the Field
   Measurements table renders from) that clause 2 didn't already fully
   name, each with its own status: applied (a genuinely separate, still-
   active applied reading -- compounding recalibrations), recorded-only /
   kept-existing-scale (rmMeasurementDecisionLabel()), or superseded (by
   remeasure, or by a "keeps scale" geometry edit like a re-snap -- named
   explicitly as superseded, never silently dropped and never presented as
   if it were current).

   Nothing here can suppress anything else: clause 2 is computed from
   ss.kind alone; clause 3 is computed from every record minus AT MOST one
   (whatever clause 2 fully named). Adding a measurement can only ADD a
   clause-3 item, never remove clause 2. "No field scale recorded... not
   verified against a physical measurement" is the FALLBACK, used only
   when BOTH clauses come back empty -- it can never appear next to a real
   measurement disclosure, because if any measurement exists (of any
   status) clause 3 is non-empty by construction. */
function rmReportMeasuredScaleSentence(measuredFt, edgeIndex){
  var detail = "";
  var ftLabel = rmReportFeetLabel(measuredFt);
  if (ftLabel && typeof edgeIndex === "number") detail = " (" + ftLabel + " on edge " + (edgeIndex + 1) + ")";
  else if (ftLabel) detail = " (" + ftLabel + " measured)";
  return "Scale set by field measurement" + detail + ".";
}
/* Returns { text, disclosedId } -- disclosedId is the ONE measurement
   record id clause 2 fully named (its real edge+length are already in
   the sentence), if any, so clause 3 doesn't repeat it. text is "" when
   ss.kind is "none"/unknown -- that is the ABSENCE of an applied-scale
   clause, not a sentence of its own; the "not verified" fallback is
   decided later, once clause 3 is known too. */
function rmReportAppliedScaleClause(ss, outline){
  if (ss && ss.kind === "measured"){
    if (ss.measurementStale){
      /* roofmapper (rmBuildScaleSource(), PR #25/#26) deliberately nulls
         ss.measuredFt/edgeIndex/measurementId here whenever measurementStale
         is set -- but NOT every stale reason means the same thing (see
         below): a genuine geometry edit really did move the original edge,
         so citing "edge N" would be a stale claim about current geometry
         and this function stays non-specific for that case, relying on
         clause 3 to supply the historical number (disclosedId left null).
         A supersede-by-remeasure never moved anything, so THAT case names
         the real edge/length directly and excludes it from clause 3 via
         disclosedId instead -- see the reason-gated branches below, not a
         single "always vague, always null" rule. */
      /* Issue #29 -- this used to hardcode "the edge it was taken on has
         since been edited" for EVERY stale reason. measurementStale is
         also set for invalidatedReason==="superseded_by_remeasure" --
         which is NOT a geometry edit, nothing moved, the SAME edge was
         just taped again. Asserting "edited" there was a fabricated claim
         on a customer PDF.

         PR #30 review found the first attempt at this fix stopped short
         in two ways (REQUIRED 20/21):
         - It called rmReportMeasurementStatusLabel(staleRecord) WITHOUT
           first confirming staleRecord.invalidatedAt was actually set --
           ss.measurementStale and a freshly re-derived staleRecord could
           in principle disagree (a snapshot ss vs. live outline), and
           rmReportMeasurementStatusLabel()'s own first line
           (`if (!m.invalidatedAt) return m.rescaleApplied ? "applied" :
           decisionLabel;`) would then render a confident, contentless
           "(applied)" -- dropping both the measured length AND the
           staleness. Both branches below now gate on staleRecord.invalidatedAt
           explicitly before doing anything with it.
         - For superseded_by_remeasure specifically, geometry was NEVER
           touched -- staleRecord.measuredFt/.edgeIndex are STILL TRUE
           statements about the current drawing, and it's the reading
           whose rescale is actually in force. The first attempt described
           its STATUS ("superseded by...") but never NAMED it, then left
           disclosedId: null, so clause 3 re-printed the identical status
           string for the identical record one line later under
           "Additional" -- verbatim duplication, and the record wasn't
           "additional" to anything. Fixed by reason-gating: a genuine
           supersede-by-remeasure NAMES the real edge+length (matching
           what issue #29 asked for in the first place) and discloses the
           id so clause 3 doesn't repeat it; a genuine geometry edit
           (resnap/square_up/align/vertex_edit) still stays non-specific
           about the edge number (the original edge no longer corresponds
           to current geometry after those) and leaves disclosedId null so
           clause 3 supplies the historical number instead.

         Clause 2 and clause 3 still can't drift apart into a self-
         contradiction, because whichever branch fires here uses either
         rmReportMeasuredScaleSentence() (the same namer the non-stale
         "measured" path already uses) or rmReportMeasurementStatusLabel()
         (clause 3's own function) -- never a third, independent copy of
         "what does this reason mean." Defense-in-depth alongside Codex's
         issue #28 (fixing measurementStale itself, roofmapper-side, so it
         only means "a geometry edit moved this edge") -- this reads the
         real invalidatedReason regardless of what the flag means. */
      var staleRecord = (outline && typeof rmLatestAppliedMeasuredEdge === "function") ? rmLatestAppliedMeasuredEdge(outline) : null;
      if (staleRecord && staleRecord.invalidatedAt && staleRecord.invalidatedReason === "superseded_by_remeasure"){
        return { text: rmReportMeasuredScaleSentence(staleRecord.measuredFt, staleRecord.edgeIndex), disclosedId: staleRecord.id || null };
      }
      var staleReasonText = (staleRecord && staleRecord.invalidatedAt) ? rmReportMeasurementStatusLabel(staleRecord) :
        (ss.measurementInvalidatedReason ? String(ss.measurementInvalidatedReason).replace(/_/g, " ") : null);
      /* Prefer honest silence over a vague specific claim -- clause 3
         always carries the record when it exists, so nothing is lost by
         not fabricating a caveat here when the reason itself is unknown. */
      return { text: "Scale set by a field measurement on this roof" + (staleReasonText ? " (" + staleReasonText + ")" : "") + ".", disclosedId: null };
    }
    return { text: rmReportMeasuredScaleSentence(ss.measuredFt, ss.edgeIndex), disclosedId: ss.measurementId || null };
  }
  if (ss && ss.kind === "image") return { text: "Scale derived from the georeferenced source image; not field-verified.", disclosedId: null };
  if (ss && ss.kind === "inherited"){
    return {
      text: "Scale carried from a field-measured section on this building" + (typeof ss.factor === "number" ? "." : " (exact factor not on record)."),
      disclosedId: null
    };
  }
  return { text: "", disclosedId: null };
}
/* Human status for one edgeMeasurements record, for clause 3's list --
   NOT the same wording rmMeasurementDecisionLabel() alone would give,
   because clause 3 additionally needs to distinguish "superseded by a
   geometry edit that kept the scale in force" (rmMeasurementInvalidationKeepsScale,
   PR #25/#26) from a plain archived/no-longer-relevant entry. */
function rmReportMeasurementStatusLabel(m){
  var decisionLabel = typeof rmMeasurementDecisionLabel === "function" ? rmMeasurementDecisionLabel(m) : (m.decision || "recorded");
  if (!m.invalidatedAt) return m.rescaleApplied ? "applied" : decisionLabel;
  var reasonText = m.invalidatedReason ? String(m.invalidatedReason).replace(/_/g, " ") : "geometry edit";
  /* "invalidated" here does NOT mean "no longer in force" -- that is the
     trap. rmMeasurementInvalidationKeepsScale() (roofmapper.js:1185)
     returns TRUE for every reason we currently emit, because none of
     vertex_edit / square_up / resnap_neighbors / align_outline UN-scale
     the ring: the tape's correction is still physically in the geometry,
     only the edge it was taken on has moved. Labelling those "superseded"
     would tell the reader the measurement is no longer in effect, which is
     false in exactly the direction that matters -- so we say what actually
     happened to it instead. */
  if (m.invalidatedReason === "superseded_by_remeasure"){
    return "superseded by a later re-measurement" +
      (m.rescaleApplied ? "; its rescale is still in this drawing" : "");
  }
  var keepsScale = typeof rmMeasurementInvalidationKeepsScale === "function" && rmMeasurementInvalidationKeepsScale(m.invalidatedReason);
  /* No parentheses in these labels -- clause 3 already wraps the status in
     parens, and a nested "(still applied; edge since edited (resnap
     neighbors))" reads like a bug on a customer-facing PDF. */
  if (keepsScale){
    return (m.rescaleApplied ? "still applied; edge since edited by " : "recorded; edge since edited by ") + reasonText;
  }
  return "archived after " + reasonText;
}
/* Clause 3: every measurement record NOT already fully named by clause 2
   (rmAllMeasuredEdgeRecords() -- the exact same source of truth the Field
   Measurements table renders from, so the two can never disagree about
   WHICH measurements exist). A record is excluded only by exact id match
   against disclosedId; nothing is excluded by kind/status, so a stale
   record, a declined-but-active record, and a genuinely superseded record
   all reach the reader every time they exist. Guards edgeIndex with
   typeof === "number" (null + 1 === 1 in JS would otherwise fabricate
   "edge 1" for a record with no known edge index). */
function rmReportAdditionalMeasurementsClause(outline, disclosedId){
  if (!outline || typeof rmAllMeasuredEdgeRecords !== "function") return "";
  var records = rmAllMeasuredEdgeRecords(outline).filter(function(m){ return m && m.id !== disclosedId; });
  if (!records.length) return "";
  records = records.slice().sort(function(a, b){ return (b.measuredAt || 0) - (a.measuredAt || 0); });
  var parts = records.map(function(m){
    var ftLabel = rmReportFeetLabel(m.measuredFt);
    var edgeLabel = typeof m.edgeIndex === "number" ? ("edge " + (m.edgeIndex + 1)) : "an unspecified edge";
    return (ftLabel || "an unspecified length") + " on " + edgeLabel + " (" + rmReportMeasurementStatusLabel(m) + ")";
  });
  var lead = parts.length === 1 ? "Also on record: " : "Additional field measurements on record: ";
  return lead + parts.join("; ") + " — see Field Measurements.";
}
/* Composes clause 2 + clause 3. The ONLY place allowed to decide what an
   ABSENT applied-scale clause means, because that answer depends on clause
   3 as well:

   ss.kind "none"  -- we KNOW nothing was applied. But "no field scale was
     applied" and "no tape exists" are DIFFERENT facts, and the old wording
     ("not verified against a physical measurement") asserted the second
     while only being entitled to the first. That sentence next to a real
     tape reading is the REQUIRED 6 self-contradiction. So the "not
     verified" clause is used ONLY when clause 3 is empty -- i.e. only when
     there is genuinely no measurement of any status on this roof. When a
     tape does exist but was not applied, we still state the as-drawn fact
     (the reader needs it -- a roof with MORE provenance must never
     disclose LESS, per REQUIRED 4), just without denying the tape.

   ss.kind unknown / ss missing -- we DON'T know. Say so. The previous
     revision of this function collapsed this into the "none" fallback,
     which fabricates a specific claim ("no field scale recorded") out of an
     absence of information. Honest unknown beats a confident wrong answer. */
function rmReportScaleSentence(ss, outline){
  var applied = rmReportAppliedScaleClause(ss, outline);
  var additional = rmReportAdditionalMeasurementsClause(outline, applied.disclosedId);
  if (applied.text) return additional ? (applied.text + " " + additional) : applied.text;
  if (!ss || ss.kind !== "none"){
    return additional ? ("Scale source unknown. " + additional) : "Scale source unknown.";
  }
  if (additional){
    return "No field measurement was applied to this drawing's scale — dimensions are as-drawn. " + additional;
  }
  return "No field scale recorded — dimensions are as-drawn, not verified against a physical measurement.";
}
/* Per-edge visual distinction (Mark's explicit "must look different at a
   glance, a derived edge must NEVER wear a measured badge" -- this exact
   bug was caught four times on the capture side). Delegates straight to
   rmEdgeDimensionMeta() (roofmapper.js) rather than re-deriving "is this
   edge measured, does it conflict with the drawing" here -- that function
   already reads rmGetMeasuredEdge() + a tolerance comparison and is the
   SAME logic that drives the live map's own edge labels, so the report and
   the live map can never show a measured edge differently from each other. */
function rmReportEdgeMeta(outline, edgeIndex, distFt){
  if (typeof rmEdgeDimensionMeta === "function") return rmEdgeDimensionMeta(outline, edgeIndex, distFt);
  return { measured: false, bg: "#263238", prefix: "", border: false, labelFt: distFt, labelIsMeasured: false };
}
/* Archived/superseded measurements (Mark: "provenance the reader never
   sees is not provenance") plus the tech's conflict-resolution decision
   for every entry, active or archived (Mark: "the report should say what
   happened, not just show a number"). rmAllMeasuredEdgeRecords()/
   rmMeasurementDecisionLabel()/rmFormatEdgeFeet() are roofmapper.js's own
   accessors -- same reasoning as rmReportEdgeMeta() above, reused rather
   than reimplemented. */
function rmReportMeasurementRows(outline){
  if (typeof rmAllMeasuredEdgeRecords !== "function") return [];
  return rmAllMeasuredEdgeRecords(outline).slice().sort(function(a, b){
    return (b.measuredAt || 0) - (a.measuredAt || 0);
  }).map(function(m){
    var decisionLabel = typeof rmMeasurementDecisionLabel === "function" ? rmMeasurementDecisionLabel(m) : (m.decision || "recorded");
    var ftLabel = rmReportFeetLabel(m.measuredFt) || "—";
    /* typeof check, not a truthy one -- null + 1 === 1 in JS, which would
       otherwise fabricate "Edge 1" for a record with no known edge index
       (low-reachability today per PR #17 review, since roofmapper.js
       already rejects a null edgeIndex on write, but this and its sibling
       clause three lines apart in this file should never disagree). */
    return {
      edgeLabel: typeof m.edgeIndex === "number" ? ("Edge " + (m.edgeIndex + 1)) : "Edge —",
      measuredFtLabel: ftLabel,
      status: m.invalidatedAt ? "Archived" : "Active",
      reason: m.invalidatedReason ? String(m.invalidatedReason).replace(/_/g, " ") : null,
      decisionLabel: decisionLabel,
      whenLabel: m.measuredAt ? new Date(m.measuredAt).toLocaleDateString() : null,
      rescaleApplied: !!m.rescaleApplied
    };
  });
}
var RM_REPORT_LEGEND_ITEMS = [
  { swatch: "#2E7D32", label: "Field-measured edge (matches drawing)" },
  { swatch: "#F57C00", label: "Field-measured edge (disagrees with drawing scale)" },
  { swatch: "#263238", label: "Derived edge (not independently measured)" }
];

/* Label declutter pass -- ported from an earlier RoofMapper-side export
   prototype (see fix/finish-firebase-split@8e70823 for the original, built
   against the pre-modularization monolith and never merged; this is a
   clean re-implementation against the real js/export.js, not a copy-paste
   of that commit). Each label has a fixed ANCHOR (a roof centroid or an
   asset marker's real point -- never moves) and a natural desired label-box
   position; on collision it walks an expanding ring of candidate offsets
   AROUND THE ANCHOR so leader lines radiate outward cleanly instead of
   compounding drift, falling back to the natural spot as a last resort
   rather than vanishing or drifting off the page. `obstacles` ([{x,y,r}],
   optional) are fixed circular footprints (asset markers) that block
   placement without ever being placed/returned themselves -- without this,
   a label can stop overlapping every other LABEL yet still land on a
   neighboring marker's glyph. */
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

/* Builds the roof-plan SVG for the report: one or more roofs (real
   position/orientation relative to each other via one shared projection
   origin, same technique RoofMapper's own multi-roof export uses),
   provenance-aware edge dimensions (rmReportEdgeMeta), a method line per
   roof, and a legend. Returns null when there's nothing to draw (no
   linked roof outline -- the report renders exactly as it always did). */
/* PDF roof-plan sizing. Height budget in points on a letter page.
   MIN: below this the drawing is too small to read a dimension label on, so
   page-break instead of squeezing into the gap.
   MAX: leaves room for the measurements table that follows the plan. */
var RM_PDF_PLAN_MIN_H = 220;
var RM_PDF_PLAN_MAX_H = 520;

/* The HTML report's copy of the plan, made responsive.
   The SVG is emitted at natural size (hard width/height attributes) because
   rmRasterizeSvgToCanvas() needs those exact pixel dimensions for the PDF. So
   the scaling is added HERE, at the HTML embed, rather than in the builder --
   putting max-width on the shared SVG would risk constraining the offscreen
   raster the PDF path depends on.
   Safe because the builder always emits a viewBox: the drawing scales as a
   unit, so every edge and dimension label shrinks with it and nothing is
   cropped. */
function rmRoofPlanResponsiveSvg(plan){
  var svg = (plan && plan.svg) || "";
  if (svg.indexOf("<svg ") !== 0) return svg; /* unexpected shape: embed as-is */
  return '<svg style="max-width:100%;height:auto;display:inline-block" ' + svg.slice("<svg ".length);
}
function rmBuildReportRoofPlanSvg(roofEntries){
  if (!roofEntries || !roofEntries.length) return null;
  /* Only roofs with a real world-coordinate ring can be projected to scale.
     Image-frame-only roofs (issue #44) carry planUnavailable and are named
     via a notice by the caller, not drawn here. If nothing is drawable there
     is no plan SVG at all -- the caller still renders every roof's notice. */
  roofEntries = roofEntries.filter(function(r){ var d = rmReportOutlineDrawability(r.outline); return d.include && !d.planUnavailable; });
  if (!roofEntries.length) return null;
  var allRingPts = [];
  roofEntries.forEach(function(r){ allRingPts = allRingPts.concat(r.outline.ring); });
  var origin = rmGeomRingCentroid(allRingPts);
  var projected = roofEntries.map(function(r){
    var pts = r.outline.ring.map(function(p){ return rmExportProjectPoint(p, origin); });
    var assetPts = (r.assets || []).map(function(a){ return Object.assign({}, rmExportProjectPoint(a, origin), { type: a.type, label: a.label }); });
    var centroidPt = rmExportProjectPoint(r.outline.center || rmGeomRingCentroid(r.outline.ring), origin);
    return { roofLabel: r.roofLabel, outline: r.outline, pts: pts, assetPts: assetPts, centroidPt: centroidPt, methodInfo: rmReportMethodSentences(r.outline) };
  });
  var allXs = [], allYs = [];
  projected.forEach(function(r){ r.pts.concat(r.assetPts).forEach(function(p){ allXs.push(p.x); allYs.push(p.y); }); });
  var minX = Math.min.apply(null, allXs), maxX = Math.max.apply(null, allXs);
  var minY = Math.min.apply(null, allYs), maxY = Math.max.apply(null, allYs);
  var padFt = Math.max(10, (maxX - minX) * 0.08);
  var w = (maxX - minX) + padFt * 2, h = (maxY - minY) + padFt * 2;
  var scale = Math.min(RM_EXPORT_MAX_SCALE, RM_EXPORT_MAX_CANVAS_DIM / Math.max(w, h));
  var headerH = 40, footerH = 96 + (roofEntries.length > 1 ? 0 : 20);
  var svgW = Math.max(240, w * scale), svgH = Math.max(240, h * scale) + headerH + footerH;
  function toSvg(p){
    return { x: (p.x - minX + padFt) * scale, y: headerH + (h * scale) - ((p.y - minY + padFt) * scale) };
  }
  var shapeSvg = "", roofLabelItems = [];
  projected.forEach(function(r, i){
    var pathPts = r.pts.map(toSvg);
    var pathD = "M " + pathPts.map(function(p){ return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" L ") + " Z" +
      rmOutlineHolesSvgPath(r.outline, origin, toSvg);
    shapeSvg += '<path d="' + pathD + '" fill="rgba(232,96,10,0.12)" fill-rule="evenodd" stroke="#E8600A" stroke-width="2" stroke-linejoin="round"/>';
    for (var e = 0; e < r.outline.ring.length - 1; e++){
      var ea = r.outline.ring[e], eb = r.outline.ring[e + 1];
      var distFt = rmGeomHaversineMeters(ea, eb) * 3.28084;
      if (distFt < 1) continue;
      var midFeet = { x: (rmExportProjectPoint(ea, origin).x + rmExportProjectPoint(eb, origin).x) / 2,
                       y: (rmExportProjectPoint(ea, origin).y + rmExportProjectPoint(eb, origin).y) / 2 };
      var svgMid = toSvg(midFeet);
      var meta = rmReportEdgeMeta(r.outline, e, distFt);
      /* PR #17 review, REQUIRED 2: this used to be Math.round(meta.labelFt)
         unconditionally -- a tech tapes 42' 6" and the customer PDF printed
         "✓ 43 ft", asserting a human measurement while showing a number the
         tape never produced (and disagreeing with the Field Measurements
         table and live map, both of which correctly show 42.5 ft). Fixed
         by calling roofmapper's own rmFormatEdgeFeet(ft, measured) --
         derived edges still round to whole feet, measured edges keep 0.1 ft
         precision unless they're within 0.05ft of a whole number. A
         measured badge (✓/!) and a rounded-away number must never appear
         on the same label.

         REQUIRED 5: that call was unguarded while every other roofmapper
         accessor in this file is -- rmFormatEdgeFeet isn't defined in
         export.js (its only other appearances here are inside comments),
         so a page where roofmapper.js failed to load would throw a
         ReferenceError BEFORE rmReportEdgeMeta()'s own deliberate fallback
         (a few lines up) ever got a chance to matter, killing the whole
         roof plan SVG instead of degrading gracefully. Guarded the same
         way as every other roofmapper call in this file, falling back to
         rmReportFeetLabel() (which already handles measured precision
         correctly) rather than bare Math.round(). Also: a formatted value
         of "" (non-finite labelFt) now suppresses the prefix too -- a
         checkmark with no number behind it is still a fabricated claim. */
      var formattedFt = typeof rmFormatEdgeFeet === "function" ?
        rmFormatEdgeFeet(meta.labelFt, meta.measured) : (rmReportFeetLabel(meta.labelFt) || "").replace(/ ft$/, "");
      var dimLabel = (formattedFt ? meta.prefix : "") + (formattedFt || "?") + " ft";
      var dimW = Math.max(34, dimLabel.length * 7.5 + 10);
      shapeSvg += '<rect x="' + (svgMid.x - dimW / 2).toFixed(1) + '" y="' + (svgMid.y - 10).toFixed(1) + '" width="' +
        dimW.toFixed(1) + '" height="20" rx="4" fill="' + meta.bg + '"' + (meta.border ? ' stroke="#fff" stroke-width="1.5"' : '') + '/>' +
        '<text x="' + svgMid.x.toFixed(1) + '" y="' + (svgMid.y + 4.5).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="11.5" font-weight="700" fill="#fff" text-anchor="middle">' +
        rmEscXml(dimLabel) + '</text>';
    }
    r.assetPts.forEach(function(a){
      var svgP = toSvg(a);
      shapeSvg += '<circle cx="' + svgP.x.toFixed(1) + '" cy="' + svgP.y.toFixed(1) + '" r="6" fill="#455A64" stroke="#fff" stroke-width="1.5"/>';
    });
    if (roofEntries.length > 1){
      var lp = toSvg(r.centroidPt);
      roofLabelItems.push({ id: "roof-" + i, name: r.roofLabel, anchorX: lp.x, anchorY: lp.y, dx: 0, dy: 0, width: r.roofLabel.length * 14 * 0.6 + 6, height: 20 });
    }
  });
  var labelSvg = "";
  if (roofLabelItems.length){
    rmDeconflictLabels(roofLabelItems, svgW, svgH).forEach(function(pl){
      if (pl.moved){
        labelSvg += '<line x1="' + pl.anchorX.toFixed(1) + '" y1="' + pl.anchorY.toFixed(1) + '" x2="' + pl.x.toFixed(1) + '" y2="' + pl.y.toFixed(1) +
          '" stroke="#8a8f93" stroke-width="1" stroke-dasharray="2,2"/><circle cx="' + pl.anchorX.toFixed(1) + '" cy="' + pl.anchorY.toFixed(1) + '" r="3" fill="#263238"/>';
      }
      labelSvg += '<text x="' + pl.x.toFixed(1) + '" y="' + (pl.y + 5).toFixed(1) +
        '" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#263238" text-anchor="middle" ' +
        'stroke="#ffffff" stroke-width="4" paint-order="stroke fill">' + rmEscXml(pl.name) + '</text>';
    });
  }
  var titleSvg = '<text x="14" y="24" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#263238">' +
    rmEscXml(roofEntries.length > 1 ? "Roof Plan — " + roofEntries.length + " Roofs" : "Roof Plan — " + roofEntries[0].roofLabel) + '</text>';
  /* Method line(s), one per DISTINCT method text (a single-roof report --
     the overwhelming common case -- shows exactly one; a multi-roof report
     with roofs captured differently shows one line per distinct method, not
     one per roof, to avoid a wall of repeated identical text). */
  var seenMethods = {}, methodLines = [];
  projected.forEach(function(r){
    var key = r.methodInfo.captureSentence + "|" + r.methodInfo.scaleSentence;
    if (seenMethods[key]) return;
    seenMethods[key] = true;
    methodLines.push((roofEntries.length > 1 ? r.roofLabel + ": " : "") + r.methodInfo.captureSentence + " " + r.methodInfo.scaleSentence);
  });
  var footerY = svgH - footerH + 18;
  var methodSvg = methodLines.map(function(line, i){
    return '<text x="14" y="' + (footerY + i * 15) + '" font-family="Arial, sans-serif" font-size="10.5" fill="#37474F">' + rmEscXml(line) + '</text>';
  }).join("");
  var legendY = footerY + methodLines.length * 15 + 14;
  var legendSvg = '<text x="14" y="' + legendY + '" font-family="Arial, sans-serif" font-size="9.5" font-weight="700" fill="#5B6770">LEGEND</text>';
  RM_REPORT_LEGEND_ITEMS.forEach(function(item, i){
    var ly = legendY + 16 + i * 14;
    legendSvg += '<rect x="14" y="' + (ly - 9) + '" width="14" height="10" rx="2" fill="' + item.swatch + '"/>' +
      '<text x="33" y="' + ly + '" font-family="Arial, sans-serif" font-size="9.5" fill="#37474F">' + rmEscXml(item.label) + '</text>';
  });
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">' +
    '<rect width="100%" height="100%" fill="#ffffff"/>' + titleSvg + shapeSvg + labelSvg + methodSvg + legendSvg + '</svg>';
  return { svg: svg, width: svgW, height: svgH, roofEntries: projected };
}
/* Rasterizes the roof-plan SVG for PDF embedding -- same technique
   RoofMapper's own export path uses (rasterize via an off-screen <img>,
   never a live http-sourced image, so the canvas never taints). */
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
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("Couldn't render the roof plan image")); };
    img.src = url;
  });
}

/* Photo <-> finding cross-reference, computed once up front so both the
   findings table (a "Photos" column) and the photo grid (a "-> Finding N"
   back-reference) can use it. Keys off photo.finding_id, the existing
   real field a photo already carries when captured from a specific
   finding's own camera button (js/photos.js) -- not a new field. */
function rmReportPhotoFindingRefs(o){
  var fp = filledPhotos();
  var ff = filledFindings();
  var findingNoById = {};
  ff.forEach(function(f, i){ findingNoById[f.id] = i + 1; });
  var photoNosByFindingId = {};
  fp.forEach(function(p, i){
    if (!p.finding_id) return;
    (photoNosByFindingId[p.finding_id] = photoNosByFindingId[p.finding_id] || []).push(i + 1);
  });
  return { fp: fp, ff: ff, findingNoById: findingNoById, photoNosByFindingId: photoNosByFindingId };
}
function renderLeakReportDoc(o){
  var isRepair = o.woType === "Repair";
  var isInspection = o.woType === "Inspection";
  var refs = rmReportPhotoFindingRefs(o);
  var h = "";
  h += "<div class='dochead' style='display:flex;align-items:center;gap:16px'>" +
       "<img src='" + LOGO + "' alt='Watkins Roofing' style='height:72px;flex:none'>" +
       "<div><div class='t1 cond' style='color:#B4223F'>" + (isRepair ? "Work Order Report" : (isInspection ? "Roofing Inspection Report" : "Leak Work Order / Repair Documentation")) + "</div>" +
       "<div class='t2'>" + esc(o.jobName) + (o.location ? " — " + esc(o.location) : "") + "</div></div></div>";

  h += "<h3 class='cond'>Job Information</h3>" + kvTable([
    /* Display label, never the raw stored value — see WORK_ORDER_TYPE_LABELS. */
    ["Work Order Type",woTypeLabel(o.woType)],
    ["Job Name",o.jobName],["Location",o.location],["Suite",o.suite],["Date of Service",o.serviceDate],
    ["Job No.",o.jobNo],["Bill To",o.billTo],["Billing Contact",o.billContact],
    ["Contact Phone",o.billPhone],["Site Contact",o.siteContact],["Technician",o.technician]]
    .concat(isInspection ? [] : [["Reported Leak Area",o.reportedArea]])
    /* States plainly which roofs this report actually covers, by label
       (not raw ids), whenever more than one is genuinely in play --
       generalized beyond just a multi-select Inspection (o.roofIds) to
       ANY work order type, since GPS auto-assign (rmMaybeAutoAssignRoofForPin())
       can now give individual findings different roofIds regardless of
       type. Mark: "must clearly STATE which roof(s) were inspected."
       Absent entirely for a single-roof report, same as before. See "GPS
       auto-assign photos to roofs" in DEV_NOTES.md. */
    .concat((function(){
      var ids = reportDistinctRoofIds(o);
      return ids.length > 1 ? [["Roof(s) Covered", ids.map(function(id){ return (o.roofLabels && o.roofLabels[id]) || id; }).join(", ")]] : [];
    })())
    /* Amended-at-a-glance: kvTable() drops empty rows, so this is absent
       entirely on a work order with no return visits. */
    .concat([["Roof System",o.roofSystem],["Return Visits",amendmentSummaryLine(o)]]));

  /* Roof plan + capture/scale provenance -- rmReportRoofPlanEntriesFor()
     is populated by goToPreview() before this ever runs (see its own
     comment) and keyed to currentId, so a stale entry from a different
     work order is silently dropped rather than rendered here. Empty (no
     linked roof, a Change Order which never reaches this function, or a
     stale/mismatched entry) just omits the section entirely, same as the
     report always did before this existed. */
  var roofPlanEntries = rmReportRoofPlanEntriesFor();
  if (roofPlanEntries.length){
    var plan = rmBuildReportRoofPlanSvg(roofPlanEntries);
    var planUnavailableRoofs = roofPlanEntries.filter(function(r){ return r.planUnavailable; });
    if (plan || planUnavailableRoofs.length){
      h += "<h3 class='cond'>Roof Plan</h3>";
      /* SCALE-TO-FIT, not crop. rmBuildReportRoofPlanSvg() emits the SVG at its
         natural size -- for a 52ft roof at the 20px/ft ceiling that is ~1440px
         wide -- and the wrapper used to be overflow:hidden, so on any narrower
         page the right-hand edges and their dimension labels were simply cut
         off. The SVG already carries a viewBox, so it was always scalable;
         nothing was telling it to scale. overflow:auto rather than hidden so
         that if anything ever does exceed the box it scrolls instead of
         silently losing content. */
      if (plan) h += "<div style='border:1px solid #CFD8DC;border-radius:6px;overflow:auto;text-align:center'>" +
        rmRoofPlanResponsiveSvg(plan) + "</div>";
      /* A roof that can't be drawn to scale (traced on a non-georeferenced
         image, issue #44) is NAMED here rather than silently omitted -- the
         report still quotes its measurements below. */
      planUnavailableRoofs.forEach(function(r){
        h += "<p style='margin:8px 0;color:#B45309'>" +
          (roofPlanEntries.length > 1 ? "<b>" + esc(r.roofLabel) + "</b> — " : "") +
          "Roof plan not available: this roof was traced on a non-georeferenced image, so its outline can't be drawn to scale. The measurements below are still valid.</p>";
      });
      /* Field-measurement history -- archived/superseded entries and the
         tech's conflict-resolution decision, not just the active number.
         One list per roof that actually has any measurement history;
         silently omitted for a roof with none (nothing to disclose). */
      var historyBlocks = roofPlanEntries.map(function(r){
        var rows = rmReportMeasurementRows(r.outline);
        if (!rows.length) return "";
        return "<p style='font-weight:700;margin:10px 0 4px'>" + (roofPlanEntries.length > 1 ? esc(r.roofLabel) + " — " : "") + "Field Measurements</p>" +
          "<table><thead><tr><th style='width:70px'>Edge</th><th style='width:70px'>Length</th>" +
          "<th style='width:80px'>Status</th><th>What Happened</th></tr></thead><tbody>" +
          rows.map(function(row){
            var what = row.decisionLabel + (row.whenLabel ? " — " + esc(row.whenLabel) : "") +
              (row.reason ? " (" + esc(row.reason) + ")" : "");
            return "<tr><td>" + esc(row.edgeLabel) + "</td><td>" + esc(row.measuredFtLabel) + "</td><td>" +
              (row.status === "Archived" ? "<span style='color:#B45309'>Archived</span>" : "Active") +
              "</td><td>" + esc(what) + "</td></tr>";
          }).join("") + "</tbody></table>";
      }).filter(Boolean).join("");
      if (historyBlocks) h += historyBlocks;
    }
  }

  if (isRepair){
    if (o.repairDescription || filledRepairItems().length){
      h += "<h3 class='cond'>Repair Scope</h3>";
      if (o.repairDescription) h += "<p style='white-space:pre-wrap'>" + esc(o.repairDescription) + "</p>";
      var fri = filledRepairItems();
      if (fri.length){
        h += "<table><thead><tr><th style='width:36px'>No.</th><th>Type</th>" +
          "<th style='width:70px'>Qty</th><th>Notes / Location</th></tr></thead><tbody>" +
          fri.map(function(it,i){
            return "<tr><td>" + (i+1) + "</td><td>" + esc(it.type) + "</td><td>" +
              esc(it.qty) + "</td><td>" + esc(it.notes) + "</td></tr>";
          }).join("") + "</tbody></table>";
      }
    }
  } else {
    if (isInspection && (o.inspectionChecklist || []).length){
      /* Grouped by roof when the inspection covered more than one. A facility
         with an EPDM roof, a TPO roof and a mod-bit roof used to print one
         undifferentiated 8-row table, so a "Critical" on the drainage row said
         nothing about WHICH roof was ponding. Single-roof reports print exactly
         as before -- one table, no roof heading, no new chrome. */
      var clGroups = inspectionChecklistByRoof(o.inspectionChecklist, o.roofLabels || {});
      h += "<h3 class='cond'>Inspection Checklist</h3>";
      clGroups.forEach(function(g){
        if (clGroups.length > 1){
          var sys = (o.roofSystems || {})[g.roofId];
          h += "<h4 class='cond' style='margin:10px 0 4px'>" + esc(g.label) +
            (sys ? " <span style='font-weight:400'>· " + esc(sys) + "</span>" : "") + "</h4>";
        }
        h += "<table><thead><tr>" +
          "<th>Component</th><th style='width:90px'>Condition</th><th>Notes</th></tr></thead><tbody>" +
          g.items.map(function(item){
            return "<tr><td>" + esc(inspectionComponentLabel(item.key)) + "</td><td>" + esc(item.rating) +
              "</td><td>" + esc(item.notes) + "</td></tr>";
          }).join("") + "</tbody></table>";
      });
    }
    var ff = filledFindings();
    if (ff.length){
      var findingsTitle = isInspection ? "Roofing Inspection Findings" : "Roof Investigation Findings";
      var findingRowsHtml = function(rows){
        return "<table><thead><tr>" +
          "<th style='width:36px'>No.</th><th>Roof Condition Observed</th><th>Location / Detail</th>" +
          "<th style='width:130px'>Warranty Opinion</th><th style='width:70px'>Photos</th></tr></thead><tbody>" +
          rows.map(function(f,i){
            var photoNos = refs.photoNosByFindingId[f.id] || [];
            return "<tr><td>" + (i+1) + "</td><td>" + esc(f.condition) + "</td><td>" +
              esc(f.location) + "</td><td>" + esc(f.warranty) + "</td><td>" +
              (photoNos.length ? photoNos.map(function(n){ return "#" + n; }).join(", ") : "—") + "</td></tr>";
          }).join("") + "</tbody></table>";
      };
      var reportRoofIds = reportDistinctRoofIds(o);
      if (reportRoofIds.length > 1){
        /* "Show findings grouped/attributed by roof when more than one is
           covered" -- generalized beyond just a multi-select Inspection to
           ANY work order type whose findings actually ended up on
           different roofs (GPS auto-assign can do this regardless of
           type -- see reportDistinctRoofIds()). One sub-table per roof, in
           the same order reportDistinctRoofIds() returns them (roofIds
           selection order when set, else first-seen-among-findings order),
           each finding renumbered within its own group (not one continuous
           count across roofs). */
        var byRoof = {};
        ff.forEach(function(f){
          var rid = f.roofId || o.roofId || reportRoofIds[0];
          (byRoof[rid] = byRoof[rid] || []).push(f);
        });
        h += "<h3 class='cond'>" + findingsTitle + "</h3>";
        reportRoofIds.forEach(function(rid){
          var group = byRoof[rid];
          if (!group || !group.length) return;
          h += "<p style='font-weight:700;margin:10px 0 4px'>" + esc((o.roofLabels && o.roofLabels[rid]) || rid) + "</p>" +
            findingRowsHtml(group);
        });
      } else {
        h += "<h3 class='cond'>" + findingsTitle + "</h3>" + findingRowsHtml(ff);
      }
    }
  }

  var fr = filledRepairs();
  if (fr.length){
    h += "<h3 class='cond'>Work Performed</h3><table><thead><tr>" +
      "<th style='width:36px'>No.</th><th>Repair Performed</th><th>Location / Detail</th>" +
      "<th style='width:110px'>Resolves</th></tr></thead><tbody>" +
      fr.map(function(r,i){
        return "<tr><td>" + (i+1) + "</td><td>" + esc(r.repair) + "</td><td>" + esc(r.location) + "</td><td>" +
          (esc(repairResolvesLabel(r.finding_id)) || "—") + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  /* Return visits — printed for every work order that has any, right after
     the original visit's work. */
  h += amendmentReportTableHtml(o);

  /* Print-if-present like Work Performed above (the card is only OFFERED on
     the Repair form — see onWoTypeChange()). "For" ties a row back to the
     Work Performed numbering when the tech linked it to a repair area. */
  var fmat = filledMaterials();
  if (fmat.length){
    h += "<h3 class='cond'>Material List</h3><table><thead><tr>" +
      "<th style='width:36px'>No.</th><th>Material / Description</th><th style='width:60px'>Qty</th>" +
      "<th style='width:80px'>Unit</th><th>Notes</th><th style='width:100px'>For</th></tr></thead><tbody>" +
      fmat.map(function(m,i){
        return "<tr><td>" + (i+1) + "</td><td>" + esc(m.material) + "</td><td>" + esc(m.qty) + "</td><td>" +
          esc(m.unit) + "</td><td>" + esc(m.notes) + "</td><td>" + (esc(materialRepairRefLabel(m.repair_id)) || "—") + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  if (!isInspection){
    var wd = kvTable([["Warrantable Repairs",o.warrantable],["Non-Warrantable Repairs",o.nonWarrantable],["Manufacturer Service #",o.mfgServiceNo]]);
    if (wd) h += "<h3 class='cond'>Warranty Determination</h3>" + wd;
  }

  if (o.summary) h += "<h3 class='cond'>Summary</h3><p style='white-space:pre-wrap'>" + esc(o.summary) + "</p>";

  var fp = refs.fp;
  if (fp.length){
    h += "<h3 class='cond'>Photo Documentation</h3>" +
      "<p style='font-size:13px'>The following photographs document the reported leak investigation, observed roof conditions, and completed repairs.</p>" +
      "<div class='photogrid'>" +
      /* On-screen Preview embeds the small p.thumb (not full-res p.img): a
         photo-heavy report otherwise decoded dozens of multi-MB base64 images
         into the DOM at once, pinning the main thread so the tab couldn't even
         scroll or reload (Mark, 2026-07). lazy/async decode covers the img
         fallback for older photos with no thumb. The emailed body + attached
         PDF are unaffected -- email inlines no images (see emailDoc()), and the
         PDF path has its own downscaler (buildPdfPhotoMap). */
      fp.map(function(p,i){
        var findingNo = p.finding_id ? refs.findingNoById[p.finding_id] : null;
        /* A photo taken on a return visit says so, so a reader can tell
           first-visit documentation from what was shot weeks later. */
        var visit = amendmentVisitLabelForPhoto(o, p);
        return "<div class='photocell'>" +
          (p.img ? "<img loading='lazy' decoding='async' src='" + (p.thumb || p.img) + "'>" : "") +
          "<div class='cap'><b>Photo " + (i+1) + ":</b> " + esc(p.caption || "") +
          (findingNo ? " <span style='color:#5B6770'>(Finding #" + findingNo + ")</span>" : "") +
          (visit ? " <span style='color:#B45309'>(" + esc(visit) + ")</span>" : "") + "</div></div>";
      }).join("") + "</div>";
  }

  h += "<div class='docfoot'>" + esc(o.jobName) + " — " + esc(o.location) +
       " | Job No. " + esc(o.jobNo) + " | Date of Service: " + esc(o.serviceDate) + "</div>";
  return h;
}
/* A change order is a work-authorization document, not a leak
   inspection report — deliberately no findings table, no warranty
   framing, no per-finding photo linkage. Materials render as an
   itemized list (one <li> per non-blank line of the textarea);
   photos, if any, are secondary — a plain grid at the bottom, not
   framed as "documentation of the leak investigation." */
function renderChangeOrderDoc(o){
  var h = "";
  h += "<div class='dochead' style='display:flex;align-items:center;gap:16px'>" +
       "<img src='" + LOGO + "' alt='Watkins Roofing' style='height:72px;flex:none'>" +
       "<div><div class='t1 cond'>Change Order</div>" +
       "<div class='t2'>" + esc(o.jobName) + (o.location ? " — " + esc(o.location) : "") + "</div></div></div>";

  h += "<h3 class='cond'>Job Information</h3>" + kvTable([
    ["Job Name",o.jobName],["Location",o.location],["Suite",o.suite],["Date",o.serviceDate],
    ["Job No.",o.jobNo],["Bill To",o.billTo],["Billing Contact",o.billContact],
    ["Contact Phone",o.billPhone],["Site Contact",o.siteContact],["Technician",o.technician],
    ["PO Number",o.woPONumber],["Date Completed",o.woDateCompleted]]);

  h += "<h3 class='cond'>Description of Work Performed</h3>" +
    "<p style='white-space:pre-wrap'>" + (o.woDescription ? esc(o.woDescription) : "<span class='co-empty'>(none entered)</span>") + "</p>";

  h += "<h3 class='cond'>Materials</h3>";
  /* Itemized Material List (materials[]) is primary; legacy free-text
     #woMaterials, if present, prints beneath it as "Additional Material
     Notes" so no historical Change Order loses its data. */
  var coMat = filledMaterials();
  if (coMat.length){
    h += "<ul class='co-materials'>" +
      coMat.map(function(m){ return "<li>" + esc(materialLineLabel(m)) + "</li>"; }).join("") + "</ul>";
  }
  var matLines = (o.woMaterials || "").split("\n").map(function(s){ return s.trim(); }).filter(Boolean);
  if (matLines.length){
    h += "<h4 class='cond' style='margin:8px 0 4px'>Additional Material Notes</h4>" +
      "<ul class='co-materials'>" + matLines.map(function(m){ return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>";
  }
  if (!coMat.length && !matLines.length) h += "<p class='co-empty'>(none entered)</p>";

  /* Return visits — same shared section the leak/work-order document prints
     (amendmentReportTableHtml()), for the same print-if-present reason
     Materials has: a change order returned to on a later day must not lose
     those records just because this is a different template. */
  h += amendmentReportTableHtml(o);

  h += "<h3 class='cond'>Cost Summary</h3>" +
    "<table class='co-cost'><tbody>" +
    "<tr><td class='k'>Man-Hours</td><td>" + esc(o.woManHours || "") + "</td></tr>" +
    "<tr><td class='k'>Cost</td><td>" + (o.woCost ? "$" + esc(o.woCost) : "") + "</td></tr>" +
    "<tr class='co-total'><td class='k'>Total</td><td>" + (o.woCost ? "$" + esc(o.woCost) : "") + "</td></tr>" +
    "</tbody></table>";

  var fp = filledPhotos();
  if (fp.length){
    h += "<h3 class='cond'>Photos</h3><div class='photogrid'>" +
      fp.map(function(p,i){
        var coVisit = amendmentVisitLabelForPhoto(o, p); /* "" unless shot on a return visit */
        return "<div class='photocell'>" +
          (p.img ? "<img loading='lazy' decoding='async' src='" + (p.thumb || p.img) + "'>" : "") +
          "<div class='cap'><b>Photo " + (i+1) + ":</b> " + esc(p.caption || "") +
          (coVisit ? " <span style='color:#B45309'>(" + esc(coVisit) + ")</span>" : "") + "</div></div>";
      }).join("") + "</div>";
  }

  h += (o.changeOrderSignature && o.changeOrderSignature.img) ?
    "<div class='co-sig'>" +
      "<div class='co-sig-line' style='flex-basis:100%'>Signature<br>" +
      "<img src='" + o.changeOrderSignature.img + "' style='max-width:220px;max-height:70px;display:block;border-bottom:1px solid #37474F;margin-top:4px'></div>" +
      "<div class='co-sig-line'>Print Name: " + esc(o.changeOrderSignature.printName) + "</div>" +
      "<div class='co-sig-line'>Date: " + esc(o.changeOrderSignature.date) + "</div></div>" :
    "<div class='co-sig'>" +
      "<div class='co-sig-line'>Approved By: <span></span></div>" +
      "<div class='co-sig-line'>Date: <span></span></div></div>";

  h += "<div class='docfoot'>" + esc(o.jobName) + " — " + esc(o.location) +
       " | Job No. " + esc(o.jobNo) + " | Date: " + esc(o.serviceDate) + "</div>";
  return h;
}

/* ================= email / copy ================= */
function pickRecipient(){
  var sel = document.getElementById("emailPick");
  var addr = sel.value;
  if (!addr) return;
  var box = document.getElementById("emailTo");
  var list = box.value.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
  var already = list.some(function(a){ return a.toLowerCase() === addr.toLowerCase(); });
  if (!already) list.push(addr);
  box.value = list.join(", ");
  sel.value = "";
}
async function emailDoc(){
  toast("Saving work order\u2026");
  if (!(await autoSaveBeforeReport("opening email"))) return;
  var o = collect();
  var subject = emailTypeSubject(o.woType) + " — " + (o.jobName || "Job") +
    (o.jobNo ? " #" + o.jobNo : "") + (o.location ? " (" + o.location + ")" : "");
  var addrList = parseEmailRecipients(val("emailTo"));
  var alreadyHasBcc = addrList.some(function(a){ return a.toLowerCase() === EMAIL_ALWAYS_BCC.toLowerCase(); });
  var addrs = addrList.map(encodeURIComponent).join(",");
  /* Leak/no-job note rides at the top of the email body (auto-inserted,
     not a separate email — see leakNoJobEmailNote() in js/workorders.js). */
  var njNote = (typeof leakNoJobEmailNote === "function") ? leakNoJobEmailNote(o) : "";
  var href = "mailto:" + addrs +
    "?subject=" + encodeURIComponent(subject) +
    "&body=" + encodeURIComponent((njNote ? njNote + "\n\n" : "") + buildText()) +
    (alreadyHasBcc ? "" : "&bcc=" + encodeURIComponent(EMAIL_ALWAYS_BCC));
  window.location.href = href;
  toast("Opening your email app… If nothing opens or it's cut off, use Copy Document Text.");
}
function copyDoc(){
  var text = buildText();
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); toast("Full document copied — paste into an email"); }
    catch(e){ toast("Copy failed — select the preview text manually"); }
    document.body.removeChild(ta);
  }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){
      toast("Full document copied — paste into an email");
    }, fallback);
  } else fallback();
}


/* ================= PDF generation ================= */
function ensureDims(p){
  return new Promise(function(res){
    if (p.w && p.h) return res(p);
    var im = new Image();
    im.onload = function(){ p.w = im.naturalWidth; p.h = im.naturalHeight; res(p); };
    im.onerror = function(){ res(p); };
    im.src = p.img;
  });
}
/* ---- PDF photo downscale: decouples EMAIL size from CAPTURE fidelity ----
   Photos are stored at whatever the global capture preset produces
   (SIZE_PRESETS in js/photos.js). That preset became a training-data
   decision on 2026-07-18 -- `large` (1600px/q0.80) is what a vision model
   wants -- but it is the WRONG size to email, and until now the two were
   the same bytes: the loops below embedded p.img directly.

   Why that breaks: netlify/functions/send-workorder.js:35 hard-rejects a
   PDF over ~6MB, and at `large` each photo lands ~700KB-1.1MB, capping a
   sendable report at ~5-7 photos. A 12-photo leak report could not be sent.

   Why 900px, not smaller: the grid below renders every photo into a box of
   cw (~258pt) x 300pt max. At 200 DPI that box can only show ~717x833px, so
   900px still over-serves the layout. It is set to EXACTLY the `small`
   capture preset's max dimension on purpose -- a photo captured at `small`
   (900px) is then <= this cap and passes through UNTOUCHED, so the common
   prod case pays no re-encode cost and no double-compression quality loss.
   Only `medium` (1200px) and `large` (1600px) get downscaled. Verified with
   real JPEG encoding (jimp) on a 1600x1200 photo-like image: `large` goes
   1551KB -> 198KB (a 3-photo report budget becomes 30), `medium` 428KB ->
   198KB, `small` stays 146KB (passthrough). All three clear the ~6MB wall
   with room for 30+ photos.

   Do NOT try to solve this with jsPDF's compress:true instead (see the
   comment at its construction): that flag is for the roof plan's mostly-
   white PNG. Deflate gains ~0-2% on already-entropy-coded JPEG data.

   Fail-safe: every failure path resolves to the ORIGINAL dataUrl, so a
   broken downscale can never cost a photo its place in a report. */
var PDF_PHOTO_MAX_DIM = 900;
var PDF_PHOTO_QUALITY = 0.72;
function pdfPhotoDataUrl(dataUrl){
  return new Promise(function(res){
    if (!dataUrl) return res(dataUrl);
    var im = new Image();
    im.onload = function(){
      try{
        var w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) return res(dataUrl);
        /* Already small enough -- re-encoding would only lose quality. */
        if (w <= PDF_PHOTO_MAX_DIM && h <= PDF_PHOTO_MAX_DIM) return res(dataUrl);
        if (w >= h){ h = Math.round(h * PDF_PHOTO_MAX_DIM / w); w = PDF_PHOTO_MAX_DIM; }
        else { w = Math.round(w * PDF_PHOTO_MAX_DIM / h); h = PDF_PHOTO_MAX_DIM; }
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(im, 0, 0, w, h);
        res(c.toDataURL("image/jpeg", PDF_PHOTO_QUALITY));
      }catch(e){ res(dataUrl); }
    };
    im.onerror = function(){ res(dataUrl); };
    im.src = dataUrl;
  });
}
/* Returns a Map of photo object -> PDF-sized dataUrl for ONE export.
   Deliberately a side Map rather than a field on the photo (e.g. p._pdfImg):
   a downscaled copy must never reach saveDb()/cloudSaveOrder(), which would
   push a SECOND set of base64 bytes into localStorage (5-10MB quota) and
   Firestore. Aspect ratio is preserved, so p.w/p.h from ensureDims() stay
   correct and the grid layout below is unchanged. */
function buildPdfPhotoMap(photos){
  var map = new Map();
  return Promise.all(photos.map(function(p){
    return pdfPhotoDataUrl(p.img).then(function(u){ map.set(p, u); });
  })).then(function(){ return map; });
}
/* ---- SHARED ~900px downscaler for the AI vision features ----
   The AI summary and the per-photo issue-ID chip both send photos to a vision
   model, and both want the SAME small image the PDF path already produces:
   900px/q0.72 (PDF_PHOTO_MAX_DIM above). Deliberately reuses pdfPhotoDataUrl()
   rather than adding a second downscaler -- two independent resize paths would
   drift, and this one is already proven on production.

   Why it matters beyond payload size: Anthropic re-scales anything over
   ~1568px on the long edge and bills the resized token count anyway, so
   sending a 1600px capture costs roughly 3x a 900px one (~2,300 vs ~810
   tokens per image) for no extra detail the model can use. At the global
   `large` capture preset every photo is 1600px, so this is a real per-draft
   saving, not a micro-optimisation.

   Returns { mediaType, data } -- base64 WITHOUT the data: prefix, which is
   exactly the shape lib/aiProvider.js's cleanInlineImage() validates -- or
   null when the photo can't be read. Never throws: a photo that won't
   downscale is simply one the model doesn't see, never a failed draft. */
function aiVisionImagePart(dataUrl){
  return pdfPhotoDataUrl(dataUrl).then(function(u){
    var m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/.exec(typeof u === "string" ? u : "");
    return m ? { mediaType: m[1], data: m[2] } : null;
  }).catch(function(){ return null; });
}
/* Downscaled vision parts for up to `max` photos that actually carry bytes,
   in report order. Shared by draftReportSummary() (whole report) and the
   per-photo issue-ID chip (one photo). */
function aiVisionImageParts(photoList, max){
  var withBytes = (photoList || []).filter(function(p){ return p && p.img; }).slice(0, max || 8);
  return Promise.all(withBytes.map(function(p){ return aiVisionImagePart(p.img); }))
    .then(function(parts){ return parts.filter(Boolean); });
}
function pdfFileName(){
  var o = collect();
  /* Stored "Repair" now DISPLAYS as "Work Order" everywhere, so its PDF
     filename follows the label too — the same prefix every other
     leak-report-template type already used. */
  var prefix = o.woType === "Change Order" ? "ChangeOrder" : "WorkOrder";
  var base = (prefix + "_" + (o.jobName || "") + "_" + (o.jobNo || ""))
    .replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return (base || prefix) + ".pdf";
}
/* Name used for the PDF saved into the linked CompanyCam project (Mark,
   2026-07-15: "leak_<JobNumber> or workorder_<jobnumber> etc"). Deterministic
   {type}_{jobNo} -- both a readable label in the project's Documents AND the
   stable key that lets the re-send REPLACE the prior version instead of piling
   up duplicates (issue #54). Falls back to the job name when there's no job
   number. The slug follows the DISPLAY type, so "Repair" (which renders as
   "Work Order" everywhere since #46) is "workorder", not "repair". */
function ccDocumentTypeSlug(woType){
  return ({ "Leak / Service": "leak", "Repair": "workorder", "Inspection": "inspection",
    "Warranty": "warranty", "Change Order": "changeorder" })[woType] || "workorder";
}
function ccDocumentName(o){
  o = o || collect();
  var slug = ccDocumentTypeSlug(o.woType);
  var jobNo = String(o.jobNo || "").replace(/[^A-Za-z0-9-]+/g, "");
  var tail = jobNo || String(o.jobName || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  var base = (slug + (tail ? "_" + tail : "")).replace(/_+/g, "_").replace(/^_|_$/g, "");
  return (base || slug) + ".pdf";
}
/* Routes to a fully separate PDF builder per work order type — a Change
   Order is a work-authorization document, not a leak inspection report,
   so it gets its own generateChangeOrderPdf() rather than a bolted-on
   section here. Repair reuses generateLeakReportPdf() below (branches
   internally on o.woType === "Repair" for the title + findings-vs-scope
   section) since it's "most of the same info," not a separate template.
   Every other type still uses this original leak-report builder,
   byte-for-byte unchanged in its own logic. See "Change Order gets its
   own PDF template" and "Repair work order type" in DEV_NOTES.md. */
/* Defense in depth against Mark's real "captions present, photos gone"
   bug: loadOrder() now refuses to trust a photo-stripped local cache over
   a cloud refetch (see stripPhotoBytes()/orderPhotosAreStrippedLocally()
   in core.js), which is the actual root fix -- but Preview and every
   export path (PDF download/email/share) all render straight from
   whatever's currently in the live photos[] array, by design
   (renderLeakReportDoc() is deliberately synchronous, no Firestore
   access). This is the last line of defense for any OTHER way that array
   could end up missing bytes (offline reopen, a future bug, etc.). Never
   silently proceeds with missing images -- every caller below blocks and
   shows a loud, impossible-to-miss warning instead of producing an
   incomplete customer-facing document. See "PDF/preview missing photos"
   in DEV_NOTES.md.

   Two-layer recovery, since photos can now be in either shape (see "Photo
   storage migration" in DEV_NOTES.md): layer 1 tries Storage directly via
   resolvePhotoImg() for anything with a storageRef -- precise, per-photo,
   no guessing needed since the reference identifies exactly which photo
   it is. Layer 2 is the ORIGINAL fallback for anything Storage couldn't
   resolve (a not-yet-migrated record with neither img nor storageRef
   locally, but the cloud Firestore doc might still hold img directly):
   one cloud refetch, restoring bytes by array position, ONLY when the
   photo count still matches (a mismatch means photos were added/removed
   since whatever got cached, so position no longer reliably corresponds
   to the same photo -- safer to report it unresolved than guess wrong). */
/* Makes sure every photo has real bytes before a report is built, and --
   crucially -- distinguishes WHY a photo has none, because the three cases
   need opposite handling:

     1. RESOLVABLE  -- bytes live in Storage (storageRef) or on-device
        (IndexedDB backup, i.e. added-but-not-yet-uploaded). Pulled in
        silently; the report proceeds. A local-backup recovery is the
        "still uploading" case: we don't block on the upload finishing,
        we just use the copy already on the device.
     2. LOAD FAILURE -- a real pointer exists (a storageRef, or the cloud
        copy has bytes) but it wouldn't load right now (offline, fetch
        error). Transient: hard-stop and tell the tech to retry, because
        the photo is NOT gone.
     3. DEAD -- confirmed no bytes anywhere (no storageRef, no local
        backup, and the cloud has none either). The image is genuinely
        lost; offer one-tap removal so the blank slot stops blocking the
        report forever (the storage-quota eviction saga). We only ever
        declare this while ONLINE and able to confirm against the cloud --
        offline, an unconfirmable slot is treated as case 2, never removed.

   Returns { ok:true } or { ok:false, reason:"load"|"dead", ... }. */
async function ensurePhotosLoadedForExport(){
  var missing = (photos || []).filter(function(p){ return !p.img; });
  if (!missing.length) return { ok: true };

  var loadFailed = [];      // case 2: has a pointer but won't load now
  var deadCandidates = [];  // case 3 candidates: no local pointer at all
  var recovered = 0, pending = 0;

  for (var mi = 0; mi < missing.length; mi++){
    var p = missing[mi];
    if (p.storageRef){
      if (await resolvePhotoImg(p)) recovered++; else loadFailed.push(p);
    } else if (p.localId){
      var localBytes = await idbGetPhoto(p.localId);
      if (localBytes){ p.img = localBytes; pending++; }
      else deadCandidates.push(p);
    } else {
      deadCandidates.push(p);
    }
  }

  /* A candidate with no local pointer might still have bytes in the cloud
     we simply never hydrated (a stripped local cache). Confirm against the
     cloud before ever calling one dead. If the cloud can't be reached,
     stay cautious: treat as a transient load failure, never as dead. */
  if (deadCandidates.length){
    if (currentId && fdb){
      try{
        var cloudCopy = await cloudFetchOrder(currentId);
        if (cloudCopy && cloudCopy.photos){
          var stillDead = [];
          for (var di = 0; di < deadCandidates.length; di++){
            var dp = deadCandidates[di];
            var idx = photos.indexOf(dp);
            var match = idx >= 0 ? cloudCopy.photos[idx] : null;
            if (match && match.img){ dp.img = match.img; recovered++; }
            else if (match && match.storageRef){
              dp.storageRef = match.storageRef;
              if (await resolvePhotoImg(dp)) recovered++; else loadFailed.push(dp);
            } else stillDead.push(dp);
          }
          deadCandidates = stillDead;
        } else {
          loadFailed = loadFailed.concat(deadCandidates); deadCandidates = [];
        }
      }catch(e){
        loadFailed = loadFailed.concat(deadCandidates); deadCandidates = [];
      }
    } else {
      loadFailed = loadFailed.concat(deadCandidates); deadCandidates = [];
    }
  }

  if (recovered || pending) renderPhotos();
  if (pending){
    toast("Using the on-device copy of " + pending + " photo" + (pending === 1 ? "" : "s") +
      " still finishing upload…");
    if (typeof tryFlushSyncQueue === "function") tryFlushSyncQueue(); // fire-and-forget: finish the upload in the background
  }

  if (loadFailed.length) return { ok: false, reason: "load", missingCount: loadFailed.length };
  if (deadCandidates.length){
    var deadNums = deadCandidates.map(function(p){ return photos.indexOf(p) + 1; })
      .filter(function(n){ return n > 0; });
    return { ok: false, reason: "dead", deadPhotos: deadCandidates, deadNums: deadNums };
  }
  return { ok: true, recovered: recovered, pending: pending };
}
function photosMissingWarning(missingCount){
  return "⚠️ " + missingCount + " photo" + (missingCount === 1 ? "" : "s") + " couldn't be loaded" +
    (fdb ? " from the cloud" : " — no internet connection") + ". Stopped rather than produce a report " +
    "with missing images. Check your connection and reopen this work order, or re-add the missing photo(s), then try again.";
}
function deadPhotosWarning(nums){
  var many = nums.length !== 1;
  return "⚠️ Photo" + (many ? "s " + nums.join(", ") + " are" : " " + nums[0] + " is") +
    " empty — the image data was lost and can't be recovered. Remove " +
    (many ? "them" : "it") + " (or re-add) before creating the report.";
}
/* Confirms and removes the genuinely-dead slots ensurePhotosLoadedForExport
   found, so they stop blocking the report. Removal is in-memory (the next
   save drops the empty docs cloud-side too — see cloudSaveOrder). Highest
   index first so earlier indices stay valid as the array shrinks. Returns
   true if the slots were removed, false if the tech declined. */
function offerRemoveDeadPhotos(photoCheck){
  var nums = photoCheck.deadNums || [];
  var many = nums.length !== 1;
  var msg = "Photo" + (many ? "s " + nums.join(", ") + " are" : " " + nums[0] + " is") +
    " empty — the image was lost and can't be recovered.\n\nRemove " +
    (many ? "them" : "it") + " and continue?";
  if (!confirm(msg)) return false;
  var idxs = (photoCheck.deadPhotos || []).map(function(p){ return photos.indexOf(p); })
    .filter(function(n){ return n >= 0; }).sort(function(a, b){ return b - a; });
  idxs.forEach(function(i){ removePhoto(i); });
  toast(idxs.length + " empty photo" + (idxs.length === 1 ? "" : "s") + " removed");
  return true;
}
async function generatePdf(){
  if (!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable)){
    toast("PDF tools couldn't load — check your internet connection, or use Print instead.");
    return null;
  }
  var photoCheck = await ensurePhotosLoadedForExport();
  if (!photoCheck.ok){
    /* A genuinely dead slot can be cleared and the report still produced;
       a transient load failure keeps the original hard stop (the photo
       isn't gone -- refusing to ship a report with a hole in it). */
    if (photoCheck.reason === "dead"){
      if (!offerRemoveDeadPhotos(photoCheck)){
        alert(deadPhotosWarning(photoCheck.deadNums));
        return null;
      }
    } else {
      alert(photosMissingWarning(photoCheck.missingCount));
      return null;
    }
  }
  /* Last chance to inherit the building's CompanyCam link before collect()
     snapshots it. generatePdf() is the single chokepoint every PDF-producing
     action funnels through (downloadPdf / sendEmailNow / sharePdf), and each
     of them calls collect() AFTER this returns -- so resolving here is what
     guarantees o.companyCamProjectId is set, and therefore that
     uploadLinkedPdfToCompanyCam() actually pushes the signed Change Order PDF
     instead of returning { skipped:true }. Now inherits for EVERY work-order
     type on a linked building (audit FIX 3 — was Change Order only); still a
     no-op when the building has no CompanyCam project (it never creates
     one) -- see resolveBuildingCompanyCamLink() in js/companycam.js. */
  if (typeof resolveBuildingCompanyCamLink === "function") await resolveBuildingCompanyCamLink();
  var o = collect();
  if (o.woType === "Change Order") return generateChangeOrderPdf(o);
  /* PDF generation doesn't necessarily pass through Preview first (a
     direct "Download PDF" tap), so this fetches fresh rather than relying
     on goToPreview()'s cached rmReportRoofPlanData -- same fetch, just not
     assuming an ordering between the two entry points. */
  var roofPlanResult = await rmFetchReportRoofOutlines(o);
  if (roofPlanResult.error) toast("Roof plan couldn't be loaded: " + roofPlanResult.error);
  return generateLeakReportPdf(o, roofPlanResult.roofEntries);
}
async function generateLeakReportPdf(o, roofPlanData){
  var isRepair = o.woType === "Repair";
  var isInspection = o.woType === "Inspection";
  var refs = rmReportPhotoFindingRefs(o);
  var jsPDF = window.jspdf.jsPDF;
  /* compress:true is essential now that the roof plan's rasterized PNG is
     embedded -- jsPDF stores image XObject streams RAW (no deflate)
     unless this is set, which turned a mostly-white ~2200px PNG into a
     multi-megabyte PDF in testing (14.3MB for a 2-page report with one
     placeholder photo). With it, the same report comes out a fraction of
     that size. Same fix already applied once before in the RoofMapper
     export path -- see "RoofMapper export: single shared render path" in
     DEV_NOTES.md for the original occurrence of this exact bug. */
  var doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  var W = doc.internal.pageSize.getWidth();
  var H = doc.internal.pageSize.getHeight();
  var M = 40;
  var y = M;

  /* header with logo -- brand red (#B4223F / rgb(180,34,63), from the
     actual Watkins logo, see css/app.css's own banner comment), matching
     generateChangeOrderPdf()'s already-correct treatment below rather than
     the plain dark gray this title used before. */
  try { doc.addImage(LOGO, "PNG", M, y, 96, 52); } catch(e){}
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(180, 34, 63);
  doc.text(isRepair ? "WORK ORDER REPORT" : (isInspection ? "ROOFING INSPECTION REPORT" : "LEAK WORK ORDER / REPAIR DOCUMENTATION"), M + 112, y + 20, { maxWidth: W - M * 2 - 112 });
  doc.setFontSize(11);
  doc.setTextColor(30, 39, 46);
  doc.text(String((o.jobName || "") + (o.location ? " \u2014 " + o.location : "")), M + 112, y + 42, { maxWidth: W - M * 2 - 112 });
  y += 66;
  doc.setDrawColor(180, 34, 63);
  doc.setLineWidth(2);
  doc.line(M, y, W - M, y);
  y += 18;

  function heading(t){
    if (y > H - M - 60){ doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(38, 50, 56);
    doc.text(t.toUpperCase(), M, y);
    y += 8;
  }
  function kvTablePdf(rows){
    rows = rows.filter(function(r){ return r[1]; });
    if (!rows.length){ y += 8; return; }
    doc.autoTable({
      startY: y, body: rows, theme: "grid",
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 150 } },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  function wrappedTextPdf(text){
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 39, 46);
    var lines = doc.splitTextToSize(text, W - M * 2);
    lines.forEach(function(ln){
      if (y > H - M - 14){ doc.addPage(); y = M; }
      doc.text(ln, M, y);
      y += 13;
    });
    y += 12;
  }

  heading("Job Information");
  kvTablePdf([
    /* Display label, never the raw stored value — see WORK_ORDER_TYPE_LABELS. */
    ["Work Order Type", woTypeLabel(o.woType)],
    ["Job Name", o.jobName], ["Location", o.location], ["Suite", o.suite], ["Date of Service", o.serviceDate],
    ["Job No.", o.jobNo], ["Bill To", o.billTo], ["Billing Contact", o.billContact],
    ["Contact Phone", o.billPhone], ["Site Contact", o.siteContact], ["Technician", o.technician]
  ].concat(isInspection ? [] : [["Reported Leak Area", o.reportedArea]])
   /* kvTablePdf() drops empty rows, so this is absent on a work order with no
      return visits — same as the HTML builder's row. */
   .concat([["Roof System", o.roofSystem], ["Return Visits", amendmentSummaryLine(o)]]));

  /* Roof plan + capture/scale provenance -- see the "roof plan + capture/
     scale provenance" section above reportDistinctRoofIds() for the full
     design rationale. Rasterizes the SAME rmBuildReportRoofPlanSvg() SVG
     the HTML report embeds directly, so the PDF and the Preview/email HTML
     are guaranteed to show the identical roof plan, not two independent
     drawings that could drift apart. */
  if (roofPlanData && roofPlanData.length){
    var plan = rmBuildReportRoofPlanSvg(roofPlanData);
    var planUnavailableRoofs = roofPlanData.filter(function(r){ return r.planUnavailable; });
    if (plan || planUnavailableRoofs.length){
      heading("Roof Plan");
      if (plan){
        try{
          var planCanvas = await rmRasterizeSvgToCanvas(plan.svg, plan.width, plan.height);
          var planDataUrl = planCanvas.toDataURL("image/png");
          /* Fit the plan to BOTH axes of the content box, then centre it.
             The old math fitted width first and clamped height to a flat 380pt,
             which never overflowed but wasted the page: a tall narrow roof
             (40 x 200ft) came out 97pt wide -- 18% of the column -- and every
             plan was pinned to the left margin because x was hardcoded to M.
             One ratio applied to both dimensions preserves aspect and cannot
             exceed either bound. */
          var availW = W - M * 2;
          /* Height budget is what is actually left on this page. If that is too
             cramped to be legible, start a fresh page and use the full column
             rather than shrinking the drawing to fit a gap. */
          var budgetH = (H - M) - y;
          if (budgetH < RM_PDF_PLAN_MIN_H){ doc.addPage(); y = M; budgetH = (H - M) - y; }
          /* Cap so the plan never swallows a whole page on its own -- the
             measurements table that follows should still get room. */
          var maxPlanH = Math.min(budgetH, RM_PDF_PLAN_MAX_H);
          var fit = Math.min(availW / plan.width, maxPlanH / plan.height);
          var planW = plan.width * fit, planH = plan.height * fit;
          var planX = M + (availW - planW) / 2;
          doc.addImage(planDataUrl, "PNG", planX, y, planW, planH);
          y += planH + 18;
        }catch(e){ console.warn("Couldn't rasterize roof plan for PDF:", e); }
      }
      /* Name any roof we can't draw to scale (issue #44) -- measurements
         still print below; the plan just can't be rendered for it. */
      planUnavailableRoofs.forEach(function(r){
        wrappedTextPdf((roofPlanData.length > 1 ? r.roofLabel + " — " : "") +
          "Roof plan not available: this roof was traced on a non-georeferenced image, so its outline can't be drawn to scale. The measurements below are still valid.");
      });

      var historyRows = [];
      roofPlanData.forEach(function(r){
        rmReportMeasurementRows(r.outline).forEach(function(row){
          historyRows.push([
            roofPlanData.length > 1 ? r.roofLabel : "",
            row.edgeLabel, row.measuredFtLabel, row.status,
            row.decisionLabel + (row.whenLabel ? " — " + row.whenLabel : "") + (row.reason ? " (" + row.reason + ")" : "")
          ]);
        });
      });
      if (historyRows.length){
        heading("Field Measurements");
        doc.autoTable({
          startY: y,
          head: [roofPlanData.length > 1 ? ["Roof", "Edge", "Length", "Status", "What Happened"] : ["Edge", "Length", "Status", "What Happened"]],
          body: roofPlanData.length > 1 ? historyRows : historyRows.map(function(r){ return r.slice(1); }),
          theme: "grid",
          headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
          styles: { fontSize: 8.5, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
          margin: { left: M, right: M }
        });
        y = doc.lastAutoTable.finalY + 18;
      }
    }
  }

  if (isRepair){
    if (o.repairDescription){
      heading("Repair Scope");
      wrappedTextPdf(o.repairDescription);
    }
    var fri = filledRepairItems();
    if (fri.length){
      heading("Repair Items");
      doc.autoTable({
        startY: y,
        head: [["No.", "Type", "Qty", "Notes / Location"]],
        body: fri.map(function(it, i){ return [i + 1, it.type, it.qty, it.notes]; }),
        theme: "grid",
        headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
        styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
        columnStyles: { 0: { cellWidth: 28 }, 2: { cellWidth: 50 } },
        margin: { left: M, right: M }
      });
      y = doc.lastAutoTable.finalY + 18;
    }
  } else {
    if (isInspection && (o.inspectionChecklist || []).length){
      heading("Inspection Checklist");
      /* Same roof grouping as the HTML report above, via the same shared
         helper so the PDF and the on-screen report can never disagree about
         which rating belongs to which roof. */
      var pdfClGroups = inspectionChecklistByRoof(o.inspectionChecklist, o.roofLabels || {});
      pdfClGroups.forEach(function(g){
        if (pdfClGroups.length > 1){
          var sys = (o.roofSystems || {})[g.roofId];
          if (y > H - M - 60){ doc.addPage(); y = M; }
          doc.setFont("helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(38, 50, 56);
          doc.text(g.label + (sys ? " — " + sys : ""), M, y);
          y += 12;
        }
        doc.autoTable({
          startY: y,
          head: [["Component", "Condition", "Notes"]],
          body: g.items.map(function(item){ return [inspectionComponentLabel(item.key), item.rating, item.notes]; }),
          theme: "grid",
          headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
          styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
          columnStyles: { 1: { cellWidth: 70 } },
          margin: { left: M, right: M }
        });
        y = doc.lastAutoTable.finalY + 10;
      });
      y += 8;
    }
    var ff = filledFindings();
    if (ff.length){
      heading(isInspection ? "Roofing Inspection Findings" : "Roof Investigation Findings");
      doc.autoTable({
        startY: y,
        head: [["No.", "Roof Condition Observed", "Location / Detail", "Warranty Opinion", "Photos"]],
        body: ff.map(function(f, i){
          var photoNos = refs.photoNosByFindingId[f.id] || [];
          return [i + 1, f.condition, f.location, f.warranty, photoNos.length ? photoNos.map(function(n){ return "#" + n; }).join(", ") : "—"];
        }),
        theme: "grid",
        headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
        styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
        columnStyles: { 0: { cellWidth: 28 }, 3: { cellWidth: 100 }, 4: { cellWidth: 60 } },
        margin: { left: M, right: M }
      });
      y = doc.lastAutoTable.finalY + 18;
    }
  }

  var fr = filledRepairs();
  if (fr.length){
    heading("Work Performed");
    doc.autoTable({
      startY: y,
      head: [["No.", "Repair Performed", "Location / Detail", "Resolves"]],
      body: fr.map(function(r, i){ return [i + 1, r.repair, r.location, repairResolvesLabel(r.finding_id) || "—"]; }),
      theme: "grid",
      headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: { 0: { cellWidth: 28 } },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  /* Return visits — same content and column order as the HTML builder's
     table (both go through amendmentReportRow()), with Visit 1 as the
     original work order. Photos are cross-referenced by number; the images
     print once in Photo Documentation below. */
  if (filledAmendments(o).length){
    heading("Return Visits (Amendments)");
    doc.autoTable({
      startY: y,
      head: AMENDMENT_PDF_HEAD,
      body: amendmentReportPdfBody(o),
      theme: "grid",
      headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: AMENDMENT_PDF_COLUMN_STYLES,
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  /* Print-if-present like Work Performed above — see the HTML builder's
     Material List block for the reasoning; identical content here. */
  var fmat = filledMaterials();
  if (fmat.length){
    heading("Material List");
    doc.autoTable({
      startY: y,
      head: [["No.", "Material / Description", "Qty", "Unit", "Notes", "For"]],
      body: fmat.map(function(m, i){
        return [i + 1, m.material, m.qty, m.unit, m.notes, materialRepairRefLabel(m.repair_id) || "—"];
      }),
      theme: "grid",
      headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: { 0: { cellWidth: 28 }, 2: { cellWidth: 40 } },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  if (!isInspection && (o.warrantable || o.nonWarrantable || o.mfgServiceNo)){
    heading("Warranty Determination");
    kvTablePdf([["Warrantable Repairs", o.warrantable], ["Non-Warrantable Repairs", o.nonWarrantable], ["Manufacturer Service #", o.mfgServiceNo]]);
  }

  if (o.summary){
    heading("Summary");
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 39, 46);
    var lines = doc.splitTextToSize(o.summary, W - M * 2);
    lines.forEach(function(ln){
      if (y > H - M - 14){ doc.addPage(); y = M; }
      doc.text(ln, M, y);
      y += 13;
    });
    y += 12;
  }

  var fp = filledPhotos().filter(function(p){ return p.img; });
  var pdfImgs = new Map();
  if (fp.length){
    await Promise.all(fp.map(ensureDims));
    fp = fp.filter(function(p){ return p.w && p.h; });
    pdfImgs = await buildPdfPhotoMap(fp);
  }
  if (fp.length){
    heading("Photo Documentation");
    y += 10;
    var gap = 16;
    var cw = (W - M * 2 - gap) / 2;
    for (var i = 0; i < fp.length; i += 2){
      var pair = [fp[i], fp[i + 1]].filter(Boolean);
      var cells = pair.map(function(p){
        var ih = cw * p.h / p.w;
        if (ih > 300) ih = 300;
        var iw = Math.min(cw, ih * p.w / p.h);
        return { p: p, iw: iw, ih: ih };
      });
      var rowH = Math.max.apply(null, cells.map(function(c){ return c.ih; })) + 28;
      if (y + rowH > H - M){ doc.addPage(); y = M; }
      cells.forEach(function(c, j){
        var x = M + j * (cw + gap);
        try { doc.addImage(pdfImgs.get(c.p) || c.p.img, "JPEG", x, y, c.iw, c.ih); } catch(e){}
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(60, 70, 77);
        /* refs.fp (not the re-filtered local fp) so this number always
           matches the "Photos" column in the findings table above -- a
           photo skipped here for missing dimensions would otherwise shift
           every later number out of sync with that cross-reference. */
        var num = refs.fp.indexOf(c.p) + 1;
        var findingNo = c.p.finding_id ? refs.findingNoById[c.p.finding_id] : null;
        /* Same return-visit tag the HTML builder prints — "" for an ordinary
           first-visit photo, so unamended reports are unchanged. */
        var visitLabel = amendmentVisitLabelForPhoto(o, c.p);
        var capText = "Photo " + num + ": " + (c.p.caption || "") + (findingNo ? "  (Finding #" + findingNo + ")" : "") +
          (visitLabel ? "  (" + visitLabel + ")" : "");
        var cap = doc.splitTextToSize(capText, cw);
        doc.text(cap.slice(0, 2), x, y + c.ih + 11);
      });
      y += rowH + 8;
    }
  }

  /* footer on every page */
  var footTxt = (o.jobName || "") + " \u2014 " + (o.location || "") +
    " | Job No. " + (o.jobNo || "") + " | Date of Service: " + (o.serviceDate || "");
  var pages = doc.getNumberOfPages();
  for (var pg = 1; pg <= pages; pg++){
    doc.setPage(pg);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(91, 103, 112);
    doc.text(footTxt + "   \u00B7   Page " + pg + " of " + pages, M, H - 20);
  }
  return doc;
}
/* A change order is a work-authorization document — its own layout, not
   a section tacked onto the leak report: no findings table, no warranty
   framing, no per-finding photo linkage. Prominent Description of Work
   Performed, an itemized Materials list, a Cost Summary with an
   emphasized Total row, and a signature/date line — the things an
   actual change-order form has. Photos are optional/secondary here (per
   spec), so they're a plain grid at the end if present, not framed as
   investigation documentation. Fully self-contained, same pattern as
   generateLeakReportPdf() (its own doc/heading/kvTablePdf/wrappedTextPdf),
   so the two templates never interfere with each other. */
async function generateChangeOrderPdf(o){
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit: "pt", format: "letter" });
  var W = doc.internal.pageSize.getWidth();
  var H = doc.internal.pageSize.getHeight();
  var M = 40;
  var y = M;

  /* header with logo + a distinct "CHANGE ORDER" title */
  try { doc.addImage(LOGO, "PNG", M, y, 96, 52); } catch(e){}
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(180, 34, 63); /* Watkins brand red — see APP_OVERVIEW.md */
  doc.text("CHANGE ORDER", M + 112, y + 22, { maxWidth: W - M * 2 - 112 });
  doc.setFontSize(11);
  doc.setTextColor(30, 39, 46);
  doc.text(String((o.jobName || "") + (o.location ? " — " + o.location : "")), M + 112, y + 44, { maxWidth: W - M * 2 - 112 });
  y += 66;
  doc.setDrawColor(180, 34, 63);
  doc.setLineWidth(2);
  doc.line(M, y, W - M, y);
  y += 18;

  function heading(t){
    if (y > H - M - 60){ doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(38, 50, 56);
    doc.text(t.toUpperCase(), M, y);
    y += 8;
  }
  function kvTablePdf(rows){
    rows = rows.filter(function(r){ return r[1]; });
    if (!rows.length){ y += 8; return; }
    doc.autoTable({
      startY: y, body: rows, theme: "grid",
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 150 } },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 18;
  }
  function wrappedTextPdf(text){
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 39, 46);
    var lines = doc.splitTextToSize(text, W - M * 2);
    lines.forEach(function(ln){
      if (y > H - M - 14){ doc.addPage(); y = M; }
      doc.text(ln, M, y);
      y += 13;
    });
    y += 12;
  }

  heading("Job Information");
  kvTablePdf([
    ["Job Name", o.jobName], ["Location", o.location], ["Suite", o.suite], ["Date", o.serviceDate],
    ["Job No.", o.jobNo], ["Bill To", o.billTo], ["Billing Contact", o.billContact],
    ["Contact Phone", o.billPhone], ["Site Contact", o.siteContact], ["Technician", o.technician],
    ["PO Number", o.woPONumber], ["Date Completed", o.woDateCompleted]
  ]);

  /* prominent, per spec — its own heading right after Job Information,
     ahead of materials/cost */
  heading("Description of Work Performed");
  wrappedTextPdf(o.woDescription || "(none entered)");

  heading("Materials");
  /* Itemized Material List (materials[]) is primary; legacy free-text
     #woMaterials, if present, prints beneath it under an "Additional
     Material Notes" sub-heading so no historical Change Order loses data. */
  function bulletLinesPdf(lines){
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 39, 46);
    lines.forEach(function(m){
      if (y > H - M - 14){ doc.addPage(); y = M; }
      var wrapped = doc.splitTextToSize("• " + m, W - M * 2);
      doc.text(wrapped, M, y);
      y += 13 * wrapped.length;
    });
    y += 12;
  }
  var coMat = filledMaterials();
  var matLines = (o.woMaterials || "").split("\n").map(function(s){ return s.trim(); }).filter(Boolean);
  if (coMat.length) bulletLinesPdf(coMat.map(materialLineLabel));
  if (matLines.length){
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(38, 50, 56);
    if (y > H - M - 14){ doc.addPage(); y = M; }
    doc.text("Additional Material Notes", M, y);
    y += 13;
    bulletLinesPdf(matLines);
  }
  if (!coMat.length && !matLines.length) wrappedTextPdf("(none entered)");

  /* Return visits — the shared section (same head/body/columns as the leak
     work-order PDF), printed whenever a change order carries any. */
  if (filledAmendments(o).length){
    heading("Return Visits (Amendments)");
    doc.autoTable({
      startY: y,
      head: AMENDMENT_PDF_HEAD,
      body: amendmentReportPdfBody(o),
      theme: "grid",
      headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: AMENDMENT_PDF_COLUMN_STYLES,
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  heading("Cost Summary");
  var costRows = [["Man-Hours", o.woManHours || ""], ["Cost", o.woCost ? "$" + o.woCost : ""]];
  doc.autoTable({
    startY: y, body: costRows, theme: "grid",
    styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 150 } },
    margin: { left: M, right: M }
  });
  y = doc.lastAutoTable.finalY;
  /* Total row — visually emphasized (filled background, bold, larger),
     drawn separately from the table above rather than as just another
     autoTable row, so it reads as a real total the way an invoice does. */
  var totalRowH = 26, totalRowW = 240;
  doc.setFillColor(245, 245, 245);
  doc.setDrawColor(38, 50, 56);
  doc.setLineWidth(1);
  doc.rect(M, y, totalRowW, totalRowH, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(38, 50, 56);
  doc.text("TOTAL", M + 10, y + 17);
  doc.text(o.woCost ? "$" + o.woCost : "—", M + totalRowW - 10, y + 17, { align: "right" });
  y += totalRowH + 20;

  var fp = filledPhotos().filter(function(p){ return p.img; });
  var pdfImgs = new Map();
  if (fp.length){
    await Promise.all(fp.map(ensureDims));
    fp = fp.filter(function(p){ return p.w && p.h; });
    pdfImgs = await buildPdfPhotoMap(fp);
  }
  if (fp.length){
    heading("Photos");
    y += 10;
    var gap = 16;
    var cw = (W - M * 2 - gap) / 2;
    for (var i = 0; i < fp.length; i += 2){
      var pair = [fp[i], fp[i + 1]].filter(Boolean);
      var cells = pair.map(function(p){
        var ih = cw * p.h / p.w;
        if (ih > 300) ih = 300;
        var iw = Math.min(cw, ih * p.w / p.h);
        return { p: p, iw: iw, ih: ih };
      });
      var rowH = Math.max.apply(null, cells.map(function(c){ return c.ih; })) + 28;
      if (y + rowH > H - M){ doc.addPage(); y = M; }
      cells.forEach(function(c, j){
        var x = M + j * (cw + gap);
        try { doc.addImage(pdfImgs.get(c.p) || c.p.img, "JPEG", x, y, c.iw, c.ih); } catch(e){}
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(60, 70, 77);
        var num = fp.indexOf(c.p) + 1;
        var coVisit = amendmentVisitLabelForPhoto(o, c.p); /* "" unless shot on a return visit */
        var cap = doc.splitTextToSize("Photo " + num + ": " + (c.p.caption || "") +
          (coVisit ? "  (" + coVisit + ")" : ""), cw);
        doc.text(cap.slice(0, 2), x, y + c.ih + 11);
      });
      y += rowH + 8;
    }
  }

  /* approval / signature line — common on a real change order. When a
     signature was actually captured (openSignaturePad(), see "In-app
     signature capture" in DEV_NOTES.md), render the real drawn signature
     image plus Print Name + Date -- otherwise keep the EXACT original
     blank underline unchanged, so an un-signed Change Order's PDF stays
     byte-for-byte what it always was. */
  if (y > H - M - 100){ doc.addPage(); y = M; }
  y += 20;
  if (o.changeOrderSignature && o.changeOrderSignature.img){
    var sigBoxW = 220, sigBoxH = 50;
    try{ doc.addImage(o.changeOrderSignature.img, "PNG", M, y - sigBoxH, sigBoxW, sigBoxH); }catch(e){}
    doc.setDrawColor(55, 71, 79);
    doc.setLineWidth(1);
    doc.line(M, y, M + sigBoxW, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(38, 50, 56);
    doc.text("Signature", M, y + 12);
    y += 28;
    doc.setFontSize(10);
    doc.text("Print Name: " + o.changeOrderSignature.printName, M, y);
    doc.text("Date: " + o.changeOrderSignature.date, M + 260, y);
  } else {
    doc.setDrawColor(55, 71, 79);
    doc.setLineWidth(1);
    doc.line(M, y, M + 260, y);
    doc.line(M + 300, y, M + 460, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(38, 50, 56);
    doc.text("Approved By", M, y + 12);
    doc.text("Date", M + 300, y + 12);
  }

  /* footer on every page */
  var footTxt = (o.jobName || "") + " — " + (o.location || "") +
    " | Job No. " + (o.jobNo || "") + " | Date: " + (o.serviceDate || "");
  var pages = doc.getNumberOfPages();
  for (var pg = 1; pg <= pages; pg++){
    doc.setPage(pg);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(91, 103, 112);
    doc.text(footTxt + "   ·   Page " + pg + " of " + pages, M, H - 20);
  }
  return doc;
}
