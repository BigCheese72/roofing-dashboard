"use strict";
/* ================= Foundation (construction accounting) — client =================

   Phase 2 client half. Two things:

   1. JOB PICKER + AUTO-FILL. Reads the client-readable `foundation_jobs`
      Firestore cache (populated nightly by netlify/functions/foundation-sync.js)
      and, on select, auto-fills the work-order form — mirroring the existing
      "Select Existing Building" picker (bpSelectBuilding in js/workorders.js).
      The picker reads the CACHE, not the live connector, so any signed-in user
      can use it (the cache holds only identifying fields — no contract value,
      no hours). See firestore.rules `foundation_jobs`.

   2. ADMIN-ONLY LABOR HOURS. A WO linked to a Foundation job shows a labor-hours
      card, but hours are NEVER cached — they're fetched live from
      netlify/functions/foundation.js (action=job_hours), which is gated on the
      `foundation.read` permission server-side. The card renders ONLY if that
      fetch is authorized (attempt-fetch, hide on 401/403), so it self-gates to
      exactly the foundation.read holders (owner/admin/service_manager/
      ops_manager) with no client-side permission grid needed.

   Depends on globals from earlier-loaded scripts: `fdb` (Firestore),
   `authHeaders`/`toast` (js/core.js), `setVal` (js/workorders.js). All are
   resolved at call time, not parse time. */

// Linkage for the currently-open work order. Read by collect() in
// js/workorders.js (guarded) so it persists on the WO doc.
var fdnLinkedJobNo = null;
var fdnLinkedJobName = "";

// Session cache of the jobs collection (filtered copy for the current search).
var fdnCache = null;
var fdnFiltered = [];

function fdnEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Compose a single-line address from the cached job's parts.
function fdnComposeAddress(j) {
  var line2 = [j.city, [j.state, j.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [j.address, line2].filter(Boolean).join(", ");
}

function openFoundationPicker() {
  var modal = document.getElementById("fdn-modal");
  if (modal) modal.style.display = "";
  var input = document.getElementById("fdn-search");
  if (input) input.value = "";
  fdnLoadAndRender();
}
function closeFoundationPicker() {
  var modal = document.getElementById("fdn-modal");
  if (modal) modal.style.display = "none";
}

// Loads foundation_jobs once per session (unless forced) and renders. The cap
// mirrors the buildings picker's bounded read; the nightly sync writes every
// active job, and 5000 comfortably covers Watkins' active count.
async function fdnLoadJobs(force) {
  if (fdnCache && !force) return fdnCache;
  if (typeof fdb === "undefined" || !fdb) throw new Error("Not connected");
  var snap = await fdb.collection("foundation_jobs").limit(5000).get();
  var jobs = [];
  snap.forEach(function (d) { jobs.push(d.data()); });
  // Newest-started first, matching the server's default ordering.
  jobs.sort(function (a, b) { return String(b.job_start_date || "").localeCompare(String(a.job_start_date || "")); });
  fdnCache = jobs;
  return fdnCache;
}

async function fdnLoadAndRender() {
  var list = document.getElementById("fdn-list");
  if (list) list.innerHTML = "Loading…";
  try {
    await fdnLoadJobs(false);
    fdnFilter();
  } catch (e) {
    if (list) list.innerHTML = "Couldn't load Foundation jobs. " + fdnEsc((e && e.message) || "");
  }
}

function fdnFilter() {
  var q = "";
  var input = document.getElementById("fdn-search");
  if (input) q = String(input.value || "").trim().toLowerCase();
  var all = fdnCache || [];
  fdnFiltered = !q ? all.slice(0, 300) : all.filter(function (j) {
    return [j.name, j.job_no, j.job_number, j.customer_no, j.project_manager_no, j.city]
      .some(function (v) { return String(v || "").toLowerCase().indexOf(q) !== -1; });
  }).slice(0, 300);
  fdnRender();
}

function fdnRender() {
  var list = document.getElementById("fdn-list");
  if (!list) return;
  if (!(fdnCache || []).length) {
    list.innerHTML = "No Foundation jobs cached yet. The nightly sync may not have run — an admin can run it, or check back after tonight.";
    return;
  }
  if (!fdnFiltered.length) { list.innerHTML = "No matching jobs."; return; }
  list.innerHTML = fdnFiltered.map(function (j) {
    var sub = [j.job_no ? "#" + j.job_no : "", j.customer_no, j.project_manager_no ? "PM " + j.project_manager_no : "", j.city]
      .filter(Boolean).map(fdnEsc).join(" · ");
    return '<div class="rowcard" style="cursor:pointer" onclick="fdnSelectJob(' +
      JSON.stringify(String(j.job_no)).replace(/"/g, "&quot;") + ')">' +
      '<b>' + fdnEsc(j.name || "(unnamed job)") + '</b><br>' +
      '<span class="hint" style="margin:0">' + sub + '</span></div>';
  }).join("");
}

// On select: auto-fill the WO fields, mirroring bpSelectBuilding(). Bill To is
// filled with Foundation's customer CODE (customer_no) — the jobs table has no
// customer display name; surfacing the friendly name would need a customers-
// table join (a small follow-up). The tech reviews before saving.
function fdnSelectJob(jobNo) {
  var j = (fdnCache || []).find(function (x) { return String(x.job_no) === String(jobNo); });
  if (!j) return;
  if (typeof setVal === "function") {
    setVal("jobName", j.name || "");
    setVal("location", fdnComposeAddress(j));
    setVal("jobNo", j.job_number || j.job_no || "");
    setVal("projectManager", j.project_manager_no || "");
    if (j.customer_no) setVal("billTo", j.customer_no);
  }
  fdnSetLinkedJob(j.job_no, j.name || "");
  closeFoundationPicker();
  if (typeof toast === "function") toast("Loaded Foundation job “" + (j.name || j.job_no) + "” — review the fields below before saving");
}

// Central setter for the WO's Foundation linkage: updates the module vars (read
// by collect()), the link line, and the admin labor card. Called by
// fdnSelectJob and by fill() (js/workorders.js) when a saved WO loads.
function fdnSetLinkedJob(jobNo, jobName) {
  fdnLinkedJobNo = jobNo || null;
  fdnLinkedJobName = jobName || "";
  renderFdnLinkInfo();
  fdnRefreshLaborCard();
}

function renderFdnLinkInfo() {
  var el = document.getElementById("fdn-link-info");
  if (!el) return;
  if (fdnLinkedJobNo) {
    el.style.display = "";
    el.innerHTML = "🏗️ Foundation job linked: <b>" + fdnEsc(fdnLinkedJobName || fdnLinkedJobNo) +
      "</b> (#" + fdnEsc(fdnLinkedJobNo) + ") — <a href=\"#\" onclick=\"fdnUnlinkJob();return false;\">unlink</a>";
  } else {
    el.style.display = "none";
    el.innerHTML = "";
  }
}

function fdnUnlinkJob() {
  fdnSetLinkedJob(null, "");
}

// GET the linked job's hours from the live connector (server-gated on
// foundation.read). Returns the parsed body or throws with .status set so the
// caller can distinguish "not authorized" (hide the card) from real data.
async function fdnFetchHours(jobNo) {
  var r = await fetch("/.netlify/functions/foundation?action=job_hours&job_no=" + encodeURIComponent(jobNo), {
    headers: await authHeaders()
  });
  var out = null;
  try { out = await r.json(); } catch (e) {}
  if (!r.ok) { var err = new Error((out && out.error) || ("server error " + r.status)); err.status = r.status; throw err; }
  return out;
}

// Shows the labor card ONLY when the server authorizes the hours fetch — that
// is the real gate (foundation.read). A 401/403 (or any error) leaves the card
// hidden, so a non-admin never sees it. Hours are live, never cached.
async function fdnRefreshLaborCard() {
  var card = document.getElementById("wo-foundation-labor-card");
  var body = document.getElementById("wo-foundation-labor-body");
  if (!card) return;
  if (!fdnLinkedJobNo) { card.style.display = "none"; return; }
  if (body) body.innerHTML = "Loading…";
  card.style.display = "";
  var jobAtFetch = fdnLinkedJobNo;
  try {
    var data = await fdnFetchHours(jobAtFetch);
    // The linkage may have changed while the fetch was in flight — ignore a
    // stale response.
    if (fdnLinkedJobNo !== jobAtFetch) return;
    fdnRenderLaborCard(data);
  } catch (e) {
    // Not authorized, or the job has no hours path — hide the card entirely
    // (fail closed on display; the server is the real gate).
    if (fdnLinkedJobNo === jobAtFetch) card.style.display = "none";
  }
}

function fdnRenderLaborCard(data) {
  var body = document.getElementById("wo-foundation-labor-body");
  if (!body) return;
  var rows = (data && data.hours) || [];
  var total = (data && typeof data.total_hours === "number") ? data.total_hours : 0;
  var head = "<div style=\"margin-bottom:8px\"><b>" + fdnEsc(String(total)) + "</b> total hours across <b>" +
    fdnEsc(String((data && data.row_count) || rows.length)) + "</b> entries</div>";
  if (!rows.length) { body.innerHTML = head + "<span class=\"hint\" style=\"margin:0\">No labor logged for this job yet.</span>"; return; }
  // Show the most recent 25 entries; date/employee/hours/phase/cost code only
  // (the server never sends pay data).
  var recent = rows.slice(-25).reverse();
  var trs = recent.map(function (h) {
    return "<tr><td>" + fdnEsc((h.date || "").slice(0, 10)) + "</td><td>" + fdnEsc(h.employee_no) +
      "</td><td style=\"text-align:right\">" + fdnEsc(String(h.hours == null ? "" : h.hours)) +
      "</td><td>" + fdnEsc(h.phase_no) + "</td><td>" + fdnEsc(h.cost_code_no) + "</td></tr>";
  }).join("");
  body.innerHTML = head +
    "<div style=\"overflow-x:auto\"><table style=\"width:100%;border-collapse:collapse;font-size:13px\">" +
    "<thead><tr><th style=\"text-align:left\">Date</th><th style=\"text-align:left\">Employee</th>" +
    "<th style=\"text-align:right\">Hours</th><th style=\"text-align:left\">Phase</th><th style=\"text-align:left\">Cost code</th></tr></thead>" +
    "<tbody>" + trs + "</tbody></table></div>" +
    (rows.length > 25 ? "<span class=\"hint\" style=\"margin:6px 0 0;display:block\">Showing the 25 most recent of " + fdnEsc(String(rows.length)) + " entries.</span>" : "");
}
