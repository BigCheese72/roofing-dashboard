"use strict";
/* #54: idempotent CompanyCam PDF push. CompanyCam's Documents API is CREATE-ONLY
   (no delete/update), so re-sending an UNCHANGED work order used to pile a
   duplicate PDF into the project. uploadPdfToCompanyCam() now skips the upload
   when the exact same PDF is already on CompanyCam (same content hash + known
   document id). The functions are extracted from js/history.js and run in a vm
   with ccApiPost/fdb/ccDocumentName stubbed -- no network, no Firestore. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const start = src.indexOf("function pdfContentHash");
const end = src.indexOf("/* ================= CompanyCam PHOTO FEED push", start);
assert.notEqual(start, -1); assert.notEqual(end, -1);

function makeCtx(){
  const calls = [];      // upload_document requests that actually went out
  const writes = [];     // ccPersistDocumentInfo merge-writes
  const ctx = {
    String, Number, isFinite,
    ccApiPost: async (body) => { calls.push(body); return { ok: true, document: { id: "doc_" + calls.length } }; },
    ccDocumentName: () => "leak_17362.pdf",
    fdb: { collection: () => ({ doc: () => ({ set: async (d) => { writes.push(d); } }) }) }
  };
  vm.runInNewContext(src.slice(start, end), ctx);
  ctx.__calls = calls; ctx.__writes = writes;
  return ctx;
}
function pdf(base64){ return { output: () => "data:application/pdf;base64," + base64 }; }

test("pdfContentHash is deterministic and content-sensitive", () => {
  const ctx = makeCtx();
  assert.equal(ctx.pdfContentHash("JVBERi0aaa"), ctx.pdfContentHash("JVBERi0aaa"), "same content -> same hash");
  assert.notEqual(ctx.pdfContentHash("JVBERi0aaa"), ctx.pdfContentHash("JVBERi0bbb"), "different content -> different hash");
  assert.notEqual(ctx.pdfContentHash("aaaa"), ctx.pdfContentHash("aaa"), "length is part of the fingerprint");
});

test("ccDocumentPushIsRedundant only when id AND hash both match", () => {
  const ctx = makeCtx();
  assert.equal(ctx.ccDocumentPushIsRedundant({ ccDocumentId: "d1", ccDocumentHash: "h1" }, "h1"), true);
  assert.equal(ctx.ccDocumentPushIsRedundant({ ccDocumentId: "d1", ccDocumentHash: "h1" }, "h2"), false, "changed hash -> not redundant");
  assert.equal(ctx.ccDocumentPushIsRedundant({ ccDocumentHash: "h1" }, "h1"), false, "never pushed (no id) -> not redundant");
  assert.equal(ctx.ccDocumentPushIsRedundant({}, "h1"), false);
});

test("first send uploads; identical re-send SKIPS (no duplicate); a changed report uploads again", async () => {
  const ctx = makeCtx();
  const o = { id: "wo_1", companyCamProjectId: "p1", woType: "Leak / Service", jobNo: "17362" };

  // 1) first send -> uploads
  const r1 = await ctx.uploadPdfToCompanyCam(pdf("SAME_PDF_BYTES"), o);
  assert.equal(r1.ok, true);
  assert.ok(!r1.unchanged);
  assert.equal(r1.documentId, "doc_1");
  assert.equal(ctx.__calls.length, 1, "one upload_document");
  assert.equal(o.ccDocumentId, "doc_1");
  assert.ok(o.ccDocumentHash, "content hash recorded on the order");
  assert.equal(ctx.__writes.length, 1, "doc id + hash persisted");
  assert.equal(ctx.__writes[0].ccDocumentId, "doc_1");

  // 2) re-send the SAME work order (unchanged PDF) -> SKIP, no new upload
  const r2 = await ctx.uploadPdfToCompanyCam(pdf("SAME_PDF_BYTES"), o);
  assert.equal(r2.ok, true);
  assert.equal(r2.unchanged, true);
  assert.equal(ctx.__calls.length, 1, "NO duplicate document uploaded on an unchanged re-send");

  // 3) the report changed -> a new version uploads
  const r3 = await ctx.uploadPdfToCompanyCam(pdf("CHANGED_PDF_BYTES"), o);
  assert.equal(r3.ok, true);
  assert.ok(!r3.unchanged);
  assert.equal(r3.documentId, "doc_2");
  assert.equal(ctx.__calls.length, 2, "a genuinely changed report is uploaded");
  assert.equal(o.ccDocumentId, "doc_2", "tracked id advances to the new version");
});

test("no linked project -> skipped, and nothing is uploaded", async () => {
  const ctx = makeCtx();
  const r = await ctx.uploadPdfToCompanyCam(pdf("x"), { id: "wo_1" });
  assert.equal(r.skipped, true);
  assert.equal(ctx.__calls.length, 0);
});
