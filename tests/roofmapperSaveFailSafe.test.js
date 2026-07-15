/* Roof-outline save fail-safe (data-loss guard).

   Mark lost a traced outline on a live production roof: the save to the
   building failed on weak signal and the trace was dropped with only a
   transient toast. These tests pin down the guarantee that replaced that
   behavior -- a failed save NEVER loses the trace, says so persistently, and
   finishes the job by itself once signal returns without ever double-saving.

   Same vm-sandbox pattern as the other browser-module tests here: slice the
   relevant functions out of js/roofmapper.js and run them against stubs,
   rather than booting the whole browser file. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "roofmapper.js"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* The real localStorage key, lifted from the source rather than restated here,
   so this test can never drift from the store the app actually writes to. */
const RM_LOCAL_KEY_DECL = source.match(/var RM_LOCAL_KEY = "[^"]+";/);
assert.ok(RM_LOCAL_KEY_DECL, "missing RM_LOCAL_KEY declaration");

/* The local store + the whole fail-safe engine, then the local-saves panel,
   then the building-save path itself. Stops short of the top-level event
   listeners/setInterval (not under test; they just call the flush). */
const CODE = [
  RM_LOCAL_KEY_DECL[0],
  between("/* ---- save locally (localStorage fallback", "/* Same triggers the work-order queue already uses"),
  between("function rmSaveLocally(){", "/* Mobile: auto-hide the header on scroll"),
  between("function rmConfirmSiteBoundarySave(){", '/* THE fix for "RoofMapper can')
].join("\n");

function makeSandbox(opts){
  opts = opts || {};
  const store = new Map();
  const els = new Map();
  const toasts = [];
  const alerts = [];
  /* The building doc, as Firestore would hand it back. */
  const building = opts.building || {
    name: "St. Joseph's Hospital",
    roofs: [{ id: "roof_a", label: "Roof 1", roof_outlines: [] }]
  };
  const saved = { calls: 0, lastRoofs: null };

  function el(){
    return { style: {}, innerHTML: "", textContent: "", scrollIntoView(){} };
  }

  const sandbox = {
    /* --- platform --- */
    localStorage: {
      getItem(k){ return store.has(k) ? store.get(k) : null; },
      setItem(k, v){ store.set(k, String(v)); },
      removeItem(k){ store.delete(k); }
    },
    navigator: { onLine: opts.online !== false },
    document: {
      readyState: "complete",
      getElementById(id){
        if (!els.has(id)) els.set(id, el());
        return els.get(id);
      },
      addEventListener(){}
    },
    window: { addEventListener(){} },
    console: { warn(){}, error(){} },
    alert(msg){ alerts.push(msg); },
    confirm(){ return true; },
    setTimeout(fn){ return 0; },

    /* --- app globals --- */
    toast(msg){ toasts.push(msg); },
    esc(s){ return String(s == null ? "" : s); },
    genId(prefix){ sandbox.__idSeq = (sandbox.__idSeq || 0) + 1; return prefix + "_" + sandbox.__idSeq; },
    getBuildingRoofs(bld){ return JSON.parse(JSON.stringify(bld.roofs || [])); },
    /* THE network write. Throws when we're simulating a failed save. */
    async saveBuildingRoofs(buildingId, roofs){
      saved.calls++;
      if (sandbox.__failWrite) throw new Error("Failed to get document because the client is offline.");
      building.roofs = JSON.parse(JSON.stringify(roofs));
      saved.lastRoofs = building.roofs;
    },
    fdb: {
      collection(){
        return { doc(){ return { get: async () => {
          if (sandbox.__failRead) throw new Error("Failed to get document because the client is offline.");
          return { exists: true, data: () => JSON.parse(JSON.stringify(building)) };
        } }; } };
      }
    },

    /* --- RoofMapper state + the collaborators the save path calls --- */
    rmState: {
      outline: null,
      map: null, /* no map in the harness: skips the label-marker branch */
      outlineLayer: null,
      orthoActive: false,
      kmlOverlayActive: false,
      linkedBuildingId: null,
      linkedRoofId: null,
      pendingBuildingId: null,
      pendingBuildingName: null
    },
    rmSplitState: { savingAll: false },
    rmRefreshOutlineMeasurementModel(){},
    closeRmSaveModal(){},
    rmClearSplitState(){},
    rmRenderRoofSwitcher(){},
    rmRenderExportRoofSelect(){},
    rmShowFeaturePanel(){},
    async rmLoadLinkedAssets(){},
    rmUpdateExportHint(){},
    rmUpdateControlVisibility(){},
    rmSetDisp(){},
    async rmEnsureSyntheticOrthoFrameForSave(){ return !sandbox.__refuseSyntheticFrame; },
    rmOutlineStorageFields(){ return {}; },
    rmPersistOrthoBaseMap(){},
    rmPersistKmlGroundOverlayBaseMap(){},
    rmCancelTrace(){},
    rmClearLinkedFeatures(){},
    rmDrawEdgeDimensions(){},
    rmRenderOutlineStats(){},
    rmOutlineTitle(o){ return o.label || "Outline"; },
    rmGeomRingCentroid(){ return { lat: 0, lng: 0 }; },
    roofLabelMarker(){ return { addTo(){ return {}; } }; },
    rmSaveRoofLabelPos(){},
    rmEnsureMap(){
      return { removeLayer(){}, fitBounds(){}, invalidateSize(){} };
    },
    L: { polygon(){ return { addTo(){ return { getBounds(){ return {}; } }; } }; } },

    /* --- harness handles --- */
    __failWrite: false,
    __failRead: false,
    __refuseSyntheticFrame: false,
    __store: store,
    __els: els,
    __toasts: toasts,
    __alerts: alerts,
    __building: building,
    __saved: saved
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return sandbox;
}

/* A traced outline, as rmState.outline looks when he taps Save. */
function anOutline(){
  return {
    ring: [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }],
    center: { lat: 1.5, lng: 1.5 },
    areaSqFt: 12450,
    source: "manual_trace",
    tags: {},
    edgeMeasurements: [],
    createdAt: Date.now()
  };
}

