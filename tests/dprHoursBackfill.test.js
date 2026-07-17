"use strict";
/* Nightly DPR punch-hours backfill (foundation-sync.js action=dpr_hours_backfill).

   Mark: a foreman saves the daily before the crew's punches sync into
   Foundation; a scheduled 8 PM + just-after-midnight pass fills them in.

   What this pins down:
     1. THE GATE — same model as action=sync: cron secret or foundation.read
        human; everyone else opaque 401/403, nothing read or written.
     2. THE MANUAL-WINS RULE, server-side identical to the client
        (js/dpr.js): empty or foundation-sourced rows fill from punches; a
        hand-typed number NEVER moves; a hand-typed day total ("Hours
        Worked") survives unless it demonstrably was the derived crew sum.
     3. LOCKED REPORTS ARE NEVER TOUCHED — the sign-off lock is a promise.
     4. Coverage of Central today+yesterday; per-job+day Foundation reads are
        cached; dryRun writes nothing.

   firebase-admin (auth + a where()-capable fake Firestore) and mssql
   (pending punches + employee master) are stubbed; the real handler, query
   builders, and merge rules run end-to-end offline. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const SYNC_SECRET = "B".repeat(40);
const SQL_PASSWORD = "sql-pw-NEVER-LEAK-5678";
const OWNER = "OWNER_TOKEN";
const TECH = "FIELD_TECH_TOKEN";

const ROLE_DOCS = { field_tech: { permissions: { "foundation.read": false } } };

// ---- Fake Firestore with where() over daily_progress_reports. ----
let dprDocs = [];      // [{ id, data }]
const writes = [];     // [{ id, data, opts }]
const metaWrites = []; // meta doc sets
function makeDocSnap(d) {
  return {
    id: d.id,
    data: () => JSON.parse(JSON.stringify(d.data)),
    ref: { set: async (data, opts) => { writes.push({ id: d.id, data, opts }); } }
  };
}
const fakeFirestore = {
  collection: (col) => ({
    doc: (id) => ({
      get: async () => {
        if (col === "roles") { const d = ROLE_DOCS[id]; return d ? { exists: true, data: () => d } : { exists: false }; }
        return { exists: false };
      },
      set: async (data, opts) => { if (col === "foundation_sync_meta") metaWrites.push({ id, data, opts }); }
    }),
    where: (field, op, value) => ({
      get: async () => {
        assert.strictEqual(col, "daily_progress_reports");
        assert.strictEqual(field, "date");
        assert.strictEqual(op, "==");
        return { docs: dprDocs.filter((d) => d.data.date === value).map(makeDocSnap) };
      }
    })
  }),
  batch: () => ({ set() { return this; }, commit: async () => {} })
};

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === OWNER) return { uid: "u_owner", email: "owner@watkins.com", owner: true, role: "owner" };
        if (token === TECH) return { uid: "u_tech", email: "tech@watkins.com", owner: false, role: "field_tech" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() { return fakeFirestore; }
};

// ---- Fake mssql: grouped day-hours per job (pending has rows for all three
// jobs, so the his_timecard fallback never fires) + the employee master. ----
let sqlQueries = 0;
const PUNCHES = {
  "17355": [{ employee_no: "ABECHR ", hours: 12.42 }, { employee_no: "WALKEL ", hours: 12 }],
  "17300": [{ employee_no: "COOMIC ", hours: 1.73 }],
  "17312": [{ employee_no: "CHEJAM ", hours: 10.75 }]
};
const fakeMssql = {
  NVarChar: "NVARCHAR",
  ConnectionPool: function () {
    this.connect = async () => ({
      request: () => {
        const inputs = {};
        return {
          input(name, type, value) { inputs[name] = value; return this; },
          query: async (text) => {
            sqlQueries++;
            if (/dbo\.employees/.test(text)) {
              return { recordset: [
                { employee_no: "ABECHR ", first_name: "Christian", last_name: "Abernathy" },
                { employee_no: "WALKEL ", first_name: "Kelly", last_name: "Walker" },
                { employee_no: "COOMIC ", first_name: "Michael", last_name: "Cook" },
                { employee_no: "CHEJAM ", first_name: "James", last_name: "Cheek" }
              ] };
            }
            if (/pending_timecards/.test(text)) return { recordset: PUNCHES[inputs.job_no] || [] };
            if (/his_timecard/.test(text)) return { recordset: [] };
            return { recordset: [] };
          }
        };
      }
    });
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FB_ADMIN_BF";
  if (req === "mssql") return "FAKE_MSSQL_BF";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FB_ADMIN_BF"] = { id: "FAKE_FB_ADMIN_BF", filename: "FAKE_FB_ADMIN_BF", loaded: true, exports: fakeAdmin };
require.cache["FAKE_MSSQL_BF"] = { id: "FAKE_MSSQL_BF", filename: "FAKE_MSSQL_BF", loaded: true, exports: fakeMssql };

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.FOUNDATION_SQL_PASSWORD = SQL_PASSWORD;
process.env.FOUNDATION_SYNC_SECRET = SYNC_SECRET;

const sync = require("../netlify/functions/foundation-sync.js");
const fdb = require("../netlify/functions/lib/foundationDb.js");
const I = sync._internals;

function ev(opts) {
  opts = opts || {};
  const headers = { host: "dev--watkins.netlify.app" };
  if (opts.syncKey) headers["x-foundation-sync-key"] = opts.syncKey;
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  return { httpMethod: "POST", headers, body: JSON.stringify(opts.body || {}) };
}
function seed() {
  fdb._resetPoolForTest();
  writes.length = 0; metaWrites.length = 0; sqlQueries = 0;
  dprDocs = [
    { id: "dpr_a", data: { date: "2026-07-16", foundationJobNo: "17355", hoursWorked: "",
      crew: [
        { name: "Christian Abernathy", hours: "", hoursSource: "" },
        { name: "Kelly Walker", hours: "5", hoursSource: "" }          // hand-typed — must survive
      ] } },
    { id: "dpr_locked", data: { date: "2026-07-16", foundationJobNo: "17355",
      signoff: { signed: true, locked: true },
      crew: [{ name: "Christian Abernathy", hours: "", hoursSource: "" }] } },
    { id: "dpr_nojob", data: { date: "2026-07-16",
      crew: [{ name: "Kelly Walker", hours: "", hoursSource: "" }] } },
    { id: "dpr_manualtotal", data: { date: "2026-07-16", jobNo: "17312",
      crewHoursTotal: 14.5, hoursWorked: "20",                         // hand-typed day total
      crew: [{ name: "James Cheek", hours: "14.5", hoursSource: "foundation" }] } },
    { id: "dpr_prev", data: { date: "2026-07-15", foundationJobNo: "17300", hoursWorked: "",
      crew: [{ name: "Michael Cook", hours: "", hoursSource: "" }] } }
  ];
}
const DATES = ["2026-07-16", "2026-07-15"];

/* ============================ THE GATE ============================ */

