const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "roofmapper.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(){
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    between("function rmIsFiniteNumber", "function rmMeasurementId") +
    between("var rmRepairAreaPinMap", "function rmEnsureRepairAreaPinModal"),
    sandbox
  );
  return sandbox;
}

function plain(v){
  return JSON.parse(JSON.stringify(v));
}

test("repair-area satellite pin builder rejects Null Island but allows valid coordinates", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.rmRepairAreaPinBuildLatLng({ lat: 0, lng: 0 }, "tech_placed"), null);
  assert.deepStrictEqual(
    plain(sb.rmRepairAreaPinBuildLatLng({ lat: 41.25, lng: -95.93 }, "tech_placed")),
    { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed" }
  );
});

test("repair-area drawing pin builder binds x/y to the exact base-map frame", () => {
  const sb = makeSandbox();
  const pin = sb.rmRepairAreaPinBuildXY(
    { lat: 250, lng: 400 },
    { w: 1000, h: 500, url: "https://example.com/job-roof-plan.png" }
  );
  assert.deepStrictEqual(plain(pin), {
    lat: null,
    lng: null,
    x: 0.4,
    y: 0.5,
    source: "tech_placed",
    imageFrame: "roof_base_map",
    imageFrameUrl: "https://example.com/job-roof-plan.png"
  });
});

test("repair-area drawing pin builder rejects missing frame and out-of-image drops", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.rmRepairAreaPinBuildXY({ lat: 5, lng: 5 }, { w: 10, h: 10, url: "" }), null);
  assert.strictEqual(sb.rmRepairAreaPinBuildXY({ lat: -1, lng: 5 }, { w: 10, h: 10, url: "u" }), null);
  assert.strictEqual(sb.rmRepairAreaPinBuildXY({ lat: 5, lng: 11 }, { w: 10, h: 10, url: "u" }), null);
});

test("repair-area pin mode detection keeps GPS and drawing pins mutually exclusive", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.rmRepairAreaPinIsLatLng({ lat: 41, lng: -95, x: null, y: null }), true);
  assert.strictEqual(sb.rmRepairAreaPinIsXY({ lat: null, lng: null, x: 0.2, y: 0.3 }), true);
  assert.strictEqual(sb.rmRepairAreaPinIsLatLng({ lat: 41, lng: -95, x: 0.2, y: null }), false);
  assert.strictEqual(sb.rmRepairAreaPinIsXY({ lat: 41, lng: -95, x: 0.2, y: 0.3 }), false);
});

test("repair-area drawing pins only reopen as existing pins on their exact image frame", () => {
  const sb = makeSandbox();
  const pin = {
    lat: null,
    lng: null,
    x: 0.2,
    y: 0.3,
    imageFrame: "roof_base_map",
    imageFrameUrl: "https://example.com/a.png"
  };
  assert.strictEqual(sb.rmRepairAreaPinMatchesFrame(pin, "https://example.com/a.png"), true);
  assert.strictEqual(sb.rmRepairAreaPinMatchesFrame(pin, "https://example.com/b.png"), false);
  assert.strictEqual(sb.rmRepairAreaPinMatchesFrame({ lat: 41, lng: -95, x: null, y: null }, "https://example.com/a.png"), false);
});
