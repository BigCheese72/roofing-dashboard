/* Email send confirmation — the durable, unmissable "did it actually send?"
   feature (Mark: the sent confirmation was too easy to miss, and a FAILED
   send must never look like a success). Covers, without a browser or network:
     - the shared toast() severity variants (success/error louder + longer),
     - email address -> friendly name mapping ("Charlotte Washburn"),
     - the Saved-list emailedMarker() green-vs-red rendering,
     - recordEmailAttempt persistence for a CONFIRMED-SENT case AND a
       SIMULATED-FAILURE case, incl. the send log and the failure-overrides-
       success badge flip,
     - and source wiring guards on sendEmailNow / renderDoc / HTML / CSS.
   Pure source-slice + vm sandbox, same approach as autoSaveAbortReason.test.js. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSrc = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const historySrc = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const exportSrc = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(__dirname, "..", "css", "app.css"), "utf8");

function extractFn(source, signature){
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, "missing function: " + signature);
  let i = source.indexOf("{", start), depth = 0;
  for (; i < source.length; i++){
    if (source[i] === "{") depth++;
    else if (source[i] === "}"){ depth--; if (depth === 0){ i++; break; } }
  }
  return source.slice(start, i);
}
function extractVar(source, name){
  const start = source.indexOf("var " + name);
  assert.notStrictEqual(start, -1, "missing var: " + name);
  const end = source.indexOf("};", start);
  assert.notStrictEqual(end, -1);
  return source.slice(start, end + 2);
}

function makeEl(){
  return { textContent: "", className: "", innerHTML: "", style: {}, _attrs: {},
    setAttribute(k, v){ this._attrs[k] = v; }, getAttribute(k){ return this._attrs[k]; } };
}

function buildSandbox(){
  const els = {};
  const db = { index: [], orders: {} };
  const calls = { lastDelay: null, drawSaved: 0, saveDb: 0 };
  const sandbox = {
    console,
    toastTimer: undefined,
    setTimeout(fn, ms){ calls.lastDelay = ms; return 1; },
    clearTimeout(){},
    document: { getElementById(id){ return els[id] || (els[id] = makeEl()); } },
    esc(s){ return s == null ? "" : String(s); },
    // Stubbed recipient book: exactly the shape getEmailRecipients() returns.
    getEmailRecipients(){
      return [
        { email: "charlottew@watkinsroofing.net", label: "Charlotte Washburn" },
        { email: "marks@watkinsroofing.net", label: "Mark Sheppard <marks@watkinsroofing.net>" }
      ];
    },
    loadDb(){ return db; },
    saveDb(){ calls.saveDb++; },
    cloudIndexCache: [],
    fdb: null,               // no cloud path in-test -> deterministic
    drawSaved(){ calls.drawSaved++; }
  };
  const code = [
    extractVar(coreSrc, "TOAST_DURATIONS"),
    extractFn(coreSrc, "function toast(msg, kind)"),
    extractFn(coreSrc, "function emailLabelFor(addr)"),
    extractFn(coreSrc, "function emailNamesFor(addrs)"),
    extractFn(coreSrc, "function parseEmailRecipients(raw)"),
    extractFn(coreSrc, "function emailedMarker(e)"),
    extractFn(historySrc, "function fmtTs(ms)"),
    extractFn(historySrc, "function appendEmailLog(existing, entry)"),
    extractFn(historySrc, "async function recordEmailAttempt(workOrderId, log)"),
    extractFn(historySrc, "async function markWorkOrderEmailed(workOrderId, addrs)"),
    extractFn(historySrc, "async function markWorkOrderEmailFailed(workOrderId, addrs, message)"),
    extractFn(historySrc, "function emailStatusStateFor(workOrderId)"),
    extractFn(historySrc, "function renderEmailStatus(workOrderId)")
  ].join("\n");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, els, db, calls };
}

/* ---------------------------- the toast ---------------------------------- */
test("toast(): a plain message is unchanged (neutral, 3.5s) — back-compatible", () => {
  const { sandbox, els, calls } = buildSandbox();
  sandbox.toast("Saving…");
  assert.strictEqual(els.toast.className, "toast toast-info");
  assert.strictEqual(els.toast.style.display, "block");
  assert.strictEqual(calls.lastDelay, 3500);
  assert.strictEqual(els.toast.getAttribute("aria-live"), "polite");
});
test("toast(): success is green, longer-lived (6.5s), politely announced", () => {
  const { sandbox, els, calls } = buildSandbox();
  sandbox.toast("Email sent to Charlotte Washburn", "success");
  assert.strictEqual(els.toast.className, "toast toast-success");
  assert.strictEqual(calls.lastDelay, 6500);
});
test("toast(): a FAILURE is red, sticky (12s), and assertively announced — cannot look like a success", () => {
  const { sandbox, els, calls } = buildSandbox();
  sandbox.toast("Send FAILED", "error");
  assert.strictEqual(els.toast.className, "toast toast-error");
  assert.strictEqual(calls.lastDelay, 12000);
  assert.strictEqual(els.toast.getAttribute("aria-live"), "assertive");
});

