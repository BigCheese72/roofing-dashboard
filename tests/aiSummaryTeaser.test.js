const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Mark, 2026-07-17: the "✨ Draft Summary" button used to be HIDDEN on a
   keyless deploy (production, no AI key). He wants it to be a TEASER instead —
   always visible on a summary-bearing report type, and a tap in the no-key
   state shows a friendly "coming soon" toast (never an error, never a
   half-generated placeholder). When a key IS present it generates a real draft
   exactly as before. These tests pin both halves: the visibility gate
   (onWoTypeChange, js/core.js) and the tap branch (draftReportSummary,
   js/workorders.js). */

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const woSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* ---- Visibility: onWoTypeChange() shows the button as a teaser --------------
   Runs the real onWoTypeChange() with every element stubbed. Crucially,
   aiSummaryConfigured()/probeAiSummaryCapability() are typeof-guarded in the
   source and deliberately NOT provided here — modelling the worst case (the
   probe has never resolved). The button must STILL be visible, proving the
   teaser no longer waits on a key. */
function runTypeChange(woType){
  const els = {};
  const vals = { woType };
  const sandbox = {
    WORK_ORDER_TYPES: ["Leak / Service", "Change Order", "Inspection", "Repair", "Warranty"],
    val(id){ return Object.prototype.hasOwnProperty.call(vals, id) ? vals[id] : ""; },
    document: {
      getElementById(id){
        if (!els[id]) els[id] = { style: { display: "unset" }, textContent: "" };
        return els[id];
      }
    },
    renderChangeOrderPhotos(){},
    ensureInspectionChecklist(){},
    renderInspectionChecklist(){},
    renderInspectionRoofPicker(){}
  };
  vm.createContext(sandbox);
  vm.runInContext(between(coreSource, "function onWoTypeChange()", "/* ================= storage"), sandbox);
  sandbox.onWoTypeChange();
  return els;
}

test("teaser: Draft Summary button is VISIBLE on the summary-bearing types even with no AI key probed", () => {
  assert.strictEqual(runTypeChange("Inspection")["wo-draft-summary-row"].style.display, "");
  assert.strictEqual(runTypeChange("Leak / Service")["wo-draft-summary-row"].style.display, "");
  assert.strictEqual(runTypeChange("Repair")["wo-draft-summary-row"].style.display, "");
});

test("Draft Summary button stays hidden on Change Order and Warranty (no Summary section)", () => {
  assert.strictEqual(runTypeChange("Change Order")["wo-draft-summary-row"].style.display, "none");
  assert.strictEqual(runTypeChange("Warranty")["wo-draft-summary-row"].style.display, "none");
});

/* ---- Tap behavior: draftReportSummary() -------------------------------------
   Runs the real draftReportSummary() with fetch/toast/setVal spied. The
   capability probe is injected per-case so we can drive keyless / keyed /
   not-yet-probed independently. */
function makeHarness(opts){
  const calls = { toasts: [], fetches: [], setVals: [], probed: 0 };
  const sandbox = {
    console,
    val(){ return ""; },                 /* no existing summary -> no confirm() */
    setVal(id, v){ calls.setVals.push({ id, v }); },
    toast(msg){ calls.toasts.push(msg); },
    confirm(){ return true; },
    collect(){ return {}; },
    buildSummaryDraftPayload(){ return {}; },
    async authHeaders(){ return {}; },
    async fetch(url, init){
      calls.fetches.push({ url, init });
      return {
        ok: true, status: 200,
        async json(){ return opts.fetchJson || { ok: true, draft: "DRAFT TEXT", llm: true, model: "claude", photosSeen: 2 }; }
      };
    }
  };
  if (opts.configured !== undefined){
    sandbox.aiSummaryConfigured = function(){ return opts.configured; };
  }
  if (opts.probeResolvesTo !== undefined){
    sandbox.probeAiSummaryCapability = async function(){ calls.probed++; return opts.probeResolvesTo; };
  }
  vm.createContext(sandbox);
  vm.runInContext(between(woSource, "async function draftReportSummary(btn){", "function fill(o){"), sandbox);
  return { sandbox, calls };
}

test("keyless (configured:false) -> a tap shows the coming-soon toast and never calls the server", async () => {
  const h = makeHarness({ configured: false });
  await h.sandbox.draftReportSummary(null);
  assert.deepStrictEqual(h.calls.toasts, ["✨ AI Draft Summary — coming soon"]);
  assert.strictEqual(h.calls.fetches.length, 0, "no draft fetch on a keyless deploy");
  assert.strictEqual(h.calls.setVals.length, 0, "no draft inserted");
});

test("keyed (configured:true) -> a tap generates a real draft and inserts it", async () => {
  const h = makeHarness({ configured: true });
  await h.sandbox.draftReportSummary(null);
  assert.strictEqual(h.calls.fetches.length, 1, "the real generate flow runs");
  assert.strictEqual(h.calls.fetches[0].url, "/.netlify/functions/generate-summary");
  const body = JSON.parse(h.calls.fetches[0].init.body);
  assert.strictEqual(body.action, "draft_summary");
  assert.deepStrictEqual(h.calls.setVals, [{ id: "summary", v: "DRAFT TEXT" }]);
  assert.match(h.calls.toasts[0], /AI draft inserted/);
  assert.ok(!h.calls.toasts.some(t => /coming soon/.test(t)), "no coming-soon toast when keyed");
});

test("not-yet-probed (null) -> awaits the probe; resolves false -> coming-soon, no server call", async () => {
  const h = makeHarness({ configured: null, probeResolvesTo: false });
  const btn = { disabled: false };
  await h.sandbox.draftReportSummary(btn);
  assert.strictEqual(h.calls.probed, 1, "the probe is awaited when state is unknown");
  assert.deepStrictEqual(h.calls.toasts, ["✨ AI Draft Summary — coming soon"]);
  assert.strictEqual(h.calls.fetches.length, 0);
  assert.strictEqual(btn.disabled, false, "button is re-enabled after the probe await — no leaked-disabled state");
});

test("not-yet-probed (null) -> awaits the probe; resolves true -> generates a real draft", async () => {
  const h = makeHarness({ configured: null, probeResolvesTo: true });
  await h.sandbox.draftReportSummary(null);
  assert.strictEqual(h.calls.probed, 1);
  assert.strictEqual(h.calls.fetches.length, 1, "generate runs once the probe confirms a key");
  assert.deepStrictEqual(h.calls.setVals, [{ id: "summary", v: "DRAFT TEXT" }]);
});
