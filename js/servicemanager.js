"use strict";
/* ============================================================================
 * Service Manager workspace — pre-create work orders from proposals (or blank),
 * cross-reference them to the real Foundation job, assign them to a CREW for a
 * DAY, and watch a live per-crew dispatch board that clears as work completes.
 *
 * WHY THIS EXISTS (Mark, 2026-07-17): Nathan sends proposals (often by email)
 * and the matching work orders don't always get created, so sold work slips
 * through. This is the ONE place a service manager pre-creates the WO and gets
 * it onto a crew's day. "Scheduling" here = WO created + scope built + assigned
 * to a crew for a day — deliberately NOT a full calendar/crew planner (phase 2).
 *
 * MODEL DECISIONS (see the exploration notes in the PR):
 *   * A "CREW" is keyed by its FOREMAN NAME (the DPR_FOREMEN roster in
 *     js/dpr.js). RoofOps has no durable crew entity today — the DPR already
 *     identifies a crew by (building, date, foreman name), so we reuse that
 *     reality instead of inventing a crews collection. Durable crew membership
 *     + per-individual-tech queues are a flagged follow-up.
 *   * Dispatch lives as ONE nested `dispatch` object on the work order
 *     ({ crew, date, status, assignedAt/By, clearedAt/By }); the fields live in
 *     collect()/fill() (js/workorders.js) so an ordinary edit-form save never
 *     drops a dispatched WO's assignment. This module WRITES dispatch two ways:
 *     pre-create builds the object directly through the normal cloud-save path;
 *     assign/clear use TARGETED Firestore updates (dot-notation) that also bump
 *     savedAt so a concurrent stale edit-form save trips the clobber guard.
 *   * Proposal FILES: emailed proposals attach BY REFERENCE (Outlook messageId
 *     + attachmentId + name) — storage-free, re-fetchable on demand via the
 *     contacts-sync attachment actions. Manual uploads persist metadata (+ the
 *     bytes inline only when small); Storage-backed large uploads are a flagged
 *     follow-up (dev has no Storage bucket — Spark plan).
 *
 * GATING: the tab is shown only to owner/admin/ops_manager/service_manager
 * (canServiceManage() in js/core.js) — the SAME role set that already holds
 * warranty.manage_reports, which SERVER-gates the proposal source
 * (netlify/functions/contacts-sync.js). NO new permission key: WO writes are
 * client-direct under the existing open `workorders` rules and the proposal
 * source is already gated, so there is nothing new to enforce server-side in
 * v1. UI-hiding is convenience only (docs/AUTH_DESIGN.md).
 *
 * Loaded after js/dpr.js (crew roster) and js/workorders.js (dispatch globals).
 * Pure helpers at the bottom are exercised by tests/serviceManager.test.js via
 * vm — see that file. ========================================================= */

/* ---- module state ---- */
var smSection = "proposals";     // "proposals" | "board"
var smInitialised = false;
var smProposals = [];            // last-loaded proposal rows from contacts-sync
var smWoIndex = [];              // recent saved-WO index (for WO-exists flag + assign list)
var smCurrentProposal = null;    // proposal ref being pre-created from (or null)
var smFoundationPick = null;     // Foundation job matched for the current pre-create

/* ---- small DOM/utility helpers (kept local so this module is self-contained
 *      and vm-testable without the rest of the app) ---- */
