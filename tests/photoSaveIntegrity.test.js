"use strict";
/* Phase 0 photo-save data integrity (js/core.js cloudSaveOrder):
   A. Reference-aware Storage deletion + re-home (the b0a57fe corruption fix):
      remove/reorder never deletes a surviving photo's confirmed-good bytes.
   B. Dead-slot drop: a slot with no bytes anywhere isn't re-persisted.
   C. ENUMERATED cleanup: photo docs are deleted by reading what actually
      exists, not by trusting the parent photoCount -- so orphan docs above a
      drifted count can't survive (Mark's "delete all, still 4").
   Extracted from js/core.js, Firestore + Storage stubbed. */
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

function makeCtx(opts){
  opts = opts || {};
  const store = { main: {}, photos: Object.assign({}, opts.existingPhotos || {}) };
  const rec = { photoSets: [], docDeletes: [], storageDeletes: [], uploads: [], resolves: [] };

  function docHandle(docId){
    return {
      id: docId,
      get: async () => ({ exists: Object.prototype.hasOwnProperty.call(store.photos, docId), data: () => store.photos[docId] }),
      set: async (d) => { store.photos[docId] = d; rec.photoSets.push({ docId, doc: d }); },
      delete: async () => { delete store.photos[docId]; rec.docDeletes.push(docId); }
    };
  }
  const photosCol = {
    doc: (docId) => docHandle(docId),
    get: async () => ({
      forEach: (cb) => Object.keys(store.photos).forEach((docId) => {
        const h = docHandle(docId);
        cb({ id: docId, ref: h, data: () => store.photos[docId] });
      })
    })
  };
  const ref = { set: async (m) => { store.main = m; }, collection: () => photosCol };

  const ctx = {
    Date: { now: () => 1234567890 }, console: { warn(){}, log(){} },
    fdb: { collection: () => ({ doc: () => ref }) },
    uploadPhotoToStorage: async (woId, i) => { rec.uploads.push(i); return P(woId, i); },
    deletePhotoFromStorage: async (woId, i) => { rec.storageDeletes.push(i); },
    resolvePhotoImg: async (p) => { rec.resolves.push(p.storageRef); if (opts.resolveOk === false) return null; p.img = "REHOMED"; return p.img; }
  };
  vm.runInNewContext(src.slice(start, end), ctx);
  ctx.__store = store; ctx.__rec = rec;
  return ctx;
}
function survivorRefIdx(store){
  return Object.keys(store.photos).map((k) => { const m = /\/(\d+)\.jpg$/.exec(store.photos[k].storageRef || ""); return m ? +m[1] : null; }).filter((n) => n !== null);
}

test("dead slot dropped; survivor re-homed; no referenced bytes deleted", async () => {
  const ctx = makeCtx({ existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: null }, p2: { i: 2, storageRef: P("wo", 2) } } });
  await ctx.cloudSaveOrder({ id: "wo", photos: [
    { caption: "A", storageRef: P("wo", 0), img: null },
    { caption: "", img: null, storageRef: null, thumb: null, imgFallback: null, localId: null }, // DEAD
    { caption: "C", storageRef: P("wo", 2), img: null }
  ]});
  assert.equal(ctx.__store.main.photoCount, 2);
  assert.equal(ctx.__store.photos.p1.caption, "C", "C compacted into slot 1");
  assert.equal(ctx.__store.photos.p1.storageRef, P("wo", 1), "C re-homed to index 1");
  const refs = survivorRefIdx(ctx.__store);
  ctx.__rec.storageDeletes.forEach((idx) => assert.equal(refs.includes(idx), false, "deleted a referenced index " + idx));
  assert.equal(ctx.__rec.docDeletes.includes("p2"), true, "surplus doc p2 removed");
});

test("SAGA REGRESSION: removing a middle photo deletes no surviving photo's bytes", async () => {
  const ctx = makeCtx({ existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) }, p2: { i: 2, storageRef: P("wo", 2) } } });
  await ctx.cloudSaveOrder({ id: "wo", photos: [ { caption: "B", storageRef: P("wo", 1), img: null }, { caption: "C", storageRef: P("wo", 2), img: null } ]});
  const refs = survivorRefIdx(ctx.__store);
  ctx.__rec.storageDeletes.forEach((idx) => assert.equal(refs.includes(idx), false, "referenced index " + idx + " wrongly deleted"));
  assert.equal(ctx.__store.photos.p0.storageRef, P("wo", 0));
  assert.equal(ctx.__store.photos.p1.storageRef, P("wo", 1));
});

test("offline re-home failure keeps old refs, deletes no referenced bytes", async () => {
  const ctx = makeCtx({ resolveOk: false, existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) }, p2: { i: 2, storageRef: P("wo", 2) } } });
  await ctx.cloudSaveOrder({ id: "wo", photos: [ { caption: "B", storageRef: P("wo", 1), img: null }, { caption: "C", storageRef: P("wo", 2), img: null } ]});
  assert.equal(ctx.__store.photos.p0.storageRef, P("wo", 1), "B keeps its ref offline");
  assert.equal(ctx.__store.photos.p1.storageRef, P("wo", 2), "C keeps its ref offline");
  assert.equal(ctx.__rec.storageDeletes.includes(1), false);
  assert.equal(ctx.__rec.storageDeletes.includes(2), false);
});

test("aligned save: no re-home, no spurious storage deletes", async () => {
  const ctx = makeCtx({ existingPhotos: { p0: { i: 0, storageRef: P("wo", 0) }, p1: { i: 1, storageRef: P("wo", 1) } } });
  await ctx.cloudSaveOrder({ id: "wo", photos: [ { caption: "A", img: "FRESH", storageRef: P("wo", 0) }, { caption: "B", img: null, storageRef: P("wo", 1) } ]});
  assert.deepEqual(ctx.__rec.storageDeletes, []);
  assert.deepEqual(ctx.__rec.uploads, [0], "only the img-bearing photo uploads; B not re-homed");
  assert.equal(ctx.__rec.resolves.length, 0);
});

test("ORPHAN FIX: delete-all removes EVERY photo doc, including orphans above the count", async () => {
  // 12 real docs exist (concurrent-save drift left p8..p11 as orphans).
  const existing = {};
  for (let i = 0; i < 12; i++) existing["p" + i] = { i, storageRef: P("wo", i) };
  const ctx = makeCtx({ existingPhotos: existing });

  await ctx.cloudSaveOrder({ id: "wo", photos: [] }); // Mark deletes everything

  assert.equal(ctx.__store.main.photoCount, 0);
  assert.equal(Object.keys(ctx.__store.photos).length, 0, "NO photo docs survive — orphans p8..p11 are gone too");
  ["p8", "p9", "p10", "p11"].forEach((id) => assert.equal(ctx.__rec.docDeletes.includes(id), true, id + " orphan deleted"));
});

test("ORPHAN FIX: a partial save deletes every doc above the compacted set", async () => {
  const existing = {};
  for (let i = 0; i < 12; i++) existing["p" + i] = { i, storageRef: P("wo", i) };
  const ctx = makeCtx({ existingPhotos: existing });

  await ctx.cloudSaveOrder({ id: "wo", photos: [
    { caption: "x", img: "F", storageRef: null }, { caption: "y", img: "F", storageRef: null }, { caption: "z", img: "F", storageRef: null }
  ]});

  assert.equal(ctx.__store.main.photoCount, 3);
  assert.deepEqual(Object.keys(ctx.__store.photos).sort(), ["p0", "p1", "p2"], "only the 3 written docs remain; p3..p11 all cleaned");
});
