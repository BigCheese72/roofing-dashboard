// Read-only connector to Foundation (construction accounting) — the
// FoundationSoft SQL Server that holds Watkins Roofing's jobs master and
// labor timecards. This is the ONE place that opens a database connection
// to Foundation; foundation.js (the deployed function) never touches
// `mssql` directly, it calls fetchJobs()/fetchJobHours() here.
//
// ---------------------------------------------------------------------
// HARD RULES (Phase 1 — the pull only)
// ---------------------------------------------------------------------
//  * READ-ONLY, ALWAYS. Every query in this file is a SELECT. Foundation
//    is Watkins' books of record — this integration must NEVER write to
//    it, and there is deliberately no INSERT/UPDATE/DELETE/exec path here.
//  * LEAST PRIVILEGE ON PAY DATA. dbo.his_timecard carries pay columns
//    (amount / pay_rate). Those are NEVER selected — the hours pull asks
//    only for the columns admin actually needs (dated, employee_no, hours,
//    phase_no, cost_code_no). Keeping pay out of the SQL means it can't be
//    leaked by a downstream mapping mistake.
//  * ONLY THE PASSWORD IS SECRET. server/port/database/user are fixed,
//    non-secret connection facts and are hardcoded below. The password is
//    read from FOUNDATION_SQL_PASSWORD (a Netlify secret env var) and is
//    never returned, thrown, or logged.
//
// ---------------------------------------------------------------------
// CONNECTION FACTS (validated live against the real Foundation server)
// ---------------------------------------------------------------------
//  * Driver: `mssql` (tedious — pure JS, no native build). Server
//    sql.foundationsoft.com on port 9000 (NOT the default 1433), database
//    Cas_10262, user roofops.
//  * encrypt MUST be FALSE. This is the one non-obvious, load-bearing
//    setting: with encrypt=true the connection hangs and TIMES OUT in the
//    post-login phase every single time; with encrypt=false it connects
//    instantly and reads fine. trustServerCertificate=true goes with it.
//    Do not "harden" this to encrypt=true — it does not work against this
//    server and will silently break the connector.
//  * Port 9000 is a non-HTTP TCP port. Whether a Netlify Function's
//    runtime can open an outbound TCP connection to it is the one real
//    unknown for this integration — see foundation.js and DEV_NOTES.md.
const FOUNDATION_SERVER = "sql.foundationsoft.com";
const FOUNDATION_PORT = 9000;
const FOUNDATION_DATABASE = "Cas_10262";
const FOUNDATION_USER = "roofops";

// Short timeouts on purpose: a read-only reporting pull should fail fast,
// not hold a Lambda open. If port 9000 is unreachable from the runtime we
// want a quick, clean error, not a 30s hang.
const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 15000;

// Builds the mssql config from the hardcoded facts + the secret password.
// Password is passed in (never read from process.env in this pure helper)
// so it can be unit-tested without touching the environment, and so the
// single env read lives in one obvious place in fetch* below.
function buildConfig(password) {
  return {
    server: FOUNDATION_SERVER,
    port: FOUNDATION_PORT,
    database: FOUNDATION_DATABASE,
    user: FOUNDATION_USER,
    password: password,
    options: {
      // See the encrypt note above — this pair is load-bearing.
      encrypt: false,
      trustServerCertificate: true
    },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 }
  };
}

// ---------------------------------------------------------------------
// Query builders (pure — unit-tested without a database)
// ---------------------------------------------------------------------
// Every builder returns { text, inputs } where inputs is an array of
// { name, value } bound as PARAMETERS (never string-concatenated into the
// SQL), so a search term or job number can never be SQL-injected. All are
// SELECT-only.

