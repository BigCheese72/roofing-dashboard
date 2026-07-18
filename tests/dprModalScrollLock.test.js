"use strict";

// DPR modal scroll-lock leak — the DPR's own version of the freeze Mark hit on
// the WO/leak form after login (prod hotfix 27bacb9, back-ported to dev as
// eeb53e6 "idempotent guard so a fresh sign-in releases body{overflow:hidden}").
//
// core.js's lockBodyScroll() is REF-COUNTED so one modal's unlock can't release
// another's. That only holds if every open pairs with exactly one close. Two
// DPR paths broke the pairing:
//   1. The modal openers are async (they lock, THEN await map/photo setup) and
//      their buttons are undebounced <button onclick="...">. A double-tap on a
//      slow connection — a foreman on a roof — locked twice; the single Close
//      unlocked once; the leftover count kept body{overflow:hidden} and the DPR
//      form froze.
//   2. The closers unlocked unconditionally, so a close fired while that modal
//      was already shut stole a decrement from a DIFFERENT open modal.
//
// These tests drive the REAL dprLockScrollFor/dprUnlockScrollFor against the
// REAL ref-counted lock copied from core.js, so they fail if either the guard
// or the ref-count semantics regress.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dprSource = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

/* Pull the real lock implementation out of core.js rather than restating it —
   if core's semantics change (e.g. back to a boolean), these tests notice. */
function realScrollLockSource(){
  const m = coreSource.match(/var scrollLockCount[\s\S]*?function unlockBodyScroll\(\)\{[\s\S]*?\n\}/);
  assert.ok(m, "could not find the ref-counted scroll lock in js/core.js");
  return m[0];
}

/* Just the guard helpers from dpr.js — enough to exercise the pairing without
   booting the whole module (which wants Firestore, Leaflet, the DOM, …). */
function dprGuardSource(){
  const m = dprSource.match(/var dprScrollLocks = \{\};[\s\S]*?function dprUnlockScrollFor\(key\)\{[\s\S]*?\n\}/);
  assert.ok(m, "could not find dprScrollLocks guards in js/dpr.js");
  return m[0];
}

function makeSandbox(){
  const sandbox = { document: { body: { style: { overflow: "" } } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(realScrollLockSource() + "\n" + dprGuardSource(), sandbox);
  return sandbox;
}

const overflow = (s) => s.document.body.style.overflow;

test("baseline: one open + one close releases the page", () => {
  const s = makeSandbox();
  vm.runInContext('dprLockScrollFor("section")', s);
  assert.strictEqual(overflow(s), "hidden", "modal open should lock the body");
  vm.runInContext('dprUnlockScrollFor("section")', s);
  assert.strictEqual(overflow(s), "", "close should release the body");
});

test("double-tap on the trace button does NOT freeze the DPR — the bug", () => {
  const s = makeSandbox();
  // Two taps land before the async map setup finishes: opener runs twice.
  vm.runInContext('dprLockScrollFor("section"); dprLockScrollFor("section")', s);
  assert.strictEqual(overflow(s), "hidden");
  // The foreman closes once — there is only one ✕ Close.
  vm.runInContext('dprUnlockScrollFor("section")', s);
  assert.strictEqual(overflow(s), "",
    "one Close must fully release the page after a double-tap open — " +
    "an unbalanced ref-count is exactly what froze the WO/leak form");
  assert.strictEqual(vm.runInContext("scrollLockCount", s), 0,
    "no leftover ref-count");
});

test("a stray close while already shut cannot steal another modal's lock", () => {
  const s = makeSandbox();
  vm.runInContext('dprLockScrollFor("cc")', s);          // CompanyCam modal open
  vm.runInContext('dprUnlockScrollFor("section")', s);   // section modal already shut
  assert.strictEqual(overflow(s), "hidden",
    "the open CompanyCam modal must stay locked");
  vm.runInContext('dprUnlockScrollFor("cc")', s);
  assert.strictEqual(overflow(s), "", "closing CompanyCam releases it");
});

test("two genuinely different modals still ref-count independently", () => {
  const s = makeSandbox();
  vm.runInContext('dprLockScrollFor("section"); dprLockScrollFor("cc")', s);
  assert.strictEqual(vm.runInContext("scrollLockCount", s), 2, "distinct keys both count");
  vm.runInContext('dprUnlockScrollFor("section")', s);
  assert.strictEqual(overflow(s), "hidden", "the other modal is still open");
  vm.runInContext('dprUnlockScrollFor("cc")', s);
  assert.strictEqual(overflow(s), "", "last one out releases the page");
});

test("source guard: DPR modal open/close paths never call the raw lock", () => {
  // The whole point of the guards is that dpr.js routes through them. A new
  // modal wired straight to lockBodyScroll() would reintroduce the freeze.
  // Strip the guard helpers (the one legitimate caller) and all block comments,
  // then assert nothing else in dpr.js reaches for the raw lock.
  const body = dprSource
    .replace(dprGuardSource(), "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\blockBodyScroll\(\)/.test(body),
    "js/dpr.js should call dprLockScrollFor(key), not lockBodyScroll() directly");
  assert.ok(!/\bunlockBodyScroll\(\)/.test(body),
    "js/dpr.js should call dprUnlockScrollFor(key), not unlockBodyScroll() directly");
});
