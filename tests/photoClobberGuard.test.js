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
  const rec = { mainSet: null, savedBase: null, photoSetThrows: !!opts.photoSetThrows };
  const parentDoc = { savedAt: ("cloudSavedAt" in opts ? opts.cloudSavedAt : 0) };
  const photosCol = {
    doc: (id) => ({ id, get: async () => ({ exists: false, data: () => undefined }),
      /* A photo-doc write can REJECT mid-batch on a flaky connection — the exact
         partial-save that used to strand the clobber-guard base. */
      set: async () => { if (rec.photoSetThrows) throw new Error("photo doc write failed (offline)"); },
      delete: async () => {} }),
    get: async () => ({ forEach: () => {} }) // empty subcollection
  };
  const ref = {
    get: async () => { if (opts.readThrows) throw new Error("offline read"); return { exists: true, data: () => parentDoc }; },
    /* Model Firestore: committing the doc advances its savedAt, so a later
       .get() (a subsequent save's conflict read) sees the value we just wrote. */
    set: async (m) => { rec.mainSet = m; parentDoc.savedAt = m.savedAt; },
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
  ctx.__allowPhotoSet = () => { rec.photoSetThrows = false; };
  ctx.__forceCloudSavedAt = (v) => { parentDoc.savedAt = v; }; // simulate another device's newer write
  return ctx;
}
function order(base){ return { id: "wo", _cloudBaseSavedAt: base, photos: [] }; }
function orderWithPhoto(base){ return { id: "wo", _cloudBaseSavedAt: base, photos: [{ img: "data:image/jpeg;base64,AAAA" }] }; }

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

/* ---- Regression: Mark's prod block — the guard re-firing "updated on another
   device" on a SINGLE device, even after reopening. The work-order doc write
   (which commits savedAt) succeeds, but a photo op then rejects mid-batch. The
   base MUST already be advanced by then, or the next save false-conflicts
   against this device's OWN just-written savedAt. ---- */
test("partial photo-op failure STILL advances the clobber-guard base", async () => {
  const ctx = makeCtx({ cloudSavedAt: 100, photoSetThrows: true });
  const o = orderWithPhoto(200);
  await assert.rejects(
    ctx.cloudSaveOrder(o),
    (e) => { assert.ok(!e.__conflict, "a transient photo failure, NOT a conflict"); return true; }
  );
  assert.ok(ctx.__rec.mainSet, "the work-order doc (carrying the new savedAt) WAS committed");
  assert.equal(o._cloudBaseSavedAt, NOW, "in-memory base advanced despite the photo-op failure");
  assert.equal(ctx.__rec.savedBase, NOW, "persisted base advanced despite the photo-op failure");
});

test("after a partial-failure save, the NEXT save does NOT false-fire the guard", async () => {
  const ctx = makeCtx({ cloudSavedAt: 100, photoSetThrows: true });
  const o = orderWithPhoto(200);
  await assert.rejects(ctx.cloudSaveOrder(o)); // doc committed at NOW, photo op failed, base -> NOW
  // Cloud doc now sits at NOW (the write landed). Retry with the advanced base;
  // photo ops succeed this time. This must NOT throw "updated on another device".
  ctx.__allowPhotoSet();
  const retry = orderWithPhoto(o._cloudBaseSavedAt);
  await ctx.cloudSaveOrder(retry);
  assert.ok(ctx.__rec.mainSet, "retry saved cleanly — no false self-conflict after a partial save");
});

test("guard STILL blocks a GENUINE newer other-device write after our base advanced", async () => {
  const ctx = makeCtx({ cloudSavedAt: 100 });
  const o = order(200);
  await ctx.cloudSaveOrder(o);                 // base advances to NOW (5000)
  assert.equal(o._cloudBaseSavedAt, NOW);
  ctx.__rec.mainSet = null;
  // Another device writes a strictly-newer version after ours.
  ctx.__forceCloudSavedAt(NOW + 100);
  const stale = order(o._cloudBaseSavedAt);    // our copy still descends from NOW
  await assert.rejects(
    ctx.cloudSaveOrder(stale),
    (e) => { assert.equal(e.__conflict, true); return true; }
  );
  assert.equal(ctx.__rec.mainSet, null, "a real newer other-device copy is NOT overwritten");
});