// Active jobs from the jobs master, newest-started first. Optional search
// matches the job number, the job name (description), or the customer.
// job_no is a CHAR column in Foundation — trim it on the way out so the
// value the app sees is clean (see the job_no padding gotcha below).
// `limit` controls the TOP clause: undefined/null keeps the default 500 cap
// (the interactive search action wants a bounded page), a positive number
// caps at that many (hard-ceilinged so a bad caller can't ask for millions),
// and 0/negative means NO cap — the nightly sync uses that to mirror EVERY
// active job into Firestore, since Watkins has more than 500 active jobs and
// the cached picker must see all of them.
function buildJobsQuery(search, limit) {
  const inputs = [];
  let where = "job_status = 'A'";
  const s = normalizeSearch(search);
  if (s) {
    inputs.push({ name: "search", value: "%" + s + "%" });
    where +=
      " AND (job_no LIKE @search OR job_number LIKE @search" +
      " OR description LIKE @search OR customer_no LIKE @search)";
  }
  const text =
    "SELECT " + topClause(limit) +
    " LTRIM(RTRIM(job_no)) AS job_no," +
    " LTRIM(RTRIM(job_number)) AS job_number," +
    " description," +
    " job_status," +
    " customer_no," +
    " project_manager_no," +
    " address_1," +
    " city," +
    " state," +
    " zip_code," +
    " job_location," +
    " original_contract," +
    " job_start_date," +
    " completion_date" +
    " FROM dbo.jobs" +
    " WHERE " + where +
    " ORDER BY job_start_date DESC";
  return { text: text, inputs: inputs };
}

// Labor timecard rows for one job. THE GOTCHA: job_no is a fixed-width
// CHAR column in Foundation, so "17053" stored as "17053     " will NOT
// equal a plain "17053" on the join — a naive match returns 0 rows for a
// job that clearly has labor. Both sides are LTRIM(RTRIM())'d so the match
// is on the logical value, not the padding. pay columns (amount/pay_rate)
// are deliberately absent — see the least-privilege rule at the top.
function buildJobHoursQuery(jobNo) {
  const trimmed = normalizeJobNo(jobNo);
  const text =
    "SELECT LTRIM(RTRIM(job_no)) AS job_no," +
    " dated," +
    " LTRIM(RTRIM(employee_no)) AS employee_no," +
    " hours," +
    " LTRIM(RTRIM(phase_no)) AS phase_no," +
    " LTRIM(RTRIM(cost_code_no)) AS cost_code_no" +
    " FROM dbo.his_timecard" +
    " WHERE LTRIM(RTRIM(job_no)) = @job_no" +
    " ORDER BY dated ASC";
  return { text: text, inputs: [{ name: "job_no", value: trimmed }] };
}

// ---------------------------------------------------------------------
// Normalizers + row mappers (pure)
// ---------------------------------------------------------------------
function normalizeSearch(search) {
  if (search === undefined || search === null) return "";
  // Cap length and strip SQL LIKE wildcards from the raw term so a caller
  // can't turn a search into a "%"-only match of the whole table (the
  // value is still parameter-bound; this is about semantics, not safety).
  return String(search).trim().slice(0, 100).replace(/[%_\[\]]/g, "");
}
function normalizeJobNo(jobNo) {
  if (jobNo === undefined || jobNo === null) return "";
  return String(jobNo).trim().slice(0, 40);
}
// Builds the SQL TOP clause from a limit. undefined/null -> "TOP 500" (the
// default page for the interactive search); a positive integer -> "TOP N"
// hard-ceilinged at MAX_JOBS_LIMIT so a caller can't request an absurd count;
// 0 or negative -> "" (no TOP, i.e. every matching row) for the full sync.
// Integer-coerced and clamped, so the value is never interpolated as raw
// caller text into the SQL.
const DEFAULT_JOBS_LIMIT = 500;
const MAX_JOBS_LIMIT = 20000;
function topClause(limit) {
  if (limit === undefined || limit === null) return "TOP " + DEFAULT_JOBS_LIMIT;
  const n = Math.floor(Number(limit));
  if (!isFinite(n) || n <= 0) return ""; // no cap — full sync
  return "TOP " + Math.min(n, MAX_JOBS_LIMIT);
}

