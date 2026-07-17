// Foundation → Firestore sync (Phase 2). Mirrors every active job
// from Foundation (construction accounting) into a client-readable Firestore
// cache (`foundation_jobs`), so the work-order job picker and auto-fill read
// a fast local collection instead of hitting the accounting DB on every
// keystroke. Read-only against Foundation; the ONLY writes are to Firestore.
//
// ---------------------------------------------------------------------
// WHO MAY CALL THIS — identity first, fail closed, key is NOT a skeleton.
// ---------------------------------------------------------------------
// Two, and only two, callers are allowed, decided BEFORE any Foundation read
// or Firestore write:
//   1. The automated scheduled caller — GitHub Actions cron (work-day hourly),
//      holding FOUNDATION_SYNC_SECRET in the `x-foundation-sync-key` header (secret in
//      a header, never the URL). Compared with a constant-time equality that
//      fails closed if the env var is unset or under 32 chars. This is the
//      SAME model as the inspection-report poller (.github/workflows/
//      poll-inspection-reports.yml + inspection-reports.js) — deliberately NOT
//      a Netlify Scheduled Function, because those carry no forgery-proof
//      signal and were removed after an anonymous-access incident (see
//      netlify.toml).
//   2. A signed-in human holding `foundation.read` — for an on-demand "sync
//      now". Verified via a real Firebase ID token; a plain signed-in user
//      without the permission gets 403.
// An unauthenticated caller gets an opaque 401 and learns nothing. And the
// sync key is scoped to the WHITELISTED scheduled actions ONLY (action=sync
// and action=dpr_hours_backfill) — anything else from the automated caller is
// refused (it is not a general-purpose credential).
//
// Foundation's password (FOUNDATION_SQL_PASSWORD) and the sync secret are
// never returned, thrown to the caller, or logged.
const crypto = require("crypto");
const { verifyCaller, getPermissionValue, getDb, hostnameFromEvent } = require("./lib/authGuard");
const foundationDb = require("./lib/foundationDb");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Opaque — an unauthenticated caller must not learn which actions exist, how
// this is configured, or whether the handler ran.
const UNAUTHORIZED = { error: "Unauthorized" };

// Firestore collections. Jobs cache is client-readable (rule: any signed-in
// user); meta holds the last run's summary for observability.
const JOBS_COLLECTION = "foundation_jobs";
const META_COLLECTION = "foundation_sync_meta";
const FIRESTORE_BATCH_LIMIT = 400; // under the hard 500-op batch ceiling

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  // Length is not secret (and timingSafeEqual throws on a length mismatch),
  // but the CONTENT comparison must not short-circuit on the first differing
  // byte — that is what leaks a secret one character at a time.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// The only non-human caller allowed in. Holds a secret Netlify has and the
// internet does not. Fails closed in every degenerate case: env var unset,
// env var too weak to be a real secret, header absent, header wrong.
const MIN_SYNC_KEY_LEN = 32;
function hasValidSyncKey(event) {
  const expected = process.env.FOUNDATION_SYNC_SECRET;
  if (!expected || String(expected).length < MIN_SYNC_KEY_LEN) return false;
  const h = (event && event.headers) || {};
  const given = h["x-foundation-sync-key"] || h["X-Foundation-Sync-Key"] || "";
  if (!given) return false;
  return timingSafeEqualStr(given, expected);
}

// Mirrors requirePermission() semantics without re-verifying the token:
// owner passes everything; otherwise the LIVE roles/{roleId} doc must grant
// the key unconditionally (=== true).
async function callerHas(caller, permKey) {
  if (!caller) return false;
  if (caller.owner) return true;
  return (await getPermissionValue(caller.role, permKey)) === true;
}

