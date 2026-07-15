"use strict";
/* Foundation → Firestore nightly sync (Phase 2).

   What this pins down:
     1. THE GATE (fail-closed, key is NOT a skeleton). Only two callers get in:
        the automated cron holding FOUNDATION_SYNC_SECRET in a header, or a
        signed-in human with foundation.read. Everyone else: opaque 401. A
        signed-in user WITHOUT foundation.read: 403. The sync key authorizes
        action=sync ONLY — any other action from it is 403. The DB/Firestore
        are never touched on a rejected call.
     2. LEAST PRIVILEGE IN THE CACHE. What lands in foundation_jobs is the
        identifying subset only — the contract value is dropped, pay is never
        involved. The password/secret never appear in a response.
     3. THE >500 PULL. The sync pulls with NO TOP cap (limit 0), so more than
        500 active jobs all make it into the cache.
     4. dryRun writes nothing.

   firebase-admin (auth + Firestore) and mssql (job rows) are both stubbed, so
   this runs offline and exercises the real query builders, cache mapping, and
   batched upsert end-to-end. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const SYNC_SECRET = "F".repeat(40); // >= 32 chars
const SQL_PASSWORD = "sql-pw-NEVER-LEAK-1234";
const OWNER = "OWNER_TOKEN";
const SM = "SERVICE_MANAGER_TOKEN"; // has foundation.read
const TECH = "FIELD_TECH_TOKEN";    // signed in, no foundation.read

const ROLE_DOCS = {
  service_manager: { permissions: { "foundation.read": true } },
  field_tech: { permissions: { "foundation.read": false } }
};

// ---- Fake Firestore (records writes) + Auth, behind firebase-admin. ----
const stored = new Map(); // "collection/id" -> data
function docRef(col, id) {
  return {
    get: async () => {
      if (col === "roles") { const d = ROLE_DOCS[id]; return d ? { exists: true, data: () => d } : { exists: false }; }
      const key = col + "/" + id;
      return stored.has(key) ? { exists: true, data: () => stored.get(key) } : { exists: false };
    },
    set: async (data, opts) => {
      const key = col + "/" + id;
      stored.set(key, opts && opts.merge ? Object.assign({}, stored.get(key) || {}, data) : data);
    }
  };
}
function collection(col) { return { doc: (id) => docRef(col, id) }; }
function makeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push([ref, data, opts]); return this; },
    commit: async () => { for (const [ref, data, opts] of ops) await ref.set(data, opts); }
  };
}
const fakeFirestore = { collection, batch: makeBatch };

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
  firestore() { return fakeFirestore; }
};

// ---- Fake mssql: the jobs query returns rows (incl. a padded CHAR job_no
// and a contract value that must NOT reach the cache). ----
let jobsQueryCount = 0;
const fakeMssql = {
  NVarChar: "NVARCHAR",
  ConnectionPool: function () {
    this.connect = async () => ({
      request: () => ({
        input() { return this; },
        query: async (text) => {
          jobsQueryCount++;
          assert.doesNotMatch(text, /\bTOP\b/, "the sync must pull with NO TOP cap (all active jobs)");
          return { recordset: [
            { job_no: "17053     ", job_number: "17053", description: "CPS Smithton MS FACS Renovation", job_status: "A", customer_no: "GBHBLD", project_manager_no: "NATE", address_1: "1 Main", city: "Smithton", state: "IL", zip_code: "62285", job_location: "", original_contract: 4200, job_start_date: new Date("2026-01-02T00:00:00Z"), completion_date: null },
            { job_no: "16189", job_number: "16189", description: "UMSL Welcome & Alumni Center", job_status: "A", customer_no: "UMSL", project_manager_no: "PAT", address_1: "2 Campus", city: "St Louis", state: "MO", zip_code: "63121", job_location: "", original_contract: 999999, job_start_date: new Date("2025-06-01T00:00:00Z"), completion_date: null }
          ] };
        }
      })
    });
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FB_ADMIN";
  if (req === "mssql") return "FAKE_MSSQL";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FB_ADMIN"] = { id: "FAKE_FB_ADMIN", filename: "FAKE_FB_ADMIN", loaded: true, exports: fakeAdmin };
require.cache["FAKE_MSSQL"] = { id: "FAKE_MSSQL", filename: "FAKE_MSSQL", loaded: true, exports: fakeMssql };

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.FOUNDATION_SQL_PASSWORD = SQL_PASSWORD;
process.env.FOUNDATION_SYNC_SECRET = SYNC_SECRET;

const sync = require("../netlify/functions/foundation-sync.js");
const fdb = require("../netlify/functions/lib/foundationDb.js");

function ev(opts) {
  opts = opts || {};
  const headers = { host: "dev--watkins.netlify.app" };
  if (opts.syncKey) headers["x-foundation-sync-key"] = opts.syncKey;
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  return { httpMethod: opts.method || "POST", headers, body: JSON.stringify(opts.body || {}) };
}
function clearStore() { stored.clear(); }

/* ============================ THE GATE ============================ */

