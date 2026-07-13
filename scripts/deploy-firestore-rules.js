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
  // ---- RULES: still fatal. Unchanged. A rules publish that silently didn't
  // happen is the incident this script was written for. ----
  const rulesResult = spawnSync(
    "npx",
    ["--yes", "firebase-tools", "deploy", "--only", "firestore:rules", "--project", projectId, "--non-interactive"],
    {
      stdio: "inherit",
      env: Object.assign({}, process.env, { GOOGLE_APPLICATION_CREDENTIALS: credPath }),
    }
  );

  if (rulesResult.error) {
    fail("Could not launch firebase-tools: " + rulesResult.error.message);
  }
  if (rulesResult.status !== 0) {
    fail("firebase-tools exited with status " + rulesResult.status + ". Rules were NOT published to " + projectId + ". See the build log above for the real error (a permission error here means this deploy context's service account needs the Firebase Rules Admin role on " + projectId + ").");
  }
  console.log("[deploy-firestore-rules] Firestore rules published to " + projectId + ".");

  // ---- INDEXES: attempted, and LOUD on failure, but NOT fatal. ----
  //
  // Composite indexes belong in the repo for the same reason rules do: an
  // index that exists only because somebody once clicked the "create it here"
  // link in a Firestore error message is an index that does not exist in the
  // next project you deploy to. warranty_review_queue had no index on
  // watkins-service-orders-dev, so list_review_queue() returned
  // 9 FAILED_PRECONDITION -- the REVIEW QUEUE, the entire safety net behind
  // "never silently file a warranty report on the wrong roof", was unreadable.
  //
  // But this must NOT fail the build, and that is a deliberate reversal:
  // publishing indexes needs an IAM role (Cloud Datastore Index Admin /
  // datastore.indexes.create) that the rules-publishing service accounts do
  // not automatically have. On 2026-07-13 making this fatal turned a missing
  // IAM grant into a hard failure of EVERY dev deploy -- a self-inflicted
  // outage of the deploy pipeline, which is strictly worse than the missing
  // index it was trying to prevent. Rules staying fatal preserves the original
  // incident's lesson; indexes warn loudly instead, and the missing index still
  // surfaces immediately and unmissably at runtime as a FAILED_PRECONDITION.
  //
  // --non-interactive will not DELETE indexes absent from firestore.indexes.json
  // (that needs --force), so this is additive and cannot drop a hand-made index.
  const idxResult = spawnSync(
    "npx",
    ["--yes", "firebase-tools", "deploy", "--only", "firestore:indexes", "--project", projectId, "--non-interactive"],
    {
      stdio: "inherit",
      env: Object.assign({}, process.env, { GOOGLE_APPLICATION_CREDENTIALS: credPath }),
    }
  );

  if (idxResult.error || idxResult.status !== 0) {
    console.error("");
    console.error("=============================================================");
    console.error("[deploy-firestore-rules] WARNING: Firestore INDEXES were NOT published to " + projectId + ".");
    console.error("Rules published fine; only indexes failed. The build is NOT failed for this.");
    console.error("");
    console.error("If the error above is 'HTTP Error: 403, The caller does not have permission',");
    console.error("this deploy context's FIREBASE_SERVICE_ACCOUNT needs the IAM role:");
    console.error("    Cloud Datastore Index Admin   (roles/datastore.indexAdmin)");
    console.error("on project " + projectId + ". Grant it in Google Cloud Console > IAM, then redeploy.");
    console.error("");
    console.error("Until then, any query needing a composite index returns 9 FAILED_PRECONDITION.");
    console.error("That currently includes the warranty REVIEW QUEUE (list_review_queue) and");
    console.error("resolveSupersedes() -- i.e. inspection-report filing and the review queue both.");
    console.error("=============================================================");
    console.error("");
  } else {
    console.log("[deploy-firestore-rules] Firestore indexes published to " + projectId + ".");
  }
} finally {
  try { fs.unlinkSync(credPath); } catch (e) { /* best-effort cleanup, not worth failing the build over */ }
}
