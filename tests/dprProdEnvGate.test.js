"use strict";
/* DPR (Daily Progress Report) prod-hide / dev-keep gate.
 *
 * Mark's 2026-08-08 dispatch (COORDINATION.md): DPR stays fully usable on the
 * dev environment and dev--/branch/deploy-preview builds, but every entry point
 * is hidden on production. The gate keys off isDevEnvironment() (hostname), not
 * role, via the single predicate isDprEnabled() in js/core.js. Three entry
 * points must agree:
 *
 *   1. the #tab-dpr header button   -> updateDprEnvUI()   (js/core.js)
 *   2. the showView("dpr") route    -> showView()         (js/core.js)  hard gate
 *   3. the home-screen DPR tile      -> renderHomeTiles()  (js/workorders.js)
 *
 * These tests prove: visible/reachable on dev, hidden/blocked on prod, and that
 * nothing else (js/dpr.js, permissions, other views) is touched. Fail-closed:
 * when the env predicate is absent the entry points hide, they do not show.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSrc = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const woSrc = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function sliceBetween(src, start, end){
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return src.slice(a, b);
}

/* ---- showView() harness: same slice as adminViewAccess.test.js ---- */
const showViewBlock = coreSrc.slice(coreSrc.indexOf("var currentViewName"));

function makeShowViewCtx(isDprEnabled){
  const elements = {};
  const views = ["home","edit","preview","saved","history","reports","roofmapper","dpr","servicemanager","admin"];
  views.forEach((name) => {
    elements["view-" + name] = { style: { display: "none" } };
    elements["tab-" + name] = {
      active: false,
      classList: { toggle: function(_cls, on){ elements["tab-" + name].active = !!on; } }
    };
  });
  const ctx = {
    isAdmin: true,
    currentAuthClaims: { owner: true },
    pendingPinFindingId: null,
    __toasts: [],
    __dprShown: 0,
    document: { getElementById: (id) => elements[id] || null },
    window: { scrollTo: function(){} },
    isDprEnabled: function(){ return isDprEnabled; },
    toast: function(m){ ctx.__toasts.push(m); },
    renderHomeTiles: function(){},
    renderDoc: function(){},
    renderSaved: function(){},
    renderHistoryList: function(){},
    renderReportsList: function(){},
    loadFeedbackBacklog: function(){},
    loadAuditLogBacklog: function(){},
    rmOnShow: function(){},
    dprOnShow: function(){ ctx.__dprShown++; },
    canServiceManage: function(){ return true; },
    smOnShow: function(){},
    rolesAdminOnShow: function(){},
    openPinModal: function(){},
    runPendingCcPdfBackfill: function(){}
  };
  vm.runInNewContext(showViewBlock, ctx);
  ctx.__elements = elements;
  return ctx;
}

test("showView('dpr') on dev shows the DPR view and runs dprOnShow", () => {
  const ctx = makeShowViewCtx(true);
  ctx.showView("dpr");
  assert.equal(ctx.currentViewName, "dpr");
  assert.equal(ctx.__elements["view-dpr"].style.display, "");
  assert.equal(ctx.__elements["tab-dpr"].active, true);
  assert.equal(ctx.__dprShown, 1);
  assert.equal(ctx.__toasts.length, 0);
});

test("showView('dpr') on prod is redirected to edit with an explanatory toast", () => {
  const ctx = makeShowViewCtx(false);
  ctx.showView("dpr");
  assert.equal(ctx.currentViewName, "edit");
  assert.equal(ctx.__elements["view-dpr"].style.display, "none");
  assert.equal(ctx.__elements["view-edit"].style.display, "");
  assert.equal(ctx.__elements["tab-edit"].active, true);
  assert.equal(ctx.__dprShown, 0, "dprOnShow must not run when the route is blocked");
  assert.equal(ctx.__toasts.length, 1);
  assert.match(ctx.__toasts[0], /dev environment only/i);
});

test("the prod DPR gate does not disturb other views (edit still works)", () => {
  const ctx = makeShowViewCtx(false);
  ctx.showView("edit");
  assert.equal(ctx.currentViewName, "edit");
  assert.equal(ctx.__toasts.length, 0, "no DPR toast for a non-DPR view");
});

/* ---- updateDprEnvUI() harness: the tab visibility + bounce ---- */
const dprEnvBlock = sliceBetween(
  coreSrc,
  "function isDprEnabled()",
  "/* Attaches the signed-in user's Firebase ID token"
);

