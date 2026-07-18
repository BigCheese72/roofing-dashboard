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
// Tier 3: the job name INSIDE an email subject. This is the Prairie Farms
// regression (Mark, 2026-07-18) — an emailed proposal carries no address, and
// its subject never EQUALS the Foundation job name, so the old address-then-
// exact-name matcher could never link one.
// ---------------------------------------------------------------------------
const PRAIRIE = {
  job_no: "17456", job_number: "17456", name: "Prairie Farms", customer_no: "ACME",
  address: "1100 N Providence Rd", city: "Columbia", state: "MO", zip: "65203",
};

test("smFindFoundationJob: matches the job name inside a proposal subject (Prairie Farms)", () => {
  const ctx = loadSm();
  const hit = ctx.smFindFoundationJob("", "Prairie Farms – roof repair proposal", [...JOBS, PRAIRIE]);
  assert.ok(hit, "the subject names the site — it must link");
  assert.strictEqual(hit.job_no, "17456");
});

test("smFindFoundationJob: customer name is NOT a match key (ACME must not link by itself)", () => {
  const ctx = loadSm();
  // The customer_no is ACME; a subject naming only the customer identifies no
  // single site and must not be guessed at.
  assert.strictEqual(ctx.smFindFoundationJob("", "ACME proposal", [...JOBS, PRAIRIE]), null);
});

test("smFindFoundationJob: subject containment prefers the most specific job name", () => {
  const ctx = loadSm();
  // "Flat Branch Pub Annex" is longer/more specific than "Flat Branch Pub".
  const hit = ctx.smFindFoundationJob("", "Proposal for Flat Branch Pub Annex reroof", JOBS);
  assert.ok(hit);
  assert.strictEqual(hit.job_no, "17003");
  // ...and the shorter name still wins when the subject stops there.
  const hit2 = ctx.smFindFoundationJob("", "Proposal for Flat Branch Pub reroof", JOBS);
  assert.ok(hit2);
  assert.strictEqual(hit2.job_no, "17001");
});

test("smFindFoundationJob: two DISJOINT sites in one subject stay ambiguous", () => {
  const ctx = loadSm();
  // Names of DIFFERENT lengths — longest-wins must not silently pick one.
  const twins = [
    { job_no: "1", name: "Prairie Farms", address: "1 A St", city: "X", state: "MO" },
    { job_no: "2", name: "North Terminal", address: "2 B St", city: "X", state: "MO" },
  ];
  assert.strictEqual(
    ctx.smFindFoundationJob("", "Prairie Farms and North Terminal reroof proposal", twins), null,
    "two different sites named in one subject is real ambiguity — refuse to guess");
});

test("smFindFoundationJob: a generic job name never outranks the real site", () => {
  const ctx = loadSm();
  // "Roof Replacement" normalizes LONGER than "Prairie Farms"; if it were an
  // eligible containment key, longest-wins would link the wrong job.
  const jobs = [
    { job_no: "9", name: "Roof Replacement", address: "", city: "" },
    { job_no: "17456", name: "Prairie Farms", customer_no: "ACME", address: "", city: "" },
  ];
  const hit = ctx.smFindFoundationJob("", "Prairie Farms roof replacement proposal", jobs);
  assert.ok(hit, "expected a match");
  assert.strictEqual(hit.job_no, "17456", "must be the site, not the work-type job");
});

test("smNameIsDistinctive: needs two non-work words to be a containment key", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smNameIsDistinctive("roof repair"), false, "all work-words");
  assert.strictEqual(ctx.smNameIsDistinctive("roof replacement"), false, "one specific word only");
  assert.strictEqual(ctx.smNameIsDistinctive("service call"), false);
  assert.strictEqual(ctx.smNameIsDistinctive("tear off"), false);
  assert.strictEqual(ctx.smNameIsDistinctive("columbia"), false, "a single word is not a site");
  assert.strictEqual(ctx.smNameIsDistinctive("123456"), false, "a bare number is not a site");
  assert.strictEqual(ctx.smNameIsDistinctive("prairie farms"), true);
  assert.strictEqual(ctx.smNameIsDistinctive("flat branch pub"), true);
  assert.strictEqual(ctx.smNameIsDistinctive("constructor"), false, "no inherited-key false positive");
  // Sequence markers are not place names — these are pure work-scope titles
  // that would otherwise qualify on their digits alone.
  assert.strictEqual(ctx.smNameIsDistinctive("roof area 2 section 3"), false);
  assert.strictEqual(ctx.smNameIsDistinctive("unit 5 bldg 7"), false);
  assert.strictEqual(ctx.smNameIsDistinctive("phase 2 area a"), false);
  // ...but a real site keeping a number in its name is still fine.
  assert.strictEqual(ctx.smNameIsDistinctive("hy vee 1234"), true);
});

