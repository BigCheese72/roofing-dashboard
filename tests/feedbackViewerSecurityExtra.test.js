"use strict";
/* Additional Codex-owned feedback viewer/payload edge tests. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const start = src.indexOf("var FEEDBACK_TYPES =");
const end = src.indexOf("/* Auth Phase 2 --");
assert.ok(start > 0 && end > start, "feedback block markers moved in js/core.js");
const block = src.slice(start, end);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeCtx(opts) {
  opts = opts || {};
  const href = opts.href || "https://dev--leak-work-orders.netlify.app/#edit";
  const fields = Object.assign({ "feedback-filter-type": "" }, opts.fields || {});
  const els = {};
  ["feedback-backlog-list", "feedback-screenshot-status", "feedback-type-picker", "feedback-context-hint", "feedback-modal"]
    .forEach(id => { els[id] = { innerHTML: "", textContent: "", style: {} }; });
  const ctx = {
    isAdmin: true,
    currentViewName: "reports",
    currentId: null,
    URL, console,
    window: { location: { href, hostname: new URL(href).hostname } },
    navigator: { userAgent: "test" },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => ({ getAttribute: () => "js/core.js?v=20260724b" })
    },
    val: (id) => fields[id] || "",
    setVal: () => {},
    esc,
    toast: () => {},
    genId: () => "fb_test",
    getFieldHistory: () => [],
    isDevEnvironment: () => true,
    lockBodyScroll: () => {},
    unlockBodyScroll: () => {},
    resizeImageFile: async () => "",
    openImageLightbox: () => {},
    fdb: null,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    __els: els
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(block, ctx);
  if (opts.backlog) ctx.feedbackBacklog = opts.backlog;
  return ctx;
}

test("agentDiagnosis HTML/script text is escaped in the backlog card", () => {
  const ctx = makeCtx({
    backlog: [{
      id: "fb_xss", type: "bug", typeLabel: "Bug", createdAt: 1, triageStatus: "fix_proposed",
      comments: "<img src=x onerror=alert(1)>",
      route: "https://dev--leak-work-orders.netlify.app/?openHelp=1",
      agentDiagnosis: "<script>alert('owned')</script><b onclick=alert(2)>bad</b>"
    }]
  });
  ctx.renderFeedbackBacklog();
  const html = ctx.__els["feedback-backlog-list"].innerHTML;
  assert.ok(!html.includes("<script>"), html);
  assert.ok(!html.includes("<b onclick"), html);
  assert.ok(!html.includes("<img src=x"), html);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;img src=x/);
});

test("a route exactly 500 chars long survives, while longer routes are capped", () => {
  const prefix = "https://dev--leak-work-orders.netlify.app/?openHelp=";
  const exactHref = prefix + "x".repeat(500 - prefix.length);
  assert.strictEqual(exactHref.length, 500);
  const exactRoute = makeCtx({ href: exactHref }).sanitizedFeedbackRoute();
  assert.strictEqual(exactRoute.length, 500);
  assert.strictEqual(exactRoute, exactHref);

  const longRoute = makeCtx({ href: exactHref + "overflow" }).sanitizedFeedbackRoute();
  assert.strictEqual(longRoute.length, 500);
  assert.ok(!longRoute.includes("overflow"));
});

test("additional secret-bearing query names are redacted", () => {
  for (const key of ["session", "session_id", "session-token", "jwt", "bearer", "credential", "assertion", "saml", "firebaseToken", "firebase-token", "accessToken", "access-token", "auth_token", "invite_token"]) {
    const route = makeCtx({ href: "https://dev--leak-work-orders.netlify.app/?" + key + "=SUPERSECRET&openHelp=1" }).sanitizedFeedbackRoute();
    assert.ok(!route.includes("SUPERSECRET"), key + " leaked: " + route);
    assert.match(route, new RegExp(key + "=REDACTED", "i"));
    assert.match(route, /openHelp=1/);
  }
});

test("appBuildId handles deploy-preview and local file shapes without throwing", () => {
  const preview = makeCtx({ href: "https://deploy-preview-188--leak-work-orders.netlify.app/#reports" });
  assert.strictEqual(preview.appBuildId(), "20260724b");
  const local = makeCtx({ href: "file:///C:/Users/Marks/projects/roofing-dashboard/index.html#reports" });
  assert.strictEqual(local.appBuildId(), "20260724b");
  assert.strictEqual(local.sanitizedFeedbackRoute(), "file:///C:/Users/Marks/projects/roofing-dashboard/index.html#reports");
});