function smEsc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function smNorm(s){
  if (typeof fdnNormalizeText === "function") return fdnNormalizeText(s);
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function smEl(id){ return (typeof document !== "undefined") ? document.getElementById(id) : null; }
function setVal2(id, v){ var e = smEl(id); if (e) e.value = (v == null ? "" : v); }
function getVal2(id){ var e = smEl(id); return e ? e.value : ""; }
function smToast(m){ if (typeof toast === "function") toast(m); }

/* ---- date helpers (local YYYY-MM-DD, matching the DPR's convention so a
 *      late-evening dispatch doesn't roll to tomorrow) ---- */
function smLocalYmd(d){
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}
function smTodayStr(){
  if (typeof dprTodayStr === "function") return dprTodayStr();
  return smLocalYmd(new Date());
}
function smDayOffsetStr(n){ var d = new Date(); d.setDate(d.getDate() + (n || 0)); return smLocalYmd(d); }
/* YYYY-MM-DD -> the app's own M/D/YY serviceDate format (todayStr()'s shape). */
function smYmdToMdy(ymd){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return (typeof todayStr === "function") ? todayStr() : "";
  return (+m[2]) + "/" + (+m[3]) + "/" + String(m[1]).slice(-2);
}
function smFmtDate(iso){
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(-2);
}
function smCurrentUserLabel(){
  try {
    if (typeof currentAuthUser !== "undefined" && currentAuthUser){
      return currentAuthUser.displayName || currentAuthUser.email || currentAuthUser.uid || null;
    }
  } catch (e) {}
  return null;
}

/* =========================== view lifecycle =============================== */
function smOnShow(){
  smApplyPermissionUI();
  if (typeof canServiceManage === "function" && !canServiceManage()) return;
  smPopulateCrewDatalist();
  if (typeof fdnPrimePicker === "function") { try { fdnPrimePicker(); } catch (e) {} } // prime fdnCache for cross-ref
  var bd = smEl("sm-board-date");
  if (bd && !bd.value) bd.value = smTodayStr();
  if (!smInitialised){ smShowSection("proposals"); smInitialised = true; }
  else { smShowSection(smSection); }
  smRefreshWoIndex();
}
function smApplyPermissionUI(){
  var can = (typeof canServiceManage === "function") ? canServiceManage() : true;
  var gate = smEl("sm-gate"), bodyEl = smEl("sm-body");
  if (gate) gate.style.display = can ? "none" : "";
  if (bodyEl) bodyEl.style.display = can ? "" : "none";
}
function smShowSection(name){
  smSection = name;
  var ps = smEl("sm-section-proposals"), bs = smEl("sm-section-board");
  if (ps) ps.style.display = (name === "proposals") ? "" : "none";
  if (bs) bs.style.display = (name === "board") ? "" : "none";
  var pb = smEl("sm-seg-proposals"), bb = smEl("sm-seg-board");
  if (pb) pb.classList.toggle("primary", name === "proposals");
  if (bb) bb.classList.toggle("primary", name === "board");
  if (name === "proposals") smLoadProposals();
  if (name === "board") smRenderBoard();
}
function smPopulateCrewDatalist(){
  var dl = smEl("dl-smCrew");
  if (!dl || dl.dataset.filled) return;
  var names = (typeof DPR_FOREMEN !== "undefined" && DPR_FOREMEN) ? DPR_FOREMEN.slice() : [];
  dl.innerHTML = names.map(function(n){ return '<option value="' + smEsc(n) + '"></option>'; }).join("");
  dl.dataset.filled = "1";
}
async function smRefreshWoIndex(){
  try { smWoIndex = (typeof cloudFetchIndex === "function") ? (await cloudFetchIndex()) : []; }
  catch (e) { smWoIndex = []; }
}

/* ============================== proposals ================================= */
async function smApi(body){
  var headers = (typeof authHeaders === "function") ? (await authHeaders()) : { "Content-Type": "application/json" };
  var r = await fetch("/.netlify/functions/contacts-sync", { method: "POST", headers: headers, body: JSON.stringify(body) });
  if (!r.ok){ var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function smLoadProposals(){
  var listEl = smEl("sm-proposals-list");
  if (!listEl) return;
  var src = getVal2("sm-proposal-source") || "Proposals";
  listEl.innerHTML = "Loading proposals…";
  try {
    var body = { action: "list_messages", pages: 3 };
    if (src === "sentitems") body.folderId = "sentitems"; else body.folderName = src;
    var data = await smApi(body);
    smProposals = data.rows || [];
    await smRefreshWoIndex();
    smRenderProposals();
  } catch (e) {
    var msg = e.status === 404 ? "No “Proposals” folder found in the mailbox. Create one in Outlook, switch to Sent Items, or use Upload PDF." :
              e.status === 403 ? "Your account doesn't have access to the shared mailbox. (Needs the same access as warranty reports.)" :
              e.status === 401 ? "Sign in with a manager account to load proposals." :
              "Couldn't load proposals" + (e.status ? " (" + e.status + ")" : "") + ".";
    listEl.innerHTML = '<span style="color:#b23">' + smEsc(msg) + "</span>";
  }
}
function smRenderProposals(){
  var listEl = smEl("sm-proposals-list");
  if (!listEl) return;
  if (!smProposals.length){ listEl.innerHTML = "No proposals found in this source."; return; }
  listEl.innerHTML = smProposals.map(function(p, i){
    var match = smWoExistsForProposal(p, smWoIndex);
    var flag = match
      ? '<span style="color:#178a1c;white-space:nowrap">✅ WO exists</span>'
      : '<span style="color:#b26a00;white-space:nowrap">⚠️ No WO yet</span>';
    var att = p.a ? " 📎" : "";
    var when = smFmtDate(p.d);
    return '<div class="card" style="margin:0 0 8px;padding:10px 12px">' +
      '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">' +
        "<b>" + smEsc(p.s || "(no subject)") + "</b>" + att +
        ' <span style="flex:1"></span> ' + flag +
      "</div>" +
      '<div class="hint" style="margin:2px 0 8px">' + smEsc(p.n || p.e || "") +
        (when ? (" · " + when) : "") +
        (match ? (" · looks like: " + smEsc(match.jobName || match.location || "")) : "") + "</div>" +
      '<div class="btnrow" style="margin:0">' +
        '<button class="btn primary" onclick="smPrecreateFromProposal(' + i + ')">➕ Create Work Order</button>' +
        (p.a ? '<button class="btn" onclick="smViewProposalPdf(' + i + ')">📄 View PDF</button>' : "") +
      "</div>" +
    "</div>";
  }).join("");
}
function smPrecreateFromProposal(i){
  var p = smProposals[i];
  if (!p) return;
  var src = getVal2("sm-proposal-source") || "Proposals";
  var ref = {
    source: src === "sentitems" ? "outlook-sent" : "outlook",
    messageId: p.id, subject: p.s || "", from: p.n || p.e || "", fromAddress: p.e || "",
    receivedDate: p.d || null, folder: src, hasAttachment: !!p.a
  };
  // Subject is usually the job/site; prefill it as the job name for the manager
  // to confirm, and drop it into scope as a starting point.
  smOpenPrecreate({ proposal: ref, jobName: (p.s || "").slice(0, 120), scope: p.s || "" });
}
async function smViewProposalPdf(i){
  var p = smProposals[i];
  if (!p) return;
  smToast("Fetching proposal…");
  try {
    var la = await smApi({ action: "attachments_list", messageId: p.id });
    var pdf = (la.attachments || []).find(function(a){ return /pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name || ""); }) || (la.attachments || [])[0];
    if (!pdf){ smToast("No attachment found on that email."); return; }
    var ga = await smApi({ action: "attachment_get", messageId: p.id, attachmentId: pdf.id });
    if (!ga.contentBytes){ smToast("Couldn't read the attachment bytes."); return; }
    smOpenBase64Pdf(ga.contentBytes, ga.contentType || "application/pdf");
  } catch (e) { smToast("Couldn't fetch the proposal PDF" + (e.status ? " (" + e.status + ")" : "") + "."); }
}
function smOpenBase64Pdf(b64, type){
  try {
    var bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    var blob = new Blob([arr], { type: type || "application/pdf" });
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  } catch (e) { smToast("Couldn't open the PDF in this browser."); }
}
function smUploadProposal(inputEl){
  var f = inputEl && inputEl.files && inputEl.files[0];
  if (inputEl) inputEl.value = "";
  if (!f) return;
  if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)){ smToast("Please choose a PDF file."); return; }
  var reader = new FileReader();
  reader.onload = function(){
    var dataUrl = String(reader.result || "");
    var b64 = dataUrl.indexOf(",") >= 0 ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
    var upload = { fileName: f.name, contentType: "application/pdf", size: f.size };
    // Inline the bytes only when they comfortably fit a Firestore field (the WO
    // doc holds much else). Larger PDFs attach by metadata only — keep the file
    // in Outlook/Drive. Storage-backed uploads are a flagged follow-up (dev has
    // no Storage bucket).
    if (f.size <= 300 * 1024) upload.contentBytes = b64;
    else smToast("PDF is " + Math.round(f.size / 1024) + "KB — attached by name only (Storage-backed uploads are a fast follow).");
    var ref = { source: "upload", fileName: f.name, subject: f.name, upload: upload };
    smOpenPrecreate({ proposal: ref, jobName: "", scope: "" });
  };
  reader.readAsDataURL(f);
}
/* Best-effort "does a WO already exist for this proposal" — matches the
 * proposal's subject/sender text against recent saved WOs by job name or by the
 * house-number+street of their address (reusing the Foundation address key so
 * "100 N Main" never matches "100 Main"). Deliberately conservative: a hit is a
 * hint the manager confirms, never an assertion. */
