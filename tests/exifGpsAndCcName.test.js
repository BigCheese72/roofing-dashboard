"use strict";
/* Two #51 follow-ups from Mark's smoke test (2026-07-15):
   (1) imported photos that HAVE EXIF GPS reached CompanyCam unpinned -> parseExifGps()
       in js/photos.js now recovers the coordinate from the original bytes.
   (2) the CompanyCam PDF document name should be {type}_{jobNo} (e.g. leak_17362)
       -> ccDocumentName() in js/export.js.
   Pure functions, extracted from real source and run in a vm (no DOM/network). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBlock(file, startMarker, endMarker, extraGlobals){
  const src = fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8");
  const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a);
  assert.notEqual(a, -1, "missing " + startMarker); assert.notEqual(b, -1, "missing " + endMarker);
  const ctx = Object.assign({ DataView, Uint8Array, isFinite, String, Number, Math }, extraGlobals || {});
  vm.runInNewContext(src.slice(a, b), ctx);
  return ctx;
}

/* ------------------------------------------------------------------ EXIF -- */
// Build a minimal big-endian ("MM") EXIF JPEG carrying one GPS coordinate.
// lat 41deg 30' 18" N = 41.505 ; lon 81deg 36' 36" W = -81.61
function buildExifJpeg(latRef, lat, lonRef, lon){
  const tiff = new Uint8Array(128);
  const dv = new DataView(tiff.buffer);
  const be = false; // DataView default is big-endian when littleEndian arg omitted/false
  dv.setUint16(0, 0x4D4D, be); dv.setUint16(2, 0x002A, be); dv.setUint32(4, 8, be); // TIFF header, IFD0 @8
  dv.setUint16(8, 1, be);                                    // IFD0: 1 entry
  dv.setUint16(10, 0x8825, be); dv.setUint16(12, 4, be); dv.setUint32(14, 1, be); dv.setUint32(18, 26, be); // GPS IFD ptr -> 26
  dv.setUint32(22, 0, be);                                   // next IFD = 0
  dv.setUint16(26, 4, be);                                   // GPS IFD: 4 entries
  dv.setUint16(28, 0x0001, be); dv.setUint16(30, 2, be); dv.setUint32(32, 2, be); tiff[36] = latRef.charCodeAt(0); // latRef
  dv.setUint16(40, 0x0002, be); dv.setUint16(42, 5, be); dv.setUint32(44, 3, be); dv.setUint32(48, 80, be);       // lat -> 80
  dv.setUint16(52, 0x0003, be); dv.setUint16(54, 2, be); dv.setUint32(56, 2, be); tiff[60] = lonRef.charCodeAt(0); // lonRef
  dv.setUint16(64, 0x0004, be); dv.setUint16(66, 5, be); dv.setUint32(68, 3, be); dv.setUint32(72, 104, be);      // lon -> 104
  dv.setUint32(76, 0, be);                                   // next IFD = 0
  [80, 104].forEach((off, k) => {
    const dms = k === 0 ? lat : lon;
    dms.forEach((pair, i) => { dv.setUint32(off + i * 8, pair[0], be); dv.setUint32(off + i * 8 + 4, pair[1], be); });
  });
  const head = [0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x88, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // SOI, APP1 len=136, "Exif\0\0"
  const out = new Uint8Array(head.length + 128 + 2);
  out.set(head, 0); out.set(tiff, head.length); out.set([0xFF, 0xD9], head.length + 128); // + EOI
  return out;
}

const exif = loadBlock("photos.js", "function rmExifGpsFromTiff", "function addPhotosFromFiles");

test("EXIF: recovers a N/W coordinate and applies the hemisphere sign", () => {
  const jpeg = buildExifJpeg("N", [[41,1],[30,1],[18,1]], "W", [[81,1],[36,1],[36,1]]);
  const out = exif.parseExifGps(jpeg.buffer);
  assert.ok(out, "should extract a coordinate");
  assert.ok(Math.abs(out.lat - 41.505) < 1e-6, "lat " + out.lat);
  assert.ok(Math.abs(out.lng - -81.61) < 1e-6, "lng " + out.lng);
});

test("EXIF: S/E hemisphere signs applied correctly", () => {
  const jpeg = buildExifJpeg("S", [[33,1],[52,1],[0,1]], "E", [[151,1],[12,1],[0,1]]);
  const out = exif.parseExifGps(jpeg.buffer);
  assert.ok(out.lat < 0 && Math.abs(out.lat - -33.8667) < 1e-3, "south is negative");
  assert.ok(out.lng > 0 && Math.abs(out.lng - 151.2) < 1e-3, "east is positive");
});

test("EXIF: a non-JPEG or GPS-less buffer returns null (photo imports unchanged)", () => {
  assert.equal(exif.parseExifGps(new Uint8Array([1, 2, 3, 4]).buffer), null, "not a JPEG");
  assert.equal(exif.parseExifGps(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]).buffer), null, "JPEG with no APP1");
});

test("EXIF: (0,0) is rejected, not published as a Null Island pin", () => {
  const jpeg = buildExifJpeg("N", [[0,1],[0,1],[0,1]], "E", [[0,1],[0,1],[0,1]]);
  assert.equal(exif.parseExifGps(jpeg.buffer), null);
});

/* -------------------------------------------------------- ccDocumentName -- */
const nm = loadBlock("export.js", "function ccDocumentTypeSlug", "/* Routes to a fully separate", { collect: () => ({}) });

test("CC document name is {type}_{jobNo}: leak_17362 / repair_17362", () => {
  assert.equal(nm.ccDocumentName({ woType: "Leak / Service", jobNo: "17362" }), "leak_17362.pdf");
  assert.equal(nm.ccDocumentName({ woType: "Repair", jobNo: "17362" }), "repair_17362.pdf");
  assert.equal(nm.ccDocumentName({ woType: "Inspection", jobNo: "88" }), "inspection_88.pdf");
  assert.equal(nm.ccDocumentName({ woType: "Change Order", jobNo: "5" }), "changeorder_5.pdf");
  assert.equal(nm.ccDocumentName({ woType: "Warranty", jobNo: "42" }), "warranty_42.pdf");
});

test("CC document name falls back to the job name when there's no job number, and slug for unknown types", () => {
  assert.equal(nm.ccDocumentName({ woType: "Leak / Service", jobNo: "", jobName: "Tri-Delta" }), "leak_Tri_Delta.pdf");
  assert.equal(nm.ccDocumentName({ woType: "Something New", jobNo: "9" }), "workorder_9.pdf");
});
