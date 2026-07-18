"use strict";

// Regression: the Foreman type-ahead roster must survive an entry AND an erase.
//
// Bug (Mark): "when I put in a foreman … the autofill list disappeared on me.
// Even after I erased the field." The foreman field is the one input whose
// field-history key ("dprForeman") collides with its own rich datalist id
// ("dl-dprForeman"). The generic rememberFieldValue() ends by calling
// populateFieldDatalist("dprForeman"), which rebuilds dl-dprForeman from device
// history ONLY — wiping the 9-name roster — and an erase-blur returns early
// without rebuilding, so it never came back. dprRememberForeman() is the fix:
// remember, then restore the full roster.
//
// Same VM-sandbox approach as tests/dpr.test.js, but with a tiny fake datalist
// DOM + faithful copies of the core.js field-history helpers (the ones the real
// onblur path runs) so this exercises the actual collision, not a mock of it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

function optionCount(el){ return (el.innerHTML.match(/<option/g) || []).length; }

function makeSandbox(){
  const datalists = { "dl-dprForeman": { innerHTML: "" } };
  const lsStore = {};
  const localStorage = {
    getItem(k){ return Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null; },
    setItem(k, v){ lsStore[k] = String(v); }
  };

  // --- faithful copies of the core.js field-history helpers the onblur runs ---
  const FIELD_HISTORY_CAP = 25;
  function fieldHistoryStorageKey(key){ return "field-history:" + key; }
  function getFieldHistory(key){
    try{
      const raw = localStorage.getItem(fieldHistoryStorageKey(key));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    }catch(e){ return []; }
  }
  function populateFieldDatalist(key){
    const dl = datalists["dl-" + key];
    if (!dl) return;
    dl.innerHTML = getFieldHistory(key).map(function(v){ return "<option value='" + v + "'>"; }).join("");
  }
  function rememberFieldValue(key, value){
    value = (value || "").trim();
    if (!value || value.length > 200) return;
    try{
      let arr = getFieldHistory(key).filter(function(v){ return v !== value; });
      arr.unshift(value);
      if (arr.length > FIELD_HISTORY_CAP) arr = arr.slice(0, FIELD_HISTORY_CAP);
      localStorage.setItem(fieldHistoryStorageKey(key), JSON.stringify(arr));
    }catch(e){ return; }
    populateFieldDatalist(key);
  }

  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById(id){ return datalists[id] || null; } },
    fdb: null,
    localStorage,
    getFieldHistory, rememberFieldValue, populateFieldDatalist,
    esc(s){ return String(s == null ? "" : s); },
    toast(){},
    setTimeout, clearTimeout,
    __datalists: datalists
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test("the roster seeds the foreman datalist (9 foremen)", () => {
  const s = makeSandbox();
  s.dprPopulateForemen();
  assert.strictEqual(optionCount(s.__datalists["dl-dprForeman"]), 9);
});

test("the OLD path proves the clobber: rememberFieldValue alone strips the roster to history-only", () => {
  const s = makeSandbox();
  s.dprPopulateForemen();
  assert.strictEqual(optionCount(s.__datalists["dl-dprForeman"]), 9);
  // This is exactly what the old onblur did — it wipes the roster down to 1.
  s.rememberFieldValue("dprForeman", "Cletus Bagby");
  assert.strictEqual(optionCount(s.__datalists["dl-dprForeman"]), 1);
});

test("dprRememberForeman keeps the full roster after entering a name", () => {
  const s = makeSandbox();
  s.dprPopulateForemen();
  s.dprRememberForeman("Cletus Bagby");   // Cletus is already in the roster → still 9
  assert.strictEqual(optionCount(s.__datalists["dl-dprForeman"]), 9);
});

test("dprRememberForeman merges a NEW typed name AND keeps the roster (10)", () => {
  const s = makeSandbox();
  s.dprPopulateForemen();
  s.dprRememberForeman("Brand New Foreman");
  assert.strictEqual(optionCount(s.__datalists["dl-dprForeman"]), 10);
});

test("erase-blur restores the roster — the exact bug Mark hit", () => {
  const s = makeSandbox();
  s.dprPopulateForemen();
  s.dprRememberForeman("Cletus Bagby");                 // enter a name
  s.dprRememberForeman("");                             // now erase and blur
  // Roster is fully back (not stuck on the degraded list).
  assert.strictEqual(optionCount(s.__datalists["dl-dprForeman"]), 9);
});