test("no key + no token: dpr_hours_backfill is opaque 401, nothing read or written", async () => {
  seed();
  const r = await sync.handler(ev({ body: { action: "dpr_hours_backfill" } }));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(sqlQueries, 0);
});

test("signed-in tech WITHOUT foundation.read: 403, nothing read or written", async () => {
  seed();
  const r = await sync.handler(ev({ token: TECH, body: { action: "dpr_hours_backfill" } }));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(sqlQueries, 0);
});

/* ============================ THE BACKFILL ============================ */

test("cron key: fills empty rows from punches, keeps manual rows, updates totals, skips locked/no-job", async () => {
  seed();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: DATES } }));
  assert.strictEqual(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.seen, 5);
  assert.strictEqual(body.updated, 3);            // dpr_a, dpr_manualtotal, dpr_prev
  assert.strictEqual(body.skipped_locked, 1);
  assert.strictEqual(body.skipped_no_job, 1);
  assert.doesNotMatch(r.body, new RegExp(SQL_PASSWORD));
  assert.doesNotMatch(r.body, new RegExp(SYNC_SECRET));

  const byId = {};
  writes.forEach((w) => { byId[w.id] = w; });
  // dpr_a: Abernathy filled from the punch, Kelly's hand-typed 5 untouched
  const a = byId.dpr_a.data;
  assert.deepStrictEqual(a.crew[0], { name: "Christian Abernathy", hours: "12.42", hoursSource: "foundation" });
  assert.deepStrictEqual(a.crew[1], { name: "Kelly Walker", hours: "5", hoursSource: "" });
  assert.strictEqual(a.crewHoursTotal, 17.42);
  assert.strictEqual(a.hoursWorked, "17.42");     // was empty -> derived total
  assert.ok(a.hoursBackfilledAt > 0);
  assert.strictEqual(a.hoursBackfilledBy, "dpr-hours-backfill (scheduled)");
  assert.strictEqual(byId.dpr_a.opts.merge, true);
  // dpr_manualtotal: foundation-sourced row refreshes, hand-typed day total survives
  const m = byId.dpr_manualtotal.data;
  assert.strictEqual(m.crew[0].hours, "10.75");
  assert.strictEqual(m.crewHoursTotal, 10.75);
  assert.strictEqual(m.hoursWorked, "20", "a hand-typed day total must never be rewritten");
  // dpr_prev (yesterday): filled too
  assert.strictEqual(byId.dpr_prev.data.crew[0].hours, "1.73");
  // locked + no-job docs were never written
  assert.ok(!byId.dpr_locked, "a locked report must never be written");
  assert.ok(!byId.dpr_nojob);
  // meta doc recorded the run
  assert.ok(metaWrites.some((w) => w.id === "dpr_hours_backfill_last"));
});

