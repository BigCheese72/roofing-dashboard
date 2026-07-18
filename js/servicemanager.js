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
var smJobNameFromProposal = false; // job-name field still holds the proposal subject (not hand-typed)
var smFdnLoadFailed = false;     // a Foundation jobs load rejected this session
var smCcPick = null;             // { id, name } CompanyCam project linked/created for this pre-create

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
    var rows = data.rows || [];   // capture ONCE — `data.rows || []` allocates a
    smProposals = rows;           // fresh array each time, so the identity guard
    await smRefreshWoIndex();     // below would never hold.
    smRenderProposals();
    // The Foundation jobs cache is primed in parallel (smOnShow → fdnPrimePicker)
    // and usually loses this race, so re-render once it lands — otherwise every
    // row keeps claiming "no Foundation job matched" on a cold open. Re-render
    // on FAILURE too, so the row line moves off "Checking…" either way.
    if (typeof fdnLoadJobs === "function" && smFdnCacheStatus() === "loading"){
      fdnLoadJobs(false).then(function(){
        if (smProposals === rows) smRenderProposals();
      }).catch(function(){
        smFdnLoadFailed = true;
        if (smProposals === rows) smRenderProposals();
      });
    }
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
    // Show the Foundation cross-reference RIGHT HERE, before anything is
    // clicked — "why didn't it link" should be answerable at a glance. If the
    // jobs cache hasn't landed yet, say "checking" rather than asserting a
    // no-match we haven't actually tested (smRenderProposals re-runs when the
    // cache arrives — see smLoadProposals).
    var fdnState = smFdnCacheStatus();
    var fdnJob = (fdnState === "ready") ? smFindFoundationJob("", p.s || "") : null;
    var fdnLine =
      fdnState === "loading" ? '<div class="hint" style="margin:0 0 8px">🏗️ Checking Foundation jobs…</div>' :
      fdnState === "empty"   ? '<div class="hint" style="margin:0 0 8px">🏗️ No Foundation jobs are cached yet — an admin can run a sync.</div>' :
      fdnState === "error"   ? '<div class="hint" style="margin:0 0 8px">🏗️ Couldn\'t load the Foundation job list — you can still link a job by hand on the work order.</div>' :
      fdnJob
        ? '<div class="hint" style="margin:0 0 8px;color:#178a1c">🏗️ Foundation job #' + smEsc(fdnJob.job_no) +
            " — " + smEsc(fdnJob.name || "") + "</div>"
        : '<div class="hint" style="margin:0 0 8px">🏗️ No Foundation job matched from the subject — you can link one when you create the work order.</div>';
    return '<div class="card" style="margin:0 0 8px;padding:10px 12px">' +
      '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">' +
        "<b>" + smEsc(p.s || "(no subject)") + "</b>" + att +
        ' <span style="flex:1"></span> ' + flag +
      "</div>" +
      '<div class="hint" style="margin:2px 0 4px">' + smEsc(p.n || p.e || "") +
        (when ? (" · " + when) : "") +
        (match ? (" · looks like: " + smEsc(match.jobName || match.location || "")) : "") + "</div>" +
      fdnLine +
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
 * fdnComposeAddress / fdnNormalizeText) — address-first, exact/unique only, and
 * it REFUSES to guess on ambiguity (>1 match), the same doctrine as
 * fdnFindMatchingBuilding(). Matches a proposal against the Foundation jobs
 * cache (fdnCache), rather than app buildings.
 *
 * WHY TIER 3 EXISTS (Mark, 2026-07-18 — "I see the proposal, why didn't it link
 * to it"): an emailed proposal carries NO address (contacts-sync list_messages
 * returns id/subject/sender/date/hasAttachments only), so the address tier can
 * never fire from a proposal. That left exact name-equality as the only path —
 * and the "name" we feed it is the EMAIL SUBJECT ("Prairie Farms – roof repair
 * proposal"), which never equals the Foundation job name ("Prairie Farms").
 * Tier 3 matches the job name as a whole-token run INSIDE that subject, which
 * is how a real proposal actually names its site.
 *
 * Note the customer is deliberately NOT a match key: Foundation's customer for
 * job 17456 is "ACME" while the site everyone says out loud is "Prairie Farms".
 * The job/site NAME and the address are the human-stable identifiers. */

/* Words that describe WORK rather than a SITE. A job named "Roof Replacement"
 * must never become a containment key — it would swallow half of Nathan's
 * subject lines. Null-prototype so inherited Object keys ("constructor") can't
 * read as generic. */
var SM_GENERIC_NAME_WORDS = Object.create(null);
// NOTE the parens: `.split()` binds tighter than `+`, so without them only the
// LAST literal would be split and the rest of the list silently dropped.
("roof roofs roofing repair repairs replacement replace reroof recover coating coat " +
 "proposal quote estimate bid service call job jobs work works project building bldg " +
 "warranty inspection inspect leak leaks maintenance punch list tear off emergency " +
 "annual new phase area section unit misc general").split(" ").forEach(function(w){
  SM_GENERIC_NAME_WORDS[w] = 1;
});

/* smNorm() is regex-heavy and tier 3 runs it across the whole cache for every
 * proposal row, so memoize per job object (S1: 50 rows × 5000 jobs measured
 * 463ms before this). The property is non-enumerable so it never rides along
 * into a Firestore write. */
function smJobNameNorm(j){
  if (!j) return "";
  if (typeof j._smNameNorm === "string") return j._smNameNorm;
  var v = smNorm(j.name);
  try { Object.defineProperty(j, "_smNameNorm", { value: v, enumerable: false, configurable: true }); }
  catch (e) { /* frozen/sealed job object — just recompute next time */ }
  return v;
}

/* A Foundation job name may serve as a containment key only if what's LEFT
 * after removing work-words still identifies a place: at least two such tokens.
 * "Prairie Farms" → [prairie, farms] ✓. "Roof Replacement" → [replacement] ✗.
 * "Columbia" → [columbia] ✗ (one word is not a site — it links "Columbia MO
 * warehouse proposal" to the wrong job; the manual picker covers those). */
function smNameIsDistinctive(nameNorm){
  if (!nameNorm) return false;
  var specific = nameNorm.split(" ").filter(function(t){
    // Bare numerals and single letters are sequence markers, not place names —
    // without this, "Roof Area 2 Section 3" and "Unit 5 Bldg 7" qualify on
    // their digits alone once the work-words are stripped.
    if (!t || t.length < 2 || /^\d+$/.test(t)) return false;
    return !SM_GENERIC_NAME_WORDS[t];
  });
  return specific.length >= 2;
}
/* Whole-token containment: smNorm() collapses to single-spaced tokens, so
 * padding both sides makes indexOf a token-boundary test ("prairie farms"
 * matches "... prairie farms ..." but "farm" never matches "farms"). */
function smContainsTokens(hayNorm, needleNorm){
  if (!hayNorm || !needleNorm) return false;
  return (" " + hayNorm + " ").indexOf(" " + needleNorm + " ") !== -1;
}

/* Full matcher. Returns { job, via } where `via` is "address" | "name" |
 * "subject" | null, so the UI can say HOW it matched (a subject-containment hit
 * is worth showing as such). smFindFoundationJob() is the thin job-only wrapper
 * everything else uses. */
function smFindFoundationJobDetailed(loc, name, jobs){
  var miss = { job: null, via: null };
  var cache = jobs || ((typeof fdnCache !== "undefined" && fdnCache) ? fdnCache : null);
  if (!cache || !cache.length) return miss;
  // Tier 1 — address. Strongest signal, but only available when the manager
  // typed/pasted one (a proposal email never carries it).
  if (typeof fdnAddressMatchKey === "function" && typeof fdnComposeAddress === "function"){
    var key = fdnAddressMatchKey(loc);
    if (key){
      var am = cache.filter(function(j){ return fdnAddressMatchKey(fdnComposeAddress(j)) === key; });
      if (am.length === 1) return { job: am[0], via: "address" };
      if (am.length > 1) return miss; // ambiguous → refuse to guess
    }
  }
  var nm = smNorm(name);
  if (!nm) return miss;
  // Tier 2 — exact name equality (the manager typed the job name verbatim).
  var exact = cache.filter(function(j){ return smJobNameNorm(j) === nm; });
  if (exact.length === 1) return { job: exact[0], via: "name" };
  if (exact.length > 1) return miss; // ambiguous → refuse to guess
  // Tier 3 — job name appearing inside the text (an email subject).
  var contained = cache.filter(function(j){
    var jn = smJobNameNorm(j);
    return smNameIsDistinctive(jn) && smContainsTokens(nm, jn);
  });
  if (!contained.length) return miss;
  // Longest-wins is only legitimate for NESTED candidates — "Flat Branch Pub
  // Annex" genuinely refines "Flat Branch Pub". Two DISJOINT sites named in one
  // subject ("Prairie Farms and North Terminal") is real ambiguity, and picking
  // whichever name happens to be longer would be arbitrary. So: take the
  // longest, then require every rival to be contained within it.
  var winner = contained.reduce(function(a, b){
    return smJobNameNorm(b).length > smJobNameNorm(a).length ? b : a;
  });
  var wn = smJobNameNorm(winner);
  // Two DIFFERENT jobs carrying the SAME name (a repeat customer, a job per
  // building per year) is ambiguity, not nesting — a string contains itself, so
  // without this the winner is decided by cache order and the WO silently binds
  // to whichever job happened to sort first. Tier 2 already refuses this; tier 3
  // must too, and it's the only tier an emailed proposal can reach.
  var sameName = contained.filter(function(j){ return smJobNameNorm(j) === wn; });
  if (sameName.length > 1) return miss;
  var allNested = contained.every(function(j){
    return j === winner || smContainsTokens(wn, smJobNameNorm(j));
  });
  return allNested ? { job: winner, via: "subject" } : miss;
}
function smFindFoundationJob(loc, name, jobs){
  return smFindFoundationJobDetailed(loc, name, jobs).job;
}

/* Which of the four states the jobs cache is in. "loading" and "empty" look
 * identical through a truthiness check but mean opposite things to a manager:
 * one resolves itself, the other needs an admin to run a sync. fdnLoadJobs()
 * also caches [] permanently for the session, so "empty" never self-clears. */
function smFdnCacheStatus(){
  var loaded = (typeof fdnCache !== "undefined" && fdnCache);
  if (loaded) return fdnCache.length ? "ready" : "empty";
  return smFdnLoadFailed ? "error" : "loading";
}

/* Ranked "did you mean" candidates for the picker and the no-match UI. Scores
 * by how much of the job's name is present in the text, so an ambiguous or
 * failed auto-match still puts the right job one tap away rather than making
 * Mark scroll 500 jobs. Pure — tested directly. */
function smRankFoundationJobs(text, jobs, limit){
  var cache = jobs || ((typeof fdnCache !== "undefined" && fdnCache) ? fdnCache : null);
  var hay = smNorm(text);
  if (!cache || !cache.length || !hay) return [];
  var hayToks = Object.create(null); // null-proto: "constructor" must not read as present
  hay.split(" ").filter(Boolean).forEach(function(t){ hayToks[t] = 1; });
  var scored = [];
  cache.forEach(function(j){
    var jn = smJobNameNorm(j);
    if (!jn) return;
    var toks = jn.split(" ").filter(Boolean);
    if (!toks.length) return;
    var hits = toks.filter(function(t){ return hayToks[t] && !SM_GENERIC_NAME_WORDS[t]; }).length;
    if (!hits) return;
    // Whole-name containment is a materially stronger signal than loose token
    // overlap, so it outranks any partial hit.
    var score = (hits / toks.length) + (smContainsTokens(hay, jn) ? 1 : 0);
    scored.push({ job: j, score: score });
  });
  scored.sort(function(a, b){
    if (b.score !== a.score) return b.score - a.score;
    return smJobNameNorm(b.job).length - smJobNameNorm(a.job).length;
  });
  return scored.slice(0, limit || 5).map(function(s){ return s.job; });
}

/* The text we match a proposal against: whatever's in the job-name field PLUS
 * the proposal subject (the field may hold a truncated/edited subject, and the
 * site name can sit in either). Deduped — on a fresh proposal the two are the
 * same string, and doubling it only creates a bogus token junction. */
/* The candidate texts to match against, MOST AUTHORITATIVE FIRST — tried one at
 * a time, never concatenated. Concatenating a hand-typed correction onto the
 * subject made things worse two ways: "North Terminal" + a Prairie Farms
 * subject became two disjoint candidates (→ refused, so typing the right name
 * broke matching), and the field/subject seam could fabricate a token run that
 * matches a third job outright. */
function smFoundationMatchTexts(){
  var name = getVal2("sm-pc-jobName");
  var subj = (smCurrentProposal && smCurrentProposal.subject) || "";
  var out = [];
  // A name the manager typed themselves outranks the email subject.
  if (name && !smJobNameFromProposal) out.push(name);
  if (subj) out.push(subj);
  if (name && out.indexOf(name) === -1) out.push(name);
  return out;
}
/* Single best text for RANKING and for seeding the picker's search box. After a
 * match has overwritten the job-name field, the proposal subject is the more
 * useful basis — otherwise "change" opens pre-filtered to the very job you're
 * trying to correct. */
function smFoundationSearchText(){
  var subj = (smCurrentProposal && smCurrentProposal.subject) || "";
  if (subj) return subj;
  return getVal2("sm-pc-jobName");
}
/* Guards the fire-and-forget match against a stale resolve. fdnLoadJobs() can
 * be a cold 5000-doc Firestore read; without this, closing proposal A's form
 * and opening B's lets A's in-flight match paint job A onto B and ship a WO
 * cross-referenced to the wrong accounting job. */
/* Two counters, not one: the picker and the auto-match run concurrently, and a
 * shared counter let either cancel the other's render — leaving an open picker
 * stuck on "Loading jobs…". */
var smFdnMatchSeq = 0;
var smFdnPickerSeq = 0;
async function smMatchFoundationFromForm(silentOnMiss){
  var el = smEl("sm-pc-foundation");
  var loc = getVal2("sm-pc-location");
  var texts = smFoundationMatchTexts();
  var seq = ++smFdnMatchSeq;
  var forProposal = smCurrentProposal;
  // Nothing to go on at all (blank New Work Order, nothing typed) — say so
  // rather than reporting a "no match" we never actually looked for.
  if (!loc && !texts.length){
    if (el) el.innerHTML = "Add a job name or an address first, or " +
      '<button class="btn" type="button" onclick="smOpenFoundationPicker()">🔗 link a Foundation job</button>.';
    return;
  }
  if (el) el.innerHTML = "Searching Foundation…";
  // A failure here must be recorded, not just swallowed: if the auto-match is
  // the first loader to fail, the proposal rows would otherwise sit on
  // "Checking Foundation jobs…" forever (the REQUIRED-4 symptom by another path).
  try { if (typeof fdnLoadJobs === "function") await fdnLoadJobs(false); }
  catch (e) { smFdnLoadFailed = true; }
  // The form moved on while we were away — drop this result on the floor.
  if (seq !== smFdnMatchSeq || smCurrentProposal !== forProposal) return;
  // Address first (it doesn't depend on any text), then each candidate text in
  // priority order; the first confident hit wins.
  var found = smFindFoundationJobDetailed(loc, "");
  for (var ti = 0; !found.job && ti < texts.length; ti++){
    found = smFindFoundationJobDetailed(loc, texts[ti]);
  }
  if (found.job){ smApplyFoundationPick(found.job, found.via); return; }
  smFoundationPick = null;
  el = smEl("sm-pc-foundation");
  if (!el) return;
  // No confident match — offer the near misses as one-tap links plus a full
  // search, so "it didn't link" is never a dead end.
  var near = smRankFoundationJobs(smFoundationSearchText(), null, 3);
  el.innerHTML = "⚠️ No confident Foundation match" + (silentOnMiss ? " from the proposal" : " by address or name") +
    " — it stays unlinked." +
    (near.length ? ('<div style="margin:6px 0 0">Did you mean: ' + near.map(function(j){
      return '<button class="btn" type="button" style="margin:2px 4px 0 0" onclick="smPickFoundationJob(' +
        smEsc(JSON.stringify(String(j.job_no))) + ')">' +
        smEsc(j.name || j.job_no) + ' <span class="hint">#' + smEsc(j.job_no) + "</span></button>";
    }).join("") + "</div>") : "") +
    '<div style="margin:6px 0 0"><button class="btn" type="button" onclick="smOpenFoundationPicker()">🔗 Search all Foundation jobs</button></div>';
}
/* Bind the picked job onto the form. JOB-CENTRIC: the Foundation job name and
 * address become the WO's identity (that's what makes buildingId resolve to the
 * same building next time), so an auto-filled proposal SUBJECT is replaced by
 * the real job name — but a name the manager typed themselves is never
 * overwritten (smJobNameFromProposal tracks which it is). */
/* `via` is "address" | "name" | "subject" for an automatic match, or "manual"
 * when the manager picked from the list. A MANUAL pick is always authoritative:
 * it overwrites the job name even if an earlier (wrong) auto-match already
 * stamped one, otherwise "change" could leave the WO carrying job 17456 under
 * the name of a different job — exactly the identity split this binding
 * exists to prevent. */
function smApplyFoundationPick(job, via){
  smFoundationPick = job || null;
  if (!job){ smClearFoundationPick(); return; }
  var manual = (via === "manual");
  // On a manual pick the name is written UNCONDITIONALLY — including to "" for
  // a job with no name. Skipping the write there would leave the previously
  // matched job's NAME sitting above the newly picked job's NUMBER, which is
  // the identity split this binding exists to prevent, and the manager has
  // every reason to believe they just corrected it.
  if (manual || (job.name && (smJobNameFromProposal || !getVal2("sm-pc-jobName")))){
    setVal2("sm-pc-jobName", job.name || "");
    smJobNameFromProposal = false;
  }
  // A manual correction re-points the SITE, so address and customer follow it
  // the same way the name does — including to empty. Keeping the previous job's
  // address here would be worse than a stale name: smSubmitPrecreate persists
  // `location` onto the WO and ensureCustomerAndBuilding() resolves the
  // BUILDING from it, so the WO would carry job B's number while anchored to
  // job A's building and billed to job A's customer.
  if (typeof fdnComposeAddress === "function"){
    var addr = fdnComposeAddress(job) || "";
    if (manual || (addr && !getVal2("sm-pc-location"))) setVal2("sm-pc-location", addr);
  }
  if (manual || (job.customer_no && !getVal2("sm-pc-billTo"))) setVal2("sm-pc-billTo", job.customer_no || "");
  var how = via === "address" ? "matched on address"
          : via === "name" ? "matched on job name"
          : via === "subject" ? "matched from the proposal subject"
          : "";
  var el = smEl("sm-pc-foundation");
  if (el){
    el.innerHTML = "✅ <b>" + smEsc(job.name || job.job_no) + "</b> — job #" + smEsc(job.job_number || job.job_no) +
      (job.customer_no ? (" · cust " + smEsc(job.customer_no)) : "") +
      (how ? ' <span class="hint">(' + how + " — confirm it's right)</span>" : "") +
      ' <button class="btn" type="button" style="margin-left:8px" onclick="smOpenFoundationPicker()">change</button>' +
      ' <button class="btn" type="button" onclick="smClearFoundationPick()">✕ unlink</button>';
  }
}
function smClearFoundationPick(){
  smFoundationPick = null;
  var el = smEl("sm-pc-foundation");
  if (el){
    el.innerHTML = "Not linked. " +
      '<button class="btn" type="button" onclick="smOpenFoundationPicker()">🔗 Link a Foundation job</button>';
  }
}
/* Clears the "this name came from the proposal subject" flag the moment the
 * manager edits the field by hand (wired oninput in index.html). */
function smJobNameEdited(){ smJobNameFromProposal = false; }

/* ---- manual Foundation job picker (search/select fallback) ----
 * Auto-match is deliberately conservative and refuses ambiguity; this is the
 * one-tap way through whenever it declines or gets it wrong. Searches the same
 * fdnCache the Select-Job picker uses, by name / job # / customer / city. */
function smOpenFoundationPicker(){
  var m = smEl("sm-fdn-modal");
  if (m) m.style.display = "";
  var host = smEl("sm-fdn-list");
  if (host) host.innerHTML = "Loading jobs…";
  // Clear last time's query synchronously, so the seed below applies on reopen
  // while anything typed DURING this open still wins.
  setVal2("sm-fdn-search", "");
  // Same staleness class as smMatchFoundationFromForm: a slow first load for
  // proposal A must not re-seed a picker the manager has since reopened for B.
  var seq = ++smFdnPickerSeq;
  var forProposal = smCurrentProposal;
  var render = function(){
    if (seq !== smFdnPickerSeq || smCurrentProposal !== forProposal) return;
    // Seed from the best-ranked CANDIDATE's name, never the raw email subject:
    // the filter is an AND over tokens, so seeding "Prairie Farms – roof repair
    // proposal" would return zero rows for a job that's sitting right there.
    var best = smRankFoundationJobs(smFoundationSearchText(), null, 1)[0];
    var seed = best ? (best.name || "") : (smJobNameFromProposal ? "" : getVal2("sm-pc-jobName"));
    // Never overwrite what the manager has already typed: on a cold jobs read
    // they can be mid-search when this lands, and replacing their text with a
    // seed silently swaps in a plausible-looking wrong result.
    if (!getVal2("sm-fdn-search")) setVal2("sm-fdn-search", String(seed || "").slice(0, 60));
    smRenderFoundationPicker();
  };
  if (typeof fdnLoadJobs === "function") fdnLoadJobs(false).then(render).catch(function(){
    smFdnLoadFailed = true;
    if (seq !== smFdnPickerSeq) return;
    if (host) host.innerHTML = '<span style="color:#b23">Couldn\'t load the Foundation job list.</span>';
  });
  else render();
}
function smCloseFoundationPicker(){ var m = smEl("sm-fdn-modal"); if (m) m.style.display = "none"; }
/* Pure filter so the search behaviour is testable without a DOM. Matches the
 * Select-Job picker's field set (name / job # / customer / PM / city). */
function smFilterFoundationJobs(query, jobs, limit){
  var all = jobs || ((typeof fdnCache !== "undefined" && fdnCache) ? fdnCache : []) || [];
  var q = smNorm(query);
  if (!q) return all.slice(0, limit || 50);
  var toks = q.split(" ").filter(Boolean);
  return all.filter(function(j){
    var hay = smNorm([j.name, j.job_no, j.job_number, j.customer_no, j.project_manager_no, j.city].join(" "));
    return toks.every(function(t){ return hay.indexOf(t) !== -1; });
  }).slice(0, limit || 50);
}
function smRenderFoundationPicker(){
  var host = smEl("sm-fdn-list");
  if (!host) return;
  var q = getVal2("sm-fdn-search");
  var rows = smFilterFoundationJobs(q, null, 50);
  var note = "";
  // Never dead-end: a strict AND-filter that finds nothing falls back to the
  // ranked near-misses, then to the head of the list, so the picker always has
  // something to tap.
  if (!rows.length && q){
    rows = smRankFoundationJobs(q, null, 25);
    note = rows.length
      ? '<div class="hint" style="margin:0 0 8px">No exact matches — closest jobs by name:</div>'
      : "";
    if (!rows.length){
      rows = smFilterFoundationJobs("", null, 25);
      note = rows.length ? '<div class="hint" style="margin:0 0 8px">No matches for “' + smEsc(q) + '” — showing the most recent jobs:</div>' : "";
    }
  }
  if (!rows.length){ host.innerHTML = '<span class="hint">No Foundation jobs are cached yet — an admin can run a sync.</span>'; return; }
  host.innerHTML = note + rows.map(function(j){
    var meta = [j.customer_no, j.city, (typeof fdnComposeAddress === "function") ? fdnComposeAddress(j) : ""]
      .filter(Boolean).map(smEsc).join(" · ");
    return '<div class="card" style="margin:0 0 6px;padding:8px 10px;display:flex;gap:8px;align-items:center">' +
      '<div style="flex:1"><b>' + smEsc(j.name || "(unnamed job)") + '</b> <span class="hint">#' + smEsc(j.job_no) + "</span>" +
        '<div class="hint">' + meta + "</div></div>" +
      '<button class="btn primary" onclick="smPickFoundationJob(' +
        smEsc(JSON.stringify(String(j.job_no))) + ')">Link</button>' +
    "</div>";
  }).join("");
}
function smPickFoundationJob(jobNo){
  var cache = (typeof fdnCache !== "undefined" && fdnCache) ? fdnCache : [];
  var j = cache.find(function(x){ return String(x.job_no) === String(jobNo); });
  if (!j) return;
  // An explicit choice outranks anything auto-match decided.
  smApplyFoundationPick(j, "manual");
  smCloseFoundationPicker();
  smToast("Linked to job #" + j.job_no);
}

/* ==================== CompanyCam link / create (rule exception) ===========
 * RoofOps' standing hard rule is "never auto-create CompanyCam projects —
 * link/push to existing ones only." Mark deliberately authorized a ONE-CLICK
 * create for THIS flow (2026-07-17), offered ONLY when the WO is
 * Foundation-linked AND no existing project matches the address. Not silent:
 * the manager clicks Check, sees the match/no-match, and only then may create.
 * The create itself is permission-gated (companycam.link) + audit-logged
 * server-side (netlify/functions/companycam.js create_project). */
async function smCcGet(params){
  if (typeof ccApi === "function") return ccApi(params);
  var qs = Object.keys(params).map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
  var headers = (typeof authHeaders === "function") ? (await authHeaders()) : {};
  var r = await fetch("/.netlify/functions/companycam?" + qs, { headers: headers });
  if (!r.ok){ var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function smCcPost(body){
  if (typeof ccApiPost === "function") return ccApiPost(body);
  var headers = (typeof authHeaders === "function") ? (await authHeaders()) : { "Content-Type": "application/json" };
  var r = await fetch("/.netlify/functions/companycam", { method: "POST", headers: headers, body: JSON.stringify(body) });
  var data = null; try { data = await r.json(); } catch (e) {}
  if (!r.ok){ var er = new Error((data && data.error) || ("HTTP " + r.status)); er.status = r.status; throw er; }
  return data;
}
/* Confident CompanyCam match: address-key equality (same fdn algorithm),
 * unique only; name-equality fallback. Refuses ambiguity — same doctrine as the
 * Foundation match. */
function smMatchCompanyCamProject(projects, loc, name){
  if (!projects || !projects.length) return null;
  if (typeof fdnAddressMatchKey === "function"){
    var key = fdnAddressMatchKey(loc);
    if (key){
      var am = projects.filter(function(p){ return fdnAddressMatchKey(p.address || "") === key; });
      if (am.length === 1) return am[0];
      if (am.length > 1) return null;
    }
  }
  var nm = smNorm(name);
  if (!nm) return null;
  var nmatch = projects.filter(function(p){ return smNorm(p.name) === nm; });
  return nmatch.length === 1 ? nmatch[0] : null;
}
/* Best-effort CompanyCam address object from the form's location line. */
function smCcAddressParts(loc){
  var parts = String(loc || "").split(",").map(function(s){ return s.trim(); }).filter(Boolean);
  var a = {};
  if (parts[0]) a.street_address_1 = parts[0];
  if (parts[1]) a.city = parts[1];
  if (parts[2]){ var sp = parts[2].split(/\s+/); if (sp[0]) a.state = sp[0]; if (sp[1]) a.postal_code = sp[1]; }
  return a;
}
async function smCheckCompanyCam(){
  var el = smEl("sm-pc-companycam");
  var loc = getVal2("sm-pc-location") || "", name = getVal2("sm-pc-jobName") || "";
  var q = (loc || name).slice(0, 100);
  if (!q){ if (el) el.innerHTML = "Add an address or job name first."; return; }
  if (el) el.innerHTML = "Searching CompanyCam…";
  try {
    var data = await smCcGet({ action: "projects", q: q });
    var projects = (data && data.projects) || [];
    var match = smMatchCompanyCamProject(projects, loc, name);
    if (match){
      smCcPick = { id: String(match.id), name: match.name || "" };
      if (el) el.innerHTML = "✅ Found <b>" + smEsc(match.name || match.id) + "</b>" +
        (match.address ? (' <span class="hint">— ' + smEsc(match.address) + "</span>") : "") +
        " — it will be linked to this work order.";
      return;
    }
    smCcPick = null;
    if (smFoundationPick){
      if (el) el.innerHTML = "⚠️ No matching CompanyCam project. " +
        '<button class="btn" type="button" style="margin-left:6px" onclick="smCreateCompanyCamProject()">➕ Create project for this address</button>' +
        '<div class="hint" style="margin:6px 0 0">Deliberate action — RoofOps normally never creates CompanyCam projects. This one is permission-gated + audit-logged.</div>';
    } else {
      if (el) el.innerHTML = "⚠️ No matching CompanyCam project. Cross-reference a Foundation job first to enable creating one (deliberate, for this flow only).";
    }
  } catch (e) {
    if (el) el.innerHTML = '<span style="color:#b23">Couldn\'t search CompanyCam' + (e.status ? " (" + e.status + ")" : "") + ".</span>";
  }
}
async function smCreateCompanyCamProject(){
  var el = smEl("sm-pc-companycam");
  if (!smFoundationPick){ if (el) el.innerHTML = "Cross-reference a Foundation job first (deliberate create is only for Foundation-linked sites)."; return; }
  var name = (getVal2("sm-pc-jobName") || (smFoundationPick && smFoundationPick.name) || "").trim();
  if (!name){ if (el) el.innerHTML = "Add a job/building name first."; return; }
  if (el) el.innerHTML = "Creating CompanyCam project…";
  try {
    var data = await smCcPost({
      action: "create_project",
      name: name,
      address: smCcAddressParts(getVal2("sm-pc-location")),
      foundationJobNo: smFoundationPick ? smFoundationPick.job_no : null
    });
    if (!data || !data.ok || !data.projectId) throw new Error((data && data.error) || "no project id returned");
    smCcPick = { id: String(data.projectId), name: data.projectName || name };
    if (el) el.innerHTML = "✅ Created <b>" + smEsc(smCcPick.name) + "</b> and linked it to this work order.";
    smToast("CompanyCam project created ✓");
  } catch (e) {
    if (el) el.innerHTML = '<span style="color:#b23">Couldn\'t create the project' + (e.status ? " (" + e.status + ")" : "") + ": " + smEsc(e.message || "") + "</span>";
  }
}

/* ========================= pre-create a work order ======================= */
function smOpenPrecreate(seed){
  seed = seed || {};
  smCurrentProposal = seed.proposal || null;
  smFoundationPick = null;
  // The seeded job name is the email SUBJECT, not a site name — a Foundation
  // match is allowed to replace it (see smApplyFoundationPick).
  smJobNameFromProposal = !!(seed.proposal && seed.jobName);
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
  smCcPick = null;
  var ccEl = smEl("sm-pc-companycam");
  if (ccEl) ccEl.innerHTML = "Check for an existing CompanyCam project to link. Creating one is a deliberate action, offered only when Foundation-linked with no match.";
  smMaybeShowAiPrefill();
  var modal = smEl("sm-precreate-modal");
  if (modal) modal.style.display = "";
  // Cross-reference Foundation IMMEDIATELY rather than waiting for a button
  // nobody knew to press — the whole point is that the WO is born bound to the
  // real job. Fire-and-forget: it paints into #sm-pc-foundation when it lands,
  // and a miss degrades to the "did you mean / search all" fallback.
  if (smCurrentProposal || seed.jobName || seed.location){
    // .catch, not try/catch — this is async; a rejection would otherwise escape.
    Promise.resolve().then(function(){ return smMatchFoundationFromForm(true); }).catch(function(){});
  }
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
    foundation: smFoundationPick,
    companyCamProjectId: smCcPick ? smCcPick.id : null,
    companyCamProjectName: smCcPick ? smCcPick.name : ""
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
    companyCamProjectId: data.companyCamProjectId || null, companyCamProjectName: data.companyCamProjectName || "",
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

/* ---- AI scope-prefill (netlify/functions/generate-scope.js). The button is
 *      hidden until the endpoint's capability probe reports a key is configured,
 *      so it's inert on a keyless deploy (production today). ---- */
async function smAiScopeApi(body){
  var headers = (typeof authHeaders === "function") ? (await authHeaders()) : { "Content-Type": "application/json" };
  var r = await fetch("/.netlify/functions/generate-scope", { method: "POST", headers: headers, body: JSON.stringify(body) });
  var data = null; try { data = await r.json(); } catch (e) {}
  if (!r.ok){ var e = new Error((data && data.error) || ("HTTP " + r.status)); e.status = r.status; throw e; }
  return data;
}
function smMaybeShowAiPrefill(){
  var row = smEl("sm-pc-ai-row");
  if (!row) return;
  row.style.display = "none";
  smAiScopeApi({ action: "capability" })
    .then(function(d){ if (d && d.configured) row.style.display = ""; })
    .catch(function(){ /* keyless / unauthorized / offline → button stays hidden */ });
}
async function smAiPrefillScope(){
  var scopeEl = smEl("sm-pc-scope");
  // Draft from the proposal's subject plus whatever scope text is already
  // there. Richer sources (full email body via mail_read, PDF-text extraction)
  // are a flagged follow-up; email subjects are already descriptive.
  var text = "";
  if (smCurrentProposal && smCurrentProposal.subject) text += smCurrentProposal.subject;
  var existing = scopeEl ? (scopeEl.value || "") : "";
  if (existing) text += (text ? "\n" : "") + existing;
  if (!text.trim()){ smToast("Add a proposal or some scope text to draft from."); return; }
  smToast("Drafting scope…");
  try {
    var d = await smAiScopeApi({
      action: "draft_scope",
      proposalText: text,
      context: { jobName: getVal2("sm-pc-jobName"), location: getVal2("sm-pc-location") }
    });
    if (!d || !d.ok) throw new Error((d && d.error) || "no draft");
    if (scopeEl && d.draft) scopeEl.value = d.draft;
    smToast(d.llm ? "Scope drafted by AI — review & edit" : (d.fallback ? "AI unavailable — inserted a template draft" : "Inserted a template scope draft"));
  } catch (e) {
    smToast("Couldn't draft the scope" + (e.status ? " (" + e.status + ")" : "") + ".");
  }
}

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
    smFindFoundationJobDetailed: smFindFoundationJobDetailed,
    smFdnCacheStatus: smFdnCacheStatus,
    smRankFoundationJobs: smRankFoundationJobs,
    smFilterFoundationJobs: smFilterFoundationJobs,
    smNameIsDistinctive: smNameIsDistinctive,
    smContainsTokens: smContainsTokens,
    smWoExistsForProposal: smWoExistsForProposal,
    smGroupBoard: smGroupBoard,
    smYmdToMdy: smYmdToMdy,
    smLocalYmd: smLocalYmd,
    smNorm: smNorm
  };
}
