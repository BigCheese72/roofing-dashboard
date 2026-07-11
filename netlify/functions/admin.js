// Privileged admin operations. This is the ONLY place in the app allowed to
// delete building/report/history records — firestore.rules (repo root)
// blocks client-side deletes on those collections entirely, so the only
// path to destroy data is through here, using the Firebase Admin SDK
// (which is not subject to Firestore security rules).
//
// The PIN a tech types into the app's "Admin" toggle is NOT checked
// client-side anymore — it's sent here and compared against the ADMIN_PIN
// environment variable, which is never shipped to the browser. This is
// what actually closes the gap where anyone could open devtools and call
// the Firestore SDK directly to delete data regardless of the UI.
const admin = require("firebase-admin");
const { tryVerifyCaller } = require("./lib/authGuard");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Auth Phase 2 -- immutable audit log for admin.js's mutating actions (see
// "Audit log" in docs/AUTH_DESIGN.md: append-only, rules deny update/delete
// to EVERYONE including owner, written only via the Admin SDK here, never
// subject to rules at all).
//
// Deliberately does NOT require login -- the shared ADMIN_PIN (checked
// above, unchanged) remains the only thing actually gating this file,
// because it's the only thing PRODUCTION'S code sends at all (zero
// Firebase Auth tokens there). tryVerifyCaller() opportunistically
// captures a real actor identity when a dev caller happens to be signed
// in (richer log: who, not just "PIN was correct"), and degrades cleanly
// to actorMethod:"pin_only" otherwise. A logging failure NEVER blocks the
// underlying admin action -- the write already happened; losing the
// audit trail for one action is a lesser failure than silently reporting
// the action itself failed when it didn't.
async function writeAuditLog(db, event, action, target, before, after) {
  try {
    const caller = await tryVerifyCaller(event);
    // ts:Date.now() (not a Firestore serverTimestamp) matches the exact
    // shape auth.js's writeAudit() already established in Phase 1 for
    // bootstrap_owner/assign_role/transfer_owner -- one consistent shape
    // across every audit_logs writer, not a second timestamp field.
    // actorEmail/actorMethod are additive fields Phase 1's writer doesn't
    // set (a plain `undefined` field is simply absent on read, same as
    // every other optional field elsewhere in this app).
    await db.collection("audit_logs").doc().set({
      ts: Date.now(),
      actorUid: caller ? caller.uid : null,
      actorEmail: caller ? caller.email : null,
      actorRole: caller ? (caller.owner ? "owner" : caller.role) : null,
      actorMethod: caller ? "claims" : "pin_only",
      action: action,
      target: target,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after
    });
  } catch (e) {
    console.error("audit log write failed (action still succeeded):", action, e && e.message);
  }
}

