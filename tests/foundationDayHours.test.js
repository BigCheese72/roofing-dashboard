"use strict";
/* Foundation employee master + per-day punch hours (DPR crew-hours).

   What this pins down (same stakes as tests/foundation.test.js):

     1. LEAST PRIVILEGE. The employees query selects id + name ONLY — the
        master carries pay/tax/PII columns and none of them may appear in the
        SQL. The day-hours query selects employee_no + SUM(hours) ONLY —
        pending_timecards carries pay_rate/amount and neither may appear.

     2. THE PRE-PAYROLL FALLBACK ORDER. Daily punches live in
        dbo.pending_timecards days before payroll posts them to
        dbo.his_timecard (validated live 2026-07-16: his stopped at 07-11,
        pending ran through 07-15). day_hours must read pending FIRST and
        fall back to his ONLY when pending has no rows for the job+day —
        and must never sum the two together (rows persist in pending after
        posting; a union double-counts).

     3. Identifier hygiene: the timecard table name is chosen server-side
        from a two-entry whitelist, job_no is trimmed on both sides (CHAR
        padding gotcha), the day is validated to YYYY-MM-DD, and both are
        parameter-bound.

   firebase-admin and mssql are stubbed exactly like tests/foundation.test.js
   so the real query builders and the real handler run offline. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const FAKE_PASSWORD = "s3cr3t-foundation-pw-NEVER-LEAK";
const OWNER = "OWNER_TOKEN";
const FOREMAN = "FOREMAN_TOKEN";   // dpr.create yes, foundation.read NO

const ROLE_DOCS = {
  field_tech: { permissions: { "dpr.create": true, "foundation.read": false } }
};

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === OWNER) return { uid: "u_owner", email: "owner@watkins.com", owner: true, role: "owner" };
        if (token === FOREMAN) return { uid: "u_foreman", email: "foreman@watkins.com", owner: false, role: "field_tech" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() {
    return { collection: (name) => ({ doc: (id) => ({ get: async () => {
      const d = name === "roles" ? ROLE_DOCS[id] : undefined;
      return d ? { exists: true, data: () => d } : { exists: false };
    } }) }) };
  }
};

// ---- Fake mssql: canned rows per table; a flag empties pending_timecards to
// exercise the his_timecard fallback. Records every query for assertions. ----
const dbCalls = [];
let pendingHasRows = true;
let postedHasRows = true;
function makeFakeMssql() {
  return {
    NVarChar: "NVARCHAR",
    ConnectionPool: function (config) {
      assert.strictEqual(config.password, FAKE_PASSWORD);
      this.connect = async () => ({
        request: () => {
          const inputs = [];
          return {
            input(name, type, value) { inputs.push({ name, type, value }); return this; },
            query: async (text) => {
              dbCalls.push({ text, inputs });
              if (/dbo\.employees/.test(text)) {
                return { recordset: [
                  { employee_no: "ABECHR ", first_name: " Christian", last_name: "Abernathy " },
                  { employee_no: "WALKEL ", first_name: "Kelly", last_name: "Walker" }
                ] };
              }
              // Grouped = the per-day SUM queries (action=day_hours); raw =
              // the per-entry ledger queries (action=job_hours blend).
              const grouped = /SUM\(hours\)/.test(text) && /GROUP BY/.test(text);
              if (/pending_timecards/.test(text)) {
                if (grouped) {
                  return { recordset: pendingHasRows ? [
                    { employee_no: "ABECHR ", hours: 8 },
                    { employee_no: "WALKEL ", hours: 7.5 },
                    { employee_no: "ZZGONE ", hours: 4 }   // not in the master — name unknown
                  ] : [] };
                }
                // raw pending tail (fresh punches after the posted cutoff)
                return { recordset: pendingHasRows ? [
                  { job_no: "17053", dated: new Date("2026-07-14T00:00:00Z"), employee_no: "ABECHR ", hours: 12.42, phase_no: "01 ", cost_code_no: "100 ", pay_rate: 55 }
                ] : [] };
              }
              if (/his_timecard/.test(text)) {
                if (grouped) return { recordset: [ { employee_no: "ABECHR ", hours: 6 } ] };
                // raw posted history (action=job_hours)
                return { recordset: postedHasRows ? [
                  { job_no: "17053", dated: new Date("2026-07-10T00:00:00Z"), employee_no: "ABECHR ", hours: 8, phase_no: "01 ", cost_code_no: "100 ", amount: 999 },
                  { job_no: "17053", dated: new Date("2026-07-11T00:00:00Z"), employee_no: "WALKEL ", hours: 7.5, phase_no: "01 ", cost_code_no: "100 " }
                ] : [] };
              }
              return { recordset: [] };
            }
          };
        }
      });
    }
  };
}

const fakeMssql = makeFakeMssql();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FB_ADMIN_DH";
  if (req === "mssql") return "FAKE_MSSQL_DH";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FB_ADMIN_DH"] = { id: "FAKE_FB_ADMIN_DH", filename: "FAKE_FB_ADMIN_DH", loaded: true, exports: fakeAdmin };
require.cache["FAKE_MSSQL_DH"] = { id: "FAKE_MSSQL_DH", filename: "FAKE_MSSQL_DH", loaded: true, exports: fakeMssql };

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.FOUNDATION_SQL_PASSWORD = FAKE_PASSWORD;

const foundation = require("../netlify/functions/foundation.js");
const fdb = require("../netlify/functions/lib/foundationDb.js");

function ev(token, qs) {
  const headers = { host: "dev--watkins.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: "GET", headers, queryStringParameters: qs || {} };
}
function fresh() { fdb._resetPoolForTest(); dbCalls.length = 0; pendingHasRows = true; postedHasRows = true; }

/* ==================== query builders (pure) ==================== */

