"use strict";
/* ================= document build ================= */
function filledFindings(){ return findings.filter(function(f){ return f.condition || f.location; }); }
function filledRepairs(){ return repairs.filter(function(r){ return r.repair || r.location; }); }
function filledRepairItems(){ return repairItems.filter(function(it){ return it.qty || it.notes; }); }
function filledPhotos(){ return photos.filter(function(p){ return p.img || (p.caption||"").trim(); }); }

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
  L.push(isRepair ? "REPAIR / PROJECT REPORT" : (isInspection ? "ROOFING INSPECTION REPORT" : "LEAK WORK ORDER / REPAIR DOCUMENTATION"));
  L.push(o.jobName + (o.location ? " - " + o.location : ""));
  L.push("");
  L.push("JOB INFORMATION");
  L.push("Work Order Type: " + o.woType);
  L.push("Job Name: " + o.jobName);
  L.push("Location: " + o.location);
  L.push("Date of Service: " + o.serviceDate);
  L.push("Job No.: " + o.jobNo);
  L.push("Bill To: " + o.billTo);
  if (o.billContact) L.push((o.billTo || "Billing") + " Contact: " + o.billContact);
  if (o.billPhone) L.push("Contact Phone: " + o.billPhone);
  L.push("Site Contact: " + o.siteContact);
  if (o.technician) L.push("Technician: " + o.technician);
  if (!isInspection) L.push("Reported Leak Area: " + o.reportedArea);
  L.push("Roof System: " + o.roofSystem);
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
  L.push("");
  L.push("WORK PERFORMED");
  filledRepairs().forEach(function(r,i){
    L.push((i+1) + ". " + r.repair + (r.location ? " — " + r.location : ""));
  });
  L.push("");
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
  if (o.woMaterials) L.push(o.woMaterials);
  L.push("");
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
  if (!photoCheck.ok) alert(photosMissingWarning(photoCheck.missingCount));
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
    toBox.value = (o.woType === WORK_ORDER_TYPES[0] ? EMAIL_DEFAULT_TO_LEAK : EMAIL_DEFAULT_TO).join(", ");
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
async function rmFetchReportRoofOutlines(o){
  var bldName = (o.jobName || "").trim();
  if (!fdb || !bldName) return { roofEntries: [], error: null };
  var custId = (o.billTo || "").trim() ? ("cust_" + slugify(o.billTo)) : null;
  var bldId = "bld_" + slugify((custId || "nocust") + "_" + bldName);
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
      if (!outline || !outline.ring || outline.ring.length < 3) return;
      out.push({
        roofId: id,
        roofLabel: roof.label || (o.roofLabels && o.roofLabels[id]) || "Roof",
        outline: outline,
        assets: (roof.roof_assets || []).filter(function(a){ return typeof a.lat === "number" && typeof a.lng === "number"; })
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
         ss.measuredFt/edgeIndex/measurementId here -- the tape's scale is
         still in effect, but its original edge no longer corresponds to
         current geometry after a resnap/vertex-edit/square-up, so citing
         a specific "edge N" here would be a stale claim about current
         geometry. The real historical number still reaches the reader
         via clause 3 (nothing is excluded when disclosedId is null). */
      /* No "see Field Measurements" pointer here: disclosedId is null, so
         clause 3 is GUARANTEED to carry this record (the stale record is
         what rmLatestAppliedMeasuredEdge() returned, so it is by
         construction in rmAllMeasuredEdgeRecords()) and it appends the
         pointer itself. Saying it twice in one sentence reads like a
         glitch on a customer PDF. */
      /* Issue #29 -- this used to hardcode "the edge it was taken on has
         since been edited" for EVERY stale reason. measurementStale is
         also set for invalidatedReason==="superseded_by_remeasure" --
         which is NOT a geometry edit, nothing moved, the SAME edge was
         just taped again. Asserting "edited" there was a fabricated claim
         on a customer PDF, and it directly contradicted clause 3's own
         (already-correct) status for the identical record a few lines
         later. Fixed by looking up the real record and reusing
         rmReportMeasurementStatusLabel() -- the SAME reason-aware wording
         clause 3 already uses -- rather than a second, independently-
         maintained (and in this case wrong) copy of "what does this
         invalidation reason mean." Clause 2 and clause 3 now describe the
         same record identically because they call the same function; they
         cannot drift apart again. Defense-in-depth alongside Codex's
         issue #28 (fixing measurementStale itself, roofmapper-side, so it
         only means "a geometry edit moved this edge") -- this reads the
         real invalidatedReason regardless of what the flag means, so it
         renders the truth even if the flag is ever imprecise again. */
      var staleRecord = (outline && typeof rmLatestAppliedMeasuredEdge === "function") ? rmLatestAppliedMeasuredEdge(outline) : null;
      var staleStatus = staleRecord ? rmReportMeasurementStatusLabel(staleRecord) : "since changed";
      return { text: "Scale set by a field measurement on this roof (" + staleStatus + ").", disclosedId: null };
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
function rmBuildReportRoofPlanSvg(roofEntries){
  if (!roofEntries || !roofEntries.length) return null;
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
    var pathD = "M " + pathPts.map(function(p){ return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" L ") + " Z";
    shapeSvg += '<path d="' + pathD + '" fill="rgba(232,96,10,0.12)" stroke="#E8600A" stroke-width="2" stroke-linejoin="round"/>';
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
       "<div><div class='t1 cond' style='color:#B4223F'>" + (isRepair ? "Repair / Project Report" : (isInspection ? "Roofing Inspection Report" : "Leak Work Order / Repair Documentation")) + "</div>" +
       "<div class='t2'>" + esc(o.jobName) + (o.location ? " — " + esc(o.location) : "") + "</div></div></div>";

  h += "<h3 class='cond'>Job Information</h3>" + kvTable([
    ["Work Order Type",o.woType],
    ["Job Name",o.jobName],["Location",o.location],["Date of Service",o.serviceDate],
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
    .concat([["Roof System",o.roofSystem]]));

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
    if (plan){
      h += "<h3 class='cond'>Roof Plan</h3>" +
        "<div style='border:1px solid #CFD8DC;border-radius:6px;overflow:hidden'>" + plan.svg + "</div>";
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
      h += "<h3 class='cond'>Inspection Checklist</h3><table><thead><tr>" +
        "<th>Component</th><th style='width:90px'>Condition</th><th>Notes</th></tr></thead><tbody>" +
        o.inspectionChecklist.map(function(item){
          return "<tr><td>" + esc(inspectionComponentLabel(item.key)) + "</td><td>" + esc(item.rating) +
            "</td><td>" + esc(item.notes) + "</td></tr>";
        }).join("") + "</tbody></table>";
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
      "<th style='width:36px'>No.</th><th>Repair Performed</th><th>Location / Detail</th></tr></thead><tbody>" +
      fr.map(function(r,i){
        return "<tr><td>" + (i+1) + "</td><td>" + esc(r.repair) + "</td><td>" + esc(r.location) + "</td></tr>";
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
      fp.map(function(p,i){
        var findingNo = p.finding_id ? refs.findingNoById[p.finding_id] : null;
        return "<div class='photocell'>" +
          (p.img ? "<img src='" + p.img + "'>" : "") +
          "<div class='cap'><b>Photo " + (i+1) + ":</b> " + esc(p.caption || "") +
          (findingNo ? " <span style='color:#5B6770'>(Finding #" + findingNo + ")</span>" : "") + "</div></div>";
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
    ["Job Name",o.jobName],["Location",o.location],["Date",o.serviceDate],
    ["Job No.",o.jobNo],["Bill To",o.billTo],["Billing Contact",o.billContact],
    ["Contact Phone",o.billPhone],["Site Contact",o.siteContact],["Technician",o.technician],
    ["PO Number",o.woPONumber],["Date Completed",o.woDateCompleted]]);

  h += "<h3 class='cond'>Description of Work Performed</h3>" +
    "<p style='white-space:pre-wrap'>" + (o.woDescription ? esc(o.woDescription) : "<span class='co-empty'>(none entered)</span>") + "</p>";

  h += "<h3 class='cond'>Materials</h3>";
  var matLines = (o.woMaterials || "").split("\n").map(function(s){ return s.trim(); }).filter(Boolean);
  h += matLines.length ?
    "<ul class='co-materials'>" + matLines.map(function(m){ return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>" :
    "<p class='co-empty'>(none entered)</p>";

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
        return "<div class='photocell'>" +
          (p.img ? "<img src='" + p.img + "'>" : "") +
          "<div class='cap'><b>Photo " + (i+1) + ":</b> " + esc(p.caption || "") + "</div></div>";
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
  var subject = (o.woType === "Change Order" ? "Change Order — " : "Leak Work Order — ") + (o.jobName || "Job") +
    (o.jobNo ? " #" + o.jobNo : "") + (o.location ? " (" + o.location + ")" : "");
  var addrList = parseEmailRecipients(val("emailTo"));
  var alreadyHasBcc = addrList.some(function(a){ return a.toLowerCase() === EMAIL_ALWAYS_BCC.toLowerCase(); });
  var addrs = addrList.map(encodeURIComponent).join(",");
  var href = "mailto:" + addrs +
    "?subject=" + encodeURIComponent(subject) +
    "&body=" + encodeURIComponent(buildText()) +
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
function pdfFileName(){
  var o = collect();
  var prefix = o.woType === "Change Order" ? "ChangeOrder" : (o.woType === "Repair" ? "Repair" : "WorkOrder");
  var base = (prefix + "_" + (o.jobName || "") + "_" + (o.jobNo || ""))
    .replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return (base || prefix) + ".pdf";
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
async function ensurePhotosLoadedForExport(){
  var missing = (photos || []).filter(function(p){ return !p.img; });
  if (!missing.length) return { ok: true };

  var stillMissingAfterStorage = [];
  for (var mi = 0; mi < missing.length; mi++){
    var resolved = missing[mi].storageRef ? await resolvePhotoImg(missing[mi]) : null;
    if (!resolved) stillMissingAfterStorage.push(missing[mi]);
  }
  if (!stillMissingAfterStorage.length){
    renderPhotos();
    return { ok: true, recovered: missing.length };
  }

  if (!currentId || !fdb) return { ok: false, missingCount: stillMissingAfterStorage.length };
  try{
    var cloudCopy = await cloudFetchOrder(currentId);
    if (!cloudCopy || !cloudCopy.photos || cloudCopy.photos.length !== photos.length){
      return { ok: false, missingCount: stillMissingAfterStorage.length };
    }
    var stillMissing = 0;
    photos.forEach(function(p, i){
      if (p.img) return;
      var match = cloudCopy.photos[i];
      if (match && match.img) p.img = match.img;
      else stillMissing++;
    });
    if (stillMissing > 0) return { ok: false, missingCount: stillMissing };
    renderPhotos();
    return { ok: true, recovered: missing.length };
  }catch(e){ return { ok: false, missingCount: missing.length, error: e.message }; }
}
function photosMissingWarning(missingCount){
  return "⚠️ " + missingCount + " photo" + (missingCount === 1 ? "" : "s") + " couldn't be loaded" +
    (fdb ? " from the cloud" : " — no internet connection") + ". Stopped rather than produce a report " +
    "with missing images. Check your connection and reopen this work order, or re-add the missing photo(s), then try again.";
}
async function generatePdf(){
  if (!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable)){
    toast("PDF tools couldn't load — check your internet connection, or use Print instead.");
    return null;
  }
  var photoCheck = await ensurePhotosLoadedForExport();
  if (!photoCheck.ok){
    alert(photosMissingWarning(photoCheck.missingCount));
    return null;
  }
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
  doc.text(isRepair ? "REPAIR / PROJECT REPORT" : (isInspection ? "ROOFING INSPECTION REPORT" : "LEAK WORK ORDER / REPAIR DOCUMENTATION"), M + 112, y + 20, { maxWidth: W - M * 2 - 112 });
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
    ["Work Order Type", o.woType],
    ["Job Name", o.jobName], ["Location", o.location], ["Date of Service", o.serviceDate],
    ["Job No.", o.jobNo], ["Bill To", o.billTo], ["Billing Contact", o.billContact],
    ["Contact Phone", o.billPhone], ["Site Contact", o.siteContact], ["Technician", o.technician]
  ].concat(isInspection ? [] : [["Reported Leak Area", o.reportedArea]]).concat([["Roof System", o.roofSystem]]));

  /* Roof plan + capture/scale provenance -- see the "roof plan + capture/
     scale provenance" section above reportDistinctRoofIds() for the full
     design rationale. Rasterizes the SAME rmBuildReportRoofPlanSvg() SVG
     the HTML report embeds directly, so the PDF and the Preview/email HTML
     are guaranteed to show the identical roof plan, not two independent
     drawings that could drift apart. */
  if (roofPlanData && roofPlanData.length){
    var plan = rmBuildReportRoofPlanSvg(roofPlanData);
    if (plan){
      try{
        var planCanvas = await rmRasterizeSvgToCanvas(plan.svg, plan.width, plan.height);
        var planDataUrl = planCanvas.toDataURL("image/png");
        heading("Roof Plan");
        var availW = W - M * 2;
        var planW = availW, planH = availW * plan.height / plan.width;
        var maxPlanH = 380;
        if (planH > maxPlanH){ planH = maxPlanH; planW = maxPlanH * plan.width / plan.height; }
        if (y + planH > H - M){ doc.addPage(); y = M; }
        doc.addImage(planDataUrl, "PNG", M, y, planW, planH);
        y += planH + 18;
      }catch(e){ console.warn("Couldn't rasterize roof plan for PDF:", e); }

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
      doc.autoTable({
        startY: y,
        head: [["Component", "Condition", "Notes"]],
        body: o.inspectionChecklist.map(function(item){ return [inspectionComponentLabel(item.key), item.rating, item.notes]; }),
        theme: "grid",
        headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
        styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
        columnStyles: { 1: { cellWidth: 70 } },
        margin: { left: M, right: M }
      });
      y = doc.lastAutoTable.finalY + 18;
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
      head: [["No.", "Repair Performed", "Location / Detail"]],
      body: fr.map(function(r, i){ return [i + 1, r.repair, r.location]; }),
      theme: "grid",
      headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
      styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
      columnStyles: { 0: { cellWidth: 28 } },
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
  if (fp.length){
    await Promise.all(fp.map(ensureDims));
    fp = fp.filter(function(p){ return p.w && p.h; });
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
        try { doc.addImage(c.p.img, "JPEG", x, y, c.iw, c.ih); } catch(e){}
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(60, 70, 77);
        /* refs.fp (not the re-filtered local fp) so this number always
           matches the "Photos" column in the findings table above -- a
           photo skipped here for missing dimensions would otherwise shift
           every later number out of sync with that cross-reference. */
        var num = refs.fp.indexOf(c.p) + 1;
        var findingNo = c.p.finding_id ? refs.findingNoById[c.p.finding_id] : null;
        var capText = "Photo " + num + ": " + (c.p.caption || "") + (findingNo ? "  (Finding #" + findingNo + ")" : "");
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
    ["Job Name", o.jobName], ["Location", o.location], ["Date", o.serviceDate],
    ["Job No.", o.jobNo], ["Bill To", o.billTo], ["Billing Contact", o.billContact],
    ["Contact Phone", o.billPhone], ["Site Contact", o.siteContact], ["Technician", o.technician],
    ["PO Number", o.woPONumber], ["Date Completed", o.woDateCompleted]
  ]);

  /* prominent, per spec — its own heading right after Job Information,
     ahead of materials/cost */
  heading("Description of Work Performed");
  wrappedTextPdf(o.woDescription || "(none entered)");

  heading("Materials");
  var matLines = (o.woMaterials || "").split("\n").map(function(s){ return s.trim(); }).filter(Boolean);
  if (matLines.length){
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 39, 46);
    matLines.forEach(function(m){
      if (y > H - M - 14){ doc.addPage(); y = M; }
      var wrapped = doc.splitTextToSize("• " + m, W - M * 2);
      doc.text(wrapped, M, y);
      y += 13 * wrapped.length;
    });
    y += 12;
  } else {
    wrappedTextPdf("(none entered)");
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
  if (fp.length){
    await Promise.all(fp.map(ensureDims));
    fp = fp.filter(function(p){ return p.w && p.h; });
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
        try { doc.addImage(c.p.img, "JPEG", x, y, c.iw, c.ih); } catch(e){}
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(60, 70, 77);
        var num = fp.indexOf(c.p) + 1;
        var cap = doc.splitTextToSize("Photo " + num + ": " + (c.p.caption || ""), cw);
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
