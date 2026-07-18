const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Never lose edits on back-out (Mark, field use 2026-07-17: backed out of an
   edited, un-emailed report unsure whether it had survived).

   The trace behind these tests: backing out never actually lost anything --
   showView() is a pure show/hide and core.js already autosaves locally 4s
   after typing stops. The real gaps were (a) work that never reached the
   cloud produced NO unload warning, because core.js's beforeunload gates on
   the sync queue and the local autosave deliberately never enqueues; (b) the
   pending 4s debounce was flushed by nothing; (c) the one existing prompt
   used hasContent(), a has-any-content check, so it fired on clean orders and
   claimed work "will be lost" that autosave had in fact kept.

   What is pinned here is that shape: prompt ONLY for genuinely un-clouded
   work, flush everywhere else, and never nag on a plain view switch. */

const src = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const start = src.indexOf("/* ================= never lose edits on back-out");
assert.notEqual(start, -1, "back-out block not found in workorders.js");
const block = src.slice(start);

/* Build a fresh sandbox per test: stub DOM/listener surface plus the core.js
   globals this block layers on top of. */
function makeCtx(opts){
  opts = opts || {};
  const listeners = { window: {}, document: {} };
  const calls = { saves: [], confirms: [], coreShowView: [], coreLoadOrder: [] };
  const ctx = {
    console,
    Promise,
    clearTimeout,
    setTimeout,
    localAutosaveTimer: opts.pendingTimer === undefined ? null : opts.pendingTimer,
    currentId: opts.currentId === undefined ? "wo_1" : opts.currentId,
    editViewVisible: opts.editViewVisible === undefined ? true : opts.editViewVisible,
    woEditDirtyInit: false,
    WORK_ORDER_TYPE_LABELS: { "Leak / Service": "Leak Work Order" },
    hasContent: () => (opts.hasContent === undefined ? true : opts.hasContent),
    loadSyncQueue: () => opts.syncQueue || {},
    loadDb: () => ({ orders: opts.orders || {} }),
    saveOrder: (o) => { calls.saves.push(o); return Promise.resolve(opts.saveOk !== false); },
    showView: (v) => { calls.coreShowView.push(v); },
    loadOrder: (id) => { calls.coreLoadOrder.push(id); return "loaded"; },
    confirm: (msg) => { calls.confirms.push(msg); return opts.confirmAnswer !== false; },
    fill: () => {},
    todayStr: () => "1/1/26",
    toast: () => {},
    scheduleInlineBuildingHistoryRefresh: () => {},
    document: {
      getElementById: (id) => (id === "view-edit"
        ? { style: { display: (opts.editViewVisible === false ? "none" : "") },
            addEventListener: () => {} }
        : null),
      addEventListener: (ev, fn) => { (listeners.document[ev] = listeners.document[ev] || []).push(fn); },
      visibilityState: "visible"
    },
    window: {
      addEventListener: (ev, fn) => { (listeners.window[ev] = listeners.window[ev] || []).push(fn); }
    }
  };
  ctx.window.addEventListener = ctx.window.addEventListener.bind(ctx.window);
  vm.createContext(ctx);
  /* `window.x = ...` in the block must land on the same global the block
     reads back, mirroring a browser's window/global identity. */
  ctx.window.saveOrder = undefined;
  vm.runInContext(block, ctx);
  /* Apply the block's window.* reassignments onto the sandbox global. */
  ["saveOrder", "showView", "loadOrder"].forEach((k) => {
    if (ctx.window[k]) ctx[k] = ctx.window[k];
  });
  return { ctx, calls, listeners };
}

/* Objects built inside the vm context have that realm's Object.prototype,
   so deepStrictEqual rejects them on identity alone. Assert on the fields
   that matter instead. */
function assertLocalOnlySaves(saves, n, msg){
  assert.equal(saves.length, n, msg);
  saves.forEach((s) => {
    assert.equal(s.quiet, true);
    assert.equal(s.localOnly, true);
  });
}

function fire(listeners, target, ev, arg){
  (listeners[target][ev] || []).forEach((fn) => fn(arg));
}

test("an order that never reached the cloud counts as un-clouded work", () => {
  const { ctx } = makeCtx({ orders: { wo_1: { id: "wo_1" } } });   // no _cloudBaseSavedAt
  assert.equal(ctx.woEditHasUncloudedWork(), true);
});

test("an order already synced to the cloud with no new edits is clean", () => {
  const { ctx } = makeCtx({ orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } } });
  assert.equal(ctx.woEditHasUncloudedWork(), false);
});

test("a cloud-saved order with a queued (unsent) change is un-clouded", () => {
  const { ctx } = makeCtx({
    orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } },
    syncQueue: { wo_1: { jobLabel: "Flat Branch" } }
  });
  assert.equal(ctx.woEditHasUncloudedWork(), true);
});

test("an empty form is never treated as work at risk", () => {
  const { ctx } = makeCtx({ hasContent: false, orders: {} });
  assert.equal(ctx.woEditHasUncloudedWork(), false);
});

