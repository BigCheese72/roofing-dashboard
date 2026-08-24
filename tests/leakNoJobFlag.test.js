const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Detector + email-note surface from js/workorders.js. */
function makeSandbox(opts){
  opts = opts || {};
  const banner = { style: { display: "unset" } };
  const sandbox = {
    __banner: banner,
    __fields: Object.assign({}, opts.fields),
    fdnLinkedJobNo: opts.fdnJobNo === undefined ? null : opts.fdnJobNo,
    fdnLinkedJobName: opts.fdnJobName === undefined ? "" : opts.fdnJobName,
    val(id){ return sandbox.__fields[id] || ""; },
    document: {
      getElementById(id){ return id === "wo-leaknojob-banner" ? banner : null; },
      addEventListener(){}
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(between(workordersSource, "var LEAK_NO_JOB_RE", "/* ================= shared roof-type list"), sandbox);
  return sandbox;
}

test("isLeakNoJobName matches the catch-all spellings techs actually produce", () => {
  const sb = makeSandbox();
  ["Leak - No Job", "Leak – No Job", "Leak — No Job", "LEAK NO JOB", "leak-no job", "Leak / No Job"]
    .forEach(function(n){ assert.ok(sb.isLeakNoJobName(n), "should match: " + n); });
});

test("isLeakNoJobName does not fire on ordinary leak jobs", () => {
  const sb = makeSandbox();
  ["Leaky Roof Job", "Leak at 12 Nojob St", "Leak repair — North Job Site", "No Job", "Leak Repair 16153", ""]
    .forEach(function(n){ assert.ok(!sb.isLeakNoJobName(n), "must not match: " + n); });
});

test("order rides the catch-all Foundation job -> flagged", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.isLeakNoJobOrder({ foundationJobName: "Leak - No Job", foundationJobNo: "99001" }), true);
});

test("real Foundation job linked -> reconciled, even if the visible name still says Leak - No Job", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.isLeakNoJobOrder({
    jobName: "Leak - No Job", foundationJobNo: "16153", foundationJobName: "North Warehouse Reroof"
  }), false);
});

test("catch-all job name with no Foundation link -> flagged", () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.isLeakNoJobOrder({ jobName: "Leak – No Job" }), true);
  assert.strictEqual(sb.isLeakNoJobOrder({ jobName: "North Warehouse" }), false);
});

test("leakNoJobEmailNote: note for a flagged order, empty string otherwise", () => {
  const sb = makeSandbox();
  const note = sb.leakNoJobEmailNote({ jobName: "Leak - No Job" });
  assert.match(note, /LEAK – NO JOB TICKET/);
  assert.match(note, /create the job\/work order in Foundation/);
  assert.strictEqual(sb.leakNoJobEmailNote({ jobName: "North Warehouse" }), "");
});

test("renderLeakNoJobBadge shows/hides the form banner off live field + link state", () => {
  const shown = makeSandbox({ fields: { jobName: "Leak - No Job" } });
  shown.renderLeakNoJobBadge();
  assert.strictEqual(shown.__banner.style.display, "");
  const reconciled = makeSandbox({
    fields: { jobName: "Leak - No Job" }, fdnJobNo: "16153", fdnJobName: "North Warehouse Reroof"
  });
  reconciled.renderLeakNoJobBadge();
  assert.strictEqual(reconciled.__banner.style.display, "none");
});

/* Shape guards: the note and default-recipient wiring stay in the send
   paths they were reviewed into. */
test("sendEmailNow and sharePdf insert the note into the outgoing email body", () => {
  const send = between(historySource, "async function sendEmailNow", "async function sharePdf");
  assert.match(send, /leakNoJobEmailNote\(o\)/);
  assert.match(send, /njNote \? "\\n\\n" \+ njNote : ""/);
  const share = historySource.slice(historySource.indexOf("async function sharePdf")); /* last fn in the file */
  assert.ok(share.length > 0, "sharePdf missing");
  assert.match(share, /leakNoJobEmailNote\(o\)/);
});

test("emailDoc (mailto path) prepends the note; renderDoc defaults a flagged order to Charlotte", () => {
  assert.match(between(exportSource, "async function emailDoc", "function copyDoc"), /leakNoJobEmailNote/);
  const rd = between(exportSource, "function renderDoc", "function reportDistinctRoofIds");
  assert.match(rd, /isLeakNoJobOrder\(o\)/);
  assert.match(rd, /EMAIL_DEFAULT_TO_LEAK/);
});

test("Saved list renders the No-Job chip off the entry's job name", () => {
  assert.match(between(coreSource, "function drawSaved", "function renderSaved"), /isLeakNoJobName\(e\.jobName\)/);
});