function smWoExistsForProposal(p, index){
  index = index || [];
  var hay = smNorm((p.s || p.subject || "") + " " + (p.n || "") + " " + (p.e || p.from || ""));
  if (!hay) return null;
  for (var i = 0; i < index.length; i++){
    var w = index[i];
    var jn = smNorm(w.jobName);
    if (jn && jn.length >= 4 && hay.indexOf(jn) !== -1) return w;
    var addrKey = (typeof fdnAddressMatchKey === "function") ? fdnAddressMatchKey(w.location) : "";
    var seg = addrKey ? addrKey.split("|")[0] : "";
    if (seg && seg.length >= 5 && hay.indexOf(seg) !== -1) return w;
  }
  return null;
}

/* ======================= Foundation cross-reference ======================
 * Reuses js/foundation.js's matching helpers (fdnAddressMatchKey /
 * fdnComposeAddress / fdnNormalizeText) — address-first, exact/unique only,
 * name-equality fallback, and it REFUSES to guess on ambiguity (>1 match), the
 * same doctrine as fdnFindMatchingBuilding(). Matches a proposal's address/name
 * against the Foundation jobs cache (fdnCache), rather than app buildings. */
function smFindFoundationJob(loc, name, jobs){
  var cache = jobs || ((typeof fdnCache !== "undefined" && fdnCache) ? fdnCache : null);
  if (!cache || !cache.length) return null;
  if (typeof fdnAddressMatchKey === "function" && typeof fdnComposeAddress === "function"){
    var key = fdnAddressMatchKey(loc);
    if (key){
      var am = cache.filter(function(j){ return fdnAddressMatchKey(fdnComposeAddress(j)) === key; });
      if (am.length === 1) return am[0];
      if (am.length > 1) return null; // ambiguous → refuse to guess
    }
  }
  var nm = smNorm(name);
  if (!nm) return null;
  var nameMatches = cache.filter(function(j){ return smNorm(j.name) === nm; });
  return nameMatches.length === 1 ? nameMatches[0] : null;
}
async function smMatchFoundationFromForm(){
  var el = smEl("sm-pc-foundation");
  var loc = getVal2("sm-pc-location"), name = getVal2("sm-pc-jobName");
  if (el) el.innerHTML = "Searching Foundation…";
  try { if (typeof fdnLoadJobs === "function") await fdnLoadJobs(false); } catch (e) {}
  var job = smFindFoundationJob(loc, name);
  smFoundationPick = job;
  if (!el) return;
  if (job){
    el.innerHTML = "✅ <b>" + smEsc(job.name || job.job_no) + "</b> — job #" + smEsc(job.job_number || job.job_no) +
      (job.customer_no ? (" · cust " + smEsc(job.customer_no)) : "") +
      ' <button class="btn" type="button" style="margin-left:8px" onclick="smClearFoundationPick()">✕ unlink</button>';
    if (!getVal2("sm-pc-jobName")) setVal2("sm-pc-jobName", job.name || "");
    if (!getVal2("sm-pc-location") && typeof fdnComposeAddress === "function") setVal2("sm-pc-location", fdnComposeAddress(job));
    if (!getVal2("sm-pc-billTo") && job.customer_no) setVal2("sm-pc-billTo", job.customer_no);
  } else {
    el.innerHTML = "⚠️ No confident Foundation match by address or name — it stays unlinked. You can still create the WO and link it later.";
  }
}
function smClearFoundationPick(){
  smFoundationPick = null;
  var el = smEl("sm-pc-foundation");
  if (el) el.innerHTML = "Not linked. Cross-reference to bind the real job number.";
}

