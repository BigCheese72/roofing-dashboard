"use strict";
/* Owner Estimate QA
   Private pre-bid review surface for Mark/the app owner. It reads the active
   work order and linked CompanyCam metadata, then flags estimating items that
   deserve a human check. It is advisory only: no pricing, work-order, or
   proposal data is changed here. */

var ownerQaLastCcPhotoCount = null;
var ownerQaLastCcCheckedAt = null;

var OWNER_QA_GROUPS = [
  { key: "access", label: "Access / Lift", words: ["lift", "lull", "telehandler", "boom", "scissor", "crane", "access", "load", "rooftop delivery"] },
  { key: "tearoff", label: "Tear-off / Disposal", words: ["tear off", "tearoff", "remove", "dumpster", "disposal", "debris", "landfill"] },
  { key: "drain", label: "Drains / Scuppers", words: ["drain", "retro", "retrofit", "scupper", "sump", "overflow"] },
  { key: "curb", label: "Curbs / RTUs", words: ["curb", "rtu", "hvac", "unit", "exhaust", "equipment"] },
  { key: "pipe", label: "Pipes / Penetrations", words: ["pipe", "boot", "vent", "penetration", "stack", "conduit", "gas line"] },
  { key: "wall", label: "Walls / Coping", words: ["wall", "parapet", "coping", "stone", "mortar", "nailer", "blocking", "anchor", "j-hook", "j hook"] },
  { key: "edge", label: "Edge Metal", words: ["edge", "metal", "coping cap", "counterflashing", "termination", "gutter", "fascia"] },
  { key: "taper", label: "Taper / Slope", words: ["taper", "slope", "canopy", "cricket", "iso", "insulation", "quarter", "1/4", "ponding"] },
  { key: "warranty", label: "Warranty", words: ["warranty", "red shield", "20 year", "20-year", "elevate", "manufacturer"] }
];

function ownerEstimateQaIsOwner(){
  return !!(currentAuthClaims && currentAuthClaims.owner === true);
}

function ownerEstimateQaOnShow(){
  if (!ownerEstimateQaIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    showView("edit");
    return;
  }
  ownerEstimateQaScanActive({ quiet: true });
}

function ownerQaSafeVal(id){
  var el = document.getElementById(id);
  return el ? String(el.value || "").trim() : "";
}

function ownerQaPhotoText(p){
  if (!p) return "";
  return [
    p.caption, p.notes, p.description, p.name, p.fileName, p.filename,
    p.creator_name, p.creatorName, p.companyCamProjectName
  ].filter(Boolean).join(" ");
}

function ownerQaFindingText(f){
  if (!f) return "";
  return [f.condition, f.location, f.notes, f.recommendation, f.warranty].filter(Boolean).join(" ");
}

function ownerQaCurrentJob(){
  return {
    id: currentId || "",
    jobName: ownerQaSafeVal("jobName"),
    location: ownerQaSafeVal("location"),
    billTo: ownerQaSafeVal("billTo"),
    type: ownerQaSafeVal("woType"),
    description: ownerQaSafeVal("woDescription") || ownerQaSafeVal("repairDescription"),
    roofSystem: ownerQaSafeVal("roofSystem"),
    companyCamProjectId: ccLinkedProjectId || "",
    companyCamProjectName: ccLinkedProjectName || "",
    photos: (typeof photos !== "undefined" && Array.isArray(photos)) ? photos.slice() : [],
    findings: (typeof findings !== "undefined" && Array.isArray(findings)) ? findings.slice() : [],
    materials: (typeof materials !== "undefined" && Array.isArray(materials)) ? materials.slice() : []
  };
}

function ownerQaKeywordGroups(job, extraPhotoText){
  var groups = {};
  OWNER_QA_GROUPS.forEach(function(g){ groups[g.key] = []; });
  var textSources = [];
  textSources.push({ label: "Job notes", text: [job.jobName, job.location, job.type, job.description, job.roofSystem].join(" ") });
  job.findings.forEach(function(f, i){ textSources.push({ label: "Finding " + (i + 1), text: ownerQaFindingText(f) }); });
  job.materials.forEach(function(m, i){ textSources.push({ label: "Material " + (i + 1), text: [m.material, m.notes, m.unit].filter(Boolean).join(" ") }); });
  job.photos.forEach(function(p, i){ textSources.push({ label: "Photo " + (i + 1), text: ownerQaPhotoText(p) }); });
  if (extraPhotoText) textSources.push({ label: "CompanyCam metadata", text: extraPhotoText });

  textSources.forEach(function(src){
    var lower = String(src.text || "").toLowerCase();
    if (!lower.trim()) return;
    OWNER_QA_GROUPS.forEach(function(g){
      if (g.words.some(function(w){ return lower.indexOf(w) !== -1; })){
        groups[g.key].push(src.label);
      }
    });
  });
  return groups;
}

