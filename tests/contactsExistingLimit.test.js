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
// THE REGRESSION THAT MATTERS: the paging loop itself.
//
// These drive pageContacts() with synthetic Graph pages — no mailbox needed —
// so all three loop exit paths are pinned behaviourally. A source-regex test
// would not do: `const truncated = false;` would satisfy a "contains the word
// truncated" assertion while reintroducing the exact bug this PR kills.
// =====================================================================

// Fake Graph: `total` contacts served 100 per page, with @odata.nextLink until
// exhausted. Records how many times it was called.
function fakeGraph(total, perPage) {
  perPage = perPage || 100;
  const calls = { n: 0 };
  const fetchJson = async (url) => {
    calls.n++;
    const m = /offset=(\d+)/.exec(String(url));
    const offset = m ? Number(m[1]) : 0;
    const slice = [];
    for (let i = offset; i < Math.min(offset + perPage, total); i++) {
      slice.push({ id: "c" + i, displayName: "Person " + i, emailAddresses: [{ address: "P" + i + "@X.com" }] });
    }
    const nextOffset = offset + perPage;
    return {
      value: slice,
      ...(nextOffset < total ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/contacts?offset=" + nextOffset } : {}),
    };
  };
  return { fetchJson, calls };
}

test("EXIT 1 — book exhausted: returns everything and truncated is FALSE", async () => {
  const { fetchJson } = fakeGraph(546); // the real post-backfill book size
  const r = await H.pageContacts(fetchJson, 5000, 400);
  assert.strictEqual(r.contacts.length, 546);
  assert.strictEqual(r.truncated, false, "a complete walk must not claim truncation");
  assert.strictEqual(r.pagesWalked, 6);
});

test("EXIT 2 — limit reached: truncated is TRUE (the incident, reproduced)", async () => {
  // 546 contacts against the OLD 500 cap: the walk stops early and MUST say so.
  const { fetchJson } = fakeGraph(546);
  const r = await H.pageContacts(fetchJson, 500, 400);
  assert.strictEqual(r.truncated, true,
    "stopping at the limit while more contacts exist MUST be reported — this is the bug");
  assert.ok(r.contacts.length >= 500);
});

test("EXIT 3 — page guard hit: truncated is TRUE, never a silent stop", async () => {
  // Short pages (10/page) make the page guard bind before the contact limit.
  const { fetchJson } = fakeGraph(1000, 10);
  const r = await H.pageContacts(fetchJson, 5000, 5); // 5 pages x 10 = 50 of 1000
  assert.strictEqual(r.pagesWalked, 5);
  assert.strictEqual(r.contacts.length, 50);
  assert.strictEqual(r.truncated, true,
    "the page guard must not truncate silently either");
});

test("a book smaller than one page reports complete", async () => {
  const { fetchJson } = fakeGraph(7);
  const r = await H.pageContacts(fetchJson, 5000, 400);
  assert.strictEqual(r.contacts.length, 7);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.pagesWalked, 1);
});

test("an empty address book is complete, not truncated", async () => {
  const { fetchJson } = fakeGraph(0);
  const r = await H.pageContacts(fetchJson, 5000, 400);
  assert.deepStrictEqual(r.contacts, []);
  assert.strictEqual(r.truncated, false);
});

test("it stops fetching once the limit is met (no needless Graph calls)", async () => {
  const { fetchJson, calls } = fakeGraph(10000);
  await H.pageContacts(fetchJson, 300, 400);
  assert.strictEqual(calls.n, 3, "300 contacts at 100/page should be exactly 3 requests");
});

test("limit is a stop-fetching threshold, so count may exceed it by <1 page — never fall short", async () => {
  const { fetchJson } = fakeGraph(1000);
  const r = await H.pageContacts(fetchJson, 750, 400);
  // Deliberate over-delivery: we never discard rows already fetched, because
  // returning FEWER contacts is what produces a false "missing" conclusion.
  assert.ok(r.contacts.length >= 750, "must never return fewer than the limit when more exist");
  assert.ok(r.contacts.length < 750 + 100, "over-delivery is bounded by one page");
  assert.strictEqual(r.truncated, true);
});

test("mapContactRow lowercases emails and tolerates sparse contacts", () => {
  assert.deepStrictEqual(
    H.mapContactRow({ id: "1", displayName: "A B", emailAddresses: [{ address: "Mixed@Case.COM" }] }),
    { id: "1", displayName: "A B", companyName: null, jobTitle: null, emails: ["mixed@case.com"], businessPhones: [], mobilePhone: null });
  const bare = H.mapContactRow({ id: "2" });
  assert.deepStrictEqual(bare.emails, []);
  assert.strictEqual(bare.displayName, null);
});