/* --------------------- address -> friendly name -------------------------- */
test("emailLabelFor/emailNamesFor: an address resolves to a person's name", () => {
  const { sandbox } = buildSandbox();
  assert.strictEqual(sandbox.emailLabelFor("charlottew@watkinsroofing.net"), "Charlotte Washburn");
  assert.strictEqual(sandbox.emailLabelFor("marks@watkinsroofing.net"), "Mark Sheppard"); // strips <email>
  assert.strictEqual(sandbox.emailLabelFor("someone@elsewhere.com"), "someone");           // local-part fallback
  assert.strictEqual(sandbox.emailNamesFor(["charlottew@watkinsroofing.net"]), "Charlotte Washburn");
});

/* --------------------- Saved-list marker (glanceable) -------------------- */
test("emailedMarker(): a sent order shows a green 'Emailed to <name>' chip with the time", () => {
  const { sandbox } = buildSandbox();
  const html = sandbox.emailedMarker({ lastEmailedAt: 1000, lastEmailedTo: ["charlottew@watkinsroofing.net"] });
  assert.match(html, /Emailed to Charlotte Washburn/);
  assert.match(html, /#0F5A28/);            // green
  assert.doesNotMatch(html, /FAILED/);
});
test("emailedMarker(): a failed last attempt shows a clearly-different red FAILED chip", () => {
  const { sandbox } = buildSandbox();
  const html = sandbox.emailedMarker({ lastEmailError: { at: 2000, message: "boom" } });
  assert.match(html, /Email FAILED/);
  assert.match(html, /#7E1329/);            // red
});
test("emailedMarker(): a failure NEWER than the last success wins — no stale green", () => {
  const { sandbox } = buildSandbox();
  const html = sandbox.emailedMarker({
    lastEmailedAt: 1000, lastEmailedTo: ["charlottew@watkinsroofing.net"],
    lastEmailError: { at: 2000, message: "502" }
  });
  assert.match(html, /Email FAILED/);
  assert.doesNotMatch(html, /Emailed to Charlotte/);
});

/* ===================== CONFIRMED-SENT case ============================== */
test("CONFIRMED SENT: markWorkOrderEmailed persists recipient + time + log, paints the green badge", async () => {
  const { sandbox, els, db, calls } = buildSandbox();
  db.index.push({ id: "wo1", jobName: "915 Richmond" });

  await sandbox.markWorkOrderEmailed("wo1", ["charlottew@watkinsroofing.net"]);

  const e = db.index.find(x => x.id === "wo1");
  assert.ok(e.lastEmailedAt > 0, "a send time is recorded on the record");
  assert.deepStrictEqual(e.lastEmailedTo, ["charlottew@watkinsroofing.net"]);
  assert.strictEqual(e.lastEmailError, null, "a success clears any prior failure");
  assert.strictEqual(e.emailLog.length, 1);
  assert.strictEqual(e.emailLog[0].ok, true);
  assert.ok(calls.saveDb >= 1 && calls.drawSaved >= 1, "it persists locally and refreshes the Saved list");
  // Preview badge painted green with the recipient's name.
  assert.match(els["email-status"].className, /es-ok/);
  assert.match(els["email-status"].innerHTML, /Emailed to Charlotte Washburn/);
  assert.strictEqual(els["email-status"].style.display, "flex");
});

/* ===================== SIMULATED-FAILURE case ========================== */
test("SIMULATED FAILURE: markWorkOrderEmailFailed records the error and paints the red badge", async () => {
  const { sandbox, els, db } = buildSandbox();
  db.index.push({ id: "wo1", jobName: "915 Richmond" });

  await sandbox.markWorkOrderEmailFailed("wo1", ["charlottew@watkinsroofing.net"],
    "Email service rejected it: 502");

  const e = db.index.find(x => x.id === "wo1");
  assert.ok(e.lastEmailError, "the failure is recorded durably on the record");
  assert.match(e.lastEmailError.message, /502/);
  assert.strictEqual(e.emailLog.length, 1);
  assert.strictEqual(e.emailLog[0].ok, false);
  assert.match(els["email-status"].className, /es-fail/);
  assert.match(els["email-status"].innerHTML, /Last send FAILED/);
});

test("a FAILURE after a SUCCESS flips the record from sent to failed — no silent success", async () => {
  const { sandbox, els, db } = buildSandbox();
  db.index.push({ id: "wo1" });
  await sandbox.markWorkOrderEmailed("wo1", ["charlottew@watkinsroofing.net"]);
  await sandbox.markWorkOrderEmailFailed("wo1", ["charlottew@watkinsroofing.net"], "network down");

  const e = db.index.find(x => x.id === "wo1");
  assert.strictEqual(e.emailLog.length, 2, "both attempts are in the send log");
  assert.match(els["email-status"].className, /es-fail/, "the badge now reads FAILED, not sent");
});

test("the send log is lightweight — capped at the last 20 attempts", async () => {
  const { sandbox, db } = buildSandbox();
  db.index.push({ id: "wo1" });
  for (let i = 0; i < 25; i++){
    await sandbox.markWorkOrderEmailed("wo1", ["charlottew@watkinsroofing.net"]);
  }
  assert.strictEqual(db.index.find(x => x.id === "wo1").emailLog.length, 20);
});

test("renderEmailStatus(): a never-emailed order shows nothing (badge stays hidden)", () => {
  const { sandbox, els } = buildSandbox();
  sandbox.renderEmailStatus("nope");
  assert.strictEqual(els["email-status"].style.display, "none");
});

/* ------------------------- source wiring guards -------------------------- */
test("wiring: sendEmailNow marks + loudly toasts BOTH success and failure, on BOTH paths", () => {
  const send = extractFn(historySrc, "async function sendEmailNow()");
  // success
  assert.match(send, /markWorkOrderEmailed\(o\.id, addrs\)/);
  assert.match(send, /emailNamesFor\(addrs\), "success"\)/);
  // http-error failure
  assert.match(send, /markWorkOrderEmailFailed\(o\.id, addrs, failMsg\)/);
  assert.match(send, /\+ failMsg, "error"\)/);
  // network-error failure (the catch)
  assert.match(send, /markWorkOrderEmailFailed\(o\.id, addrs, "Couldn't reach the send service \(offline or blocked\)\."\)/);
  // the CompanyCam-linked branch no longer swallows the success confirmation
  assert.match(send, /every successful send, linked or not/);
  // existing guarantees preserved (don't regress leakNoJobFlag / summaryPersistence)
  assert.match(send, /leakNoJobEmailNote\(o\)/);
  assert.match(send, /autoSaveBeforeReport\("sending email"\)/);
});
test("wiring: the Preview render paints the durable badge from the record", () => {
  const rd = extractFn(exportSrc, "function renderDoc()");
  assert.match(rd, /renderEmailStatus\(/);
});
test("wiring: the HTML has the badge holder and an accessible, dismissable toast", () => {
  assert.match(indexHtml, /id="email-status"/);
  assert.match(indexHtml, /id="toast"[^>]*aria-live="polite"/);
  assert.match(indexHtml, /onclick="this\.style\.display='none'"/);
});
test("wiring: the CSS defines distinct success/error toasts and ok/fail badges", () => {
  assert.match(cssSrc, /\.toast\.toast-success/);
  assert.match(cssSrc, /\.toast\.toast-error/);
  assert.match(cssSrc, /\.email-status\.es-ok/);
  assert.match(cssSrc, /\.email-status\.es-fail/);
});
