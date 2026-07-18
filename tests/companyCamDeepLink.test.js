const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* "Open in CompanyCam" deep-link buttons on the work-order form and the DPR
   (Mark, approved 2026-07-18).

   The URL scheme under test is CompanyCam's own documented mobile deep link,
   ccam://projects/<id> (docs.companycam.com/docs/mobile-deep-links). If these
   assertions ever fail because the scheme changed, fix js/companycam.js --
   do NOT relax the assertion to whatever the code now emits. In particular,
   an https://app.companycam.com/... fallback was deliberately NOT added
   because that URL is not in CompanyCam's docs; see CC-1 on the board. */

const companycamSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const dprSource = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function makeSandbox(){
  const sandbox = {
    /* Same escaping contract as js/core.js's esc(). */
    esc(s){
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(companycamSource, "function ccProjectDeepLink", "function renderCCLinkInfo"),
    sandbox
  );
  return sandbox;
}

test("ccProjectDeepLink builds CompanyCam's documented ccam:// project scheme", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.ccProjectDeepLink("35212993"), "ccam://projects/35212993");
  /* CompanyCam ids are numeric today, but the helper must not assume it. */
  assert.strictEqual(sb.ccProjectDeepLink("abc_DEF-123"), "ccam://projects/abc_DEF-123");
});

test("ccProjectDeepLink returns null when there is no linked project", () => {
  const sb = makeSandbox();
  [null, undefined, "", "   "].forEach(v => {
    assert.strictEqual(sb.ccProjectDeepLink(v), null, "expected null for " + JSON.stringify(v));
  });
});

test("ccProjectDeepLink refuses ids that aren't plainly ids", () => {
  const sb = makeSandbox();
  /* The id reaches a URL that the OS hands to another app. A stored value
     carrying a path traversal, a second scheme, or quote/angle characters
     must not be shipped into that URL -- reject rather than sanitize, so a
     malformed id is visibly absent instead of silently altered. */
  [
    "12/../../settings",
    "12 34",
    'x" onclick="alert(1)',
    "javascript:alert(1)",
    "ccam://projects/9",
    "<script>",
    "12?a=b",
    "12#frag"
  ].forEach(bad => {
    assert.strictEqual(sb.ccProjectDeepLink(bad), null, "expected null for " + JSON.stringify(bad));
  });
});

test("ccOpenProjectButtonHtml renders a tappable anchor for a linked project", () => {
  const sb = makeSandbox();
  const html = sb.ccOpenProjectButtonHtml("35212993");
  assert.match(html, /^<a class="btn"/);
  assert.match(html, /href="ccam:\/\/projects\/35212993"/);
  assert.match(html, /Open in CompanyCam/);
  /* The label says "app" somewhere reachable, because on a desktop browser
     with no CompanyCam app the tap does nothing -- the user needs to know. */
  assert.match(html, /title="[^"]*CompanyCam app"/);
});

test("ccOpenProjectButtonHtml renders nothing when no project is linked", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.ccOpenProjectButtonHtml(null), "");
  assert.strictEqual(sb.ccOpenProjectButtonHtml(""), "");
  /* A rejected id must produce no button rather than a dead one. */
  assert.strictEqual(sb.ccOpenProjectButtonHtml("12/../../x"), "");
});

test("both surfaces render the button from the one shared helper", () => {
  /* The point of the shared helper is that the work-order form and the DPR
     can't drift into two different URLs or two different labels. */
  const woBlock = between(companycamSource, "function renderCCLinkInfo", "/* Inherits the building");
  assert.match(woBlock, /ccOpenProjectButtonHtml\(ccLinkedProjectId\)/);
  assert.match(dprSource, /ccOpenProjectButtonHtml\(dprState\.companyCamProjectId\)/);
  /* Neither surface may hand-roll its own scheme string. */
  assert.doesNotMatch(woBlock, /ccam:\/\//);
  assert.doesNotMatch(dprSource, /ccam:\/\//);
});

test("the DPR call is typeof-guarded so the report survives without companycam.js", () => {
  /* js/companycam.js loads before js/dpr.js in index.html, but the DPR is
     also exercised in isolation; an unguarded call would throw and take the
     whole job header down rather than just omitting one button. */
  assert.match(dprSource, /typeof ccOpenProjectButtonHtml === "function"/);
});
