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

// Records a signed-report hours amendment to audit_logs, matching the app's
// existing writer shape (admin.js writeAuditLog). Actor is the sync itself
// (no human uid on the cron path); best-effort — a failed audit write must
// not fail the amendment, but it IS logged so a missing trail is visible.
async function writeHoursAmendAudit(db, entry) {
  try {
    await db.collection("audit_logs").doc().set({
      ts: entry.ts,
      actorUid: null,
      actorEmail: null,
      actorRole: "system",
      actorMethod: "system-sync",
      actorLabel: entry.actor,
      action: "dpr_hours_amended_signed",
      target: entry.target,
      before: entry.before,
      after: entry.after
    });
  } catch (e) {
    console.error("dpr_hours_backfill: audit_log write failed for", entry.target, e && e.message ? e.message : e);
  }
}

// ---------------------------------------------------------------------
// Signed-amendment notification (Mark: email the admin + the recorded PM
// when a signed DPR's hours are amended).
// ---------------------------------------------------------------------
// Admin recipient: DPR_AMEND_NOTIFY_EMAIL (defaults to marks@watkinsroofing.net).
// PM recipient: the DPR's Foundation job carries a PM CODE (project_manager_no,
// e.g. "NATE"), not an email — DPR_PM_EMAILS is a JSON map {CODE: email} that
// resolves it. SAFE DEFAULT: with no map (or no entry for this code), the PM
// is simply not emailed — the admin still is, and the PM code is named in the
// body — so a missing map never sends mail to the wrong person.
function resolvePmEmail(pmCode) {
  const code = String(pmCode == null ? "" : pmCode).trim();
  if (!code) return "";
  let map = null;
  try { map = JSON.parse(process.env.DPR_PM_EMAILS || "{}"); }
  catch (e) { return ""; } // a malformed map resolves to nobody, never guesses
  if (!map || typeof map !== "object") return "";
  // case-insensitive code match
  const wantLc = code.toLowerCase();
  for (const k of Object.keys(map)) {
    if (String(k).trim().toLowerCase() === wantLc) {
      const v = String(map[k] || "").trim();
      return /.+@.+\..+/.test(v) ? v : "";
    }
  }
  return "";
}

// Builds the amendment email (pure — unit-tested). Hours only; no pay data.
function buildAmendEmail(ctx) {
  const jobLabel = [ctx.jobName, ctx.jobNo ? "#" + ctx.jobNo : ""].filter(Boolean).join(" ");
  const subject = ("[RoofOps] Signed DPR hours amended — " + (jobLabel || "job") + " · " + (ctx.date || "")).slice(0, 200);
  const fmtCrew = function (snap) {
    const rows = (snap && snap.crew) || [];
    if (!rows.length) return "  (none)";
    return rows.map(function (c) { return "  " + c.name + ": " + (c.hours === "" ? "—" : c.hours) + " hr"; }).join("\n");
  };
  const pmLine = ctx.pmEmail
    ? "Project manager: " + (ctx.pmCode || "") + " <" + ctx.pmEmail + ">"
    : "Project manager: " + (ctx.pmCode ? ctx.pmCode + " (no email on file — add to DPR_PM_EMAILS to notify them directly)" : "(none on the job)");
  const lines = [
    "A SIGNED Daily Progress Report had its hours amended by the nightly Foundation time-clock sync.",
    "The signature/sign-off is unchanged; this is a corrective update, and it is recorded in the audit log.",
    "",
    "Job: " + (jobLabel || "(unknown)"),
    "Date: " + (ctx.date || ""),
    "Foreman: " + (ctx.foreman || "(not recorded)"),
    pmLine,
    "Amended: " + (ctx.note || ""),
    "",
    "Hours before:",
    "  Total: " + (ctx.before && ctx.before.hoursWorked ? ctx.before.hoursWorked : "—"),
    fmtCrew(ctx.before),
    "",
    "Hours after:",
    "  Total: " + (ctx.after && ctx.after.hoursWorked ? ctx.after.hoursWorked : "—"),
    fmtCrew(ctx.after),
    "",
    "— RoofOps (automated). Reply-to is unmonitored; open the report in the app to review."
  ];
  return { subject: subject, text: lines.join("\n") };
}

