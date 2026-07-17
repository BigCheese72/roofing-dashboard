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
const auditWrites = []; // audit_logs entries
let jobDocs = {};      // safeDocId(jobNo) -> foundation_jobs doc (carries project_manager_no)
const resendCalls = []; // captured Resend email payloads
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
        if (col === "foundation_jobs") { const d = jobDocs[id]; return d ? { exists: true, data: () => d } : { exists: false }; }
        return { exists: false };
      },
      set: async (data, opts) => {
        if (col === "foundation_sync_meta") metaWrites.push({ id, data, opts });
        else if (col === "audit_logs") auditWrites.push(data);
      }
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

// Capture Resend calls (the amend notification's only network use). The
// backfill otherwise hits mssql via the fake driver, so stubbing global.fetch
// only intercepts the email send.
global.fetch = async (url, opts) => {
  if (String(url).indexOf("api.resend.com") !== -1) {
    resendCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => "ok" };
  }
  throw new Error("unexpected fetch to " + url);
};

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
  writes.length = 0; metaWrites.length = 0; auditWrites.length = 0; sqlQueries = 0; resendCalls.length = 0;
  jobDocs = { "17355": { project_manager_no: "NATE" }, "17300": { project_manager_no: "" } };
  delete process.env.RESEND_API_KEY;
  delete process.env.DPR_PM_EMAILS;
  delete process.env.DPR_AMEND_NOTIFY_EMAIL;
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

test("cron key: fills empty rows, keeps manual, AMENDS signed reports, skips no-job", async () => {
  seed();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: DATES } }));
  assert.strictEqual(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.seen, 5);
  assert.strictEqual(body.updated, 3);            // dpr_a, dpr_manualtotal, dpr_prev (unsigned)
  assert.strictEqual(body.amended_signed, 1);     // dpr_locked (Mark's AMEND decision)
  assert.strictEqual(body.skipped_no_job, 1);
  assert.strictEqual(body.skipped_locked, undefined, "there is no skip-locked path anymore");
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
  assert.ok(!a.hoursAmendments, "an unsigned backfill is not an amendment");
  // dpr_manualtotal: foundation-sourced row refreshes, hand-typed day total survives
  const m = byId.dpr_manualtotal.data;
  assert.strictEqual(m.crew[0].hours, "10.75");
  assert.strictEqual(m.crewHoursTotal, 10.75);
  assert.strictEqual(m.hoursWorked, "20", "a hand-typed day total must never be rewritten");
  // dpr_prev (yesterday): filled too
  assert.strictEqual(byId.dpr_prev.data.crew[0].hours, "1.73");
  // dpr_locked: AMENDED, signature intact, dated note appended, merge write
  const L = byId.dpr_locked.data;
  assert.ok(L, "a signed report IS written (amended) now");
  assert.strictEqual(L.crew[0].hours, "12.42");
  assert.strictEqual(L.crewHoursTotal, 12.42);
  assert.strictEqual(byId.dpr_locked.opts.merge, true, "merge:true keeps the signature/sign-off intact");
  assert.ok(!("signoff" in L), "the amend write never touches signoff");
  assert.strictEqual(L.hoursAmendments.length, 1);
  assert.match(L.hoursAmendments[0].note, /^Hours amended \d{4}-\d{2}-\d{2} — late Foundation timecard entries$/);
  assert.ok(L.hoursAmendedAt > 0);
  // no-job doc never written
  assert.ok(!byId.dpr_nojob);
  // audit trail: exactly one audit_logs entry for the signed amendment, hours only
  assert.strictEqual(auditWrites.length, 1);
  const au = auditWrites[0];
  assert.strictEqual(au.action, "dpr_hours_amended_signed");
  assert.strictEqual(au.target, "dpr_locked");
  assert.strictEqual(au.actorRole, "system");
  assert.strictEqual(au.before.crew[0].hours, "");
  assert.strictEqual(au.after.crew[0].hours, "12.42");
  assert.strictEqual(au.after.hoursWorked, "12.42");
  assert.ok(!JSON.stringify(au).match(/pay|rate/i), "audit snapshot carries no pay data");
  // meta doc recorded the run
  assert.ok(metaWrites.some((w) => w.id === "dpr_hours_backfill_last"));
});

test("a signed report already carrying the current hours is unchanged — no re-amend, no new audit", async () => {
  seed();
  // pre-fill the locked report with the punch value it would receive
  dprDocs.find((d) => d.id === "dpr_locked").data.crew[0] =
    { name: "Christian Abernathy", hours: "12.42", hoursSource: "foundation" };
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: DATES } }));
  const body = JSON.parse(r.body);
  assert.strictEqual(body.amended_signed, 0, "no change -> no amendment");
  assert.strictEqual(auditWrites.length, 0, "no change -> no audit entry");
  assert.ok(!writes.some((w) => w.id === "dpr_locked"));
});

