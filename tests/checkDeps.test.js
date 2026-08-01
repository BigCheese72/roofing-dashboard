"use strict";
/* Preflight dependency check (scripts/check-deps.js), wired as npm's `pretest`.

   Guards the 2026-07-31 incident: `firebase-admin` disappeared from node_modules
   while still declared in package.json, and the resulting MODULE_NOT_FOUND
   errors -- raised deep inside test -> contacts-sync.js -> lib/authGuard.js --
   read as a regression in the auth/M365 code. They weren't: the same 20 failures
   reproduced with the suspect branch stashed. node_modules is gitignored and
   there is no lockfile, so nothing in git records the drift.

   The checker only has to do two things, and both are asserted here:
     1. Report exactly the declared dependencies that will not resolve.
     2. Never crash on its own -- a broken preflight must not become a second
        mystery stacked on the first. */
const test = require("node:test");
const assert = require("node:assert");
const { findMissing, declaredDependencies } = require("../scripts/check-deps");

// A resolver that only knows about the names it is given -- lets us simulate an
// absent module without uninstalling one.
const resolverFor = (present) => (name) => {
  if (!present.includes(name)) throw new Error("Cannot find module '" + name + "'");
  return "/fake/node_modules/" + name;
};

test("reports nothing when every declared dependency resolves", () => {
  const deps = ["firebase-admin", "jimp", "mssql"];
  assert.deepStrictEqual(findMissing(deps, resolverFor(deps)), []);
});

test("reports exactly the dependency that vanished (the real incident)", () => {
  const deps = ["firebase-admin", "jimp", "mssql"];
  assert.deepStrictEqual(findMissing(deps, resolverFor(["jimp", "mssql"])), ["firebase-admin"]);
});

test("reports every missing dependency, not just the first", () => {
  const deps = ["firebase-admin", "jimp", "mssql"];
  assert.deepStrictEqual(findMissing(deps, resolverFor([])), deps);
});

test("an empty dependency list is not an error", () => {
  assert.deepStrictEqual(findMissing([], resolverFor([])), []);
});

test("declaredDependencies reads dependencies only, sorted and stable", () => {
  const pkg = { dependencies: { mssql: "^11", "firebase-admin": "^12", jimp: "^0.22" },
    devDependencies: { something: "^1" } };
  assert.deepStrictEqual(declaredDependencies(pkg), ["firebase-admin", "jimp", "mssql"],
    "devDependencies are deliberately out of scope");
});

test("declaredDependencies never throws on a malformed or empty package.json", () => {
  for (const pkg of [undefined, null, {}, { dependencies: null }, { dependencies: {} }]) {
    assert.deepStrictEqual(declaredDependencies(pkg), []);
  }
});

// The point of the whole exercise: this repo's own manifest must be covered, so
// the guard cannot silently stop watching the dependency that actually vanished.
test("the real package.json declares firebase-admin, and it resolves right now", () => {
  const pkg = require("../package.json");
  const names = declaredDependencies(pkg);
  assert.ok(names.includes("firebase-admin"), "firebase-admin must stay declared");
  assert.deepStrictEqual(findMissing(names, require.resolve), [],
    "if this fails, run `npm install` -- it is dependency drift, NOT broken code");
});

test("pretest is wired up, or the guard never runs", () => {
  const pkg = require("../package.json");
  assert.strictEqual(pkg.scripts.pretest, "node scripts/check-deps.js");
});
