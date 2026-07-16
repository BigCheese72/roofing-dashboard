const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const PIN = { lat: 41.25, lng: -95.93, x: null, y: null, source: "tech_placed", suite: null };

/* Pairing surface from js/workorders.js: removeFinding's unlink +
   repairForFinding / repairIndexForFinding / repairFindingLinkOptionsHtml /
   linkRepairToFinding. */
function makePairingSandbox(opts){
  opts = opts || {};
  const sandbox = {
    findings: opts.findings ? opts.findings.slice() : [],
    repairs: opts.repairs ? opts.repairs.slice() : [],
    photos: [],
    esc(s){ return String(s == null ? "" : s); },
    renderPhotos(){}, renderRepairs(){}, renderFindings(){}
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(workordersSource, "function removeFinding", "/* Persistent per-photo indicator"),
    sandbox
  );
  return sandbox;
}

test("linking carries the finding's location and a pin SNAPSHOT into the repair's gaps only", () => {
  const sb = makePairingSandbox();
  const finding = { id: "fnd_1", condition: "Split seam", location: "NW parapet", pin: Object.assign({}, PIN) };
  const repair = { id: "rep_1", repair: "Re-seamed", location: "", pin: null, finding_id: null };
  sb.linkRepairToFinding(repair, finding);
  assert.strictEqual(repair.location, "NW parapet", "empty location adopts the finding's");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(repair.pin)), JSON.parse(JSON.stringify(PIN)),
    "pin carried so the after-photo frames the same spot");
  assert.notStrictEqual(repair.pin, finding.pin, "pin is a CLONE — moving one later never yanks the other");
  /* Gaps only: the repair's own spot is never overwritten. */
  const repair2 = { id: "rep_2", repair: "x", location: "SE corner", pin: { lat: 1, lng: 2 }, finding_id: null };
  sb.linkRepairToFinding(repair2, finding);
  assert.strictEqual(repair2.location, "SE corner");
  assert.strictEqual(repair2.pin.lat, 1);
});

test("finding side is DERIVED: repairForFinding/repairIndexForFinding, no stored back-ref", () => {
  const sb = makePairingSandbox({
    repairs: [
      { id: "rep_a", repair: "a", location: "", pin: null, finding_id: null },
      { id: "rep_b", repair: "b", location: "", pin: null, finding_id: "fnd_9" }
    ]
  });
  assert.strictEqual(sb.repairForFinding("fnd_9").id, "rep_b");
  assert.strictEqual(sb.repairIndexForFinding("fnd_9"), 1, "chip shows 'Repair #2' (index+1)");
  assert.strictEqual(sb.repairForFinding("fnd_none"), null);
  assert.strictEqual(sb.repairIndexForFinding(null), -1);
});