test("buildEmployeesQuery: SELECT-only, active filter, id+name ONLY — no pay/PII columns", () => {
  const q = fdb.buildEmployeesQuery();
  assert.match(q.text, /^SELECT /);
  assert.match(q.text, /record_status = 'A'/);
  ["pay", "rate", "salar", "wage", "amount", "ssn", "birth", "address", "phone", "email", "bank", "marital"].forEach((bad) => {
    assert.ok(!new RegExp(bad, "i").test(q.text), "employees SQL must not touch: " + bad);
  });
  assert.strictEqual(q.inputs.length, 0);
});

test("buildDayHoursQuery: whitelisted table only — anything else throws", () => {
  assert.throws(() => fdb.buildDayHoursQuery("employees", "17053", "2026-07-16"), /bad day-hours table/);
  assert.throws(() => fdb.buildDayHoursQuery("pending_timecards; DROP TABLE x", "17053", "2026-07-16"), /bad day-hours table/);
  assert.doesNotThrow(() => fdb.buildDayHoursQuery("pending_timecards", "17053", "2026-07-16"));
  assert.doesNotThrow(() => fdb.buildDayHoursQuery("his_timecard", "17053", "2026-07-16"));
});

test("buildDayHoursQuery: trimmed job match, bound params, day window, SUM(hours), NO pay columns", () => {
  const q = fdb.buildDayHoursQuery("pending_timecards", "  17053 ", "2026-07-16");
  assert.match(q.text, /^SELECT /);
  assert.match(q.text, /LTRIM\(RTRIM\(job_no\)\) = @job_no/);
  assert.match(q.text, /dated >= @day AND dated < DATEADD\(day, 1, @day\)/);
  assert.match(q.text, /SUM\(hours\)/);
  assert.match(q.text, /GROUP BY/);
  assert.match(q.text, /record_status = 'A'/);
  assert.ok(!/pay_rate|amount/i.test(q.text), "day-hours SQL must not touch pay columns");
  assert.deepStrictEqual(q.inputs, [
    { name: "job_no", value: "17053" },
    { name: "day", value: "2026-07-16" }
  ]);
});

test("normalizeDay: YYYY-MM-DD only", () => {
  assert.strictEqual(fdb.normalizeDay(" 2026-07-16 "), "2026-07-16");
  assert.strictEqual(fdb.normalizeDay("07/16/2026"), "");
  assert.strictEqual(fdb.normalizeDay("2026-7-16"), "");
  assert.strictEqual(fdb.normalizeDay("2026-07-16'; DROP--"), "");
  assert.strictEqual(fdb.normalizeDay(null), "");
});

test("mapEmployeeRow: trims CHAR padding and composes the display name", () => {
  const e = fdb.mapEmployeeRow({ employee_no: "ABECHR ", first_name: " Christian", last_name: "Abernathy " });
  assert.deepStrictEqual(e, { employee_no: "ABECHR", first_name: "Christian", last_name: "Abernathy", name: "Christian Abernathy" });
});

