#!/usr/bin/env node
// ============================================================================
// SEED THE DEV SANDBOX WITH REAL BUILDINGS FROM PRODUCTION
//
// WHAT THIS IS FOR
//   Dev (dev--leak-work-orders.netlify.app) has no buildings in it. That's
//   why Building History looks empty there -- there is nothing to render.
//   Production is fine. This script copies a few REAL buildings out of
//   production and into dev so you have something real to click around in:
//   the buildings themselves, their roofs, roof outlines and roof features,
//   the work orders filed against them, findings, pins, the building history
//   timeline, reports, the customers they belong to, and the photos.
//
//   It only ever READS from production. It only ever WRITES to dev.
//   It refuses to run at all if the two key files are swapped or wrong.
//
// EXACTLY WHAT TO RUN -- two commands.
//
//   1) See what it WOULD do. Writes nothing:
//
//      node tools/seed_dev_from_prod.js --prod-key <path-to-prod-key.json> --dev-key <path-to-dev-key.json> --dry-run
//
//   2) Read that output. If it looks right, do it for real:
//
//      node tools/seed_dev_from_prod.js --prod-key <path-to-prod-key.json> --dev-key <path-to-dev-key.json> --commit
//
//   Replace <path-to-prod-key.json> and <path-to-dev-key.json> with your two
//   Firebase service-account key files. This script takes those paths from
//   you at run time -- it never goes looking for them, never stores them,
//   never prints them.
//
//   Run it from the repo root (the folder with package.json in it), and run
//   `npm install` once first if you never have -- it needs firebase-admin.
//
// WHAT IT PICKS BY DEFAULT
//   Tri-Delta (your 11-roof building -- the multi-roof case that exercises
//   everything), plus up to 3 more real buildings chosen automatically to
//   make sure the seed includes at least one building WITH a base roof map
//   and at least one WITH a leak report -- the two things you need to test
//   ("the base roof map should show up in the leak investigation"). The dry
//   run tells you which ones it picked and whether that coverage was met.
//
//   To choose the buildings yourself instead:
//      --buildings="Tri-Delta,St Joe Hospital"   (comma separated, partial
//                                                 names are fine)
//      --list    just print every building name in production and stop.
//
// ABOUT PHOTOS -- READ THIS
//   Production keeps photo bytes in Cloud Storage. The dev Firebase project
//   is on the free Spark plan, and Cloud Storage needs Blaze, so the dev
//   project may have no Storage bucket at all (see "Dev Storage requires
//   Blaze" in DEV_NOTES.md).
//
//   This script checks, up front, whether dev has a working Storage bucket,
//   and tells you which mode it's in before it copies anything:
//
//     * STORAGE mode (dev bucket exists): photo bytes are copied into the dev
//       bucket at the same paths. Photos render in dev exactly like prod.
//
//     * INLINE mode (no dev bucket): photo bytes are written directly into the
//       dev Firestore photo documents as base64 -- the older format the app
//       still fully supports and renders. Photos still show up. Two honest
//       limits in this mode: a photo too large to fit in a Firestore document
//       (1MB) is skipped and named, and warranty-report PDFs (Storage-only)
//       can't come across. Everything you asked to test -- timeline, pins,
//       findings, base roof map in a leak investigation -- works either way.
//
//   The base roof map image itself is NOT in Firebase Storage at all -- it is
//   hosted by CompanyCam and referenced by URL (see rmPersistOrthoBaseMap() in
//   js/roofmapper.js), so it comes across with the building document and
//   renders in dev in both modes.
//
//   CompanyCam-sourced photos on a work order are fetched live from the
//   CompanyCam API. Those render in dev only if dev's Netlify site has the
//   CompanyCam API credentials set. Not something this script can copy.
//
// SAFE TO RUN TWICE. Every document is written by its own real id, so a
// re-run overwrites the same documents instead of duplicating anything.
//
// It also archives the two leftover dev test buildings
// (OFFLINE-LIVE-TEST-DELETE-ME, SYNTH-TEST-PHOTOBUG-DELETE-ME) so you don't
// have to click through a confirm dialog for them.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROD_PROJECT_ID = "watkins-service-orders";
const DEV_PROJECT_ID = "watkins-service-orders-dev";
// Same bucket names the app itself uses -- see FIREBASE_CONFIG_PROD /
// FIREBASE_CONFIG_DEV in js/core.js. Named explicitly rather than derived,
// because firebase-admin does not infer a default bucket on its own.
const PROD_BUCKET = PROD_PROJECT_ID + ".firebasestorage.app";
const DEV_BUCKET = DEV_PROJECT_ID + ".firebasestorage.app";

