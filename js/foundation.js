"use strict";
/* ================= Job list (Foundation-sourced) — client =================

   The "Foundation" wording is internal only — in the UI this is just "jobs"
   (by # / name). Two things:

   1. JOB LIST INSIDE THE "SELECT JOB" PICKER. Reads the client-readable
      `foundation_jobs` Firestore cache (populated by the scheduled sync,
      netlify/functions/foundation-sync.js) and renders as the primary section
      of the ONE picker (the bp-modal in index.html — same modal that shows the
      app's own buildings and CompanyCam). On select, auto-fills the work-order
      form; if the job also exists as an app building, it carries that
      building's extra context too. The picker reads the CACHE, not the live
      connector, so any signed-in user can use it (the cache holds only
      identifying fields — no contract value, no hours). See firestore.rules
      `foundation_jobs`.

   2. ADMIN-ONLY LABOR HOURS. A WO linked to a job shows a labor-hours card,
      but hours are NEVER cached — they're fetched live from
      netlify/functions/foundation.js (action=job_hours), gated on the
      `foundation.read` permission server-side. The card renders ONLY if that
      fetch is authorized (attempt-fetch, hide on 401/403), so it self-gates to
      exactly the foundation.read holders (owner/admin/service_manager/
      ops_manager) with no client-side permission grid needed.

   Depends on globals from earlier-loaded scripts: `fdb` (Firestore),
   `authHeaders`/`toast` (js/core.js), `setVal`/`bpCache`/`closeBuildingPicker`
   (js/workorders.js), `ccLinkedProjectId`/`renderCCLinkInfo` (companycam.js).
   All resolved at call time, not parse time. */

// Linkage for the currently-open work order. Read by collect() in
// js/workorders.js (guarded) so it persists on the WO doc — and, via
// ensureCustomerAndBuilding() (js/core.js), onto the BUILDING doc so the site's
// accounting identity + base-map anchor follow the job (issue #76). customer_no
// and the composed address are captured alongside the job no/name so the
// building doc carries the full accounting snapshot, not just the number.
var fdnLinkedJobNo = null;
var fdnLinkedJobName = "";
var fdnLinkedCustomerNo = null;
var fdnLinkedAddress = "";

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

// Loads the jobs cache once per session (unless forced). The cap mirrors the
// buildings picker's bounded read; the scheduled sync writes every active job,
// and 5000 comfortably covers Watkins' active count (~522).
async function fdnLoadJobs(force) {
  if (fdnCache && !force) return fdnCache;
  if (typeof fdb === "undefined" || !fdb) throw new Error("Not connected");
  var snap = await fdb.collection("foundation_jobs").limit(5000).get();
  var jobs = [];
  snap.forEach(function (d) { jobs.push(d.data()); });
  // Descending by job number (highest / newest job # first). Numeric-aware so
  // "17053" sorts above "9999"; falls back to a string compare for any
  // non-numeric job_no.
  jobs.sort(function (a, b) {
    var na = Number(a.job_no), nb = Number(b.job_no);
    if (isFinite(na) && isFinite(nb) && na !== nb) return nb - na;
    return String(b.job_no || "").localeCompare(String(a.job_no || ""));
  });
  fdnCache = jobs;
  return fdnCache;
}

// The job list is ONE section of the single "Select Job" picker (the bp-modal
// in index.html), alongside the app's own buildings and CompanyCam. There is
// no separate modal. openBuildingPicker() (js/workorders.js) calls this to
// prime the jobs section; the shared search box re-filters it on every
// keystroke via fdnFilterPicker().
async function fdnPrimePicker() {
  var host = document.getElementById("bp-job-list");
  if (host) { host.className = "hint"; host.textContent = "Loading jobs…"; }
  try {
    await fdnLoadJobs(false);
    fdnFilterPicker();
  } catch (e) {
    if (host) { host.className = "hint"; host.textContent = "Couldn't load jobs: " + fdnEsc((e && e.message) || ""); }
  }
}

function fdnFilterPicker() {
  var q = "";
  var input = document.getElementById("bp-search");
  if (input) q = String(input.value || "").trim().toLowerCase();
  var all = fdnCache || [];
  fdnFiltered = !q ? all.slice(0, 300) : all.filter(function (j) {
    return [j.name, j.job_no, j.job_number, j.customer_no, j.project_manager_no, j.city]
      .some(function (v) { return String(v || "").toLowerCase().indexOf(q) !== -1; });
  }).slice(0, 300);
  fdnRenderPicker();
}