test("smFindFoundationJob: single-word job names don't auto-link from a subject", () => {
  const ctx = loadSm();
  const jobs = [{ job_no: "5", name: "Columbia", address: "", city: "" }];
  assert.strictEqual(ctx.smFindFoundationJob("", "Columbia MO warehouse proposal", jobs), null,
    "one word can't identify a site — that's what the manual picker is for");
});

test("smFindFoundationJob: two jobs with the SAME name stay ambiguous (not cache order)", () => {
  const ctx = loadSm();
  // A repeat customer with a job per building/year really does produce these.
  // A string contains itself, so the nesting rule alone would call the twin
  // "nested" and hand back whichever job happened to sort first.
  const twins = [
    { job_no: "17820", name: "Prairie Farms", address: "1 A St", city: "Columbia", state: "MO" },
    { job_no: "17456", name: "Prairie Farms", address: "9 B St", city: "Moberly", state: "MO" },
  ];
  const subject = "Prairie Farms – roof repair proposal";
  assert.strictEqual(ctx.smFindFoundationJob("", subject, twins), null);
  // ...and the answer must not depend on cache order.
  assert.strictEqual(ctx.smFindFoundationJob("", subject, twins.slice().reverse()), null);
  // A third, genuinely distinct name alongside them is still ambiguous.
  assert.strictEqual(ctx.smFindFoundationJob("", subject, [...twins, { job_no: "3", name: "North Terminal" }]), null);
});

test("smFdnCacheStatus: loading / empty / error / ready are distinguishable", () => {
  const ctx = loadSm();
  ctx.fdnCache = null; ctx.smFdnLoadFailed = false;
  assert.strictEqual(ctx.smFdnCacheStatus(), "loading");
  ctx.smFdnLoadFailed = true;
  assert.strictEqual(ctx.smFdnCacheStatus(), "error", "a failed load must not read as still loading");
  ctx.fdnCache = []; ctx.smFdnLoadFailed = false;
  assert.strictEqual(ctx.smFdnCacheStatus(), "empty", "fdnLoadJobs caches [] for the session — it never self-clears");
  ctx.fdnCache = [PRAIRIE];
  assert.strictEqual(ctx.smFdnCacheStatus(), "ready");
});

test("the proposals row distinguishes all four cache states", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const render = src.slice(src.indexOf("function smRenderProposals"), src.indexOf("function smPrecreateFromProposal"));
  assert.ok(/smFdnCacheStatus\(\)/.test(render), "must consult the cache state, not a truthiness check");
  for (const state of ["loading", "empty", "error"]) {
    assert.ok(new RegExp(`fdnState === "${state}"`).test(render), `must handle the ${state} state`);
  }
});

test("hand-typed and subject texts are matched separately, never concatenated", () => {
  const ctx = loadSm();
  const jobs = [
    { job_no: "1", name: "North Terminal", address: "", city: "" },
    { job_no: "2", name: "Prairie Farms", address: "", city: "" },
  ];
  // Concatenating a correction onto the subject yields two disjoint candidates
  // and refuses — i.e. typing the RIGHT name would have broken matching.
  assert.strictEqual(
    ctx.smFindFoundationJob("", "North Terminal Prairie Farms – roof repair proposal", jobs), null);
  // Matched on its own, the hand-typed name resolves cleanly.
  const hit = ctx.smFindFoundationJob("", "North Terminal", jobs);
  assert.ok(hit);
  assert.strictEqual(hit.job_no, "1");
  // The seam must not fabricate a match across field-end/subject-start either.
  const seam = [{ job_no: "9", name: "Terminal Prairie", address: "", city: "" }];
  assert.strictEqual(ctx.smFindFoundationJob("", "North Terminal", seam), null);

  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const fn = src.slice(src.indexOf("function smFoundationMatchTexts"), src.indexOf("function smFoundationSearchText"));
  assert.ok(/if \(name && !smJobNameFromProposal\) out\.push\(name\)/.test(fn),
    "a hand-typed name must be tried first, on its own");
  assert.ok(!/name \+ " " \+ subj/.test(src), "the concatenated haystack must be gone");
  const match = src.slice(src.indexOf("async function smMatchFoundationFromForm"), src.indexOf("function smApplyFoundationPick"));
  assert.ok(/for \(var ti = 0; !found\.job && ti < texts\.length; ti\+\+\)/.test(match),
    "must try each candidate text in priority order");
});

