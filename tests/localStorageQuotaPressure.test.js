"use strict";
/* Mark, prod, 2026-07-31 08:36 CT, screen "Report Preview": "working on the
   Vandalia report and keep getting storage full toasts. I am on my desktop."
   (fb_ms8xezlkg4cmk; his leak-workorders-v1 key measured 4,890,778 bytes against
   a ~5MB quota -- see PR #194.)

   Two independent defects, both pinned here:

   1. ROOT CAUSE -- `imgFallback`. cloudFetchOrder() sets it to a photo's FULL-
      RESOLUTION base64 whenever the photo has a storageRef but no thumb (every
      photo the server-side migration backfilled). Nothing treated it as photo
      bytes: stripPhotoBytes() left it, leanDbReplacer() left it, and
      orderHasCachedPhotoBytes() could not see it -- so merely OPENING one
      migrated work order wrote ~650KB per photo into localStorage permanently,
      invisible to every eviction path. Eight such photos are the entire quota.

   2. TERMINAL FAILURE -- saveDb()'s quota recovery had exactly one rung: drop
      `img` from cloud-backed orders. Phase 1 (IndexedDB offload) had already
      moved every `img` out of localStorage, so that rung silently became a
      no-op: it freed nothing, returned false, saveDb() gave up WITHOUT retrying,
      and the toast fired on every single save with no way back under the quota
      short of clearing site data. That is the "keep getting" in the report.

   Functions are extracted from js/core.js and run in a vm with localStorage /
   the sync queue stubbed -- same harness style as photoStorageEviction.test.js. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const a = src.indexOf("var MAX_CACHED_PHOTO_DRAFTS");
const b = src.indexOf("async function idbPutPhoto");
assert.notEqual(a, -1);
assert.notEqual(b, -1);

function load(opts){
  opts = opts || {};
  const store = {};
  let setCalls = 0;
  const toasts = [];
  const ctx = {
    JSON, Object, String, Array, Math,
    STORE_KEY: "k",
    currentId: opts.currentId || null,
    toast(m){ toasts.push(m); },
    loadSyncQueue(){ return opts.pending || {}; },
    localStorage: {
      getItem(k){ return store[k] || null; },
      setItem(k, v){
        setCalls++;
        /* Models a real quota: the write succeeds only if the payload fits the
           byte ceiling. That is what makes "eviction actually freed enough"
           testable, rather than just "eviction ran N times". */
        if (opts.quotaBytes != null && v.length > opts.quotaBytes){
          const e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
        }
        if (setCalls <= (opts.throwFirstN || 0)){
          const e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
        }
        store[k] = v;
      }
    }
  };
  vm.runInNewContext(src.slice(a, b), ctx);
  ctx.__store = store;
  ctx.__toasts = toasts;
  ctx.__setCalls = () => setCalls;
  return ctx;
}

/* A real 200px/q0.6 thumb of a real roof photo measures 7,599 raw bytes ->
   ~10,155 base64 chars (jimp, tools/_last_upload_preview.jpg). A 1600px/q0.8
   full-size measures 486,589 -> ~648,811. Scaled down by 1000x here so the
   tests stay fast; the RATIO between them (~64:1) is what the eviction ladder
   is being exercised against, and that is preserved. */
const FULL = "F".repeat(650);
const THUMB = "T".repeat(10);

/* The migrated shape that caused this: storageRef, NO thumb, and the full
   base64 sitting in imgFallback. Exactly what cloudFetchOrder() produces for a
   backfill-migrated photo. */
const migrated = (n) => ({ storageRef: "workorders/x/" + n + ".jpg", imgFallback: FULL, caption: "c" });
const uploaded = (n) => ({ img: FULL, thumb: THUMB, storageRef: "workorders/x/" + n + ".jpg", caption: "c" });
const legacyCloud = (n) => ({ img: FULL, thumb: THUMB, _cloudImg: true, caption: "c" + n });
const idbBacked = (n) => ({ img: FULL, thumb: THUMB, _idbBacked: true, localId: "lp_" + n });
const notUploaded = (n) => ({ img: FULL, caption: "c" + n }); // only copy anywhere!