/* ==================== handler: day_hours ==================== */

test("day_hours: pending_timecards rows win, names joined from the master, total summed", async () => {
  fresh();
  const res = await foundation.handler(ev(OWNER, { action: "day_hours", job_no: "17053", date: "2026-07-16" }));
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.source, "pending_timecards");
  assert.strictEqual(body.total_hours, 19.5);
  const byNo = {};
  body.rows.forEach((r) => { byNo[r.employee_no] = r; });
  assert.strictEqual(byNo.ABECHR.name, "Christian Abernathy");
  assert.strictEqual(byNo.ABECHR.hours, 8);
  assert.strictEqual(byNo.WALKEL.name, "Kelly Walker");
  assert.strictEqual(byNo.ZZGONE.name, "");   // unknown id -> empty name, row still returned
  // his_timecard must NOT have been queried — no union, no double count.
  assert.ok(!dbCalls.some((c) => /his_timecard/.test(c.text)), "must not touch his_timecard when pending has rows");
  assert.ok(!res.body.includes(FAKE_PASSWORD));
});

test("day_hours: empty pending falls back to his_timecard (source says so)", async () => {
  fresh();
  pendingHasRows = false;
  const res = await foundation.handler(ev(OWNER, { action: "day_hours", job_no: "17053", date: "2026-07-01" }));
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.source, "his_timecard");
  assert.strictEqual(body.total_hours, 6);
  assert.strictEqual(body.rows[0].name, "Christian Abernathy");
});

test("day_hours: missing job_no or bad date is a 400, DB untouched", async () => {
  fresh();
  const noJob = await foundation.handler(ev(OWNER, { action: "day_hours", date: "2026-07-16" }));
  assert.strictEqual(noJob.statusCode, 400);
  const badDate = await foundation.handler(ev(OWNER, { action: "day_hours", job_no: "17053", date: "tomorrow" }));
  assert.strictEqual(badDate.statusCode, 400);
  assert.strictEqual(dbCalls.length, 0);
});

test("day_hours: employee master is cached per warm instance (one master query across two calls)", async () => {
  fresh();
  await foundation.handler(ev(OWNER, { action: "day_hours", job_no: "17053", date: "2026-07-16" }));
  await foundation.handler(ev(OWNER, { action: "day_hours", job_no: "17053", date: "2026-07-15" }));
  const masterQueries = dbCalls.filter((c) => /dbo\.employees/.test(c.text));
  assert.strictEqual(masterQueries.length, 1);
});

/* ==================== handler: job_hours (posted + unposted blend) ==================== */

test("job_hours blends posted history with the unposted pending tail — names joined, flags set, totals split", async () => {
  fresh();
  const res = await foundation.handler(ev(OWNER, { action: "job_hours", job_no: "17053" }));
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.total_hours, 27.92);       // 8 + 7.5 posted, 12.42 punched
  assert.strictEqual(body.posted_hours, 15.5);
  assert.strictEqual(body.unposted_hours, 12.42);
  assert.strictEqual(body.unposted_through, "2026-07-14");
  assert.strictEqual(body.row_count, 3);
  assert.strictEqual(body.hours[0].posted, true);
  assert.strictEqual(body.hours[0].name, "Christian Abernathy");   // master join
  const tail = body.hours[body.hours.length - 1];
  assert.strictEqual(tail.posted, false);
  assert.strictEqual(tail.hours, 12.42);
  // Pay data on the fake rows must not survive into the response.
  assert.doesNotMatch(res.body, /pay_rate|amount/i);
  assert.ok(!res.body.includes(FAKE_PASSWORD));
});

test("the pending tail is cut off strictly AFTER the newest posted date (no double count)", async () => {
  fresh();
  await foundation.handler(ev(OWNER, { action: "job_hours", job_no: "17053" }));
  const tailCall = dbCalls.find((c) => /pending_timecards/.test(c.text) && !/SUM\(hours\)/.test(c.text));
  assert.ok(tailCall, "a pending-tail query must have run");
  assert.match(tailCall.text, /dated > @after/);
  assert.match(tailCall.text, /record_status = 'A'/);
  assert.ok(!/pay_rate|amount/i.test(tailCall.text), "tail SQL must not touch pay columns");
  const after = tailCall.inputs.find((i) => i.name === "after");
  assert.ok(after && after.value.startsWith("2026-07-11"), "cutoff must be the newest posted date");
});

