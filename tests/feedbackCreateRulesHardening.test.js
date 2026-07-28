"use strict";
/* Firestore feedback create-rule hardening.

   The important compatibility trap: the new client seeds triageStatus:"new",
   but older bundles in the middle of a deploy submit the same feedback doc
   without any triageStatus field. The rule must accept BOTH shapes while
   rejecting forged server-owned lifecycle fields. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const rulesSource = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");

function feedbackBlock() {
  const start = rulesSource.indexOf("match /feedback/{feedbackId}");
  assert.notStrictEqual(start, -1, "missing feedback rules block");
  const end = rulesSource.indexOf("match /", start + 1);
  assert.notStrictEqual(end, -1, "could not isolate feedback block");
  return rulesSource.slice(start, end);
}

test("feedback create is field-validated but still create-only", () => {
  const block = feedbackBlock();
  assert.match(block, /allow create: if request\.resource\.data\.keys\(\)\.hasOnly\(/);
  assert.match(block, /request\.resource\.data\.type in \['praise', 'confusing', 'bug', 'feature'\]/);
  assert.match(block, /request\.resource\.data\.createdAt is number/);
  assert.match(block, /request\.resource\.data\.route\.size\(\) <= 500/);
  assert.match(block, /allow read, update, delete: if false;/);
});

test("feedback create accepts legacy no-status docs and only the new seed status", () => {
  const block = feedbackBlock();
  assert.match(block, /!request\.resource\.data\.keys\(\)\.hasAny\(\['triageStatus'\]\)/,
    "legacy clients without triageStatus must still be accepted mid-deploy");
  assert.match(block, /request\.resource\.data\.triageStatus == 'new'/,
    "new clients may seed only the watcher's new status");
  assert.doesNotMatch(block, /triageStatus == 'merged'/,
    "a crafted client must not be able to self-hide as merged");
});

test("feedback create rejects server-owned lifecycle fields", () => {
  const block = feedbackBlock();
  const hasOnly = block.slice(block.indexOf("hasOnly(["), block.indexOf("])", block.indexOf("hasOnly([")));
  for (const forbidden of ["agentDiagnosis", "branchUrl", "updatedAt"]) {
    assert.ok(!hasOnly.includes(forbidden), forbidden + " must remain server-owned");
  }
});
