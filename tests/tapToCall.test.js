const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(phoneValue){
  const anchor = { href: "#", style: { display: "none" }, __removed: false,
    removeAttribute(n){ if (n === "href") this.__removed = true; } };
  const input = { value: phoneValue || "" };
  const sandbox = {
    __anchor: anchor,
    __input: input,
    __fields: { billPhone: phoneValue || "" },
    val(id){ return sandbox.__fields[id] || ""; },
    document: {
      getElementById(id){
        if (id === "billphone-call") return anchor;
        if (id === "billPhone") return input;
        return null;
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(between(workordersSource, "var PHONE_DISPLAY_FORMAT", "/* ================= address"), sandbox);
  return sandbox;
}

test("telHrefFor: recognized US numbers become E.164 tel links", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.telHrefFor("(573) 489-3291"), "tel:+15734893291");
  assert.strictEqual(sb.telHrefFor("5734893291"), "tel:+15734893291");
  assert.strictEqual(sb.telHrefFor("+1 573 489 3291"), "tel:+15734893291");
});

test("telHrefFor: no link is better than a wrong link", () => {
  const sb = makeSandbox();
  ["573489", "", null, "573-489-3291 ext 204", "+44 20 7946 0958", "call the office"].forEach(function(raw){
    assert.strictEqual(sb.telHrefFor(raw), null, JSON.stringify(raw));
  });
});

test("renderPhoneCallLink shows a live tel: href for a real number, hides otherwise", () => {
  const sb = makeSandbox("(573) 489-3291");
  sb.renderPhoneCallLink();
  assert.strictEqual(sb.__anchor.style.display, "");
  assert.strictEqual(sb.__anchor.href, "tel:+15734893291");
  sb.__fields.billPhone = "573489";
  sb.renderPhoneCallLink();
  assert.strictEqual(sb.__anchor.style.display, "none");
  assert.ok(sb.__anchor.__removed, "stale href removed");
});

test("formatting and the call link move together (one input pass does both)", () => {
  const sb = makeSandbox("15734893291");
  sb.__fields.billPhone = "15734893291";
  sb.renderPhoneFormatting();
  assert.strictEqual(sb.__input.value, "(573) 489-3291", "formatted");
  /* renderPhoneFormatting chains renderPhoneCallLink — val() reads the field
     store, updated by the page's input event in the real DOM; here the field
     store still holds the raw value, which resolves to the same tel link. */
  assert.strictEqual(sb.__anchor.href, "tel:+15734893291");
  assert.strictEqual(sb.__anchor.style.display, "");
});

test("wired: anchor in the form + fill() refresh", () => {
  const a = between(indexSource, 'id="billphone-call"', ">");
  assert.match(indexSource, /id="billphone-call"/);
  assert.match(between(workordersSource, "function fill(o)", "scheduleInlineBuildingHistoryRefresh();"),
    /renderPhoneCallLink\(\);/);
});