const LOCAL_KEY = "roofmapper-local-outlines-v1";
const PENDING_KEY = "roofmapper-pending-building-saves-v1";

function localOutlines(sb){ return JSON.parse(sb.__store.get(LOCAL_KEY) || "[]"); }
function pendingSaves(sb){ return JSON.parse(sb.__store.get(PENDING_KEY) || "{}"); }
function banner(sb){ return sb.__els.get("roof-sync-status-bar"); }

/* ---------------------------------------------------------------- *
 * 1. THE REGRESSION GUARD: a normal, successful save is unchanged.  *
 * ---------------------------------------------------------------- */
test("successful save writes the outline to the building and leaves no local copy", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();

  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  const outlines = sb.__building.roofs[0].roof_outlines;
  assert.strictEqual(outlines.length, 1, "outline is on the building");
  assert.strictEqual(sb.__saved.calls, 1, "wrote exactly once");

  /* No double-save: the normal path must not also drop a device copy. */
  assert.deepStrictEqual(localOutlines(sb), [], "no local copy on the happy path");
  assert.deepStrictEqual(pendingSaves(sb), {}, "nothing queued on the happy path");
  assert.strictEqual(banner(sb).style.display, "none", "no scary banner on the happy path");
  assert.ok(sb.__toasts.some(t => /saved/i.test(t)), "still confirms the save");
});

/* ---------------------------------------------------------------- *
 * 2. THE FIX: the exact failure that lost Mark's roof.              *
 * ---------------------------------------------------------------- */
test("failed save preserves the trace on the device, queues it, and shows a persistent notice", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true; /* the Firestore write rejects, exactly as it did on the roof */

  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  /* (a) the trace survives */
  const local = localOutlines(sb);
  assert.strictEqual(local.length, 1, "the outline was preserved on the device");
  assert.strictEqual(local[0].savedByFailSafe, true);
  assert.strictEqual(local[0].areaSqFt, 12450, "the actual traced geometry, not a stub");
  assert.strictEqual(local[0].ring.length, 3);
  assert.strictEqual(local[0].pendingBuildingName, "St. Joseph's Hospital");

  /* (b) it is queued to retry against the right building/roof */
  const q = pendingSaves(sb);
  const ids = Object.keys(q);
  assert.strictEqual(ids.length, 1, "queued for auto-retry");
  assert.strictEqual(q[ids[0]].buildingId, "bld_1");
  assert.strictEqual(q[ids[0]].roofId, "roof_a");

  /* (c) the notice is LOUD and STICKY -- not a toast that vanishes */
  const bar = banner(sb);
  assert.notStrictEqual(bar.style.display, "none", "the persistent banner is visible");
  assert.match(bar.innerHTML, /saved on THIS DEVICE/i);
  assert.match(bar.innerHTML, /don't re-trace it/i);

  /* (d) and nothing was written to the building */
  assert.strictEqual(sb.__building.roofs[0].roof_outlines.length, 0);
});

test("fail-safe also catches a failure in the initial building read", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failRead = true; /* dies before it ever gets an outline id */

  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  assert.strictEqual(localOutlines(sb).length, 1, "trace still preserved");
  assert.strictEqual(Object.keys(pendingSaves(sb)).length, 1, "still queued for retry");
});

