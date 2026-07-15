"use strict";
/* Phase 1b: keep full photo bytes OUT of localStorage.
   - leanDbReplacer omits a photo's img on serialize ONLY when its bytes are
     safely elsewhere (IDB-confirmed _idbBacked, or Storage storageRef); it never
     touches an un-backed photo's bytes or an unrelated img (e.g. a signature).
   - offloadPhotoBytesToIdb confirms cached bytes into IDB, flags them, and
     re-saves lean.
   Extracted from js/core.js; IDB/db stubbed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

/* ---- leanDbReplacer ---- */
function replacerCtx(){ const ctx = { JSON }; vm.runInNewContext(src.slice(src.indexOf("function leanDbReplacer"), src.indexOf("function saveDb")), ctx); return ctx; }

test("leanDbReplacer drops img for IDB- and Storage-backed photos, keeps un-backed", () => {
  const ctx = replacerCtx();
  const db = { photos: [
    { img: "A_BYTES", _idbBacked: true, localId: "L1", thumb: "tA" },
    { img: "B_BYTES", storageRef: "workorders/w/0.jpg", thumb: "tB" },
    { img: "C_BYTES", localId: "L2", thumb: "tC" } // un-backed: no flag, no ref
  ]};
  const out = JSON.parse(JSON.stringify(db, ctx.leanDbReplacer));
  assert.equal("img" in out.photos[0], false, "IDB-backed img dropped");
  assert.equal("img" in out.photos[1], false, "Storage-backed img dropped");
  assert.equal(out.photos[2].img, "C_BYTES", "un-backed img KEPT (only copy)");
  // metadata always survives
  assert.equal(out.photos[0].thumb, "tA");
  assert.equal(out.photos[0].localId, "L1");
});

test("leanDbReplacer never drops an unrelated img (e.g. a Change Order signature)", () => {
  const ctx = replacerCtx();
  const db = { changeOrderSignature: { img: "SIGNATURE", printName: "Jim", date: "7/15" } };
  const out = JSON.parse(JSON.stringify(db, ctx.leanDbReplacer));
  assert.equal(out.changeOrderSignature.img, "SIGNATURE");
});

/* ---- offloadPhotoBytesToIdb ---- */
function offloadCtx(db, opts){
  opts = opts || {};
  const rec = { puts: [], saved: null };
  const ctx = {
    window: { indexedDB: opts.noIdb ? undefined : {} },
    loadDb: () => db,
    saveDb: (d) => { rec.saved = d; return true; },
    idbPutPhoto: async (localId, bytes) => { rec.puts.push(localId); if (opts.putThrows) throw new Error("idb"); return true; }
  };
  vm.runInNewContext(src.slice(src.indexOf("async function offloadPhotoBytesToIdb"), src.indexOf("/* ================= offline-first: sync queue")), ctx);
  ctx.__rec = rec;
  return ctx;
}

test("offload flags img+localId photos after confirming IDB, then re-saves", async () => {
  const db = { orders: { wo: { photos: [
    { img: "A", localId: "L1" },                       // -> offload
    { img: "B", localId: "L2", _idbBacked: true },     // already flagged -> skip
    { img: "C", storageRef: "workorders/wo/0.jpg" },   // Storage-only, no localId -> skip
    { localId: "L3" }                                   // no img -> skip
  ]}}};
  const ctx = offloadCtx(db);
  const changed = await ctx.offloadPhotoBytesToIdb();
  assert.equal(changed, true);
  assert.deepEqual(ctx.__rec.puts, ["L1"], "only the un-flagged img+localId photo is put to IDB");
  assert.equal(db.orders.wo.photos[0]._idbBacked, true, "flagged after confirmed put");
  assert.ok(ctx.__rec.saved, "re-saved a leaner db");
});

test("offload does NOT flag a photo whose IDB put fails (keeps its localStorage copy)", async () => {
  const db = { orders: { wo: { photos: [{ img: "A", localId: "L1" }] } } };
  const ctx = offloadCtx(db, { putThrows: true });
  const changed = await ctx.offloadPhotoBytesToIdb();
  assert.equal(changed, false);
  assert.equal(db.orders.wo.photos[0]._idbBacked, undefined, "not flagged when the write failed");
  assert.equal(ctx.__rec.saved, null, "nothing re-saved");
});

test("offload is a no-op when IndexedDB is unavailable", async () => {
  const db = { orders: { wo: { photos: [{ img: "A", localId: "L1" }] } } };
  const ctx = offloadCtx(db, { noIdb: true });
  assert.equal(await ctx.offloadPhotoBytesToIdb(), false);
  assert.deepEqual(ctx.__rec.puts, []);
});