const DEV_SITE_URL = "https://dev--leak-work-orders.netlify.app";

// The multi-roof building the whole seed exists to give you. Always included
// when found; the rest are auto-picked around it for coverage.
const ANCHOR_BUILDING = "Tri-Delta";
const AUTO_PICK_LIMIT = 3; // additional buildings beyond the anchor

// Synthetic leftovers from testing -- archived (not deleted) on dev, exactly
// what the "Archive (admin)" button does, minus the confirm dialog.
const TEST_BUILDINGS_TO_ARCHIVE = ["OFFLINE-LIVE-TEST-DELETE-ME", "SYNTH-TEST-PHOTOBUG-DELETE-ME"];

// A Firestore document is capped at 1 MiB. Leave headroom for the rest of the
// photo doc (caption, thumb, gps, finding_id...) in INLINE mode.
const INLINE_PHOTO_BUDGET_BYTES = 900 * 1024;

// Accepts BOTH "--prod-key path/to/key.json" and "--prod-key=path/to/key.json".
// The space-separated form is the one the usage block above tells you to type,
// so it has to work -- an earlier version of this script only parsed the "="
// form and then aborted on its own documented command.
const args = (function () {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf("--") !== 0) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next && next.indexOf("--") !== 0) { out[name] = next; i++; }
    else out[name] = true;
  }
  return out;
})();
const COMMIT = args.commit === true;
const LIST_ONLY = args.list === true;
const EXPLICIT_BUILDINGS = String(args.buildings || "")
  .split(",").map(function (s) { return s.trim(); }).filter(Boolean);

function die(msg) {
  console.error("\nABORTED: " + msg + "\n");
  process.exit(1);
}
function requireArg(name) {
  if (!args[name] || args[name] === true) {
    die("missing required --" + name + " <path-to-key.json>. See the usage block at the top of this file.");
  }
  return String(args[name]);
}
function loadServiceAccount(keyPath, label) {
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) die(label + " service-account key not found at: " + resolved);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (e) {
    return die(label + " service-account key at " + resolved + " is not valid JSON.");
  }
  if (!json.project_id) die(label + " key has no project_id field -- that is not a Firebase service-account key.");
  return json; // never logged, never stored, never passed anywhere but initializeApp
}

// ---------------------------------------------------------------------------
// THE SAFETY MODEL (the most important part of this file)
//
// 1. Both key files are checked BEFORE anything is initialized. If the prod
//    key isn't prod's, or the dev key isn't dev's, the script exits. That
//    alone catches the one realistic disaster: swapping the two flags.
//
// 2. Production is never exposed as something writable. Reads from production
//    go through the prodGet*() helpers below, which return plain JavaScript
//    objects -- {id, data} -- and NEVER a Firestore reference. No production
//    document reference ever reaches the seeding code, so there is nothing
//    there to call .set() or .delete() on, even by accident.
//
// 3. Writes are only possible through devSet()/devCommit()/devUpload(), which
//    build their own references from the dev handle and call assertDevTarget()
//    first -- EVERY time, before every batch and every upload, not once at
//    startup. If the target is ever not the dev project, the process exits.
// ---------------------------------------------------------------------------
let prodApp = null, devApp = null;
let prodDb = null, devDb = null;
let prodBucket = null, devBucket = null;