/* ========================= pre-create a work order ======================= */
function smOpenPrecreate(seed){
  seed = seed || {};
  smCurrentProposal = seed.proposal || null;
  smFoundationPick = null;
  var sel = smEl("sm-pc-woType");
  if (sel){
    var types = (typeof WORK_ORDER_TYPES !== "undefined" && WORK_ORDER_TYPES) ? WORK_ORDER_TYPES : ["Repair"];
    sel.innerHTML = types.map(function(t){
      return '<option value="' + smEsc(t) + '"' + (t === "Repair" ? " selected" : "") + ">" + smEsc(t) + "</option>";
    }).join("");
  }
  setVal2("sm-pc-date", smTodayStr());
  setVal2("sm-pc-billTo", seed.billTo || "");
  setVal2("sm-pc-jobName", seed.jobName || "");
  setVal2("sm-pc-location", seed.location || "");
  setVal2("sm-pc-scope", seed.scope || "");
  setVal2("sm-pc-crew", seed.crew || "");
  var banner = smEl("sm-precreate-proposal");
  if (banner){
    if (smCurrentProposal){
      banner.style.display = "";
      banner.innerHTML = "📨 From proposal: <b>" + smEsc(smCurrentProposal.subject || smCurrentProposal.fileName || "(proposal)") + "</b>" +
        (smCurrentProposal.from ? (' <span class="hint">— ' + smEsc(smCurrentProposal.from) + "</span>") : "") +
        (smCurrentProposal.source === "upload" ? ' <span class="hint">(uploaded PDF)</span>' : "");
    } else { banner.style.display = "none"; banner.innerHTML = ""; }
  }
  smClearFoundationPick();
  smMaybeShowAiPrefill();
  var modal = smEl("sm-precreate-modal");
  if (modal) modal.style.display = "";
}
function smClosePrecreate(){ var m = smEl("sm-precreate-modal"); if (m) m.style.display = "none"; }
async function smSubmitPrecreate(){
  var date = getVal2("sm-pc-date") || smTodayStr();
  var crew = (getVal2("sm-pc-crew") || "").trim();
  var data = {
    woType: getVal2("sm-pc-woType") || "Repair",
    dispatchDate: date,
    serviceDate: smYmdToMdy(date),
    billTo: (getVal2("sm-pc-billTo") || "").trim(),
    jobName: (getVal2("sm-pc-jobName") || "").trim(),
    location: (getVal2("sm-pc-location") || "").trim(),
    scope: (getVal2("sm-pc-scope") || "").trim(),
    crew: crew,
    proposal: smCurrentProposal,
    foundation: smFoundationPick
  };
  if (!data.jobName && !data.location){ smToast("Add at least a job name or an address."); return; }
  smToast("Creating work order…");
  try {
    await smSaveNewWorkOrder(data);
    smClosePrecreate();
    smToast("Work order created" + (crew ? (" — assigned to " + crew) : "") + " ✓");
    if (smSection === "board") smRenderBoard();
    smRefreshWoIndex();
  } catch (e) {
    smToast("Couldn't save the work order: " + (e && e.message ? e.message : "unknown error"));
  }
}
/* Builds a fresh WO object and writes it through the SAME cloud path the edit
 * form uses (ensureCustomerAndBuilding → cloudSaveOrder → building-history),
 * plus the local-cache bookkeeping saveOrder() does, so it shows in Saved and
 * on the timeline immediately. Kept self-contained (no edit-form DOM) so the
 * pre-create flow doesn't disturb whatever WO is open in the editor. */
