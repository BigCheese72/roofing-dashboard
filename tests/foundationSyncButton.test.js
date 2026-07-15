"use strict";
/* Admin "Sync Foundation Jobs Now" button handler (runFoundationSync): POSTs
   action:sync with auth, toasts the result, and re-enables the button. Extracted
   from js/core.js with fetch/authHeaders/toast stubbed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const block = src.slice(src.indexOf("async function runFoundationSync"), src.indexOf("async function callAdminApi"));

function makeCtx(resp){
  const rec = { req: null, toasts: [] };
  const ctx = {
    JSON, String, encodeURIComponent, Array,
    authHeaders: async () => ({ "Content-Type": "application/json", Authorization: "Bearer T" }),
    toast: (m) => rec.toasts.push(m),
    fetch: async (url, opts) => { rec.req = { url, opts }; if (resp.throws) throw new Error("network error"); return { ok: resp.ok, status: resp.status || 200, json: async () => resp.body }; }
  };
  vm.runInNewContext(block, ctx);
  ctx.__rec = rec;
  return ctx;
}

test("posts action:sync with auth header to the foundation-sync function", async () => {
  const ctx = makeCtx({ ok: true, body: { ok: true, active_jobs: 42, written: 5 } });
  const btn = { disabled: false };
  await ctx.runFoundationSync(btn);
  assert.match(ctx.__rec.req.url, /\/functions\/foundation-sync$/);
  assert.equal(ctx.__rec.req.opts.method, "POST");
  assert.equal(JSON.parse(ctx.__rec.req.opts.body).action, "sync");
  assert.ok(ctx.__rec.req.opts.headers.Authorization);
});

test("success toast reports active job count + updated, and re-enables the button", async () => {
  const ctx = makeCtx({ ok: true, body: { ok: true, active_jobs: 42, written: 5 } });
  const btn = { disabled: false };
  await ctx.runFoundationSync(btn);
  const last = ctx.__rec.toasts[ctx.__rec.toasts.length - 1];
  assert.match(last, /synced/i);
  assert.match(last, /42 active jobs/);
  assert.match(last, /5 updated/);
  assert.equal(btn.disabled, false, "button re-enabled after");
});

test("server error surfaces the message and re-enables the button", async () => {
  const ctx = makeCtx({ ok: false, status: 403, body: { error: "Forbidden: missing permission foundation.read" } });
  const btn = { disabled: false };
  await ctx.runFoundationSync(btn);
  assert.match(ctx.__rec.toasts.join(" "), /failed.*foundation\.read/i);
  assert.equal(btn.disabled, false);
});

test("network failure is caught and toasted; button re-enabled", async () => {
  const ctx = makeCtx({ throws: true });
  const btn = { disabled: false };
  await ctx.runFoundationSync(btn);
  assert.match(ctx.__rec.toasts.join(" "), /failed/i);
  assert.equal(btn.disabled, false);
});