function assertDevTarget() {
  if (!devApp || devApp === prodApp) die("dev app missing, or identical to the prod app. Refusing to write.");
  // Same firebase-admin quirk as Guard #2 in main(): options.projectId is
  // undefined for credential-only init; the real project is on
  // options.credential.projectId.
  const devProject = devApp.options.credential && devApp.options.credential.projectId;
  if (devProject !== DEV_PROJECT_ID) {
    die('write target is project "' + devProject + '", not "' + DEV_PROJECT_ID + '". Refusing to write.');
  }
  const prodProject = prodApp && prodApp.options.credential && prodApp.options.credential.projectId;
  if (prodApp && prodProject !== PROD_PROJECT_ID) {
    die('read source is project "' + prodProject + '", not "' + PROD_PROJECT_ID + '". Refusing to continue.');
  }
}
function assertDevBucket(bucket) {
  assertDevTarget();
  if (!bucket || bucket.name !== DEV_BUCKET) {
    die('storage write target is bucket "' + (bucket && bucket.name) + '", not "' + DEV_BUCKET + '". Refusing to write.');
  }
}

// ---- production: READ ONLY. Returns data, never references. ----
async function prodGetAll(collectionPath) {
  const snap = await prodDb.collection(collectionPath).get();
  return snap.docs.map(function (d) { return { id: d.id, data: d.data() }; });
}
async function prodGetSub(collectionPath, docId, subPath) {
  const snap = await prodDb.collection(collectionPath).doc(docId).collection(subPath).get();
  return snap.docs.map(function (d) { return { id: d.id, data: d.data() }; });
}
async function prodGetDoc(collectionPath, docId) {
  const snap = await prodDb.collection(collectionPath).doc(docId).get();
  return snap.exists ? { id: snap.id, data: snap.data() } : null;
}
async function prodStorageMeta(storagePath) {
  try {
    const file = prodBucket.file(storagePath);
    const existsRes = await file.exists();
    if (!existsRes[0]) return null;
    const metaRes = await file.getMetadata();
    return { size: Number(metaRes[0].size || 0), contentType: metaRes[0].contentType || "image/jpeg" };
  } catch (e) {
    return null;
  }
}
async function prodStorageDownload(storagePath) {
  const res = await prodBucket.file(storagePath).download();
  return res[0];
}

// ---- dev: the ONLY way anything is written, anywhere ----
const pendingWrites = []; // { pathParts, data, merge }
function devSet(pathParts, data, opts) {
  pendingWrites.push({ pathParts: pathParts, data: data, merge: !!(opts && opts.merge) });
}
async function devCommit() {
  if (!COMMIT) { pendingWrites.length = 0; return 0; }
  if (!pendingWrites.length) return 0;
  let written = 0;
  // Firestore caps a batch at 500 writes.
  for (let i = 0; i < pendingWrites.length; i += 400) {
    assertDevTarget(); // re-checked before EVERY batch, not once at startup
    const chunk = pendingWrites.slice(i, i + 400);
    const batch = devDb.batch();
    for (const w of chunk) {
      let ref = devDb.collection(w.pathParts[0]).doc(w.pathParts[1]);
      for (let k = 2; k < w.pathParts.length; k += 2) {
        ref = ref.collection(w.pathParts[k]).doc(w.pathParts[k + 1]);
      }
      if (w.merge) batch.set(ref, w.data, { merge: true });
      else batch.set(ref, w.data);
      written++;
    }
    await batch.commit();
  }
  pendingWrites.length = 0;
  return written;
}
async function devUpload(storagePath, buf, contentType) {
  assertDevBucket(devBucket);
  await devBucket.file(storagePath).save(buf, { contentType: contentType || "image/jpeg", resumable: false });
}

// ---------------------------------------------------------------------------
// helpers that mirror the app's own conventions -- these must match the app
// exactly or the seeded data won't join up
// ---------------------------------------------------------------------------

// Identical to slugify() in js/core.js.
function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}
// Identical to the id math in ensureCustomerAndBuilding() in js/core.js. This
// is how a work order (which stores no buildingId of its own -- only Bill To
// and Job Name) resolves to a building.
function derivedIdsForWorkOrder(wo) {
  const custName = String(wo.billTo || "").trim();
  const bldName = String(wo.jobName || "").trim();
  if (!bldName) return { customerId: null, buildingId: null };
  const customerId = custName ? "cust_" + slugify(custName) : null;
  return {
    customerId: customerId,
    buildingId: "bld_" + slugify((customerId || "nocust") + "_" + bldName)
  };
}
// Photo bytes live at workorders/<workOrderId>/<photoIndex>.jpg -- see
// storagePathFor() in netlify/functions/photos.js.
const PHOTO_PATH_RE = /^workorders\/[A-Za-z0-9_-]+\/\d+\.jpg$/;