test("a manual pick writes the job name unconditionally (even an empty one)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const apply = src.slice(src.indexOf("function smApplyFoundationPick"), src.indexOf("function smClearFoundationPick"));
  assert.ok(/if \(manual \|\| \(job\.name &&/.test(apply),
    "manual must not be gated behind job.name — an unnamed job would leave the previous job's name in place");
  assert.ok(/setVal2\("sm-pc-jobName", job\.name \|\| ""\)/.test(apply));
});

test("smFindFoundationJobDetailed: reports HOW it matched", () => {
  const ctx = loadSm();
  const all = [...JOBS, PRAIRIE];
  assert.strictEqual(ctx.smFindFoundationJobDetailed("123 S 9th St, Columbia, MO 65201", "", [JOBS[0], JOBS[1]]).via, "address");
  assert.strictEqual(ctx.smFindFoundationJobDetailed("", "Broadway Diner", JOBS).via, "name");
  assert.strictEqual(ctx.smFindFoundationJobDetailed("", "Prairie Farms – roof repair proposal", all).via, "subject");
  assert.strictEqual(ctx.smFindFoundationJobDetailed("", "nothing here", all).via, null);
});

test("smContainsTokens: whole-token containment only (no partial-word hits)", () => {
  const ctx = loadSm();
  assert.strictEqual(ctx.smContainsTokens("proposal prairie farms reroof", "prairie farms"), true);
  assert.strictEqual(ctx.smContainsTokens("prairie farmstead barn", "prairie farm"), false);
  assert.strictEqual(ctx.smContainsTokens("", "prairie farms"), false);
});

// ---------------------------------------------------------------------------
// Ranked "did you mean" candidates + the manual picker's search filter.
// ---------------------------------------------------------------------------
test("smRankFoundationJobs: whole-name containment outranks loose token overlap", () => {
  const ctx = loadSm();
  const ranked = ctx.smRankFoundationJobs("Prairie Farms roof proposal", [...JOBS, PRAIRIE], 3);
  assert.ok(ranked.length >= 1);
  assert.strictEqual(ranked[0].job_no, "17456");
});

test("smRankFoundationJobs: generic-only overlap scores nothing", () => {
  const ctx = loadSm();
  const generic = [{ job_no: "9", name: "Roof Repair", address: "", city: "" }];
  assert.strictEqual(ctx.smRankFoundationJobs("roof repair proposal", generic, 3).length, 0);
});

test("smFilterFoundationJobs: matches on name, job #, customer and city", () => {
  const ctx = loadSm();
  const all = [...JOBS, PRAIRIE];
  assert.strictEqual(ctx.smFilterFoundationJobs("prairie", all, 50)[0].job_no, "17456");
  assert.strictEqual(ctx.smFilterFoundationJobs("17456", all, 50)[0].job_no, "17456");
  assert.strictEqual(ctx.smFilterFoundationJobs("acme", all, 50)[0].job_no, "17456");
  // every token must hit (AND, not OR)
  assert.strictEqual(ctx.smFilterFoundationJobs("prairie nowhere", all, 50).length, 0);
  // empty query returns the head of the list rather than nothing
  assert.strictEqual(ctx.smFilterFoundationJobs("", all, 2).length, 2);
});

test("the picker seeds from a ranked candidate, never the raw email subject", () => {
  const ctx = loadSm();
  const all = [...JOBS, PRAIRIE];
  const subject = "Prairie Farms – roof repair proposal";
  // Seeding the AND-filter with the raw subject finds NOTHING — the exact
  // dead-end the picker exists to avoid.
  assert.strictEqual(ctx.smFilterFoundationJobs(subject, all, 50).length, 0);
  // Ranking the subject yields the right job, whose NAME does filter correctly.
  const best = ctx.smRankFoundationJobs(subject, all, 1)[0];
  assert.ok(best);
  assert.strictEqual(best.job_no, "17456");
  assert.strictEqual(ctx.smFilterFoundationJobs(best.name, all, 50)[0].job_no, "17456");

  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const open = src.slice(src.indexOf("function smOpenFoundationPicker"), src.indexOf("function smCloseFoundationPicker"));
  assert.ok(/smRankFoundationJobs\(smFoundationSearchText\(\), null, 1\)/.test(open),
    "picker must seed from the ranked candidate");
  const render = src.slice(src.indexOf("function smRenderFoundationPicker"), src.indexOf("function smPickFoundationJob"));
  assert.ok(/smRankFoundationJobs\(q, null, 25\)/.test(render), "an empty strict filter must fall back to ranked near-misses");
});

// ---------------------------------------------------------------------------
// Static guards: the cross-reference must actually FIRE, and a matched job must
// bind job-centrically (real job name replaces the proposal subject).
// ---------------------------------------------------------------------------
test("smOpenPrecreate auto-runs the Foundation cross-reference (not button-only)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const open = src.slice(src.indexOf("function smOpenPrecreate"), src.indexOf("function smClosePrecreate"));
  assert.ok(/smMatchFoundationFromForm\(/.test(open),
    "opening the pre-create form must cross-reference Foundation itself");
});

test("a Foundation match replaces the proposal SUBJECT with the real job name", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const apply = src.slice(src.indexOf("function smApplyFoundationPick"), src.indexOf("function smClearFoundationPick"));
  assert.ok(/smJobNameFromProposal/.test(apply), "must know whether the name is a subject or hand-typed");
  assert.ok(/setVal2\("sm-pc-jobName", job\.name \|\| ""\)/.test(apply), "must bind the canonical job name");
  // A manual correction must win even after an auto-match already stamped a
  // name, or "change" leaves the WO under the wrong job's name.
  assert.ok(/var manual = \(via === "manual"\)/.test(apply), "must distinguish a manual pick");
  assert.ok(/if \(manual \|\| \(job\.name &&/.test(apply), "a manual pick must override the flag");
});

test("smPickFoundationJob marks the pick manual (authoritative over auto-match)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const pick = src.slice(src.indexOf("function smPickFoundationJob"));
  assert.ok(/smApplyFoundationPick\(j, "manual"\)/.test(pick));
});

test("the fire-and-forget cross-reference drops a stale result", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  const fn = src.slice(src.indexOf("async function smMatchFoundationFromForm"), src.indexOf("function smApplyFoundationPick"));
  assert.ok(/var seq = \+\+smFdnMatchSeq/.test(fn), "must take a generation token before awaiting");
  assert.ok(/seq !== smFdnMatchSeq \|\| smCurrentProposal !== forProposal/.test(fn),
    "must bail if the form moved on — otherwise proposal A's match binds onto proposal B");
});

