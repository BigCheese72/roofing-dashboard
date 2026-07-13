#!/usr/bin/env node
// ============================================================================
// WHAT THIS DOES (read this part, skip the code below unless you want to)
//
// Copies a handful of real buildings you name -- out of production
// (watkins-service-orders) into the empty dev sandbox
// (watkins-service-orders-dev): buildings, roofs, work orders, findings,
// pins, history, and the actual photo files -- so dev has something real
// to click around in instead of an empty app.
//
// It only ever READS from production. It only ever WRITES to dev. It
// refuses to run at all if the two key files are swapped or wrong.
//
// This file deliberately does NOT hardcode any real customer or building
// name -- this repo is public, and customer names don't belong committed
// into public source. You pass the buildings you want on the command line
// instead (see below), where they're never committed anywhere.
//
// EXACTLY WHAT TO RUN (three steps, in this order):
//
//   1) Run with no --buildings flag to see every building name in
//      production, so you can copy the exact ones you want:
//
//      node tools/seed_dev_from_prod.js --prod-key <path-to-prod-key.json> --dev-key <path-to-dev-key.json> --dry-run
//
//   2) Dry run again, this time naming the buildings you want (comma-
//      separated, case-insensitive substring match against name/address --
//      e.g. your 11-roof multi-roof building plus 2-3 others, including at
//      least one with a base roof map and one with a leak report):
//
//      node tools/seed_dev_from_prod.js --prod-key <path-to-prod-key.json> --dev-key <path-to-dev-key.json> --buildings="Building One,Building Two,Building Three" --dry-run
//
//   3) Read the output. If it looks right, actually copy it -- same command,
//      swap --dry-run for --commit:
//
//      node tools/seed_dev_from_prod.js --prod-key <path-to-prod-key.json> --dev-key <path-to-dev-key.json> --buildings="Building One,Building Two,Building Three" --commit
//
// Replace <path-to-prod-key.json> / <path-to-dev-key.json> with the two
// service-account key files you already have. Nobody but you touches
// those files -- this script takes the paths as arguments, never reads
// them from anywhere else, never prints their contents.
//
// Safe to run more than once -- re-running just re-copies the same data
// over itself (same document ids, same storage paths), it does not
// duplicate anything.
//
// Also archives the two leftover test buildings on dev
// (OFFLINE-LIVE-TEST-DELETE-ME, SYNTH-TEST-PHOTOBUG-DELETE-ME -- these are
// synthetic test-data names, not real customers, safe to name here) as
// part of --commit, so you don't have to click through a confirm dialog
// for them.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROD_PROJECT_ID = "watkins-service-orders";
const DEV_PROJECT_ID = "watkins-service-orders-dev";

// Buildings that only exist to test something and were never cleaned up --
// archived (not deleted) on dev so they don't show in the normal list, same
// effect as clicking "Archive (admin)" without the confirm-dialog click.
const TEST_BUILDINGS_TO_ARCHIVE = ["OFFLINE-LIVE-TEST-DELETE-ME", "SYNTH-TEST-PHOTOBUG-DELETE-ME"];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const COMMIT = !!args.commit;
// Comma-separated, e.g. --buildings="Building One,Building Two" -- deliberately
// a runtime argument, never a hardcoded constant, so no real building/customer
// name ever ends up committed to this (public) repo.
const BUILDING_NAME_MATCHES = (args.buildings || "").split(",").map((s) => s.trim()).filter(Boolean);

function requireArg(name) {
  if (!args[name]) {
    console.error(`Missing required --${name} <path> argument. See the usage block at the top of this file.`);
    process.exit(1);
  }
  return args[name];
}

