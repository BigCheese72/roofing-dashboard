// Change-order workflow actions (Auth Phase 5 accelerated slice -- see
// "Change-order workflow" and "Phase 5" in docs/AUTH_DESIGN.md). The full
// 5-stage workflow (Draft -> Requested -> Pricing Approved -> Report
// Approved -> Sent) is Phase 3, not built here -- this ships exactly one
// real, claims-gated action (approve_pricing) as a genuine enforcement
// point for the changeorder.approve_pricing permission, proving the
// permission actually works end-to-end rather than leaving it as an
// unused key in permissions.js with nothing behind it.
//
// Approval state is NOT a field on the wide-open workorders/{id} doc
// (firestore.rules has that collection at `allow read, write: if true` for
// production compatibility -- see "Shared Firestore, dev/prod risk
// boundary" in docs/AUTH_DESIGN.md). It lives in a brand-new subcollection,
// workorders/{id}/changeorder_approvals, that firestore.rules locks to
// write:false for every client -- a genuinely new write path with no
// legacy production reliance, so it can be fully server-only from day one
// (same pattern Phase 1 used for roles/users/audit_logs). A field_tech (or
// anyone) attempting to write approval state directly via the Firestore
// client SDK is blocked by rules alone, with zero dependency on this
// function ever being called correctly.
const { getDb, requirePermission } = require("./lib/authGuard");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

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

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  try {
    const db = getDb();

    if (body.action === "approve_pricing") {
      let caller;
      try { caller = await requirePermission(event, "changeorder.approve_pricing"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const workOrderId = String(body.workOrderId || "");
      if (!workOrderId || !SAFE_ID.test(workOrderId)) return resp(400, { error: "Invalid workOrderId" });
      const notes = typeof body.notes === "string" ? body.notes.slice(0, 2000) : "";

      const approvalRef = db.collection("workorders").doc(workOrderId).collection("changeorder_approvals").doc("current");
      const existingSnap = await approvalRef.get();
      const before = existingSnap.exists ? existingSnap.data() : null;
      const after = {
        stage: "pricing_approved",
        approvedByUid: caller.uid,
        approvedByEmail: caller.email,
        approvedByRole: caller.owner ? "owner" : caller.role,
        approvedAt: Date.now(),
        notes: notes
      };
      await approvalRef.set(after);
      await writeAuditLog(db, caller, "approve_changeorder_pricing",
        { collection: "workorders", id: workOrderId, subcollection: "changeorder_approvals" }, before, after);
      return resp(200, { ok: true });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(e.statusCode || 500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
