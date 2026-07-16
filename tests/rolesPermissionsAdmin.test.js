"use strict";
/* Roles & Permissions editor -- server-side guards (netlify/functions/
   admin.js: list_roles / set_role_permissions).

   What must stay true forever:
     1. Both actions are settings.security-gated: no token -> 401, a plain
        authenticated tech -> 403, and the gate is DATA-DRIVEN (a role whose
        live grid grants settings.security passes; owner always passes).
     2. The owner role is LOCKED -- set_role_permissions refuses to touch it
        no matter who asks, so no sequence of edits can lock the owner out.
     3. Only keys in PERMISSION_KEYS can ever be written, and only values
        that are true/false or a scope PERMISSION_SCOPES allows for that
        specific key. Unknown key / bad value = hard 400, NOTHING written.
     4. Every real change is audit-logged as "role_permissions_changed"
        with a before/after DIFF (changed keys only); a no-op save writes
        neither the role nor an audit entry.

   firebase-admin is stubbed (same pattern as functionsAuth.test.js) so this
   runs offline: an in-memory Firestore seeded from the REAL SEED_ROLES, so
   validation is tested against the actual shipped grids. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const OWNER_TOKEN = "VALID_OWNER_TOKEN";
const TECH_TOKEN = "VALID_TECH_TOKEN";
const SECMGR_TOKEN = "VALID_SECMGR_TOKEN";

// ---- in-memory Firestore ----
const store = new Map(); // "collection/docId" -> data object
let autoId = 0;
function docRef(col, id) {
  const key = col + "/" + id;
  return {
    id,
    get: async () => ({
      exists: store.has(key),
      id,
      data: () => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined)
    }),
    set: async (data, opts) => {
      const merged = (opts && opts.merge && store.has(key))
        ? Object.assign({}, store.get(key), data) : data;
      store.set(key, JSON.parse(JSON.stringify(merged)));
    }
  };
}
const fakeDb = {
  collection: (col) => ({
    doc: (id) => docRef(col, id || ("auto_" + (++autoId))),
    get: async () => {
      const docs = [];
      for (const [k, v] of store) {
        if (k.startsWith(col + "/")) {
          const id = k.slice(col.length + 1);
          docs.push({ id, data: () => JSON.parse(JSON.stringify(v)) });
        }
      }
      return { docs, forEach: (fn) => docs.forEach(fn), size: docs.length };
    }
  })
};
const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === OWNER_TOKEN) return { uid: "owner_1", email: "mark@watkins.com", owner: true, role: "owner" };
        if (token === TECH_TOKEN) return { uid: "tech_1", email: "tech@watkins.com", owner: false, role: "field_tech" };
        if (token === SECMGR_TOKEN) return { uid: "sec_1", email: "sec@watkins.com", owner: false, role: "secmgr" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() { return fakeDb; }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN"] = {
  id: "FAKE_FIREBASE_ADMIN", filename: "FAKE_FIREBASE_ADMIN", loaded: true, exports: fakeAdmin
};
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });

const { PERMISSION_KEYS, PERMISSION_SCOPES, SEED_ROLES } = require("../netlify/functions/lib/permissions.js");
const adminFn = require("../netlify/functions/admin.js");

function seedRoles() {
  store.clear();
  SEED_ROLES.forEach(r => {
    store.set("roles/" + r.id, {
      id: r.id, label: r.label, description: r.description,
      permissions: JSON.parse(JSON.stringify(r.permissions)), isSystem: !!r.isSystem, rank: r.rank || 0
    });
  });
  // A custom, non-seed role holding settings.security -- proves the gate is
  // the LIVE grid, not a hardcoded "is owner" check.
  const secPerms = {};
  PERMISSION_KEYS.forEach(k => { secPerms[k] = false; });
  secPerms["settings.security"] = true;
  store.set("roles/secmgr", { id: "secmgr", label: "Security Manager", permissions: secPerms, isSystem: false, rank: 80 });
}

function ev(body, token) {
  const headers = { host: "dev--leak-work-orders.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: "POST", headers, body: JSON.stringify(body) };
}
function auditEntries() {
  const out = [];
  for (const [k, v] of store) if (k.startsWith("audit_logs/")) out.push(v);
  return out;
}
function rolePerms(roleId) { return store.get("roles/" + roleId).permissions; }

// ---- 1. the gate ----
for (const action of ["list_roles", "set_role_permissions"]) {
  test(`${action}: 401 with no token / garbage token`, async () => {
    seedRoles();
    for (const token of [null, "garbage.token"]) {
      const r = await adminFn.handler(ev({ action, roleId: "field_tech", permissions: {} }, token));
      assert.strictEqual(r.statusCode, 401, `${action} must 401 with token=${token}`);
    }
  });

  test(`${action}: 403 for an authenticated tech (no settings.security)`, async () => {
    seedRoles();
    const r = await adminFn.handler(ev({ action, roleId: "billing", permissions: {} }, TECH_TOKEN));
    assert.strictEqual(r.statusCode, 403, `${action} must 403 for field_tech`);
  });
}

test("gate is data-driven: a live role granted settings.security passes (not hardcoded owner)", async () => {
  seedRoles();
  const r = await adminFn.handler(ev({ action: "list_roles" }, SECMGR_TOKEN));
  assert.strictEqual(r.statusCode, 200);
});

// ---- 2. list_roles payload ----
test("list_roles returns rank-sorted roles + the canonical key/scope registries", async () => {
  seedRoles();
  const r = await adminFn.handler(ev({ action: "list_roles" }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.deepStrictEqual(out.permissionKeys, PERMISSION_KEYS, "editor rows must come from the real registry");
  assert.deepStrictEqual(out.permissionScopes, PERMISSION_SCOPES, "scope dropdowns must come from the real registry");
  assert.strictEqual(out.roles[0].id, "owner", "owner (rank 100) sorts first");
  const ids = out.roles.map(x => x.id);
  for (const seed of SEED_ROLES) assert.ok(ids.includes(seed.id), "missing role " + seed.id);
});

// ---- 3. a real edit persists, normalized, and is audit-logged as a diff ----
test("owner edit persists (normalized full grid) and audit-logs the diff", async () => {
  seedRoles();
  const r = await adminFn.handler(ev({
    action: "set_role_permissions", roleId: "field_tech",
    permissions: { "billing.view": true, "workorder.view.all": "proj" }
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(JSON.parse(r.body).changed, 2);

  const perms = rolePerms("field_tech");
  assert.strictEqual(perms["billing.view"], true);
  assert.strictEqual(perms["workorder.view.all"], "proj");
  assert.strictEqual(perms["capture.photos"], true, "keys NOT in the request keep their existing value");
  for (const k of PERMISSION_KEYS) assert.ok(k in perms, "normalized grid must contain every registry key: " + k);

  const audits = auditEntries();
  assert.strictEqual(audits.length, 1);
  const a = audits[0];
  assert.strictEqual(a.action, "role_permissions_changed");
  assert.strictEqual(a.actorUid, "owner_1");
  assert.deepStrictEqual(a.target, { collection: "roles", id: "field_tech" });
  assert.deepStrictEqual(a.before, { "workorder.view.all": false, "billing.view": false });
  assert.deepStrictEqual(a.after, { "workorder.view.all": "proj", "billing.view": true });
});

test("no-op save writes nothing: changed 0, no audit entry", async () => {
  seedRoles();
  const r = await adminFn.handler(ev({
    action: "set_role_permissions", roleId: "field_tech",
    permissions: { "capture.photos": true } // already true in the seed
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(JSON.parse(r.body).changed, 0);
  assert.strictEqual(auditEntries().length, 0);
});

// ---- 4. the owner lock ----
test("owner role is locked: even the owner gets 403, nothing written", async () => {
  seedRoles();
  const before = JSON.stringify(rolePerms("owner"));
  const r = await adminFn.handler(ev({
    action: "set_role_permissions", roleId: "owner", permissions: { "buildings.purge": false }
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(JSON.stringify(rolePerms("owner")), before, "owner grid must be untouched");
  assert.strictEqual(auditEntries().length, 0);
});

// ---- 5. key/value validation (hard reject, nothing written) ----
test("unknown permission key -> 400, nothing written", async () => {
  seedRoles();
  const before = JSON.stringify(rolePerms("billing"));
  const r = await adminFn.handler(ev({
    action: "set_role_permissions", roleId: "billing",
    permissions: { "billing.view": true, "totally.made.up": true }
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 400);
  assert.match(JSON.parse(r.body).error, /totally\.made\.up/);
  assert.strictEqual(JSON.stringify(rolePerms("billing")), before);
  assert.strictEqual(auditEntries().length, 0);
});

test("scoped values: allowed scopes accepted, wrong/unknown scopes rejected", async () => {
  seedRoles();
  // Rejected: an arbitrary string, and a REAL scope on a key that doesn't allow it.
  for (const bad of [
    { "workorder.view.all": "banana" },
    { "workorder.create": "own" },     // workorder.create allows only "proj"
    { "changeorder.draft": "proj" },   // boolean-only key
    { "billing.view": 1 }              // non-boolean, non-string garbage
  ]) {
    const r = await adminFn.handler(ev({
      action: "set_role_permissions", roleId: "estimator", permissions: bad
    }, OWNER_TOKEN));
    assert.strictEqual(r.statusCode, 400, "must reject " + JSON.stringify(bad));
  }
  assert.strictEqual(auditEntries().length, 0);

  // Accepted: every scope PERMISSION_SCOPES actually allows.
  const r = await adminFn.handler(ev({
    action: "set_role_permissions", roleId: "estimator",
    permissions: { "workorder.view.all": "billing", "capture.photos": "proj", "attachments.archive": "own" }
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  const perms = rolePerms("estimator");
  assert.strictEqual(perms["workorder.view.all"], "billing");
  assert.strictEqual(perms["capture.photos"], "proj");
  assert.strictEqual(perms["attachments.archive"], "own");
});

test("unknown role -> 404", async () => {
  seedRoles();
  const r = await adminFn.handler(ev({
    action: "set_role_permissions", roleId: "no_such_role", permissions: { "billing.view": true }
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 404);
});

test("missing/invalid permissions object -> 400", async () => {
  seedRoles();
  for (const perms of [undefined, null, "x", ["billing.view"]]) {
    const r = await adminFn.handler(ev({
      action: "set_role_permissions", roleId: "billing", permissions: perms
    }, OWNER_TOKEN));
    assert.strictEqual(r.statusCode, 400, "must 400 for permissions=" + JSON.stringify(perms));
  }
});