// Maps a dbo.jobs row to the shape the app consumes. Foundation stores the
// job NAME in `description` — expose it as `name` (that rename is the whole
// point of the mapping; the app's job picker/WO auto-fill want a `name`).
function mapJobRow(row) {
  return {
    job_no: trimField(row.job_no),
    job_number: trimField(row.job_number),
    name: trimField(row.description),
    status: trimField(row.job_status),
    customer_no: trimField(row.customer_no),
    project_manager_no: trimField(row.project_manager_no),
    address: trimField(row.address_1),
    city: trimField(row.city),
    state: trimField(row.state),
    zip: trimField(row.zip_code),
    job_location: trimField(row.job_location),
    original_contract: toNumberOrNull(row.original_contract),
    job_start_date: toIsoOrNull(row.job_start_date),
    completion_date: toIsoOrNull(row.completion_date)
  };
}

// Maps a dbo.his_timecard row. NOTE the columns here are exactly the ones
// buildJobHoursQuery selected — no amount/pay_rate — so even if a pay
// column somehow rode along on the row object, it does not enter the API
// response through this mapper.
function mapHoursRow(row) {
  return {
    date: toIsoOrNull(row.dated),
    employee_no: trimField(row.employee_no),
    hours: toNumberOrNull(row.hours),
    phase_no: trimField(row.phase_no),
    cost_code_no: trimField(row.cost_code_no)
  };
}

// Sums hours defensively (Foundation hours are numeric, but a stray
// null/garbage value must not turn the total into NaN). Rounded to 2dp to
// avoid float noise like 40.00000001.
function sumHours(rows) {
  const total = (rows || []).reduce(function (acc, r) {
    const h = Number(r && r.hours);
    return acc + (isFinite(h) ? h : 0);
  }, 0);
  return Math.round(total * 100) / 100;
}

function trimField(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}
function toNumberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function toIsoOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------
// DB access (the only impure part — requires `mssql`, opens a pool)
// ---------------------------------------------------------------------
// A single pool per warm Lambda instance, created lazily on first use and
// reused across invocations. `mssql` is require()'d lazily INSIDE getPool()
// so that the pure builders/mappers above can be unit-tested by requiring
// this module without needing the driver present or a live server.
let poolPromise = null;
function getPool(password) {
  if (!poolPromise) {
    const sql = require("mssql");
    const pool = new sql.ConnectionPool(buildConfig(password));
    // If connect() fails, clear the cached promise so the next request
    // retries a fresh pool rather than re-await a permanently-rejected one.
    poolPromise = pool.connect().catch(function (e) {
      poolPromise = null;
      throw e;
    });
  }
  return poolPromise;
}

// Runs one { text, inputs } SELECT against Foundation and returns the raw
// recordset. password is required (the caller reads it from the env once);
// this throws a clear, password-free error if it's missing.
async function runSelect(password, query) {
  if (!password) {
    throw new Error("Foundation password is not configured.");
  }
  const sql = require("mssql");
  const pool = await getPool(password);
  const request = pool.request();
  (query.inputs || []).forEach(function (inp) {
    request.input(inp.name, sql.NVarChar, inp.value);
  });
  const result = await request.query(query.text);
  return (result && result.recordset) || [];
}

async function fetchJobs(password, search, limit) {
  const rows = await runSelect(password, buildJobsQuery(search, limit));
  return rows.map(mapJobRow);
}

