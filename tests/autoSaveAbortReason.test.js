/* Regression: when a report action (email/share/download) is blocked because
   the work order could not be safely saved, the ABORT toast must be
   SELF-CONTAINED — it must carry the underlying reason. Before the fix,
   saveOrder() toasted the reason and autoSaveBeforeReport() then immediately
   toasted "NOT sending email …" into the same single #toast element, clobbering
   the reason before it could be read (Mark: emailing an inspection, the message
   flashed and vanished). See autoSaveBeforeReport() in js/core.js. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");

function extractFn(source, signature){
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, "missing function: " + signature);
  // Walk braces from the first "{" after the signature to find the function end.
  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i++){
    if (source[i] === "{") depth++;
    else if (source[i] === "}"){ depth--; if (depth === 0){ i++; break; } }
  }
  return source.slice(start, i);
}

const autoSaveFnText = extractFn(coreSource, "async function autoSaveBeforeReport(actionLabel)");

function runAbort(saveResult, reasonToShow){
  const toasts = [];
  const sandbox = {
    lastSaveFailMsg: "",
    toast(msg){ toasts.push(msg); },
    // Stubbed saveOrder mimics core.js: on failure it sets lastSaveFailMsg
    // (as the real conflict / failed-local-write branches now do) and toasts it.
    async saveOrder(){
      if (!saveResult){
        sandbox.lastSaveFailMsg = reasonToShow;
        sandbox.toast(reasonToShow);
        return false;
      }
      return true;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(autoSaveFnText + "\nthis.__run = autoSaveBeforeReport;", sandbox);
  return sandbox.__run("sending email").then(function(ok){
    return { ok, toasts };
  });
}

test("blocked send: the abort toast contains the real save-failure reason", async () => {
  const reason = "This work order was updated on another device. Reopen it to get the latest version before saving.";
  const { ok, toasts } = await runAbort(false, reason);
  assert.strictEqual(ok, false, "must block the send");
  const abortToast = toasts[toasts.length - 1];
  assert.match(abortToast, /NOT sending email/, "abort toast should name the blocked action");
  assert.ok(abortToast.includes(reason),
    "abort toast must embed the underlying reason so it isn't lost when it clobbers the prior toast");
});

test("successful save proceeds and shows no abort toast", async () => {
  const { ok, toasts } = await runAbort(true, "");
  assert.strictEqual(ok, true);
  assert.ok(!toasts.some(t => /NOT sending email/.test(t)), "no abort toast on success");
});
