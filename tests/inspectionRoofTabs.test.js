const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Roof TABS on the inspection checklist (Mark, 2026-07-20).

   Each roof repeated all five sections stacked full height, so a 4-5 roof
   building was "a mile long". Now one roof's form shows at a time and a tab
   strip switches between them.

   Two things these tests defend.

   (1) NO DATA LOSS ON SWITCH. Only the active roof's rows are in the DOM, so
   the other roofs' answers exist solely in inspectionChecklist[]. That is
   already how the form worked -- inputs write through on every keystroke -- but
   if anything ever starts reading answers back out of the DOM, switching tabs
   would silently discard four roofs' work.

   (2) THE TAB STATE SURVIVES RE-RENDER. renderInspectionChecklist() rebuilds
   innerHTML wholesale from ten call sites, including on every rating change and
   every photo edit. State in the DOM would reset to roof 1 mid-inspection. */

const inspectionsSource = fs.readFileSync(path.join(__dirname, "..", "js", "inspections.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

/* CRLF file: `.` does not match \r, so use [^\n]* to strip line comments. */
function codeOnly(src){ return src.replace(/\/\/[^\n]*/g, ""); }
function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Run the real status helpers in a sandbox. */
function statusSandbox(){
  const src = between(inspectionsSource, "function inspectionRoofTabStatus", "function renderInspectionChecklist");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb;
}
const seeded = (over) => Object.assign(
  { key: "membrane", roofId: "r1", rating: "N/A", notes: "", pin: null, linkedFindingId: null }, over || {});

/* ================= what a tab may honestly claim ================= */

test("a roof with nothing recorded reads as not started", () => {
  const sb = statusSandbox();
  const st = sb.inspectionRoofTabStatus([seeded(), seeded(), seeded()]);
  assert.equal(st.untouched, true);
  assert.equal(st.flagged, 0);
});

test("an all-N/A roof stops reading 'not started' once anything is recorded", () => {
  /* N/A is a LEGITIMATE answer -- the component isn't on this roof. A roof
     correctly marked N/A throughout, with notes, must not be branded unstarted
     forever. This is why the badge never claims a % complete. */
  const sb = statusSandbox();
  assert.equal(sb.inspectionRoofTabStatus([
    seeded(), seeded({ notes: "no rooftop equipment on this roof" })
  ]).untouched, false);
  assert.equal(sb.inspectionRoofTabStatus([seeded(), seeded({ pin: { x: 1, y: 2 } })]).untouched, false);
  assert.equal(sb.inspectionRoofTabStatus([seeded(), seeded({ linkedFindingId: "f1" })]).untouched, false);
});

test("a rating other than the seeded N/A counts as touched", () => {
  const sb = statusSandbox();
  assert.equal(sb.inspectionRoofTabStatus([seeded({ rating: "Good" })]).untouched, false);
});

test("flagged counts exactly the ratings that shade a row", () => {
  /* Same test renderInspectionChecklistRow() uses for its `nonwar` class --
     the two must not drift, or the tab and the row disagree. */
  const sb = statusSandbox();
  const st = sb.inspectionRoofTabStatus([
    seeded({ rating: "Good" }), seeded({ rating: "Fair" }),
    seeded({ rating: "Poor" }), seeded({ rating: "Critical" }), seeded({ rating: "N/A" })
  ]);
  assert.equal(st.flagged, 3);
  assert.equal(st.untouched, false);
});

test("ragged items do not throw", () => {
  const sb = statusSandbox();
  assert.doesNotThrow(() => sb.inspectionRoofTabStatus([{}, { rating: null }, null].filter(Boolean)));
  assert.equal(sb.inspectionRoofTabStatus([]).untouched, true);
  assert.equal(sb.inspectionRoofTabStatus(null).flagged, 0);
});

test("the badge shows a count when flagged, and a tick when clean but worked", () => {
  const sb = statusSandbox();
  assert.match(sb.inspectionRoofTabBadge({ flagged: 3, untouched: false }), /3/);
  assert.match(sb.inspectionRoofTabBadge({ flagged: 0, untouched: true }), /not started/i);
  assert.match(sb.inspectionRoofTabBadge({ flagged: 0, untouched: false }), /10003|✓/);
});

/* ================= tab state ================= */

test("the active tab lives in a module variable, not the DOM", () => {
  /* renderInspectionChecklist() rebuilds innerHTML from ten call sites,
     including on every rating change. DOM-held state would reset to roof 1 the
     moment a condition is set -- the most common action on this screen. */
  assert.match(inspectionsSource, /var inspectionActiveRoofId = null/);
  const render = between(inspectionsSource, "function renderInspectionChecklist", "function renderInspectionChecklistRow");
  assert.doesNotMatch(codeOnly(render), /querySelector[^\n]*activ|dataset\.activeRoof/,
    "the active roof must never be read back out of the DOM");
});

test("an unknown or deselected active roof falls back to a real tab", () => {
  /* Deselecting the active roof in the picker must not render an empty form. */
  const render = between(inspectionsSource, "function renderInspectionChecklist", "function renderInspectionChecklistRow");
  assert.match(render, /if \(!active\) active = groups\[0\]/);
  assert.match(render, /inspectionActiveRoofId = active\.roofId/,
    "the resolved tab is written back so the fallback sticks");
});

test("switching tabs re-renders rather than mutating the DOM in place", () => {
  const fn = between(inspectionsSource, "function onInspectionRoofTab", "function inspectionRoofTabStatus");
  assert.match(fn, /inspectionActiveRoofId = roofId/);
  assert.match(fn, /renderInspectionChecklist\(\)/);
});

/* ================= no data loss, and the report ================= */

test("answers are written through on input, so a tab switch cannot lose them", () => {
  /* THE invariant behind rendering one roof at a time. If this binding ever
     stops writing into inspectionChecklist[] on input, four roofs' answers
     would live only in a DOM that the next render throws away. */
  const bind = between(inspectionsSource, "function bindInspectionChecklistInputs", "/* Mark:");
  assert.match(bind, /addEventListener\("input"/);
  assert.match(bind, /item\[el\.dataset\.cf\] = el\.value/);
});

test("only the active roof is rendered, but EVERY roof still prints", () => {
  /* The tabs are a screen affordance only. The report builders read
     inspectionChecklist[] through inspectionChecklistByRoof() -- never the
     DOM -- so a tabbed screen must not become a one-roof report. */
  const render = between(inspectionsSource, "function renderInspectionChecklist", "function renderInspectionChecklistRow");
  assert.match(render, /active\.items\.map/, "screen renders the active roof only");
  assert.match(exportSource, /inspectionChecklistByRoof\(o\.inspectionChecklist/,
    "the report groups from saved data, not from what is on screen");
  const printCalls = (exportSource.match(/inspectionChecklistByRoof\(/g) || []).length;
  assert.ok(printCalls >= 2, "both the HTML report and the PDF build from the full checklist, saw " + printCalls);
});

test("a single-roof inspection gets no tab chrome at all", () => {
  /* Field-first: the common case must look exactly as it always has. */
  const render = between(inspectionsSource, "function renderInspectionChecklist", "function renderInspectionChecklistRow");
  assert.match(render, /if \(!multiRoof\)/);
  const singleBranch = between(render, "if (!multiRoof)", "Resolve the active tab");
  assert.doesNotMatch(singleBranch, /onInspectionRoofTab/, "no tabs when there is one roof");
});

test("row indices stay identity-based, not positional", () => {
  /* Rendering a subset means a row's screen position no longer matches its
     index in inspectionChecklist[]; data-ci must carry the real index or every
     edit writes to the wrong row. */
  const render = between(inspectionsSource, "function renderInspectionChecklist", "function renderInspectionChecklistRow");
  assert.match(render, /inspectionChecklist\.indexOf\(item\)/);
  assert.doesNotMatch(codeOnly(render), /items\.map\(function\(item, ?i\)/,
    "must not use the loop index as the array index");
});