// Sends the amendment notice via Resend (same shape as send-workorder.js /
// send-feedback.js). Best-effort: a mail failure NEVER fails the amendment —
// the corrected hours + audit_logs entry are the source of truth. Returns a
// small result for the run summary. Never called on dryRun.
async function sendAmendNotification(ctx) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: 0, skipped: "no RESEND_API_KEY" };
  const adminTo = String(process.env.DPR_AMEND_NOTIFY_EMAIL || "marks@watkinsroofing.net").trim();
  const pmEmail = resolvePmEmail(ctx.pmCode);
  ctx.pmEmail = pmEmail;
  const to = [];
  if (adminTo) to.push(adminTo);
  if (pmEmail && pmEmail.toLowerCase() !== adminTo.toLowerCase()) to.push(pmEmail);
  if (!to.length) return { sent: 0, skipped: "no recipients" };
  const from = process.env.FROM_EMAIL || "Watkins Roofing Work Orders <workorders@watkinsroofing.net>";
  const mail = buildAmendEmail(ctx);
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: to, subject: mail.subject, text: mail.text })
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error("dpr_hours_backfill: amend email rejected:", resp.status, body.slice(0, 200));
      return { sent: 0, error: "resend " + resp.status };
    }
    return { sent: to.length, to: to };
  } catch (e) {
    console.error("dpr_hours_backfill: amend email failed:", e && e.message ? e.message : e);
    return { sent: 0, error: "exception" };
  }
}

// A compact before/after snapshot for the audit trail — hours only, never
// any pay/PII. Used when a SIGNED report is amended so the change to a
// finalized record is provable.
function hoursSnapshot(crew, crewHoursTotal_, hoursWorked) {
  return {
    hoursWorked: String(hoursWorked == null ? "" : hoursWorked),
    crewHoursTotal: (typeof crewHoursTotal_ === "number" ? crewHoursTotal_ : null),
    crew: (crew || []).filter(function (c) { return String((c && c.name) || "").trim(); })
      .map(function (c) { return { name: String(c.name).trim(), hours: String(c.hours == null ? "" : c.hours) }; })
  };
}

async function backfillDprHours(opts) {
  const dates = (opts.dates && opts.dates.length) ? opts.dates : centralDates(new Date());
  const db = getDb(opts.hostname);
  const summary = {
    ok: true, action: "dpr_hours_backfill", dryRun: !!opts.dryRun, dates: dates,
    // amended_signed = signed/locked reports corrected with late hours (Mark's
    // AMEND decision — the signature is kept, an audit note + audit_log record
    // the change). updated = unsigned reports filled normally.
    seen: 0, updated: 0, amended_signed: 0, unchanged: 0, skipped_no_job: 0, no_punches: 0, errors: 0,
    amend_emails_sent: 0
  };
  const punchCache = {}; // "jobNo|date" -> byName (one Foundation read per job+day)
  const pmCache = {};    // jobNo -> Foundation PM code (project_manager_no from the jobs cache)
  for (const date of dates) {
    const qs = await db.collection(DPR_COLLECTION).where("date", "==", date).get();
    for (const docSnap of qs.docs) {
      summary.seen++;
      const r = docSnap.data() || {};
      const isSigned = !!(r.signoff && r.signoff.locked);
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
        if (isSigned) {
          // AMEND a signed report transparently: keep signoff intact, append a
          // dated amendment note (rendered on the DPR + PDF), and write an
          // audit_logs entry with before/after hours. Never silent.
          const note = "Hours amended " + String(opts.nowIso || "").slice(0, 10) +
            " — late Foundation timecard entries";
          const prior = Array.isArray(r.hoursAmendments) ? r.hoursAmendments : [];
          update.hoursAmendments = prior.concat([{ at: opts.nowMs, note: note, by: opts.actor }]);
          update.hoursAmendedAt = opts.nowMs;
          if (!opts.dryRun) {
            await docSnap.ref.set(update, { merge: true });
            await writeHoursAmendAudit(db, {
              target: docSnap.id, actor: opts.actor, ts: opts.nowMs,
              before: hoursSnapshot(r.crew, oldTotal, r.hoursWorked),
              after: hoursSnapshot(res.crew, newTotal, update.hoursWorked)
            });
            // Notify the admin + the recorded PM (Mark's ask). The PM CODE
            // comes from the linked Foundation job (jobs cache), resolved to
            // an email via DPR_PM_EMAILS; best-effort, a mail failure never
            // fails the amendment.
            let pmCode = pmCache[jobNo];
            if (pmCode === undefined) {
              pmCode = "";
              try {
                const jsnap = await db.collection(JOBS_COLLECTION).doc(safeDocId(jobNo)).get();
                if (jsnap.exists) pmCode = String((jsnap.data() || {}).project_manager_no || "").trim();
              } catch (e) { /* no PM code — admin still notified */ }
              pmCache[jobNo] = pmCode;
            }
            const mailRes = await sendAmendNotification({
              docId: docSnap.id, jobNo: jobNo, jobName: r.jobName || "", date: date,
              foreman: r.foreman || "", pmCode: pmCode, note: note,
              before: hoursSnapshot(r.crew, oldTotal, r.hoursWorked),
              after: hoursSnapshot(res.crew, newTotal, update.hoursWorked)
            });
            summary.amend_emails_sent += (mailRes && mailRes.sent) || 0;
          }
          summary.amended_signed++;
        } else {
          if (!opts.dryRun) await docSnap.ref.set(update, { merge: true });
          summary.updated++;
        }
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
  hoursSnapshot, resolvePmEmail, buildAmendEmail, backfillDprHours, DPR_COLLECTION
};
