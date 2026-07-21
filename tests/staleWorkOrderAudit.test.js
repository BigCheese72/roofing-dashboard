const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Read-only audit for work orders that would rename their building on save.

   Generalises the Orr St near-miss: a merge before the woReassign fix
   re-pointed a work order's buildingId but left its own jobName / location /
   billTo holding the merged-away building's values, so the next ordinary save
   wrote them back onto the survivor.

   The predicate is narrower than "the fields disagree", and that matters.
   ensureCustomerAndBuilding() only writes them when ownsBuilding is true, and
   ownsBuilding is false whenever the stored id RESOLVES elsewhere
   (redirectedByMerge). A work order still pointing at the loser is already
   protected by that redirect. Flagging plain mismatches would over-report and
   send someone rewriting records in no danger. */

const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

function codeOnly(src){
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}
const AUDIT = () => between(adminSource, 'body.action === "audit_stale_workorder_identity"', "DESIGN NOTE");

/* Run the real server-side merge resolver against a fake Firestore. */
function resolver(buildings){
  const src = between(adminSource, "const MAX_MERGE_HOPS_SERVER", "// Server-side mirror of genId");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  const db = { collection: () => ({ doc: (id) => ({ get: async () => ({
    exists: Object.prototype.hasOwnProperty.call(buildings, id),
    data: () => buildings[id]
  }) }) }) };
  return (id) => sb.resolveMergedBuildingIdServer(db, id, new Map());
}

/* ================= the resolver must match the client ================= */

test("a live building resolves to itself", async () => {
  const r = resolver({ a: { name: "A" } });
  assert.equal(await r("a"), "a");
});

test("an archived, merged-away building follows its pointer", async () => {
  const r = resolver({ a: { archived: true, mergedIntoBuildingId: "b" }, b: { name: "B" } });
  assert.equal(await r("a"), "b");
});

test("archived but NOT merged is left alone", async () => {
  /* Filing a building out of the way is a deliberate act; its records should
     keep pointing at it. */
  const r = resolver({ a: { archived: true } });
  assert.equal(await r("a"), "a");
});

test("a chain of exactly 3 resolves — the off-by-one that shipped once", async () => {
  /* `hop < MAX` followed 3 pointers but never inspected the 3rd target, so a
     3-chain returned the archived husk: worse than no guard at all. Chains of
     3 are the normal shape of a dedup campaign. */
  const r = resolver({
    a: { archived: true, mergedIntoBuildingId: "b" },
    b: { archived: true, mergedIntoBuildingId: "c" },
    c: { archived: true, mergedIntoBuildingId: "d" },
    d: { name: "D" }
  });
  assert.equal(await r("a"), "d");
});

test("a cycle returns the original rather than looping", async () => {
  const r = resolver({
    a: { archived: true, mergedIntoBuildingId: "b" },
    b: { archived: true, mergedIntoBuildingId: "a" }
  });
  assert.equal(await r("a"), "a");
});

test("a dangling pointer stops at the missing id, it does not invent one", async () => {
  const r = resolver({ a: { archived: true, mergedIntoBuildingId: "gone" } });
  assert.equal(await r("a"), "gone");
});

test("the server resolver mirrors the client's hop budget", async () => {
  assert.match(adminSource, /const MAX_MERGE_HOPS_SERVER = 3/);
  assert.match(coreSource, /var MAX_MERGE_HOPS = 3/);
  const s = between(adminSource, "const MAX_MERGE_HOPS_SERVER", "// Server-side mirror of genId");
  assert.match(s, /hop <= MAX_MERGE_HOPS_SERVER/, "must be <=, not <");
});

/* ================= the predicate ================= */

test("a redirected work order is skipped, not flagged", () => {
  /* Its save writes nothing to the building — ownsBuilding is false. */
  const a = codeOnly(AUDIT());
  assert.match(a, /if \(resolvedId !== storedId\) \{ redirected\+\+; continue; \}/);
});

test("only stored === resolved AND a field disagreeing is flagged", () => {
  const a = codeOnly(AUDIT());
  assert.match(a, /const nameMismatch = woName !== bName/);
  assert.match(a, /const locMismatch\s+= woLoc !== bLoc/);
  assert.match(a, /const billMismatch = woBill !== bCust/);
  assert.match(a, /const safeToSave = !\(nameMismatch \|\| locMismatch \|\| billMismatch\)/);
});

test("the fields compared are exactly the ones the save writes", () => {
  /* jobName->name (trimmed), location->location, billTo->customerName. If the
     save path ever writes a different set, this audit goes blind to it. */
  const ensure = between(coreSource, "var ownsBuilding", "if (o.companyCamProjectId)");
  assert.match(ensure, /patch\.name = bldName/);
  assert.match(ensure, /patch\.location = o\.location/);
  assert.match(ensure, /patch\.customerName = custName/);
  const a = codeOnly(AUDIT());
  assert.match(a, /String\(wo\.jobName \|\| ""\)\.trim\(\)/, "jobName is trimmed, as the save trims it");
  assert.match(a, /String\(bld\.name \|\| ""\)\.trim\(\)/);
});

test("each flagged row names WHICH fields would be overwritten", () => {
  const a = AUDIT();
  assert.match(a, /wouldOverwrite:/);
  assert.match(a, /SAFE_TO_SAVE: false/);
});

/* ================= it cannot write ================= */

test("the audit has NO write path at all — not even a guarded one", () => {
  const a = codeOnly(AUDIT());
  ["ref.set(", "batch.commit(", ".update(", ".delete(", "body.apply"].forEach(w =>
    assert.ok(!a.includes(w), "audit must contain no write primitive: " + w));
  assert.match(AUDIT(), /readOnly: true/);
});

test("it is admin-gated like every other building action", () => {
  assert.match(AUDIT(), /requirePermission\(event, "settings\.company"\)/);
});

/* ================= bounded so it cannot time out ================= */

test("the scan is bounded and pageable", () => {
  /* Netlify caps around 26s; an unbounded collection scan would die
     half-finished and report a partial count as if it were the total. */
  const a = codeOnly(AUDIT());
  assert.match(a, /Math\.min\(Math\.max\(Number\(body\.limit\) \|\| 500, 1\), 2000\)/);
  assert.match(a, /startAfter/);
  assert.match(a, /nextStartAfter/);
});

test("a full page reports that more remain rather than implying completeness", () => {
  /* The failure that matters: reporting "3 stale" when the scan stopped early
     would send Mark to a decision on a number that is not the total. */
  const a = AUDIT();
  assert.match(a, /woSnap\.docs\.length === limit \? lastId : null/);
  assert.match(a, /More work orders remain/);
});

test("buildings are read once and cached, not once per work order", () => {
  const a = codeOnly(AUDIT());
  assert.match(a, /const bldCache = new Map\(\)/);
  assert.match(a, /bldCache\.get\(resolvedId\)/);
  assert.match(a, /bldCache\.set\(resolvedId, bld\)/);
});

test("rows are capped but the count is not", () => {
  /* The count must stay honest even when the sample is truncated. */
  const a = codeOnly(AUDIT());
  assert.match(a, /rows\.length < 200/);
  assert.match(a, /rowsTruncated/);
  assert.match(a, /staleWorkOrders: stale/);
});

/* ================= the backfill stays unbuilt ================= */

test("no backfill action exists yet", () => {
  /* It rewrites fields a human typed, so it waits for Mark. */
  assert.doesNotMatch(codeOnly(adminSource), /body\.action === "backfill_stale_workorder_identity"/);
  assert.match(adminSource, /DESIGN NOTE: the backfill this audit feeds \(NOT BUILT\)/);
});
