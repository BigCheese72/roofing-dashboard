// RoofOps auth: identity + roles (see docs/AUTH_DESIGN.md). admin.js and
// every other privileged server function are claims-only as of Auth Phase
// 5 -- there is no PIN left anywhere in this app for this file to be
// "layered alongside."
//
// Every privileged write in this file goes through the Firebase Admin
// SDK (not subject to Firestore rules) -- this is deliberate: custom
// claims and the users/{uid} privilege fields must have NO client write
// path at all, and Admin-SDK-only is what actually guarantees that,
// exactly like admin.js already does for deletes/roof-map/profile writes.
const crypto = require("crypto");
const { getDb, getAuth, verifyCaller, getPermissionValue } = require("./lib/authGuard");
const { SEED_ROLES } = require("./lib/permissions");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function writeAudit(db, entry) {
  // Best-effort -- Phase 2 formalizes audit_logs' rules (deny update/delete
  // to everyone) and expands what's logged everywhere else in the app.
  // Started here in Phase 1 since role/claim changes are exactly the
  // highest-risk actions the audit log exists for -- no reason to wait.
  try {
    await db.collection("audit_logs").doc().set(Object.assign({
      ts: Date.now()
    }, entry));
  } catch (e) { /* never let an audit-log failure block the real action */ }
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
    const auth = getAuth();

    // ---- seed_roles: writes/re-syncs the 9 approved roles from code-defined
    // SEED_ROLES. Idempotent (overwrites only the SEED_ROLES ids, never
    // touches any other role doc). Usable two ways: before any owner exists
    // (bootstrap secret), or afterward by a verified owner (to re-apply a
    // code-level grid update). Does NOT touch custom, non-seed roles a
    // future role-editor might create. ----
    if (body.action === "seed_roles") {
      const bootstrapDoc = await db.collection("app_settings").doc("auth_bootstrap").get();
      const alreadyBootstrapped = bootstrapDoc.exists && bootstrapDoc.data().ownerBootstrapped === true;
      if (!alreadyBootstrapped) {
        const secret = process.env.OWNER_BOOTSTRAP_SECRET;
        if (!secret) return resp(500, { error: "OWNER_BOOTSTRAP_SECRET is not set. Add it in Netlify > Environment variables, then redeploy." });
        if (body.secret !== secret) return resp(403, { error: "Wrong bootstrap secret" });
      } else {
        let caller;
        try { caller = await verifyCaller(event); }
        catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
        if (!caller.owner) return resp(403, { error: "Owner only" });
      }
      const batch = db.batch();
      SEED_ROLES.forEach(r => {
        batch.set(db.collection("roles").doc(r.id), {
          id: r.id, label: r.label, description: r.description,
          permissions: r.permissions, isSystem: !!r.isSystem, rank: r.rank || 0,
          updatedAt: Date.now()
        }, { merge: false });
      });
      await batch.commit();
      return resp(200, { ok: true, seeded: SEED_ROLES.map(r => r.id) });
    }

    // ---- bootstrap_owner: one-time-only first-owner creation. Protected by
    // a secret env var (never shipped to the browser) rather than a caller
    // permission, since there IS no owner yet for the normal auth path to
    // check against. Refuses outright once app_settings/auth_bootstrap
    // says an owner already exists -- not reusable, not a standing backdoor,
    // a single-use setup step. ----
    if (body.action === "bootstrap_owner") {
      const secret = process.env.OWNER_BOOTSTRAP_SECRET;
      if (!secret) return resp(500, { error: "OWNER_BOOTSTRAP_SECRET is not set. Add it in Netlify > Environment variables, then redeploy." });
      if (body.secret !== secret) return resp(403, { error: "Wrong bootstrap secret" });

      const bootstrapRef = db.collection("app_settings").doc("auth_bootstrap");
      const bootstrapDoc = await bootstrapRef.get();
      if (bootstrapDoc.exists && bootstrapDoc.data().ownerBootstrapped === true) {
        return resp(409, { error: "Owner already bootstrapped -- this is a one-time action." });
      }
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const displayName = String(body.displayName || "").trim();
      if (!email || !password) return resp(400, { error: "Missing email or password" });

      const userRecord = await auth.createUser({ email, password, displayName: displayName || undefined });
      await auth.setCustomUserClaims(userRecord.uid, { owner: true, role: "owner", mfaOk: false });
      await db.collection("users").doc(userRecord.uid).set({
        uid: userRecord.uid, email, displayName: displayName || "",
        role: "owner", permissions: {}, projectRoles: {},
        status: "active", mfaEnrolled: false, owner: true,
        createdAt: Date.now(), updatedAt: Date.now(), createdBy: "bootstrap", lastLoginAt: null
      });
      await bootstrapRef.set({ ownerBootstrapped: true, bootstrappedAt: Date.now(), ownerUid: userRecord.uid }, { merge: true });
      await writeAudit(db, {
        actorUid: userRecord.uid, actorRole: "owner", action: "bootstrap_owner",
        target: { collection: "users", id: userRecord.uid }, before: null, after: { role: "owner" }
      });
      return resp(200, { ok: true, uid: userRecord.uid });
    }

    // ---- create_user: the user-management screen's "invite/create" action
    // (see docs/AUTH_DESIGN.md's Phase 5). Same hierarchy invariant as
    // assign_role below, applied to the NEW user's initial role rather than
    // a change to an existing one: "owner" can never be created here (the
    // owner role is unique and only ever set by bootstrap_owner or moved by
    // transfer_owner, never duplicated); creating an "admin" requires the
    // caller to BE owner; anything else requires owner OR
    // users.manage_nonadmin, matching "admins manage non-admin users only."
    //
    // The new account's password is a throwaway, cryptographically random
    // value generated here and NEVER returned to the caller or stored
    // anywhere -- this endpoint hands back only {ok, uid, email}. The
    // caller's browser is expected to immediately call the public
    // fauth.sendPasswordResetEmail(email) client SDK method so the new user
    // sets their own password via Firebase's own built-in reset flow. This
    // means no human (not Mark, not an admin, not this assistant) ever
    // types, sees, or transmits another person's password at any point in
    // this flow. ----
    if (body.action === "create_user") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const email = String(body.email || "").trim().toLowerCase();
      const roleId = String(body.roleId || "");
      const displayName = String(body.displayName || "").trim();
      if (!email || !EMAIL_RE.test(email)) return resp(400, { error: "Invalid email" });
      if (!roleId) return resp(400, { error: "Missing roleId" });
      if (roleId === "owner") return resp(400, { error: "The owner role can't be assigned here -- it's unique, set only via bootstrap or transfer_owner" });

      const roleDoc = await db.collection("roles").doc(roleId).get();
      if (!roleDoc.exists) return resp(400, { error: "Unknown role: " + roleId });

      if (roleId === "admin") {
        if (!caller.owner) return resp(403, { error: "Only the owner may create an admin" });
      } else {
        if (!caller.owner) {
          const canManage = await getPermissionValue(caller.role, "users.manage_nonadmin");
          if (canManage !== true) return resp(403, { error: "Forbidden: missing permission users.manage_nonadmin" });
        }
      }

      const tempPassword = crypto.randomBytes(24).toString("base64");
      let userRecord;
      try {
        userRecord = await getAuth().createUser({ email: email, password: tempPassword, displayName: displayName || undefined });
      } catch (e) {
        if (e && e.code === "auth/email-already-exists") return resp(409, { error: "A user with that email already exists" });
        throw e;
      }
      await getAuth().setCustomUserClaims(userRecord.uid, { owner: false, role: roleId, mfaOk: false });
      await db.collection("users").doc(userRecord.uid).set({
        uid: userRecord.uid, email: email, displayName: displayName || "",
        role: roleId, permissions: {}, projectRoles: {},
        status: "active", mfaEnrolled: false, owner: false,
        createdAt: Date.now(), updatedAt: Date.now(), createdBy: caller.uid, lastLoginAt: null
      });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: caller.owner ? "owner" : caller.role, action: "create_user",
        target: { collection: "users", id: userRecord.uid }, before: null, after: { email: email, role: roleId }
      });
      return resp(200, { ok: true, uid: userRecord.uid, email: email });
    }

    // ---- assign_role: the ONLY way a user's role/claims change. Hard
    // rules, not just permission-key checks, since these are hierarchy
    // invariants: no self-role-changes (blocks the exact "field_tech tries
    // to self-promote" attack), and granting/revoking the "admin" role
    // specifically requires the caller to BE owner, regardless of any
    // users.manage_* permission value -- "ONLY owner may create/promote/
    // demote/remove admins" is a hierarchy rule, not a delegable
    // permission. "owner" itself is never assignable here -- see
    // transfer_owner below. ----
    if (body.action === "assign_role") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const targetUid = String(body.targetUid || "");
      const roleId = String(body.roleId || "");
      if (!targetUid || !roleId) return resp(400, { error: "Missing targetUid or roleId" });
      if (targetUid === caller.uid) return resp(403, { error: "Cannot change your own role" });
      if (roleId === "owner") return resp(400, { error: "Use transfer_owner to grant the owner role" });

      const roleDoc = await db.collection("roles").doc(roleId).get();
      if (!roleDoc.exists) return resp(400, { error: "Unknown role: " + roleId });

      const targetUserDoc = await db.collection("users").doc(targetUid).get();
      const targetCurrentRole = targetUserDoc.exists ? targetUserDoc.data().role : null;
      const involvesAdmin = roleId === "admin" || targetCurrentRole === "admin";

      if (involvesAdmin) {
        if (!caller.owner) return resp(403, { error: "Only the owner may grant or remove admin" });
      } else {
        if (!caller.owner) {
          const canManage = await getPermissionValue(caller.role, "users.manage_nonadmin");
          if (canManage !== true) return resp(403, { error: "Forbidden: missing permission users.manage_nonadmin" });
        }
      }
      if (targetCurrentRole === "owner") {
        return resp(403, { error: "Cannot change the owner's role -- transfer ownership first" });
      }

      const targetAuthRecord = await getAuth().getUser(targetUid);
      const existingMfaOk = (targetAuthRecord.customClaims && targetAuthRecord.customClaims.mfaOk) === true;
      await getAuth().setCustomUserClaims(targetUid, { owner: false, role: roleId, mfaOk: existingMfaOk });
      await getAuth().revokeRefreshTokens(targetUid); // takes effect immediately, not after natural token expiry
      await db.collection("users").doc(targetUid).set({
        role: roleId, updatedAt: Date.now()
      }, { merge: true });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: caller.role, action: "assign_role",
        target: { collection: "users", id: targetUid },
        before: { role: targetCurrentRole }, after: { role: roleId }
      });
      return resp(200, { ok: true });
    }

    // ---- transfer_owner: separate from assign_role on purpose -- moving
    // owner status is uniquely sensitive (exactly one owner should exist),
    // so it gets its own explicit action rather than being one more roleId
    // option in the generic assignment path. Caller must currently BE
    // owner; the outgoing owner is demoted to admin (never left with no
    // role at all), the incoming owner's claims/mirror doc are updated,
    // both sessions are revoked. ----
    if (body.action === "transfer_owner") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
      if (!caller.owner) return resp(403, { error: "Only the current owner may transfer ownership" });

      const targetUid = String(body.targetUid || "");
      if (!targetUid) return resp(400, { error: "Missing targetUid" });
      if (targetUid === caller.uid) return resp(400, { error: "Already the owner" });

      const targetUserDoc = await db.collection("users").doc(targetUid).get();
      if (!targetUserDoc.exists) return resp(400, { error: "Target user not found" });

      await getAuth().setCustomUserClaims(targetUid, { owner: true, role: "owner", mfaOk: false });
      await getAuth().setCustomUserClaims(caller.uid, { owner: false, role: "admin", mfaOk: false });
      await Promise.all([getAuth().revokeRefreshTokens(targetUid), getAuth().revokeRefreshTokens(caller.uid)]);
      const batch = db.batch();
      batch.set(db.collection("users").doc(targetUid), { role: "owner", updatedAt: Date.now() }, { merge: true });
      batch.set(db.collection("users").doc(caller.uid), { role: "admin", updatedAt: Date.now() }, { merge: true });
      await batch.commit();
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: "owner", action: "transfer_owner",
        target: { collection: "users", id: targetUid },
        before: { owner: caller.uid }, after: { owner: targetUid }
      });
      return resp(200, { ok: true });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(e.statusCode || 500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