async function smSaveNewWorkOrder(data){
  if (typeof fdb === "undefined" || !fdb) throw new Error("cloud not available");
  var now = Date.now();
  var by = smCurrentUserLabel();
  var f = data.foundation || null;
  var o = {
    id: "wo_" + now,
    woType: data.woType || "Repair",
    serviceDate: data.serviceDate || ((typeof todayStr === "function") ? todayStr() : ""),
    jobName: data.jobName || "", location: data.location || "", suite: "",
    jobNo: (f && (f.job_number || f.job_no)) || "",
    projectManager: (f && f.project_manager_no) || "",
    billTo: data.billTo || (f && f.customer_no) || "",
    billContact: "", billPhone: "", siteContact: "", technician: "",
    roofSystem: "", reportedArea: "", warrantable: "", nonWarrantable: "", summary: "",
    woCost: "", woManHours: "", woMaterials: "", woDescription: "", woPONumber: "", woDateCompleted: "",
    repairDescription: data.scope || "", mfgServiceNo: "",
    findings: [], repairs: [], repairItems: [], materials: [], inspectionChecklist: [], photos: [],
    companyCamProjectId: null, companyCamProjectName: "",
    buildingId: null, customerId: null, ccDocumentId: null, ccDocumentHash: null,
    foundationJobNo: f ? f.job_no : null,
    foundationJobName: f ? (f.name || "") : "",
    foundationCustomerNo: f ? (f.customer_no || null) : null,
    foundationAddress: (f && typeof fdnComposeAddress === "function") ? fdnComposeAddress(f) : "",
    roofId: null, roofIds: null, roofLabels: null, changeOrderSignature: null,
    dispatch: data.crew ? {
      crew: data.crew, date: data.dispatchDate || smTodayStr(), status: "assigned",
      assignedAt: now, assignedBy: by, clearedAt: null, clearedBy: null
    } : null,
    proposal: data.proposal || null,
    _cloudBaseSavedAt: 0 // brand-new order — nothing to clobber
  };
  try {
    if (typeof ensureCustomerAndBuilding === "function"){
      var ids = await ensureCustomerAndBuilding(o);
      if (ids && ids.buildingId) o.buildingId = ids.buildingId;
      if (ids && ids.customerId) o.customerId = ids.customerId;
    }
  } catch (e) { /* non-fatal, same as saveOrder() */ }
  await cloudSaveOrder(o);
  try {
    if (typeof loadDb === "function" && typeof saveDb === "function"){
      var db = loadDb();
      db.orders[o.id] = o;
      db.index = db.index.filter(function(e){ return e.id !== o.id; });
      db.index.unshift({ id: o.id, jobName: o.jobName || "(untitled)", jobNo: o.jobNo, location: o.location, serviceDate: o.serviceDate, savedAt: Date.now() });
      saveDb(db);
      if (typeof drawSaved === "function") drawSaved();
    }
  } catch (e) {}
  try { if (typeof logReportAndHistoryEvent === "function") await logReportAndHistoryEvent(o, "Saved", null, undefined); } catch (e) {}
  return o;
}