test("flushing cancels the pending 4s debounce and saves immediately, local-only", () => {
  const { ctx, calls } = makeCtx({ pendingTimer: 999 });
  ctx.flushWorkOrderAutosave();
  assert.equal(ctx.localAutosaveTimer, null, "pending autosave timer must be cleared, not raced");
  assertLocalOnlySaves(calls.saves, 1);
});

test("flushing does nothing when the edit view isn't showing", () => {
  const { ctx, calls } = makeCtx({ editViewVisible: false });
  ctx.flushWorkOrderAutosave();
  assert.equal(calls.saves.length, 0);
});

test("leaving the edit view flushes but never prompts", () => {
  const { ctx, calls } = makeCtx({ orders: {} });   // un-clouded work present
  ctx.showView("history");
  assertLocalOnlySaves(calls.saves, 1);
  assert.equal(calls.confirms.length, 0, "a plain tab switch must not nag — nothing is lost");
  assert.deepEqual(calls.coreShowView, ["history"]);
});

test("switching to the edit view does not trigger a save", () => {
  const { ctx, calls } = makeCtx({});
  ctx.showView("edit");
  assert.equal(calls.saves.length, 0);
});

test("beforeunload warns when work never reached the cloud", () => {
  const { ctx, listeners, calls } = makeCtx({ orders: {} });
  const e = { returnValue: undefined, prevented: false, preventDefault(){ this.prevented = true; } };
  fire(listeners, "window", "beforeunload", e);
  assert.equal(e.prevented, true, "this is the case core.js's queue-based check could never see");
  assert.equal(e.returnValue, "");
  assertLocalOnlySaves(calls.saves, 1, "flush first, then warn");
});

test("beforeunload stays silent once the work is safely in the cloud", () => {
  const { ctx, listeners } = makeCtx({ orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } } });
  const e = { returnValue: undefined, prevented: false, preventDefault(){ this.prevented = true; } };
  fire(listeners, "window", "beforeunload", e);
  assert.equal(e.prevented, false);
});

test("pagehide flushes (phone lock / tab close)", () => {
  const { listeners, calls } = makeCtx({});
  fire(listeners, "window", "pagehide");
  assertLocalOnlySaves(calls.saves, 1);
});

test("visibilitychange flushes only when actually hidden", () => {
  const { ctx, listeners, calls } = makeCtx({});
  fire(listeners, "document", "visibilitychange");
  assert.equal(calls.saves.length, 0, "still visible — nothing to flush for");
  ctx.document.visibilityState = "hidden";
  fire(listeners, "document", "visibilitychange");
  assertLocalOnlySaves(calls.saves, 1);
});

test("an explicit cloud Save clears dirty; a local autosave does not", async () => {
  const { ctx } = makeCtx({ orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } } });
  ctx.woEditDirty = true;
  await ctx.saveOrder({ quiet: true, localOnly: true });
  assert.equal(ctx.woEditDirty, true, "the autosave is exactly the state we're tracking — must not clear it");
  await ctx.saveOrder({});
  assert.equal(ctx.woEditDirty, false);
});

test("a failed explicit Save leaves the form dirty", async () => {
  const { ctx } = makeCtx({ saveOk: false, orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } } });
  ctx.woEditDirty = true;
  await ctx.saveOrder({});
  assert.equal(ctx.woEditDirty, true);
});

test("opening a different order prompts only for un-clouded work, and honours Cancel", () => {
  const declined = makeCtx({ orders: {}, confirmAnswer: false });
  declined.ctx.loadOrder("wo_other");
  assert.equal(declined.calls.confirms.length, 1);
  assert.equal(declined.calls.coreLoadOrder.length, 0, "Cancel must not discard the form");

  const accepted = makeCtx({ orders: {}, confirmAnswer: true });
  accepted.ctx.loadOrder("wo_other");
  assert.deepEqual(accepted.calls.coreLoadOrder, ["wo_other"]);
});

test("re-opening the order already on screen never prompts", () => {
  const { ctx, calls } = makeCtx({ orders: {} });   // un-clouded, but same id
  ctx.loadOrder("wo_1");
  assert.equal(calls.confirms.length, 0);
  assert.deepEqual(calls.coreLoadOrder, ["wo_1"]);
});

test("opening another order is silent once the current one is in the cloud", () => {
  const { ctx, calls } = makeCtx({ orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } } });
  ctx.loadOrder("wo_other");
  assert.equal(calls.confirms.length, 0, "no reason to interrupt — the work is safe");
  assert.deepEqual(calls.coreLoadOrder, ["wo_other"]);
});

test("the prompt tells the truth: device-local, not lost", () => {
  const { ctx, calls } = makeCtx({ orders: {}, confirmAnswer: false });
  ctx.confirmLeaveUnclouded("Start a new work order anyway?");
  const msg = calls.confirms[0];
  assert.match(msg, /saved on this device/i);
  assert.doesNotMatch(msg, /will be lost/i, "autosave means the old wording was simply untrue");
});

test("confirmLeaveUnclouded flushes before deciding", () => {
  const { ctx, calls } = makeCtx({ orders: { wo_1: { id: "wo_1", _cloudBaseSavedAt: 123 } } });
  assert.equal(ctx.confirmLeaveUnclouded("..."), true);
  assertLocalOnlySaves(calls.saves, 1, "even on the clean path the latest keystrokes must be persisted");
});
