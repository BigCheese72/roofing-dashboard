#!/usr/bin/env node
"use strict";
// Preflight dependency check -- runs automatically as npm's `pretest` hook.
//
// WHY THIS EXISTS (2026-07-31): mid-session, `firebase-admin` vanished from
// node_modules while still declared in package.json. The suite went from green
// to 20 failures across the Microsoft 365 / delegated-auth tests, all of them
// MODULE_NOT_FOUND raised deep inside a require chain
// (test -> contacts-sync.js -> lib/authGuard.js -> require("firebase-admin")).
//
// Read cold, that looks exactly like a real regression in the auth or M365 code
// -- which is the trap: it cost a bisect against a branch that turned out to be
// entirely innocent (the same 20 failures reproduced with the branch's changes
// stashed). `npm install` fixed it. node_modules is gitignored and this repo
// carries no lockfile, so nothing in git records the drift; only the failures do.
//
// With several worktrees in play, the next session to hit this deserves one
// clear line instead of a wall of stack traces. This check cannot prevent the
// drift -- it just refuses to let it masquerade as broken code.

const fs = require("fs");
const path = require("path");

// Pure + exported so it can be tested without touching a real node_modules:
// takes the declared dependency names and a resolver, returns what's missing.
// The resolver is injected rather than hardcoded to require.resolve precisely
// so a test can simulate an absent module without uninstalling one.
function findMissing(depNames, resolve) {
  const missing = [];
  for (const name of depNames) {
    try { resolve(name); }
    catch (e) { missing.push(name); }
  }
  return missing;
}

// `dependencies` only. devDependencies are deliberately out of scope: this repo
// has none, and a missing dev tool does not produce the deep, misleading
// require-chain failure described above.
function declaredDependencies(pkgJson) {
  const deps = (pkgJson && pkgJson.dependencies) || {};
  return Object.keys(deps).sort();
}

function main() {
  const pkgPath = path.join(__dirname, "..", "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (e) {
    // Never block the suite over the checker's own problem -- a broken preflight
    // must not become a second mystery on top of the first.
    console.error("check-deps: could not read package.json (" + e.message + ") -- skipping preflight.");
    return 0;
  }

  const names = declaredDependencies(pkg);
  // Resolve from the repo root, which is what the tests themselves resolve
  // against -- not from this script's own directory.
  const missing = findMissing(names, (n) => require.resolve(n, { paths: [path.join(__dirname, "..")] }));
  if (!missing.length) return 0;

  console.error("");
  console.error("  DEPENDENCIES MISSING FROM node_modules -- this is NOT a code regression.");
  console.error("");
  for (const n of missing) console.error("    missing: " + n + "  (declared in package.json)");
  console.error("");
  console.error("  Left unfixed, these surface as MODULE_NOT_FOUND deep inside unrelated");
  console.error("  test files and read like broken auth / M365 / photo code. They are not.");
  console.error("");
  console.error("  Fix:  npm install");
  console.error("");
  return 1;
}

module.exports = { findMissing, declaredDependencies };

if (require.main === module) process.exit(main());
