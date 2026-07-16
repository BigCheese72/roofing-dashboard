// Foundation (construction accounting) read-only integration — Phase 1
// (connect + pull). Proxies a small, read-only slice of Watkins Roofing's
// FoundationSoft SQL Server (jobs master + labor timecards) to the app.
// Same guarded proxy pattern as companycam.js / outlook.js: the DB
// credential lives only in a Netlify env var, never in the browser or the
// repo, and every action is gated on a verified identity BEFORE anything
// else happens.
//
// ---------------------------------------------------------------------
// AUTH FIRST — Foundation data is admin-grade.
// ---------------------------------------------------------------------
// The jobs master exposes customers, PMs, contract values; the timecard
// pull exposes employee hours. That is company-internal accounting data,
// not a field operation, so unlike companycam.js (authentication-only,
// any signed-in tech) this endpoint is a PERMISSION gate:
// requirePermission(..., "foundation.read"). foundation.read is granted to
// owner/admin/service_manager/ops_manager in lib/permissions.js.
//
// The permission check runs as the very FIRST thing, ahead of the
// FOUNDATION_SQL_PASSWORD env read and ahead of the action dispatch —
// including the unknown-action branch. Same discipline as outlook.js: an
// unauthorized caller must get a 401/403, never a 500 that reveals whether
// the deploy is configured, and the endpoint's protection must not depend
// on being correctly configured. There is no unauthenticated path through
// this function.
//
// The password (FOUNDATION_SQL_PASSWORD) is never returned, thrown to the
// caller, or logged. On a DB error the caller gets a generic 502; the real
// error goes to the function logs (console.error) with no password in it.
const { requirePermission } = require("./lib/authGuard");
const foundationDb = require("./lib/foundationDb");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  // ---- PERMISSION GATE: first, for every method and every action. ----
  try {
    await requirePermission(event, "foundation.read");
  } catch (e) {
    // Mirror outlook.js: surface the guard's own status code (401 missing/
    // invalid token, 403 missing permission) with its message. A thrown
    // authGuard safety-guard error (cross-project misconfig) has no
    // statusCode and falls through to 500 here — the one case we DO want to
    // surface, since it's an infra misconfiguration, not a data leak.
    return resp(e.statusCode || 500, { error: e.message });
  }

  // Only AFTER auth do we look at whether the connector is configured.
  const password = process.env.FOUNDATION_SQL_PASSWORD;
  if (!password) {
    return resp(500, {
      error: "FOUNDATION_SQL_PASSWORD is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy."
    });
  }

  const p = event.queryStringParameters || {};
  const action = p.action || "jobs";

  try {
    if (action === "jobs") {
      // Active jobs from dbo.jobs, optional ?search= over job no / name /
      // customer. description is mapped to `name` in the connector.
      const jobs = await foundationDb.fetchJobs(password, p.search);
      return resp(200, { jobs: jobs });
    }

    if (action === "job_hours") {
      const jobNo = foundationDb.normalizeJobNo(p.job_no);
      if (!jobNo) return resp(400, { error: "Missing job_no" });
      // Labor rows from dbo.his_timecard (trimmed job_no match) + a summed
      // total. pay_rate/amount are never selected — admin-only hours, not
      // pay. See lib/foundationDb.js.
      const result = await foundationDb.fetchJobHours(password, jobNo);
      return resp(200, result);
    }

    if (action === "schema_probe") {
      // TEMPORARY (read-only): schema discovery for the DPR crew-hours
      // integration — employee master + raw daily punch table. Behind the
      // same foundation.read gate as everything else; the query shapes are
      // WHITELISTED in lib/foundationDb.js (no arbitrary SQL, identifiers
      // validated, pay/PII column names refused). REMOVE once
      // action=employees / action=day_hours ship.
      const rows = await foundationDb.runProbe(password, p);
      return resp(200, { rows: rows });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    // Never leak the password or raw driver internals to the caller. Log
    // the real error server-side (Netlify function logs) for diagnosis —
    // the password is not part of any error message this code constructs.
    console.error("foundation.js DB error:", e && e.message ? e.message : e);
    return resp(502, { error: "Foundation query failed. See function logs." });
  }
};

/* ============================================================
 * NOT BUILT YET — Phase 2, left as notes (per the DEV_NOTES/ROADMAP
 * convention of documenting what's next without building ahead of a real
 * spec). Phase 1 is the read-only pull only.
 *
 * Phase 2 — scheduled nightly sync + wiring into the app:
 *   - A scheduled Netlify function mirrors active jobs (this same
 *     fetchJobs()) into Firestore so the job picker / WO auto-fill read
 *     from a fast local cache, not a live DB call per keystroke.
 *   - WO auto-fill: selecting a Foundation job fills customer/PM/address
 *     from the mirrored job (map already exposes name/customer_no/
 *     project_manager_no/address).
 *   - DPR (Daily Progress Report): PM comes from project_manager_no;
 *     admin-only labor hours (fetchJobHours) surface on the WO for users
 *     who hold foundation.read.
 *   The clean hooks for all of this already exist: fetchJobs/fetchJobHours
 *   and the mappers in lib/foundationDb.js. Do not build the sync/writes
 *   here until Phase 2 is speced.
 * ============================================================ */