function hasBaseMap(bld) {
  if (bld.roof_base_map_type && bld.roof_base_map_url) return true;
  return Array.isArray(bld.roofs) && bld.roofs.some(function (r) {
    return r && r.roof_base_map_type && r.roof_base_map_url;
  });
}
function roofCount(bld) {
  return Array.isArray(bld.roofs) && bld.roofs.length ? bld.roofs.length : 1;
}
function isLeakish(rec) {
  return /leak/i.test(String(rec.workOrderType || "") + " " + String(rec.reportType || ""));
}
function countPins(rec) {
  return Array.isArray(rec.pins) ? rec.pins.length : 0;
}

// ---------------------------------------------------------------------------
async function main() {
  const prodKeyPath = requireArg("prod-key");
  const devKeyPath = requireArg("dev-key");

  if (!COMMIT && args["dry-run"] !== true && !LIST_ONLY) {
    console.log("\n(Neither --dry-run nor --commit given -- treating this as a dry run. Nothing will be written.)");
  }

  const prodCred = loadServiceAccount(prodKeyPath, "--prod-key");
  const devCred = loadServiceAccount(devKeyPath, "--dev-key");

  // Guard #1 -- before a single Firebase app exists.
  if (prodCred.project_id !== PROD_PROJECT_ID) {
    die('--prod-key belongs to project "' + prodCred.project_id + '", expected "' + PROD_PROJECT_ID + '".');
  }
  if (devCred.project_id !== DEV_PROJECT_ID) {
    die('--dev-key belongs to project "' + devCred.project_id + '", expected "' + DEV_PROJECT_ID +
        '". If you are seeing this you almost certainly swapped --prod-key and --dev-key. Nothing was written.');
  }

  prodApp = admin.initializeApp(
    { credential: admin.credential.cert(prodCred), storageBucket: PROD_BUCKET }, "prod");
  devApp = admin.initializeApp(
    { credential: admin.credential.cert(devCred), storageBucket: DEV_BUCKET }, "dev");

  // Guard #2 -- against the initialized apps themselves. NOTE:
  // app.options.projectId is UNDEFINED when an app is initialized with only
  // a credential (firebase-admin copies your init options verbatim; it does
  // not surface the credential's project there) -- the project the app will
  // actually talk to lives on options.credential.projectId. Checking the
  // former made this guard trip on every run, even a correct one.
  const prodAppProject = prodApp.options.credential && prodApp.options.credential.projectId;
  const devAppProject = devApp.options.credential && devApp.options.credential.projectId;
  if (prodAppProject !== PROD_PROJECT_ID) die('prod app came up on the wrong project ("' + prodAppProject + '").');
  if (devAppProject !== DEV_PROJECT_ID) die('dev app came up on the wrong project ("' + devAppProject + '").');

  prodDb = prodApp.firestore();
  devDb = devApp.firestore();
  prodBucket = prodApp.storage().bucket(PROD_BUCKET);
  devBucket = devApp.storage().bucket(DEV_BUCKET);
  assertDevTarget();

  console.log("");
  console.log("  READ FROM (never written):  " + PROD_PROJECT_ID);
  console.log("  WRITE TO:                   " + DEV_PROJECT_ID);
  console.log("  MODE:                       " + (COMMIT
    ? "--commit  (this WILL write to dev)"
    : "dry run   (writes nothing -- re-run with --commit to write)"));
  console.log("");

  // ---- Photo mode: decided up front, honestly, before anything is copied ----
  let storageMode = "INLINE";
  try {
    const devBucketExists = await devBucket.exists();
    if (devBucketExists[0]) storageMode = "STORAGE";
  } catch (e) {
    storageMode = "INLINE";
  }
  if (storageMode === "STORAGE") {
    console.log("  PHOTOS: dev Storage bucket exists (" + DEV_BUCKET + ") -- photo bytes will be copied");
    console.log("          into it at the same paths. Photos will render in dev exactly like prod.");
  } else {
    console.log("  PHOTOS: dev has NO usable Storage bucket (the dev project is on the free Spark plan;");
    console.log("          Cloud Storage needs Blaze). Falling back to INLINE mode -- photo bytes go");
    console.log("          straight into the dev Firestore photo documents as base64, which the app still");
    console.log("          reads and renders. Photos too big for a 1MB Firestore document are skipped and");
    console.log("          named below. Warranty-report PDFs cannot come across at all. Everything you");
    console.log("          need to test (timeline, pins, findings, base roof map in a leak");
    console.log("          investigation) works in this mode.");
  }
  console.log("");

  // ---- Read production once, group in memory ----
  const readResults = await Promise.all([
    prodGetAll("buildings"),
    prodGetAll("building_history_events"),
    prodGetAll("reports"),
    prodGetAll("workorders")
  ]);
  const allBuildings = readResults[0];
  const allEvents = readResults[1];
  const allReports = readResults[2];
  const allWorkOrders = readResults[3];

  if (LIST_ONLY) {
    console.log("Every building in production:");
    allBuildings.forEach(function (b) {
      console.log("  - " + (b.data.name || "(no name)") +
        "  [" + roofCount(b.data) + " roof(s), base map: " + (hasBaseMap(b.data) ? "YES" : "no") + "]");
    });
    console.log('\nRe-run with --buildings="Name One,Name Two" to pick, or with no --buildings to let it choose.');
    return;
  }

  const eventsBy = new Map(), reportsBy = new Map(), workOrdersBy = new Map();
  for (const e of allEvents) {
    if (!e.data.buildingId) continue;
    if (!eventsBy.has(e.data.buildingId)) eventsBy.set(e.data.buildingId, []);
    eventsBy.get(e.data.buildingId).push(e);
  }
  for (const r of allReports) {
    if (!r.data.buildingId) continue;
    if (!reportsBy.has(r.data.buildingId)) reportsBy.set(r.data.buildingId, []);
    reportsBy.get(r.data.buildingId).push(r);
  }
  // Work orders carry no buildingId of their own -- they resolve to a building
  // by the same Bill To / Job Name slug the app itself uses. Resolving them
  // this way (rather than only following reports) also picks up a work order
  // that was SAVED but never exported -- exactly the kind of record that has to
  // be here for the timeline to look real.
  for (const w of allWorkOrders) {
    const ids = derivedIdsForWorkOrder(w.data);
    if (!ids.buildingId) continue;
    if (!workOrdersBy.has(ids.buildingId)) workOrdersBy.set(ids.buildingId, []);
    workOrdersBy.get(ids.buildingId).push(w);
  }
  // Belt and braces: any work order a history event explicitly points at, even
  // if its Job Name was later edited and no longer slugs to this building.
  for (const entry of eventsBy) {
    const bid = entry[0];
    for (const e of entry[1]) {
      const woId = e.data.workOrderId;
      if (!woId) continue;
      const list = workOrdersBy.get(bid) || [];
      if (list.some(function (w) { return w.id === woId; })) continue;
      const wo = allWorkOrders.find(function (w) { return w.id === woId; });
      if (!wo) continue;
      list.push(wo);
      workOrdersBy.set(bid, list);
    }
  }

  function score(b) {
    const evts = eventsBy.get(b.id) || [];
    const reps = reportsBy.get(b.id) || [];
    return {
      id: b.id,
      name: b.data.name || "(no name)",
      roofs: roofCount(b.data),
      baseMap: hasBaseMap(b.data),
      // `reports` and `building_history_events` are written as a mirrored pair
      // (same payload, same doc id -- see logReportAndHistoryEvent() in
      // js/history.js), so count ONE of them, not both, or every leak report
      // gets counted twice.
      leaks: (evts.length ? evts : reps).filter(function (x) { return isLeakish(x.data); }).length,
      events: evts.length,
      reports: reps.length,
      workOrders: (workOrdersBy.get(b.id) || []).length,
      pins: evts.reduce(function (n, e) { return n + countPins(e.data); }, 0)
    };
  }

  // ---- Choose the buildings ----
  let chosen = [];
  if (EXPLICIT_BUILDINGS.length) {
    chosen = allBuildings.filter(function (b) {
      const hay = ((b.data.name || "") + " " + (b.data.location || "")).toLowerCase();
      return EXPLICIT_BUILDINGS.some(function (n) { return hay.indexOf(n.toLowerCase()) !== -1; });
    });
    if (!chosen.length) {
      console.log("None of the names in --buildings matched anything in production. Buildings in production:");
      allBuildings.forEach(function (b) { console.log("  - " + (b.data.name || "(no name)")); });
      return;
    }
  } else {
    const anchor = allBuildings.filter(function (b) {
      return String(b.data.name || "").toLowerCase().indexOf(ANCHOR_BUILDING.toLowerCase()) !== -1;
    });
    if (!anchor.length) {
      console.log('Couldn\'t find a building matching "' + ANCHOR_BUILDING + '" in production, so nothing is anchored.');
      console.log('Auto-picking on coverage instead. Use --list to see every name, or --buildings="..." to choose.');
    }
    chosen = anchor.slice();
    const chosenIds = new Set(chosen.map(function (b) { return b.id; }));
    const rest = allBuildings
      .filter(function (b) {
        if (chosenIds.has(b.id) || b.data.archived) return false;
        if (TEST_BUILDINGS_TO_ARCHIVE.indexOf(String(b.data.name || "")) !== -1) return false;
        // A building with no timeline and no reports would seed as an empty
        // shell -- exactly the "nothing to render" state this script exists to
        // fix. Never auto-pick one. (--buildings="..." still forces any name.)
        const s = score(b);
        return (s.events + s.reports) > 0;
      })
      .map(function (b) { return { b: b, s: score(b) }; });

    // Coverage first: guarantee a base roof map and a leak report are in the
    // seed if production has them at all -- those are the two things the seed
    // exists to let you test.
    const needBaseMap = !chosen.some(function (b) { return hasBaseMap(b.data); });
    const needLeak = !chosen.some(function (b) { return score(b).leaks > 0; });
    function take(pred) {
      const hit = rest
        .filter(function (x) { return !chosenIds.has(x.b.id) && pred(x.s); })
        .sort(function (x, y) { return (y.s.events + y.s.pins) - (x.s.events + x.s.pins); })[0];
      if (hit) { chosen.push(hit.b); chosenIds.add(hit.b.id); }
    }
    if (needBaseMap) take(function (s) { return s.baseMap; });
    if (needLeak) take(function (s) { return s.leaks > 0; });
    // Then fill any remaining slots with the richest buildings left.
    rest.sort(function (x, y) {
      return (y.s.events + y.s.reports + y.s.pins) - (x.s.events + x.s.reports + x.s.pins);
    });
    for (const x of rest) {
      if (chosen.length >= 1 + AUTO_PICK_LIMIT) break;
      if (chosenIds.has(x.b.id)) continue;
      chosen.push(x.b);
      chosenIds.add(x.b.id);
    }
  }

  const scores = chosen.map(score);
  console.log("BUILDINGS TO COPY:");
  scores.forEach(function (s) {
    console.log("  - " + s.name);
    console.log("      " + s.roofs + " roof(s) | base roof map: " + (s.baseMap ? "YES" : "no") +
      " | " + s.workOrders + " work order(s) | " + s.reports + " report(s) (" + s.leaks + " leak)" +
      " | " + s.events + " history event(s) | " + s.pins + " pin(s)");
  });
  console.log("");
  console.log("COVERAGE CHECK:");
  console.log("  at least one base roof map: " + (scores.some(function (s) { return s.baseMap; }) ? "YES" : "NO"));
  console.log("  at least one leak report:   " + (scores.some(function (s) { return s.leaks > 0; }) ? "YES" : "NO"));
  console.log("  a multi-roof building:      " + (scores.some(function (s) { return s.roofs > 1; }) ? "YES" : "NO"));
  if (!scores.some(function (s) { return s.baseMap; }) || !scores.some(function (s) { return s.leaks > 0; })) {
    console.log("  ^ something above is missing. Run with --list to see every building, then re-run with");
    console.log('    --buildings="..." naming one that has what is missing.');
  }
  console.log("");

  // ---- Queue every document ----
  const customerIds = new Set();
  const ccProjectIds = new Set();
  const photoJobs = [];
  let nEvents = 0, nReports = 0, nWorkOrders = 0, nWarranty = 0, nPhotoDocs = 0;

  for (const bld of chosen) {
    const bid = bld.id;
    devSet(["buildings", bid], bld.data);
    if (bld.data.customerId) customerIds.add(bld.data.customerId);
    if (bld.data.companyCamProjectId) ccProjectIds.add(bld.data.companyCamProjectId);

    for (const e of (eventsBy.get(bid) || [])) {
      devSet(["building_history_events", e.id], e.data);
      if (e.data.customerId) customerIds.add(e.data.customerId);
      nEvents++;
    }
    for (const r of (reportsBy.get(bid) || [])) {
      devSet(["reports", r.id], r.data);
      if (r.data.customerId) customerIds.add(r.data.customerId);
      nReports++;
    }
    for (const w of (workOrdersBy.get(bid) || [])) {
      devSet(["workorders", w.id], w.data);
      nWorkOrders++;
      const photos = await prodGetSub("workorders", w.id, "photos");
      for (const p of photos) {
        photoJobs.push({ workOrderId: w.id, photoDocId: p.id, data: p.data });
        nPhotoDocs++;
      }
    }
    const warranty = await prodGetSub("buildings", bid, "warranty_reports");
    for (const wr of warranty) {
      devSet(["buildings", bid, "warranty_reports", wr.id], wr.data);
      nWarranty++;
    }
  }

  for (const cid of customerIds) {
    const c = await prodGetDoc("customers", cid);
    if (c) devSet(["customers", c.id], c.data);
  }
  for (const pid of ccProjectIds) {
    const p = await prodGetDoc("companycam_projects", pid);
    if (p) devSet(["companycam_projects", p.id], p.data);
  }

  console.log("WILL COPY:");
  console.log("  " + chosen.length + " building(s), " + customerIds.size + " customer(s), " +
    nWorkOrders + " work order(s),");
  console.log("  " + nReports + " report(s), " + nEvents + " history event(s), " +
    nWarranty + " warranty report(s),");
  console.log("  " + nPhotoDocs + " photo record(s), " + ccProjectIds.size + " CompanyCam project link(s).");
  console.log("  (Roofs, roof outlines, roof features, findings and pins travel inside those documents.)");
  console.log("");

  // ---- Photos ----
  let photosReady = 0, photosCopied = 0, photosAlready = 0, photosInlined = 0;
  let photosSkippedTooBig = 0, photosMissing = 0, photosFailed = 0;
  const tooBig = [];

  for (const job of photoJobs) {
    const p = job.data;
    const ref = typeof p.storageRef === "string" ? p.storageRef : "";

    // A legacy photo (base64 already in Firestore, no Storage object) travels
    // with its document for free, in either mode.
    if (!ref) {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], p);
      if (p.img) photosReady++;
      continue;
    }
    if (!PHOTO_PATH_RE.test(ref)) {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], p);
      photosFailed++;
      console.log("  ! photo " + job.workOrderId + "/" + job.photoDocId +
        ': unexpected storageRef "' + ref + '" -- record copied, bytes not.');
      continue;
    }

    if (storageMode === "STORAGE") {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], p);
      const meta = await prodStorageMeta(ref);
      if (!meta) { photosMissing++; continue; }
      if (!COMMIT) { photosCopied++; photosReady++; continue; }
      assertDevBucket(devBucket);
      const already = await devBucket.file(ref).exists();
      if (already[0]) { photosAlready++; photosReady++; continue; } // idempotent
      try {
        const buf = await prodStorageDownload(ref);
        await devUpload(ref, buf, meta.contentType);
        photosCopied++;
        photosReady++;
      } catch (e) {
        photosFailed++;
        console.log("  ! failed to copy photo bytes " + ref + ": " + e.message);
      }
      continue;
    }

    // INLINE mode. Production kept a base64 backup on many migrated photo docs
    // (see cloudSaveOrder()'s cooling-off preservation in js/core.js) -- where
    // it exists, no download is needed at all. Dropping storageRef is what makes
    // the app render `img` directly (see cloudLoadOrder()).
    const inlineDoc = Object.assign({}, p);
    delete inlineDoc.storageRef;
    if (typeof p.img === "string" && p.img.indexOf("data:") === 0) {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], inlineDoc);
      photosInlined++;
      photosReady++;
      continue;
    }
    const meta = await prodStorageMeta(ref);
    if (!meta) {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], p);
      photosMissing++;
      continue;
    }
    const estimated = Math.ceil(meta.size * 4 / 3) + 512; // base64 inflation + data-url header
    if (estimated > INLINE_PHOTO_BUDGET_BYTES) {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], p); // record copies; image won't show
      photosSkippedTooBig++;
      tooBig.push(ref + " (" + Math.round(meta.size / 1024) + " KB)");
      continue;
    }
    if (!COMMIT) { photosInlined++; photosReady++; continue; }
    try {
      const buf = await prodStorageDownload(ref);
      inlineDoc.img = "data:" + (meta.contentType || "image/jpeg") + ";base64," + buf.toString("base64");
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], inlineDoc);
      photosInlined++;
      photosReady++;
    } catch (e) {
      devSet(["workorders", job.workOrderId, "photos", job.photoDocId], p);
      photosFailed++;
      console.log("  ! failed to read photo bytes " + ref + ": " + e.message);
    }
  }

  if (storageMode === "STORAGE") {
    console.log("PHOTOS (storage mode): " + photosCopied + " to copy, " + photosAlready +
      " already in dev, " + photosMissing + " referenced but missing in production, " +
      photosFailed + " failed.");
  } else {
    console.log("PHOTOS (inline mode): " + photosInlined + " will render in dev, " +
      photosSkippedTooBig + " too large for a Firestore document (skipped), " +
      photosMissing + " referenced but missing in production, " + photosFailed + " failed.");
    if (tooBig.length) {
      console.log("  Too large to inline (the record still copies -- only the image is absent):");
      tooBig.slice(0, 20).forEach(function (t) { console.log("    - " + t); });
      if (tooBig.length > 20) console.log("    ...and " + (tooBig.length - 20) + " more");
    }
    if (nWarranty) {
      console.log("  Note: " + nWarranty + " warranty-report PDF(s) are Storage-only and cannot come across");
      console.log("  in this mode. Their records copy, but 'View PDF' on them will fail in dev.");
    }
  }
  console.log("");

  // ---- Write ----
  if (!COMMIT) {
    console.log("DRY RUN -- nothing was written. If the above looks right, run the same command again");
    console.log("with --commit in place of --dry-run.");
    return;
  }

  const written = await devCommit();
  console.log("Wrote " + written + " document(s) to " + DEV_PROJECT_ID + ".");

  // ---- Archive dev's leftover test buildings ----
  assertDevTarget();
  const devBuildings = await devDb.collection("buildings").get();
  for (const wanted of TEST_BUILDINGS_TO_ARCHIVE) {
    const hit = devBuildings.docs.find(function (d) { return (d.data().name || "") === wanted; });
    if (!hit) { console.log('Test building "' + wanted + '" is not on dev -- nothing to archive.'); continue; }
    if (hit.data().archived) { console.log('Test building "' + wanted + '" was already archived.'); continue; }
    devSet(["buildings", hit.id], { archived: true, archivedAt: Date.now() }, { merge: true });
    console.log('Archiving test building "' + wanted + '".');
  }
  await devCommit();

  // ---- Summary ----
  console.log("");
  console.log("======================================================================");
  console.log("DONE. Dev now has:");
  scores.forEach(function (s) {
    console.log("  - " + s.name + " -- " + s.roofs + " roof(s), " + s.events + " timeline entr" +
      (s.events === 1 ? "y" : "ies") + ", " + s.pins + " pin(s)" +
      (s.baseMap ? ", base roof map" : "") + (s.leaks ? ", leak report" : ""));
  });
  console.log("  - " + photosReady + " photo(s) that will actually render" +
    (storageMode === "INLINE" ? " (inlined -- dev has no Storage bucket)" : ""));
  console.log("");
  console.log("Open " + DEV_SITE_URL + " and go to Building History.");
  console.log("Open " + (scores[0] ? scores[0].name : "a building") + " and check the timeline, the pins,");
  console.log("and that the base roof map shows up inside a leak investigation.");
  console.log("======================================================================");
}

main().catch(function (e) {
  console.error("\nABORTED: " + (e && e.message ? e.message : String(e)));
  console.error("Nothing further was written.\n");
  process.exit(1);
});
