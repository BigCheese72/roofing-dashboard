"use strict";
/* The save-funnel half of "close the photo-loss saga":
     1. cloudSaveOrder DROPS dead photo slots (no bytes anywhere) instead of
        re-persisting them as empty docs that Preview flags forever.
     2. Storage cleanup is REFERENCE-AWARE: it deletes only Storage objects no
        surviving photo still points at -- fixing the pre-existing bug where a
        naive trailing index-range delete destroyed a DIFFERENT photo's bytes
        on any middle-remove/reorder (index-based Storage paths).
     3. A surviving photo whose Storage object is at the wrong index is
        RE-HOMED (fetch old path -> re-upload at its new index); if that fetch
        fails (offline) its old ref is kept and its bytes are never deleted.

   photoSlotIsEmpty / photoStorageIndex / cloudSaveOrder are extracted from
   js/core.js and run in a vm with Firestore + Storage stubbed (no network). */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const start = src.indexOf("function photoSlotIsEmpty");
const end = src.indexOf("async function cloudFetchIndex");
assert.notEqual(start, -1); assert.notEqual(end, -1);

function P(id, i){ return "workorders/" + id + "/" + i + ".jpg"; }

/* Fake Firestore for one work-order doc + its photos subcollection, plus
   stubbed Storage upload/delete/resolve. `existingPhotos` seeds the docs the
   cloud already holds (so the preserve/existing-doc lookup has something to
   read); `storageBytes` models the shared index-keyed Storage namespace for
   collision tests; `resolveOk` toggles whether re-home fetches succeed
   (online) or return null (offline). */
function makeCtx(opts){
  opts = opts || {};
  const store = { main: { photoCount: opts.prevCount || 0 }, photos: Object.assign({}, opts.existingPhotos || {}) };
  const storageBytes = opts.storageBytes ? Object.assign({}, opts.storageBytes) : null;
  const rec = { photoSets: [], docDeletes: [], storageDeletes: [], uploads: [], resolves: [] };

  const photosCol = {
    doc: (docId) => ({
      get: async () => ({ exists: Object.prototype.hasOwnProperty.call(store.photos, docId), data: () => store.photos[docId] }),
      set: async (d) => { store.photos[docId] = d; rec.photoSets.push({ docId: docId, doc: d }); },
      delete: async () => { delete store.photos[docId]; rec.docDeletes.push(docId); }
    }),
    get: async () => ({
      forEach: (cb) => {
        Object.keys(store.photos).forEach((docId) => {
          cb({
            id: docId,
            data: () => store.photos[docId],
            ref: { delete: async () => { delete store.photos[docId]; rec.docDeletes.push(docId); } }
          });
        });
      }
    })
  };
  const ref = {
    get: async () => ({ exists: true, data: () => store.main }),
    set: async (m) => { store.main = m; },
    collection: () => photosCol
  };

  const ctx = {
    Date: { now: () => 1234567890 },
    console: { warn(){}, log(){} },
    fdb: { collection: () => ({ doc: () => ref }) },
    uploadPhotoToStorage: async (woId, i, bytes) => {
      rec.uploads.push({ i: i, bytes: bytes });
      if (storageBytes) storageBytes[i] = bytes;
      return P(woId, i);
    },
    deletePhotoFromStorage: async (woId, i) => { rec.storageDeletes.push(i); },
    resolvePhotoImg: async (p) => {
      rec.resolves.push(p.storageRef);
      if (opts.resolveOk === false) return null;         // offline: can't fetch
      if (storageBytes){
        const idx = Number((/\/(\d+)\.jpg$/.exec(p.storageRef || "") || [])[1]);
        p.img = storageBytes[idx] || null;
        return p.img;
      }
      p.img = "data:image/jpeg;base64,REHOMED_" + p.storageRef;
      return p.img;
    }
  };
  vm.runInNewContext(src.slice(start, end), ctx);
  ctx.__store = store; ctx.__rec = rec;
  return ctx;
}

