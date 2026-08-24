"use strict";
/* Field-blocking bug (Mark, on his phone): localStorage quota full blocked saves,
   AND 2 photos never reached the cloud / couldn't be emailed. Root cause: photo
   eviction (pruneCachedPhotoDrafts) protected only the CURRENT order -- it could
   strip a PENDING (unsynced) or NEVER-UPLOADED order's photos, whose local bytes
   are the only copy (data loss), and saveDb() gave up on quota instead of freeing
   cloud-backed bytes and retrying. These tests pin the safety guards. Functions
   are extracted from js/core.js and run in a vm with localStorage/syncQueue stubbed. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const a = src.indexOf("var MAX_CACHED_PHOTO_DRAFTS");
const b = src.indexOf("async function idbPutPhoto");
assert.notEqual(a, -1); assert.notEqual(b, -1);

function load(opts){
  opts = opts || {};
  const store = {};
  let setCalls = 0;
  const ctx = {
    JSON, Object, String,
    STORE_KEY: "k",
    currentId: opts.currentId || null,
    toast(){},
    loadSyncQueue(){ return opts.pending || {}; },
    localStorage: {
      getItem(k){ return store[k] || null; },
      setItem(k, v){
        setCalls++;
        // Throw quota for the first N writes, then succeed (models quota -> evict -> retry).
        if (setCalls <= (opts.throwFirstN || 0)){
          const e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
        }
        store[k] = v;
      }
    }
  };
  vm.runInNewContext(src.slice(a, b), ctx);
  ctx.__store = store; ctx.__setCalls = () => setCalls;
  return ctx;
}

// photo helpers
const uploaded = (n) => ({ img: "BYTES" + n, storageRef: "workorders/x/" + n + ".jpg", caption: "c" });
const notUploaded = (n) => ({ img: "BYTES" + n, storageRef: null, caption: "c" }); // only local copy!
const strippedRef = (n) => ({ storageRef: "workorders/x/" + n + ".jpg" });          // no bytes, ref only

test("orderIsFullyCloudBacked: true only when every local-byte photo has a storageRef", () => {
  const c = load();
  assert.equal(c.orderIsFullyCloudBacked({ photos: [uploaded(0), strippedRef(1)] }), true);
  assert.equal(c.orderIsFullyCloudBacked({ photos: [uploaded(0), notUploaded(1)] }), false, "a never-uploaded photo makes it NOT evictable");
  assert.equal(c.orderIsFullyCloudBacked({ photos: [] }), true);
});

test("DATA-LOSS GUARD: pruneCachedPhotoDrafts never strips current / pending / never-uploaded orders", () => {
  const c = load({ currentId: "cur", pending: { pend: {} } });
  const db = { index: [
    { id: "cur", savedAt: 9 }, { id: "pend", savedAt: 8 }, { id: "raw", savedAt: 7 },
    { id: "s1", savedAt: 6 }, { id: "s2", savedAt: 5 }, { id: "s3", savedAt: 4 },
    { id: "s4", savedAt: 3 }, { id: "s5", savedAt: 2 }, { id: "s6", savedAt: 1 }
  ], orders: {
    cur: { photos: [uploaded(0)] },          // current -> keep
    pend: { photos: [notUploaded(0)] },      // pending + unbacked -> keep
    raw: { photos: [notUploaded(0)] },       // never-uploaded draft -> keep
    s1: { photos: [uploaded(0)] }, s2: { photos: [uploaded(0)] }, s3: { photos: [uploaded(0)] },
    s4: { photos: [uploaded(0)] }, s5: { photos: [uploaded(0)] }, s6: { photos: [uploaded(0)] }
  } };

  c.pruneCachedPhotoDrafts(db);

  // protected orders keep their bytes
  assert.ok(db.orders.cur.photos[0].img, "current order keeps photos");
  assert.ok(db.orders.pend.photos[0].img, "PENDING order keeps photos (only local copy)");
  assert.ok(db.orders.raw.photos[0].img, "never-uploaded draft keeps photos");
  // only 6 evictable (s1..s6); cap is 5 -> exactly 1 (the oldest, s6) is stripped
  assert.ok(!db.orders.s6.photos[0].img, "oldest cloud-backed order beyond the cap is stripped");
  assert.ok(db.orders.s1.photos[0].img && db.orders.s5.photos[0].img, "5 most-recent cloud-backed kept for offline");
});

test("evictCloudBackedPhotoBytes frees ALL cloud-backed orders but never the unsafe ones", () => {
  const c = load({ currentId: "cur", pending: { pend: {} } });
  const db = { index: ["cur", "pend", "raw", "s1", "s2"].map((id, i) => ({ id, savedAt: 5 - i })),
    orders: { cur: { photos: [uploaded(0)] }, pend: { photos: [notUploaded(0)] }, raw: { photos: [notUploaded(0)] },
      s1: { photos: [uploaded(0)] }, s2: { photos: [uploaded(0)] } } };

  const freed = c.evictCloudBackedPhotoBytes(db);

  assert.equal(freed, true);
  assert.ok(!db.orders.s1.photos[0].img && !db.orders.s2.photos[0].img, "all cloud-backed freed");
  assert.ok(db.orders.cur.photos[0].img && db.orders.pend.photos[0].img && db.orders.raw.photos[0].img,
    "current + pending + never-uploaded all protected");
});

test("saveDb: on QuotaExceededError it evicts cloud-backed bytes and RETRIES (save not blocked)", () => {
  // First write throws quota; the retry (after eviction frees space) succeeds.
  const c = load({ currentId: "cur", throwFirstN: 1 });
  const db = { index: [{ id: "cur", savedAt: 2 }, { id: "s1", savedAt: 1 }],
    orders: { cur: { photos: [uploaded(0)] }, s1: { photos: [uploaded(1)] } } };

  const ok = c.saveDb(db);

  assert.equal(ok, true, "the save succeeds after freeing space");
  assert.ok(!db.orders.s1.photos[0].img, "cloud-backed s1 was evicted to make room");
  assert.ok(db.orders.cur.photos[0].img, "current order never evicted");
  assert.ok(c.__setCalls() >= 2, "it retried the write after eviction");
});

test("saveDb: nothing evictable -> returns false (honest failure, no silent success)", () => {
  const c = load({ currentId: "cur", throwFirstN: 1 });
  const db = { index: [{ id: "cur" }], orders: { cur: { photos: [notUploaded(0)] } } };
  assert.equal(c.saveDb(db), false, "can't free the current/unsynced order -> honest false");
});