// ---------------------------------------------------------------- root cause

test("REGRESSION: a migrated photo's full-res imgFallback never reaches localStorage", () => {
  const c = load();
  const db = { index: [{ id: "o1", savedAt: 1 }], orders: { o1: { photos: [migrated(0), migrated(1)] } } };

  assert.equal(c.saveDb(db), true);
  const written = c.__store.k;

  assert.ok(!written.includes(FULL), "full-resolution imgFallback bytes must not be written to localStorage");
  assert.ok(written.includes("workorders/x/0.jpg"), "the storageRef pointer is still cached (that is the whole point)");
});

test("REGRESSION: eviction can SEE imgFallback bytes (orderHasCachedPhotoBytes)", () => {
  const c = load();
  // Before the fix this returned false -- an order made entirely of migrated
  // photos looked byte-free, so no eviction rung would ever touch it.
  assert.equal(c.orderHasCachedPhotoBytes({ photos: [migrated(0)] }), true);
  assert.equal(c.orderHasCachedPhotoBytes({ photos: [{ storageRef: "workorders/x/0.jpg", thumb: THUMB }] }), false);
});

test("REGRESSION: stripPhotoBytes drops imgFallback, not just img", () => {
  const c = load();
  const stripped = c.stripPhotoBytes({ photos: [uploaded(0), migrated(1)] });
  assert.ok(!stripped.photos[0].img, "img dropped");
  assert.ok(!stripped.photos[1].imgFallback, "imgFallback dropped too");
  assert.ok(stripped.photos[0].thumb, "the 200px thumb survives this rung");
  assert.equal(stripped.photosStripped, true);
});

test("a byte-less cached copy reads as stripped even when it still has a storageRef", () => {
  const c = load();
  // storageRef is a pointer needing a round-trip, not something renderable --
  // so loadOrder() must still prefer a cloud refetch over this copy.
  assert.equal(c.orderPhotosAreStrippedLocally({ photos: [{ storageRef: "workorders/x/0.jpg" }] }), true);
  assert.equal(c.orderPhotosAreStrippedLocally({ photos: [{ storageRef: "workorders/x/0.jpg", thumb: THUMB }] }), false,
    "a thumb IS renderable -- that copy is good enough to open offline");
});

// ------------------------------------------------------- terminal quota loop

test("REGRESSION: a cache of thumbs-only orders is still recoverable (rung 0 frees nothing)", () => {
  /* The exact shape of Mark's loop: Phase 1 has offloaded every `img`, so the
     only rung that existed frees NOTHING. Before the fix this returned false
     and toasted; now rungs 1 and 2 get the save through. */
  const c = load({ currentId: "cur", quotaBytes: 900 });
  const orders = { cur: { photos: [notUploaded(0)], _cloudBaseSavedAt: 1 } };
  const index = [{ id: "cur", savedAt: 99 }];
  for (let i = 0; i < 12; i++){
    orders["o" + i] = { photos: [{ storageRef: "workorders/o" + i + "/0.jpg", thumb: THUMB }], _cloudBaseSavedAt: 1 };
    index.push({ id: "o" + i, savedAt: i });
  }
  const db = { index, orders };

  assert.equal(c.evictCloudBackedPhotoBytes(db), false, "rung 0 has nothing to free -- this is the dead end");
  assert.equal(c.saveDb(db), true, "the save still gets through by escalating");
  assert.deepEqual(c.__toasts, [], "and the tech is never told storage is full");
  assert.ok(db.orders.cur, "the OPEN order is never evicted");
  assert.ok(db.orders.cur.photos[0].img, "and its never-uploaded bytes are never dropped");
});