function ownerQaStatusItem(status, title, body){
  return { status: status, title: title, body: body };
}

function ownerQaBuildChecklist(job, groups){
  var items = [];
  var photoCount = job.photos.length;
  var ccCount = ownerQaLastCcPhotoCount;
  var hasCc = !!job.companyCamProjectId;

  items.push(ownerQaStatusItem(hasCc ? "ok" : "risk", "CompanyCam link",
    hasCc ? "Linked to " + (job.companyCamProjectName || job.companyCamProjectId) + "." :
      "No CompanyCam project is linked to this active job. Link/import photos before trusting the review."));

  items.push(ownerQaStatusItem(photoCount ? "ok" : "risk", "Imported photo evidence",
    photoCount ? photoCount + " imported photo" + (photoCount === 1 ? "" : "s") + " available in this work order." :
      "No imported photos are available. The owner QA cannot inspect captions or photo notes yet."));

  if (ccCount !== null){
    items.push(ownerQaStatusItem(ccCount ? "ok" : "review", "CompanyCam photo count",
      ccCount + " CompanyCam project photo" + (ccCount === 1 ? "" : "s") + " found" +
      (ownerQaLastCcCheckedAt ? " at " + ownerQaLastCcCheckedAt : "") + "."));
  }

  items.push(ownerQaStatusItem(groups.access.length ? "ok" : "review", "Lift / access allowance",
    groups.access.length ? "Access-related evidence found: " + groups.access.slice(0, 4).join(", ") + "." :
      "No lift, crane, loading, or access note found. Confirm rental equipment before sending a final number."));

  items.push(ownerQaStatusItem(groups.tearoff.length ? "ok" : "review", "Tear-off and disposal",
    groups.tearoff.length ? "Tear-off/disposal evidence found: " + groups.tearoff.slice(0, 4).join(", ") + "." :
      "No dumpster or disposal note found. Confirm tear-off, debris handling, and landfill fees."));

  items.push(ownerQaStatusItem(groups.drain.length ? "ok" : "review", "Drains and scuppers",
    groups.drain.length ? "Drain/scupper evidence found: " + groups.drain.slice(0, 5).join(", ") + "." :
      "No drain/scupper evidence found. Confirm drain count, retrofit drains, sumps, and overflow details."));

  items.push(ownerQaStatusItem((groups.curb.length || groups.pipe.length) ? "ok" : "review", "Curbs and penetrations",
    (groups.curb.length || groups.pipe.length) ?
      "Penetration evidence found: " + groups.curb.concat(groups.pipe).slice(0, 5).join(", ") + "." :
      "No curb, RTU, pipe, or penetration evidence found. Confirm boots, flashing, and curb securement."));

  items.push(ownerQaStatusItem(groups.wall.length ? "ok" : "review", "Parapet, coping, and blocking",
    groups.wall.length ? "Wall/coping evidence found: " + groups.wall.slice(0, 5).join(", ") + "." :
      "No parapet/coping note found. Confirm wall height, coping removal, wood nailer, anchors, and blocking layers."));

  items.push(ownerQaStatusItem(groups.taper.length ? "ok" : "review", "Taper / structurally sloped roof",
    groups.taper.length ? "Taper/slope evidence found: " + groups.taper.slice(0, 5).join(", ") + "." :
      "No taper/slope note found. Confirm whether the roof is structurally sloped or needs tapered insulation."));

  items.push(ownerQaStatusItem(groups.warranty.length ? "ok" : "review", "Warranty allowance",
    groups.warranty.length ? "Warranty evidence found: " + groups.warranty.slice(0, 4).join(", ") + "." :
      "No warranty note found. Confirm warranty term, manufacturer fee, wind speed, and attachment requirements."));

  return items;
}

function ownerQaItemHtml(item){
  return '<div class="ownerqa-item ' + esc(item.status) + '">' +
    '<b>' + esc(item.title) + '</b><p>' + esc(item.body) + '</p></div>';
}