/* ---- AI scope-prefill (wired in Phase 2). In Phase 1 the button stays hidden
 *      (the endpoint doesn't exist yet); Phase 2 replaces this with a capability
 *      probe that reveals it only on a keyed deploy. ---- */
function smMaybeShowAiPrefill(){
  var row = smEl("sm-pc-ai-row");
  if (row) row.style.display = "none"; // Phase 2 flips this on a keyed deploy
}
function smAiPrefillScope(){ smToast("AI scope draft arrives in the next update."); }

/* ============================ dispatch board ============================= */
/* Pure grouping: assigned WOs bucketed by crew, cleared/undispatched excluded,
 * crews alphabetical. Exercised by tests. */
function smGroupBoard(wos){
  var groups = {};
  (wos || []).forEach(function(w){
    var d = w && w.dispatch;
    if (!d || d.status !== "assigned") return;
    var crew = d.crew || "(unassigned crew)";
    (groups[crew] = groups[crew] || []).push(w);
  });
  return Object.keys(groups).sort().map(function(c){ return { crew: c, items: groups[c] }; });
}
async function smRenderBoard(){
  var el = smEl("sm-board");
  if (!el) return;
  var date = getVal2("sm-board-date") || smTodayStr();
  if (typeof fdb === "undefined" || !fdb){ el.innerHTML = "Cloud not available."; return; }
  el.innerHTML = "Loading board…";
  try {
    var qs = await fdb.collection("workorders").where("dispatch.date", "==", date).get();
    var wos = [];
    qs.forEach(function(d){ var v = d.data(); v.id = d.id; wos.push(v); });
    var groups = smGroupBoard(wos);
    if (!groups.length){
      el.innerHTML = '<p class="hint">No work orders assigned for ' + smEsc(date) + ". Use ➕ New Work Order or 📋 Assign Existing.</p>";
      return;
    }
    el.innerHTML = '<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:6px">' +
      groups.map(smRenderBoardColumn).join("") + "</div>";
  } catch (e) {
    var idxHint = (e && (e.code === "failed-precondition" || /index/i.test(e.message || ""))) ? " (Firestore may need a single-field index on dispatch.date)" : "";
    el.innerHTML = '<span style="color:#b23">Couldn\'t load the board' + idxHint + ".</span>";
  }
}
function smRenderBoardColumn(g){
  var enc = encodeURIComponent(g.crew);
  return '<div class="card" style="min-width:260px;max-width:300px;flex:0 0 auto;background:#F7F9FB">' +
    '<div style="display:flex;align-items:center;gap:6px;margin:0 0 8px"><b>👷 ' + smEsc(g.crew) + "</b>" +
      '<span class="hint">(' + g.items.length + ")</span></div>" +
    g.items.map(smRenderBoardCard).join("") +
    '<button class="btn" style="width:100%;margin-top:4px" onclick="smAddToCrew(\'' + enc + '\')">＋ Add work order</button>' +
  "</div>";
}
function smRenderBoardCard(w){
  var loc = w.location || "", scope = w.repairDescription || w.reportedArea || "";
  return '<div class="card" style="margin:0 0 8px;padding:8px 10px;background:#fff">' +
    "<b>" + smEsc(w.jobName || "(untitled)") + "</b>" +
    (loc ? ('<div class="hint">' + smEsc(loc) + "</div>") : "") +
    (scope ? ('<div style="font-size:12px;margin:4px 0">' + smEsc(String(scope).slice(0, 140)) + "</div>") : "") +
    (w.foundationJobNo ? ('<div class="hint">🏗️ job #' + smEsc(w.foundationJobNo) + "</div>") : "") +
    '<div class="btnrow" style="margin:6px 0 0">' +
      '<button class="btn" onclick="smOpenWorkOrder(\'' + smEsc(w.id) + '\')">Open</button>' +
      '<button class="btn primary" onclick="smClearWorkOrder(\'' + smEsc(w.id) + '\')" title="Mark done — drops off the board">✓ Clear</button>' +
    "</div>" +
  "</div>";
}
function smBoardSetDay(n){ setVal2("sm-board-date", smDayOffsetStr(n)); smRenderBoard(); }
function smAddToCrew(enc){
  var crew = "";
  try { crew = decodeURIComponent(enc); } catch (e) { crew = enc; }
  smOpenPrecreate({ crew: crew });
  var d = getVal2("sm-board-date");
  if (d) setVal2("sm-pc-date", d);
}
function smOpenWorkOrder(id){ if (typeof loadOrder === "function") loadOrder(id); }

