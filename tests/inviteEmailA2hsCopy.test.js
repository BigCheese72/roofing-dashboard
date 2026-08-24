"use strict";
/* Regression guard for the 2026-07-16 invite-email copy fix: the
   add-to-home-screen instructions in sendInviteEmail() (netlify/functions/
   auth.js) used to tell iPhone crew members it "must be Safari, not Chrome
   -- the option doesn't exist there." That was stale pre-iOS-16.4
   knowledge: since iOS 16.4 (March 2023) third-party browsers, including
   Chrome, can add web apps to the Home Screen, and Mark himself uses
   Chrome on iOS exclusively. The old copy told a Chrome-on-iOS user their
   working browser couldn't do the thing it can -- exactly the kind of
   confidently-wrong onboarding step that makes a new tech give up.

   This is a source-copy guard (the email body is a pair of inline string
   literals, one text and one HTML -- there is no template file to render):
   it asserts the stale Safari-only claim never comes back and that BOTH
   variants of the email keep mentioning both browsers for iPhone/iPad. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "netlify", "functions", "auth.js"),
  "utf8"
);

test("invite email no longer claims Add to Home Screen is Safari-only on iOS", () => {
  // The two exact stale claims that shipped (text + HTML variants), plus
  // loose patterns so a reworded version of the same wrong claim also trips.
  assert.ok(!src.includes("must be Safari"), "stale 'must be Safari' claim is back in auth.js");
  assert.ok(!/doesn'?t exist (there|in Chrome)/i.test(src),
    "stale 'option doesn't exist in Chrome on iOS' claim is back in auth.js");
});

test("both text and HTML iPhone/iPad lines cover Safari AND Chrome", () => {
  const lines = src.split("\n").filter((l) => l.includes("iPhone/iPad"));
  // One plain-text line, one HTML <li> -- if either variant loses the
  // instruction (or the two drift apart on which browsers they name),
  // this fails rather than silently onboarding half the crew wrong.
  assert.strictEqual(lines.length, 2,
    "expected exactly 2 iPhone/iPad instruction lines (text + HTML), got " + lines.length);
  for (const line of lines) {
    assert.ok(line.includes("Safari") && line.includes("Chrome"),
      "iPhone/iPad line must mention both Safari and Chrome: " + line.trim());
    assert.ok(line.includes("Add to Home Screen"),
      "iPhone/iPad line lost the 'Add to Home Screen' instruction: " + line.trim());
  }
});
