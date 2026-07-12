// Shared server-side identity/permission verification for RoofOps auth
// (Phase 1 -- see docs/AUTH_DESIGN.md). This is the ONE place that turns
// a client-supplied Authorization header into a VERIFIED identity -- a
// client can put anything it wants into a JS variable or a request body,
// but it cannot forge a Firebase ID token's signature, so
// admin.auth().verifyIdToken() here is the actual trust boundary, not
// anything the client sends about itself.
//
// Custom claims on the verified token are intentionally small
// ({ owner, role, mfaOk } only -- see "Custom claims size" in
// AUTH_DESIGN.md) -- real permission resolution happens here, server-side,
// by reading the LIVE roles/{roleId} doc, never by trusting a
// pre-resolved grid embedded in the token.
const admin = require("firebase-admin");
const { PERMISSION_KEYS } = require("./permissions");

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set. Add it in Netlify > Environment variables, then redeploy.");
    let creds;
    try { creds = JSON.parse(raw); }
    catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON."); }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  return admin;
}
function getDb() { return getAdmin().firestore(); }
function getAuth() { return getAdmin().auth(); }

// Extracts the bearer token from a Netlify Function event's headers.
// Header names arrive lowercased in Netlify's event.headers.
function extractBearerToken(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// Verifies the caller's ID token and returns their identity + claims, or
// throws. checkRevoked:true additionally rejects a token whose session was
// explicitly revoked (admin.auth().revokeRefreshTokens()) even if the
// token itself hasn't expired yet -- needed for Phase 4's disable/recovery
// flows to take effect immediately rather than waiting out the token's
// natural ~1hr expiry.
async function verifyCaller(event, opts) {
  opts = opts || {};
  const token = extractBearerToken(event);
  if (!token) {
    const err = new Error("Missing Authorization bearer token");
    err.statusCode = 401;
    throw err;
  }
  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token, !!opts.checkRevoked);
  } catch (e) {
    const err = new Error("Invalid or expired session");
    err.statusCode = 401;
    throw err;
  }
  return {
    uid: decoded.uid,
    email: decoded.email || null,
    owner: decoded.owner === true,
    role: typeof decoded.role === "string" ? decoded.role : null,
    mfaOk: decoded.mfaOk === true
  };
}

// Resolves a role id's LIVE permission value for one key by reading the
// roles/{roleId} doc fresh -- never cached across requests, so a role
// EDIT (not just a role re-assignment) takes effect on the very next
// permission check with zero extra work, per the claims-size design note.
async function getPermissionValue(roleId, permKey) {
  if (!roleId || PERMISSION_KEYS.indexOf(permKey) === -1) return false;
  const snap = await getDb().collection("roles").doc(roleId).get();
  if (!snap.exists) return false;
  const perms = snap.data().permissions || {};
  return perms[permKey] === undefined ? false : perms[permKey];
}

// Convenience combo: verify the caller, then require they hold a given
// permission (unconditionally granted -- true only; a "proj"/"own"/
// "billing" scoped value does NOT satisfy this simple check, since scope
// resolution against a specific target document is Phase 2/3 work, not
// something this generic helper can know). Owner always passes, matching
// "owner: ALL permissions." Throws (with .statusCode) on any failure --
// missing/invalid token, wrong permission, whatever -- so callers can
// wrap one try/catch around both steps.
async function requirePermission(event, permKey) {
  const caller = await verifyCaller(event);
  if (caller.owner) return caller;
  const value = await getPermissionValue(caller.role, permKey);
  if (value !== true) {
    const err = new Error("Forbidden: missing permission " + permKey);
    err.statusCode = 403;
    throw err;
  }
  return caller;
}

// Optional-identity variant of verifyCaller() -- never throws, returns null
// for "no token" or "token invalid/expired" instead. Historically used by
// admin.js's PIN-gated actions to opportunistically capture a richer actor
// identity in the audit log when one happened to be available; admin.js is
// claims-only now (the PIN is fully removed as of Auth Phase 5, see
// docs/AUTH_DESIGN.md) and calls requirePermission()/verifyCaller()
// directly instead. Kept as general-purpose infrastructure for any future
// caller that genuinely needs an optional, non-blocking identity check --
// currently unused.
async function tryVerifyCaller(event) {
  try { return await verifyCaller(event); }
  catch (e) { return null; }
}

module.exports = { getAdmin, getDb, getAuth, verifyCaller, tryVerifyCaller, getPermissionValue, requirePermission };