// Server-side mirror of getBuildingRoofs()/saveBuildingRoofs() in index.html
// — see "Multiple roofs per building" in DEV_NOTES.md / DATA_MODEL.md for
// the full design. Duplicated here (not shared code) because this function
// runs under the Firebase Admin SDK, not the browser; keep both in sync by
// hand if the roof shape ever changes.
function getBuildingRoofsServer(bld) {
  bld = bld || {};
  if (Array.isArray(bld.roofs) && bld.roofs.length) return bld.roofs;
  return [{
    id: "roof_default",
    label: "Roof 1",
    roofSystem: bld.roofSystem || "",
    roof_base_map_type: bld.roof_base_map_type || null,
    roof_base_map_url: bld.roof_base_map_url || null,
    roof_base_map_bounds: bld.roof_base_map_bounds || null,
    roof_base_map_synthetic: bld.roof_base_map_synthetic || false,
    roof_assets: bld.roof_assets || [],
    roof_outlines: bld.roof_outlines || []
  }];
}

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set. Add it in Netlify > Environment variables, then redeploy.");
    let creds;
    try { creds = JSON.parse(raw); }
    catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON."); }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  return admin.firestore();
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }
  const configuredPin = process.env.ADMIN_PIN;
  if (!configuredPin) {
    return resp(500, { error: "ADMIN_PIN is not set. Add it in Netlify > Environment variables, then redeploy." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  if (String(body.pin || "") !== configuredPin) {
    return resp(403, { error: "Wrong admin PIN" });
  }

  if (body.action === "check_pin") {
    return resp(200, { ok: true });
  }

  try {
    const db = getDb();

    if (body.action === "delete_building") {
      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      const [bldSnapBefore, evtSnap, repSnap] = await Promise.all([
        db.collection("buildings").doc(buildingId).get(),
        db.collection("building_history_events").where("buildingId", "==", buildingId).get(),
        db.collection("reports").where("buildingId", "==", buildingId).get()
      ]);
      // "before" is a summary, not a full backup (name/address/customerId
      // plus counts) -- enough to identify what was destroyed and by whom,
      // not a restore mechanism; roofs[]/history content can be large and
      // isn't what this log is for.
      const bldBefore = bldSnapBefore.exists ? bldSnapBefore.data() : null;
      const batch = db.batch();
      evtSnap.forEach(d => batch.delete(d.ref));
      repSnap.forEach(d => batch.delete(d.ref));
      batch.delete(db.collection("buildings").doc(buildingId));
      await batch.commit();
      await writeAuditLog(db, event, "delete_building", { collection: "buildings", id: buildingId },
        bldBefore ? { name: bldBefore.name || null, address: bldBefore.address || null,
          customerId: bldBefore.customerId || null, deletedEvents: evtSnap.size, deletedReports: repSnap.size } : null,
        null);
      return resp(200, { ok: true, deletedEvents: evtSnap.size, deletedReports: repSnap.size });
    }

    if (body.action === "delete_history_event") {
      const eventId = String(body.eventId || "");
      if (!eventId) return resp(400, { error: "Missing eventId" });
      const evtSnapBefore = await db.collection("building_history_events").doc(eventId).get();
      const evtBefore = evtSnapBefore.exists ? evtSnapBefore.data() : null;
      const batch = db.batch();
      batch.delete(db.collection("building_history_events").doc(eventId));
      batch.delete(db.collection("reports").doc(eventId)); // same id — see logReportAndHistoryEvent in index.html
      await batch.commit();
      await writeAuditLog(db, event, "delete_history_event", { collection: "building_history_events", id: eventId },
        evtBefore ? { buildingId: evtBefore.buildingId || null, workOrderType: evtBefore.workOrderType || null } : null, null);
      return resp(200, { ok: true });
    }

    if (body.action === "set_building_roof_map") {
      // Setting AND clearing a building's base map both go through here —
      // it's a shared, building-wide setting (affects every future report's
      // history map), not per-work-order draft data, so it gets the same
      // admin-only treatment as the delete actions above rather than being
      // left to a client-side-only check.
      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      // roofId is optional — omitted (every call before this change) means
      // "the building's first roof", same as before. Passing it targets a
      // specific roof on a multi-roof building instead.
      const roofId = body.roofId ? String(body.roofId) : null;
      const type = body.roof_base_map_type ? String(body.roof_base_map_type) : null;
      const url = body.roof_base_map_url ? String(body.roof_base_map_url) : null;
      if (type && ["drone_ortho", "satellite", "roof_plan", "sketch"].indexOf(type) === -1) {
        return resp(400, { error: "Invalid roof_base_map_type" });
      }
      // Purely cosmetic label, not read by any type-dispatch logic —
      // RoofMapper's ortho-upload flow (see rmPersistOrthoBaseMap() in
      // index.html) saves an uploaded drone image as type "sketch" (x/y
      // pixel space, since its bounds are synthetic/Null Island, not real
      // GPS) but still wants to say "drone photo" instead of "hand
      // sketch" wherever this shows up. Only meaningful alongside a
      // truthy type; explicitly false/absent otherwise.
      const synthetic = type ? !!body.roof_base_map_synthetic : false;
      let bounds = null;
      if (type === "drone_ortho") {
        const b = body.roof_base_map_bounds || {};
        const n = Number(b.north), s = Number(b.south), e = Number(b.east), w = Number(b.west);
        const valid = [n, s, e, w].every(v => Number.isFinite(v)) &&
          n > s && n <= 90 && s >= -90 && e > w && e <= 180 && w >= -180;
        if (!valid) {
          return resp(400, { error: "roof_base_map_bounds must have valid north/south/east/west (north>south, east>west, in range)" });
        }
        bounds = { north: n, south: s, east: e, west: w };
      }

      const bldRef = db.collection("buildings").doc(buildingId);
      const bldSnap = await bldRef.get();
      const bld = bldSnap.exists ? bldSnap.data() : {};
      const roofs = getBuildingRoofsServer(bld);
      const foundIdx = roofId ? roofs.findIndex(r => r.id === roofId) : 0;
      const idx = foundIdx >= 0 ? foundIdx : 0;
      const roofBefore = { roof_base_map_type: roofs[idx].roof_base_map_type || null,
        roof_base_map_url: roofs[idx].roof_base_map_url || null };
      roofs[idx] = Object.assign({}, roofs[idx], {
        roof_base_map_type: type,
        roof_base_map_url: url,
        roof_base_map_bounds: bounds,
        roof_base_map_synthetic: synthetic,
        updatedAt: Date.now()
      });

      const patch = { roofs, updatedAt: Date.now() };
      // Mirror onto the legacy singular fields whenever the building still
      // has exactly one roof — same dual-write rule as saveBuildingRoofs()
      // client-side, so production (which only reads those legacy fields)
      // keeps working for every still-single-roof building.
      if (roofs.length === 1) {
        patch.roof_base_map_type = type;
        patch.roof_base_map_url = url;
        patch.roof_base_map_bounds = bounds;
        patch.roof_base_map_synthetic = synthetic;
        patch.roof_base_map_updated_at = Date.now();
      }
      await bldRef.set(patch, { merge: true });
      await writeAuditLog(db, event, "set_building_roof_map", { collection: "buildings", id: buildingId, roofId: roofs[idx].id },
        roofBefore, { roof_base_map_type: type, roof_base_map_url: url });
      return resp(200, { ok: true });
    }

    if (body.action === "set_roof_profile") {
      // Admin-editable facts ABOUT a roof (age, warranty, condition, etc.)
      // — a shared, building-wide fact worth the same server-enforced gate
      // as the custom base map above, not a per-work-order thing any tech
      // should casually overwrite. See "Admin roof-profile fields" in
      // DEV_NOTES.md / DATA_MODEL.md.
      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      const roofId = body.roofId ? String(body.roofId) : null;
      const rawProfile = (body.profile && typeof body.profile === "object") ? body.profile : {};
      // Allow-list of fields — never let an arbitrary client payload write
      // unexpected keys onto a roof, even though this whole action is
      // already admin-PIN-gated.
      const ALLOWED_PROFILE_FIELDS = ["installDate", "estimatedAgeYears", "healthScore",
        "condition", "manufacturer", "deckType", "insulationType", "warrantyProvider",
        "warrantyExpiration", "warrantyStatus", "drainageNotes", "customerContacts",
        "internalNotes", "replacementHistory", "estimatedRemainingLifeYears"];
      const profile = {};
      ALLOWED_PROFILE_FIELDS.forEach(k => { if (rawProfile[k] !== undefined) profile[k] = rawProfile[k]; });
      profile.updatedAt = Date.now();
      const roofSystem = body.roofSystem !== undefined ? String(body.roofSystem) : undefined;

      const bldRef = db.collection("buildings").doc(buildingId);
      const bldSnap = await bldRef.get();
      const bld = bldSnap.exists ? bldSnap.data() : {};
      const roofs = getBuildingRoofsServer(bld);
      const foundIdx = roofId ? roofs.findIndex(r => r.id === roofId) : 0;
      const idx = foundIdx >= 0 ? foundIdx : 0;
      const profileBefore = roofs[idx].profile || null;
      const updatedRoof = Object.assign({}, roofs[idx], { profile: profile });
      if (roofSystem !== undefined) updatedRoof.roofSystem = roofSystem;
      roofs[idx] = updatedRoof;

      const patch = { roofs, updatedAt: Date.now() };
      // profile is a brand-new concept — there's no legacy singular field
      // for it to mirror into (production's old code has no notion of a
      // roof profile at all). roofSystem, however, predates roofs[] and
      // still needs the usual single-roof mirror for production parity.
      if (roofs.length === 1 && roofSystem !== undefined) {
        patch.roofSystem = roofSystem;
      }
      await bldRef.set(patch, { merge: true });
      await writeAuditLog(db, event, "set_roof_profile", { collection: "buildings", id: buildingId, roofId: roofs[idx].id },
        profileBefore, profile);
      return resp(200, { ok: true });
    }

    if (body.action === "list_feedback") {
      // In-app Send Feedback backlog (💬 button, every screen — see
      // "Send Feedback" in DEV_NOTES.md). firestore.rules blocks client
      // reads on `feedback` entirely (create-only, like the delete-blocked
      // collections above use write-blocked) — this Admin-SDK read is the
      // only way to list them, so the backlog view is inherently
      // admin-PIN-gated with no separate check needed.
      const snap = await db.collection("feedback").orderBy("createdAt", "desc").limit(200).get();
      const items = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      return resp(200, { ok: true, items });
    }

    if (body.action === "list_audit_log") {
      // Auth Phase 2 -- surfaces what writeAuditLog() above records.
      // firestore.rules already lets a signed-in caller with audit.view
      // (or owner) read audit_logs directly, but this PIN-gated path
      // works for the CURRENT PIN-only admin mode too, same precedent as
      // list_feedback just above (a client-side Firestore read would need
      // a real signed-in claims-bearing user, which Phase 2 doesn't yet
      // require of admin mode -- see "Shared Firestore, dev/prod risk
      // boundary" in docs/AUTH_DESIGN.md for why that's still true).
      // ts is a plain Date.now() number (see writeAuditLog()'s comment on
      // why -- matches auth.js's Phase 1 audit writer exactly), not a
      // Firestore Timestamp, so no server->client conversion is needed
      // here the way there would be for a serverTimestamp() field.
      const snap = await db.collection("audit_logs").orderBy("ts", "desc").limit(200).get();
      const items = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      return resp(200, { ok: true, items });
    }

    if (body.action === "archive_building") {
      // Replaces the old hard-delete-only path (delete_building above,
      // "can't be undone") with a recoverable soft delete -- Mark's actual
      // need was "get a wrong/junk building out of my way," not "destroy
      // its history forever," and the old path was the ONLY option, which
      // meant real history sometimes got destroyed just to clear clutter.
      // Purely an additive flag -- never touches roofs[]/companyCamProjectId/
      // building_history_events/reports at all, so nothing about the
      // building's data changes, only its visibility in default lists (see
      // renderHistoryList()/rmBpRender()/etc. in index.html, all of which
      // now filter archived out by default). See "Building archive" in
      // DEV_NOTES.md.
      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      const bldRef = db.collection("buildings").doc(buildingId);
      const bldSnap = await bldRef.get();
      if (!bldSnap.exists) return resp(404, { error: "Building not found" });
      const bldBefore = bldSnap.data();
      await bldRef.set({ archived: true, archivedAt: Date.now() }, { merge: true });
      await writeAuditLog(db, event, "archive_building", { collection: "buildings", id: buildingId },
        { archived: !!bldBefore.archived, name: bldBefore.name || null }, { archived: true });
      return resp(200, { ok: true });
    }

    if (body.action === "unarchive_building") {
      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      const bldRef = db.collection("buildings").doc(buildingId);
      const bldSnap = await bldRef.get();
      if (!bldSnap.exists) return resp(404, { error: "Building not found" });
      await bldRef.set({ archived: false, archivedAt: null }, { merge: true });
      await writeAuditLog(db, event, "unarchive_building", { collection: "buildings", id: buildingId },
        { archived: true }, { archived: false });
      return resp(200, { ok: true });
    }

    if (body.action === "move_roof") {
      // Mark: traced a roof onto the wrong building with no way to fix it
      // short of admin-deleting the whole wrong building (destroying
      // everything else on it too). A roof isn't just a roofs[] array
      // entry -- building_history_events/reports docs reference it by
      // (buildingId, roofId) pair too (see DATA_MODEL.md), so a real move
      // has to re-point every one of those, not just relocate the roofs[]
      // entry itself, or the moved roof's history would silently vanish
      // from both buildings' timelines. High-blast-radius, multi-collection
      // write -- same admin-PIN-gated + audited treatment as every other
      // cross-cutting building/roof action in this file, not a plain
      // client write even though firestore.rules would technically allow
      // one. See "Move/reassign a roof to a different building" in
      // DEV_NOTES.md.
      const sourceBuildingId = String(body.sourceBuildingId || "");
      const destBuildingId = String(body.destBuildingId || "");
      const roofId = String(body.roofId || "");
      if (!sourceBuildingId || !destBuildingId || !roofId) {
        return resp(400, { error: "Missing sourceBuildingId, destBuildingId, or roofId" });
      }
      if (sourceBuildingId === destBuildingId) return resp(400, { error: "Source and destination are the same building" });

      const [sourceSnap, destSnap] = await Promise.all([
        db.collection("buildings").doc(sourceBuildingId).get(),
        db.collection("buildings").doc(destBuildingId).get()
      ]);
      if (!sourceSnap.exists) return resp(404, { error: "Source building not found" });
      if (!destSnap.exists) return resp(404, { error: "Destination building not found" });
      const sourceBld = sourceSnap.data();
      const destBld = destSnap.data();

      const sourceRoofs = getBuildingRoofsServer(sourceBld);
      const roofIdx = sourceRoofs.findIndex(r => r.id === roofId);
      if (roofIdx === -1) return resp(404, { error: "Roof not found on the source building" });
      const movingRoof = sourceRoofs[roofIdx];

      // Same duplicate-name handling as the client's rmResolveUniqueRoofLabel()
      // (see index.html) -- a moved roof landing on a building that already
      // has a roof with the same label gets auto-suffixed rather than
      // silently colliding, no server-side prompt/confirm loop possible
      // here so this always just picks the suggestion.
      const destRoofs = getBuildingRoofsServer(destBld);
      const takenLabels = destRoofs.map(r => String((r.label || "")).trim().toLowerCase());
      let newLabel = movingRoof.label || "Roof";
      if (takenLabels.indexOf(newLabel.trim().toLowerCase()) !== -1) {
        let n = 2, candidate;
        do { candidate = newLabel + " (" + n + ")"; n++; }
        while (takenLabels.indexOf(candidate.trim().toLowerCase()) !== -1);
        newLabel = candidate;
      }
      const movedRoof = Object.assign({}, movingRoof, { label: newLabel, updatedAt: Date.now() });

      const newSourceRoofs = sourceRoofs.slice(0, roofIdx).concat(sourceRoofs.slice(roofIdx + 1));
      const newDestRoofs = destRoofs.concat([movedRoof]);

      const sourcePatch = { roofs: newSourceRoofs, updatedAt: Date.now() };
      // If that was the source building's ONLY roof, its legacy mirror
      // fields (roof_outlines/roof_assets/roof_base_map_*) still point at
      // the roof that just left -- clear them so getBuildingRoofs() falls
      // back to synthesizing a genuinely empty default roof instead of
      // resurrecting stale data for a roof that now lives elsewhere. Same
      // dual-write convention saveBuildingRoofs()/set_building_roof_map
      // already use, just in reverse (un-mirroring instead of mirroring).
      if (newSourceRoofs.length === 0) {
        sourcePatch.roofSystem = "";
        sourcePatch.roof_base_map_type = null;
        sourcePatch.roof_base_map_url = null;
        sourcePatch.roof_base_map_bounds = null;
        sourcePatch.roof_base_map_synthetic = false;
        sourcePatch.roof_assets = [];
        sourcePatch.roof_outlines = [];
      } else if (newSourceRoofs.length === 1) {
        const only = newSourceRoofs[0];
        sourcePatch.roofSystem = only.roofSystem || "";
        sourcePatch.roof_base_map_type = only.roof_base_map_type || null;
        sourcePatch.roof_base_map_url = only.roof_base_map_url || null;
        sourcePatch.roof_base_map_bounds = only.roof_base_map_bounds || null;
        sourcePatch.roof_base_map_synthetic = only.roof_base_map_synthetic || false;
        sourcePatch.roof_assets = only.roof_assets || [];
        sourcePatch.roof_outlines = only.roof_outlines || [];
      }
      const destPatch = { roofs: newDestRoofs, updatedAt: Date.now() };
      if (newDestRoofs.length === 1) {
        const only = newDestRoofs[0];
        destPatch.roofSystem = only.roofSystem || "";
        destPatch.roof_base_map_type = only.roof_base_map_type || null;
        destPatch.roof_base_map_url = only.roof_base_map_url || null;
        destPatch.roof_base_map_bounds = only.roof_base_map_bounds || null;
        destPatch.roof_base_map_synthetic = only.roof_base_map_synthetic || false;
        destPatch.roof_assets = only.roof_assets || [];
        destPatch.roof_outlines = only.roof_outlines || [];
      }

      // Re-point every building_history_events/reports doc for this
      // specific roof so BOTH buildings' timelines/roof maps stay accurate
      // -- the source building's history for this roof would otherwise
      // still claim it (a roof that no longer exists there), and the
      // destination's history would be missing it entirely.
      const [evtSnap, repSnap] = await Promise.all([
        db.collection("building_history_events").where("buildingId", "==", sourceBuildingId).where("roofId", "==", roofId).get(),
        db.collection("reports").where("buildingId", "==", sourceBuildingId).where("roofId", "==", roofId).get()
      ]);
      const batch = db.batch();
      batch.set(db.collection("buildings").doc(sourceBuildingId), sourcePatch, { merge: true });
      batch.set(db.collection("buildings").doc(destBuildingId), destPatch, { merge: true });
      const reassign = {
        buildingId: destBuildingId, buildingName: destBld.name || "",
        customerId: destBld.customerId || null, customerName: destBld.customerName || ""
      };
      evtSnap.forEach(d => batch.set(d.ref, reassign, { merge: true }));
      repSnap.forEach(d => batch.set(d.ref, reassign, { merge: true }));
      await batch.commit();

      await writeAuditLog(db, event, "move_roof",
        { collection: "buildings", id: sourceBuildingId, roofId: roofId },
        { sourceBuildingId, sourceBuildingName: sourceBld.name || null, roofLabel: movingRoof.label || null },
        { destBuildingId, destBuildingName: destBld.name || null, newLabel: newLabel,
          movedEvents: evtSnap.size, movedReports: repSnap.size });
      return resp(200, { ok: true, movedEvents: evtSnap.size, movedReports: repSnap.size, newLabel: newLabel });
    }

    if (body.action === "set_photo_size_pref") {
      // Global (not per-user, not per-work-order) photo size — used to be
      // a client-only localStorage preference; now a single admin-set
      // value everyone picks up on load (see loadGlobalPhotoSizePref() in
      // index.html). Same admin-PIN-gated pattern as the settings above,
      // even though this one isn't destructive — it affects every photo
      // every user takes from here on, so it shouldn't be a client-side-
      // only check either.
      const ALLOWED_SIZES = ["small", "medium", "large"];
      const value = String(body.value || "");
      if (ALLOWED_SIZES.indexOf(value) === -1) return resp(400, { error: "Invalid photo size value" });
      await db.collection("app_settings").doc("global").set(
        { photoSizePref: value, updatedAt: Date.now() }, { merge: true });
      return resp(200, { ok: true });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