test("eviction escalates cheapest-first: full-res bytes go before thumbs", () => {
  /* legacyCloud, not uploaded(): a photo WITH a storageRef never has its img
     written to localStorage in the first place (leanDbReplacer), so it has no
     full-res bytes for rung 0 to free. The bytes that do reach the cache are
     exactly the ones with no fetch-by-pointer route home. */
  const c = load({ currentId: "cur", quotaBytes: 700 });
  const db = {
    index: [{ id: "cur", savedAt: 9 }, { id: "o1", savedAt: 2 }, { id: "o2", savedAt: 1 }],
    orders: {
      cur: { photos: [{ thumb: THUMB, storageRef: "workorders/cur/0.jpg" }], _cloudBaseSavedAt: 1 },
      o1: { photos: [legacyCloud(0)], _cloudBaseSavedAt: 1 },
      o2: { photos: [legacyCloud(0)], _cloudBaseSavedAt: 1 }
    }
  };

  assert.equal(c.saveDb(db), true);
  assert.ok(db.orders.o1 && db.orders.o2, "records survive -- rung 0 was enough, rung 2 never ran");
  assert.ok(!db.orders.o1.photos[0].img && !db.orders.o2.photos[0].img, "full-res bytes freed");
  assert.ok(db.orders.o1.photos[0].thumb, "thumbs kept: the cheaper rung was sufficient");
});

test("DATA-LOSS GUARD: record eviction never drops the open order, an unsynced one, or one never in the cloud", () => {
  const c = load({ currentId: "cur", pending: { pend: {} }, quotaBytes: 400 });
  const db = {
    index: [{ id: "cur", savedAt: 9 }, { id: "pend", savedAt: 8 }, { id: "local", savedAt: 7 },
            { id: "o1", savedAt: 2 }, { id: "o2", savedAt: 1 }],
    orders: {
      cur: { photos: [notUploaded(0)] },
      pend: { photos: [notUploaded(0)] },
      local: { photos: [notUploaded(0)] },              // never reached the cloud: no _cloudBaseSavedAt
      o1: { photos: [uploaded(0)], _cloudBaseSavedAt: 1 },
      o2: { photos: [uploaded(0)], _cloudBaseSavedAt: 1 }
    }
  };

  c.saveDb(db); // may or may not fit; what matters is WHAT it was willing to drop

  assert.ok(db.orders.cur, "the open order is never dropped");
  assert.ok(db.orders.pend, "an order still waiting to sync is never dropped");
  assert.ok(db.orders.local, "an order that never reached the cloud is never dropped -- it is the only copy");
  assert.ok(!db.orders.o1 || !db.orders.o2, "cloud-persisted records are what get shed");
});

test("record eviction drops the OLDEST cloud-persisted orders first", () => {
  const c = load({ currentId: null, quotaBytes: 700 });
  const orders = {}, index = [];
  for (let i = 0; i < 10; i++){
    orders["o" + i] = { photos: [{ storageRef: "workorders/o" + i + "/0.jpg", thumb: THUMB }], _cloudBaseSavedAt: 1 };
    index.push({ id: "o" + i, savedAt: i }); // o0 oldest, o9 newest
  }
  const db = { index, orders };

  assert.equal(c.saveDb(db), true);

  const survivors = Object.keys(db.orders).map((k) => +k.slice(1)).sort((x, y) => x - y);
  assert.ok(survivors.length > 0 && survivors.length < 10, "some but not all records were shed");
  assert.ok(survivors[0] > 0, "the oldest order (o0) went first, not a recent one");
  assert.equal(db.index.length, survivors.length, "the index stays in step with the orders map");
});

test("honest failure survives: nothing evictable at ANY rung -> false, and the toast is shown", () => {
  const c = load({ currentId: "cur", quotaBytes: 10 });
  const db = { index: [{ id: "cur", savedAt: 1 }], orders: { cur: { photos: [notUploaded(0)] } } };

  assert.equal(c.saveDb(db), false, "no silent success when the only data is unevictable");
  assert.equal(c.__toasts.length, 1);
  assert.match(c.__toasts[0], /Storage is full/);
  assert.ok(db.orders.cur.photos[0].img, "the unsynced bytes are still there -- we failed rather than lose them");
});

// ------------------------------------------------------- proactive budgeting

