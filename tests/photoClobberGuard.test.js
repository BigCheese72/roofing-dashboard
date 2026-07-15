"use strict";
/* Phase 0b multi-device clobber guard (optimistic concurrency in cloudSaveOrder):
   refuse to overwrite a cloud doc that advanced past the version this copy
   descends from (o._cloudBaseSavedAt), so an auto-flushed stale copy from one
   device can't wipe a newer save from another. Extracted from js/core.js. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const block = src.slice(src.indexOf("function photoSlotIsEmpty"), src.indexOf("async function cloudFetchIndex"));

const NOW = 5000;
function makeCtx(opts){
  opts = opts || {};
  const rec = { mainSet: null, savedBase: null };
  const parentDoc = { savedAt: ("cloudSavedAt" in opts ? opts.cloudSavedAt : 0) };
  const photosCol = {
    doc: (id) => ({ id, get: async () => ({ exists: false, data: () => undefined }), set: async () => {}, delete: async () => {} }),
    get: async () => ({ forEach: () => {} }) // empty subcollection
  };
  const ref = {
    get: async () => { if (opts.readThrows) throw new Error("offline read"); return { exists: true, data: () => parentDoc }; },
    set: async (m) => { rec.mainSet = m; },
    collection: () => photosCol
  };
  const ctx = {
    Date: { now: () => NOW }, console: { warn(){}, log(){} },
    fdb: { collection: () => ({ doc: () => ref }) },
    loadDb: () => ({ orders: { wo: {} } }),
    saveDb: (db) => { rec.savedBase = db.orders.wo._cloudBaseSavedAt; return true; },
    uploadPhotoToStorage: async () => "workorders/wo/0.jpg",
    deletePhotoFromStorage: async () => {},
    resolvePhotoImg: async () => null
  };
  vm.runInNewContext(block, ctx);
  ctx.__rec = rec;
  return ctx;
}
function order(base){ return { id: "wo", _cloudBaseSavedAt: base, photos: [] }; }

test("CONFLICT: cloud advanced past our base -> throws __conflict, does NOT overwrite", async () => {
  const ctx = makeCtx({ cloudSavedAt: 200 });
  await assert.rejects(
    ctx.cloudSaveOrder(order(100)),
    (e) => { assert.equal(e.__conflict, true); assert.match(e.message, /another device/i); return true; }
  );
  assert.equal(ctx.__rec.mainSet, null, "the cloud doc was never overwritten");
});

test("no conflict when the cloud is OLDER than our base -> proceeds and writes", async () => {
  const ctx = makeCtx({ cloudSavedAt: 100 });
  await ctx.cloudSaveOrder(order(200));
  assert.ok(ctx.__rec.mainSet, "cloud doc written");
});

test("no conflict when cloud equals our base -> proceeds", async () => {
  const ctx = makeCtx({ cloudSavedAt: 150 });
  await ctx.cloudSaveOrder(order(150));
  assert.ok(ctx.__rec.mainSet);
});

test("a new/never-synced order (base 0) is NOT guarded -> proceeds even against a newer cloud", async () => {
  const ctx = makeCtx({ cloudSavedAt: 999 });
  await ctx.cloudSaveOrder(order(0));
  assert.ok(ctx.__rec.mainSet, "unguarded new order still saves");
});

test("base advances to main.savedAt after a successful save (no self-conflict next time)", async () => {
  const ctx = makeCtx({ cloudSavedAt: 100 });
  const o = order(200);
  await ctx.cloudSaveOrder(o);
  assert.equal(o._cloudBaseSavedAt, NOW, "in-memory base advanced to the just-written savedAt");
  assert.equal(ctx.__rec.savedBase, NOW, "persisted base advanced too");
});

test("a read failure never blocks the save (best-effort guard)", async () => {
  const ctx = makeCtx({ readThrows: true });
  await ctx.cloudSaveOrder(order(100));
  assert.ok(ctx.__rec.mainSet, "save proceeds when the conflict read can't be made");
});