// The actual sync. Pulls EVERY active job (limit 0 = no TOP cap — Watkins has
// more than 500 active jobs), projects each to the client-safe cache shape
// (drops the contract value — see mapJobForCache), and upserts into
// foundation_jobs keyed on a safe doc id derived from job_no. dryRun reports
// what it would do and writes nothing. Returns a summary (never any pay or
// contract data).
async function syncActiveJobs(opts) {
  const password = opts.password;
  const dryRun = !!opts.dryRun;
  const nowIso = opts.nowIso; // injected so the write timestamp is testable
  const jobs = await foundationDb.fetchJobs(password, "", 0);

  if (dryRun) {
    return { ok: true, dryRun: true, action: "sync", active_jobs: jobs.length, would_write: jobs.length, actor: opts.actor };
  }

  const db = getDb(opts.hostname);
  const jobsCol = db.collection(JOBS_COLLECTION);
  let written = 0;
  const skipped = [];

  let batch = db.batch();
  let inBatch = 0;
  for (const job of jobs) {
    const id = safeDocId(job.job_no);
    if (!id) { skipped.push(job.job_no); continue; }
    const doc = foundationDb.mapJobForCache(job);
    doc.synced_at = nowIso;
    batch.set(jobsCol.doc(id), doc, { merge: true });
    written++;
    inBatch++;
    if (inBatch >= FIRESTORE_BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  // One meta doc records the run for observability (client/admin can show
  // "jobs last synced at ..."). Best-effort — a meta failure must not fail an
  // otherwise-successful sync of thousands of jobs.
  try {
    await db.collection(META_COLLECTION).doc("last").set({
      synced_at: nowIso,
      active_jobs: jobs.length,
      written: written,
      skipped: skipped.length,
      actor: opts.actor
    }, { merge: true });
  } catch (e) {
    console.error("foundation-sync: meta write failed (non-fatal):", e && e.message ? e.message : e);
  }

  return { ok: true, action: "sync", active_jobs: jobs.length, written: written, skipped: skipped.length };
}

// Firestore doc ids can't contain '/', can't be '.'/'..', and are capped in
// length. Job numbers are short and almost always [A-Za-z0-9-], but normalize
// defensively so a stray character can't break a write. The true job_no is
// also stored as a field, so the id format doesn't matter to readers.
function safeDocId(jobNo) {
  const s = String(jobNo == null ? "" : jobNo).trim();
  if (!s) return "";
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
}

// ---------------------------------------------------------------------
// DPR punch-hours backfill (Mark: "run them once at like 8pm every night for
// the day's reports submitted … the Time could fill in at Midnight also").
// ---------------------------------------------------------------------
// A foreman often saves the daily BEFORE the crew's punches have synced into
// Foundation (pending_timecards fills in batches through the evening). This
// scheduled pass revisits the day's saved reports and fills each crew
// member's punch hours in — with EXACTLY the client's manual-wins rule
// (js/dpr.js dprCrewHoursFillValue): only an empty value or a previous
// auto-fill is ever replaced; a hand-typed number never moves. Locked
// (signed) reports are never touched — the lock is a promise.

const DPR_COLLECTION = "daily_progress_reports";

// The run covers Central "today" AND "yesterday": the 8 PM pass fills today's
// reports; the just-after-midnight pass closes out the day that just ended
// (by then "today" has rolled over, so yesterday is the target).
function centralDates(now) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  const today = fmt.format(now);                                       // en-CA formats as YYYY-MM-DD
  const yesterday = fmt.format(new Date(now.getTime() - 24 * 3600 * 1000));
  return [today, yesterday];
}

// Same name key as the client (js/dpr.js dprNameKey): case/spacing-
// insensitive, folds "Last, First" to "first last".
function nameKey(s) {
  let t = String(s == null ? "" : s).trim();
  const parts = t.indexOf(",") > -1 ? t.split(",") : null;
  if (parts && parts.length === 2) t = parts[1].trim() + " " + parts[0].trim();
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Client's crew-hours total (js/dpr.js dprCrewHoursTotal): named rows only,
// garbage-proof, 2dp.
function crewHoursTotal(crew) {
  const total = (crew || []).reduce(function (acc, c) {
    if (!String((c && c.name) || "").trim()) return acc;
    const h = Number(c && c.hours);
    return acc + (isFinite(h) && h > 0 ? h : 0);
  }, 0);
  return Math.round(total * 100) / 100;
}

// Applies a day's punch totals ({nameKey -> hours}) to crew rows. Returns
// { crew, changed } — rows are copied, never mutated in place.
function applyPunchesToCrew(crew, byName) {
  let changed = false;
  const out = (crew || []).map(function (c) {
    const row = Object.assign({}, c);
    const k = nameKey(row.name);
    const punch = k ? byName[k] : undefined;
    if (punch == null) return row;
    const cur = String(row.hours == null ? "" : row.hours).trim();
    const isAuto = row.hoursSource === "foundation";
    if (cur !== "" && !isAuto) return row;          // hand-typed — never move
    const hs = String(punch);
    if (cur === hs && isAuto) return row;           // already current
    row.hours = hs;
    row.hoursSource = "foundation";
    changed = true;
    return row;
  });
  return { crew: out, changed: changed };
}

// The day's "Hours Worked" total follows the same never-stomp rule the client
// uses: replace it only when it's empty or it demonstrably WAS the derived
// crew sum (equals the old total) — a deliberately different hand-typed
// number (drive time on top of roof hours) survives.
function newHoursWorked(oldHoursWorked, oldTotal, newTotal) {
  const cur = String(oldHoursWorked == null ? "" : oldHoursWorked).trim();
  if (cur === "" || (oldTotal > 0 && cur === String(oldTotal))) return String(newTotal);
  return cur;
}

// Turns fetchDayHours rows into {nameKey -> hours} (accumulating rows that
// fold to the same person, mirroring the client's dprDayHoursByName).
function punchesByName(rows) {
  const byName = {};
  (rows || []).forEach(function (r) {
    const k = nameKey(r && r.name);
    const h = Number(r && r.hours);
    if (!k || !isFinite(h) || h <= 0) return;
    byName[k] = (byName[k] || 0) + h;
  });
  Object.keys(byName).forEach(function (k) { byName[k] = Math.round(byName[k] * 100) / 100; });
  return byName;
}

async function backfillDprHours(opts) {
  const dates = (opts.dates && opts.dates.length) ? opts.dates : centralDates(new Date());
  const db = getDb(opts.hostname);
  const summary = {
    ok: true, action: "dpr_hours_backfill", dryRun: !!opts.dryRun, dates: dates,
    seen: 0, updated: 0, unchanged: 0, skipped_locked: 0, skipped_no_job: 0, no_punches: 0, errors: 0
  };
  const punchCache = {}; // "jobNo|date" -> byName (one Foundation read per job+day)
  for (const date of dates) {
    const qs = await db.collection(DPR_COLLECTION).where("date", "==", date).get();
    for (const docSnap of qs.docs) {
      summary.seen++;
      const r = docSnap.data() || {};
      if (r.signoff && r.signoff.locked) { summary.skipped_locked++; continue; }
      const jobNo = String(r.foundationJobNo || r.jobNo || "").trim();
      if (!jobNo) { summary.skipped_no_job++; continue; }
      if (!(r.crew && r.crew.length)) { summary.unchanged++; continue; }
      try {
        const key = jobNo + "|" + date;
        let byName = punchCache[key];
        if (byName === undefined) {
          const dh = await foundationDb.fetchDayHours(opts.password, jobNo, date);
          byName = punchCache[key] = punchesByName(dh && dh.rows);
        }
        if (!Object.keys(byName).length) { summary.no_punches++; continue; }
        const res = applyPunchesToCrew(r.crew, byName);
        if (!res.changed) { summary.unchanged++; continue; }
        const oldTotal = (typeof r.crewHoursTotal === "number" && isFinite(r.crewHoursTotal))
          ? r.crewHoursTotal : crewHoursTotal(r.crew);
        const newTotal = crewHoursTotal(res.crew);
        const update = {
          crew: res.crew,
          crewHoursTotal: newTotal,
          hoursWorked: newHoursWorked(r.hoursWorked, oldTotal, newTotal),
          hoursBackfilledAt: opts.nowMs,
          hoursBackfilledBy: opts.actor
        };
        if (!opts.dryRun) await docSnap.ref.set(update, { merge: true });
        summary.updated++;
      } catch (e) {
        summary.errors++;
        console.error("dpr_hours_backfill: report " + docSnap.id + " failed:", e && e.message ? e.message : e);
      }
    }
  }
  // Observability meta doc, best-effort (same convention as the job sync).
  try {
    if (!opts.dryRun) {
      await db.collection(META_COLLECTION).doc("dpr_hours_backfill_last").set(
        Object.assign({ ran_at: opts.nowIso, actor: opts.actor }, summary), { merge: true });
    }
  } catch (e) {
    console.error("dpr_hours_backfill: meta write failed (non-fatal):", e && e.message ? e.message : e);
  }
  return summary;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }
  const action = body.action || "";

  // ---- IDENTITY FIRST. Automated caller, or a verified human. ----
  const isSyncCaller = hasValidSyncKey(event);
  let caller = null;
  if (!isSyncCaller) {
    try {
      caller = await verifyCaller(event);
    } catch (e) {
      // A genuine missing/invalid token → opaque 401 (leak nothing). A tripped
      // authGuard safety guard (cross-project misconfig) has no statusCode and
      // is surfaced as a 500 — that's an infra alarm, not a data path.
      if (e && e.statusCode === 401) return resp(401, UNAUTHORIZED);
      console.error("foundation-sync auth infrastructure failure:", e && e.message ? e.message : e);
      return resp(500, { error: "Service unavailable" });
    }
  }

  if (action === "sync") {
    // Human path must hold foundation.read; the automated caller is already
    // proven by its secret.
    if (!isSyncCaller && !(await callerHas(caller, "foundation.read"))) {
      return resp(403, { error: "Forbidden: missing permission foundation.read" });
    }
    const password = process.env.FOUNDATION_SQL_PASSWORD;
    if (!password) {
      return resp(500, { error: "FOUNDATION_SQL_PASSWORD is not set. Add it in Netlify > Environment variables, then redeploy." });
    }
    try {
      const result = await syncActiveJobs({
        password: password,
        dryRun: !!body.dryRun,
        hostname: hostnameFromEvent(event),
        nowIso: new Date().toISOString(),
        actor: isSyncCaller ? "foundation-sync (scheduled)" : (caller.email || caller.uid || "unknown")
      });
      return resp(200, result);
    } catch (e) {
      console.error("foundation-sync error:", e && e.message ? e.message : e);
      return resp(502, { error: "Foundation sync failed. See function logs." });
    }
  }

  if (action === "dpr_hours_backfill") {
    // Human path must hold foundation.read (punch hours are Foundation data);
    // the automated caller is already proven by its secret.
    if (!isSyncCaller && !(await callerHas(caller, "foundation.read"))) {
      return resp(403, { error: "Forbidden: missing permission foundation.read" });
    }
    const password = process.env.FOUNDATION_SQL_PASSWORD;
    if (!password) {
      return resp(500, { error: "FOUNDATION_SQL_PASSWORD is not set. Add it in Netlify > Environment variables, then redeploy." });
    }
    // Optional explicit dates (YYYY-MM-DD, validated, capped) for a manual
    // catch-up run; the scheduled caller sends none and gets today+yesterday.
    let dates = null;
    if (Array.isArray(body.dates)) {
      dates = body.dates.map(function (d) { return foundationDb.normalizeDay(d); }).filter(Boolean).slice(0, 7);
      if (!dates.length) return resp(400, { error: "No valid dates (want YYYY-MM-DD)" });
    }
    try {
      const result = await backfillDprHours({
        password: password,
        dryRun: !!body.dryRun,
        dates: dates,
        hostname: hostnameFromEvent(event),
        nowIso: new Date().toISOString(),
        nowMs: Date.now(),
        actor: isSyncCaller ? "dpr-hours-backfill (scheduled)" : (caller.email || caller.uid || "unknown")
      });
      return resp(200, result);
    } catch (e) {
      console.error("dpr_hours_backfill error:", e && e.message ? e.message : e);
      return resp(502, { error: "DPR hours backfill failed. See function logs." });
    }
  }

  // The sync key authorizes the whitelisted scheduled actions above ONLY — it
  // is not a skeleton key.
  if (isSyncCaller) return resp(403, { error: "Forbidden" });
  return resp(400, { error: "Unknown action" });
};

// Exposed for unit tests (pure/logic pieces) — the handler is the real entry.
exports._internals = {
  timingSafeEqualStr, hasValidSyncKey, safeDocId, syncActiveJobs, JOBS_COLLECTION, META_COLLECTION,
  centralDates, nameKey, crewHoursTotal, applyPunchesToCrew, newHoursWorked, punchesByName,
  backfillDprHours, DPR_COLLECTION
};
