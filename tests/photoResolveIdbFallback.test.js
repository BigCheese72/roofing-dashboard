"use strict";
/* Phase 1a: resolvePhotoImg falls back to the IndexedDB backup (by localId)
   before Storage, so a locally-added photo whose bytes live only in IDB (its
   localStorage copy offloaded) can still be shown/exported. Extracted from
   js/core.js with idbGetPhoto / fetchPhotoFromStorage stubbed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const block = src.slice(src.indexOf("async function resolvePhotoImg"), src.indexOf("function photoSlotIsEmpty"));

function makeCtx(opts){
  opts = opts || {};
  const rec = { idbCalls: [], storageCalls: [] };
  const ctx = {
    idbGetPhoto: async (localId) => { rec.idbCalls.push(localId); if (opts.idbThrows) throw new Error("idb"); return (opts.idb && opts.idb[localId]) || null; },
    fetchPhotoFromStorage: async (wo, i) => { rec.storageCalls.push([wo, i]); if (opts.storageThrows) throw new Error("net"); return "STORAGE_BYTES"; }
  };
  vm.runInNewContext(block, ctx);
  ctx.__rec = rec;
  return ctx;
}

test("in-memory img short-circuits (no IDB, no Storage)", async () => {
  const ctx = makeCtx({});
  const p = { img: "MEM" };
  assert.equal(await ctx.resolvePhotoImg(p), "MEM");
  assert.equal(ctx.__rec.idbCalls.length, 0);
  assert.equal(ctx.__rec.storageCalls.length, 0);
});

test("IDB backup is used first when localId has bytes; caches onto p.img", async () => {
  const ctx = makeCtx({ idb: { L1: "IDB_BYTES" } });
  const p = { localId: "L1", storageRef: "workorders/wo/0.jpg", img: null };
  assert.equal(await ctx.resolvePhotoImg(p), "IDB_BYTES");
  assert.equal(p.img, "IDB_BYTES", "cached in memory");
  assert.deepEqual(ctx.__rec.storageCalls, [], "did not hit Storage when IDB had it");
});

test("falls back to Storage when localId has no IDB bytes", async () => {
  const ctx = makeCtx({ idb: {} });
  const p = { localId: "L1", storageRef: "workorders/wo/2.jpg", img: null };
  assert.equal(await ctx.resolvePhotoImg(p), "STORAGE_BYTES");
  assert.deepEqual(ctx.__rec.idbCalls, ["L1"]);
  assert.deepEqual(ctx.__rec.storageCalls, [["wo", 2]]);
});

test("a cloud-only photo (no localId) goes straight to Storage", async () => {
  const ctx = makeCtx({});
  const p = { storageRef: "workorders/wo/3.jpg", img: null };
  assert.equal(await ctx.resolvePhotoImg(p), "STORAGE_BYTES");
  assert.equal(ctx.__rec.idbCalls.length, 0);
});

test("IDB error doesn't block Storage fallback", async () => {
  const ctx = makeCtx({ idbThrows: true });
  const p = { localId: "L1", storageRef: "workorders/wo/4.jpg", img: null };
  assert.equal(await ctx.resolvePhotoImg(p), "STORAGE_BYTES");
});

test("nothing anywhere -> null", async () => {
  const ctx = makeCtx({ idb: {} });
  assert.equal(await ctx.resolvePhotoImg({ localId: "L1", storageRef: null, img: null }), null);
  assert.equal(await ctx.resolvePhotoImg({ img: null }), null);
});
