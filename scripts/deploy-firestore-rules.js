// Publishes firestore.rules to whichever Firebase project this deploy's
// own FIREBASE_SERVICE_ACCOUNT belongs to -- runs as part of every Netlify
// build, in every context, so a rules change committed to the repo is
// never stuck behind a manual Firebase Console publish again (see "The
// Firestore rules trap" incident, 2026-07-12: a promoted feature's rules
// were never published to production, and the app failed with "Missing or
// insufficient permissions" in front of the crew).
//
// SAFETY, TWO INDEPENDENT FACTS MUST AGREE -- credential-derivation ALONE
// is not enough. Real incident, 2026-07-12, ~8:15 PM: this script's first
// version derived the target project solely from FIREBASE_SERVICE_ACCOUNT,
// on the theory that "a deploy-preview build can only ever hold a
// dev-scoped credential." That was false -- Netlify's deploy-preview
// context was, at the time, configured with PRODUCTION's service account,
// and an unmerged PR branch's build silently published firestore.rules to
// watkins-service-orders (production). Nothing in the code caught it; the
// only reason it didn't cause an outage is that the rules change happened
// to be a strict superset of what was already live. Luck is not a control.
//
// So this script now checks the deploy context (process.env.CONTEXT,
// Netlify's own built-in build variable) against an EXPECTED project id
// for that context (FIRESTORE_RULES_EXPECTED_PROJECT_ID, set per-context
// in netlify.toml -- see [context.*.environment] blocks there; these are
// project ids, not secrets, so they're committed rather than depending on
// a separate manual Netlify dashboard step). If the credential-derived
// project and the context-expected project disagree, this refuses to
// publish at all. A mis-scoped FIREBASE_SERVICE_ACCOUNT now fails the
// build loudly instead of silently publishing to the wrong project.
//
// FAILS THE BUILD (non-zero exit) on any error -- a rules publish that
// silently didn't happen (or silently happened to the wrong project) is
// exactly the failure mode this script exists to eliminate. No try/catch
// that swallows and continues.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function fail(message) {
  console.error("[deploy-firestore-rules] FAILED: " + message);
  process.exit(1);
}

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  fail("FIREBASE_SERVICE_ACCOUNT is not set for this deploy context. " +
    "Add it in Netlify > Site configuration > Environment variables, then redeploy.");
}

let creds;
try {
  creds = JSON.parse(raw);
} catch (e) {
  fail("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
}

if (!creds.project_id) {
  fail("FIREBASE_SERVICE_ACCOUNT JSON has no project_id field.");
}

const projectId = creds.project_id;
console.log("[deploy-firestore-rules] Target project (derived from this deploy's own service account): " + projectId);

// Independent second check -- see the SAFETY comment at the top of this
// file for why credential-derivation alone already failed once. CONTEXT is
// set automatically by Netlify (production | deploy-preview | branch-deploy);
// FIRESTORE_RULES_EXPECTED_PROJECT_ID is set per-context in netlify.toml.
const context = process.env.CONTEXT;
const expectedProjectId = process.env.FIRESTORE_RULES_EXPECTED_PROJECT_ID;

if (!expectedProjectId) {
  fail(
    `No FIRESTORE_RULES_EXPECTED_PROJECT_ID is configured for context "${context || "(unset)"}". ` +
    "Add a [context.<name>.environment] block for it in netlify.toml before this can safely publish rules -- " +
    "refusing to guess."
  );
}

if (projectId !== expectedProjectId) {
  fail(
    `REFUSING TO PUBLISH. Context "${context}" expects project "${expectedProjectId}" but this deploy's ` +
    `FIREBASE_SERVICE_ACCOUNT belongs to "${projectId}". FIREBASE_SERVICE_ACCOUNT is mis-scoped for this ` +
    "Netlify context -- fix it in Site configuration > Environment variables, then redeploy. " +
    "(This exact mismatch published rules to production once already -- see the SAFETY comment above.)"
  );
}

console.log(`[deploy-firestore-rules] Context "${context}" independently confirms target project "${projectId}" -- proceeding.`);

// Firebase CLI needs the credentials as a FILE path, not inline JSON --
// written to the build's own temp dir, which Netlify tears down with the
// rest of the build container. Never logged, never committed.
const credPath = path.join(os.tmpdir(), "firestore-rules-deploy-credentials.json");
fs.writeFileSync(credPath, raw, { mode: 0o600 });

try {
  const result = spawnSync(
    "npx",
    ["--yes", "firebase-tools", "deploy", "--only", "firestore:rules", "--project", projectId, "--non-interactive"],
    {
      stdio: "inherit",
      env: Object.assign({}, process.env, { GOOGLE_APPLICATION_CREDENTIALS: credPath }),
    }
  );

  if (result.error) {
    fail("Could not launch firebase-tools: " + result.error.message);
  }
  if (result.status !== 0) {
    fail("firebase-tools exited with status " + result.status + ". Rules were NOT published to " + projectId + ". See the build log above for the real error (a permission error here means this deploy context's service account needs the Firebase Rules Admin role on " + projectId + ").");
  }

  console.log("[deploy-firestore-rules] Firestore rules published to " + projectId + ".");
} finally {
  try { fs.unlinkSync(credPath); } catch (e) { /* best-effort cleanup, not worth failing the build over */ }
}
