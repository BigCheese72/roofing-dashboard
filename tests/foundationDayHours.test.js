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

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === OWNER) return { uid: "u_owner", email: "owner@watkins.com", owner: true, role: "owner" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() {
    return { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
  }
};

// ---- Fake mssql: canned rows per table; a flag empties pending_timecards to
// exercise the his_timecard fallback. Records every query for assertions. ----
const dbCalls = [];
let pendingHasRows = true;
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
              if (/pending_timecards/.test(text)) {
                return { recordset: pendingHasRows ? [
                  { employee_no: "ABECHR ", hours: 8 },
                  { employee_no: "WALKEL ", hours: 7.5 },
                  { employee_no: "ZZGONE ", hours: 4 }   // not in the master — name unknown
                ] : [] };
              }
              if (/his_timecard/.test(text)) {
                return { recordset: [ { employee_no: "ABECHR ", hours: 6 } ] };
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
function fresh() { fdb._resetPoolForTest(); dbCalls.length = 0; pendingHasRows = true; }

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
