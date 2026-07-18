"use strict";

// DPR compact section chips — Mark: "can they be buttons that open a fill
// field instead of using so much space vertically". One "More to report?"
// chip row replaces the eight always-visible Yes/No cards; the hidden
// per-card <select> toggles stay the source of truth so collect()/fill()
// semantics are byte-for-byte what they were.
//
// Coverage:
//   1. every DPR_SECTIONS entry's ids exist in the shipped index.html
//      (card, toggle, body, chip host) — the map can't drift from the markup,
//      and toolbox is included (this is the #141+#155 reconciliation)
//   2. dprToggleSection ON -> gate Yes, card shown, collect() carries the
//      section; OFF -> gate No, card hidden, collect() drops it
//   3. fill() of a doc with section data lights the chip + shows the card;
//      a fresh/new report collapses everything
//   4. a locked report refuses chip toggles and renders chips disabled

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function realSlugify(s){
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

function makeSandbox(){
  const els = {};
  function el(id){
    if (!els[id]) els[id] = { id, style: { display: "" }, innerHTML: "", value: "",
      querySelectorAll(){ return []; }, querySelector(){ return null; }, addEventListener(){}, scrollIntoView(){} };
    return els[id];
  }
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById: (id) => el(id) },
    __els: els,
    fdb: null, currentAuthClaims: null, currentAuthUser: null,
    slugify: realSlugify,
    customerIdFor(b){ const n=(b||"").trim(); return n?("cust_"+realSlugify(n)):null; },
    buildingIdFor(b,j){ const bn=(j||"").trim(); if(!bn) return null; const c=(b||"").trim()?("cust_"+realSlugify(b.trim())):null; return "bld_"+realSlugify((c||"nocust")+"_"+bn); },
    __fields: {},
    val(id){ return sandbox.__fields[id] !== undefined ? sandbox.__fields[id] : ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){}, esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return [{ id: "roof_default", label: "Roof 1" }]; },
    L: { latLng(a,b){ return { lat:a, lng:b }; } },
    setTimeout, clearTimeout, authHeaders: async () => ({})
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test("every DPR_SECTIONS id (card/toggle/body) and the chip host exist in index.html — incl. toolbox", () => {
  const s = makeSandbox();
  assert.strictEqual(s.DPR_SECTIONS.length, 8);
  assert.ok(s.DPR_SECTIONS.some((sec) => sec.key === "toolbox"), "toolbox joins the chip row (#141+#155 reconcile)");
  s.DPR_SECTIONS.forEach((sec) => {
    ["card", "toggle", "body"].forEach((k) => {
      assert.ok(html.includes('id="' + sec[k] + '"'), sec.key + " " + k + " id missing from index.html: " + sec[k]);
    });
  });
  assert.ok(html.includes('id="dpr-section-chips"'));
  // the gated cards start collapsed — the chip row is the entry point
  s.DPR_SECTIONS.forEach((sec) => {
    const at = html.indexOf('id="' + sec.card + '"');
    assert.ok(/style="display:none"/.test(html.slice(at, at + 60)), sec.card + " must start hidden");
  });
});

test("chip ON carries the section into collect(); chip OFF drops it and hides the card", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A" });
  s.dprToggleSection("visitors");
  assert.strictEqual(s.val("dpr-visitors-toggle"), "Yes");
  assert.strictEqual(s.__els["dpr-card-visitors"].style.display, "");
  s.setVal("dpr-visitors-notes", "GC walked the roof");
  let out = s.dprCollect();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out.visitors)), { notes: "GC walked the roof" });
  s.dprToggleSection("visitors");
  assert.strictEqual(s.val("dpr-visitors-toggle"), "No");
  assert.strictEqual(s.__els["dpr-card-visitors"].style.display, "none");
  out = s.dprCollect();
  assert.strictEqual(out.visitors, null);
});

test("the toolbox chip toggles the toolbox section", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A", crew: [{ name: "Jose Garcia", hours: "" }] });
  s.dprToggleSection("toolbox");
  assert.strictEqual(s.val("dpr-toolbox-toggle"), "Yes");
  assert.strictEqual(s.__els["dpr-card-toolbox"].style.display, "");
  assert.match(s.__els["dpr-section-chips"].innerHTML, /✓ Toolbox Talk/);
});

test("chips render their on/off state (✓ active, + inactive)", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A" });
  s.dprToggleSection("delays");
  const chips = s.__els["dpr-section-chips"].innerHTML;
  assert.match(chips, /✓ Delays/);
  assert.match(chips, /\+ Visitors/);
});

test("filling a doc WITH section data lights the chip and shows the card; a fresh doc collapses all", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    delays: { cause: "Weather", hoursLost: "2", notes: "" } });
  assert.strictEqual(s.__els["dpr-card-delays"].style.display, "");
  assert.match(s.__els["dpr-section-chips"].innerHTML, /✓ Delays/);
  s.dprFill({ date: "2026-07-17", jobName: "N", billTo: "A" });
  assert.strictEqual(s.__els["dpr-card-delays"].style.display, "none");
  assert.match(s.__els["dpr-section-chips"].innerHTML, /\+ Delays/);
});

test("a locked report refuses chip toggles and renders the chips disabled", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    signoff: { signed: true, locked: true } });
  s.dprToggleSection("jsa");
  assert.strictEqual(s.val("dpr-jsa-toggle"), "No", "locked must refuse the toggle");
  assert.match(s.__els["dpr-section-chips"].innerHTML, /disabled/);
});
