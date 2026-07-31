// Security tests for the ASIL assistant bridge key (netlify/functions/lib/asilKey.js).
//
// This key lets ASIL (Mark's local assistant) reach a few read endpoints and the
// delegated-Graph mail/calendar read + draft actions WITHOUT a Firebase user
// token -- the same "non-human caller" carve-out the poll-key and sync-key
// already establish. The whole safety of that carve-out rests on two properties,
// which these tests pin:
//
//   1. It is NOT a skeleton key. A valid key authorizes ONLY the actions a
//      function passes in its allowlist; a valid key on ANY other action must be
//      refused, so it falls through to the normal human gate and (no bearer
//      token) is denied. This is the property that keeps the key away from
//      upsert/move/delete/create_user and every other write.
//   2. It fails closed in every degenerate config (env unset, secret too weak to
//      be real, header absent/empty/wrong), and compares in constant time.
//
// Unlike pollKey.test.js (which mirrors its gate inline), this exercises the REAL
// module -- asilKey.js reads process.env at call time, so we set it here.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { hasValidAsilKey, asilKeyAllows, presentedAsilKey, timingSafeEqualStr } = require("../netlify/functions/lib/asilKey");

const GOOD = "b7f1c9a4e2d84f6b8c3a5d7e9f1b2c4d6e8a0f2b"; // 40 chars, >= 32
const ALLOWED = ["mail_read", "calendar_list", "create_draft", "jobs"];
const ev = (headers) => ({ headers: headers || {} });

// process.env is the real source; set/clear it around each assertion so tests
// don't leak state into each other.
function withSecret(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "ROOFOPS_ASIL_KEY");
  const prev = process.env.ROOFOPS_ASIL_KEY;
  if (value === undefined) delete process.env.ROOFOPS_ASIL_KEY;
  else process.env.ROOFOPS_ASIL_KEY = value;
  try { return fn(); }
  finally {
    if (had) process.env.ROOFOPS_ASIL_KEY = prev;
    else delete process.env.ROOFOPS_ASIL_KEY;
  }
}

// =====================================================================
// THE KEY PROPERTY: scoped to the allowlist, never a skeleton key.
// =====================================================================
test("valid key + an allowlisted action is authorized", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(asilKeyAllows(ev({ "x-roofops-asil-key": GOOD }), "mail_read", ALLOWED), true);
  });
});

test("valid key + a NON-allowlisted action is refused (not a skeleton key)", () => {
  withSecret(GOOD, () => {
    // These are real, dangerous actions on the same functions. The key must not
    // reach any of them, even though the key itself is perfectly valid.
    for (const action of ["upsert", "move", "rules_create", "create_user", "delete_building", "send"]) {
      assert.strictEqual(
        asilKeyAllows(ev({ "x-roofops-asil-key": GOOD }), action, ALLOWED), false,
        `the key must never authorize "${action}"`);
    }
  });
});

test("an empty or missing action is refused", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(asilKeyAllows(ev({ "x-roofops-asil-key": GOOD }), "", ALLOWED), false);
    assert.strictEqual(asilKeyAllows(ev({ "x-roofops-asil-key": GOOD }), undefined, ALLOWED), false);
  });
});

// =====================================================================
// The key itself.
// =====================================================================
test("the correct key in the correct header is accepted", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": GOOD })), true);
  });
});

test("the canonical-cased header is also accepted", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "X-RoofOps-Asil-Key": GOOD })), true);
  });
});

test("a wrong key is rejected", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": "x".repeat(40) })), false);
  });
});

test("a key one byte off is rejected", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": GOOD.slice(0, -1) + "c" })), false);
  });
});

test("a correct PREFIX of the key is rejected (no short-circuit acceptance)", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": GOOD.slice(0, 20) })), false);
  });
});

test("no header at all is rejected", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({})), false);
  });
});

test("an empty header value is rejected", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": "" })), false);
  });
});

// =====================================================================
// Fail closed in every degenerate configuration.
// =====================================================================
test("FAIL CLOSED: with ROOFOPS_ASIL_KEY unset, no key works", () => {
  withSecret(undefined, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": GOOD })), false,
      "an unset secret must disable the path, not open it");
    assert.strictEqual(asilKeyAllows(ev({ "x-roofops-asil-key": GOOD }), "mail_read", ALLOWED), false);
  });
});