/* Every storageRef index a surviving photo doc still points at, after the save. */
function survivorRefIndexes(store){
  return Object.keys(store.photos).map((k) => {
    const m = /\/(\d+)\.jpg$/.exec(store.photos[k].storageRef || "");
    return m ? +m[1] : null;
  }).filter((n) => n !== null);
}

test("photoSlotIsEmpty: only a slot with nothing anywhere is empty", () => {
  const ctx = makeCtx();
  assert.equal(ctx.photoSlotIsEmpty({ img: null, storageRef: null, thumb: null, imgFallback: null, localId: null }), true);
  assert.equal(ctx.photoSlotIsEmpty({ storageRef: "workorders/w/2.jpg" }), false, "has a cloud pointer");
  assert.equal(ctx.photoSlotIsEmpty({ img: "data:..." }), false, "has bytes in memory");
  assert.equal(ctx.photoSlotIsEmpty({ thumb: "data:..." }), false, "has a thumb to show");
  assert.equal(ctx.photoSlotIsEmpty({ localId: "L1" }), false, "has a local backup handle");
});

test("dead slot is dropped; survivors re-homed; only the freed index is deleted", async () => {
  const ctx = makeCtx({
    prevCount: 3,
    existingPhotos: {
      p0: { i: 0, storageRef: P("wo", 0) },
      p1: { i: 1, storageRef: null },            // the dead slot's existing (empty) doc
      p2: { i: 2, storageRef: P("wo", 2) }
    }
  });
  const o = { id: "wo", photos: [
    { caption: "A", storageRef: P("wo", 0), img: null },
    { caption: "", img: null, storageRef: null, thumb: null, imgFallback: null, localId: null }, // DEAD
    { caption: "C", storageRef: P("wo", 2), img: null }
  ]};

  await ctx.cloudSaveOrder(o);

  assert.equal(ctx.__store.main.photoCount, 2, "compacted to 2 photos");
  // Docs written: p0 (A) and p1 (C re-homed); no dead doc re-written.
  assert.deepEqual(ctx.__rec.photoSets.map((s) => s.docId).sort(), ["p0", "p1"]);
  const p1doc = ctx.__store.photos.p1;
  assert.equal(p1doc.caption, "C", "C moved into slot 1");
  assert.equal(p1doc.storageRef, P("wo", 1), "C re-homed to storage index 1");
  assert.ok(ctx.__rec.uploads.some((u) => u.i === 1), "C's bytes re-uploaded at index 1");
  assert.equal(ctx.__rec.docDeletes.includes("p2"), true, "stale trailing doc p2 deleted");

  // THE INVARIANT: no Storage object a surviving photo points at is deleted.
  const refs = survivorRefIndexes(ctx.__store);
  ctx.__rec.storageDeletes.forEach((idx) => {
    assert.equal(refs.includes(idx), false, "must not delete a referenced storage index " + idx);
  });
  assert.deepEqual(ctx.__rec.storageDeletes.sort(), [2], "only the now-unreferenced old index 2 is freed");
});

test("SAGA REGRESSION: removing a MIDDLE photo does not delete a later photo's bytes", async () => {
  // Start [A,B,C] at storage 0,1,2; user removed A -> save [B,C].
  const ctx = makeCtx({
    prevCount: 3,
    existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) }, p2: { i: 2, storageRef: P("wo", 2) } }
  });
  const o = { id: "wo", photos: [
    { caption: "B", storageRef: P("wo", 1), img: null },
    { caption: "C", storageRef: P("wo", 2), img: null }
  ]};

  await ctx.cloudSaveOrder(o);

  // Every surviving doc's storageRef index must NOT be in the storage-delete set.
  const refs = survivorRefIndexes(ctx.__store);
  ctx.__rec.storageDeletes.forEach((idx) => {
    assert.equal(refs.includes(idx), false, "referenced storage index " + idx + " was wrongly deleted");
  });
  assert.equal(ctx.__store.photos.p0.caption, "B");
  assert.equal(ctx.__store.photos.p1.caption, "C");
  assert.equal(ctx.__store.photos.p0.storageRef, P("wo", 0), "B re-homed to 0");
  assert.equal(ctx.__store.photos.p1.storageRef, P("wo", 1), "C re-homed to 1");
});