test("a prior amendment is preserved and the new one appended (trail grows, never overwrites)", async () => {
  seed();
  const locked = dprDocs.find((d) => d.id === "dpr_locked");
  locked.data.hoursAmendments = [{ at: 1, note: "Hours amended 2026-07-16 — late Foundation timecard entries", by: "x" }];
  await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"] } }));
  const w = writes.find((x) => x.id === "dpr_locked");
  assert.strictEqual(w.data.hoursAmendments.length, 2, "prior note kept, new one appended");
  assert.strictEqual(w.data.hoursAmendments[0].at, 1);
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

/* ============= SIGNED-AMEND NOTIFICATION (admin + recorded PM) ============= */

test("resolvePmEmail: maps a PM code case-insensitively; safe-empty otherwise", () => {
  process.env.DPR_PM_EMAILS = JSON.stringify({ NATE: "nate@watkinsroofing.net", PAT: "pat@watkinsroofing.net" });
  assert.strictEqual(I.resolvePmEmail("NATE"), "nate@watkinsroofing.net");
  assert.strictEqual(I.resolvePmEmail(" nate "), "nate@watkinsroofing.net");
  assert.strictEqual(I.resolvePmEmail("UNKNOWN"), "", "no entry -> nobody (never guesses)");
  assert.strictEqual(I.resolvePmEmail(""), "");
  delete process.env.DPR_PM_EMAILS;
  assert.strictEqual(I.resolvePmEmail("NATE"), "", "no map -> nobody");
  process.env.DPR_PM_EMAILS = "{not json";
  assert.strictEqual(I.resolvePmEmail("NATE"), "", "malformed map -> nobody, never throws");
  process.env.DPR_PM_EMAILS = JSON.stringify({ NATE: "not-an-email" });
  assert.strictEqual(I.resolvePmEmail("NATE"), "", "non-email value rejected");
  delete process.env.DPR_PM_EMAILS;
});

test("buildAmendEmail: subject + before/after hours; PM line reflects whether an email is on file", () => {
  const ctx = {
    jobName: "North Warehouse", jobNo: "17355", date: "2026-07-16", foreman: "Dax Dollens",
    pmCode: "NATE", pmEmail: "nate@watkinsroofing.net",
    note: "Hours amended 2026-07-17 — late Foundation timecard entries",
    before: { hoursWorked: "", crew: [{ name: "Christian Abernathy", hours: "" }] },
    after: { hoursWorked: "12.42", crew: [{ name: "Christian Abernathy", hours: "12.42" }] }
  };
  const mail = I.buildAmendEmail(ctx);
  assert.match(mail.subject, /Signed DPR hours amended/);
  assert.match(mail.subject, /North Warehouse #17355/);
  assert.match(mail.subject, /2026-07-16/);
  assert.match(mail.text, /Foreman: Dax Dollens/);
  assert.match(mail.text, /nate@watkinsroofing\.net/);
  assert.match(mail.text, /Christian Abernathy: 12\.42 hr/);
  assert.match(mail.text, /signature\/sign-off is unchanged/);
  // no email on file -> the code is named with guidance, no address invented
  const ctx2 = Object.assign({}, ctx, { pmEmail: "" });
  const mail2 = I.buildAmendEmail(ctx2);
  assert.match(mail2.text, /NATE \(no email on file/);
  assert.ok(!/nate@/.test(mail2.text));
  assert.ok(!/pay|rate/i.test(mail.text), "email carries no pay data");
});

test("amending a signed report emails the admin + the mapped PM (one send, both recipients)", async () => {
  seed();
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.DPR_PM_EMAILS = JSON.stringify({ NATE: "nate@watkinsroofing.net" });
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"] } }));
  const body = JSON.parse(r.body);
  assert.strictEqual(body.amended_signed, 1);
  assert.strictEqual(body.amend_emails_sent, 2, "admin + PM");
  assert.strictEqual(resendCalls.length, 1, "one email carrying both recipients");
  const mail = resendCalls[0];
  assert.deepStrictEqual(mail.to.slice().sort(), ["marks@watkinsroofing.net", "nate@watkinsroofing.net"]);
  assert.match(mail.subject, /Signed DPR hours amended/);
  assert.match(mail.text, /late Foundation timecard entries/);
  delete process.env.RESEND_API_KEY; delete process.env.DPR_PM_EMAILS;
});

test("no PM map: only the admin is emailed, and the PM code is named in the body (never guessed)", async () => {
  seed();
  process.env.RESEND_API_KEY = "re_test_key";
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"] } }));
  const body = JSON.parse(r.body);
  assert.strictEqual(body.amend_emails_sent, 1);
  assert.strictEqual(resendCalls.length, 1);
  assert.deepStrictEqual(resendCalls[0].to, ["marks@watkinsroofing.net"]);
  assert.match(resendCalls[0].text, /NATE \(no email on file/);
  delete process.env.RESEND_API_KEY;
});

test("a custom admin address (DPR_AMEND_NOTIFY_EMAIL) is honored", async () => {
  seed();
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.DPR_AMEND_NOTIFY_EMAIL = "ops@watkinsroofing.net";
  await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"] } }));
  assert.deepStrictEqual(resendCalls[0].to, ["ops@watkinsroofing.net"]);
  delete process.env.RESEND_API_KEY; delete process.env.DPR_AMEND_NOTIFY_EMAIL;
});

test("dryRun never sends email (and never writes)", async () => {
  seed();
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.DPR_PM_EMAILS = JSON.stringify({ NATE: "nate@watkinsroofing.net" });
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"], dryRun: true } }));
  assert.strictEqual(resendCalls.length, 0);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(JSON.parse(r.body).amend_emails_sent, 0);
  delete process.env.RESEND_API_KEY; delete process.env.DPR_PM_EMAILS;
});

test("with no RESEND_API_KEY the amendment still lands (write + audit); just no email", async () => {
  seed();  // seed() deletes RESEND_API_KEY
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "dpr_hours_backfill", dates: ["2026-07-16"] } }));
  const body = JSON.parse(r.body);
  assert.strictEqual(body.amended_signed, 1, "hours still amended");
  assert.strictEqual(body.amend_emails_sent, 0);
  assert.strictEqual(resendCalls.length, 0);
  assert.ok(writes.some((w) => w.id === "dpr_locked"), "the signed report was still written");
  assert.strictEqual(auditWrites.length, 1, "audit still recorded");
});