test("the proposals list says 'checking' until the jobs cache lands (no false no-match)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  assert.ok(/Checking Foundation jobs/.test(src), "must not assert a no-match before the cache loads");
  const load = src.slice(src.indexOf("async function smLoadProposals"), src.indexOf("function smRenderProposals"));
  assert.ok(/smRenderProposals\(\)/.test(load) && /fdnLoadJobs\(false\)\.then/.test(load),
    "must re-render once the cache arrives");
});

test("onclick job-number args are escaped &-first (no double-decode break)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "servicemanager.js"), "utf8");
  assert.ok(!/JSON\.stringify\(String\(j\.job_no\)\)\.replace/.test(src),
    "the naive quote-only replace double-decodes on a job_no containing &quot;");
  assert.strictEqual((src.match(/smEsc\(JSON\.stringify\(String\(j\.job_no\)\)\)/g) || []).length, 2);
});

test("the manual Foundation picker is wired into index.html", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(/id="sm-fdn-modal"/.test(html), "picker modal must exist");
  assert.ok(/id="sm-fdn-search"/.test(html) && /smRenderFoundationPicker\(\)/.test(html), "search box must re-filter");
  assert.ok(/smOpenFoundationPicker\(\)/.test(html), "a manual link affordance must be reachable");
  assert.ok(/id="sm-pc-jobName"[^>]*oninput="smJobNameEdited\(\)"/.test(html),
    "hand-editing the job name must clear the from-proposal flag");
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