test("SAGA REGRESSION: swapping cloud-only photos snapshots bytes before re-home uploads", async () => {
  const ctx = makeCtx({
    prevCount: 2,
    storageBytes: { 0: "data:image/jpeg;base64,A_BYTES", 1: "data:image/jpeg;base64,B_BYTES" },
    existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) } }
  });
  const o = { id: "wo", photos: [
    { caption: "B", storageRef: P("wo", 1), img: null },
    { caption: "A", storageRef: P("wo", 0), img: null }
  ]};

  await ctx.cloudSaveOrder(o);

  assert.equal(ctx.__store.photos.p0.caption, "B");
  assert.equal(ctx.__store.photos.p1.caption, "A");
  assert.deepEqual(ctx.__rec.resolves, [P("wo", 1), P("wo", 0)], "both old locations fetched before uploads");
  assert.deepEqual(ctx.__rec.uploads, [
    { i: 0, bytes: "data:image/jpeg;base64,B_BYTES" },
    { i: 1, bytes: "data:image/jpeg;base64,A_BYTES" }
  ], "each destination receives its original photo bytes");
  assert.equal(ctx.__store.photos.p0.storageRef, P("wo", 0));
  assert.equal(ctx.__store.photos.p1.storageRef, P("wo", 1));
});

test("offline re-home failure keeps old refs and deletes NO referenced bytes", async () => {
  const ctx = makeCtx({
    resolveOk: false, // simulate can't-reach-Storage
    prevCount: 3,
    existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) }, p2: { i: 2, storageRef: P("wo", 2) } }
  });
  const o = { id: "wo", photos: [
    { caption: "B", storageRef: P("wo", 1), img: null },
    { caption: "C", storageRef: P("wo", 2), img: null }
  ]};

  await ctx.cloudSaveOrder(o);

  // B/C keep their OLD refs (couldn't re-home) -> those indexes must survive.
  assert.equal(ctx.__store.photos.p0.storageRef, P("wo", 1), "B keeps its original ref when offline");
  assert.equal(ctx.__store.photos.p1.storageRef, P("wo", 2), "C keeps its original ref when offline");
  assert.equal(ctx.__rec.storageDeletes.includes(1), false, "B's bytes not deleted");
  assert.equal(ctx.__rec.storageDeletes.includes(2), false, "C's bytes not deleted");
  ctx.__rec.storageDeletes.forEach((idx) => {
    assert.equal([1, 2].includes(idx), false, "must not delete a survivor's old storage index " + idx);
  });
});

test("an order whose only photo is a dead slot saves cleanly (no throw, slot dropped)", async () => {
  const ctx = makeCtx({ prevCount: 1, existingPhotos: { p0: { i: 0, storageRef: null } } });
  const o = { id: "wo", photos: [
    { caption: "", img: null, storageRef: null, thumb: null, imgFallback: null, localId: null }
  ]};

  await assert.doesNotReject(ctx.cloudSaveOrder(o));
  assert.equal(ctx.__store.main.photoCount, 0);
  assert.equal(ctx.__rec.photoSets.length, 0, "nothing re-written");
  assert.equal(ctx.__rec.docDeletes.includes("p0"), true, "empty doc removed");
});

test("ordinary aligned save: no re-home, no spurious storage deletes", async () => {
  const ctx = makeCtx({
    prevCount: 2,
    existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) } }
  });
  const o = { id: "wo", photos: [
    { caption: "A", img: "data:image/jpeg;base64,FRESH", storageRef: P("wo", 0) }, // freshly edited -> uploads at 0
    { caption: "B", img: null, storageRef: P("wo", 1) }                              // aligned cloud photo
  ]};

  await ctx.cloudSaveOrder(o);

  assert.equal(ctx.__store.main.photoCount, 2);
  assert.deepEqual(ctx.__rec.storageDeletes, [], "nothing freed on a straight save");
  assert.deepEqual(ctx.__rec.uploads.map((u) => u.i), [0], "only the img-bearing photo uploads; B is not re-homed");
  assert.equal(ctx.__rec.resolves.length, 0, "aligned cloud photo is never re-fetched");
});