// Projects a mapped job down to the fields that are safe + useful to mirror
// into the client-readable Firestore cache (foundation_jobs). Deliberately
// DROPS `original_contract` — the contract value is the one financially
// sensitive field on a job, the WO auto-fill doesn't need it, and the cache
// is readable by any signed-in user, so it stays server-only (still available
// to foundation.read holders via the live foundation.js connector). This is
// the single chokepoint deciding what leaves the server for the cache.
function mapJobForCache(job) {
  return {
    job_no: job.job_no,
    job_number: job.job_number,
    name: job.name,
    status: job.status,
    customer_no: job.customer_no,
    project_manager_no: job.project_manager_no,
    address: job.address,
    city: job.city,
    state: job.state,
    zip: job.zip,
    job_location: job.job_location,
    job_start_date: job.job_start_date,
    completion_date: job.completion_date
  };
}

// The unposted tail: pending_timecards rows for the job strictly AFTER the
// newest posted (his_timecard) date. Same columns/trim discipline as
// buildJobHoursQuery; `after` is optional (a job with no posted labor yet
// takes its whole pending history). Rows persist in pending after posting, so
// the strict `dated > @after` cutoff is what prevents double-counting a row
// that exists in both tables.
function buildPendingTailQuery(jobNo, afterIso) {
  const inputs = [{ name: "job_no", value: normalizeJobNo(jobNo) }];
  let where = "LTRIM(RTRIM(job_no)) = @job_no AND record_status = 'A'";
  if (afterIso) {
    inputs.push({ name: "after", value: afterIso });
    where += " AND dated > @after";
  }
  const text =
    "SELECT LTRIM(RTRIM(job_no)) AS job_no," +
    " dated," +
    " LTRIM(RTRIM(employee_no)) AS employee_no," +
    " hours," +
    " LTRIM(RTRIM(phase_no)) AS phase_no," +
    " LTRIM(RTRIM(cost_code_no)) AS cost_code_no" +
    " FROM dbo.pending_timecards" +
    " WHERE " + where +
    " ORDER BY dated ASC";
  return { text: text, inputs: inputs };
}

// Job labor = the posted record (his_timecard) PLUS the not-yet-posted tail
// from pending_timecards, so the card is CURRENT (punches land in pending days
// before payroll posts them — validated 2026-07-16: his stopped at 07-11 with
// punches in pending through 07-15). Names joined from the cached employee
// master. Response stays backward compatible (job_no/total_hours/row_count/
// hours[]); rows gain `name` + `posted`, and the posted/unposted split rides
// alongside so the UI can say what's still pending payroll.
async function fetchJobHours(password, jobNo) {
  const trimmed = normalizeJobNo(jobNo);
  const postedRows = await runSelect(password, buildJobHoursQuery(trimmed));
  const posted = postedRows.map(mapHoursRow);
  // Cutoff = newest posted date (ISO); pending rows after it are the fresh tail.
  let cutoff = null;
  posted.forEach(function (r) { if (r.date && (!cutoff || r.date > cutoff)) cutoff = r.date; });
  let unposted = [];
  try {
    const pendingRows = await runSelect(password, buildPendingTailQuery(trimmed, cutoff));
    unposted = pendingRows.map(mapHoursRow);
  } catch (e) {
    // The posted record still answers — a pending-tail failure must not take
    // the whole card down. Logged by the caller's generic handler if rethrown;
    // here we degrade to posted-only.
    unposted = [];
  }
  let names = {};
  if (posted.length || unposted.length) {
    try { names = await employeeNamesByNo(password); } catch (e) { names = {}; }
  }
  const decorate = function (isPosted) {
    return function (r) {
      r.name = names[r.employee_no] || "";
      r.posted = isPosted;
      return r;
    };
  };
  const hours = posted.map(decorate(true)).concat(unposted.map(decorate(false)));
  const unpostedTotal = sumHours(unposted);
  let unpostedThrough = null;
  unposted.forEach(function (r) { if (r.date && (!unpostedThrough || r.date > unpostedThrough)) unpostedThrough = r.date; });
  return {
    job_no: trimmed,
    total_hours: sumHours(hours),
    posted_hours: sumHours(posted),
    unposted_hours: unpostedTotal,
    unposted_through: unpostedThrough ? unpostedThrough.slice(0, 10) : null,
    row_count: hours.length,
    hours: hours
  };
}

