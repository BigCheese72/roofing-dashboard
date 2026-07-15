"use strict";
/* Tests for the retroactive CompanyCam photo-feed backfill (issue #55):
   runCompanyCamPhotoBackfill() in js/core.js. It walks CompanyCam-linked work
   orders and reuses #51's pushPhotosToCompanyCamFeed() per order. Loads the
   REAL source into a vm sandbox (same technique as companyCamPhotoFeed.test.js)
   and stubs the collaborators (cloudFetchIndex / cloudFetchOrder /
   pushPhotosToCompanyCamFeed / confirm / toast) so the ORCHESTRATION is
   asserted: linked-only filtering, aggregation, idempotency pass-through,
   non-fatal-per-order, and the owner gate. Nothing touches network or Firestore. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadApp(){
  const noop = function(){};
  const stubEl = () => ({
    style: {}, classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [], setAttribute: noop,
    getAttribute: () => null, children: [], value: "", textContent: "", innerHTML: ""
  });
  const toasts = [];
  const sandbox = {
    console,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: stubEl, addEventListener: noop, body: stubEl() },
    navigator: { geolocation: {}, onLine: true, userAgent: "node-test" },
    L: { map: noop, tileLayer: noop, marker: noop, divIcon: noop, layerGroup: noop, polygon: noop,
         polyline: noop, circle: noop, circleMarker: noop, rectangle: noop,
         point: (x, y) => ({ x, y }), latLng: (a, b) => ({ lat: a, lng: b }) },
    URL: { createObjectURL: noop, revokeObjectURL: noop },
    Image: function () { this.addEventListener = noop; },
    Blob: function () {}, addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hostname: "localhost", href: "http://localhost/", search: "" },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    fetch: async () => { throw new Error("no network in test"); },
    Date, Math, JSON, Number, String, Boolean, Array, Object, Promise, isFinite
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const root = path.join(__dirname, "..");
  ["js/core.js", "js/history.js"].forEach(function (rel) {
    vm.runInContext(fs.readFileSync(path.join(root, rel), "utf8"), sandbox, { filename: rel });
  });
  sandbox.toast = (m) => toasts.push(String(m));
  sandbox.__toasts = toasts;
  sandbox.fdb = {};                       // truthy: the real query is stubbed via cloudFetchIndex
  sandbox.currentAuthClaims = { owner: true };
  sandbox.confirmCalls = 0;
  sandbox.confirm = () => { sandbox.confirmCalls++; return true; };
  return sandbox;
}

// index() returns work-order summaries (like cloudFetchIndex); some linked, some not.
function stubIndex(sb, list){ sb.cloudFetchIndex = async () => list; }
// fetch() returns a full order by id from a map; pushes come from `pushes` map.
function stubOrders(sb, byId){ sb.cloudFetchOrder = async (id) => byId[id] || null; }
function stubPush(sb, resultForOrder){
  sb.pushPhotosToCompanyCamFeed = async (o) => resultForOrder(o);
}

test("owner gate: a non-owner triggers no scan and no confirm", async () => {
  const sb = loadApp();
  sb.currentAuthClaims = { owner: false };
  let scanned = false;
  sb.cloudFetchIndex = async () => { scanned = true; return []; };
  const r = await sb.runCompanyCamPhotoBackfill();
  assert.strictEqual(r, undefined, "non-owner returns early");
  assert.strictEqual(scanned, false, "must not even scan without owner");
  assert.strictEqual(sb.confirmCalls, 0);
});

test("no CompanyCam-linked work orders: returns zeros, never prompts", async () => {
  const sb = loadApp();
  stubIndex(sb, [
    { id: "wo_a", companyCamProjectId: null },
    { id: "wo_b", companyCamProjectId: "" }
  ]);
  let fetched = false; sb.cloudFetchOrder = async () => { fetched = true; return null; };
  const r = await sb.runCompanyCamPhotoBackfill();
  assert.strictEqual(r.orders, 0);
  assert.strictEqual(r.pushed, 0);
  assert.strictEqual(sb.confirmCalls, 0, "no confirm when there's nothing to do");
  assert.strictEqual(fetched, false, "unlinked orders are never fetched");
});

test("only CompanyCam-linked orders are processed, counts aggregate across orders", async () => {
  const sb = loadApp();
  stubIndex(sb, [
    { id: "wo_linked1", companyCamProjectId: "p1" },
    { id: "wo_unlinked", companyCamProjectId: null },
    { id: "wo_linked2", companyCamProjectId: "p2" }
  ]);
  const fetchedIds = [];
  sb.cloudFetchOrder = async (id) => { fetchedIds.push(id); return { id: id, companyCamProjectId: id === "wo_linked1" ? "p1" : "p2", photos: [] }; };
  stubPush(sb, (o) => o.id === "wo_linked1"
    ? { ok: true, pushed: 2, alreadyPushed: 0, failed: 0 }
    : { ok: true, pushed: 1, alreadyPushed: 1, failed: 0 });

  const r = await sb.runCompanyCamPhotoBackfill();
  assert.deepStrictEqual(fetchedIds.sort(), ["wo_linked1", "wo_linked2"], "only linked orders fetched");
  assert.strictEqual(r.orders, 2);
  assert.strictEqual(r.pushed, 3, "2 + 1 pushed");
  assert.strictEqual(r.alreadyPushed, 1);
  assert.strictEqual(r.ordersTouched, 2, "both linked orders pushed at least one photo");
  assert.strictEqual(r.failed, 0);
});

test("idempotency pass-through: a re-run where everything is already pushed touches nothing", async () => {
  const sb = loadApp();
  stubIndex(sb, [{ id: "wo1", companyCamProjectId: "p1" }, { id: "wo2", companyCamProjectId: "p1" }]);
  stubOrders(sb, { wo1: { id: "wo1", photos: [] }, wo2: { id: "wo2", photos: [] } });
  stubPush(sb, () => ({ ok: true, pushed: 0, alreadyPushed: 3, failed: 0 }));

  const r = await sb.runCompanyCamPhotoBackfill();
  assert.strictEqual(r.pushed, 0, "nothing new pushed on a re-run");
  assert.strictEqual(r.alreadyPushed, 6);
  assert.strictEqual(r.ordersTouched, 0, "an order where 0 were pushed is not counted as touched");
  assert.strictEqual(r.failed, 0);
});

test("non-fatal: one order throwing (or reporting failures) never aborts the rest", async () => {
  const sb = loadApp();
  stubIndex(sb, [
    { id: "wo_ok", companyCamProjectId: "p1" },
    { id: "wo_throws", companyCamProjectId: "p1" },
    { id: "wo_partial", companyCamProjectId: "p1" }
  ]);
  sb.cloudFetchOrder = async (id) => {
    if (id === "wo_throws") throw new Error("fetch blew up");
    return { id: id, photos: [] };
  };
  stubPush(sb, (o) => o.id === "wo_partial"
    ? { ok: false, pushed: 1, alreadyPushed: 0, failed: 2, error: "CompanyCam 422" }
    : { ok: true, pushed: 3, alreadyPushed: 0, failed: 0 });

  const r = await sb.runCompanyCamPhotoBackfill();
  assert.strictEqual(r.pushed, 4, "wo_ok(3) + wo_partial(1); the throwing order is skipped, not fatal");
  assert.strictEqual(r.failed, 3, "1 thrown order + 2 failed photos");
  assert.strictEqual(r.failures.length, 2, "one failure entry for the throw, one for the partial");
  assert.ok(r.failures.some((f) => f.workOrderId === "wo_throws"));
  assert.ok(r.failures.some((f) => f.workOrderId === "wo_partial"));
});
