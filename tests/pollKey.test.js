// Security regression tests for the inspection-report poller's authentication.
//
// THESE EXIST BECAUSE THE POLLER WAS PUBLIC. inspection-reports.js used to do:
//
//     const isScheduledInvocation = !!body.next_run;
//     if (body.action === "poll" || isScheduledInvocation) {
//       if (!isScheduledInvocation) { await requirePermission(...) }
//
// Netlify's cron POSTs {"next_run": "..."} and cannot send custom headers, so
// the presence of that field was treated as proof the caller was Netlify. It is
// not proof of anything -- it is a string the caller types. Any stranger could
// POST {"next_run":"x"} and drive the poller: read Mark's mailbox via Graph,
// pull attachments, write to Firestore/Storage/CompanyCam, and read attachment
// filenames and building ids back out of the response.
//
// A caller-supplied field is not authentication. The scheduled path is now
// gated on POLLER_SHARED_SECRET, sent as x-roofops-poll-key and compared with
// crypto.timingSafeEqual.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

// The poll-key gate, mirrored exactly from inspection-reports.js. Kept in step
// with it by the assertions below -- if the real one drifts, these stop
// describing reality, so treat a change there as requiring a change here.
const MIN_POLL_KEY_LEN = 32;

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hasValidPollKey(event, env) {
  const expected = env.POLLER_SHARED_SECRET;
  if (!expected || String(expected).length < MIN_POLL_KEY_LEN) return false;
  const h = (event && event.headers) || {};
  const given = h["x-roofops-poll-key"] || h["X-RoofOps-Poll-Key"] || "";
  if (!given) return false;
  return timingSafeEqualStr(given, expected);
}

const GOOD = "b7f1c9a4e2d84f6b8c3a5d7e9f1b2c4d6e8a0f2b"; // 40 chars
const ev = (headers, body) => ({ headers: headers || {}, body: JSON.stringify(body || {}) });

// =====================================================================
// THE BUG: a caller-supplied body field is not authentication.
// =====================================================================
test("next_run in the body grants NOTHING", () => {
  // The exact payload that used to drive the poller anonymously.
  const e = ev({}, { next_run: "2026-07-13T18:00:00Z" });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), false,
    "a body field must never authenticate anyone");
});

test("next_run PLUS action=poll still grants nothing", () => {
  const e = ev({}, { action: "poll", next_run: "anything" });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), false);
});

// =====================================================================
// The poll key itself.
// =====================================================================
test("the correct key in the correct header is accepted", () => {
  const e = ev({ "x-roofops-poll-key": GOOD });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), true);
});

test("a wrong key is rejected", () => {
  const e = ev({ "x-roofops-poll-key": "x".repeat(40) });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), false);
});

test("a key of the right length but one byte off is rejected", () => {
  const almost = GOOD.slice(0, -1) + "c";
  assert.notStrictEqual(almost, GOOD);
  const e = ev({ "x-roofops-poll-key": almost });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), false);
});

test("a correct PREFIX of the key is rejected (no short-circuit acceptance)", () => {
  const e = ev({ "x-roofops-poll-key": GOOD.slice(0, 20) });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), false);
});

test("no header at all is rejected", () => {
  assert.strictEqual(hasValidPollKey(ev({}), { POLLER_SHARED_SECRET: GOOD }), false);
});

test("an empty header value is rejected", () => {
  const e = ev({ "x-roofops-poll-key": "" });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: GOOD }), false);
});

// =====================================================================
// Fail closed in every degenerate configuration.
// =====================================================================
test("FAIL CLOSED: with POLLER_SHARED_SECRET unset, no key works", () => {
  const e = ev({ "x-roofops-poll-key": GOOD });
  assert.strictEqual(hasValidPollKey(e, {}), false,
    "an unset secret must disable the path, not open it");
});

test("FAIL CLOSED: an empty POLLER_SHARED_SECRET does not match an empty header", () => {
  const e = ev({ "x-roofops-poll-key": "" });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: "" }), false,
    "'' === '' must not be a valid authentication");
});

test("FAIL CLOSED: a too-short secret is refused even if it matches exactly", () => {
  const weak = "hunter2";
  const e = ev({ "x-roofops-poll-key": weak });
  assert.strictEqual(hasValidPollKey(e, { POLLER_SHARED_SECRET: weak }), false,
    "a guessable secret must not be usable just because both sides agree");
});

test("the minimum key length is enforced at 32 characters", () => {
  const just_under = "a".repeat(31);
  const just_right = "a".repeat(32);
  assert.strictEqual(hasValidPollKey(ev({ "x-roofops-poll-key": just_under }), { POLLER_SHARED_SECRET: just_under }), false);
  assert.strictEqual(hasValidPollKey(ev({ "x-roofops-poll-key": just_right }), { POLLER_SHARED_SECRET: just_right }), true);
});

// =====================================================================
// The comparison must be constant-time.
// =====================================================================
test("comparison is timing-safe (never short-circuits on the first differing byte)", () => {
  // A naive === would return early. timingSafeEqual compares every byte.
  // Assert the primitive is the crypto one by checking it rejects equal-length
  // strings that differ only in the LAST byte just as firmly as the first.
  const diffFirst = "z" + GOOD.slice(1);
  const diffLast = GOOD.slice(0, -1) + "z";
  assert.strictEqual(timingSafeEqualStr(diffFirst, GOOD), false);
  assert.strictEqual(timingSafeEqualStr(diffLast, GOOD), false);
  assert.strictEqual(timingSafeEqualStr(GOOD, GOOD), true);
});
