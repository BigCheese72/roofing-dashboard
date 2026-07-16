const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Covers the shared roof-type list surface: ROOF_TYPES_BUILTIN /
   allRoofTypes / populateRoofSystemSelect / populateRoofSystemDatalist /
   onRoofSystemChange / addRoofType / loadRoofTypes. */
function makeSandbox(opts){
  opts = opts || {};
  const select = { value: "", innerHTML: "" };
  const datalist = { innerHTML: "" };
  const stored = {};
  const writes = [];
  const sandbox = {
    __select: select,
    __datalist: datalist,
    __stored: stored,
    __writes: writes,
    __toasts: [],
    __promptReturns: opts.promptReturns,
    prompt(){ return sandbox.__promptReturns; },
    toast(msg){ sandbox.__toasts.push(msg); },
    esc(s){ return String(s == null ? "" : s); },
    localStorage: {
      getItem(k){ return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; },
      setItem(k, v){ stored[k] = String(v); }
    },
    document: {
      getElementById(id){
        if (id === "roofSystem") return select;
        if (id === "dl-roofSystem") return datalist;
        return null;
      }
    },
    fdb: null,
    firebase: { firestore: { FieldValue: { arrayUnion(v){ return { __arrayUnion: v }; } } } }
  };
  if (opts.cloudTypes !== undefined || opts.recordWrites){
    sandbox.fdb = {
      collection(name){
        return { doc(id){
          return {
            set(data, o){ writes.push({ path: name + "/" + id, data: data, opts: o }); return Promise.resolve(); },
            get(){ return Promise.resolve(opts.cloudTypes === undefined
              ? { exists: false }
              : { exists: true, data(){ return { types: opts.cloudTypes }; } }); }
          };
        } };
      }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(between("var ROOF_TYPES_BUILTIN", "var FIELD_IDS ="), sandbox);
  return sandbox;
}

test("SSM is a builtin roof type", () => {
  const sb = makeSandbox();
  assert.ok(sb.ROOF_TYPES_BUILTIN.includes("SSM"));
  assert.ok(sb.allRoofTypes().includes("SSM"));
});

test("allRoofTypes merges customs after builtins, trims, and de-dupes case-insensitively", () => {
  const sb = makeSandbox();
  sb.customRoofTypes = [" ssm ", "Green Roof", "green roof", "  "];
  const all = sb.allRoofTypes();
  assert.strictEqual(all.filter(t => t.toLowerCase() === "ssm").length, 1, "builtin SSM wins, no dupe");
  assert.strictEqual(all.filter(t => t.toLowerCase() === "green roof").length, 1);
  assert.ok(all.indexOf("Green Roof") > all.indexOf("SSM"), "customs come after builtins");
  assert.ok(!all.includes(""), "blank entries dropped");
});

test("populateRoofSystemSelect keeps a record's off-list value visible and selected", () => {
  const sb = makeSandbox();
  sb.populateRoofSystemSelect("Thatch");
  assert.strictEqual(sb.__select.value, "Thatch");
  assert.match(sb.__select.innerHTML, /<option selected>Thatch<\/option>/);
  assert.match(sb.__select.innerHTML, /__add_new_roof_type__/, "Add-new sentinel option present");
  assert.match(sb.__datalist.innerHTML, /value="SSM"/, "shared datalist populated too");
});

test("populateRoofSystemSelect canonicalizes casing to the listed type", () => {
  const sb = makeSandbox();
  sb.populateRoofSystemSelect("ssm");
  assert.strictEqual(sb.__select.value, "SSM");
});

test("cancelling the Add-new prompt restores the previous selection", () => {
  const sb = makeSandbox({ promptReturns: null });
  sb.populateRoofSystemSelect("PVC");
  sb.__select.value = sb.ROOF_TYPE_ADD_SENTINEL;
  sb.onRoofSystemChange();
  assert.strictEqual(sb.__select.value, "PVC");
  assert.strictEqual(sb.customRoofTypes.length, 0);
});

test("adding a duplicate (any casing) selects the existing type and stores nothing", () => {
  const sb = makeSandbox({ promptReturns: "  fa tpo ", recordWrites: true });
  sb.populateRoofSystemSelect("");
  sb.__select.value = sb.ROOF_TYPE_ADD_SENTINEL;
  sb.onRoofSystemChange();
  assert.strictEqual(sb.__select.value, "FA TPO");
  assert.strictEqual(sb.customRoofTypes.length, 0);
  assert.strictEqual(sb.__writes.length, 0, "no Firestore write for a duplicate");
});

test("adding a new type trims/collapses whitespace, selects it, caches it, arrayUnions it", () => {
  const sb = makeSandbox({ promptReturns: "  Green   Roof  ", recordWrites: true });
  sb.populateRoofSystemSelect("");
  sb.__select.value = sb.ROOF_TYPE_ADD_SENTINEL;
  sb.onRoofSystemChange();
  assert.strictEqual(sb.__select.value, "Green Roof");
  assert.strictEqual(JSON.stringify([...sb.customRoofTypes]), JSON.stringify(["Green Roof"]));
  assert.deepStrictEqual(JSON.parse(sb.__stored["custom-roof-types-v1"]), ["Green Roof"]);
  assert.strictEqual(sb.__writes.length, 1);
  assert.strictEqual(sb.__writes[0].path, "app_settings/roof_types");
  assert.strictEqual(sb.__writes[0].data.types.__arrayUnion, "Green Roof");
  assert.strictEqual(sb.__writes[0].opts.merge, true);
});

test("offline add still lands on the device list (cache) without a Firestore write", () => {
  const sb = makeSandbox({ promptReturns: "Modified Bitumen Cap" }); /* fdb: null */
  sb.populateRoofSystemSelect("");
  sb.__select.value = sb.ROOF_TYPE_ADD_SENTINEL;
  sb.onRoofSystemChange();
  assert.strictEqual(sb.__select.value, "Modified Bitumen Cap");
  assert.deepStrictEqual(JSON.parse(sb.__stored["custom-roof-types-v1"]), ["Modified Bitumen Cap"]);
});

test("loadRoofTypes seeds from device cache, then adopts the shared cloud list", async () => {
  const sb = makeSandbox({ cloudTypes: ["Green Roof", "Solar Overlay"] });
  sb.__stored["custom-roof-types-v1"] = JSON.stringify(["Old Cached Type"]);
  const p = sb.loadRoofTypes();
  assert.ok(sb.allRoofTypes().includes("Old Cached Type"), "cache renders before the fetch lands");
  await p;
  assert.strictEqual(JSON.stringify([...sb.customRoofTypes]), JSON.stringify(["Green Roof", "Solar Overlay"]));
  assert.ok(!sb.allRoofTypes().includes("Old Cached Type"), "cloud list is the shared source of truth");
  assert.match(sb.__datalist.innerHTML, /Solar Overlay/);
  assert.deepStrictEqual(JSON.parse(sb.__stored["custom-roof-types-v1"]), ["Green Roof", "Solar Overlay"]);
});

test("loadRoofTypes preserves the current selection across the cloud refresh", async () => {
  const sb = makeSandbox({ cloudTypes: ["Green Roof"] });
  sb.populateRoofSystemSelect("PVC");
  await sb.loadRoofTypes();
  assert.strictEqual(sb.__select.value, "PVC");
});