function makeDprEnvCtx(isDev, currentViewName){
  const tab = { style: { display: "" } };
  const ctx = {
    isDevEnvironment: function(){ return isDev; },
    currentViewName: currentViewName || "home",
    document: { getElementById: (id) => (id === "tab-dpr" ? tab : null) },
    __bouncedTo: null,
    showView: function(v){ ctx.__bouncedTo = v; }
  };
  vm.runInNewContext(dprEnvBlock, ctx);
  ctx.__tab = tab;
  return ctx;
}

test("isDprEnabled() tracks isDevEnvironment()", () => {
  assert.equal(makeDprEnvCtx(true).isDprEnabled(), true);
  assert.equal(makeDprEnvCtx(false).isDprEnabled(), false);
});

test("updateDprEnvUI() reveals #tab-dpr on dev", () => {
  const ctx = makeDprEnvCtx(true, "home");
  ctx.updateDprEnvUI();
  assert.equal(ctx.__tab.style.display, "");
  assert.equal(ctx.__bouncedTo, null);
});

test("updateDprEnvUI() hides #tab-dpr on prod", () => {
  const ctx = makeDprEnvCtx(false, "home");
  ctx.updateDprEnvUI();
  assert.equal(ctx.__tab.style.display, "none");
});

test("updateDprEnvUI() on prod bounces a session left on the DPR view to edit", () => {
  const ctx = makeDprEnvCtx(false, "dpr");
  ctx.updateDprEnvUI();
  assert.equal(ctx.__tab.style.display, "none");
  assert.equal(ctx.__bouncedTo, "edit");
});

test("updateDprEnvUI() on dev never bounces the DPR view", () => {
  const ctx = makeDprEnvCtx(true, "dpr");
  ctx.updateDprEnvUI();
  assert.equal(ctx.__bouncedTo, null);
});

/* ---- renderHomeTiles() harness: the home-screen tile ---- */
const homeTilesBlock = sliceBetween(woSrc, "function renderHomeTiles()", "function startNewWorkOrder(");

function renderHomeTilesHtml(opts){
  let captured = "";
  const host = {
    childElementCount: 0,
    set innerHTML(v){ captured = v; },
    get innerHTML(){ return captured; }
  };
  const ctx = {
    WORK_ORDER_TYPES: ["Leak / Service"],
    WORK_ORDER_TYPE_ICONS: { "Leak / Service": "🧰" },
    WORK_ORDER_TYPE_LABELS: { "Leak / Service": "Leak / Service" },
    esc: function(s){ return String(s == null ? "" : s); },
    document: { getElementById: (id) => (id === "home-tiles" ? host : null) }
  };
  if (opts && Object.prototype.hasOwnProperty.call(opts, "isDprEnabled")){
    ctx.isDprEnabled = function(){ return opts.isDprEnabled; };
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, "isDevEnvironment")){
    ctx.isDevEnvironment = function(){ return opts.isDevEnvironment; };
  }
  vm.runInNewContext(homeTilesBlock, ctx);
  ctx.renderHomeTiles();
  return captured;
}

test("renderHomeTiles() includes the DPR tile on dev", () => {
  const html = renderHomeTilesHtml({ isDprEnabled: true });
  assert.match(html, /showView\('dpr'\)/);
  assert.match(html, /Daily Progress Report/);
  /* other secondary tiles are unaffected */
  assert.match(html, /showView\('roofmapper'\)/);
  assert.match(html, /showView\('reports'\)/);
});

test("renderHomeTiles() omits the DPR tile on prod", () => {
  const html = renderHomeTilesHtml({ isDprEnabled: false });
  assert.doesNotMatch(html, /showView\('dpr'\)/);
  assert.doesNotMatch(html, /Daily Progress Report/);
  /* everything else still renders -- only the DPR entry point is removed */
  assert.match(html, /showView\('roofmapper'\)/);
  assert.match(html, /showView\('history'\)/);
  assert.match(html, /showView\('reports'\)/);
});

test("renderHomeTiles() falls back to isDevEnvironment() when isDprEnabled is absent", () => {
  assert.match(renderHomeTilesHtml({ isDevEnvironment: true }), /showView\('dpr'\)/);
  assert.doesNotMatch(renderHomeTilesHtml({ isDevEnvironment: false }), /showView\('dpr'\)/);
});

test("renderHomeTiles() fails closed: no env predicate at all hides the DPR tile", () => {
  const html = renderHomeTilesHtml({});
  assert.doesNotMatch(html, /showView\('dpr'\)/);
  assert.match(html, /showView\('reports'\)/);
});
