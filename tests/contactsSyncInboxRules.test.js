// Unit tests for the contacts-sync inbox-rule builder — the subject/body
// keyword auto-file support and its guardrails.
//
// buildInboxRule is a pure function (it never issues a Graph request), so we
// load just its source block into a fresh VM context — the same technique the
// roofmapper tests use. This deliberately avoids requiring the whole
// contacts-sync module, whose top-level require of lib/graphDelegatedAuth
// pulls in firebase-admin and a live mailbox config that has nothing to do
// with the logic under test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function loadRuleBuilder() {
  const src = fs.readFileSync(path.join(repoRoot, "netlify/functions/contacts-sync.js"), "utf8");
  const start = src.indexOf("const RULE_CONDITION_FIELDS");
  const end = src.indexOf("exports.handler", start);
  assert.notEqual(start, -1, "missing RULE_CONDITION_FIELDS marker");
  assert.notEqual(end, -1, "missing exports.handler marker");
  // Evaluate the self-contained block in THIS realm (not a vm sandbox) so the
  // objects it returns share this realm's prototypes and satisfy
  // deepStrictEqual. The block requires nothing, so firebase-admin is never
  // pulled in.
  const factory = new Function(src.slice(start, end) + "\nreturn { buildInboxRule, ruleKeywordProblem };");
  return factory();
}

const { buildInboxRule, ruleKeywordProblem } = loadRuleBuilder();
const DEST = "AAMkDestFolderId==";

test("senderContains still builds a move-only rule (unchanged behaviour)", () => {
  const built = buildInboxRule({ displayName: "ACME", destinationId: DEST, senderContains: ["@acme.com"] });
  assert.equal(built.skip, undefined);
  assert.deepEqual(built.payload.conditions, { senderContains: ["@acme.com"] });
  assert.equal(built.payload.isEnabled, true);
  assert.deepEqual(built.payload.actions, { moveToFolder: DEST, stopProcessingRules: true });
  assert.equal(built.matchCount, 1);
});

test("subjectContains emits into Graph conditions", () => {
  const built = buildInboxRule({ displayName: "Leaks", destinationId: DEST, subjectContains: ["leak", "roof leak"] });
  assert.equal(built.skip, undefined);
  assert.deepEqual(built.payload.conditions, { subjectContains: ["leak", "roof leak"] });
  assert.equal(built.matchCount, 2);
});

test("bodyContains emits into Graph conditions", () => {
  const built = buildInboxRule({ displayName: "Invoices", destinationId: DEST, bodyContains: ["invoice", "amount due"] });
  assert.equal(built.skip, undefined);
  assert.deepEqual(built.payload.conditions, { bodyContains: ["invoice", "amount due"] });
  assert.equal(built.matchCount, 2);
});

test("all three condition arrays combine (OR-matched by Graph)", () => {
  const built = buildInboxRule({
    displayName: "Warranties",
    destinationId: DEST,
    senderContains: ["warranty@gaf.com"],
    subjectContains: ["warranty", "warranty claim"],
    bodyContains: ["golden pledge"],
  });
  assert.equal(built.skip, undefined);
  assert.deepEqual(built.payload.conditions, {
    senderContains: ["warranty@gaf.com"],
    subjectContains: ["warranty", "warranty claim"],
    bodyContains: ["golden pledge"],
  });
  assert.equal(built.matchCount, 4);
});

test("keywords are trimmed on emission", () => {
  const built = buildInboxRule({ displayName: "T", destinationId: DEST, subjectContains: ["  leak  "] });
  assert.deepEqual(built.payload.conditions, { subjectContains: ["leak"] });
});

test("action is always move-only, never forward/delete/markRead, even if the caller asks", () => {
  const built = buildInboxRule({
    displayName: "Evil",
    destinationId: DEST,
    subjectContains: ["invoice"],
    // caller-supplied hostile fields must be ignored
    actions: { forwardTo: [{ emailAddress: { address: "attacker@evil.com" } }], delete: true, markAsRead: true },
    isEnabled: false,
  });
  assert.deepEqual(built.payload.actions, { moveToFolder: DEST, stopProcessingRules: true });
  assert.equal(built.payload.isEnabled, true);
  assert.equal("forwardTo" in built.payload.actions, false);
  assert.equal("delete" in built.payload.actions, false);
  assert.equal("markAsRead" in built.payload.actions, false);
});

// ---- guardrails ----------------------------------------------------------

test("missing destinationId is skipped", () => {
  const built = buildInboxRule({ displayName: "X", subjectContains: ["invoice"] });
  assert.match(built.skip, /needs destinationId/);
});

test("no condition arrays at all is skipped", () => {
  const built = buildInboxRule({ displayName: "X", destinationId: DEST });
  assert.match(built.skip, /at least one non-empty condition/);
});

test("empty condition arrays only is skipped", () => {
  const built = buildInboxRule({ displayName: "X", destinationId: DEST, subjectContains: [], senderContains: [] });
  assert.match(built.skip, /at least one non-empty condition/);
});

test("empty / whitespace keyword skips the whole rule", () => {
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: [""] }).skip, /empty keyword/);
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: ["   "] }).skip, /empty keyword/);
});

test("keyword shorter than 3 chars skips the whole rule", () => {
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: ["ab"] }).skip, /shorter than 3/);
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: ["@"] }).skip, /shorter than 3/);
});

test("over-broad stopword tokens skip the whole rule", () => {
  for (const w of ["the", "and", "fwd", "you"]) {
    const built = buildInboxRule({ destinationId: DEST, subjectContains: [w] });
    assert.ok(built.skip, "expected skip for token '" + w + "'");
    assert.match(built.skip, /over-broad token/);
  }
});

test("a bare domain in a subject/body match is over-broad and skips the rule", () => {
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: ["gmail.com"] }).skip, /bare domain/);
  assert.match(buildInboxRule({ destinationId: DEST, bodyContains: ["acme.com"] }).skip, /bare domain/);
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: ["@acme.com"] }).skip, /bare domain/);
});

test("a bare domain in senderContains is allowed (that is the point of sender matching)", () => {
  const built = buildInboxRule({ destinationId: DEST, senderContains: ["acme.com", "@gmail.com"] });
  assert.equal(built.skip, undefined);
  assert.deepEqual(built.payload.conditions, { senderContains: ["acme.com", "@gmail.com"] });
});

test("one bad keyword rejects the whole rule (never files on the good ones)", () => {
  const built = buildInboxRule({ destinationId: DEST, subjectContains: ["invoice", "an"] });
  assert.ok(built.skip);
  assert.equal(built.payload, undefined);
});

test("non-array condition is skipped", () => {
  assert.match(buildInboxRule({ destinationId: DEST, subjectContains: "invoice" }).skip, /must be an array/);
});

test("ruleKeywordProblem field-scopes the bare-domain rule", () => {
  assert.equal(ruleKeywordProblem("acme.com", "senderContains"), null);
  assert.match(ruleKeywordProblem("acme.com", "subjectContains"), /bare domain/);
  assert.equal(ruleKeywordProblem("roof leak", "subjectContains"), null);
});