function ownerQaRenderSummary(job){
  var ccText = job.companyCamProjectId ? (job.companyCamProjectName || job.companyCamProjectId) : "Not linked";
  var metrics = [
    { label: "Imported photos", value: job.photos.length },
    { label: "Findings", value: job.findings.length },
    { label: "Materials rows", value: job.materials.length },
    { label: "CompanyCam photos", value: ownerQaLastCcPhotoCount === null ? "-" : ownerQaLastCcPhotoCount }
  ];
  return '<div class="ownerqa-metrics">' + metrics.map(function(m){
    return '<div class="ownerqa-metric"><b>' + esc(m.value) + '</b><span>' + esc(m.label) + '</span></div>';
  }).join("") + '</div>' +
    '<div class="ownerqa-list">' +
    ownerQaItemHtml(ownerQaStatusItem(job.jobName ? "ok" : "review", "Active job", job.jobName || "No job name filled in.")) +
    ownerQaItemHtml(ownerQaStatusItem(job.location ? "ok" : "review", "Location", job.location || "No location filled in.")) +
    ownerQaItemHtml(ownerQaStatusItem(job.companyCamProjectId ? "ok" : "risk", "CompanyCam project", ccText)) +
    '</div>';
}

function ownerQaRenderEvidence(groups){
  return '<div class="ownerqa-evidence-grid">' + OWNER_QA_GROUPS.map(function(g){
    var hits = groups[g.key] || [];
    return '<div class="ownerqa-evidence-card"><b>' + esc(g.label) + '</b>' +
      '<p>' + (hits.length ? esc(hits.slice(0, 8).join(", ")) : 'No evidence found yet.') + '</p></div>';
  }).join("") + '</div>';
}

function ownerEstimateQaScanActive(opts){
  if (!ownerEstimateQaIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var job = ownerQaCurrentJob();
  var groups = ownerQaKeywordGroups(job, "");
  var checklist = ownerQaBuildChecklist(job, groups);
  var summary = document.getElementById("ownerqa-summary");
  var list = document.getElementById("ownerqa-checklist");
  var evidence = document.getElementById("ownerqa-evidence");
  if (summary) summary.innerHTML = ownerQaRenderSummary(job);
  if (list) list.innerHTML = '<div class="ownerqa-list">' + checklist.map(ownerQaItemHtml).join("") + '</div>';
  if (evidence) evidence.innerHTML = ownerQaRenderEvidence(groups);
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Owner estimate QA refreshed.");
  }
  return { job: job, groups: groups, checklist: checklist };
}

async function ownerEstimateQaSyncCompanyCam(){
  if (!ownerEstimateQaIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (!ccLinkedProjectId){
    if (typeof toast === "function") toast("No CompanyCam project linked yet.");
    ownerEstimateQaScanActive({ quiet: true });
    return;
  }
  if (typeof ccApi !== "function"){
    if (typeof toast === "function") toast("CompanyCam API is not available.");
    return;
  }
  if (typeof toast === "function") toast("Checking CompanyCam photos...");
  var all = [];
  var page = 1;
  try{
    while (page <= 5){
      var out = await ccApi({ action: "photos", project_id: ccLinkedProjectId, page: page });
      var batch = out.photos || [];
      all = all.concat(batch);
      if (batch.length < 30) break;
      page++;
    }
    ownerQaLastCcPhotoCount = all.length;
    ownerQaLastCcCheckedAt = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    var job = ownerQaCurrentJob();
    var groups = ownerQaKeywordGroups(job, all.map(ownerQaPhotoText).join(" "));
    var checklist = ownerQaBuildChecklist(job, groups);
    var summary = document.getElementById("ownerqa-summary");
    var list = document.getElementById("ownerqa-checklist");
    var evidence = document.getElementById("ownerqa-evidence");
    if (summary) summary.innerHTML = ownerQaRenderSummary(job);
    if (list) list.innerHTML = '<div class="ownerqa-list">' + checklist.map(ownerQaItemHtml).join("") + '</div>';
    if (evidence) evidence.innerHTML = ownerQaRenderEvidence(groups);
    if (typeof toast === "function") toast("CompanyCam photo count checked.");
    return { photoCount: all.length, groups: groups, checklist: checklist };
  }catch(e){
    if (typeof toast === "function") toast("CompanyCam check failed: " + e.message);
  }
}
