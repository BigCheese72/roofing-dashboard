"use strict";
/* The Preview half of "close the photo-loss saga": ensurePhotosLoadedForExport
   no longer collapses every byte-less photo into one scary "couldn't be
   loaded" message. It distinguishes three cases, each handled oppositely:
     - RESOLVABLE  (Storage or on-device backup) -> recovered silently, ok:true
     - LOAD FAILURE (a real pointer that won't load right now) -> hard stop
     - DEAD        (confirmed no bytes anywhere, online) -> offer one-tap remove
   and is careful to NEVER call a slot dead when it can't reach the cloud to
   confirm. Extracted from js/export.js and run with its collaborators stubbed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const start = src.indexOf("async function ensurePhotosLoadedForExport");
const end = src.indexOf("async function generatePdf");
assert.notEqual(start, -1); assert.notEqual(end, -1);

function makeCtx(opts){
  opts = opts || {};
  const rec = { toasts: [], flushes: 0, removed: [] };
  const ctx = {
    console: { warn(){}, log(){} },
    photos: opts.photos || [],
    currentId: "currentId" in opts ? opts.currentId : "wo1",
    fdb: "fdb" in opts ? opts.fdb : {},                 // truthy = cloud available
    renderPhotos(){},
    toast: (m) => rec.toasts.push(m),
    tryFlushSyncQueue: () => { rec.flushes++; },
    confirm: () => opts.confirm !== false,
    removePhoto: (i) => { rec.removed.push(i); ctx.photos.splice(i, 1); },
    resolvePhotoImg: async (p) => {
      if (opts.resolveFails) return null;
      p.img = "data:image/jpeg;base64,FROMSTORAGE"; return p.img;
    },
    idbGetPhoto: async (localId) => (opts.idb && opts.idb[localId]) || null,
    cloudFetchOrder: async () => {
      if (opts.cloudThrows) throw new Error("offline");
      return opts.cloud || null;
    }
  };
  vm.runInNewContext(src.slice(start, end), ctx);
  ctx.__rec = rec;
  return ctx;
}

test("all photos already have bytes -> ok, no work", async () => {
  const ctx = makeCtx({ photos: [{ img: "x" }, { img: "y" }] });
  assert.deepEqual(await ctx.ensurePhotosLoadedForExport(), { ok: true });
});

test("Storage-backed photo is recovered silently -> ok", async () => {
  const ctx = makeCtx({ photos: [{ img: null, storageRef: "workorders/wo1/0.jpg" }] });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, true);
  assert.equal(r.recovered, 1);
  assert.equal(ctx.photos[0].img, "data:image/jpeg;base64,FROMSTORAGE");
});

test("on-device backup (still uploading) is used, toasts, and kicks a background flush", async () => {
  const ctx = makeCtx({ photos: [{ img: null, localId: "L1" }], idb: { L1: "data:LOCALBYTES" } });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, true);
  assert.equal(r.pending, 1);
  assert.equal(ctx.photos[0].img, "data:LOCALBYTES");
  assert.equal(ctx.__rec.flushes, 1, "background upload kicked");
  assert.ok(ctx.__rec.toasts.some((t) => /finishing upload/i.test(t)));
});

test("genuinely dead slot (online, cloud has nothing) -> reason:dead with 1-based nums", async () => {
  const ctx = makeCtx({
    photos: [{ img: null, storageRef: null, localId: null }],
    cloud: { photos: [ {} ] } // cloud copy also has no bytes
  });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "dead");
  assert.deepEqual(r.deadNums, [1]);
  assert.equal(r.deadPhotos.length, 1);
});

test("transient load failure (Storage ref that won't fetch) -> reason:load, NOT dead", async () => {
  const ctx = makeCtx({ resolveFails: true, photos: [{ img: null, storageRef: "workorders/wo1/0.jpg" }] });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load");
  assert.equal(r.missingCount, 1);
});

test("cannot reach cloud to confirm -> a pointerless slot is treated as LOAD, never dead", async () => {
  const ctx = makeCtx({ cloudThrows: true, photos: [{ img: null, storageRef: null, localId: null }] });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load", "must not offer to REMOVE a photo we could not confirm is gone");
});

test("no cloud configured at all -> pointerless slot is LOAD, never dead", async () => {
  const ctx = makeCtx({ fdb: null, photos: [{ img: null, storageRef: null, localId: null }] });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load");
});

test("cloud actually has bytes we lacked locally -> recovered, ok (not dead)", async () => {
  const ctx = makeCtx({
    photos: [{ img: null, storageRef: null, localId: null }],
    cloud: { photos: [ { img: "data:CLOUDBYTES" } ] }
  });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, true);
  assert.equal(ctx.photos[0].img, "data:CLOUDBYTES");
});

test("cloud match has a storageRef we lacked -> adopt + resolve -> recovered", async () => {
  const ctx = makeCtx({
    photos: [{ img: null, storageRef: null, localId: null }],
    cloud: { photos: [ { storageRef: "workorders/wo1/0.jpg" } ] }
  });
  const r = await ctx.ensurePhotosLoadedForExport();
  assert.equal(r.ok, true);
  assert.equal(ctx.photos[0].img, "data:image/jpeg;base64,FROMSTORAGE");
});

test("offerRemoveDeadPhotos: confirm -> removes highest index first, returns true", () => {
  const ctx = makeCtx({ photos: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  const dead = [ctx.photos[1], ctx.photos[2]];
  const ok = ctx.offerRemoveDeadPhotos({ deadPhotos: dead, deadNums: [2, 3] });
  assert.equal(ok, true);
  assert.deepEqual(ctx.__rec.removed, [2, 1], "removed highest-index first so earlier indices stay valid");
});

test("offerRemoveDeadPhotos: decline -> nothing removed, returns false", () => {
  const ctx = makeCtx({ confirm: false, photos: [{ id: "a" }, { id: "b" }] });
  const ok = ctx.offerRemoveDeadPhotos({ deadPhotos: [ctx.photos[1]], deadNums: [2] });
  assert.equal(ok, false);
  assert.deepEqual(ctx.__rec.removed, []);
});
