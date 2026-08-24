// Regression tests for warranty-report -> building matching.
//
// THESE TESTS EXIST BECAUSE THE MATCHER SILENTLY FILED REPORTS ONTO THE
// WRONG ROOF. The original code compared addresses and building names with a
// raw substring test, so "1234 Oak" matched a building at "234 Oak", and a
// building named "Ridge" captured "Ridgewood Elementary". Both auto-filed,
// with no review and no warning. A warranty inspection on the wrong roof is
// worse than no inspection on file at all.
//
// Every case below is a real collision found by executing the old matcher.
// If a future change reintroduces substring matching, these MUST fail.
//
// Run: npm test        (no dependencies -- node:test is built in)
const test = require("node:test");
const assert = require("node:assert");

const { matchBuilding } = require("../netlify/functions/lib/buildingMatch");
const {
  compareAddresses, compareNames, extractAddressCandidates, isNameDistinctiveEnough
} = require("../netlify/functions/lib/textMatch");

const B = (id, name, location) => ({ id, name, location, companyCamProjectId: null });

// Asserts the report did NOT auto-file anywhere -- it went to the review queue.
function assertQueued(res, why) {
  assert.strictEqual(res.building, null,
    why + " -- expected REVIEW QUEUE, but it auto-filed onto " +
    (res.building && res.building.id) + " via '" + res.method + "'");
}
function assertFiledOn(res, id, why) {
  assert.ok(res.building, why + " -- expected a match on " + id + ", got '" + res.method + "'");
  assert.strictEqual(res.building.id, id, why);
}

// =====================================================================
// THE BUG: street-number collisions. These are the cases that misfiled.
// =====================================================================
test("1234 Oak Ave must NOT file onto the building at 234 Oak Ave", () => {
  const res = matchBuilding(
    [B("b_234oak", "Riverside Depot", "234 Oak Ave")],
    "Warranty Inspection 1234 Oak Ave"
  );
  assertQueued(res, "1234 Oak vs 234 Oak is a DIFFERENT ROOF");
});

test("12 Elm St must NOT file onto the building at 112 Elm St", () => {
  const res = matchBuilding(
    [B("b_112elm", "Elm Tower", "112 Elm St")],
    "Warranty Inspection 12 Elm St"
  );
  assertQueued(res, "12 Elm vs 112 Elm is a DIFFERENT ROOF");
});

test("500 Park Way must NOT file onto the building at 1500 Park Way", () => {
  const res = matchBuilding(
    [B("b_1500park", "Park North", "1500 Park Way")],
    "Warranty Inspection 500 Park Way"
  );
  assertQueued(res, "500 Park vs 1500 Park is a DIFFERENT ROOF");
});

test("the street-number collision is caught at the primitive level too", () => {
  // The exact comparisons that used to return true.
  assert.strictEqual(compareAddresses("1234 Oak Ave", "234 Oak Ave").match, false);
  assert.strictEqual(compareAddresses("12 Elm St", "112 Elm St").match, false);
  assert.strictEqual(compareAddresses("500 Park Way", "1500 Park Way").match, false);
  // ...and is reported as a same-street near-miss, not a silent nothing.
  assert.strictEqual(compareAddresses("1234 Oak Ave", "234 Oak Ave").reason, "street_number_mismatch");
});

// =====================================================================
// THE BUG: building-name substring collisions.
// =====================================================================
test("a building named 'Ridge' must NOT capture 'Ridgewood Elementary'", () => {
  const res = matchBuilding(
    [B("b_ridge", "Ridge", "9 Hill Ct")],
    "Ridgewood Elementary - warranty inspection"
  );
  assertQueued(res, "'Ridge' is not 'Ridgewood'");
});

test("a building named 'Oaks' must NOT capture 'Oakstone Industrial'", () => {
  const res = matchBuilding(
    [B("b_oaks", "Oaks", "77 Cedar Ln")],
    "Inspection Report - Oakstone Industrial"
  );
  assertQueued(res, "'Oaks' is not 'Oakstone'");
});

test("name comparison rejects substring hits and flags what the old rule would have done", () => {
  const r = compareNames("Ridgewood Elementary - warranty inspection", "Ridge");
  assert.strictEqual(r.match, false);
  assert.strictEqual(r.reason, "name_substring_only_not_word_boundary");
  // The audit trail must be able to say: the OLD code would have misfiled this.
  assert.strictEqual(r.wouldHaveMatchedUnderOldRule, true);
});

// =====================================================================
// Bias toward the queue: weak evidence must never auto-file.
// =====================================================================
test("a generic single-word building name never auto-files", () => {
  const res = matchBuilding(
    [B("b_shop", "Shop", "4 Cedar Rd")],
    "Inspection Report - shop roof survey"
  );
  assertQueued(res, "'Shop' is too generic to be evidence");
  assert.strictEqual(isNameDistinctiveEnough("Shop"), false);
  assert.strictEqual(isNameDistinctiveEnough("Warehouse"), false);
  assert.strictEqual(isNameDistinctiveEnough("Ridgewood"), true);
  assert.strictEqual(isNameDistinctiveEnough("Main Plaza"), true);
});

test("an address with no house number never auto-files", () => {
  assert.strictEqual(compareAddresses("Oak Ave", "Oak Ave").match, false);
  assert.strictEqual(compareAddresses("Oak Ave", "Oak Ave").reason, "no_street_number");
});

test("a subject with no address and no name goes to the queue", () => {
  const res = matchBuilding(
    [B("b_100main", "Main Plaza", "100 Main St")],
    "Inspection Report 2026-07-11.pdf"
  );
  assertQueued(res, "nothing identifying in the subject");
  assert.strictEqual(res.method, "no_match");
});