/* Targeted dispatch write: only the provided keys, plus a savedAt bump so a
 * concurrent stale edit-form save trips the multi-device clobber guard rather
 * than silently reverting the assignment/clear. */
async function smUpdateDispatch(id, dispatch){
  if (typeof fdb === "undefined" || !fdb) throw new Error("cloud not available");
  var patch = { savedAt: Date.now() };
  ["crew", "date", "status", "assignedAt", "assignedBy", "clearedAt", "clearedBy"].forEach(function(k){
    if (dispatch[k] !== undefined) patch["dispatch." + k] = dispatch[k];
  });
  await fdb.collection("workorders").doc(id).update(patch);
}
async function smClearWorkOrder(id){
  try {
    await smUpdateDispatch(id, { status: "cleared", clearedAt: Date.now(), clearedBy: smCurrentUserLabel() });
    smToast("Cleared ✓");
    smRenderBoard();
    smRefreshWoIndex();
  } catch (e) { smToast("Couldn't clear that work order: " + (e && e.message ? e.message : "error")); }
}

/* ---- assign an already-saved work order to a crew/day ---- */
function smOpenAssignExisting(){
  setVal2("sm-assign-date", getVal2("sm-board-date") || smTodayStr());
  setVal2("sm-assign-crew", "");
  setVal2("sm-assign-search", "");
  var m = smEl("sm-assign-modal");
  if (m) m.style.display = "";
  smRefreshWoIndex().then(smRenderAssignList);
}
function smCloseAssignExisting(){ var m = smEl("sm-assign-modal"); if (m) m.style.display = "none"; }
function smRenderAssignList(){
  var el = smEl("sm-assign-list");
  if (!el) return;
  var q = smNorm(getVal2("sm-assign-search") || "");
  var rows = (smWoIndex || []).filter(function(w){
    if (!q) return true;
    return smNorm((w.jobName || "") + " " + (w.location || "") + " " + (w.jobNo || "")).indexOf(q) !== -1;
  }).slice(0, 50);
  if (!rows.length){ el.innerHTML = "No matching saved work orders."; return; }
  el.innerHTML = rows.map(function(w){
    return '<div class="card" style="margin:0 0 6px;padding:8px 10px;display:flex;gap:8px;align-items:center">' +
      '<div style="flex:1"><b>' + smEsc(w.jobName || "(untitled)") + "</b>" +
        '<div class="hint">' + smEsc(w.location || "") + (w.jobNo ? (" · #" + smEsc(w.jobNo)) : "") + "</div></div>" +
      '<button class="btn primary" onclick="smAssignExisting(\'' + smEsc(w.id) + '\')">Assign</button>' +
    "</div>";
  }).join("");
}
async function smAssignExisting(id){
  var crew = (getVal2("sm-assign-crew") || "").trim();
  var date = getVal2("sm-assign-date") || smTodayStr();
  if (!crew){ smToast("Pick a crew (foreman) first."); return; }
  try {
    await smUpdateDispatch(id, { crew: crew, date: date, status: "assigned", assignedAt: Date.now(), assignedBy: smCurrentUserLabel() });
    smToast("Assigned to " + crew + " ✓");
    smCloseAssignExisting();
    if (smSection === "board") smRenderBoard();
  } catch (e) { smToast("Couldn't assign: " + (e && e.message ? e.message : "error")); }
}

/* Node/test export — the browser ignores this (no `module`). Lets
 * tests/serviceManager.test.js require the pure helpers directly in addition to
 * the vm-based load. */
if (typeof module !== "undefined" && module.exports){
  module.exports = {
    smFindFoundationJob: smFindFoundationJob,
    smWoExistsForProposal: smWoExistsForProposal,
    smGroupBoard: smGroupBoard,
    smYmdToMdy: smYmdToMdy,
    smLocalYmd: smLocalYmd,
    smNorm: smNorm
  };
}