function fdnRenderPicker() {
  var host = document.getElementById("bp-job-list");
  if (!host) return;
  if (!(fdnCache || []).length) {
    host.className = "hint";
    host.textContent = "No jobs cached yet — an admin can run a sync (the list also refreshes automatically during the work day).";
    return;
  }
  if (!fdnFiltered.length) { host.className = "hint"; host.textContent = "No matching jobs."; return; }
  host.className = "";
  host.innerHTML = fdnFiltered.map(function (j) {
    var parts = [j.customer_no, j.project_manager_no ? "PM " + j.project_manager_no : "", j.city].filter(Boolean);
    if (fdnFindMatchingBuilding(j)) parts.push("✓ in app");
    var meta = parts.map(fdnEsc).join(" · ");
    return '<div class="bld-item" onclick="fdnSelectJob(' +
      JSON.stringify(String(j.job_no)).replace(/"/g, "&quot;") + ')"><div class="info">' +
      '<div class="name">' + fdnEsc(j.name || "(unnamed job)") +
      (j.job_no ? ' <span class="hint">#' + fdnEsc(j.job_no) + '</span>' : "") + '</div>' +
      '<div class="meta">' + meta + '</div></div>' +
      '<button class="btn">Select</button></div>';
  }).join("");
}

// Best-effort link from a job to an already-created app building. Address is
// strongest, exact name is the fallback, and ambiguity always refuses to guess.
// carry the building's extra context on select, and to tag "✓ in app" rows.
function fdnNormalizeText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function fdnNormalizeStreetToken(token) {
  var t = String(token || "").toLowerCase();
  var map = {
    avenue: "ave", ave: "ave",
    boulevard: "blvd", blvd: "blvd",
    circle: "cir", cir: "cir",
    court: "ct", ct: "ct",
    drive: "dr", dr: "dr",
    highway: "hwy", hwy: "hwy",
    lane: "ln", ln: "ln",
    parkway: "pkwy", pkwy: "pkwy",
    place: "pl", pl: "pl",
    road: "rd", rd: "rd",
    street: "st", st: "st",
    terrace: "ter", ter: "ter"
  };
  return map[t] || t;
}

function fdnAddressMatchKey(s) {
  var parts = String(s || "").split(",");
  var firstLine = parts[0];
  var normalized = fdnNormalizeText(firstLine);
  var m = normalized.match(/^(\d+[a-z]?)\s+(.+)$/);
  if (!m) return "";
  var stop = { apt: true, apartment: true, ste: true, suite: true, unit: true, bldg: true, building: true };
  var street = [];
  fdnNormalizeText(m[2]).split(" ").some(function (token) {
    if (!token) return false;
    if (stop[token]) return true;
    street.push(fdnNormalizeStreetToken(token));
    return false;
  });
  if (!street.length) return "";
  var key = [m[1] + " " + street.join(" ")];
  var city = fdnNormalizeText(parts[1]);
  if (city) key.push(city);
  var state = fdnNormalizeText(parts[2]).split(" ")[0] || "";
  if (state) key.push(state);
  return key.join("|");
}

function fdnUniqueMatch(candidates, predicate) {
  var matches = candidates.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function fdnFindMatchingBuilding(job) {
  if (typeof bpCache === "undefined" || !bpCache) return null;
  var buildings = (bpCache || []).filter(Boolean);
  if (!buildings.length || !job) return null;

  var jobAddressKey = fdnAddressMatchKey(fdnComposeAddress(job));
  if (jobAddressKey) {
    var addressMatches = buildings.filter(function (b) {
      return fdnAddressMatchKey(b && b.location) === jobAddressKey;
    });
    if (addressMatches.length === 1) return addressMatches[0];
    if (addressMatches.length > 1) return null;
  }

  var jobName = fdnNormalizeText(job.name);
  if (!jobName) return null;
  return fdnUniqueMatch(buildings, function (b) {
    return fdnNormalizeText(b && b.name) === jobName;
  });
}

// On select: auto-fill the WO fields. Bill To is filled with the customer CODE
// (customer_no) — the jobs table has no customer display name; the friendly
// name would need a customers-table join (a small follow-up). If the job is
// ALSO an existing app building, carry that building's richer context (roof
// system + CompanyCam link) on top. The tech reviews before saving.
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
  var b = fdnFindMatchingBuilding(j);
  if (b) {
    if (b.roofSystem && typeof setVal === "function") setVal("roofSystem", b.roofSystem);
    // Carry the building's CompanyCam link, but never clobber an explicit link
    // the tech already made this session (mirrors bpSelectBuilding).
    if (b.companyCamProjectId && typeof ccLinkedProjectId !== "undefined" && !ccLinkedProjectId) {
      ccLinkedProjectId = b.companyCamProjectId;
      ccLinkedProjectName = b.companyCamProjectName || "";
      if (typeof renderCCLinkInfo === "function") renderCCLinkInfo();
    }
  }
  fdnSetLinkedJob(j.job_no, j.name || "", j.customer_no || null, fdnComposeAddress(j));
  /* Picked job's address is navigable immediately (🧭 Directions —
     js/workorders.js, loads after this file, hence the guard). */
  if (typeof renderLocationDirectionsLink === "function") renderLocationDirectionsLink();
  if (typeof closeBuildingPicker === "function") closeBuildingPicker();
  if (typeof toast === "function") toast("Loaded job “" + (j.name || j.job_no) + "” — review the fields below before saving");
}

// Central setter for the WO's Foundation linkage: updates the module vars (read
// by collect()), the link line, and the admin labor card. Called by
// fdnSelectJob and by fill() (js/workorders.js) when a saved WO loads.
function fdnSetLinkedJob(jobNo, jobName, customerNo, address) {
  fdnLinkedJobNo = jobNo || null;
  fdnLinkedJobName = jobName || "";
  fdnLinkedCustomerNo = customerNo || null;
  fdnLinkedAddress = address || "";
  renderFdnLinkInfo();
  fdnRefreshLaborCard();
  /* Linking/unlinking the Foundation job is exactly what flips the
     "Leak – No Job" flag (js/workorders.js — loads after this file, so
     typeof-guarded the same way fill()'s call to this function is). */
  if (typeof renderLeakNoJobBadge === "function") renderLeakNoJobBadge();
}

function renderFdnLinkInfo() {
  var el = document.getElementById("fdn-link-info");
  if (!el) return;
  if (fdnLinkedJobNo) {
    el.style.display = "";
    el.innerHTML = "🔗 Linked job: <b>" + fdnEsc(fdnLinkedJobName || fdnLinkedJobNo) +
      "</b> (#" + fdnEsc(fdnLinkedJobNo) + ") — <a href=\"#\" onclick=\"fdnUnlinkJob();return false;\">unlink</a>";
  } else {
    el.style.display = "none";
    el.innerHTML = "";
  }
}

function fdnUnlinkJob() {
  fdnSetLinkedJob(null, "", null, "");
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
  fdnRenderLaborInto(document.getElementById("wo-foundation-labor-body"), data);
}
// Shared renderer for a labor-hours card body — used by the WO/leak form
// (above) and the DPR's card (js/dpr.js). The server now blends the posted
// record (his_timecard) with the not-yet-posted pending tail, so this shows
// CURRENT hours: rows carry `name` (employee-master join, falls back to the
// raw mnemonic) and `posted` (false = punched but pending payroll, shown with
// the same ⏱ tag the DPR crew rows use).
function fdnRenderLaborInto(body, data) {
  if (!body) return;
  var rows = (data && data.hours) || [];
  var total = (data && typeof data.total_hours === "number") ? data.total_hours : 0;
  var unposted = (data && typeof data.unposted_hours === "number") ? data.unposted_hours : 0;
  var head = "<div style=\"margin-bottom:8px\"><b>" + fdnEsc(String(total)) + "</b> total hours across <b>" +
    fdnEsc(String((data && data.row_count) || rows.length)) + "</b> entries" +
    (unposted > 0
      ? " — <b>" + fdnEsc(String(unposted)) + "</b> of that punched but not yet posted to payroll" +
        (data.unposted_through ? " (through " + fdnEsc(data.unposted_through) + ")" : "")
      : "") +
    "</div>";
  if (!rows.length) { body.innerHTML = head + "<span class=\"hint\" style=\"margin:0\">No labor logged for this job yet.</span>"; return; }
  // Show the most recent 25 entries; date/person/hours/phase/cost code only
  // (the server never sends pay data).
  var recent = rows.slice(-25).reverse();
  var trs = recent.map(function (h) {
    var pendingTag = (h.posted === false)
      ? " <span title=\"Punched on the clock, not yet posted to payroll\">⏱</span>" : "";
    return "<tr><td>" + fdnEsc((h.date || "").slice(0, 10)) + "</td><td>" + fdnEsc(h.name || h.employee_no) + pendingTag +
      "</td><td style=\"text-align:right\">" + fdnEsc(String(h.hours == null ? "" : h.hours)) +
      "</td><td>" + fdnEsc(h.phase_no) + "</td><td>" + fdnEsc(h.cost_code_no) + "</td></tr>";
  }).join("");
  body.innerHTML = head +
    "<div style=\"overflow-x:auto\"><table style=\"width:100%;border-collapse:collapse;font-size:13px\">" +
    "<thead><tr><th style=\"text-align:left\">Date</th><th style=\"text-align:left\">Person</th>" +
    "<th style=\"text-align:right\">Hours</th><th style=\"text-align:left\">Phase</th><th style=\"text-align:left\">Cost code</th></tr></thead>" +
    "<tbody>" + trs + "</tbody></table></div>" +
    (rows.length > 25 ? "<span class=\"hint\" style=\"margin:6px 0 0;display:block\">Showing the 25 most recent of " + fdnEsc(String(rows.length)) + " entries.</span>" : "") +
    (unposted > 0 ? "<span class=\"hint\" style=\"margin:6px 0 0;display:block\">⏱ = punched, awaiting payroll posting — hours are current, dollars aren't booked yet.</span>" : "");
}
