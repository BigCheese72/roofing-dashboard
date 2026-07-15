"use strict";
/* Foundation (construction accounting) read-only connector — Phase 1.

   Two things this file pins down, because getting either wrong is how this
   integration hurts Watkins:

     1. THE GATE. Foundation is admin-grade accounting data (customers, PMs,
        contract values, employee hours). Every action must be behind the
        foundation.read PERMISSION -- not mere authentication -- and there
        must be NO unauthenticated/unauthorized path, including the
        unknown-action branch. A caller with no token gets 401; a signed-in
        user WITHOUT foundation.read (a plain field tech) gets 403; the DB
        is never touched in either case.

     2. READ-ONLY + LEAST PRIVILEGE + THE CHAR GOTCHA. Every query is a
        SELECT; pay columns (amount/pay_rate) never appear in the hours SQL
        or the mapped output; job_no is matched with LTRIM(RTRIM()) on BOTH
        sides so a padded CHAR job_no still finds its labor rows; and the
        secret password never leaks into a response body.

   firebase-admin AND mssql are both stubbed, so this runs offline with no
   credentials, no driver connection, and no secrets. The fake mssql driver
   lets the real query builders + row mappers run end-to-end through the
   handler against canned rows -- so a 200 here exercises the actual SQL
   text and mapping, not a shortcut. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// ---- The secret. If this string ever shows up in a response body, the
// connector is leaking the password and the test fails loudly. ----
const FAKE_PASSWORD = "s3cr3t-foundation-pw-NEVER-LEAK";

// ---- Fake firebase-admin (identity + live roles doc), same shape as
// tests/functionsAuth.test.js. Only the sentinel tokens verify. ----
const OWNER = "OWNER_TOKEN";
const SM = "SERVICE_MANAGER_TOKEN";     // has foundation.read via role doc
const TECH = "FIELD_TECH_TOKEN";        // signed in, but NO foundation.read

// Live roles/{roleId} docs requirePermission() reads server-side.
const ROLE_DOCS = {
  service_manager: { permissions: { "foundation.read": true } },
  field_tech: { permissions: { "foundation.read": false } }
};

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === OWNER) return { uid: "u_owner", email: "owner@watkins.com", owner: true, role: "owner" };
        if (token === SM) return { uid: "u_sm", email: "sm@watkins.com", owner: false, role: "service_manager" };
        if (token === TECH) return { uid: "u_tech", email: "tech@watkins.com", owner: false, role: "field_tech" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() {
    return {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => {
            const d = name === "roles" ? ROLE_DOCS[id] : undefined;
            return d ? { exists: true, data: () => d } : { exists: false };
          }
        })
      })
    };
  }
};

// ---- Fake mssql driver. Records what the handler asked for, and answers
// with canned recordsets keyed off the SQL text (jobs vs timecard). ----
const dbCalls = []; // every { text, inputs } that reached the "DB"
function makeFakeMssql() {
  const sql = {
    NVarChar: "NVARCHAR",
    VarChar: "VARCHAR",
    connectCount: 0,
    ConnectionPool: function (config) {
      // Assert the load-bearing connection facts as they flow through.
      assert.strictEqual(config.options.encrypt, false, "encrypt MUST be false");
      assert.strictEqual(config.options.trustServerCertificate, true, "trustServerCertificate must be true");
      assert.strictEqual(config.port, 9000, "port must be 9000");
      assert.strictEqual(config.password, FAKE_PASSWORD, "pool must receive the password from env");
      this.connect = async () => {
        sql.connectCount++;
        return {
          request: () => {
            const inputs = [];
            return {
              input(name, type, value) { inputs.push({ name, type, value }); return this; },
              query: async (text) => {
                dbCalls.push({ text, inputs });
                if (/his_timecard/.test(text)) {
                  return { recordset: [
                    { job_no: "17053", dated: new Date("2026-05-01T00:00:00Z"), employee_no: "E1 ", hours: 8, phase_no: "01 ", cost_code_no: "100 ", amount: 999, pay_rate: 55 },
                    { job_no: "17053", dated: new Date("2026-05-02T00:00:00Z"), employee_no: "E1 ", hours: 7.5, phase_no: "01 ", cost_code_no: "100 " }
                  ] };
                }
                // jobs
                return { recordset: [
                  { job_no: "17053     ", job_number: "17053", description: "CPS Smithton MS FACS Renovation", job_status: "A", customer_no: "GBHBLD", project_manager_no: "NATE", address_1: "1 Main", city: "Smithton", state: "IL", zip_code: "62285", job_location: "", original_contract: 4200, job_start_date: new Date("2026-01-02T00:00:00Z"), completion_date: null }
                ] };
              }
            };
          }
        };
      };
    }
  };
  return sql;
}

// Wire both stubs into the module loader BEFORE requiring the code.
const fakeMssql = makeFakeMssql();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FB_ADMIN";
  if (req === "mssql") return "FAKE_MSSQL";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FB_ADMIN"] = { id: "FAKE_FB_ADMIN", filename: "FAKE_FB_ADMIN", loaded: true, exports: fakeAdmin };
require.cache["FAKE_MSSQL"] = { id: "FAKE_MSSQL", filename: "FAKE_MSSQL", loaded: true, exports: fakeMssql };

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.FOUNDATION_SQL_PASSWORD = FAKE_PASSWORD;

const foundation = require("../netlify/functions/foundation.js");
const fdb = require("../netlify/functions/lib/foundationDb.js");

function ev(token, qs) {
  const headers = { host: "dev--watkins.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: "GET", headers, queryStringParameters: qs || {} };
}

const ACTIONS = [
  { action: "jobs" },
  { action: "jobs", search: "smithton" },
  { action: "job_hours", job_no: "17053" },
  { action: "bogus" },
  {}
];

/* ============================ THE GATE ============================ */

