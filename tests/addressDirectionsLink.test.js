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

/* isIOSDevice / directionsUrlFor / renderLocationDirectionsLink with a
   controllable navigator + anchor stub. */
function makeSandbox(opts){
  opts = opts || {};
  const anchor = {
    href: "#", style: { display: "none" }, __removed: false,
    removeAttribute(name){ if (name === "href") this.__removed = true; }
  };
  const sandbox = {
    __anchor: anchor,
    __fields: Object.assign({}, opts.fields),
    val(id){ return sandbox.__fields[id] || ""; },
    navigator: Object.assign({ userAgent: "", platform: "", maxTouchPoints: 0 }, opts.navigator),
    document: { getElementById(id){ return id === "location-directions" ? anchor : null; } },
    encodeURIComponent: encodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(between(workordersSource, "function isIOSDevice", '/* ================= "Leak'), sandbox);
  return sandbox;
}

const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 };
const IPADOS = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 };
const ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)", platform: "Linux armv8l", maxTouchPoints: 5 };
const DESKTOP = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 };

test("iOS (and iPadOS-masquerading-as-Mac) get Apple Maps turn-by-turn URLs", () => {
  const iphone = makeSandbox({ navigator: IPHONE });
  assert.strictEqual(iphone.directionsUrlFor("101 Main St, Omaha, NE"),
    "https://maps.apple.com/?daddr=101%20Main%20St%2C%20Omaha%2C%20NE");
  const ipad = makeSandbox({ navigator: IPADOS });
  assert.match(ipad.directionsUrlFor("101 Main St"), /^https:\/\/maps\.apple\.com\/\?daddr=/);
});

test("Android and desktop get Google Maps directions URLs", () => {
  [ANDROID, DESKTOP].forEach(function(nav){
    const sb = makeSandbox({ navigator: nav });
    assert.strictEqual(sb.directionsUrlFor("101 Main St, Omaha, NE"),
      "https://www.google.com/maps/dir/?api=1&destination=101%20Main%20St%2C%20Omaha%2C%20NE");
  });
});

test("a plain Mac desktop (no touch) is NOT treated as iPadOS", () => {
  const mac = makeSandbox({ navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 } });
  assert.match(mac.directionsUrlFor("101 Main St"), /^https:\/\/www\.google\.com\//);
});

test("blank/whitespace address yields no URL", () => {
  const sb = makeSandbox({ navigator: DESKTOP });
  assert.strictEqual(sb.directionsUrlFor(""), null);
  assert.strictEqual(sb.directionsUrlFor("   "), null);
  assert.strictEqual(sb.directionsUrlFor(null), null);
});

test("renderLocationDirectionsLink shows a live href with an address, hides without", () => {
  const sb = makeSandbox({ navigator: DESKTOP, fields: { location: "101 Main St" } });
  sb.renderLocationDirectionsLink();
  assert.strictEqual(sb.__anchor.style.display, "");
  assert.match(sb.__anchor.href, /destination=101%20Main%20St/);
  sb.__fields.location = "";
  sb.renderLocationDirectionsLink();
  assert.strictEqual(sb.__anchor.style.display, "none");
  assert.ok(sb.__anchor.__removed, "stale href removed when the address is cleared");
});

test("anchor opens in a new tab and never navigates the form away", () => {
  const a = between(indexSource, 'id="location-directions"', ">");
  assert.match(a, /target="_blank"/);
  assert.match(a, /rel="noopener"/);
});

test("wired live: location input listener + fill() + building/job pickers refresh the link", () => {
  assert.match(workordersSource, /loc\.addEventListener\("input", renderLocationDirectionsLink\)/);
  assert.match(between(workordersSource, "function fill(o)", "scheduleInlineBuildingHistoryRefresh();"), /renderLocationDirectionsLink\(\);/);
  assert.match(between(workordersSource, "function bpSelectBuilding", "async function openMoveRoofModal"), /renderLocationDirectionsLink\(\)/);
  const foundationSource = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");
  assert.match(foundationSource, /typeof renderLocationDirectionsLink === "function"\) renderLocationDirectionsLink\(\)/);
});
