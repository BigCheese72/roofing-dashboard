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

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
