const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* A way back from Preview (feedback report fb_ms7owm7pdbc5a).

   The report: once you are on the Report Preview screen there is no way to go
   back and edit. Strictly speaking the header's "Edit" tab always went back --
   but on a phone that tab is an unlabelled icon inside a horizontally
   scrolling header that collapses out of view on scroll-down
   (`.header-collapsed`, css/app.css), and the preview document is long. In the
   field that is indistinguishable from having no back button.

   What is pinned here:
     1. An explicit back control exists inside the preview view, BEFORE the
        document and again AFTER it -- the second one is the whole point on a
        phone, where scrolling back up a 20-photo report to find a control is
        the thing that made this feel like a dead end.
     2. Neither control prints (they are chrome, not report content).
     3. backToEdit() only navigates -- it must never save, clear, reload or
        otherwise touch the order, because the promise being made to the tech
        is "go back, edit, come back, nothing is lost".
     4. The form scroll position survives the round trip, and Preview's own
        scroll position can never overwrite it. */

const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notEqual(a, -1, "missing start marker: " + start);
  assert.notEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const previewView = between(indexSource, '<div id="view-preview"', "<!-- ================= SAVED VIEW");
const backBlock = between(exportSource, "/* Where the tech was in the form", "async function goToPreview(){");

/* ---------- the control exists, top and bottom, and never prints ---------- */

test("the preview view carries a back-to-edit control above and below the document", () => {
  const docAt = previewView.indexOf('id="doc-output"');
  assert.notEqual(docAt, -1, "preview view no longer contains #doc-output");

  const hits = [];
  let at = previewView.indexOf("backToEdit()");
  while (at !== -1){ hits.push(at); at = previewView.indexOf("backToEdit()", at + 1); }

  assert.equal(hits.length, 2, "expected exactly two back-to-edit controls in the preview view");
  assert.ok(hits[0] < docAt, "a back control must sit above the report document");
  assert.ok(hits[1] > docAt, "a back control must sit below the report document -- a long report on a phone must not have to be scrolled back up");
});

test("both back controls are labelled, tappable buttons -- not bare links", () => {
  const buttons = previewView.match(/<button[^>]*backToEdit\(\)[^>]*>[^<]*<\/button>/g) || [];
  assert.equal(buttons.length, 2);
  buttons.forEach(function(html){
    assert.match(html, /class="btn"/, "must use the shared .btn style: " + html);
    assert.match(html, /Back to Edit</, "label must say where it goes: " + html);
    assert.match(html, /title="[^"]+"/, "needs a tooltip, per the docs-with-every-feature practice: " + html);
  });
});

test("neither back control lands in the printed report", () => {
  /* .no-print is display:none !important in the print block of css/app.css.
     The class has to be on the row that wraps the button. */
  ["preview-back-top", "preview-back-bottom"].forEach(function(id){
    const openTag = (previewView.match(new RegExp('<div[^>]*id="' + id + '"[^>]*>')) || [])[0];
    assert.ok(openTag, "no row with id " + id);
    assert.match(openTag, /class="[^"]*\bno-print\b/, id + " must be no-print");
    const row = between(previewView, 'id="' + id + '"', "</div>");
    assert.ok(row.indexOf("backToEdit()") !== -1, id + " must hold a back control");
  });

  const printBlock = fs.readFileSync(path.join(__dirname, "..", "css", "app.css"), "utf8");
  assert.match(printBlock, /@media print[\s\S]{0,400}\.no-print[^}]*display:\s*none/,
    "no-print stopped meaning 'hidden when printing' -- these rows relied on it");
});

/* ---------- behaviour ---------- */

function makeCtx(opts){
  opts = opts || {};
  const calls = { showView: [], scrollTo: [], forbidden: [] };
  const editView = { style: { display: opts.editVisible === false ? "none" : "" } };
  const forbid = function(name){ return function(){ calls.forbidden.push(name); }; };
  const ctx = {
    console,
    calls,
    document: {
      getElementById(id){ return id === "view-edit" ? editView : null; }
    },
    window: {
      scrollY: opts.scrollY === undefined ? 0 : opts.scrollY,
      scrollTo(x, y){ calls.scrollTo.push([x, y]); }
    },
    showView(v){ calls.showView.push(v); },
    /* Anything that would mutate or drop the order. None of these may fire. */
    saveOrder: forbid("saveOrder"),
    newOrder: forbid("newOrder"),
    loadOrder: forbid("loadOrder"),
    collect: forbid("collect"),
    fill: forbid("fill"),
    resetForm: forbid("resetForm"),
    renderDoc: forbid("renderDoc")
  };
  vm.createContext(ctx);
  vm.runInContext(backBlock, ctx);
  return ctx;
}

test("backToEdit returns to the form and touches nothing else", () => {
  const ctx = makeCtx();
  ctx.backToEdit();
  assert.deepEqual(ctx.calls.showView, ["edit"]);
  assert.deepEqual(ctx.calls.forbidden, [],
    "backToEdit must only navigate -- the form's DOM is the live copy of the work, and saving/reloading it here is how a 'back' button starts losing edits");
});

test("the round trip puts the tech back where they were in the form", () => {
  const ctx = makeCtx({ scrollY: 1840 });
  ctx.rememberEditScrollForPreview();       /* leaving the form for Preview */
  ctx.window.scrollY = 320;                 /* now scrolled inside Preview */
  ctx.backToEdit();
  assert.deepEqual(ctx.calls.scrollTo, [[0, 1840]],
    "should restore the form position, not the top and not Preview's position");
});

test("re-tapping Preview while already on Preview cannot overwrite the remembered position", () => {
  const ctx = makeCtx({ scrollY: 1840 });
  ctx.rememberEditScrollForPreview();
  /* The header Preview tab is live on the Preview screen too, and it runs
     goToPreview() again. The edit view is hidden by then. */
  ctx.window.scrollY = 990;
  ctx.document.getElementById("view-edit").style.display = "none";
  ctx.rememberEditScrollForPreview();
  ctx.backToEdit();
  assert.deepEqual(ctx.calls.scrollTo, [[0, 1840]]);
});

test("a fresh session with no remembered position lands at the top, not undefined", () => {
  const ctx = makeCtx();
  ctx.backToEdit();
  assert.deepEqual(ctx.calls.scrollTo, [[0, 0]]);
});

test("goToPreview remembers the form position before anything can await", () => {
  const body = between(exportSource, "async function goToPreview(){", "function renderDoc(");
  const firstLine = body.split("\n")[1].trim();
  assert.equal(firstLine, "rememberEditScrollForPreview();",
    "must be the first statement -- ensurePhotosLoadedForExport() can alert() and await, and showView('preview') hides the form");
});
