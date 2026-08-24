"use strict";
/* Feedback -> auto-fix loop, client half (js/core.js: appBuildId,
   sanitizedFeedbackRoute, the submitFeedback payload, and the backlog
   viewer's triage rendering).

   What must stay true forever:
     1. A submitted report says WHICH build, WHICH url and WHICH environment
        it came from -- without those an agent cannot reproduce anything.
     2. `route` NEVER carries a secret. js/core.js reads a single-use invite
        token off window.location.search, so an untrimmed href would copy a
        live credential into Firestore and into the feedback email.
     3. The client seeds triageStatus:"new" (the watcher's indexed query
        needs the field to exist) and writes NO other triage field --
        agentDiagnosis/branchUrl are server-owned.
     4. The viewer only ever renders an https github.com branchUrl into an
        href, and its status labels cover the server's whole vocabulary.

   The feedback block is extracted and run in a vm the same way
   adminViewAccess.test.js extracts showView(). */
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

const { TRIAGE_STATUSES, parseFeedbackQuery } = require("../netlify/functions/lib/feedbackStatus.js");

function makeCtx(opts) {
  const o = opts || {};
  const href = o.href || "https://dev--leak-work-orders.netlify.app/";
  const scriptSrc = o.scriptSrc === undefined ? "js/core.js?v=20260724b" : o.scriptSrc;
  const saved = [];
  const posted = [];
  const fields = Object.assign({ "feedback-comments": "the save button spins forever", technician: "Ray", jobName: "Flat Branch" }, o.fields);
  const els = {};
  ["feedback-screenshot-status", "feedback-type-picker", "feedback-context-hint", "feedback-modal", "feedback-backlog-list"]
    .forEach(id => { els[id] = { innerHTML: "", textContent: "", style: {} }; });

  const ctx = {
    isAdmin: !!o.isAdmin,
    currentViewName: o.view || "edit",
    currentId: "wo_123",
    feedbackBacklog: o.backlog || [],
    URL, console,
    window: { location: { href, hostname: new URL(href).hostname } },
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel.indexOf("js/core.js") !== -1 && scriptSrc !== null
        ? { getAttribute: () => scriptSrc } : null)
    },
    val: (id) => fields[id] || "",
    setVal: () => {},
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: () => {},
    genId: () => "fb_test",
    getFieldHistory: () => [],
    isDevEnvironment: () => new URL(href).hostname.indexOf("dev--") !== -1,
    lockBodyScroll: () => {}, unlockBodyScroll: () => {},
    resizeImageFile: async () => "",
    openImageLightbox: () => {},
    // Capture what submitFeedback would persist / email.
    fdb: { collection: () => ({ doc: () => ({ set: async (d) => { saved.push(d); } }) }) },
    fetch: async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    __saved: saved, __posted: posted, __els: els
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(block, ctx);
  // AFTER the vm run: the block itself declares `var feedbackBacklog = []`,
  // which would overwrite a value seeded before it executes.
  if (o.backlog) ctx.feedbackBacklog = o.backlog;
  return ctx;
}

async function submitted(opts) {
  const ctx = makeCtx(opts);
  ctx.feedbackState.type = "bug";
  await ctx.submitFeedback();
  assert.strictEqual(ctx.__saved.length, 1, "expected exactly one Firestore write");
  return { doc: ctx.__saved[0], ctx };
}

// ---- 1. the new auto-diagnosis signal ----
test("a submitted report carries build id, route and environment", async () => {
  const { doc } = await submitted({ href: "https://dev--leak-work-orders.netlify.app/#edit" });
  assert.strictEqual(doc.appVersion, "20260724b", "build id comes from the core.js cache-buster");
  assert.strictEqual(doc.route, "https://dev--leak-work-orders.netlify.app/#edit");
  assert.strictEqual(doc.env, "dev");
});

test("production submissions are tagged prod (dev and prod are separate Firebase projects)", async () => {
  const { doc } = await submitted({ href: "https://leak-work-orders.netlify.app/#saved" });
  assert.strictEqual(doc.env, "prod");
});