test("no token / garbage token: every action 401, DB never touched", async () => {
  for (const token of [null, "garbage.token"]) {
    for (const qs of ACTIONS) {
      const before = dbCalls.length;
      const r = await foundation.handler(ev(token, qs));
      assert.strictEqual(r.statusCode, 401, `action ${qs.action || "(none)"} must 401 without a valid token`);
      assert.strictEqual(dbCalls.length, before, "DB must not be queried for an unauthenticated caller");
      assert.doesNotMatch(r.body, new RegExp(FAKE_PASSWORD), "password must never appear in a response");
    }
  }
});

test("signed-in user WITHOUT foundation.read (field tech): every action 403, DB never touched", async () => {
  for (const qs of ACTIONS) {
    const before = dbCalls.length;
    const r = await foundation.handler(ev(TECH, qs));
    assert.strictEqual(r.statusCode, 403, `action ${qs.action || "(none)"} must 403 for a user lacking foundation.read`);
    assert.strictEqual(dbCalls.length, before, "DB must not be queried for an unauthorized caller");
  }
});

test("auth runs BEFORE the env check: 401 even if the connector password is unset", async () => {
  const saved = process.env.FOUNDATION_SQL_PASSWORD;
  delete process.env.FOUNDATION_SQL_PASSWORD;
  try {
    const r = await foundation.handler(ev(null, { action: "jobs" }));
    assert.strictEqual(r.statusCode, 401, "an unauthenticated caller must not be able to tell a configured deploy from a misconfigured one");
  } finally {
    process.env.FOUNDATION_SQL_PASSWORD = saved;
  }
});

/* ==================== AUTHORIZED, END-TO-END ==================== */

test("owner: action=jobs returns active jobs with description mapped to name (incl. Smithton)", async () => {
  const r = await foundation.handler(ev(OWNER, { action: "jobs" }));
  assert.strictEqual(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.jobs) && body.jobs.length >= 1);
  const smithton = body.jobs.find(j => j.job_no === "17053");
  assert.ok(smithton, "Smithton job 17053 must be present");
  assert.strictEqual(smithton.name, "CPS Smithton MS FACS Renovation", "description must map to name");
  assert.strictEqual(smithton.job_no, "17053", "padded CHAR job_no must be trimmed in output");
  assert.strictEqual(smithton.project_manager_no, "NATE");
  assert.doesNotMatch(r.body, new RegExp(FAKE_PASSWORD));
});

test("service_manager: action=job_hours returns trimmed rows + summed total, and NO pay data", async () => {
  const r = await foundation.handler(ev(SM, { action: "job_hours", job_no: "17053" }));
  assert.strictEqual(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.job_no, "17053");
  assert.strictEqual(body.total_hours, 15.5, "8 + 7.5 must sum to 15.5");
  assert.strictEqual(body.row_count, 2);
  assert.strictEqual(body.hours[0].employee_no, "E1", "employee_no must be trimmed");
  // Pay data must not survive into the response even though the fake row
  // carried amount/pay_rate.
  assert.doesNotMatch(r.body, /amount|pay_rate/i, "pay columns must never reach the response");
  assert.doesNotMatch(r.body, new RegExp(FAKE_PASSWORD));
});

test("the hours query actually used a trimmed match on both sides", async () => {
  await foundation.handler(ev(OWNER, { action: "job_hours", job_no: "  17053  " }));
  const hoursCall = dbCalls.filter(c => /his_timecard/.test(c.text)).pop();
  assert.ok(hoursCall, "an hours query must have run");
  assert.match(hoursCall.text, /LTRIM\(RTRIM\(job_no\)\)\s*=\s*@job_no/, "must trim BOTH sides of the job_no match");
  assert.strictEqual(hoursCall.inputs[0].value, "17053", "the bound job_no must be trimmed");
});

