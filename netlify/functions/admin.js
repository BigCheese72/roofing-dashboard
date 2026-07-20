// Privileged admin operations. This is the ONLY place in the app allowed to
// delete building/report/history records — firestore.rules (repo root)
// blocks client-side deletes on those collections entirely, so the only
// path to destroy data is through here, using the Firebase Admin SDK
// (which is not subject to Firestore security rules).
//
// Auth Phase 5 (per Mark's direct order: "Kill the PIN and finish the
// logins" -- see docs/AUTH_DESIGN.md): every action below is gated by a
// VERIFIED caller's Firebase custom claims, resolved against the live
// roles/{roleId} permission grid (requirePermission() in lib/authGuard.js).
// The ADMIN_PIN environment variable is not read anywhere in this file --
// there is no PIN check left to bypass, not even as a fallback. A missing
// or insufficient token is rejected the same way regardless of anything
// else in the request body.
const { getDb, requirePermission, hostnameFromEvent } = require("./lib/authGuard");
const { PERMISSION_KEYS, PERMISSION_SCOPES, isValidPermissionValue } = require("./lib/permissions");
const { purgeLabelsForBuilding } = require("./lib/aiLabels");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Auth Phase 2/5 -- immutable audit log for admin.js's mutating actions
// (see "Audit log" in docs/AUTH_DESIGN.md: append-only, rules deny
// update/delete to EVERYONE including owner, written only via the Admin
// SDK here, never subject to rules at all).
//
// caller is always a real verified identity now (requirePermission()
// throws before any action body runs otherwise) -- no more optional
// tryVerifyCaller()/"pin_only" degradation, since there's no PIN-only path
// left for any of these actions to take. A logging failure NEVER blocks
// the underlying admin action -- the write already happened; losing the
// audit trail for one action is a lesser failure than silently reporting
// the action itself failed when it didn't.
async function writeAuditLog(db, caller, action, target, before, after) {
  try {
    await db.collection("audit_logs").doc().set({
      ts: Date.now(),
      actorUid: caller.uid,
      actorEmail: caller.email,
      actorRole: caller.owner ? "owner" : caller.role,
      actorMethod: "claims",
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

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  try {
    const db = getDb(hostnameFromEvent(event));

    if (body.action === "delete_building") {
      // Hard delete -- the "purge" tier per docs/AUTH_DESIGN.md ("No
      // client deletes anywhere... purge has no client path at all --
      // server function, callable only when the caller's claims have
      // owner === true"). buildings.purge resolves to owner-only via the
      // seed grid (admin is explicitly excluded), so this IS an
      // owner-only check, just expressed as a data-driven permission
      // rather than a hardcoded caller.owner test.
      let caller;
      try { caller = await requirePermission(event, "buildings.purge"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

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
      // Deletion cascade for AI training labels (see lib/aiLabels.js +
      // "AI training labels" in DEV_NOTES.md): label records reference this
      // building's photos, which are customer property -- purge them BEFORE
      // the building doc itself, so a mid-delete failure leaves the
      // building (and a retry path) intact rather than orphaning labels
      // behind a building that no longer exists.
      const deletedLabels = await purgeLabelsForBuilding(db, buildingId);
      const batch = db.batch();
      evtSnap.forEach(d => batch.delete(d.ref));
      repSnap.forEach(d => batch.delete(d.ref));
      batch.delete(db.collection("buildings").doc(buildingId));
      await batch.commit();
      await writeAuditLog(db, caller, "delete_building", { collection: "buildings", id: buildingId },
        bldBefore ? { name: bldBefore.name || null, address: bldBefore.address || null,
          customerId: bldBefore.customerId || null, deletedEvents: evtSnap.size, deletedReports: repSnap.size,
          deletedAiLabels: deletedLabels } : null,
        null);
      return resp(200, { ok: true, deletedEvents: evtSnap.size, deletedReports: repSnap.size, deletedAiLabels: deletedLabels });
    }

    if (body.action === "delete_history_event") {
      // Same purge tier as delete_building above -- a history event is
      // just as irreversible once gone, and there's no separate
      // permission key for "delete one event" vs "delete a building";
      // both are the same hard-delete danger class.
      let caller;
      try { caller = await requirePermission(event, "buildings.purge"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const eventId = String(body.eventId || "");
      if (!eventId) return resp(400, { error: "Missing eventId" });
      const evtSnapBefore = await db.collection("building_history_events").doc(eventId).get();
      const evtBefore = evtSnapBefore.exists ? evtSnapBefore.data() : null;
      const batch = db.batch();
      batch.delete(db.collection("building_history_events").doc(eventId));
      batch.delete(db.collection("reports").doc(eventId)); // same id — see logReportAndHistoryEvent in index.html
      await batch.commit();
      await writeAuditLog(db, caller, "delete_history_event", { collection: "building_history_events", id: eventId },
        evtBefore ? { buildingId: evtBefore.buildingId || null, workOrderType: evtBefore.workOrderType || null } : null, null);
      return resp(200, { ok: true });
    }

    if (body.action === "set_building_roof_map") {
      // Building-wide admin setting -- settings.company tier (Admin +
      // Owner, per docs/AUTH_DESIGN.md's settings split), not the owner-
      // only purge tier above.
      let caller;
      try { caller = await requirePermission(event, "settings.company"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

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
      await writeAuditLog(db, caller, "set_building_roof_map", { collection: "buildings", id: buildingId, roofId: roofs[idx].id },
        roofBefore, { roof_base_map_type: type, roof_base_map_url: url });
      return resp(200, { ok: true });
    }

    if (body.action === "set_roof_profile") {
      // Admin-editable facts ABOUT a roof (age, warranty, condition, etc.)
      // — same settings.company tier as the base-map action above.
      let caller;
      try { caller = await requirePermission(event, "settings.company"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      const roofId = body.roofId ? String(body.roofId) : null;
      const rawProfile = (body.profile && typeof body.profile === "object") ? body.profile : {};
      // Allow-list of fields — never let an arbitrary client payload write
      // unexpected keys onto a roof, even though this whole action is
      // already claims-gated.
      // areaSquares (Mark, 2026-07-19): roofers size a roof in SQUARES (100
      // sq ft), and on a multi-roof building "which one is the 34-square TPO"
      // is how a roof actually gets identified in conversation. RoofMapper can
      // only derive an area from a TRACED outline, which needs a base map --
      // and the multi-roof buildings driving this work have no imagery yet, so
      // a manually-recorded area is the only one they will have.
      const ALLOWED_PROFILE_FIELDS = ["installDate", "estimatedAgeYears", "healthScore",
        "condition", "manufacturer", "deckType", "insulationType", "warrantyProvider",
        "warrantyExpiration", "warrantyStatus", "drainageNotes", "customerContacts",
        "internalNotes", "replacementHistory", "estimatedRemainingLifeYears",
        "areaSquares"];
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
      await writeAuditLog(db, caller, "set_roof_profile", { collection: "buildings", id: buildingId, roofId: roofs[idx].id },
        profileBefore, profile);
      return resp(200, { ok: true });
    }

    if (body.action === "list_feedback") {
      // In-app Send Feedback backlog (💬 button, every screen — see
      // "Send Feedback" in DEV_NOTES.md). firestore.rules blocks client
      // reads on `feedback` entirely (create-only) -- this Admin-SDK read
      // is the only way to list them. Gated on audit.view: the closest
      // existing permission key for "sees internal operational backlog
      // data," same tier as the audit log itself just below.
      let caller;
      try { caller = await requirePermission(event, "audit.view"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const snap = await db.collection("feedback").orderBy("createdAt", "desc").limit(200).get();
      const items = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      return resp(200, { ok: true, items });
    }

    if (body.action === "list_audit_log") {
      // audit.view -- matches the permission key exactly.
      let caller;
      try { caller = await requirePermission(event, "audit.view"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      // ts is a plain Date.now() number (matches every audit_logs writer
      // in this app), not a Firestore Timestamp, so no server->client
      // conversion is needed here the way there would be for a
      // serverTimestamp() field.
      const snap = await db.collection("audit_logs").orderBy("ts", "desc").limit(200).get();
      const items = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      return resp(200, { ok: true, items });
    }

    if (body.action === "archive_building") {
      let caller;
      try { caller = await requirePermission(event, "buildings.archive"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

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
      await writeAuditLog(db, caller, "archive_building", { collection: "buildings", id: buildingId },
        { archived: !!bldBefore.archived, name: bldBefore.name || null }, { archived: true });
      return resp(200, { ok: true });
    }

    if (body.action === "unarchive_building") {
      let caller;
      try { caller = await requirePermission(event, "buildings.restore"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const buildingId = String(body.buildingId || "");
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      const bldRef = db.collection("buildings").doc(buildingId);
      const bldSnap = await bldRef.get();
      if (!bldSnap.exists) return resp(404, { error: "Building not found" });
      await bldRef.set({ archived: false, archivedAt: null }, { merge: true });
      await writeAuditLog(db, caller, "unarchive_building", { collection: "buildings", id: buildingId },
        { archived: true }, { archived: false });
      return resp(200, { ok: true });
    }

    if (body.action === "merge_buildings") {
      // Mark, 106 Orr St, 2026-07-19: one real building ended up as TWO
      // records -- "(unnamed project)" holding the base map and all 4 roofs,
      // and "Orr St Studios - Roof Eval" holding the correct name and nothing
      // else. Neither record is usable on its own, and there was no way to
      // combine them.
      //
      // This is move_roof generalised from one roof to a whole building: same
      // multi-collection re-pointing, same settings.company tier, same audit
      // discipline. It moves EVERY roof (each carrying its own base map,
      // assets and outlines), re-points EVERY history event and report --
      // unfiltered by roofId, since events predating roofs[] carry none -- and
      // carries the CompanyCam/Foundation links forward before archiving the
      // source. Archive rather than delete, matching archive_building: a merge
      // that turns out wrong must be inspectable afterwards.
      let caller;
      try { caller = await requirePermission(event, "settings.company"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const sourceBuildingId = String(body.sourceBuildingId || "");
      const destBuildingId = String(body.destBuildingId || "");
      if (!sourceBuildingId || !destBuildingId) {
        return resp(400, { error: "Missing sourceBuildingId or destBuildingId" });
      }
      if (sourceBuildingId === destBuildingId) return resp(400, { error: "Source and destination are the same building" });

      const [srcSnap, dstSnap] = await Promise.all([
        db.collection("buildings").doc(sourceBuildingId).get(),
        db.collection("buildings").doc(destBuildingId).get()
      ]);
      if (!srcSnap.exists) return resp(404, { error: "Source building not found" });
      if (!dstSnap.exists) return resp(404, { error: "Destination building not found" });
      const srcBld = srcSnap.data();
      const dstBld = dstSnap.data();

      // Only move roofs that were really stored. getBuildingRoofsServer()
      // synthesises a default roof for a building that never had roofs[], and
      // merging that phantom would plant an empty "Roof 1" on the survivor.
      const srcRoofs = Array.isArray(srcBld.roofs) ? srcBld.roofs.slice() : [];
      const dstRoofs = Array.isArray(dstBld.roofs) ? dstBld.roofs.slice() : getBuildingRoofsServer(dstBld).slice();

      // Same auto-suffix rule move_roof uses, applied across the whole batch so
      // two roofs both called "Roof 1" cannot collide on the survivor.
      // RETRY SAFETY. sourcePatch now commits LAST, so a chunk-2 failure leaves
      // the source roofs intact -- which is the point, the merge stays
      // retryable. But a retry then re-reads those roofs and would append them
      // to a destination that already received them in the failed run, and the
      // label auto-suffix below would helpfully rename the copies to "Roof 1
      // (2)" instead of catching the collision. Skip any roof already present
      // by id so a merge is idempotent.
      const dstRoofIds = {};
      dstRoofs.forEach(r => { if (r && r.id) dstRoofIds[r.id] = true; });
      const roofsToMove = srcRoofs.filter(r => !(r && r.id && dstRoofIds[r.id]));
      const taken = dstRoofs.map(r => String(r.label || "").trim().toLowerCase());
      const movedRoofs = roofsToMove.map(r => {
        let label = r.label || "Roof";
        if (taken.indexOf(label.trim().toLowerCase()) !== -1) {
          let n = 2, candidate;
          do { candidate = label + " (" + n + ")"; n++; }
          while (taken.indexOf(candidate.trim().toLowerCase()) !== -1);
          label = candidate;
        }
        taken.push(label.trim().toLowerCase());
        return Object.assign({}, r, { label: label, updatedAt: Date.now() });
      });
      const newDestRoofs = dstRoofs.concat(movedRoofs);

      // Best name wins. The survivor is chosen by the caller, but its name may
      // still be the placeholder -- so prefer, in order: an explicit name the
      // caller passed, the survivor's own real name, the source's real name,
      // then whatever is left. "(unnamed project)" is mapProject()'s display
      // fallback for a nameless CompanyCam project and must never win.
      const PLACEHOLDER = "(unnamed project)";
      const realName = (n) => (n && String(n).trim() && String(n).trim() !== PLACEHOLDER) ? String(n).trim() : "";
      const chosenName = realName(body.survivingName) || realName(dstBld.name) ||
        realName(srcBld.name) || String(dstBld.name || srcBld.name || "").trim();

      const destPatch = { roofs: newDestRoofs, updatedAt: Date.now() };
      if (chosenName) destPatch.name = chosenName;
      // Carry links forward ONLY where the survivor has none -- a merge must
      // never silently re-point a building that already has its own link.
      if (!dstBld.companyCamProjectId && srcBld.companyCamProjectId) {
        destPatch.companyCamProjectId = srcBld.companyCamProjectId;
        destPatch.companyCamProjectName = srcBld.companyCamProjectName || "";
      }
      if (!dstBld.foundationJobNo && srcBld.foundationJobNo) {
        destPatch.foundationJobNo = srcBld.foundationJobNo;
        destPatch.foundationCustomerNo = srcBld.foundationCustomerNo || null;
        destPatch.foundationAddress = srcBld.foundationAddress || "";
      }
      if (!dstBld.location && srcBld.location) destPatch.location = srcBld.location;
      // Legacy single-roof mirror fields, same convention as move_roof.
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

      const sourcePatch = {
        roofs: [], archived: true, archivedAt: Date.now(),
        mergedIntoBuildingId: destBuildingId, updatedAt: Date.now(),
        roofSystem: "", roof_base_map_type: null, roof_base_map_url: null,
        roof_base_map_bounds: null, roof_base_map_synthetic: false,
        roof_assets: [], roof_outlines: []
      };

      // Unfiltered by roofId on purpose: a building's history includes events
      // written before roofs[] existed, which carry no roofId at all. Filtering
      // by roof would strand exactly the oldest history a merge is meant to
      // rescue.
      // Mark, KOMU 2026-07-19: this list used to be events + reports ONLY, so a
      // merge left every saved WORK ORDER still pointing at the loser. The
      // inspection he was running resolved to the archived record -- which the
      // merge had just emptied (roofs: []), so getBuildingRoofs() synthesised a
      // single phantom "Roof 1" with no base map and no history. The record
      // looked broken; it was orphaned.
      //
      // Every collection that stores a buildingId belongs here. Archived/voided
      // work orders are re-pointed too (Mark: keep it all consistent) -- an
      // archived WO still aimed at an emptied building is a landmine the day
      // someone restores it.
      const [evtSnap, repSnap, woSnap, dprSnap] = await Promise.all([
        db.collection("building_history_events").where("buildingId", "==", sourceBuildingId).get(),
        db.collection("reports").where("buildingId", "==", sourceBuildingId).get(),
        db.collection("workorders").where("buildingId", "==", sourceBuildingId).get(),
        db.collection("daily_progress_reports").where("buildingId", "==", sourceBuildingId).get()
      ]);
      const reassign = {
        buildingId: destBuildingId, buildingName: chosenName || dstBld.name || "",
        customerId: dstBld.customerId || srcBld.customerId || null,
        customerName: dstBld.customerName || srcBld.customerName || ""
      };
      // Firestore caps a batch at 500 writes; chunk so a building with a long
      // history merges rather than failing at the limit.
      const writes = [];
      writes.push({ ref: db.collection("buildings").doc(destBuildingId), data: destPatch });
      evtSnap.forEach(d => writes.push({ ref: d.ref, data: reassign }));
      repSnap.forEach(d => writes.push({ ref: d.ref, data: reassign }));
      // Work orders and DPRs carry buildingId AND the denormalised name, same
      // as the history docs -- re-point both so a reopened record resolves to
      // the survivor and reads with the survivor's name.
      woSnap.forEach(d => writes.push({ ref: d.ref, data: reassign }));
      dprSnap.forEach(d => writes.push({ ref: d.ref, data: reassign }));
      // The DESTRUCTIVE patch goes LAST, deliberately. Chunks commit
      // sequentially and are not atomic across chunk boundaries, and adding
      // work orders + DPRs is exactly what pushes a busy building past 400
      // writes into multiple chunks. With sourcePatch first, a chunk-2 failure
      // (function timeout, DEADLINE_EXCEEDED) left the source already emptied
      // and archived while records still pointed at it -- unrecoverable
      // without a hand fix, and not even audit-logged, since that write comes
      // after. Last means a mid-way failure leaves the source INTACT and the
      // whole merge safely retryable.
      writes.push({ ref: db.collection("buildings").doc(sourceBuildingId), data: sourcePatch });
      for (let i = 0; i < writes.length; i += 400) {
        const batch = db.batch();
        writes.slice(i, i + 400).forEach(w => batch.set(w.ref, w.data, { merge: true }));
        await batch.commit();
      }

      await writeAuditLog(db, caller, "merge_buildings",
        { collection: "buildings", id: sourceBuildingId },
        { sourceBuildingId, sourceName: srcBld.name || null, sourceRoofs: srcRoofs.length },
        { destBuildingId, destName: chosenName || dstBld.name || null,
          movedRoofs: movedRoofs.length, movedEvents: evtSnap.size, movedReports: repSnap.size,
          movedWorkOrders: woSnap.size, movedDprs: dprSnap.size });
      return resp(200, { ok: true, movedRoofs: movedRoofs.length,
        movedEvents: evtSnap.size, movedReports: repSnap.size,
        movedWorkOrders: woSnap.size, movedDprs: dprSnap.size,
        survivingName: chosenName });
    }

    if (body.action === "move_roof") {
      // Cross-cutting, multi-collection structural change -- same
      // settings.company tier as the other building-admin actions above.
      let caller;
      try { caller = await requirePermission(event, "settings.company"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      // Mark: traced a roof onto the wrong building with no way to fix it
      // short of admin-deleting the whole wrong building (destroying
      // everything else on it too). A roof isn't just a roofs[] array
      // entry -- building_history_events/reports docs reference it by
      // (buildingId, roofId) pair too (see DATA_MODEL.md), so a real move
      // has to re-point every one of those, not just relocate the roofs[]
      // entry itself, or the moved roof's history would silently vanish
      // from both buildings' timelines. High-blast-radius, multi-collection
      // write -- same admin-gated + audited treatment as every other
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

      await writeAuditLog(db, caller, "move_roof",
        { collection: "buildings", id: sourceBuildingId, roofId: roofId },
        { sourceBuildingId, sourceBuildingName: sourceBld.name || null, roofLabel: movingRoof.label || null },
        { destBuildingId, destBuildingName: destBld.name || null, newLabel: newLabel,
          movedEvents: evtSnap.size, movedReports: repSnap.size });
      return resp(200, { ok: true, movedEvents: evtSnap.size, movedReports: repSnap.size, newLabel: newLabel });
    }

    if (body.action === "set_photo_size_pref") {
      // Global (not per-user, not per-work-order) photo size — settings.company
      // tier, same as the other admin-settings actions, even though this
      // one isn't destructive — it affects every photo every user takes
      // from here on, so it shouldn't be a client-side-only check either.
      let caller;
      try { caller = await requirePermission(event, "settings.company"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const ALLOWED_SIZES = ["small", "medium", "large"];
      const value = String(body.value || "");
      if (ALLOWED_SIZES.indexOf(value) === -1) return resp(400, { error: "Invalid photo size value" });
      await db.collection("app_settings").doc("global").set(
        { photoSizePref: value, updatedAt: Date.now() }, { merge: true });
      return resp(200, { ok: true });
    }

    if (body.action === "list_roles") {
      // Data source for the Roles & Permissions editor (Admin page).
      // settings.security tier -- the seed grid grants it to the owner
      // ONLY (admin is explicitly excluded), so this whole editor is
      // owner-only today unless the owner deliberately grants
      // settings.security to another role through this very editor.
      // Roles are client-readable via firestore.rules anyway (not
      // secret), but the editor loads through here so the key list and
      // scope registry it renders come from the SAME code the validator
      // below enforces -- no drift between what the grid shows and what
      // the server will accept.
      let caller;
      try { caller = await requirePermission(event, "settings.security"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const snap = await db.collection("roles").get();
      const roles = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      roles.sort((a, b) => (b.rank || 0) - (a.rank || 0));
      return resp(200, { ok: true, roles, permissionKeys: PERMISSION_KEYS, permissionScopes: PERMISSION_SCOPES });
    }

    if (body.action === "set_role_permissions") {
      // Writes ONE role's edited permission grid (Roles & Permissions
      // editor's Save). Same settings.security tier as list_roles above.
      // The roles collection is the LIVE enforcement source of truth
      // (authGuard's getPermissionValue() re-reads it on every check), so
      // this takes effect on the very next permission check -- which is
      // exactly why every guardrail here is server-side, not just UI:
      let caller;
      try { caller = await requirePermission(event, "settings.security"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const roleId = String(body.roleId || "");
      if (!roleId) return resp(400, { error: "Missing roleId" });
      // Guardrail: the owner role is LOCKED to all-permissions, always.
      // Not editable, not reducible, by anyone -- including the owner
      // themself -- so there is no sequence of grid edits that can lock
      // the owner out of this editor (or anything else).
      if (roleId === "owner") {
        return resp(403, { error: "The owner role is locked to all permissions and cannot be edited." });
      }
      const roleRef = db.collection("roles").doc(roleId);
      const roleSnap = await roleRef.get();
      if (!roleSnap.exists) return resp(404, { error: "Unknown role: " + roleId });

      const incoming = (body.permissions && typeof body.permissions === "object" && !Array.isArray(body.permissions))
        ? body.permissions : null;
      if (!incoming) return resp(400, { error: "Missing permissions object" });
      // Guardrail: only keys in the code-defined PERMISSION_KEYS registry
      // may EVER appear in a role grid -- an unknown key is a hard reject
      // (whole request, nothing written), not a silent strip, so a typo'd
      // or stale client can't half-apply an edit without anyone noticing.
      const unknownKeys = Object.keys(incoming).filter(k => PERMISSION_KEYS.indexOf(k) === -1);
      if (unknownKeys.length) {
        return resp(400, { error: "Unknown permission key(s): " + unknownKeys.join(", ") });
      }
      // Values: true/false, or a scope string PERMISSION_SCOPES explicitly
      // allows for that specific key ("proj"/"own"/"billing") -- a scope on
      // a boolean-only key is rejected, since enforcement code for that key
      // wouldn't know what the scope means.
      for (const k of Object.keys(incoming)) {
        if (!isValidPermissionValue(k, incoming[k])) {
          return resp(400, { error: "Invalid value for " + k + ": " + JSON.stringify(incoming[k]) });
        }
      }

      // Merge onto the role's EXISTING grid (a partial body edits only the
      // keys it names), then normalize to exactly the registry: every
      // PERMISSION_KEYS key present (default false), any stale key from a
      // since-removed registry entry dropped.
      const existing = roleSnap.data().permissions || {};
      const normalized = {};
      PERMISSION_KEYS.forEach(k => {
        normalized[k] = incoming[k] !== undefined ? incoming[k]
          : (existing[k] !== undefined ? existing[k] : false);
      });

      // before/after in the audit entry is the DIFF (changed keys only),
      // not two full ~38-key grids -- keeps the Audit Log view legible.
      const changedBefore = {}, changedAfter = {};
      PERMISSION_KEYS.forEach(k => {
        const prev = existing[k] === undefined ? false : existing[k];
        if (prev !== normalized[k]) { changedBefore[k] = prev; changedAfter[k] = normalized[k]; }
      });
      if (!Object.keys(changedAfter).length) {
        return resp(200, { ok: true, changed: 0 });
      }

      await roleRef.set({ permissions: normalized, updatedAt: Date.now() }, { merge: true });
      await writeAuditLog(db, caller, "role_permissions_changed", { collection: "roles", id: roleId },
        changedBefore, changedAfter);
      return resp(200, { ok: true, changed: Object.keys(changedAfter).length });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(e.statusCode || 500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
