"use strict";
/* Admin view access guard: the tab is hidden for field users, but showView()
   itself must also refuse direct showView("admin") calls. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const block = src.slice(src.indexOf("var currentViewName"));

function makeCtx(isAdmin, claims){
  const elements = {};
  const views = ["home","edit","preview","saved","history","reports","ownerqa","roofmapper","dpr","servicemanager","admin"];
  views.forEach((name) => {
    elements["view-" + name] = { style: { display: "none" } };
    elements["tab-" + name] = {
      active: false,
      classList: { toggle: function(_cls, on){ elements["tab-" + name].active = !!on; } }
    };
  });
  const ctx = {
    isAdmin,
    currentAuthClaims: claims || null,
    pendingPinFindingId: null,
    document: { getElementById: (id) => elements[id] || null },
    window: { scrollTo: function(){} },
    renderHomeTiles: function(){},
    renderDoc: function(){},
    renderSaved: function(){},
    renderHistoryList: function(){},
    renderReportsList: function(){},
    loadFeedbackBacklog: function(){},
    loadAuditLogBacklog: function(){},
    ownerEstimateQaOnShow: function(){},
    rmOnShow: function(){},
    dprOnShow: function(){},
    canServiceManage: function(){ return false; },
    smOnShow: function(){},
    openPinModal: function(){}
  };
  vm.runInNewContext(block, ctx);
  ctx.__elements = elements;
  return ctx;
}

test("non-admin direct showView('admin') is redirected to edit", () => {
  const ctx = makeCtx(false);
  ctx.showView("admin");
  assert.equal(ctx.currentViewName, "edit");
  assert.equal(ctx.__elements["view-admin"].style.display, "none");
  assert.equal(ctx.__elements["view-edit"].style.display, "");
  assert.equal(ctx.__elements["tab-admin"].active, false);
  assert.equal(ctx.__elements["tab-edit"].active, true);
});

test("admin direct showView('admin') displays the admin view", () => {
  const ctx = makeCtx(true);
  ctx.showView("admin");
  assert.equal(ctx.currentViewName, "admin");
  assert.equal(ctx.__elements["view-admin"].style.display, "");
  assert.equal(ctx.__elements["tab-admin"].active, true);
});

test("non-owner direct showView('ownerqa') is redirected to edit", () => {
  const ctx = makeCtx(true, { owner: false, role: "admin" });
  ctx.showView("ownerqa");
  assert.equal(ctx.currentViewName, "edit");
  assert.equal(ctx.__elements["view-ownerqa"].style.display, "none");
  assert.equal(ctx.__elements["view-edit"].style.display, "");
  assert.equal(ctx.__elements["tab-ownerqa"].active, false);
  assert.equal(ctx.__elements["tab-edit"].active, true);
});

test("owner direct showView('ownerqa') displays Owner Estimate QA", () => {
  const ctx = makeCtx(true, { owner: true, role: "owner" });
  ctx.showView("ownerqa");
  assert.equal(ctx.currentViewName, "ownerqa");
  assert.equal(ctx.__elements["view-ownerqa"].style.display, "");
  assert.equal(ctx.__elements["tab-ownerqa"].active, true);
});
