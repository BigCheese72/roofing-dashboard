"use strict";
/* Feedback -> auto-fix loop, server half (netlify/functions/admin.js:
   list_feedback filters + update_feedback_status, and lib/feedbackStatus.js).

   What must stay true forever:
     1. Both halves are audit.view-gated: no token -> 401, a plain field tech
        -> 403. The Dispatch watcher is an ADMIN caller, not an open endpoint.
     2. The watcher's poll is an INDEXED query: equality filters are applied
        before orderBy("createdAt","desc"), matching the composite index in
        firestore.indexes.json. A bad param is a 400, never a silently
        different (unfiltered) query.
     3. list_feedback with NO params behaves exactly as it did before this
        feature -- the admin backlog card must not change behaviour.
     4. update_feedback_status is a MERGE: it never destroys the submission
        evidence (comments/screenshot/route/appVersion) the loop runs on, and
        omitting agentDiagnosis/branchUrl leaves earlier values intact.
     5. branchUrl is allowlisted to https github.com. A javascript:/data:/
        lookalike-host URL is a hard 400 -- the admin viewer renders this
        into an <a href>.
     6. Every status write is audit-logged with a before/after.

   firebase-admin is stubbed (same pattern as rolesPermissionsAdmin.test.js)
   so this runs offline, with a query builder good enough to prove the
   where/orderBy/limit chain is actually applied. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const OWNER_TOKEN = "VALID_OWNER_TOKEN";
const TECH_TOKEN = "VALID_TECH_TOKEN";

// ---- in-memory Firestore with enough query support to test the chain ----
const store = new Map(); // "collection/docId" -> data
let autoId = 0;
// Records the shape of the last feedback query so a test can assert the
// filters were really pushed into Firestore, not applied in JS afterwards.
let lastQuery = null;

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function docRef(col, id) {
  const key = col + "/" + id;
  return {
    id,
    get: async () => ({
      exists: store.has(key), id,
      data: () => (store.has(key) ? clone(store.get(key)) : undefined)
    }),
    set: async (data, opts) => {
      const merged = (opts && opts.merge && store.has(key))
        ? Object.assign({}, store.get(key), data) : data;
      store.set(key, clone(merged));
    }
  };
}

function makeQuery(col, filters, order, limit) {
  const q = {
    where: (field, op, value) => makeQuery(col, filters.concat([{ field, op, value }]), order, limit),
    orderBy: (field, dir) => makeQuery(col, filters, { field, dir }, limit),
    limit: (n) => makeQuery(col, filters, order, n),
    get: async () => {
      if (col === "feedback") lastQuery = { filters: clone(filters), order: order ? clone(order) : null, limit };
      let rows = [];
      for (const [k, v] of store) {
        if (!k.startsWith(col + "/")) continue;
        rows.push({ id: k.slice(col.length + 1), data: clone(v) });
      }
      rows = rows.filter(r => filters.every(f => {
        const actual = r.data[f.field];
        if (f.op === "==") return actual === f.value;
        if (f.op === ">") return typeof actual === "number" && actual > f.value;
        throw new Error("stub does not implement operator " + f.op);
      }));
      if (order) {
        rows.sort((a, b) => {
          const av = a.data[order.field], bv = b.data[order.field];
          return order.dir === "desc" ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
        });
      }
      if (typeof limit === "number") rows = rows.slice(0, limit);
      const docs = rows.map(r => ({ id: r.id, data: () => clone(r.data) }));
      return { docs, forEach: (fn) => docs.forEach(fn), size: docs.length };
    }
  };
  return q;
}

const fakeDb = {
  collection: (col) => {
    const base = makeQuery(col, [], null, undefined);
    return Object.assign({}, base, { doc: (id) => docRef(col, id || ("auto_" + (++autoId))) });
  }
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

const { SEED_ROLES } = require("../netlify/functions/lib/permissions.js");
const fbStatus = require("../netlify/functions/lib/feedbackStatus.js");
const adminFn = require("../netlify/functions/admin.js");

function seed() {
  store.clear();
  lastQuery = null;
  autoId = 0;
  SEED_ROLES.forEach(r => {
    store.set("roles/" + r.id, {
      id: r.id, label: r.label, permissions: clone(r.permissions), isSystem: !!r.isSystem, rank: r.rank || 0
    });
  });
  // Three bug reports and one feature request, oldest -> newest.
  store.set("feedback/fb_old_bug", {
    type: "bug", typeLabel: "🐞 Bug", comments: "map pin drifts", screen: "RoofMapper",
    createdAt: 1000, triageStatus: "new", appVersion: "20260724b", env: "prod",
    route: "https://leak-work-orders.netlify.app/#rm", screenshot: "data:image/jpeg;base64,AAA"
  });
  store.set("feedback/fb_mid_bug", {
    type: "bug", typeLabel: "🐞 Bug", comments: "save spinner hangs", screen: "Work Order Form",
    createdAt: 2000, triageStatus: "triaging", appVersion: "20260724b", env: "prod"
  });
  store.set("feedback/fb_new_bug", {
    type: "bug", typeLabel: "🐞 Bug", comments: "photo upload 500s", screen: "Work Order Form",
    createdAt: 3000, triageStatus: "new", appVersion: "20260724b", env: "dev"
  });
  store.set("feedback/fb_feature", {
    type: "feature", typeLabel: "💡 Feature request", comments: "dark mode",
    screen: "Home", createdAt: 4000, triageStatus: "new"
  });
  // Predates the feature: no triageStatus field at all.
  store.set("feedback/fb_legacy", {
    type: "bug", typeLabel: "🐞 Bug", comments: "old report", screen: "Home", createdAt: 500
  });
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

// ---- 1. the gate ----
for (const action of ["list_feedback", "update_feedback_status"]) {
  test(`${action}: 401 with no token / garbage token`, async () => {
    seed();
    for (const token of [null, "garbage.token"]) {
      const r = await adminFn.handler(ev({ action, feedbackId: "fb_new_bug", triageStatus: "triaging" }, token));
      assert.strictEqual(r.statusCode, 401, `${action} must 401 with token=${token}`);
    }
  });

  test(`${action}: 403 for an authenticated field tech (no audit.view)`, async () => {
    seed();
    const r = await adminFn.handler(ev({ action, feedbackId: "fb_new_bug", triageStatus: "triaging" }, TECH_TOKEN));
    assert.strictEqual(r.statusCode, 403, `${action} must 403 for field_tech`);
  });
}

// ---- 2. the watcher's poll ----
test("list_feedback with no params is unchanged: newest first, limit 200, no filters", async () => {
  seed();
  const r = await adminFn.handler(ev({ action: "list_feedback" }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.deepStrictEqual(lastQuery.filters, [], "unfiltered call must not push any where()");
  assert.deepStrictEqual(lastQuery.order, { field: "createdAt", dir: "desc" });
  assert.strictEqual(lastQuery.limit, 200);
  assert.deepStrictEqual(out.items.map(i => i.id), ["fb_feature", "fb_new_bug", "fb_mid_bug", "fb_old_bug", "fb_legacy"]);
});

test("the Dispatch poll (type=bug + triageStatus=new) returns only new bug reports, newest first", async () => {
  seed();
  const r = await adminFn.handler(ev({ action: "list_feedback", type: "bug", triageStatus: "new" }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.deepStrictEqual(out.items.map(i => i.id), ["fb_new_bug", "fb_old_bug"]);
  // Equality filters must precede the range/orderBy field -- that ordering is
  // what the composite index in firestore.indexes.json is built for.
  assert.deepStrictEqual(lastQuery.filters, [
    { field: "type", op: "==", value: "bug" },
    { field: "triageStatus", op: "==", value: "new" }
  ]);
  assert.deepStrictEqual(lastQuery.order, { field: "createdAt", dir: "desc" });
});

test("the poll returns the full doc including the new auto-diagnosis fields", async () => {
  seed();
  const r = await adminFn.handler(ev({ action: "list_feedback", type: "bug", triageStatus: "new", limit: 1 }, OWNER_TOKEN));
  const item = JSON.parse(r.body).items[0];
  assert.strictEqual(item.id, "fb_new_bug");
  assert.strictEqual(item.appVersion, "20260724b");
  assert.strictEqual(item.env, "dev");
  assert.strictEqual(item.comments, "photo upload 500s");
  assert.strictEqual(item.screen, "Work Order Form");
});

test("sinceCreatedAt is a real range filter (watermark path for pre-feature reports)", async () => {
  seed();
  const r = await adminFn.handler(ev({ action: "list_feedback", sinceCreatedAt: 2000 }, OWNER_TOKEN));
  const out = JSON.parse(r.body);
  assert.deepStrictEqual(out.items.map(i => i.id), ["fb_feature", "fb_new_bug"], "strictly greater-than the watermark");
  assert.deepStrictEqual(lastQuery.filters, [{ field: "createdAt", op: ">", value: 2000 }]);
});

test("a legacy doc with no triageStatus is invisible to the status query but visible unfiltered", async () => {
  seed();
  const filtered = JSON.parse((await adminFn.handler(ev({ action: "list_feedback", triageStatus: "new" }, OWNER_TOKEN))).body);
  assert.ok(!filtered.items.some(i => i.id === "fb_legacy"), "Firestore equality cannot match a missing field");
  const all = JSON.parse((await adminFn.handler(ev({ action: "list_feedback" }, OWNER_TOKEN))).body);
  assert.ok(all.items.some(i => i.id === "fb_legacy"), "unfiltered listing must still surface it");
});

test("list_feedback echoes the query and the status vocabulary", async () => {
  seed();
  const out = JSON.parse((await adminFn.handler(ev({ action: "list_feedback", type: "bug" }, OWNER_TOKEN))).body);
  assert.deepStrictEqual(out.statuses, fbStatus.TRIAGE_STATUSES);
  assert.strictEqual(out.query.type, "bug");
  assert.strictEqual(out.query.limit, 200);
});

test("bad params are a 400, never a silently unfiltered query", async () => {
  seed();
  const bad = [
    { type: "urgent" }, { triageStatus: "in_progress" },
    { sinceCreatedAt: "yesterday" }, { sinceCreatedAt: -1 },
    { limit: 0 }, { limit: 201 }, { limit: 2.5 }
  ];
  for (const params of bad) {
    const r = await adminFn.handler(ev(Object.assign({ action: "list_feedback" }, params), OWNER_TOKEN));
    assert.strictEqual(r.statusCode, 400, "expected 400 for " + JSON.stringify(params));
  }
});

// ---- 3. the writeback ----
test("update_feedback_status writes status/diagnosis/branch and preserves the evidence", async () => {
  seed();
  const r = await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_old_bug", triageStatus: "fix_proposed",
    agentDiagnosis: "Pin drift: rmProjectPoint() rounds before the zoom transform.",
    branchUrl: "https://github.com/BigCheese72/roofing-dashboard/tree/fix/pin-drift"
  }, OWNER_TOKEN));
  assert.strictEqual(r.statusCode, 200);
  const doc = store.get("feedback/fb_old_bug");
  assert.strictEqual(doc.triageStatus, "fix_proposed");
  assert.match(doc.agentDiagnosis, /rmProjectPoint/);
  assert.strictEqual(doc.branchUrl, "https://github.com/BigCheese72/roofing-dashboard/tree/fix/pin-drift");
  assert.ok(typeof doc.updatedAt === "number" && doc.updatedAt > 0);
  // The submission evidence must survive the merge.
  assert.strictEqual(doc.comments, "map pin drifts");
  assert.strictEqual(doc.screenshot, "data:image/jpeg;base64,AAA");
  assert.strictEqual(doc.route, "https://leak-work-orders.netlify.app/#rm");
  assert.strictEqual(doc.appVersion, "20260724b");
  assert.strictEqual(doc.createdAt, 1000);
});

test("omitting agentDiagnosis/branchUrl leaves earlier values intact", async () => {
  seed();
  await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: "fix_proposed",
    agentDiagnosis: "first pass", branchUrl: "https://github.com/BigCheese72/roofing-dashboard/tree/fix/a"
  }, OWNER_TOKEN));
  await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: "merged"
  }, OWNER_TOKEN));
  const doc = store.get("feedback/fb_new_bug");
  assert.strictEqual(doc.triageStatus, "merged");
  assert.strictEqual(doc.agentDiagnosis, "first pass", "a status-only call must not blank the diagnosis");
  assert.strictEqual(doc.branchUrl, "https://github.com/BigCheese72/roofing-dashboard/tree/fix/a");
});

test("every status in the vocabulary is writable, and nothing else is", async () => {
  for (const status of fbStatus.TRIAGE_STATUSES) {
    seed();
    const r = await adminFn.handler(ev({ action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: status }, OWNER_TOKEN));
    assert.strictEqual(r.statusCode, 200, "should accept " + status);
  }
  seed();
  for (const bad of ["", null, "NEW", "closed", "done", 1, true]) {
    const r = await adminFn.handler(ev({ action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: bad }, OWNER_TOKEN));
    assert.strictEqual(r.statusCode, 400, "should reject " + JSON.stringify(bad));
  }
  assert.strictEqual(store.get("feedback/fb_new_bug").triageStatus, "new", "a rejected call writes nothing");
});

test("branchUrl is allowlisted: only https github.com is stored", async () => {
  seed();
  const evil = [
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "http://github.com/BigCheese72/roofing-dashboard",      // not https
    "https://github.com.attacker.dev/BigCheese72/repo",      // lookalike host
    "https://gitllub.com/BigCheese72/repo",
    "not a url at all"
  ];
  for (const url of evil) {
    const r = await adminFn.handler(ev({
      action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: "fix_proposed", branchUrl: url
    }, OWNER_TOKEN));
    assert.strictEqual(r.statusCode, 400, "must reject " + url);
  }
  const doc = store.get("feedback/fb_new_bug");
  assert.strictEqual(doc.branchUrl, undefined, "nothing was stored");
  assert.strictEqual(doc.triageStatus, "new", "and the status did not move either");
});

test("branchUrl can be explicitly cleared with an empty string", async () => {
  seed();
  await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: "fix_proposed",
    branchUrl: "https://github.com/BigCheese72/roofing-dashboard/tree/fix/a"
  }, OWNER_TOKEN));
  await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_new_bug", triageStatus: "wont_fix", branchUrl: ""
  }, OWNER_TOKEN));
  assert.strictEqual(store.get("feedback/fb_new_bug").branchUrl, "");
});

test("a missing feedbackId is 404, a blank one is 400", async () => {
  seed();
  const missing = await adminFn.handler(ev({ action: "update_feedback_status", feedbackId: "fb_nope", triageStatus: "merged" }, OWNER_TOKEN));
  assert.strictEqual(missing.statusCode, 404);
  const blank = await adminFn.handler(ev({ action: "update_feedback_status", feedbackId: "  ", triageStatus: "merged" }, OWNER_TOKEN));
  assert.strictEqual(blank.statusCode, 400);
});

test("a status write is audit-logged with before/after", async () => {
  seed();
  await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_old_bug", triageStatus: "merged",
    branchUrl: "https://github.com/BigCheese72/roofing-dashboard/tree/fix/pin-drift"
  }, OWNER_TOKEN));
  const entry = auditEntries().find(e => e.action === "update_feedback_status");
  assert.ok(entry, "must write an audit entry");
  assert.strictEqual(entry.target.feedbackId, "fb_old_bug");
  assert.strictEqual(entry.before.triageStatus, "new");
  assert.strictEqual(entry.after.triageStatus, "merged");
  assert.strictEqual(entry.actorEmail, "mark@watkins.com");
});

// ---- 4. the pure validators ----
test("clampDiagnosis caps runaway agent output", () => {
  const long = "x".repeat(fbStatus.MAX_DIAGNOSIS_LEN + 500);
  assert.ok(fbStatus.clampDiagnosis(long).length <= fbStatus.MAX_DIAGNOSIS_LEN);
  assert.strictEqual(fbStatus.clampDiagnosis("  spaced  "), "spaced");
  assert.strictEqual(fbStatus.clampDiagnosis(null), "");
  assert.strictEqual(fbStatus.clampDiagnosis(undefined), "");
});

test("normalizeBranchUrl: '' passes through, bad urls return null (reject), good urls normalize", () => {
  assert.strictEqual(fbStatus.normalizeBranchUrl(""), "");
  assert.strictEqual(fbStatus.normalizeBranchUrl(undefined), "");
  assert.strictEqual(fbStatus.normalizeBranchUrl("javascript:alert(1)"), null);
  assert.strictEqual(fbStatus.normalizeBranchUrl("https://github.com.evil.dev/x"), null);
  assert.strictEqual(
    fbStatus.normalizeBranchUrl("https://github.com/BigCheese72/roofing-dashboard/pull/188"),
    "https://github.com/BigCheese72/roofing-dashboard/pull/188"
  );
  assert.strictEqual(fbStatus.normalizeBranchUrl("https://" + "a".repeat(fbStatus.MAX_BRANCH_URL_LEN) + ".github.com/x"), null);
});