// ---------------------------------------------------------------------
// Employee master + per-day punch hours (DPR crew-hours integration)
// ---------------------------------------------------------------------
// Schema facts (validated live via the temporary schema probe, 2026-07-16):
//  * dbo.employees — the employee master. 327 rows; employee_no is a 6-char
//    mnemonic CHAR (e.g. "ABECHR" = ABErnathy CHRistian), names live in
//    first_name / last_name, record_status = 'A' marks an active employee.
//    The table also carries pay/tax/PII columns — NEVER selected here; the
//    query asks for id + name + nothing else (least-privilege rule above).
//  * dbo.pending_timecards — the RAW pre-payroll time entry ledger (the daily
//    punches Braxton described). Same job/day/hours shape as dbo.his_timecard
//    (job_no CHAR w/ padding, dated datetime, hours numeric, multiple rows per
//    person per day across cost codes) PLUS raw start_time/end_time punches
//    and approval flags. Crucially it runs DAYS AHEAD of his_timecard:
//    validated 2026-07-16 with his_timecard MAX(dated)=07-11 (last payroll
//    posting) while pending_timecards had rows through 07-15. `hours` is
//    already the per-entry duration — no out-minus-in math needed; a person's
//    day is SUM(hours) over their rows. pay_rate/amount exist on this table
//    too and are NEVER selected.
//  * Day-hours strategy: read pending_timecards FIRST (fresh, covers the DPR
//    use case of "today's report"); fall back to his_timecard only when the
//    job+date has no pending rows. Never sum the two tables together — rows
//    persist in pending after posting, so a union would double-count.

// Active employees: id + name ONLY (no pay, no PII).
function buildEmployeesQuery() {
  const text =
    "SELECT LTRIM(RTRIM(employee_no)) AS employee_no," +
    " LTRIM(RTRIM(first_name)) AS first_name," +
    " LTRIM(RTRIM(last_name)) AS last_name" +
    " FROM dbo.employees" +
    " WHERE record_status = 'A'" +
    " ORDER BY last_name, first_name";
  return { text: text, inputs: [] };
}
function mapEmployeeRow(row) {
  const first = trimField(row.first_name), last = trimField(row.last_name);
  return {
    employee_no: trimField(row.employee_no),
    first_name: first,
    last_name: last,
    name: (first + " " + last).trim()
  };
}

