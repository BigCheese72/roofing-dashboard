"use strict";
/* Additional Codex-owned tests for the feedback auto-fix admin API.
   These cover the hardening items not pinned by Claude's foundation tests:
   feedback.triage write permission, duplicate writes, screenshot omission,
   and the 200-result cap. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const OWNER_TOKEN = "VALID_OWNER_TOKEN";
const AUDIT_ONLY_TOKEN = "VALID_AUDIT_ONLY_TOKEN";
const TRIAGE_ONLY_TOKEN = "VALID_TRIAGE_ONLY_TOKEN";
const TECH_TOKEN = "VALID_TECH_TOKEN";

const store = new Map();
let autoId = 0;

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
  return {
    where: (field, op, value) => makeQuery(col, filters.concat([{ field, op, value }]), order, limit),
    orderBy: (field, dir) => makeQuery(col, filters, { field, dir }, limit),
    limit: (n) => makeQuery(col, filters, order, n),
    get: async () => {
      let rows = [];
      for (const [k, v] of store) {
        if (k.startsWith(col + "/")) rows.push({ id: k.slice(col.length + 1), data: clone(v) });
      }
      rows = rows.filter(r => filters.every(f => {
        const actual = r.data[f.field];
        if (f.op === "==") return actual === f.value;
        if (f.op === ">") return typeof actual === "number" && actual > f.value;
        throw new Error("unsupported op " + f.op);
      }));
      if (order) {
        rows.sort((a, b) => {
          const av = a.data[order.field], bv = b.data[order.field];
          return order.dir === "desc" ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
        });
      }
      if (typeof limit === "number") rows = rows.slice(0, limit);
      return { docs: rows.map(r => ({ id: r.id, data: () => clone(r.data) })) };
    }
  };
}

const fakeDb = {
  collection: (col) => Object.assign(makeQuery(col, [], null, undefined), {
    doc: (id) => docRef(col, id || ("auto_" + (++autoId)))
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
        if (token === AUDIT_ONLY_TOKEN) return { uid: "audit_1", email: "audit@watkins.com", owner: false, role: "audit_only" };
        if (token === TRIAGE_ONLY_TOKEN) return { uid: "triage_1", email: "triage@watkins.com", owner: false, role: "triage_only" };
        if (token === TECH_TOKEN) return { uid: "tech_1", email: "tech@watkins.com", owner: false, role: "field_tech" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() { return fakeDb; }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN_EXTRA";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN_EXTRA"] = {
  id: "FAKE_FIREBASE_ADMIN_EXTRA", filename: "FAKE_FIREBASE_ADMIN_EXTRA", loaded: true, exports: fakeAdmin
};
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });

const { PERMISSION_KEYS, SEED_ROLES } = require("../netlify/functions/lib/permissions.js");
const adminFn = require("../netlify/functions/admin.js");

function fullFalse(extra) {
  const p = {};
  PERMISSION_KEYS.forEach(k => { p[k] = false; });
  Object.assign(p, extra || {});
  return p;
}

function seed() {
  store.clear();
  autoId = 0;
  SEED_ROLES.forEach(r => {
    store.set("roles/" + r.id, { id: r.id, label: r.label, permissions: clone(r.permissions), rank: r.rank || 0 });
  });
  store.set("roles/audit_only", { id: "audit_only", permissions: fullFalse({ "audit.view": true }) });
  store.set("roles/triage_only", { id: "triage_only", permissions: fullFalse({ "feedback.triage": true }) });
  store.set("feedback/fb_one", {
    type: "bug", typeLabel: "Bug", comments: "bad save", screen: "Work Order Form",
    screenshot: "data:image/jpeg;base64," + "A".repeat(1000),
    createdAt: 1000, triageStatus: "new", route: "https://dev--leak-work-orders.netlify.app/#edit"
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

test("update_feedback_status requires feedback.triage, not merely audit.view", async () => {
  seed();
  const auditOnly = await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_one", triageStatus: "triaging"
  }, AUDIT_ONLY_TOKEN));
  assert.strictEqual(auditOnly.statusCode, 403);
  assert.match(JSON.parse(auditOnly.body).error, /feedback\.triage/);

  const triageOnly = await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_one", triageStatus: "triaging"
  }, TRIAGE_ONLY_TOKEN));
  assert.strictEqual(triageOnly.statusCode, 200);
});

test("list_feedback remains audit.view-gated and does not require triage write permission", async () => {
  seed();
  assert.strictEqual((await adminFn.handler(ev({ action: "list_feedback" }, AUDIT_ONLY_TOKEN))).statusCode, 200);
  assert.strictEqual((await adminFn.handler(ev({ action: "list_feedback" }, TRIAGE_ONLY_TOKEN))).statusCode, 403);
});

test("duplicate status writes merge in order and audit both attempts", async () => {
  seed();
  const first = await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_one", triageStatus: "triaging",
    agentDiagnosis: "claimed by watcher A"
  }, OWNER_TOKEN));
  const second = await adminFn.handler(ev({
    action: "update_feedback_status", feedbackId: "fb_one", triageStatus: "fix_proposed",
    agentDiagnosis: "watcher B produced the final diagnosis",
    branchUrl: "https://github.com/BigCheese72/roofing-dashboard/tree/fix/save"
  }, OWNER_TOKEN));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(second.statusCode, 200);
  const doc = store.get("feedback/fb_one");
  assert.strictEqual(doc.triageStatus, "fix_proposed");
  assert.strictEqual(doc.agentDiagnosis, "watcher B produced the final diagnosis");
  assert.strictEqual(doc.comments, "bad save", "evidence survives duplicate merges");
  assert.strictEqual(doc.screenshot.slice(0, 22), "data:image/jpeg;base64");
  assert.strictEqual(auditEntries().filter(e => e.action === "update_feedback_status").length, 2);
});

test("list_feedback can omit screenshots for watcher polls", async () => {
  seed();
  const kept = JSON.parse((await adminFn.handler(ev({ action: "list_feedback", limit: 1 }, OWNER_TOKEN))).body);
  assert.ok(kept.items[0].screenshot, "admin card no-argument behavior keeps full docs");
  assert.strictEqual(kept.query.omitScreenshot, false);

  const omitted = JSON.parse((await adminFn.handler(ev({ action: "list_feedback", limit: 1, omitScreenshot: true }, OWNER_TOKEN))).body);
  assert.strictEqual(omitted.items[0].screenshot, undefined);
  assert.strictEqual(omitted.query.omitScreenshot, true);

  const bad = await adminFn.handler(ev({ action: "list_feedback", omitScreenshot: "yes" }, OWNER_TOKEN));
  assert.strictEqual(bad.statusCode, 400);
});

test("list_feedback never pages past the 200 result cap", async () => {
  seed();
  for (let i = 0; i < 205; i++) {
    store.set("feedback/fb_bulk_" + i, { type: "bug", createdAt: 2000 + i, triageStatus: "new" });
  }
  const out = JSON.parse((await adminFn.handler(ev({ action: "list_feedback", limit: 200, omitScreenshot: true }, OWNER_TOKEN))).body);
  assert.strictEqual(out.items.length, 200);
  assert.strictEqual(out.items[0].id, "fb_bulk_204");
  assert.ok(!out.items.some(i => i.id === "fb_one"), "oldest records stay past the cap");
  assert.strictEqual((await adminFn.handler(ev({ action: "list_feedback", limit: 201 }, OWNER_TOKEN))).statusCode, 400);
});