test("FAIL CLOSED: an empty secret does not match an empty header", () => {
  withSecret("", () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": "" })), false,
      "'' === '' must not be a valid authentication");
  });
});

test("FAIL CLOSED: a too-short secret is refused even if it matches exactly", () => {
  const weak = "hunter2";
  withSecret(weak, () => {
    assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": weak })), false,
      "a guessable secret must not be usable just because both sides agree");
  });
});

test("the minimum key length is enforced at 32 characters", () => {
  const under = "a".repeat(31);
  const right = "a".repeat(32);
  withSecret(under, () => assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": under })), false));
  withSecret(right, () => assert.strictEqual(hasValidAsilKey(ev({ "x-roofops-asil-key": right })), true));
});

// =====================================================================
// Constant-time comparison.
// =====================================================================
test("comparison is timing-safe (never short-circuits on the first differing byte)", () => {
  const diffFirst = "z" + GOOD.slice(1);
  const diffLast = GOOD.slice(0, -1) + "z";
  assert.strictEqual(timingSafeEqualStr(diffFirst, GOOD), false);
  assert.strictEqual(timingSafeEqualStr(diffLast, GOOD), false);
  assert.strictEqual(timingSafeEqualStr(GOOD, GOOD), true);
});

// =====================================================================
// presentedAsilKey() -- diagnostic only, and must NOT become an oracle.
//
// Regression cover for a real misdiagnosis (2026-07-31): an ASIL caller whose
// key was not accepted fell through to the human gate and was told "Missing
// Authorization bearer token" -- a credential it never intended to send. That
// wrong signal, on a function whose whole job is Microsoft 365, was read as
// "the delegated M365 session has expired", which it had not. contacts-sync.js
// uses this helper to say "your ASIL key path failed" instead.
// =====================================================================
test("presentedAsilKey: true whenever the header is present, regardless of value", () => {
  // The POINT is that it does not care whether the key is right -- a caller
  // with a WRONG key still attempted the ASIL path and must be told so.
  withSecret(GOOD, () => {
    assert.strictEqual(presentedAsilKey(ev({ "x-roofops-asil-key": GOOD })), true);
    assert.strictEqual(presentedAsilKey(ev({ "x-roofops-asil-key": "totally-wrong-value" })), true);
    assert.strictEqual(presentedAsilKey(ev({ "X-RoofOps-Asil-Key": GOOD })), true, "canonical casing too");
  });
});

test("presentedAsilKey: false when no key header was sent", () => {
  withSecret(GOOD, () => {
    assert.strictEqual(presentedAsilKey(ev({})), false);
    assert.strictEqual(presentedAsilKey(ev({ authorization: "Bearer something" })), false,
      "a bearer-token caller never attempted the ASIL path");
    assert.strictEqual(presentedAsilKey(ev({ "x-roofops-asil-key": "" })), false, "empty header is not an attempt");
  });
});

test("presentedAsilKey: degenerate events never throw", () => {
  for (const bad of [undefined, null, {}, { headers: null }, { headers: undefined }]) {
    assert.strictEqual(presentedAsilKey(bad), false);
  }
});

test("presentedAsilKey is NOT an oracle: it never reveals whether the key matched", () => {
  // Same header presence => same answer, whether the env secret is unset, weak,
  // or a perfect match. If this ever varied with the SECRET rather than the
  // HEADER, it would leak exactly what hasValidAsilKey() protects.
  const e = ev({ "x-roofops-asil-key": GOOD });
  const answers = [];
  withSecret(undefined, () => answers.push(presentedAsilKey(e)));
  withSecret("short", () => answers.push(presentedAsilKey(e)));
  withSecret("b".repeat(40), () => answers.push(presentedAsilKey(e)));
  withSecret(GOOD, () => answers.push(presentedAsilKey(e)));
  assert.deepStrictEqual(answers, [true, true, true, true],
    "the answer must depend only on the header, never on the stored secret");
});