function loadServiceAccount(keyPath) {
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Service account key not found: ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

async function main() {
  const prodKeyPath = requireArg("prod-key");
  const devKeyPath = requireArg("dev-key");

  const prodCred = loadServiceAccount(prodKeyPath);
  const devCred = loadServiceAccount(devKeyPath);

  // Hard assertions BEFORE any app is initialized -- refuses to run at all
  // if the two key files are swapped, mislabeled, or point at the wrong
  // projects. This is the single most important check in this file: it is
  // structurally impossible for this script to write to production, because
  // every write call below goes through `devDb`/`devBucket`, which can only
  // ever be initialized from a credential that passed this assertion.
  if (prodCred.project_id !== PROD_PROJECT_ID) {
    throw new Error(
      `--prod-key belongs to project "${prodCred.project_id}", expected "${PROD_PROJECT_ID}". Refusing to run.`
    );
  }
  if (devCred.project_id !== DEV_PROJECT_ID) {
    throw new Error(
      `--dev-key belongs to project "${devCred.project_id}", expected "${DEV_PROJECT_ID}". Refusing to run -- ` +
      `if this fired, you likely swapped --prod-key and --dev-key.`
    );
  }

  const prodApp = admin.initializeApp({ credential: admin.credential.cert(prodCred) }, "prod");
  const devApp = admin.initializeApp({ credential: admin.credential.cert(devCred) }, "dev");

  // Re-assert against the initialized apps themselves, not just the raw
  // JSON, as a second independent check before any read or write happens.
  if (prodApp.options.projectId !== PROD_PROJECT_ID) throw new Error("prod app projectId mismatch after init -- aborting.");
  if (devApp.options.projectId !== DEV_PROJECT_ID) throw new Error("dev app projectId mismatch after init -- aborting.");

  const prodDb = prodApp.firestore(); // READ ONLY -- never call .set/.delete/.update on this anywhere below
  const devDb = devApp.firestore(); // writes go here only
  const prodBucket = prodApp.storage().bucket();
  const devBucket = devApp.storage().bucket();

  console.log(`Reading from (read-only): ${prodApp.options.projectId} / bucket ${prodBucket.name}`);
  console.log(`Writing to:               ${devApp.options.projectId} / bucket ${devBucket.name}`);
  console.log(COMMIT ? "MODE: --commit (will write to dev)" : "MODE: dry run (writes nothing -- pass --commit to actually write)");
  console.log("");

  // ---- 1. Find matching buildings in production ----
  const allBuildingsSnap = await prodDb.collection("buildings").get();

  if (!BUILDING_NAME_MATCHES.length) {
    console.log("No --buildings=\"...\" flag given. Every building name in production:");
    allBuildingsSnap.docs.forEach((d) => console.log(`  - ${d.data().name || "(no name)"} / ${d.data().address || ""}`));
    console.log('\nRe-run with --buildings="Exact Name One,Exact Name Two,..." naming the ones you want, e.g. your');
    console.log("11-roof multi-roof building plus 2-3 others (include at least one with a base roof map and one with a leak report).");
    return;
  }

  const matched = allBuildingsSnap.docs.filter((d) => {
    const b = d.data();
    const hay = `${b.name || ""} ${b.address || ""}`.toLowerCase();
    return BUILDING_NAME_MATCHES.some((n) => hay.includes(n.toLowerCase()));
  });

  if (!matched.length) {
    console.log(`None of the names in --buildings matched anything in production. Every building name in production:`);
    allBuildingsSnap.docs.forEach((d) => console.log(`  - ${d.data().name || "(no name)"} / ${d.data().address || ""}`));
    return;
  }

  console.log(`Matched ${matched.length} building(s) in production:`);
  matched.forEach((d) => {
    const b = d.data();
    const hasBaseMap = !!(b.roof_base_map_type && b.roof_base_map_url) ||
      (Array.isArray(b.roofs) && b.roofs.some((r) => r.roof_base_map_type && r.roof_base_map_url));
    console.log(`  - ${d.id}: ${b.name || "(no name)"}  [base roof map: ${hasBaseMap ? "YES" : "no"}]`);
  });
  console.log("");

  // Collects every storage path (workorders/<id>/<n>.jpg) found anywhere in
  // the copied JSON, regardless of which work-order type nests it where --
  // robust to leak/inspection/repair/change-order/warranty schema
  // differences without having to special-case each one. Photos stored as
  // legacy base64 (`img` field, no `storageRef`) travel with the Firestore
  // doc itself and need no separate Storage copy -- they'll render in dev
  // immediately once the doc is copied.
  const storagePaths = new Set();
  const STORAGE_PATH_RE = /^workorders\/[A-Za-z0-9_-]+\/\d+\.jpg$/;
  function collectStoragePaths(value) {
    if (typeof value === "string") {
      if (STORAGE_PATH_RE.test(value)) storagePaths.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(collectStoragePaths);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collectStoragePaths);
    }
  }

  let totalReports = 0, totalEvents = 0, totalWarrantyReports = 0, totalWorkOrders = 0, leakReportsFound = 0;

  for (const bldDoc of matched) {
    const buildingId = bldDoc.id;
    const bld = bldDoc.data();
    collectStoragePaths(bld);

    // Same footprint definition admin.js's delete_building action uses, in
    // reverse (copy instead of delete) -- the authoritative definition of
    // "everything that belongs to a building" already established elsewhere
    // in this app, not something invented here.
    const [evtSnap, repSnap, warrantySnap] = await Promise.all([
      prodDb.collection("building_history_events").where("buildingId", "==", buildingId).get(),
      prodDb.collection("reports").where("buildingId", "==", buildingId).get(),
      prodDb.collection("buildings").doc(buildingId).collection("warranty_reports").get(),
    ]);

    const leakReports = repSnap.docs.filter((d) => {
      const r = d.data();
      return /leak/i.test(r.workOrderType || r.reportType || "");
    });
    if (leakReports.length) leakReportsFound += leakReports.length;

    console.log(`[${buildingId}] ${bld.name || "(no name)"}: ${evtSnap.size} history events, ${repSnap.size} reports (${leakReports.length} leak), ${warrantySnap.size} warranty reports`);

    evtSnap.forEach((d) => collectStoragePaths(d.data()));
    repSnap.forEach((d) => collectStoragePaths(d.data()));
    warrantySnap.forEach((d) => collectStoragePaths(d.data()));
    totalEvents += evtSnap.size;
    totalReports += repSnap.size;
    totalWarrantyReports += warrantySnap.size;

    // Best-effort: a live "workorders" draft doc sharing the same id as a
    // reports/ doc (logReportAndHistoryEvent's "sharedId" convention) --
    // not every report has one (some are backfilled from elsewhere), so
    // missing is expected and not an error.
    const workOrderDocs = [];
    for (const repDoc of repSnap.docs) {
      const woSnap = await prodDb.collection("workorders").doc(repDoc.id).get();
      if (woSnap.exists) workOrderDocs.push(woSnap);
    }
    workOrderDocs.forEach((d) => collectStoragePaths(d.data()));
    totalWorkOrders += workOrderDocs.length;

    if (COMMIT) {
      // .set() (full overwrite, not merge) with the SAME document id every
      // time is what makes this idempotent -- running this twice converges
      // to the same state instead of duplicating anything.
      await devDb.collection("buildings").doc(buildingId).set(bld);
      const batch = devDb.batch();
      evtSnap.forEach((d) => batch.set(devDb.collection("building_history_events").doc(d.id), d.data()));
      repSnap.forEach((d) => batch.set(devDb.collection("reports").doc(d.id), d.data()));
      warrantySnap.forEach((d) =>
        batch.set(devDb.collection("buildings").doc(buildingId).collection("warranty_reports").doc(d.id), d.data())
      );
      workOrderDocs.forEach((d) => batch.set(devDb.collection("workorders").doc(d.id), d.data()));
      await batch.commit();

      // Photos subcollection under each copied workorders doc.
      for (const woDoc of workOrderDocs) {
        const photosSnap = await prodDb.collection("workorders").doc(woDoc.id).collection("photos").get();
        if (!photosSnap.size) continue;
        const photoBatch = devDb.batch();
        photosSnap.forEach((p) => {
          collectStoragePaths(p.data());
          photoBatch.set(devDb.collection("workorders").doc(woDoc.id).collection("photos").doc(p.id), p.data());
        });
        await photoBatch.commit();
      }
    }
  }

  console.log("");
  console.log(`Totals: ${matched.length} buildings, ${totalReports} reports (${leakReportsFound} leak reports), ${totalEvents} history events, ${totalWarrantyReports} warranty reports, ${totalWorkOrders} workorders docs`);
  if (!leakReportsFound) {
    console.log("WARNING: none of the matched buildings have a leak report. Add another building name to --buildings and re-run --dry-run.");
  }
  console.log(`Storage objects referenced: ${storagePaths.size}`);

  // ---- 2. Storage: copy the actual photo bytes, same path in dev ----
  // storagePathFor() in netlify/functions/photos.js is a pure function of
  // (workOrderId, photoIndex) with no project-specific prefix, so the path
  // string itself never needs to change -- only the bytes need to exist at
  // that same path in the dev bucket for photos to render instead of
  // showing as broken images.
  let copied = 0, skippedMissing = 0, skippedExists = 0, failed = 0;
  for (const p of storagePaths) {
    const srcFile = prodBucket.file(p);
    const [exists] = await srcFile.exists();
    if (!exists) { skippedMissing++; continue; }

    if (!COMMIT) { console.log(`  would copy photo: ${p}`); continue; }

    const destFile = devBucket.file(p);
    const [alreadyThere] = await destFile.exists();
    if (alreadyThere) { skippedExists++; continue; } // idempotent: don't re-copy what's already there

    try {
      const [buf] = await srcFile.download();
      await destFile.save(buf, { contentType: "image/jpeg", resumable: false });
      copied++;
    } catch (e) {
      failed++;
      console.error(`  FAILED to copy ${p}: ${e.message}`);
    }
  }

  console.log("");
  if (COMMIT) {
    console.log(`Storage: copied ${copied}, already present ${skippedExists}, missing in source ${skippedMissing}, failed ${failed}`);
    if (failed > 0) console.log(`${failed} photo(s) failed to copy -- those will render as broken images in dev. See errors above.`);
  } else {
    console.log(`DRY RUN: ${storagePaths.size - skippedMissing} storage object(s) would be copied, ${skippedMissing} referenced path(s) missing in production (expected for older/never-migrated photos -- those photos use legacy base64 and don't need a Storage copy).`);
  }

  // ---- 3. Archive leftover test buildings on dev (dev-only write) ----
  if (COMMIT) {
    console.log("");
    const devBuildingsSnap = await devDb.collection("buildings").get();
    for (const wantedName of TEST_BUILDINGS_TO_ARCHIVE) {
      const hit = devBuildingsSnap.docs.find((d) => (d.data().name || "") === wantedName);
      if (!hit) { console.log(`Test building "${wantedName}" not found on dev -- nothing to archive.`); continue; }
      if (hit.data().archived) { console.log(`Test building "${wantedName}" already archived.`); continue; }
      await devDb.collection("buildings").doc(hit.id).set({ archived: true, archivedAt: Date.now() }, { merge: true });
      console.log(`Archived test building "${wantedName}" (${hit.id}) on dev.`);
    }
  } else {
    console.log(`\nWould also archive on dev (if present): ${TEST_BUILDINGS_TO_ARCHIVE.join(", ")}`);
  }

  console.log("");
  if (COMMIT) {
    console.log("Done. Open https://dev--leak-work-orders.netlify.app , go to Building History, and check:");
    matched.forEach((d) => console.log(`  - ${d.data().name || d.id}`));
  } else {
    console.log("Dry run complete -- nothing was written. Re-run with --commit to actually seed dev.");
  }
}

main().catch((e) => {
  console.error("ABORTED:", e.message);
  process.exit(1);
});
