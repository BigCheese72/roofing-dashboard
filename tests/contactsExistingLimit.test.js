// Tests for the `existing` action's contact paging limit.
//
// THE BUG THIS EXISTS FOR (hit live 2026-07-19): the paging loop stopped at a
// hard-coded 500 and the response reported `count: out.length` with no signal
// that it had stopped early. Backfilling contact cards for the field crew took
// the address book from 444 past 500, and the very next "who am I missing?"
// diff reported people as absent who demonstrably had cards — upsert found and
// PATCHed them moments later. A cap that truncates silently produces confident
// wrong answers, which is worse than a cap that refuses.
//
// So the contract under test is not merely "the number is bigger". It is:
//   * the default is far above any plausible Watkins address book,
//   * a caller can raise it, bounded by a hard ceiling,
//   * a bad/garbage limit degrades to the default rather than to NaN (which
//     would make `out.length < limit` false and return ZERO contacts), and
//   * truncation is REPORTED so it can't be mistaken for completeness.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const H = require(path.join(__dirname, "..", "netlify", "functions", "contacts-sync.js"))._internals;

test("the default limit is far above the old 500 that caused the incident", () => {
  assert.ok(H.DEFAULT_CONTACTS_LIMIT >= 5000,
    "444 contacts crossed 500 in a single backfill; the default must leave real headroom");
  assert.strictEqual(H.contactsLimit(undefined), H.DEFAULT_CONTACTS_LIMIT);
  assert.strictEqual(H.contactsLimit(null), H.DEFAULT_CONTACTS_LIMIT);
  assert.strictEqual(H.contactsLimit(""), H.DEFAULT_CONTACTS_LIMIT);
});

test("a caller-supplied limit is honored", () => {
  assert.strictEqual(H.contactsLimit(750), 750);
  assert.strictEqual(H.contactsLimit("1200"), 1200);
});

test("the limit is hard-ceilinged so a caller can't ask for millions", () => {
  assert.strictEqual(H.contactsLimit(999999999), H.MAX_CONTACTS_LIMIT);
  assert.ok(H.MAX_CONTACTS_LIMIT >= H.DEFAULT_CONTACTS_LIMIT);
});

test("garbage or non-positive limits fall back to the default, NEVER NaN", () => {
  // NaN is the dangerous failure: `out.length < NaN` is false, so the paging
  // loop would never run and `existing` would report ZERO contacts — which a
  // diff would read as "everyone is missing".
  for (const bad of ["abc", {}, [], NaN, Infinity, -1, 0, -500, "0", "-3"]) {
    const v = H.contactsLimit(bad);
    assert.ok(Number.isFinite(v) && v > 0, "limit must stay a positive finite number for input: " + String(bad));
    assert.strictEqual(v, H.DEFAULT_CONTACTS_LIMIT, "bad input should degrade to the default: " + String(bad));
  }
});

test("fractional limits floor to a whole number of contacts", () => {
  assert.strictEqual(H.contactsLimit(10.9), 10);
  assert.strictEqual(H.contactsLimit("25.7"), 25);
});

test("a page guard exists so a pathological nextLink chain cannot spin forever", () => {
  assert.ok(Number.isFinite(H.MAX_CONTACT_PAGES) && H.MAX_CONTACT_PAGES > 0);
  // Pages are 100 contacts each — the guard must not cut the default short.
  assert.ok(H.MAX_CONTACT_PAGES * 100 >= H.DEFAULT_CONTACTS_LIMIT,
    "the page guard must be able to reach the default contact limit");
});

// =====================================================================
// The regression that matters: truncation must be VISIBLE in the response.
// Asserted against the source, since exercising the handler needs a mailbox.
// =====================================================================
test("SOURCE: the existing action reports truncation instead of hiding it", () => {
  const fs = require("fs");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "netlify", "functions", "contacts-sync.js"), "utf8");
  const block = src.slice(src.indexOf('action === "existing"'), src.indexOf('action === "upsert"'));
  assert.ok(/truncated/.test(block), "the existing action must report a `truncated` flag");
  assert.ok(/hasMore/.test(block), "the existing action must report `hasMore`");
  assert.ok(/contactsLimit\(/.test(block), "the existing action must use the clamped limit helper");
  assert.ok(!/out\.length\s*<\s*500/.test(block), "the hard-coded 500 cap must be gone");
});
