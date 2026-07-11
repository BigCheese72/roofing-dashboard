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
function renderLeakReportDoc(o){
  var isRepair = o.woType === "Repair";
  var isInspection = o.woType === "Inspection";
  var h = "";
  h += "<div class='dochead' style='display:flex;align-items:center;gap:16px'>" +
       "<img src='" + LOGO + "' alt='Watkins Roofing' style='height:72px;flex:none'>" +
       "<div><div class='t1 cond'>" + (isRepair ? "Repair / Project Report" : (isInspection ? "Roofing Inspection Report" : "Leak Work Order / Repair Documentation")) + "</div>" +
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
          "<th style='width:130px'>Warranty Opinion</th></tr></thead><tbody>" +
          rows.map(function(f,i){
            return "<tr><td>" + (i+1) + "</td><td>" + esc(f.condition) + "</td><td>" +
              esc(f.location) + "</td><td>" + esc(f.warranty) + "</td></tr>";
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

  var fp = filledPhotos();
  if (fp.length){
    h += "<h3 class='cond'>Photo Documentation</h3>" +
      "<p style='font-size:13px'>The following photographs document the reported leak investigation, observed roof conditions, and completed repairs.</p>" +
      "<div class='photogrid'>" +
      fp.map(function(p,i){
        return "<div class='photocell'>" +
          (p.img ? "<img src='" + p.img + "'>" : "") +
          "<div class='cap'><b>Photo " + (i+1) + ":</b> " + esc(p.caption || "") + "</div></div>";
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
async function generatePdf(){
  if (!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable)){
    toast("PDF tools couldn't load — check your internet connection, or use Print instead.");
    return null;
  }
  var o = collect();
  return o.woType === "Change Order" ? generateChangeOrderPdf(o) : generateLeakReportPdf(o);
}
async function generateLeakReportPdf(o){
  var isRepair = o.woType === "Repair";
  var isInspection = o.woType === "Inspection";
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit: "pt", format: "letter" });
  var W = doc.internal.pageSize.getWidth();
  var H = doc.internal.pageSize.getHeight();
  var M = 40;
  var y = M;

  /* header with logo */
  try { doc.addImage(LOGO, "PNG", M, y, 96, 52); } catch(e){}
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(30, 39, 46);
  doc.text(isRepair ? "REPAIR / PROJECT REPORT" : (isInspection ? "ROOFING INSPECTION REPORT" : "LEAK WORK ORDER / REPAIR DOCUMENTATION"), M + 112, y + 20, { maxWidth: W - M * 2 - 112 });
  doc.setFontSize(11);
  doc.text(String((o.jobName || "") + (o.location ? " \u2014 " + o.location : "")), M + 112, y + 42, { maxWidth: W - M * 2 - 112 });
  y += 66;
  doc.setDrawColor(38, 50, 56);
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
        head: [["No.", "Roof Condition Observed", "Location / Detail", "Warranty Opinion"]],
        body: ff.map(function(f, i){ return [i + 1, f.condition, f.location, f.warranty]; }),
        theme: "grid",
        headStyles: { fillColor: [38, 50, 56], fontSize: 8 },
        styles: { fontSize: 9, cellPadding: 4, textColor: [30, 39, 46], lineColor: [154, 165, 172], lineWidth: 0.5 },
        columnStyles: { 0: { cellWidth: 28 }, 3: { cellWidth: 110 } },
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
        var num = fp.indexOf(c.p) + 1;
        var cap = doc.splitTextToSize("Photo " + num + ": " + (c.p.caption || ""), cw);
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
