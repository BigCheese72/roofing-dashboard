"use strict";
/* Login History & Online Now -- server half (netlify/functions/admin.js:
   list_login_events / list_user_activity).

   What must stay true:
     1. Both actions are audit.view-gated: no token -> 401, a plain tech
        (no audit.view) -> 403, and the gate is data-driven (service_manager
        holds audit.view in the seed grid and passes -- not hardcoded
        owner/admin).
     2. list_login_events returns newest-first.
     3. list_user_activity joins users + presence + Firebase Auth
        lastSignInTime per uid -- and DEGRADES (lastSignInTime null, not a
        500) if the Auth listUsers call fails, because presence data alone
        is still worth showing.

   Same offline firebase-admin stub pattern as the rest of tests/. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const OWNER_TOKEN = "VALID_OWNER_TOKEN";
const TECH_TOKEN = "VALID_TECH_TOKEN";
const SM_TOKEN = "VALID_SERVICE_MANAGER_TOKEN";

let listUsersShouldFail = false;

// ---- in-memory Firestore with just enough query support ----
const store = new Map(); // "collection/docId" -> data
function colDocs(col) {
  const docs = [];
  for (const [k, v] of store) {
    if (k.startsWith(col + "/")) {
      const id = k.slice(col.length + 1);
      docs.push({ id, data: () => JSON.parse(JSON.stringify(v)) });
    }
  }
  return docs;
}
const fakeDb = {
  collection: (col) => ({
    doc: (id) => ({
      get: async () => ({
        exists: store.has(col + "/" + id),
        data: () => (store.has(col + "/" + id) ? JSON.parse(JSON.stringify(store.get(col + "/" + id))) : undefined)
      })
    }),
    get: async () => {
      const docs = colDocs(col);
      return { docs, forEach: (fn) => docs.forEach(fn), size: docs.length };
    },
    orderBy: (field, dir) => ({
      limit: (n) => ({
        get: async () => {
          let docs = colDocs(col);
          docs.sort((a, b) => dir === "desc" ? (b.data()[field] - a.data()[field]) : (a.data()[field] - b.data()[field]));
          docs = docs.slice(0, n);
          return { docs, forEach: (fn) => docs.forEach(fn), size: docs.length };
        }
      })
    })
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
        if (token === SM_TOKEN) return { uid: "sm_1", email: "sm@watkins.com", owner: false, role: "service_manager" };
        throw new Error("Decoding Firebase ID token failed");
      },
      listUsers: async () => {
        if (listUsersShouldFail) throw new Error("listUsers unavailable");
        return {
          users: [
            { uid: "u_tech", metadata: { lastSignInTime: "Tue, 15 Jul 2026 08:00:00 GMT" } },
            { uid: "u_old", metadata: { lastSignInTime: "Mon, 01 Jun 2026 12:00:00 GMT" } }
          ]
        };
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

const { SEED_ROLES } = require("../netlify/functions/lib/permissions.js");
const adminFn = require("../netlify/functions/admin.js");

function seed() {
  store.clear();
  listUsersShouldFail = false;
  SEED_ROLES.forEach(r => store.set("roles/" + r.id, {
    id: r.id, permissions: JSON.parse(JSON.stringify(r.permissions))
  }));
  // Two users, one with a presence heartbeat, one without (pre-feature user).
  store.set("users/u_tech", { uid: "u_tech", email: "tech@watkins.com", displayName: "Tech", role: "field_tech", status: "active" });
  store.set("users/u_old", { uid: "u_old", email: "old@watkins.com", displayName: "Old Timer", role: "estimator", status: "active" });
  store.set("presence/u_tech", { uid: "u_tech", email: "tech@watkins.com", lastActiveAt: 1752650000000, userAgent: "UA_TECH" });
  // Login events deliberately inserted OUT of time order.
  store.set("login_events/e1", { uid: "u_tech", email: "tech@watkins.com", ts: 1000, userAgent: "UA_A" });
  store.set("login_events/e2", { uid: "u_old", email: "old@watkins.com", ts: 3000, userAgent: "UA_B" });
  store.set("login_events/e3", { uid: "u_tech", email: "tech@watkins.com", ts: 2000, userAgent: "UA_C" });
}

function ev(body, token) {
  const headers = { host: "dev--leak-work-orders.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: "POST", headers, body: JSON.stringify(body) };
}

// ---- the gate ----
for (const action of ["list_login_events", "list_user_activity"]) {
  test(`${action}: 401 with no/garbage token, 403 without audit.view`, async () => {
    seed();
    for (const token of [null, "garbage.token"]) {
      const r = await adminFn.handler(ev({ action }, token));
      assert.strictEqual(r.statusCode, 401, `${action} must 401 with token=${token}`);
    }
    const r = await adminFn.handler(ev({ action }, TECH_TOKEN));
    assert.strictEqual(r.statusCode, 403, `${action} must 403 for field_tech (no audit.view)`);
  });

  test(`${action}: allowed for owner AND for a role whose live grid grants audit.view`, async () => {
    seed();
    for (const token of [OWNER_TOKEN, SM_TOKEN]) {
      const r = await adminFn.handler(ev({ action }, token));
      assert.strictEqual(r.statusCode, 200, `${action} must 200 for ${token}`);
    }
  });
}

// ---- list_login_events ----
test("list_login_events returns newest-first", async () => {
  seed();
  const r = await adminFn.handler(ev({ action: "list_login_events" }, OWNER_TOKEN));
  const out = JSON.parse(r.body);
  assert.deepStrictEqual(out.items.map(i => i.ts), [3000, 2000, 1000]);
  assert.strictEqual(out.items[0].email, "old@watkins.com");
  assert.strictEqual(out.items[0].userAgent, "UA_B");
});

// ---- list_user_activity ----
test("list_user_activity joins users + presence + Auth lastSignInTime", async () => {
  seed();
  const r = await adminFn.handler(ev({ action: "list_user_activity" }, OWNER_TOKEN));
  const out = JSON.parse(r.body);
  const byUid = {};
  out.items.forEach(i => { byUid[i.uid] = i; });

  // heartbeating user: presence fields present
  assert.strictEqual(byUid.u_tech.lastActiveAt, 1752650000000);
  assert.strictEqual(byUid.u_tech.userAgent, "UA_TECH");
  assert.strictEqual(byUid.u_tech.lastSignInTime, "Tue, 15 Jul 2026 08:00:00 GMT");
  assert.strictEqual(byUid.u_tech.role, "field_tech");

  // pre-feature user: no presence yet, but Auth lastSignInTime still surfaces
  assert.strictEqual(byUid.u_old.lastActiveAt, null);
  assert.strictEqual(byUid.u_old.userAgent, null);
  assert.strictEqual(byUid.u_old.lastSignInTime, "Mon, 01 Jun 2026 12:00:00 GMT");
});

test("list_user_activity degrades gracefully when Auth listUsers fails", async () => {
  seed();
  listUsersShouldFail = true;
  const r = await adminFn.handler(ev({ action: "list_user_activity" }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200, "presence roster must still load without Auth metadata");
  const out = JSON.parse(r.body);
  const byUid = {};
  out.items.forEach(i => { byUid[i.uid] = i; });
  assert.strictEqual(byUid.u_tech.lastSignInTime, null);
  assert.strictEqual(byUid.u_tech.lastActiveAt, 1752650000000, "presence data survives the Auth failure");
});