test("link options: on-screen Finding #N numbering (blanks hold their number but aren't offered)", () => {
  const sb = makePairingSandbox({
    findings: [
      { id: "fnd_1", condition: "", location: "", warranty: "Warrantable", pin: null },   /* blank — skipped */
      { id: "fnd_2", condition: "Split seam at the NW parapet wall flashing detail area", location: "", pin: null },
      { id: "fnd_3", condition: "", location: "Ponding SE", pin: null }
    ]
  });
  const html = sb.repairFindingLinkOptionsHtml("fnd_3");
  assert.match(html, /— not linked —/);
  assert.ok(html.indexOf("fnd_1") === -1, "blank finding not offered");
  assert.match(html, /Finding #2 — Split seam at the NW parapet wall flashi/);
  assert.match(html, /value="fnd_3" selected>Finding #3 — Ponding SE/);
});

test("removing a finding unlinks its paired repair (repair row survives, photos rule reused)", () => {
  const sb = makePairingSandbox({
    findings: [{ id: "fnd_1", condition: "Split seam", location: "", pin: null }],
    repairs: [{ id: "rep_1", repair: "Re-seamed", location: "", pin: null, finding_id: "fnd_1" }]
  });
  sb.removeFinding(0);
  assert.strictEqual(sb.findings.length, 0);
  assert.strictEqual(sb.repairs.length, 1, "the repair is real work — never deleted with the finding");
  assert.strictEqual(sb.repairs[0].finding_id, null);
});

/* Repair-row select wiring (js/photos.js renderRepairs) — same fake-host
   pattern as tests/repairScopeSync.test.js. */
function makeRowSandbox(opts){
  opts = opts || {};
  const handlers = [];
  const host = {
    innerHTML: "",
    appendChild(){},
    querySelectorAll(sel){
      if (sel !== "[data-f]") return [];
      const els = [];
      sandbox.repairs.forEach(function(r, i){
        ["repair", "location", "finding_id"].forEach(function(f){
          const el = { dataset: { i: String(i), f: f }, value: r[f] || "" };
          el.addEventListener = function(type, fn){ handlers.push({ type: type, i: i, f: f, el: el, fn: fn }); };
          els.push(el);
        });
      });
      return els;
    }
  };
  const sandbox = {
    repairs: opts.repairs ? opts.repairs.slice() : [],
    findings: opts.findings ? opts.findings.slice() : [],
    materials: [],
    __fields: { woType: "Inspection" },
    __renderedFindings: 0,
    val(id){ return sandbox.__fields[id] || ""; },
    esc(s){ return String(s == null ? "" : s); },
    genId(p){ return p + "_t"; },
    rememberFieldValue(){},
    findingById(id){ return sandbox.findings.find(function(f){ return f && f.id === id; }) || null; },
    linkRepairToFinding(r, f){
      if (!r || !f) return;
      if (!r.location && f.location) r.location = f.location;
      if (!r.pin && f.pin) r.pin = JSON.parse(JSON.stringify(f.pin));
    },
    repairFindingLinkOptionsHtml(){ return "<option></option>"; },
    renderFindings(){ sandbox.__renderedFindings++; },
    renderMaterials(){},
    openBaseMapPinPicker(){},
    document: {
      getElementById(id){
        if (id === "repairs-list") return host;
        if (id === "repairDescription") return { value: "" };
        return null;
      },
      createElement(){ return { className: "", style: {}, innerHTML: "" }; }
    },
    __host: host,
    __handlers: handlers
  };
  vm.createContext(sandbox);
  vm.runInContext(between(photosSource, "function repairScopeLineFor", "/* Repair work order type only"), sandbox);
  return sandbox;
}

test("selecting a finding on a repair row links it and carries the spot; '' unlinks", () => {
  const sb = makeRowSandbox({
    findings: [{ id: "fnd_1", condition: "Split seam", location: "NW parapet", pin: Object.assign({}, PIN) }],
    repairs: [{ id: "rep_1", repair: "Re-seamed", location: "", pin: null, finding_id: null }]
  });
  sb.renderRepairs();
  const h = sb.__handlers.filter(function(x){ return x.type === "input" && x.f === "finding_id"; }).pop();
  h.el.value = "fnd_1";
  h.fn();
  assert.strictEqual(sb.repairs[0].finding_id, "fnd_1");
  assert.strictEqual(sb.repairs[0].location, "NW parapet", "spot carried on link");
  assert.strictEqual(sb.repairs[0].pin.lat, PIN.lat);
  assert.ok(sb.__renderedFindings > 0, "finding chip refreshes");
  const h2 = sb.__handlers.filter(function(x){ return x.type === "input" && x.f === "finding_id"; }).pop();
  h2.el.value = "";
  h2.fn();
  assert.strictEqual(sb.repairs[0].finding_id, null, "empty select = unlinked (null, not \"\")");
});

/* Report references — filledFindings numbering, dangling-safe. */
function makeExportSandbox(findings, repairs){
  const sandbox = { findings: findings, repairs: repairs, repairItems: [], materials: [], photos: [] };
  vm.createContext(sandbox);
  vm.runInContext(
    between(exportSource, "function findingHasPhotos", "function filledPhotos"),
    sandbox
  );
  return sandbox;
}

test("report: repairResolvesLabel uses the printed findings numbering and skips dangling links", () => {
  const sb = makeExportSandbox([
    { id: "fnd_blank", condition: "", location: "" },        /* not printed */
    { id: "fnd_1", condition: "Split seam", location: "" }
  ], []);
  assert.strictEqual(sb.repairResolvesLabel("fnd_1"), "Finding #1",
    "numbering must match the printed findings section, not raw array position");
  assert.strictEqual(sb.repairResolvesLabel("fnd_blank"), "", "an unprinted finding gets no dangling ref");
  assert.strictEqual(sb.repairResolvesLabel(null), "");
});

test("all three Work Performed print paths carry the Resolves reference", () => {
  assert.match(exportSource, /\[resolves " \+ resolves \+ " — before\/after\]/);
  const html = between(exportSource, "<h3 class='cond'>Work Performed</h3>", "</tbody></table>");
  assert.match(html, /<th style='width:110px'>Resolves<\/th>/);
  assert.match(html, /repairResolvesLabel\(r\.finding_id\)/);
  const pdf = between(exportSource, 'heading("Work Performed")', "margin: { left: M, right: M }");
  assert.match(pdf, /"Resolves"/);
  assert.match(pdf, /repairResolvesLabel\(r\.finding_id\)/);
});

test("fill() self-heals finding_id onto legacy repair rows", () => {
  assert.match(workordersSource, /if \(r\.finding_id === undefined\) r\.finding_id = null;/);
});