test("reopened-roof read failure queues under a fail-safe id, not the saved outline id", async () => {
  const saved = Object.assign(anOutline(), { id: "rmo_saved", areaSqFt: 12450 });
  const sb = makeSandbox({
    building: { name: "Clinic", roofs: [{ id: "roof_a", label: "Roof 1", roof_outlines: [saved] }] }
  });
  sb.rmState.outline = Object.assign(anOutline(), { id: "rmo_saved", areaSqFt: 48000 });
  sb.__failRead = true; /* dies before rmSaveOutlineToBuilding can mint the normal fresh id */

  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  const queuedId = Object.keys(pendingSaves(sb))[0];
  assert.ok(queuedId, "queued for retry");
  assert.notStrictEqual(queuedId, "rmo_saved", "does not reuse the id already present on the building");
  assert.strictEqual(localOutlines(sb)[0].id, queuedId, "device copy uses the retry id");

  sb.__failRead = false;
  const writesBefore = sb.__saved.calls;
  await sb.rmFlushPendingBuildingSaves();

  const outlines = sb.__building.roofs[0].roof_outlines;
  assert.strictEqual(sb.__saved.calls, writesBefore + 1, "retry actually wrote the recovered trace");
  assert.strictEqual(outlines.length, 2, "re-trace lands as a new append-only outline");
  assert.strictEqual(outlines[1].id, queuedId);
  assert.strictEqual(outlines[1].areaSqFt, 48000);
  assert.deepStrictEqual(localOutlines(sb), [], "device copy retired only after the retry writes");
  assert.deepStrictEqual(pendingSaves(sb), {}, "queue entry retired");
});

test("synthetic-ortho save refusal preserves the trace on-device without auto-retry", async () => {
  const saved = Object.assign(anOutline(), { id: "rmo_saved", areaSqFt: 12450 });
  const sb = makeSandbox({
    building: { name: "Clinic", roofs: [{ id: "roof_a", label: "Roof 1", roof_outlines: [saved] }] }
  });
  sb.rmState.outline = Object.assign(anOutline(), { id: "rmo_saved", areaSqFt: 48000 });
  sb.__refuseSyntheticFrame = true;

  const result = await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  assert.strictEqual(result, false, "save is refused");
  assert.strictEqual(sb.__saved.calls, 0, "nothing inaccurate was written");
  assert.strictEqual(sb.__building.roofs[0].roof_outlines.length, 1, "existing building geometry is untouched");
  assert.strictEqual(sb.__building.roofs[0].roof_outlines[0].areaSqFt, 12450);

  const local = localOutlines(sb);
  assert.strictEqual(local.length, 1, "trace preserved on this device");
  assert.notStrictEqual(local[0].id, "rmo_saved", "device copy does not borrow the saved outline id");
  assert.strictEqual(local[0].areaSqFt, 48000);
  assert.strictEqual(local[0].failSafeReason, "synthetic-ortho-refused");
  assert.deepStrictEqual(pendingSaves(sb), {}, "policy refusal is device-only, not auto-retried");
  assert.ok(sb.__toasts.some(t => /Save refused/i.test(t)), "clear refusal message is shown");
});

/* ---------------------------------------------------------------- *
 * 3. THE RETRY: signal comes back, it finishes the job itself.      *
 * ---------------------------------------------------------------- */
test("queued outline is pushed to the building once signal returns, then cleaned up", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true;
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  const queuedId = Object.keys(pendingSaves(sb))[0];

  sb.__failWrite = false; /* signal is back */
  await sb.rmFlushPendingBuildingSaves();

  const outlines = sb.__building.roofs[0].roof_outlines;
  assert.strictEqual(outlines.length, 1, "the trace made it onto the building");
  assert.strictEqual(outlines[0].id, queuedId, "and it's the same outline, same id");
  assert.strictEqual(outlines[0].areaSqFt, 12450);

  /* Cleaned up on both sides, so it can't be saved a second time later. */
  assert.deepStrictEqual(pendingSaves(sb), {}, "queue entry retired");
  assert.deepStrictEqual(localOutlines(sb), [], "device copy retired");
  assert.strictEqual(banner(sb).style.display, "none", "banner cleared");
});

test("retry is idempotent: a write that actually landed is never appended twice", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true;
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  /* The flaky-link case: the write DID land server-side, but the response never
     came back, so it got queued anyway. Simulate by planting the outline on the
     building under the same id before the retry runs. */
  const queuedId = Object.keys(pendingSaves(sb))[0];
  sb.__building.roofs[0].roof_outlines = [Object.assign(anOutline(), { id: queuedId })];

  sb.__failWrite = false;
  const writesBefore = sb.__saved.calls;
  await sb.rmFlushPendingBuildingSaves();

  assert.strictEqual(sb.__building.roofs[0].roof_outlines.length, 1, "still exactly one copy");
  assert.strictEqual(sb.__saved.calls, writesBefore, "no redundant write at all");
  assert.deepStrictEqual(pendingSaves(sb), {}, "queue entry retired anyway");
});