test("a second report on the same job+day reuses the cached Foundation read", async () => {
  seed();
  dprDocs.push({ id: "dpr_b", data: { date: "2026-07-16", foundationJobNo: "17355", hoursWorked: "",
    crew: [{ name: "Kelly Walker", hours: "", hoursSource: "" }] } });
  await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"] } }));
  // 17355 queried once (pending) + 17312 once (pending) + employees once = 3
  assert.strictEqual(sqlQueries, 3, "per-job+day punch reads must be cached across reports");
});

test("dryRun reports what it would do and writes nothing", async () => {
  seed();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: DATES, dryRun: true } }));
  const body = JSON.parse(r.body);
  assert.strictEqual(body.dryRun, true);
  assert.strictEqual(body.updated, 3);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(metaWrites.length, 0);
});

test("bad explicit dates are rejected with 400 before any work", async () => {
  seed();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["tomorrow", "07/16/2026"] } }));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(sqlQueries, 0);
});

/* ============================ PURE RULES ============================ */

test("centralDates: today + yesterday in America/Chicago (the midnight pass closes out the day)", () => {
  // 2026-07-17 02:00 UTC = 2026-07-16 9 PM CDT
  assert.deepStrictEqual(I.centralDates(new Date("2026-07-17T02:00:00Z")), ["2026-07-16", "2026-07-15"]);
  // 2026-07-17 05:10 UTC = 12:10 AM CDT on the 17th -> covers the 16th as "yesterday"
  assert.deepStrictEqual(I.centralDates(new Date("2026-07-17T05:10:00Z")), ["2026-07-17", "2026-07-16"]);
});

test("applyPunchesToCrew: fill rules mirror the client exactly", () => {
  const byName = { "christian abernathy": 12.42 };
  // empty -> fill
  let r = I.applyPunchesToCrew([{ name: "Christian Abernathy", hours: "", hoursSource: "" }], byName);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.crew[0].hours, "12.42");
  // hand-typed -> never move
  r = I.applyPunchesToCrew([{ name: "Christian Abernathy", hours: "8", hoursSource: "" }], byName);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.crew[0].hours, "8");
  // stale auto-fill -> refresh
  r = I.applyPunchesToCrew([{ name: "Christian Abernathy", hours: "4", hoursSource: "foundation" }], byName);
  assert.strictEqual(r.crew[0].hours, "12.42");
  // already current -> unchanged
  r = I.applyPunchesToCrew([{ name: "Christian Abernathy", hours: "12.42", hoursSource: "foundation" }], byName);
  assert.strictEqual(r.changed, false);
  // "Last, First" folding matches
  r = I.applyPunchesToCrew([{ name: "Abernathy, Christian", hours: "", hoursSource: "" }], byName);
  assert.strictEqual(r.crew[0].hours, "12.42");
  // input rows are never mutated
  const input = [{ name: "Christian Abernathy", hours: "", hoursSource: "" }];
  I.applyPunchesToCrew(input, byName);
  assert.strictEqual(input[0].hours, "");
});

test("newHoursWorked: empty or derived totals update; a different hand-typed total survives", () => {
  assert.strictEqual(I.newHoursWorked("", 0, 17.42), "17.42");
  assert.strictEqual(I.newHoursWorked("14.5", 14.5, 17.42), "17.42");  // was the derived sum
  assert.strictEqual(I.newHoursWorked("20", 14.5, 17.42), "20");        // deliberate — keep
});
