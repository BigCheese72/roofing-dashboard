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

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
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
      const [evtSnap, repSnap] = await Promise.all([
        db.collection("building_history_events").where("buildingId", "==", buildingId).get(),
        db.collection("reports").where("buildingId", "==", buildingId).get()
      ]);
      const batch = db.batch();
      evtSnap.forEach(d => batch.delete(d.ref));
      repSnap.forEach(d => batch.delete(d.ref));
      batch.delete(db.collection("buildings").doc(buildingId));
      await batch.commit();
      return resp(200, { ok: true, deletedEvents: evtSnap.size, deletedReports: repSnap.size });
    }

    if (body.action === "delete_history_event") {
      const eventId = String(body.eventId || "");
      if (!eventId) return resp(400, { error: "Missing eventId" });
      const batch = db.batch();
      batch.delete(db.collection("building_history_events").doc(eventId));
      batch.delete(db.collection("reports").doc(eventId)); // same id — see logReportAndHistoryEvent in index.html
      await batch.commit();
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
      roofs[idx] = Object.assign({}, roofs[idx], {
        roof_base_map_type: type,
        roof_base_map_url: url,
        roof_base_map_bounds: bounds,
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
        patch.roof_base_map_updated_at = Date.now();
      }
      await bldRef.set(patch, { merge: true });
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
      return resp(200, { ok: true });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
