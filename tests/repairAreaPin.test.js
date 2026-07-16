const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Covers the repair-area pin contract surface in js/workorders.js
   (repairAreaById / repairAreaPinValid / setRepairAreaPin /
   openBaseMapPinPicker + the pinCoordIsNumber guard it builds on) plus
   addRepair() from js/photos.js. */
function makeSandbox(opts){
  opts = opts || {};
  const sandbox = {
    repairs: opts.repairs ? opts.repairs.slice() : [],
    __toasts: [],
    __renders: 0,
    __genIdCounter: 0,
    genId(prefix){ return prefix + "_t" + (sandbox.__genIdCounter++); },
    toast(msg){ sandbox.__toasts.push(msg); },
    renderRepairs(){ sandbox.__renders++; }
  };
  if (opts.rmPicker) sandbox.rmOpenRepairAreaPinPicker = opts.rmPicker;
  vm.createContext(sandbox);
  vm.runInContext(
    between(workordersSource, "function pinCoordIsNumber", "function savePinFromModal") +
    between(workordersSource, "function repairAreaById", "/* ================= warranty guidelines") +
    between(photosSource, "function addRepair", "function removeRepair"),
    sandbox
  );
  return sandbox;
}

const XY_PIN = { lat: null, lng: null, x: 0.4, y: 0.6, source: "tech_placed",
  imageFrame: "roof_base_map", imageFrameUrl: "https://example.com/roofplan.png" };
const LATLNG_PIN = { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed" };

test("addRepair gives every new repair area a stable id and an explicit null pin", () => {
  const sb = makeSandbox();
  sb.addRepair();
  assert.ok(sb.repairs[0].id, "new repair row must carry an id");
  assert.strictEqual(sb.repairs[0].pin, null);
});

test("fill() self-heal backfills id + null pin onto legacy repair rows", () => {
  const sb = makeSandbox();
  const o = { repairs: [{ repair: "Old repair", location: "SW" }] };
  vm.runInContext(
    "var o = " + JSON.stringify(o) + ";" +
    between(workordersSource, "repairs = (o.repairs", "repairItems = (o.repairItems"),
    sb
  );
  assert.ok(sb.repairs[0].id.startsWith("rep_"), "legacy row gets a rep_ id");
  assert.strictEqual(sb.repairs[0].pin, null);
  assert.strictEqual(sb.repairs[0].repair, "Old repair");
});

test("setRepairAreaPin stores a valid satellite pin and re-renders", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  assert.strictEqual(sb.setRepairAreaPin("rep_a", LATLNG_PIN), true);
  assert.deepStrictEqual(sb.repairAreaById("rep_a").pin, LATLNG_PIN);
  assert.ok(sb.__renders > 0);
});

test("setRepairAreaPin stores a valid x/y roof-plan pin (frame-bound)", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  assert.strictEqual(sb.setRepairAreaPin("rep_a", XY_PIN), true);
  assert.strictEqual(sb.repairAreaById("rep_a").pin.imageFrameUrl, XY_PIN.imageFrameUrl);
});

test("Null Island (0,0) is rejected — never a real repair pin", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  assert.strictEqual(sb.setRepairAreaPin("rep_a",
    { lat: 0, lng: 0, x: null, y: null, source: "tech_placed" }), false);
  assert.strictEqual(sb.repairAreaById("rep_a").pin, null);
});

test("valid zero latitude is NOT rejected (only the exact 0,0 convention point is)", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  assert.strictEqual(sb.setRepairAreaPin("rep_a",
    { lat: 0, lng: -78.5, x: null, y: null, source: "tech_placed" }), true);
});

test("x/y pin without its base-map frame is rejected (#45 lesson)", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  const noFrame = Object.assign({}, XY_PIN, { imageFrameUrl: null });
  assert.strictEqual(sb.setRepairAreaPin("rep_a", noFrame), false);
  const noFrameTag = Object.assign({}, XY_PIN, { imageFrame: undefined });
  assert.strictEqual(sb.setRepairAreaPin("rep_a", noFrameTag), false);
});

test("non-finite / malformed / out-of-range pins are rejected", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  [
    { lat: NaN, lng: 1, x: null, y: null },
    { lat: "41", lng: "-95", x: null, y: null },
    Object.assign({}, XY_PIN, { x: 1.4 }),
    Object.assign({}, XY_PIN, { x: -0.1 }),
    { lat: 41, lng: -95, x: 0.5, y: 0.5, imageFrame: "roof_base_map", imageFrameUrl: "u" }, /* both modes at once */
    {}, "pin" /* null is NOT here — it's the documented clear value, tested below */
  ].forEach(function(bad){
    assert.strictEqual(sb.setRepairAreaPin("rep_a", bad), false, "should reject: " + JSON.stringify(bad));
  });
  assert.strictEqual(sb.repairAreaById("rep_a").pin, null);
});

test("setRepairAreaPin(null) clears the pin; unknown row returns false", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: LATLNG_PIN }] });
  assert.strictEqual(sb.setRepairAreaPin("rep_a", null), true);
  assert.strictEqual(sb.repairAreaById("rep_a").pin, null);
  assert.strictEqual(sb.setRepairAreaPin("rep_nope", LATLNG_PIN), false);
});

test("openBaseMapPinPicker delegates to rmOpenRepairAreaPinPicker when roofmapper provides it", () => {
  const calls = [];
  const sb = makeSandbox({
    repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }],
    rmPicker(id){ calls.push(id); }
  });
  sb.openBaseMapPinPicker("rep_a");
  assert.deepStrictEqual(calls, ["rep_a"]);
  assert.strictEqual(sb.__toasts.length, 0);
});

test("openBaseMapPinPicker degrades to a toast until the roofmapper popup lands", () => {
  const sb = makeSandbox({ repairs: [{ id: "rep_a", repair: "x", location: "", pin: null }] });
  sb.openBaseMapPinPicker("rep_a");
  assert.strictEqual(sb.__toasts.length, 1);
  sb.openBaseMapPinPicker("rep_unknown"); /* unknown row: silent no-op, no crash */
  assert.strictEqual(sb.__toasts.length, 1);
});