test("no key + no token: action=sync is 401 opaque, and nothing is queried/written", async () => {
  clearStore();
  const before = jobsQueryCount;
  const r = await sync.handler(ev({ body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 401);
  assert.match(r.body, /^\{"error":"Unauthorized"\}$/);
  assert.strictEqual(jobsQueryCount, before, "no DB read for an unauthenticated caller");
  assert.strictEqual(stored.size, 0, "no Firestore write for an unauthenticated caller");
});

test("wrong / too-short sync key falls through to token auth (401 without a token)", async () => {
  const r1 = await sync.handler(ev({ syncKey: "short", body: { action: "sync" } }));
  assert.strictEqual(r1.statusCode, 401);
  const r2 = await sync.handler(ev({ syncKey: "G".repeat(40), body: { action: "sync" } }));
  assert.strictEqual(r2.statusCode, 401, "a 40-char but WRONG key must not authenticate");
});

test("signed-in user WITHOUT foundation.read: action=sync is 403, nothing written", async () => {
  clearStore();
  const r = await sync.handler(ev({ token: TECH, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(stored.size, 0);
});

test("valid sync key authorizes ONLY action=sync — any other action is 403 (not a skeleton key)", async () => {
  clearStore();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "delete_everything" } }));
  assert.strictEqual(r.statusCode, 403);
  assert.match(r.body, /Forbidden/);
  assert.strictEqual(stored.size, 0);
});

test("non-POST is 405", async () => {
  const r = await sync.handler(ev({ method: "GET", syncKey: SYNC_SECRET, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 405);
});

test("auth runs before the password check: 401 even if FOUNDATION_SQL_PASSWORD is unset", async () => {
  const saved = process.env.FOUNDATION_SQL_PASSWORD;
  delete process.env.FOUNDATION_SQL_PASSWORD;
  try {
    const r = await sync.handler(ev({ body: { action: "sync" } }));
    assert.strictEqual(r.statusCode, 401);
  } finally { process.env.FOUNDATION_SQL_PASSWORD = saved; }
});

/* ==================== AUTHORIZED SYNC, END-TO-END ==================== */

test("automated caller: syncs ALL active jobs into foundation_jobs, contract DROPPED, meta written", async () => {
  clearStore();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.active_jobs, 2);
  assert.strictEqual(body.written, 2);

  // Padded CHAR job_no became a clean doc id + trimmed field.
  const smithton = stored.get("foundation_jobs/17053");
  assert.ok(smithton, "job 17053 must be cached");
  assert.strictEqual(smithton.name, "CPS Smithton MS FACS Renovation");
  assert.strictEqual(smithton.job_no, "17053");
  assert.strictEqual(smithton.project_manager_no, "NATE");
  assert.ok(smithton.synced_at, "each cached job carries a synced_at");
  // The financially-sensitive field must NOT be in the cache.
  assert.ok(!("original_contract" in smithton), "contract value must never be cached");

  const meta = stored.get("foundation_sync_meta/last");
  assert.ok(meta && meta.active_jobs === 2 && meta.written === 2, "meta doc records the run");

  // The password/secret never leak into the response.
  assert.doesNotMatch(r.body, new RegExp(SQL_PASSWORD));
  assert.doesNotMatch(r.body, new RegExp(SYNC_SECRET));
});

test("signed-in human WITH foundation.read (service_manager) can trigger a sync", async () => {
  clearStore();
  const r = await sync.handler(ev({ token: SM, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(stored.get("foundation_jobs/16189").name, "UMSL Welcome & Alumni Center");
});

test("owner can trigger a sync", async () => {
  clearStore();
  const r = await sync.handler(ev({ token: OWNER, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 200);
});

test("dryRun: reports what it would write and writes NOTHING", async () => {
  clearStore();
  const r = await sync.handler(ev({ syncKey: SYNC_SECRET, body: { action: "sync", dryRun: true } }));
  assert.strictEqual(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.dryRun, true);
  assert.strictEqual(body.would_write, 2);
  assert.strictEqual(stored.size, 0, "dryRun must not write");
});

/* ============= PURE HELPERS (limit cap, cache mapping, doc id) ============= */

test("topClause: default 500, positive N, 0/negative => no cap, clamped to max", () => {
  assert.strictEqual(fdb.topClause(undefined), "TOP 500");
  assert.strictEqual(fdb.topClause(null), "TOP 500");
  assert.strictEqual(fdb.topClause(100), "TOP 100");
  assert.strictEqual(fdb.topClause(0), "", "0 means no cap (full sync)");
  assert.strictEqual(fdb.topClause(-5), "");
  assert.strictEqual(fdb.topClause(999999), "TOP 20000", "clamped to the hard ceiling");
});

test("buildJobsQuery honors the limit: default caps at 500, limit 0 removes TOP entirely", () => {
  assert.match(fdb.buildJobsQuery().text, /SELECT TOP 500/);
  assert.match(fdb.buildJobsQuery("", 250).text, /SELECT TOP 250/);
  const all = fdb.buildJobsQuery("", 0).text;
  assert.doesNotMatch(all, /\bTOP\b/, "limit 0 => pull every active job");
  assert.match(all, /job_status = 'A'/);
});

test("mapJobForCache: keeps identifying fields, DROPS original_contract", () => {
  const cached = fdb.mapJobForCache(fdb.mapJobRow({
    job_no: "17053  ", job_number: "17053", description: "CPS Smithton", job_status: "A",
    customer_no: "GBHBLD", project_manager_no: "NATE", address_1: "1 Main", city: "Smithton",
    state: "IL", zip_code: "62285", original_contract: 4200, job_start_date: new Date("2026-01-02T00:00:00Z")
  }));
  assert.strictEqual(cached.name, "CPS Smithton");
  assert.strictEqual(cached.job_no, "17053");
  assert.strictEqual(cached.project_manager_no, "NATE");
  assert.ok(!("original_contract" in cached), "contract must be dropped from the cache shape");
});

test("safeDocId: sanitizes to Firestore-safe ids, rejects empty", () => {
  const { safeDocId } = sync._internals;
  assert.strictEqual(safeDocId("17053"), "17053");
  assert.strictEqual(safeDocId("  17053 "), "17053");
  assert.strictEqual(safeDocId("A/B.C"), "A_B_C", "slashes/dots replaced");
  assert.strictEqual(safeDocId(""), "");
  assert.strictEqual(safeDocId(null), "");
});