test("the existing capture fields are untouched by the enrichment", async () => {
  const { doc } = await submitted({});
  assert.strictEqual(doc.type, "bug");
  assert.strictEqual(doc.comments, "the save button spins forever");
  assert.strictEqual(doc.screen, "Work Order Form");
  assert.strictEqual(doc.technician, "Ray");
  assert.strictEqual(doc.workOrderId, "wo_123");
  assert.strictEqual(doc.workOrderJobName, "Flat Branch");
  assert.match(doc.device, /iPhone/);
  assert.ok(typeof doc.createdAt === "number");
});

test("appBuildId degrades to 'unknown' rather than throwing when the tag is missing or unversioned", () => {
  assert.strictEqual(makeCtx({ scriptSrc: null }).appBuildId(), "unknown");
  assert.strictEqual(makeCtx({ scriptSrc: "js/core.js" }).appBuildId(), "unknown");
  assert.strictEqual(makeCtx({ scriptSrc: "/js/core.js?v=20260801a&x=1" }).appBuildId(), "20260801a");
});

// ---- 2. route must never carry a secret ----
test("an invite token in the url is REDACTED, never persisted", async () => {
  const { doc } = await submitted({
    href: "https://dev--leak-work-orders.netlify.app/?invite=eyJhbGciOiJIUzI1NiJ9.SECRET#home"
  });
  assert.ok(doc.route.indexOf("SECRET") === -1, "the live token must not reach Firestore: " + doc.route);
  assert.ok(doc.route.indexOf("eyJhbGciOiJIUzI1NiJ9") === -1);
  assert.match(doc.route, /invite=REDACTED/, "the parameter is redacted, not silently dropped");
  assert.match(doc.route, /#home$/, "the hash route still survives");
});

test("every secret-ish parameter name is redacted, and harmless ones survive", () => {
  const ctx = makeCtx({});
  for (const key of ["invite", "token", "access_token", "id_token", "key", "api_key", "secret", "sig", "signature", "password", "pin", "auth", "code"]) {
    const c = makeCtx({ href: "https://x.netlify.app/?" + key + "=hunter2" });
    const route = c.sanitizedFeedbackRoute();
    assert.ok(route.indexOf("hunter2") === -1, key + " leaked: " + route);
  }
  const kept = makeCtx({ href: "https://x.netlify.app/?openHelp=1&view=edit" }).sanitizedFeedbackRoute();
  assert.match(kept, /openHelp=1/, "non-secret params are useful diagnosis signal and are kept");
  assert.match(kept, /view=edit/);
  assert.ok(ctx.sanitizedFeedbackRoute().length > 0);
});

test("redaction is case-insensitive and survives repeated params", () => {
  const route = makeCtx({ href: "https://x.netlify.app/?Invite=AAA&TOKEN=BBB" }).sanitizedFeedbackRoute();
  assert.ok(route.indexOf("AAA") === -1 && route.indexOf("BBB") === -1, route);
});

test("an unparseable href falls back to dropping the query string entirely", () => {
  const ctx = makeCtx({});
  ctx.URL = function () { throw new Error("no URL support"); };
  const route = ctx.sanitizedFeedbackRoute();
  assert.ok(route.indexOf("?") === -1, "must fail toward privacy, not ship a raw query string");
});

// ---- 3. the client writes exactly one triage field ----
test("the client seeds triageStatus 'new' and writes no other triage field", async () => {
  const { doc } = await submitted({});
  assert.strictEqual(doc.triageStatus, "new");
  assert.ok(TRIAGE_STATUSES.indexOf(doc.triageStatus) !== -1, "seed value must be in the server vocabulary");
  assert.strictEqual(doc.agentDiagnosis, undefined, "diagnosis is server-owned");
  assert.strictEqual(doc.branchUrl, undefined, "branch link is server-owned");
  assert.strictEqual(doc.updatedAt, undefined, "updatedAt is stamped by the server writer");
});

test("the same enriched payload is what the feedback email receives", async () => {
  const { ctx } = await submitted({ href: "https://leak-work-orders.netlify.app/#edit" });
  const posted = ctx.__posted.find(p => p.url.indexOf("send-feedback") !== -1);
  assert.ok(posted, "the email function is still called");
  assert.strictEqual(posted.body.appVersion, "20260724b");
  assert.strictEqual(posted.body.env, "prod");
  assert.strictEqual(posted.body.route, "https://leak-work-orders.netlify.app/#edit");
});

// ---- 4. the viewer ----
test("the viewer renders status, diagnosis snippet and a github branch link", () => {
  const ctx = makeCtx({
    isAdmin: true, view: "reports",
    fields: { "feedback-filter-type": "" },
    backlog: [{
      id: "fb1", type: "bug", typeLabel: "🐞 Bug", comments: "photo upload 500s", screen: "Work Order Form",
      createdAt: 1700000000000, triageStatus: "fix_proposed", appVersion: "20260724b", env: "prod",
      route: "https://leak-work-orders.netlify.app/#edit",
      agentDiagnosis: "resizeImageFile() rejects HEIC on iOS 17.",
      branchUrl: "https://github.com/BigCheese72/roofing-dashboard/tree/fix/heic"
    }]
  });
  ctx.renderFeedbackBacklog();
  const html = ctx.__els["feedback-backlog-list"].innerHTML;
  assert.match(html, /Fix proposed/);
  assert.match(html, /resizeImageFile\(\) rejects HEIC/);
  assert.match(html, /href="https:\/\/github\.com\/BigCheese72\/roofing-dashboard\/tree\/fix\/heic"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /20260724b/);
  assert.match(html, /photo upload 500s/, "the original report is still shown");
});

test("the viewer refuses to render a non-github branchUrl as a link", () => {
  for (const branchUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://github.com.evil.dev/x", "http://github.com/x"]) {
    const ctx = makeCtx({
      isAdmin: true, fields: { "feedback-filter-type": "" },
      backlog: [{ id: "fb1", type: "bug", createdAt: 1, triageStatus: "fix_proposed", branchUrl }]
    });
    ctx.renderFeedbackBacklog();
    const html = ctx.__els["feedback-backlog-list"].innerHTML;
    assert.ok(html.indexOf("<a href") === -1, "must not link " + branchUrl + " -> " + html);
    assert.ok(html.toLowerCase().indexOf("javascript:") === -1);
  }
});

test("a pre-loop report with no triage fields renders cleanly", () => {
  const ctx = makeCtx({
    isAdmin: true, fields: { "feedback-filter-type": "" },
    backlog: [{ id: "old", type: "bug", typeLabel: "🐞 Bug", comments: "old report", screen: "Home", createdAt: 1 }]
  });
  ctx.renderFeedbackBacklog();
  const html = ctx.__els["feedback-backlog-list"].innerHTML;
  assert.match(html, /old report/);
  assert.ok(html.indexOf("Diagnosis:") === -1);
  assert.ok(html.indexOf("Build:") === -1, "no build line when the report predates the enrichment");
  assert.ok(html.indexOf("undefined") === -1);
});

test("the viewer's status labels cover the server's whole vocabulary", () => {
  const ctx = makeCtx({});
  for (const status of TRIAGE_STATUSES) {
    const label = ctx.feedbackTriageLabel(status);
    assert.ok(label && label !== status, "js/core.js FEEDBACK_TRIAGE_LABELS is missing a label for " + status);
  }
  assert.strictEqual(ctx.feedbackTriageLabel("some_future_status"), "some_future_status", "unknown statuses show raw, never hidden");
  assert.strictEqual(ctx.feedbackTriageLabel(undefined), "");
});

// ---- 5. client/server vocabulary parity ----
test("every client FEEDBACK_TYPES key is accepted by the server's list_feedback filter", () => {
  const ctx = makeCtx({});
  const keys = ctx.FEEDBACK_TYPES.map(t => t.key);
  assert.ok(keys.indexOf("bug") !== -1, "the watcher polls type=bug -- it must exist");
  for (const key of keys) {
    assert.strictEqual(parseFeedbackQuery({ type: key }).ok, true,
      "lib/feedbackStatus.js parseFeedbackQuery rejects the client type " + key);
  }
  assert.strictEqual(parseFeedbackQuery({ type: "not_a_type" }).ok, false);
});

test("a long diagnosis is snipped in the card, not dumped whole", () => {
  const ctx = makeCtx({
    isAdmin: true, fields: { "feedback-filter-type": "" },
    backlog: [{ id: "fb1", type: "bug", createdAt: 1, triageStatus: "triaging", agentDiagnosis: "y".repeat(2000) }]
  });
  ctx.renderFeedbackBacklog();
  const html = ctx.__els["feedback-backlog-list"].innerHTML;
  assert.ok(html.indexOf("y".repeat(400)) === -1, "should be truncated to a snippet");
  assert.match(html, /…/);
});