test("a job with no posted history yet takes its whole pending ledger (no cutoff bound)", async () => {
  fresh();
  postedHasRows = false;
  const res = await foundation.handler(ev(OWNER, { action: "job_hours", job_no: "17053" }));
  const body = JSON.parse(res.body);
  assert.strictEqual(body.posted_hours, 0);
  assert.strictEqual(body.total_hours, 12.42);
  assert.ok(body.hours.every((h) => h.posted === false));
  const tailCall = dbCalls.find((c) => /pending_timecards/.test(c.text) && !/SUM\(hours\)/.test(c.text));
  assert.ok(!/dated > @after/.test(tailCall.text), "no cutoff clause without posted history");
  assert.ok(!tailCall.inputs.some((i) => i.name === "after"));
});

test("buildPendingTailQuery: trimmed job match, optional cutoff, SELECT-only, no pay columns", () => {
  const withAfter = fdb.buildPendingTailQuery(" 17053 ", "2026-07-11T00:00:00.000Z");
  assert.match(withAfter.text, /^SELECT /);
  assert.match(withAfter.text, /LTRIM\(RTRIM\(job_no\)\) = @job_no/);
  assert.match(withAfter.text, /dated > @after/);
  assert.strictEqual(withAfter.inputs.find((i) => i.name === "job_no").value, "17053");
  const noAfter = fdb.buildPendingTailQuery("17053", null);
  assert.ok(!/dated > @after/.test(noAfter.text));
  assert.ok(!/pay_rate|amount/i.test(withAfter.text));
});

/* ==================== handler: day_crew (names only, dpr.create gate) ==================== */

test("day_crew: a FOREMAN (dpr.create, no foundation.read) gets WHO punched — names only, never hours", async () => {
  fresh();
  const res = await foundation.handler(ev(FOREMAN, { action: "day_crew", job_no: "17053", date: "2026-07-16" }));
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.source, "pending_timecards");
  const names = body.crew.map((c) => c.name).filter(Boolean).sort();
  assert.deepStrictEqual(names, ["Christian Abernathy", "Kelly Walker"]);
  body.crew.forEach((c) => assert.deepStrictEqual(Object.keys(c).sort(), ["employee_no", "name"]));
  assert.ok(!/"hours"/.test(res.body), "day_crew must never carry hours");
  assert.ok(!/total_hours/.test(res.body));
});

test("the SAME foreman is still 403 on the hours actions — the widening is day_crew only", async () => {
  fresh();
  for (const qs of [
    { action: "day_hours", job_no: "17053", date: "2026-07-16" },
    { action: "job_hours", job_no: "17053" },
    { action: "employees" },
    { action: "jobs" }
  ]) {
    const res = await foundation.handler(ev(FOREMAN, qs));
    assert.strictEqual(res.statusCode, 403, (qs.action || "") + " must stay foundation.read-only");
  }
  assert.strictEqual(dbCalls.length, 0);
});

test("day_crew: missing job_no / bad date are 400s, DB untouched", async () => {
  fresh();
  assert.strictEqual((await foundation.handler(ev(OWNER, { action: "day_crew", date: "2026-07-16" }))).statusCode, 400);
  assert.strictEqual((await foundation.handler(ev(OWNER, { action: "day_crew", job_no: "17053", date: "junk" }))).statusCode, 400);
  assert.strictEqual(dbCalls.length, 0);
});

/* ==================== handler: employees ==================== */

test("employees: returns the mapped active roster (id + names only)", async () => {
  fresh();
  const res = await foundation.handler(ev(OWNER, { action: "employees" }));
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.employees.length, 2);
  assert.deepStrictEqual(Object.keys(body.employees[0]).sort(), ["employee_no", "first_name", "last_name", "name"]);
  assert.strictEqual(body.employees[0].name, "Christian Abernathy");
  assert.ok(!res.body.includes(FAKE_PASSWORD));
});

test("no token: employees + day_hours are 401 and the DB is never touched", async () => {
  fresh();
  for (const qs of [{ action: "employees" }, { action: "day_hours", job_no: "17053", date: "2026-07-16" }]) {
    const res = await foundation.handler(ev(null, qs));
    assert.strictEqual(res.statusCode, 401);
  }
  assert.strictEqual(dbCalls.length, 0);
});
