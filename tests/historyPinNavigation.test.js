const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Read-only history pins must be navigable (Mark, KOMU leak 2026-07-19).

   A pin on the inline Building History map showed the finding text and the
   right job number, but tapping it did nothing. The "View Work Order" button
   already existed -- the read-only branch returned before reaching it, with
   p.work_order_id sitting unused beside the job number the tech could see.

   The rule these tests pin down: READ-ONLY means the pin can't be EDITED, not
   that it can't be NAVIGATED FROM. Navigation is read-only by definition. */

const source = fs.readFileSync(path.join(__dirname, "..", "js", "buildinghistory.js"), "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");

function between(src, start, end){
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start: " + start);
  assert.notStrictEqual(b, -1, "missing end: " + end);
  return src.slice(a, b);
}

function popup(p, opts){
  const sb = {
    esc: s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"),
    warrantyColor: () => "#000"
  };
  vm.createContext(sb);
  vm.runInContext(between(source, "function pinPopupHtml", "function assetPopupReadonlyHtml"), sb);
  return sb.pinPopupHtml(p, opts);
}

const PIN = {
  work_order_id: "wo_komu_1", work_order_no: "17488", finding_id: "fnd_1",
  condition: "bad weather stripping on RTU door", warranty: "Non-warrantable",
  eventDate: "2026-07-19"
};

test("a read-only pin offers a route to the work order it came from", () => {
  const html = popup(PIN, { readOnly: true });
  assert.match(html, /loadOrder\('wo_komu_1'\)/, "the pin must reach its source record");
  assert.match(html, /View Work Order/);
});

test("a read-only pin still refuses to EDIT the pin", () => {
  /* The distinction that matters: navigate yes, mutate no. */
  const html = popup(PIN, { readOnly: true });
  assert.doesNotMatch(html, /jumpToAdjustPin/, "Adjust Pin mutates and must stay withheld");
  assert.match(html, /Read-only history pin/, "still labelled read-only");
});

test("the editable pin keeps BOTH actions, unchanged", () => {
  const html = popup(PIN, {});
  assert.match(html, /loadOrder\('wo_komu_1'\)/);
  assert.match(html, /jumpToAdjustPin\('wo_komu_1','fnd_1'\)/);
});

test("a pin with no source work order shows no dead button", () => {
  /* A legacy pin predating work_order_id must not render a button that
     navigates to undefined -- worse than no button. */
  const html = popup({ condition: "old pin", warranty: "" }, { readOnly: true });
  assert.doesNotMatch(html, /View Work Order/);
  assert.match(html, /Read-only history pin/);
});

test("the finding text and job number still render", () => {
  /* What Mark could already see must not regress. */
  const html = popup(PIN, { readOnly: true });
  assert.match(html, /bad weather stripping on RTU door/);
  assert.match(html, /17488/);
});

test("navigating away from an in-progress report is guarded", () => {
  /* The inline card sits INSIDE an open work order, so loadOrder() discards
     the current form. The #171 wrapper is what makes this tap safe. */
  assert.match(workordersSource, /window\.loadOrder = function/);
  assert.match(workordersSource, /confirmLeaveUnclouded\("Open the other work order anyway\?"\)/);
});
