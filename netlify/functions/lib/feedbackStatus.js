"use strict";
/* Triage vocabulary + validators for the feedback -> auto-fix loop.
   (See "Feedback auto-fix loop" in DEV_NOTES.md and COORDINATION.md.)

   Why this is its own module and not inlined in admin.js: every value the
   Dispatch watcher writes back has to pass the SAME validation the admin
   viewer trusts when it renders. Keeping the vocabulary in one file means
   the enum, the URL allowlist and the length caps can't drift between the
   writer (admin.js update_feedback_status) and the tests that pin them.

   No firebase-admin import on purpose -- this stays a pure module so it
   unit-tests offline without stubbing Firestore. */

// The full lifecycle a bug report moves through. Order matters only for
// display; nothing here enforces a state MACHINE (the watcher may jump
// straight from "new" to "wont_fix"), it only enforces the vocabulary.
const TRIAGE_STATUSES = ["new", "triaging", "fix_proposed", "merged", "wont_fix"];

// Statuses a human/agent may write. Identical to the list above today --
// kept as its own export so a future "archived" display-only state can be
// added to TRIAGE_STATUSES without silently becoming writable.
const WRITABLE_TRIAGE_STATUSES = TRIAGE_STATUSES.slice();

// Hosts a branchUrl may point at. This is an ALLOWLIST, not a scheme check:
// the admin viewer renders branchUrl into an <a href>, so an unconstrained
// string is a stored-XSS / phishing surface (javascript:, data:, or a
// lookalike host). Only the repo host the loop actually pushes to is
// accepted. Add to this list deliberately, never widen it to "any https".
const BRANCH_URL_HOSTS = ["github.com", "www.github.com"];

const MAX_DIAGNOSIS_LEN = 4000;
const MAX_BRANCH_URL_LEN = 500;

function isValidTriageStatus(value) {
  return typeof value === "string" && TRIAGE_STATUSES.indexOf(value) !== -1;
}

/* Trims + caps free text the agent wrote. Returns "" for null/undefined so a
   caller can distinguish "field omitted" (undefined in, "" out, skip the
   write) from "explicitly cleared" (null in -> caller passes null through). */
function clampDiagnosis(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\r\n/g, "\n").trim();
  return text.length > MAX_DIAGNOSIS_LEN ? text.slice(0, MAX_DIAGNOSIS_LEN - 1).trim() + "…" : text;
}

/* Returns the URL string if it is a well-formed https:// URL on an
   allowlisted host, else null. Callers treat null as "reject the request",
   NOT as "store null" -- silently dropping a bad branch link would leave the
   watcher thinking it published one. */
function normalizeBranchUrl(value) {
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value).trim();
  if (!raw || raw.length > MAX_BRANCH_URL_LEN) return null;
  let parsed;
  try { parsed = new URL(raw); } catch (e) { return null; }
  if (parsed.protocol !== "https:") return null;
  if (BRANCH_URL_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return null;
  return parsed.toString();
}

/* Validates + normalizes the list_feedback query params the Dispatch watcher
   sends. Every field is optional; the no-argument call returns the same
   defaults list_feedback used before this feature existed (newest 200, no
   filter) so the existing admin backlog view is unaffected.

   Returns { ok: true, query } or { ok: false, error } -- admin.js turns the
   error into a 400 rather than quietly running a different query than the
   caller asked for. */
function parseFeedbackQuery(body) {
  const src = body || {};
  const query = { type: null, triageStatus: null, sinceCreatedAt: null, limit: 200 };

  if (src.type !== undefined && src.type !== null && src.type !== "") {
    const type = String(src.type).trim();
    // Mirrors FEEDBACK_TYPES in js/core.js. Kept as a literal (not imported)
    // because that file is a browser script with no module exports; the
    // tests assert the two lists match so drift is caught.
    if (["praise", "confusing", "bug", "feature"].indexOf(type) === -1) {
      return { ok: false, error: "Invalid feedback type" };
    }
    query.type = type;
  }

  if (src.triageStatus !== undefined && src.triageStatus !== null && src.triageStatus !== "") {
    if (!isValidTriageStatus(src.triageStatus)) return { ok: false, error: "Invalid triageStatus" };
    query.triageStatus = src.triageStatus;
  }

  if (src.sinceCreatedAt !== undefined && src.sinceCreatedAt !== null && src.sinceCreatedAt !== "") {
    const since = Number(src.sinceCreatedAt);
    // createdAt is a plain Date.now() epoch-ms number everywhere in this app
    // (js/core.js submitFeedback), not a Firestore Timestamp -- so the
    // watermark is a number and a non-numeric one is a caller bug, not a
    // reason to silently scan the whole collection.
    if (!Number.isFinite(since) || since < 0) return { ok: false, error: "Invalid sinceCreatedAt" };
    query.sinceCreatedAt = since;
  }

  if (src.limit !== undefined && src.limit !== null && src.limit !== "") {
    const limit = Number(src.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: "Invalid limit (1-200)" };
    query.limit = limit;
  }

  return { ok: true, query };
}

module.exports = {
  TRIAGE_STATUSES,
  WRITABLE_TRIAGE_STATUSES,
  BRANCH_URL_HOSTS,
  MAX_DIAGNOSIS_LEN,
  MAX_BRANCH_URL_LEN,
  isValidTriageStatus,
  clampDiagnosis,
  normalizeBranchUrl,
  parseFeedbackQuery
};