test("saveDb trims proactively: the cache is kept under budget, not driven into the quota", () => {
  const c = load({ currentId: null }); // no quota enforcement at all
  const orders = {}, index = [];
  for (let i = 0; i < 400; i++){
    // ~10KB of thumbs each -> ~4MB total, the shape of Mark's real cache
    orders["o" + i] = { photos: [{ storageRef: "workorders/o" + i + "/0.jpg", thumb: "T".repeat(10000) }], _cloudBaseSavedAt: 1 };
    index.push({ id: "o" + i, savedAt: i });
  }
  const db = { index, orders };

  assert.equal(c.saveDb(db), true);
  assert.ok(c.__store.k.length <= c.LOCAL_CACHE_BUDGET_BYTES,
    "written cache is under the budget (" + c.__store.k.length + " <= " + c.LOCAL_CACHE_BUDGET_BYTES + ")");
  assert.ok(c.__store.k.length > c.LOCAL_CACHE_BUDGET_BYTES / 2,
    "and it did not over-shed -- the trim stops as soon as it fits");
  assert.deepEqual(c.__toasts, [], "trimming is silent: the tech never sees a storage message");
});

test("a cache that already fits is never trimmed", () => {
  const c = load({ currentId: null });
  const db = { index: [{ id: "o1", savedAt: 1 }, { id: "o2", savedAt: 2 }],
    orders: { o1: { photos: [uploaded(0)], _cloudBaseSavedAt: 1 }, o2: { photos: [uploaded(0)], _cloudBaseSavedAt: 1 } } };

  assert.equal(c.saveDb(db), true);
  assert.ok(db.orders.o1 && db.orders.o2, "both records kept");
  assert.ok(db.orders.o1.photos[0].img, "and their bytes kept -- nothing is shed under budget");
});

// ------------------------------------------------ what stays out of the cache

test("bytes recovered from IndexedDB are not written back into localStorage", () => {
  /* The Preview re-inflation loop: goToPreview() hydrates every photo, the
     showView() wrapper flushes the local autosave, and before the fix the bytes
     Phase 1 had just offloaded went straight back into localStorage. */
  const c = load();
  const db = { index: [{ id: "o1", savedAt: 1 }], orders: { o1: { photos: [idbBacked(0)] } } };
  assert.equal(c.saveDb(db), true);
  assert.ok(!c.__store.k.includes(FULL), "IDB-backed bytes stay out of the cache");
  assert.ok(c.__store.k.includes("lp_0"), "the localId that finds them again is kept");
});

test("a photo whose bytes exist NOWHERE else is always written, cache pressure or not", () => {
  const c = load();
  const db = { index: [{ id: "o1", savedAt: 1 }], orders: { o1: { photos: [notUploaded(0)] } } };
  assert.equal(c.saveDb(db), true);
  assert.ok(c.__store.k.includes(FULL), "the only copy of a photo is never dropped from the cache");
});

test("a legacy cloud photo keeps its local bytes until the cache is actually under pressure", () => {
  /* Field-first: a tech who saved an order should still see its photos with no
     signal. _cloudImg makes those bytes EVICTABLE, not evicted. */
  const c = load();
  const db = { index: [{ id: "o1", savedAt: 1 }], orders: { o1: { photos: [legacyCloud(0)] } } };
  assert.equal(c.saveDb(db), true);
  assert.ok(c.__store.k.includes(FULL), "kept while there is room");

  const c2 = load({ currentId: "cur", quotaBytes: 300 });
  const db2 = { index: [{ id: "cur", savedAt: 2 }, { id: "o1", savedAt: 1 }],
    orders: { cur: { photos: [] }, o1: { photos: [legacyCloud(0)], _cloudBaseSavedAt: 1 } } };
  assert.equal(c2.saveDb(db2), true);
  assert.ok(!c2.__store.k.includes(FULL), "but freed under pressure, because the cloud doc still has them");
});

test("a Change Order signature is never treated as an evictable photo", () => {
  const c = load();
  const db = { index: [{ id: "o1", savedAt: 1 }],
    orders: { o1: { photos: [uploaded(0)], signature: { img: "SIGNATURE_BYTES" } } } };
  assert.equal(c.saveDb(db), true);
  assert.ok(c.__store.k.includes("SIGNATURE_BYTES"), "the signature carries none of the elsewhere-markers, so it stays");
});
