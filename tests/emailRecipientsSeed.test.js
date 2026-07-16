"use strict";
/* Email "Send to…" quick-pick seed: the four office contacts added 2026-07-15
   must be in EMAIL_RECIPIENTS_SEED, get backfilled into a device's existing
   stored list (getEmailRecipients, case-insensitive dedupe), and render as
   named options in the Send-to select (populateEmailPick). Extracted from
   js/core.js with localStorage/document/esc stubbed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const block = src.slice(src.indexOf("var EMAIL_RECIPIENTS_KEY"), src.indexOf("function rememberEmailRecipients"));

const NEW_FOUR = [
  { email: "daxd@watkinsroofing.net", label: "Dax Dollins" },
  { email: "carld@watkinsroofing.net", label: "Carl Daly" },
  { email: "jodyg@watkinsroofing.net", label: "Jody Galloway" },
  { email: "thomase@watkinsroofing.net", label: "Thomas Emms" }
];

function makeCtx(storedList){
  const store = {};
  if (storedList) store["email-recipients-v1"] = JSON.stringify(storedList);
  const sel = { value: "", innerHTML: "" };
  const ctx = {
    JSON, Array, String,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; }
    },
    document: { getElementById: (id) => (id === "emailPick" ? sel : null) },
    esc: (s) => String(s)
  };
  vm.runInNewContext(block, ctx);
  ctx.__sel = sel; ctx.__store = store;
  return ctx;
}

test("seed contains the four new contacts with exact emails + labels", () => {
  const ctx = makeCtx();
  NEW_FOUR.forEach((want) => {
    const hit = ctx.EMAIL_RECIPIENTS_SEED.find((r) => r.email === want.email);
    assert.ok(hit, want.email + " in seed");
    assert.equal(hit.label, want.label);
  });
});

test("seed has no case-insensitive duplicate emails", () => {
  const ctx = makeCtx();
  const keys = ctx.EMAIL_RECIPIENTS_SEED.map((r) => r.email.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
});

test("fresh device: all four render as named options in the Send-to select", () => {
  const ctx = makeCtx();
  ctx.populateEmailPick();
  NEW_FOUR.forEach((want) => {
    assert.match(ctx.__sel.innerHTML, new RegExp('value="' + want.email + '">' + want.label + "<"));
  });
});

test("device with an existing stored list: the four are backfilled and render", () => {
  // A stored list from before this seed change (misses the four; has its own extra).
  const ctx = makeCtx([
    { email: "charlottew@watkinsroofing.net", label: "Charlotte Washburn" },
    { email: "somebody@example.com", label: "Existing Extra" }
  ]);
  ctx.populateEmailPick();
  NEW_FOUR.forEach((want) => assert.match(ctx.__sel.innerHTML, new RegExp(want.label)));
  assert.match(ctx.__sel.innerHTML, /Existing Extra/, "device's own entries untouched");
  const persisted = JSON.parse(ctx.__store["email-recipients-v1"]);
  NEW_FOUR.forEach((want) => assert.ok(persisted.some((r) => r.email === want.email), want.email + " persisted"));
});

test("backfill is case-insensitive (an already-stored DaxD@ variant is not duplicated)", () => {
  const ctx = makeCtx([{ email: "DaxD@watkinsroofing.net", label: "Dax (already saved)" }]);
  const list = ctx.getEmailRecipients();
  const daxes = list.filter((r) => r.email.toLowerCase() === "daxd@watkinsroofing.net");
  assert.equal(daxes.length, 1, "no duplicate for a case-variant already on the device");
});