test("a failing retry keeps the trace and counts the attempt, never dropping it", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true;
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  await sb.rmFlushPendingBuildingSaves(); /* still offline: fails again */

  const q = pendingSaves(sb);
  const ids = Object.keys(q);
  assert.strictEqual(ids.length, 1, "entry survives a failed retry (never silently dropped)");
  assert.strictEqual(q[ids[0]].attempts, 1, "attempt counted");
  assert.strictEqual(localOutlines(sb).length, 1, "trace still on the device");
  assert.notStrictEqual(banner(sb).style.display, "none", "notice still up");
});

/* ---------------------------------------------------------------- *
 * 4. THE MANUAL PATH: Load it from the panel, save it by hand.      *
 * ---------------------------------------------------------------- */
test("a device copy can be loaded and re-saved to the building, with no duplicate left behind", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true;
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  const savedId = localOutlines(sb)[0].id;

  /* He gets signal, opens "Saved On This Device", taps Load... */
  sb.rmState.outline = null;
  sb.rmLoadLocalOutline(savedId);
  assert.ok(sb.rmState.outline, "the outline is back on the map");
  assert.strictEqual(sb.rmState.outline.areaSqFt, 12450);
  assert.strictEqual(sb.rmState.outline.savedByFailSafe, undefined,
    "fail-safe bookkeeping is stripped, never written to Firestore");

  /* ...then Save Outline to Building. */
  sb.__failWrite = false;
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  assert.strictEqual(sb.__building.roofs[0].roof_outlines.length, 1, "on the building, exactly once");
  assert.deepStrictEqual(localOutlines(sb), [], "device copy retired -- no duplicate to re-save later");
  assert.deepStrictEqual(pendingSaves(sb), {}, "pending retry retired -- won't re-push it");
  assert.strictEqual(banner(sb).style.display, "none", "banner cleared");
});

test("an outline the user saved deliberately with Save-on-Device is never auto-deleted", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.rmSaveLocally(); /* his own explicit local save -- not a fail-safe copy */
  assert.strictEqual(localOutlines(sb).length, 1);

  const id = localOutlines(sb)[0].id;
  sb.rmLoadLocalOutline(id);
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  assert.strictEqual(sb.__building.roofs[0].roof_outlines.length, 1, "saved to the building");
  assert.strictEqual(localOutlines(sb).length, 1, "his own device copy is left alone (his to delete)");
});

/* ---------------------------------------------------------------- *
 * 5. NO BUILDING AT ALL (building creation itself failed).          *
 * ---------------------------------------------------------------- */
test("device-only fallback (no building yet) still preserves the trace and says what to do", () => {
  const sb = makeSandbox();
  const outline = anOutline();

  sb.rmFailSafeSaveOutline(outline, { reason: "no-building", error: new Error("need internet connection") });

  const local = localOutlines(sb);
  assert.strictEqual(local.length, 1, "trace preserved");
  assert.strictEqual(local[0].pendingBuildingId, null);
  assert.deepStrictEqual(pendingSaves(sb), {}, "nothing to auto-retry against -- correctly not queued");

  const bar = banner(sb);
  assert.notStrictEqual(bar.style.display, "none");
  assert.match(bar.innerHTML, /THIS DEVICE only/i);
  assert.match(bar.innerHTML, /Save Outline to Building/i);
});

test("manual re-save of a pending trace whose write actually landed doesn't duplicate it", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true;
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  /* The write DID land server-side; only the response was lost. */
  const pendingId = Object.keys(pendingSaves(sb))[0];
  sb.__building.roofs[0].roof_outlines = [Object.assign(anOutline(), { id: pendingId })];

  /* He doesn't know that, so he loads the device copy and saves it by hand. */
  sb.__failWrite = false;
  sb.rmLoadLocalOutline(pendingId);
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  assert.strictEqual(sb.__building.roofs[0].roof_outlines.length, 1,
    "the roof appears on the building exactly once, not twice");
  assert.deepStrictEqual(localOutlines(sb), []);
  assert.deepStrictEqual(pendingSaves(sb), {});
});

test("repeated failures update the one device copy instead of stacking duplicates", async () => {
  const sb = makeSandbox();
  sb.rmState.outline = anOutline();
  sb.__failWrite = true;

  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");
  await sb.rmSaveOutlineToBuilding("bld_1", "roof_a");

  assert.strictEqual(localOutlines(sb).length, 1, "one trace, one device copy");
  assert.strictEqual(Object.keys(pendingSaves(sb)).length, 1, "one trace, one queue entry");
});
