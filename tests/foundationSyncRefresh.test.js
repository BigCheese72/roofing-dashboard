"use strict";
/* Field-accessible "🔄 Refresh from Foundation" button in the Select Job picker
 * (js/foundation.js fdnRefreshPicker).
 *
 * WHY THIS FILE EXISTS — 2026-08-10 field outage: Foundation job #17519
 * ("Multipli Credit Union Leak") was created but did not appear in the RoofOps
 * job picker, because the hourly scheduled sync only ever refreshed DEV, so
 * prod's foundation_jobs cache went stale (see .github/workflows/
 * sync-foundation-jobs.yml and tests/foundationSyncSchedule.test.js). The
 * scheduled-target fix stops it recurring; THIS button is the on-demand escape
 * hatch so a field user never has to wait for the timer again.
 *
 * The REAL fdnRefreshPicker runs in a vm sandbox (same harness as
 * tests/foundationJobLink.test.js) with fetch/authHeaders/toast/fdb stubbed.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFdn(overrides) {
  const rec = { fetches: [], toasts: [] };
  const ctx = Object.assign({
    console,
    document: { getElementById() { return null; } },
    authHeaders: async () => ({ "Content-Type": "application/json", Authorization: "Bearer T" }),
    toast: (m) => rec.toasts.push(m),
    fetch: async (url, opts) => {
      rec.fetches.push({ url, opts });
      if (rec.throws) throw new Error("network error");
      return { ok: rec.ok !== false, status: rec.status || 200, json: async () => rec.body };
    }
  }, overrides || {});
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");
  vm.runInContext(src.replace(/^\s*["']use strict["'];?\s*/, ""), ctx);
  ctx.__rec = rec;
  return ctx;
}

// A stub Firestore handle whose foundation_jobs collection returns `docs`.
function fdbWith(docs) {
  const snap = { forEach: (cb) => docs.forEach((d) => cb({ data: () => d })) };
  const query = { limit: () => query, get: async () => snap };
  return { collection: () => query };
}

const JOB = (job_no, name) => ({ job_no, job_number: "", name, status: "A" });

test("posts action:sync with auth to the foundation-sync function", async () => {
  const ctx = loadFdn();
  ctx.__rec.ok = true; ctx.__rec.body = { ok: true, active_jobs: 42, written: 3 };
  ctx.fdb = fdbWith([JOB("17519", "Multipli Credit Union Leak")]);
  await ctx.fdnRefreshPicker({ disabled: false });
  const req = ctx.__rec.fetches[0];
  assert.match(req.url, /\/functions\/foundation-sync$/);
  assert.equal(req.opts.method, "POST");
  assert.equal(JSON.parse(req.opts.body).action, "sync");
  assert.ok(req.opts.headers.Authorization, "auth header forwarded");
});

test("on success it force-reloads the cache so the new job is selectable, and toasts the count", async () => {
  const ctx = loadFdn();
  ctx.__rec.ok = true; ctx.__rec.body = { ok: true, active_jobs: 1, written: 1 };
  ctx.fdb = fdbWith([JOB("17519", "Multipli Credit Union Leak")]);
  const btn = { disabled: false };
  await ctx.fdnRefreshPicker(btn);
  // fdnLoadJobs(true) must have repopulated the module cache from Firestore.
  assert.equal(ctx.fdnCache.length, 1);
  assert.equal(ctx.fdnCache[0].job_no, "17519");
  assert.match(ctx.__rec.toasts.join(" "), /refreshed/i);
  assert.equal(btn.disabled, false, "button re-enabled");
});

test("a 403 tells the field user they need foundation.read, and does NOT wipe the cache", async () => {
  const ctx = loadFdn();
  ctx.__rec.ok = false; ctx.__rec.status = 403;
  ctx.__rec.body = { error: "Forbidden: missing permission foundation.read" };
  ctx.fdb = fdbWith([JOB("1", "x")]);
  ctx.fdnCache = [JOB("999", "existing")]; // pre-existing cache stays put
  await ctx.fdnRefreshPicker({ disabled: false });
  assert.match(ctx.__rec.toasts.join(" "), /foundation\.read/i);
  assert.deepEqual(ctx.fdnCache.map((j) => j.job_no), ["999"], "cache untouched on failure");
});

test("a network failure is caught and toasted; button re-enabled", async () => {
  const ctx = loadFdn();
  ctx.__rec.throws = true;
  const btn = { disabled: false };
  await ctx.fdnRefreshPicker(btn);
  assert.match(ctx.__rec.toasts.join(" "), /failed/i);
  assert.equal(btn.disabled, false);
});
