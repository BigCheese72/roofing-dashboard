const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Slice covers repairScopeLineFor / syncRepairScopeLine / addRepair /
   removeRepair / renderRepairs — the whole "+ Add Repair" ⇄ Repair Scope
   sync surface. */
function makeSandbox(opts){
  opts = opts || {};
  const scopeEl = { value: opts.scope || "" };
  const handlers = [];
  const host = {
    innerHTML: "",
    appendChild(){},
    querySelectorAll(sel){
      if (sel !== "[data-f]") return [];
      /* renderRepairs binds one input listener per field of each row —
         recreate that shape with synthetic elements the tests can "type"
         into (the real handler only touches dataset.i / dataset.f /
         value). */
      const els = [];
      sandbox.repairs.forEach(function(r, i){
        ["repair", "location"].forEach(function(f){
          const el = { dataset: { i: String(i), f: f }, value: r[f] || "" };
          el.addEventListener = function(type, fn){ handlers.push({ i: i, f: f, el: el, fn: fn }); };
          els.push(el);
        });
      });
      return els;
    }
  };
  const sandbox = {
    repairs: opts.repairs ? opts.repairs.slice() : [],
    __fields: { woType: opts.woType === undefined ? "Repair" : opts.woType },
    val(id){ return sandbox.__fields[id] || ""; },
    esc(s){ return String(s == null ? "" : s); },
    rememberFieldValue(){},
    __genIdCounter: 0,
    genId(prefix){ return prefix + "_t" + (sandbox.__genIdCounter++); },
    openBaseMapPinPicker(){},
    document: {
      getElementById(id){
        if (id === "repairs-list") return host;
        if (id === "repairDescription") return scopeEl;
        return null;
      },
      createElement(){ return { className: "", style: {}, innerHTML: "" }; }
    },
    __scope: scopeEl,
    __handlers: handlers
  };
  vm.createContext(sandbox);
  vm.runInContext(between("function repairScopeLineFor", "/* Repair work order type only"), sandbox);
  return sandbox;
}

/* Simulate the tech typing a final value into row i's field f (rebinding
   listeners first, exactly as a real renderRepairs() call would). */
function type(sandbox, i, f, text){
  sandbox.renderRepairs();
  const matches = sandbox.__handlers.filter(function(h){ return h.i === i && h.f === f; });
  assert.ok(matches.length, "no bound handler for row " + i + " field " + f);
  const h = matches[matches.length - 1];
  h.el.value = text;
  h.fn();
}

test("typing a repair row mirrors it into the empty Repair Scope description", () => {
  const sb = makeSandbox();
  sb.addRepair();
  type(sb, 0, "repair", "Replaced pipe boot");
  assert.strictEqual(sb.__scope.value, "• Replaced pipe boot");
  type(sb, 0, "location", "NW corner");
  assert.strictEqual(sb.__scope.value, "• Replaced pipe boot — NW corner");
});

test("per-keystroke edits keep exactly one line in sync (no per-keystroke duplicates)", () => {
  const sb = makeSandbox();
  sb.addRepair();
  ["R", "Re", "Rep", "Repaired seam"].forEach(function(t){ type(sb, 0, "repair", t); });
  assert.strictEqual(sb.__scope.value, "• Repaired seam");
});

test("existing scope text the tech typed is preserved — mirrored line appends after it", () => {
  const sb = makeSandbox({ scope: "Scope per proposal 1042." });
  sb.addRepair();
  type(sb, 0, "repair", "Sealed curb flashing");
  assert.strictEqual(sb.__scope.value, "Scope per proposal 1042.\n• Sealed curb flashing");
});

test("editing a repair row updates its mirrored line in place", () => {
  const sb = makeSandbox({ scope: "Notes first." });
  sb.addRepair();
  type(sb, 0, "repair", "Patched membrane");
  type(sb, 0, "repair", "Patched membrane and re-seamed");
  assert.strictEqual(sb.__scope.value, "Notes first.\n• Patched membrane and re-seamed");
});

test("removing a repair removes only its mirrored line", () => {
  const sb = makeSandbox({ scope: "Keep me." });
  sb.addRepair();
  type(sb, 0, "repair", "Cleared drain");
  sb.addRepair();
  type(sb, 1, "repair", "Reset counterflashing");
  sb.removeRepair(0);
  assert.strictEqual(sb.__scope.value, "Keep me.\n• Reset counterflashing");
});

test("hand-edited mirrored line disengages: never clobbered, never re-appended, not removed", () => {
  const sb = makeSandbox();
  sb.addRepair();
  type(sb, 0, "repair", "Replaced boot");
  /* Tech rewords the mirrored line in the scope box by hand. */
  sb.__scope.value = "Replaced boot per manufacturer spec";
  type(sb, 0, "repair", "Replaced boot x2");
  assert.strictEqual(sb.__scope.value, "Replaced boot per manufacturer spec");
  sb.removeRepair(0);
  assert.strictEqual(sb.__scope.value, "Replaced boot per manufacturer spec");
});

test("no sync outside the Repair work-order type (Work Performed also shows on Inspection/Warranty)", () => {
  ["Inspection", "Warranty", "Leak / Service"].forEach(function(woType){
    const sb = makeSandbox({ woType: woType });
    sb.addRepair();
    type(sb, 0, "repair", "Should not appear");
    sb.removeRepair(0);
    assert.strictEqual(sb.__scope.value, "", woType + " must not touch repairDescription");
  });
});

test("duplicate row with identical text does not double the line", () => {
  const sb = makeSandbox();
  sb.addRepair();
  type(sb, 0, "repair", "Sealed seam");
  sb.addRepair();
  type(sb, 1, "repair", "Sealed seam");
  assert.strictEqual(sb.__scope.value, "• Sealed seam");
});

test("clearing a row's only content removes its mirrored line", () => {
  const sb = makeSandbox();
  sb.addRepair();
  type(sb, 0, "repair", "Temp patch");
  type(sb, 0, "repair", "");
  assert.strictEqual(sb.__scope.value, "");
});
