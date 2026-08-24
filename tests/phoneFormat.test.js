const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(fieldValue){
  const input = { value: fieldValue || "" };
  const sandbox = {
    __input: input,
    document: { getElementById(id){ return id === "billPhone" ? input : null; } }
  };
  vm.createContext(sandbox);
  vm.runInContext(between(workordersSource, "var PHONE_DISPLAY_FORMAT", "/* ================= address"), sandbox);
  return sandbox;
}

test("a clean 10-digit US number formats to the PHONE_DISPLAY_FORMAT style", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.formatPhoneUS("5734893291"), "(573) 489-3291");
  assert.strictEqual(sb.formatPhoneUS("573-489-3291"), "(573) 489-3291");
  assert.strictEqual(sb.formatPhoneUS("573.489.3291"), "(573) 489-3291");
  assert.strictEqual(sb.formatPhoneUS(" 573 489 3291 "), "(573) 489-3291");
});

test("a leading 1 (US country code) is absorbed", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.formatPhoneUS("15734893291"), "(573) 489-3291");
  assert.strictEqual(sb.formatPhoneUS("+1 573 489 3291"), "(573) 489-3291");
});

test("idempotent: an already-formatted number stays byte-identical", () => {
  const sb = makeSandbox();
  const once = sb.formatPhoneUS("5734893291");
  assert.strictEqual(sb.formatPhoneUS(once), once);
  /* Mark's own no-space example also normalizes to the configured style */
  assert.strictEqual(sb.formatPhoneUS("(573)489-3291"), "(573) 489-3291");
});

test("anything not positively a 10-digit US number passes through untouched", () => {
  const sb = makeSandbox();
  ["573489", "57348932", "", "573-489-3291 ext 204" /* 13 digits */, "+44 20 7946 0958",
   "call the office", null].forEach(function(raw){
    assert.strictEqual(sb.formatPhoneUS(raw), String(raw || ""), JSON.stringify(raw) + " must not be mangled");
  });
});

test("the style is ONE constant — swapping it reformats without code changes", () => {
  const sb = makeSandbox();
  sb.PHONE_DISPLAY_FORMAT = "(AAA)PPP-NNNN"; /* Mark's literal example style */
  assert.strictEqual(sb.formatPhoneUS("5734893291"), "(573)489-3291");
});

test("renderPhoneFormatting rewrites the field only when the format actually changes", () => {
  const sb = makeSandbox("15734893291");
  sb.renderPhoneFormatting();
  assert.strictEqual(sb.__input.value, "(573) 489-3291");
  const sb2 = makeSandbox("573489"); /* partial, mid-typing */
  sb2.renderPhoneFormatting();
  assert.strictEqual(sb2.__input.value, "573489", "partial input untouched — no cursor fights");
});

test("wired: input+blur listeners on billPhone; fill() normalizes legacy stored values", () => {
  assert.match(workordersSource, /bp\.addEventListener\("input", renderPhoneFormatting\)/);
  assert.match(workordersSource, /bp\.addEventListener\("blur", renderPhoneFormatting\)/);
  assert.match(between(workordersSource, "function fill(o)", "scheduleInlineBuildingHistoryRefresh();"),
    /setVal\("billPhone", formatPhoneUS\(o\.billPhone\)\);/);
});
