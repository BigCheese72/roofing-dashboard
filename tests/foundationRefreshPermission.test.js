"use strict";
/* Narrow Foundation job-list refresh permission (foundation.refresh_jobs).
 *
 * WHY THIS FILE EXISTS — Mark, 2026-08-10: field foremen may refresh the
 * Foundation JOB LIST "as long as it's just pulling the current job orders",
 * and must NOT be handed any Foundation cost / margin / billing / AR data.
 *
 * `foundation.read` is NOT job-list-only: the live foundation.js connector
 * returns the contract value (action=jobs -> original_contract) and labor hours
 * (job_hours / day_hours) behind it. So foremen get the NARROW
 * `foundation.refresh_jobs` instead — it authorizes ONLY the job-list sync
 * (foundation-sync.js action=sync -> the foundation_jobs cache, contract value
 * dropped) and nothing financial. This file pins both halves:
 *   A. the seed grid — foremen get refresh_jobs, NOT foundation.read.
 *   B. the gate — refresh_jobs authorizes action=sync but is REFUSED for the
 *      hours backfill (which stays foundation.read), and the synced cache never
 *      carries the contract value.
 */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const { PERMISSION_KEYS, SEED_ROLES } = require("../netlify/functions/lib/permissions.js");

const byId = {};
SEED_ROLES.forEach((r) => { byId[r.id] = r; });
const FIELD_FOREMAN_ROLES = ["field_tech", "superintendent", "project_manager"];
const ADMIN_GRADE_ROLES = ["owner", "admin", "service_manager", "ops_manager"];

/* ============================ A. THE SEED GRID ============================ */

test("foundation.refresh_jobs is a real registered permission key", () => {
  assert.ok(PERMISSION_KEYS.includes("foundation.refresh_jobs"));
});

test("field foreman roles get the NARROW refresh key but NOT foundation.read", () => {
  for (const id of FIELD_FOREMAN_ROLES) {
    const perms = byId[id].permissions;
    assert.strictEqual(perms["foundation.refresh_jobs"], true, id + " must be able to refresh the job list");
    assert.notStrictEqual(perms["foundation.read"], true, id + " must NOT hold foundation.read (no contract/hours)");
  }
});

test("admin-grade roles keep foundation.read (financial access unchanged)", () => {
  for (const id of ADMIN_GRADE_ROLES) {
    assert.strictEqual(byId[id].permissions["foundation.read"], true, id + " keeps foundation.read");
  }
});

test("no role was accidentally handed foundation.read via this change", () => {
  // Exactly the four admin-grade roles hold foundation.read; nobody else.
  const holders = SEED_ROLES.filter((r) => r.permissions["foundation.read"] === true).map((r) => r.id).sort();
  assert.deepStrictEqual(holders, ADMIN_GRADE_ROLES.slice().sort());
});

/* ===================== B. THE GATE (handler, stubbed) ===================== */

const SQL_PASSWORD = "sql-pw-NEVER-LEAK-9999";
const SYNC_SECRET = "F".repeat(40);
const FOREMAN = "FOREMAN_TOKEN";       // role field_tech: refresh_jobs, NOT read
const ADMIN_TOK = "ADMIN_TOKEN";       // role service_manager: foundation.read

// roles/{id} docs come straight from the REAL seed, so this exercises the
// actual grants, not a hand-made grid.
const ROLE_DOCS = {};
SEED_ROLES.forEach((r) => { ROLE_DOCS[r.id] = { permissions: r.permissions }; });

const stored = new Map();
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
  return { set(ref, d, o) { ops.push([ref, d, o]); return this; }, commit: async () => { for (const [ref, d, o] of ops) await ref.set(d, o); } };
}
const fakeFirestore = { collection, batch: makeBatch };
const fakeAdmin = {
  apps: [], credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === FOREMAN) return { uid: "u_fore", email: "fore@watkins.com", owner: false, role: "field_tech" };
        if (token === ADMIN_TOK) return { uid: "u_sm", email: "sm@watkins.com", owner: false, role: "service_manager" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() { return fakeFirestore; }
};
const fakeMssql = {
  NVarChar: "NVARCHAR",
  ConnectionPool: function () {
    this.connect = async () => ({
      request: () => ({
        input() { return this; },
        query: async () => ({ recordset: [
          { job_no: "17519", job_number: "", description: "Multipli Credit Union Leak", job_status: "A", customer_no: "MULTIPLI", project_manager_no: "MARK", address_1: "", city: "", state: "", zip_code: "", job_location: "", original_contract: 500000, job_start_date: null, completion_date: null }
        ] })
      })
    });
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FB_ADMIN2";
  if (req === "mssql") return "FAKE_MSSQL2";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FB_ADMIN2"] = { id: "FAKE_FB_ADMIN2", filename: "FAKE_FB_ADMIN2", loaded: true, exports: fakeAdmin };
require.cache["FAKE_MSSQL2"] = { id: "FAKE_MSSQL2", filename: "FAKE_MSSQL2", loaded: true, exports: fakeMssql };

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.FOUNDATION_SQL_PASSWORD = SQL_PASSWORD;
process.env.FOUNDATION_SYNC_SECRET = SYNC_SECRET;

const sync = require("../netlify/functions/foundation-sync.js");

function ev(opts) {
  const headers = { host: "dev--watkins.netlify.app" };
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  return { httpMethod: "POST", headers, body: JSON.stringify(opts.body || {}) };
}

test("a foreman (refresh_jobs, no foundation.read) CAN refresh the job list", async () => {
  stored.clear();
  const r = await sync.handler(ev({ token: FOREMAN, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 200, "foreman may pull the current job list");
  const job = stored.get("foundation_jobs/17519");
  assert.ok(job, "job 17519 landed in the cache");
  assert.strictEqual(job.name, "Multipli Credit Union Leak");
  // The financial field must NEVER reach a foreman via the cache.
  assert.ok(!("original_contract" in job), "contract value must not be exposed to a foreman");
  assert.doesNotMatch(r.body, /500000/, "no contract value in the response body");
});

test("a foreman CANNOT run the DPR hours backfill (labor hours stay foundation.read)", async () => {
  stored.clear();
  const r = await sync.handler(ev({ token: FOREMAN, body: { action: "dpr_hours_backfill" } }));
  assert.strictEqual(r.statusCode, 403, "hours are financial-grade — refresh_jobs must not reach them");
  assert.match(r.body, /foundation\.read/);
  assert.strictEqual(stored.size, 0, "nothing written on a refused call");
});

test("an admin (foundation.read) can still refresh, unchanged", async () => {
  stored.clear();
  const r = await sync.handler(ev({ token: ADMIN_TOK, body: { action: "sync" } }));
  assert.strictEqual(r.statusCode, 200);
});