test("two buildings that genuinely fit the same address go to the queue, never a coin flip", () => {
  const res = matchBuilding(
    [B("b_a", "North Campus", "500 Park Way"), B("b_b", "South Campus", "500 Park Way")],
    "Inspection 500 Park Way"
  );
  assertQueued(res, "genuinely ambiguous");
  assert.strictEqual(res.method, "ambiguous_address");
  assert.strictEqual(res.decision.ambiguousCandidates.length, 2);
});

test("when both 234 and 1234 Oak exist, 1234 files on 1234 -- not on 234", () => {
  const res = matchBuilding(
    [B("b_234oak", "Riverside Depot", "234 Oak Ave"), B("b_1234oak", "Oakview Plant", "1234 Oak Ave")],
    "Warranty Inspection 1234 Oak Ave"
  );
  assertFiledOn(res, "b_1234oak", "exact house number wins; 234 is not a candidate at all");
});

test("a directional prefix is not ignored: 100 Main must not file onto 100 N Main", () => {
  const res = matchBuilding(
    [B("b_100nmain", "North Main", "100 N Main St")],
    "Inspection 100 Main St"
  );
  assertQueued(res, "'100 N Main' and '100 Main' are different roofs");
});

// =====================================================================
// Controls: correct matches must STILL work. A matcher that queues
// everything is safe but useless.
// =====================================================================
test("CONTROL: an exact address match still auto-files", () => {
  const res = matchBuilding(
    [B("b_100main", "Main Plaza", "100 Main St, Springfield MO 65801"), B("b_55pine", "Pine Center", "55 Pine Rd")],
    "Warranty Inspection - 100 Main St"
  );
  assertFiledOn(res, "b_100main", "plain correct match");
  assert.strictEqual(res.method, "address");
});

test("CONTROL: trailing words in the subject do not break a correct address match", () => {
  const res = matchBuilding(
    [B("b_100main", "Main Plaza", "100 Main St, Springfield MO 65801")],
    "Re: FW: 100 Main St inspection report - annual warranty"
  );
  assertFiledOn(res, "b_100main", "the greedy-tail bug must not resurface");
});

test("CONTROL: a .pdf filename suffix does not break a correct address match", () => {
  const res = matchBuilding(
    [B("b_12elm", "Elm Cottage", "12 Elm St")],
    "Inspection Report 12 Elm St.pdf"
  );
  assertFiledOn(res, "b_12elm", "'.pdf' used to be dragged into the address");
});

test("CONTROL: 'Street' vs 'St' still normalize to the same roof", () => {
  const res = matchBuilding(
    [B("b_100main", "Main Plaza", "100 Main Street")],
    "Inspection - 100 Main St"
  );
  assertFiledOn(res, "b_100main", "street-suffix normalization");
});

test("CONTROL: a suite number still files onto the parent building", () => {
  const res = matchBuilding(
    [B("b_500park", "Park Plaza", "500 Park Way")],
    "Inspection 500 Park Way Suite 200"
  );
  assertFiledOn(res, "b_500park", "same roof, different tenant");
});

test("CONTROL: a distinctive multi-word name still auto-files when there is no address", () => {
  const res = matchBuilding(
    [B("b_mp", "Main Plaza", "100 Main St"), B("b_pc", "Pine Center", "55 Pine Rd")],
    "Main Plaza - annual warranty inspection"
  );
  assertFiledOn(res, "b_mp", "name fallback must still work");
  assert.strictEqual(res.method, "name");
});

// =====================================================================
// Address extraction no longer swallows trailing junk.
// =====================================================================
test("extraction stops at the street suffix", () => {
  assert.deepStrictEqual(extractAddressCandidates("Re: FW: 100 Main St inspection"), ["100 Main St"]);
  assert.deepStrictEqual(extractAddressCandidates("Inspection Report 12 Elm St.pdf"), ["12 Elm St"]);
  assert.deepStrictEqual(extractAddressCandidates("Inspection Report 2026-07-11.pdf"), []);
});

// =====================================================================
// The audit trail: every decision must explain itself.
// =====================================================================
test("a rejected same-street near-miss is recorded for the audit log", () => {
  const res = matchBuilding(
    [B("b_234oak", "Riverside Depot", "234 Oak Ave")],
    "Warranty Inspection 1234 Oak Ave"
  );
  assertQueued(res, "must not file");
  const miss = res.decision.nearMisses.find(m => m.buildingId === "b_234oak");
  assert.ok(miss, "the near-miss must be logged, not silently dropped");
  assert.strictEqual(miss.stage, "address");
  assert.strictEqual(miss.reason, "street_number_mismatch");
});

test("a name near-miss records that the OLD rule would have misfiled it", () => {
  const res = matchBuilding(
    [B("b_ridge", "Ridge", "9 Hill Ct")],
    "Ridgewood Elementary - warranty inspection"
  );
  assertQueued(res, "must not file");
  const miss = res.decision.nearMisses.find(m => m.buildingId === "b_ridge");
  assert.ok(miss, "the near-miss must be logged");
  assert.strictEqual(miss.rejectedByNewRule, true);
});

test("every decision carries the text it judged and how many buildings it considered", () => {
  const res = matchBuilding(
    [B("b_100main", "Main Plaza", "100 Main St")],
    "Warranty Inspection - 100 Main St"
  );
  assert.strictEqual(res.decision.candidateText, "Warranty Inspection - 100 Main St");
  assert.strictEqual(res.decision.buildingsConsidered, 1);
  assert.deepStrictEqual(res.decision.addressCandidates, ["100 Main St"]);
  assert.strictEqual(res.decision.matchedBuildingId, "b_100main");
});
