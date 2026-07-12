// Publishes firestore.rules to whichever Firebase project this deploy's
// own FIREBASE_SERVICE_ACCOUNT belongs to -- runs as part of every Netlify
// build, in every context, so a rules change committed to the repo is
// never stuck behind a manual Firebase Console publish again (see "The
// Firestore rules trap" incident, 2026-07-12: a promoted feature's rules
// were never published to production, and the app failed with "Missing or
// insufficient permissions" in front of the crew).
//
// SAFETY: the target project is derived ONLY from the SAME
// FIREBASE_SERVICE_ACCOUNT credential Netlify already injects per deploy
// context (Production / Deploy Previews / Branch deploys / Preview Server
// & Agent Runners each hold their own value) -- never hardcoded, never
// read from a separate "which environment am I" flag that could drift out
// of sync with the actual credential. A Production-context build can only
// ever publish to whatever project its own service account belongs to,
// same for every other context. This is the same derive-don't-hardcode
// principle netlify/functions/photos.js uses for its Storage bucket.
//
// FAILS THE BUILD (non-zero exit) on any error -- a rules publish that
// silently didn't happen is exactly the failure mode this script exists
// to eliminate. No try/catch that swallows and continues.
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