// Per-employee summed hours for ONE job + ONE day, from one timecard table.
// `table` is chosen by fetchDayHours below — never by the caller — so only the
// two known table names can ever appear in the SQL. job_no gets the same
// LTRIM(RTRIM()) treatment as buildJobHoursQuery (CHAR padding gotcha), and
// `dated` is a midnight datetime so an exact half-open day window matches it
// regardless of any stray time-of-day component. record_status='A' skips
// voided/inactive entries. hours only — no pay columns, ever.
const DAY_HOURS_TABLES = ["pending_timecards", "his_timecard"];
function buildDayHoursQuery(table, jobNo, date) {
  if (DAY_HOURS_TABLES.indexOf(table) === -1) throw new Error("bad day-hours table");
  const text =
    "SELECT LTRIM(RTRIM(employee_no)) AS employee_no," +
    " SUM(hours) AS hours" +
    " FROM dbo." + table +
    " WHERE LTRIM(RTRIM(job_no)) = @job_no" +
    " AND record_status = 'A'" +
    " AND dated >= @day AND dated < DATEADD(day, 1, @day)" +
    " GROUP BY LTRIM(RTRIM(employee_no))" +
    " ORDER BY LTRIM(RTRIM(employee_no))";
  return {
    text: text,
    inputs: [
      { name: "job_no", value: normalizeJobNo(jobNo) },
      { name: "day", value: normalizeDay(date) }
    ]
  };
}
// A day parameter must be a plain YYYY-MM-DD — anything else is rejected
// before it reaches SQL (it's parameter-bound anyway; this is semantics).
function normalizeDay(date) {
  const s = String(date == null ? "" : date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  return s;
}

async function fetchEmployees(password) {
  const rows = await runSelect(password, buildEmployeesQuery());
  return rows.map(mapEmployeeRow);
}

// Employee-name lookup cached per warm Lambda (the master changes rarely and
// day_hours needs it on every call to turn employee_no into a display name).
let employeeCache = null; // { at: epoch-ms, byNo: { employee_no -> name } }
const EMPLOYEE_CACHE_MS = 10 * 60 * 1000;
async function employeeNamesByNo(password) {
  const now = Date.now();
  if (employeeCache && now - employeeCache.at < EMPLOYEE_CACHE_MS) return employeeCache.byNo;
  const employees = await fetchEmployees(password);
  const byNo = {};
  employees.forEach(function (e) { if (e.employee_no) byNo[e.employee_no] = e.name; });
  employeeCache = { at: now, byNo: byNo };
  return byNo;
}

// Per-employee hours for one job + one day, names joined from the master.
// pending_timecards first (pre-payroll — the fresh daily punches), falling
// back to his_timecard for days that pre-date what pending still holds.
async function fetchDayHours(password, jobNo, date) {
  const day = normalizeDay(date);
  const trimmedJob = normalizeJobNo(jobNo);
  if (!day) throw new Error("day_hours: bad date");
  let source = DAY_HOURS_TABLES[0];
  let rows = await runSelect(password, buildDayHoursQuery(source, trimmedJob, day));
  if (!rows.length) {
    source = DAY_HOURS_TABLES[1];
    rows = await runSelect(password, buildDayHoursQuery(source, trimmedJob, day));
  }
  const byNo = rows.length ? await employeeNamesByNo(password) : {};
  const out = rows.map(function (r) {
    const no = trimField(r.employee_no);
    return { employee_no: no, name: byNo[no] || "", hours: toNumberOrNull(r.hours) };
  });
  return {
    job_no: trimmedJob,
    date: day,
    source: source,
    total_hours: sumHours(out),
    rows: out
  };
}

// WHO punched on one job + one day — the roster subset of fetchDayHours.
// Hours are deliberately dropped at THIS layer (not the caller), so the
// dpr.create-gated action=day_crew can never leak them through a mapping
// mistake downstream. Same pending-first source logic.
async function fetchDayCrew(password, jobNo, date) {
  const dh = await fetchDayHours(password, jobNo, date);
  return {
    job_no: dh.job_no,
    date: dh.date,
    source: dh.source,
    crew: dh.rows.map(function (r) { return { employee_no: r.employee_no, name: r.name }; })
  };
}

// Test-only reset of the caches, so a unit test that stubs `mssql` isn't
// polluted by a pool/employee-map from a previous test.
function _resetPoolForTest() {
  poolPromise = null;
  employeeCache = null;
}

module.exports = {
  // pure helpers (unit-tested directly)
  buildConfig,
  buildJobsQuery,
  buildJobHoursQuery,
  normalizeSearch,
  normalizeJobNo,
  mapJobRow,
  mapJobForCache,
  mapHoursRow,
  sumHours,
  topClause,
  buildEmployeesQuery,
  buildDayHoursQuery,
  buildPendingTailQuery,
  normalizeDay,
  mapEmployeeRow,
  // DB-hitting API (used by foundation.js; DB stubbed in tests)
  fetchJobs,
  fetchJobHours,
  fetchEmployees,
  fetchDayHours,
  fetchDayCrew,
  _resetPoolForTest,
  // constants exposed for tests/assertions
  FOUNDATION_SERVER,
  FOUNDATION_PORT,
  FOUNDATION_DATABASE,
  FOUNDATION_USER
};
