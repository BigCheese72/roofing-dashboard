"use strict";
/* Service Manager (dispatch + proposals) unit tests.
 *
 * The client controller (js/servicemanager.js) is loaded into a vm sandbox
 * TOGETHER WITH js/foundation.js, so the Foundation cross-reference tests
 * exercise the REAL fdn* matching helpers the app uses (no drift, no
 * re-implementation). Pure helpers only — no network, no DOM, no Firestore. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSm() {
  const ctx = { console };
  vm.createContext(ctx);
  // Strip a leading "use strict" directive so top-level function/var
  // declarations bind to the sandbox global (strict global code would not).
  const strip = (s) => s.replace(/^\s*["']use strict["'];?\s*/, "");
  for (const rel of ["js/foundation.js", "js/servicemanager.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    vm.runInContext(strip(src), ctx);
  }
  return ctx;
}

// A representative Foundation jobs cache (shape from foundationDb.mapJobForCache).
const JOBS = [
  { job_no: "17001", job_number: "17001", name: "Flat Branch Pub", customer_no: "C1", address: "123 S 9th St", city: "Columbia", state: "MO", zip: "65201" },
  { job_no: "17002", job_number: "17002", name: "Broadway Diner", customer_no: "C2", address: "500 E Broadway", city: "Columbia", state: "MO", zip: "65201" },
  // A deliberate address twin of 17001 to prove ambiguity is refused, not guessed.
  { job_no: "17003", job_number: "17003", name: "Flat Branch Pub Annex", customer_no: "C1", address: "123 S 9th St", city: "Columbia", state: "MO", zip: "65201" },
];

// ---------------------------------------------------------------------------
// Foundation cross-reference (reuses fdnAddressMatchKey / fdnComposeAddress)
// ---------------------------------------------------------------------------
test("smFindFoundationJob: unique address match wins", () => {
  const ctx = loadSm();
  const only = [JOBS[0], JOBS[1]];
  const hit = ctx.smFindFoundationJob("123 S 9th St, Columbia, MO 65201", "", only);
  assert.ok(hit, "expected a match");
  assert.strictEqual(hit.job_no, "17001");
});

test("smFindFoundationJob: ambiguous address refuses to guess (null)", () => {
  const ctx = loadSm();
  const hit = ctx.smFindFoundationJob("123 S 9th St, Columbia, MO", "", JOBS);
  assert.strictEqual(hit, null, "two jobs share the address — must not guess");
});

test("smFindFoundationJob: falls back to exact unique name when address misses", () => {
  const ctx = loadSm();
  const hit = ctx.smFindFoundationJob("999 Nowhere Rd, Columbia, MO", "Broadway Diner", JOBS);
  assert.ok(hit);
  assert.strictEqual(hit.job_no, "17002");
});

test("smFindFoundationJob: no address and no name match returns null", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smFindFoundationJob("1 Unknown Way, Nowhere, XX", "Nothing Here", JOBS), null);
});

// ---------------------------------------------------------------------------
// "WO already exists for this proposal" flag (best-effort, conservative)
// ---------------------------------------------------------------------------
const WO_INDEX = [
  { id: "wo_1", jobName: "Flat Branch Pub", location: "123 S 9th St, Columbia, MO" },
];
test("smWoExistsForProposal: matches on job name in the subject", () => {
  const ctx = loadSm();
  const m = ctx.smWoExistsForProposal({ s: "Proposal — Flat Branch Pub reroof", n: "Nathan", e: "nathan@x.com" }, WO_INDEX);
  assert.ok(m);
  assert.strictEqual(m.id, "wo_1");
});
test("smWoExistsForProposal: matches on house-number+street in the subject", () => {
  const ctx = loadSm();
  const m = ctx.smWoExistsForProposal({ s: "Estimate for 123 S 9th St Columbia", n: "", e: "" }, WO_INDEX);
  assert.ok(m);
  assert.strictEqual(m.id, "wo_1");
});
test("smWoExistsForProposal: unrelated proposal returns null", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smWoExistsForProposal({ s: "Totally unrelated subject", n: "", e: "" }, WO_INDEX), null);
});

// ---------------------------------------------------------------------------
// Dispatch board grouping (assigned only, cleared drops off, sorted by crew)
// ---------------------------------------------------------------------------
test("smGroupBoard: groups assigned by crew, excludes cleared/undispatched", () => {
  const ctx = loadSm();
  const wos = [
    { id: "a", dispatch: { crew: "Kelly Walker", status: "assigned" } },
    { id: "b", dispatch: { crew: "Kelly Walker", status: "assigned" } },
    { id: "c", dispatch: { crew: "Mark Sheppard", status: "assigned" } },
    { id: "d", dispatch: { crew: "Kelly Walker", status: "cleared" } }, // done → drops off
    { id: "e", dispatch: null },                                        // never dispatched
    { id: "f" },                                                        // no dispatch field
  ];
  const groups = ctx.smGroupBoard(wos);
  assert.strictEqual(groups.length, 2);
  // sorted alphabetically by crew
  assert.strictEqual(groups[0].crew, "Kelly Walker");
  assert.strictEqual(groups[1].crew, "Mark Sheppard");
  // join to compare across the vm realm boundary (arrays have a different proto)
  assert.strictEqual(groups[0].items.map((w) => w.id).join(","), "a,b");
  assert.strictEqual(groups[1].items.map((w) => w.id).join(","), "c");
});
test("smGroupBoard: empty / null input yields no columns", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smGroupBoard([]).length, 0);
  assert.strictEqual(ctx.smGroupBoard(null).length, 0);
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
test("smLocalYmd: local YYYY-MM-DD, zero-padded", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smLocalYmd(new Date(2026, 6, 5)), "2026-07-05"); // month index 6 = July
});
test("smYmdToMdy: converts to the app's M/D/YY serviceDate shape", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smYmdToMdy("2026-07-05"), "7/5/26");
  assert.strictEqual(ctx.smYmdToMdy("2026-12-31"), "12/31/26");
});

// ---------------------------------------------------------------------------
// Static guard: dispatch/proposal linkage must ride collect()/fill() so an
// ordinary edit-form save never drops a dispatched WO's assignment.
// ---------------------------------------------------------------------------
test("workorders.js collect() persists dispatch + proposal, fill() restores them", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
  assert.ok(/o\.dispatch\s*=\s*smBuildDispatchField\(\)/.test(src), "collect() must write o.dispatch");
  assert.ok(/o\.proposal\s*=\s*smProposalRef/.test(src), "collect() must write o.proposal");
  assert.ok(/smSetDispatchState\(o\)/.test(src), "fill() must restore dispatch/proposal state");
});

// ---------------------------------------------------------------------------
// contacts-sync: folder-name resolver (well-known branch is pure — no Graph).
// ---------------------------------------------------------------------------
test("resolveFolderIdByName resolves well-known folders without a Graph call", async () => {
  const H = require(path.join(__dirname, "..", "netlify", "functions", "contacts-sync.js"))._internals;
  assert.strictEqual(await H.resolveFolderIdByName("Sent Items"), "sentitems");
  assert.strictEqual(await H.resolveFolderIdByName("sentitems"), "sentitems");
  assert.strictEqual(await H.resolveFolderIdByName("INBOX"), "inbox");
  assert.strictEqual(await H.resolveFolderIdByName(""), null);
  assert.strictEqual(await H.resolveFolderIdByName("   "), null);
});
