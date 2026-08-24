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

function makeSandbox(options = {}){
  const elements = {
    "rm-trace-finish-btn": { disabled: false },
    "rm-trace-undo-btn": { disabled: false },
    "rm-trace-count": { textContent: "" }
  };
  const sandbox = {
    document: {
      getElementById(id){
        return elements[id];
      }
    },
    __elements: elements
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between("var rmTraceState", "function rmCancelTrace"),
    sandbox
  );
  sandbox.renderCount = 0;
  sandbox.buttonCount = 0;
  sandbox.rmRenderTracePreview = function(){ sandbox.renderCount += 1; };
  if (!options.realButtons) {
    sandbox.rmUpdateTraceButtons = function(){ sandbox.buttonCount += 1; };
  }
  sandbox.rmTraceState.active = true;
  sandbox.rmTraceState.points = [
    { lat: 1, lng: 1 },
    { lat: 2, lng: 2 },
    { lat: 3, lng: 3 }
  ];
  return sandbox;
}

test("trace vertices can be moved, inserted, and deleted without restarting the trace", () => {
  const sb = makeSandbox();

  sb.rmTraceMovePoint(1, { lat: 20, lng: 21 });
  assert.deepStrictEqual(sb.rmTraceState.points.map((p) => [p.lat, p.lng]), [
    [1, 1],
    [20, 21],
    [3, 3]
  ]);

  sb.rmTraceInsertPoint(1, { lat: 30, lng: 31 });
  assert.deepStrictEqual(sb.rmTraceState.points.map((p) => [p.lat, p.lng]), [
    [1, 1],
    [20, 21],
    [30, 31],
    [3, 3]
  ]);

  sb.rmTraceDeletePoint(0);
  assert.deepStrictEqual(sb.rmTraceState.points.map((p) => [p.lat, p.lng]), [
    [20, 21],
    [30, 31],
    [3, 3]
  ]);
  assert.strictEqual(sb.renderCount, 3);
  assert.strictEqual(sb.buttonCount, 3);
});

test("trace edit operations ignore inactive traces and invalid indexes", () => {
  const sb = makeSandbox();
  const before = JSON.stringify(sb.rmTraceState.points);

  sb.rmTraceMovePoint(99, { lat: 9, lng: 9 });
  sb.rmTraceInsertPoint(-1, { lat: 9, lng: 9 });
  sb.rmTraceDeletePoint(99);
  sb.rmTraceState.active = false;
  sb.rmTraceMovePoint(1, { lat: 9, lng: 9 });
  sb.rmTraceInsertPoint(1, { lat: 9, lng: 9 });
  sb.rmTraceDeletePoint(1);

  assert.strictEqual(JSON.stringify(sb.rmTraceState.points), before);
  assert.strictEqual(sb.renderCount, 0);
  assert.strictEqual(sb.buttonCount, 0);
});

test("inserting on the closing edge appends before the implicit first point", () => {
  const sb = makeSandbox();

  sb.rmTraceInsertPoint(2, { lat: 40, lng: 41 });

  assert.deepStrictEqual(sb.rmTraceState.points.map((p) => [p.lat, p.lng]), [
    [1, 1],
    [2, 2],
    [3, 3],
    [40, 41]
  ]);
});

test("deleting below three trace points disables Finish", () => {
  const sb = makeSandbox({ realButtons: true });

  sb.rmUpdateTraceButtons();
  assert.strictEqual(sb.__elements["rm-trace-finish-btn"].disabled, false);

  sb.rmTraceDeletePoint(2);

  assert.strictEqual(sb.__elements["rm-trace-finish-btn"].disabled, true);
  assert.strictEqual(sb.__elements["rm-trace-undo-btn"].disabled, false);
  assert.match(sb.__elements["rm-trace-count"].textContent, /^2 points/);
});
