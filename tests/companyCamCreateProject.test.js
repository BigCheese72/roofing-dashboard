"use strict";
/* CompanyCam project CREATE — the deliberate, authorized exception to RoofOps'
 * "never auto-create CompanyCam projects" rule (Service Manager dispatch flow).
 * Covers the server lib write helper (token/body/honesty), the static gating
 * guardrail on the action, and the client-side confident-match logic. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createCompanyCamProject } = require(path.join(__dirname, "..", "netlify", "functions", "lib", "companyCamDocuments.js"));

function withEnv(fn) {
  const saved = { r: process.env.COMPANYCAM_TOKEN, w: process.env.COMPANYCAM_WRITE_TOKEN, u: process.env.COMPANYCAM_USER_EMAIL };
  const savedFetch = global.fetch;
  return async () => {
    try { await fn(); }
    finally {
      if (saved.r === undefined) delete process.env.COMPANYCAM_TOKEN; else process.env.COMPANYCAM_TOKEN = saved.r;
      if (saved.w === undefined) delete process.env.COMPANYCAM_WRITE_TOKEN; else process.env.COMPANYCAM_WRITE_TOKEN = saved.w;
      if (saved.u === undefined) delete process.env.COMPANYCAM_USER_EMAIL; else process.env.COMPANYCAM_USER_EMAIL = saved.u;
      global.fetch = savedFetch;
    }
  };
}

test("createCompanyCamProject: no write token → clear error, makes no network call", withEnv(async () => {
  delete process.env.COMPANYCAM_TOKEN;
  delete process.env.COMPANYCAM_WRITE_TOKEN;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => "{}" }; };
  const r = await createCompanyCamProject("X", null, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not set/);
  assert.strictEqual(called, false, "must not hit the network without a token");
}));

test("createCompanyCamProject: 2xx with id posts {project:{...}} to /v2/projects and links it", withEnv(async () => {
  process.env.COMPANYCAM_WRITE_TOKEN = "wtok";
  let captured = null;
  global.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 201, text: async () => JSON.stringify({ id: "proj_123", name: "Flat Branch Pub" }) }; };
  const r = await createCompanyCamProject("Flat Branch Pub", { street_address_1: "123 S 9th St", city: "Columbia", state: "MO", postal_code: "65201" }, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.projectId, "proj_123");
  assert.match(captured.url, /\/v2\/projects$/);
  assert.strictEqual(captured.opts.method, "POST");
  assert.strictEqual(captured.opts.headers.Authorization, "Bearer wtok");
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.project.name, "Flat Branch Pub");
  assert.strictEqual(body.project.address.city, "Columbia");
  assert.strictEqual(body.project.address.state, "MO");
}));

test("createCompanyCamProject: 2xx WITHOUT an id is a FAILURE, never a null-id 'created'", withEnv(async () => {
  process.env.COMPANYCAM_WRITE_TOKEN = "wtok";
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
  const r = await createCompanyCamProject("X", null, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no project id/);
}));

test("createCompanyCamProject: non-2xx surfaces the status + body", withEnv(async () => {
  process.env.COMPANYCAM_WRITE_TOKEN = "wtok";
  global.fetch = async () => ({ ok: false, status: 422, text: async () => "unprocessable" });
  const r = await createCompanyCamProject("X", null, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /422/);
}));

// ---------------------------------------------------------------------------
// Static guardrail: the create action must be permission-gated + audit-logged.
// ---------------------------------------------------------------------------
test("companycam.js create_project is permission-gated (companycam.link) + audit-logged", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "companycam.js"), "utf8");
  const idx = src.indexOf('body.action === "create_project"');
  assert.ok(idx !== -1, "create_project action must exist");
  const block = src.slice(idx, idx + 1600);
  assert.match(block, /requirePermission\(event,\s*"companycam\.link"\)/, "create must require companycam.link");
  assert.match(block, /companycam_project_created/, "create must write an audit log entry");
});

// ---------------------------------------------------------------------------
// Client confident-match logic (loaded with foundation.js so the fdn address
// key is the real one). Ambiguity must be refused, not guessed.
// ---------------------------------------------------------------------------
function loadSm() {
  const ctx = { console };
  vm.createContext(ctx);
  const strip = (s) => s.replace(/^\s*["']use strict["'];?\s*/, "");
  for (const rel of ["js/foundation.js", "js/servicemanager.js"]) {
    vm.runInContext(strip(fs.readFileSync(path.join(__dirname, "..", rel), "utf8")), ctx);
  }
  return ctx;
}
const CC_PROJECTS = [
  { id: "p1", name: "Flat Branch Pub", address: "123 S 9th St, Columbia, MO 65201" },
  { id: "p2", name: "Broadway Diner", address: "500 E Broadway, Columbia, MO" },
  { id: "p3", name: "Flat Branch Annex", address: "123 S 9th St, Columbia, MO 65201" },
];
test("smMatchCompanyCamProject: unique address match links it", () => {
  const ctx = loadSm();
  const m = ctx.smMatchCompanyCamProject([CC_PROJECTS[0], CC_PROJECTS[1]], "123 S 9th St, Columbia, MO 65201", "");
  assert.ok(m); assert.strictEqual(m.id, "p1");
});
test("smMatchCompanyCamProject: ambiguous address returns null (offer create, don't guess)", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smMatchCompanyCamProject(CC_PROJECTS, "123 S 9th St, Columbia, MO 65201", ""), null);
});
test("smMatchCompanyCamProject: falls back to unique name when address misses", () => {
  const ctx = loadSm();
  const m = ctx.smMatchCompanyCamProject(CC_PROJECTS, "999 Nowhere Rd", "Broadway Diner");
  assert.ok(m); assert.strictEqual(m.id, "p2");
});