test("job_hours with a missing job_no is a 400, not a full-table scan", async () => {
  const r = await foundation.handler(ev(OWNER, { action: "job_hours" }));
  assert.strictEqual(r.statusCode, 400);
});

test("unknown action for an AUTHORIZED caller is 400 (and still hit no DB)", async () => {
  const before = dbCalls.length;
  const r = await foundation.handler(ev(OWNER, { action: "totally_bogus" }));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(dbCalls.length, before);
});

/* ============= PURE BUILDERS / MAPPERS (no DB, no driver) ============= */

test("buildConfig: encrypt=false, trustServerCertificate=true, port 9000, right host/db/user", () => {
  const cfg = fdb.buildConfig("pw");
  assert.strictEqual(cfg.options.encrypt, false);
  assert.strictEqual(cfg.options.trustServerCertificate, true);
  assert.strictEqual(cfg.port, 9000);
  assert.strictEqual(cfg.server, "sql.foundationsoft.com");
  assert.strictEqual(cfg.database, "Cas_10262");
  assert.strictEqual(cfg.user, "roofops");
});

test("buildJobsQuery: SELECT-only, active filter, no search => no bound params, no pay columns", () => {
  const q = fdb.buildJobsQuery();
  assert.match(q.text, /^SELECT/);
  assert.doesNotMatch(q.text, /INSERT|UPDATE|DELETE|DROP|EXEC/i);
  assert.match(q.text, /job_status = 'A'/);
  assert.strictEqual(q.inputs.length, 0);
  assert.doesNotMatch(q.text, /amount|pay_rate/i);
  assert.match(q.text, /description/, "job name column must be selected");
});

test("buildJobsQuery: search is parameter-bound (never concatenated) and wildcard-stripped", () => {
  const q = fdb.buildJobsQuery("50%_drop[hack]");
  assert.strictEqual(q.inputs.length, 1);
  assert.strictEqual(q.inputs[0].name, "search");
  assert.strictEqual(q.inputs[0].value, "%50drophack%", "LIKE metacharacters must be stripped from the term");
  assert.match(q.text, /LIKE @search/);
  assert.doesNotMatch(q.text, /50%_drop/, "raw search text must not appear in the SQL");
});

test("buildJobHoursQuery: trimmed match, parameter-bound job_no, ORDER BY dated, NO pay columns", () => {
  const q = fdb.buildJobHoursQuery("  17053  ");
  assert.match(q.text, /FROM dbo\.his_timecard/);
  assert.match(q.text, /LTRIM\(RTRIM\(job_no\)\)\s*=\s*@job_no/);
  assert.match(q.text, /ORDER BY dated/);
  assert.doesNotMatch(q.text, /amount|pay_rate/i);
  assert.strictEqual(q.inputs[0].value, "17053");
});

test("mapJobRow: description -> name and padded CHAR fields trimmed", () => {
  const m = fdb.mapJobRow({ job_no: "17053   ", job_number: "17053", description: "CPS Smithton", job_status: "A", customer_no: "GBHBLD ", project_manager_no: "NATE ", original_contract: 4200, job_start_date: new Date("2026-01-02T00:00:00Z"), completion_date: null });
  assert.strictEqual(m.job_no, "17053");
  assert.strictEqual(m.name, "CPS Smithton");
  assert.strictEqual(m.customer_no, "GBHBLD");
  assert.strictEqual(m.project_manager_no, "NATE");
  assert.strictEqual(m.original_contract, 4200);
  assert.strictEqual(m.completion_date, null);
  assert.match(m.job_start_date, /^2026-01-02/);
});

test("mapHoursRow: only the non-pay columns survive, even if a pay column rides along", () => {
  const m = fdb.mapHoursRow({ dated: new Date("2026-05-01T00:00:00Z"), employee_no: "E1 ", hours: 8, phase_no: "01", cost_code_no: "100", amount: 999, pay_rate: 55 });
  assert.deepStrictEqual(Object.keys(m).sort(), ["cost_code_no", "date", "employee_no", "hours", "phase_no"].sort());
  assert.strictEqual(m.employee_no, "E1");
  assert.strictEqual(m.hours, 8);
  assert.ok(!("amount" in m) && !("pay_rate" in m), "no pay field may exist on the mapped row");
});

test("sumHours: sums numeric hours and ignores null/garbage", () => {
  assert.strictEqual(fdb.sumHours([{ hours: 8 }, { hours: 7.5 }, { hours: null }, { hours: "x" }, {}]), 15.5);
  assert.strictEqual(fdb.sumHours([]), 0);
});

test("normalizeJobNo / normalizeSearch: trim, cap length, strip wildcards", () => {
  assert.strictEqual(fdb.normalizeJobNo("  17053  "), "17053");
  assert.strictEqual(fdb.normalizeJobNo(null), "");
  assert.strictEqual(fdb.normalizeSearch("  a%b_c[]  "), "abc");
  assert.strictEqual(fdb.normalizeSearch(undefined), "");
});
