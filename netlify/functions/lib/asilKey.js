// ASIL assistant bridge key — a single-purpose shared secret, exactly the shape
// of the poll-key (inspection-reports.js) and the sync-key (foundation-sync.js):
// a value Netlify has and the internet does not, sent in a header, compared with
// timingSafeEqual, failing closed in every degenerate case (env unset, env too
// weak to be a real secret, header absent, header wrong).
//
// UNLIKE a human's Firebase ID token, this key is NOT a skeleton key. It
// authorizes ONLY the specific read + draft actions each function passes in its
// own allowlist; any other action falls straight through to the normal
// requirePermission/verifyCaller gate (and, carrying no bearer token, is
// refused). One key, a fixed per-function allowlist, nothing else — so even a
// leaked ASIL key can read the allowlisted data and draft mail for Mark to send,
// and can do nothing destructive, nothing that sends, and nothing off the list.
//
// It exists so ASIL (Mark's local assistant) can reach a few read endpoints and
// the delegated-Graph mail/calendar read + draft actions without holding a
// short-lived Firebase user token — the same "non-human caller" carve-out the
// poll/sync keys already establish, scoped just as narrowly.
const crypto = require("crypto");

// A real secret, not a guessable word. Matches MIN_POLL_KEY_LEN in
// inspection-reports.js: below this we treat the env var as unconfigured and
// fail closed rather than accept a weak shared secret.
const MIN_ASIL_KEY_LEN = 32;

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  // Length is not secret (and timingSafeEqual throws on a length mismatch), but
  // the CONTENT comparison must not short-circuit on the first differing byte —
  // that is what leaks a secret one character at a time.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// True only if the request carries the real ASIL key. Fails closed in every
// degenerate case, exactly like hasValidPollKey / hasValidSyncKey.
function hasValidAsilKey(event) {
  const expected = process.env.ROOFOPS_ASIL_KEY;
  if (!expected || String(expected).length < MIN_ASIL_KEY_LEN) return false;
  const h = (event && event.headers) || {};
  // Netlify lowercases header names; accept the canonical casing too, matching
  // the poll/sync key helpers.
  const given = h["x-roofops-asil-key"] || h["X-RoofOps-Asil-Key"] || "";
  if (!given) return false;
  return timingSafeEqualStr(given, expected);
}

// The gate each function calls: authorize THIS action iff the ASIL key is valid
// AND the action is in that function's allowlist. `allowed` is the array of
// action names a given function is willing to expose to the ASIL key. Returns
// false for an unknown/empty action or an action off the list, so the caller
// then falls through to its normal human-auth gate.
function asilKeyAllows(event, action, allowed) {
  if (!action) return false;
  if (!Array.isArray(allowed) || allowed.indexOf(action) === -1) return false;
  return hasValidAsilKey(event);
}

module.exports = { hasValidAsilKey, asilKeyAllows, timingSafeEqualStr, MIN_ASIL_KEY_LEN };
