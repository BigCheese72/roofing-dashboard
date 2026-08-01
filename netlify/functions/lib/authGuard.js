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

// Environment-aware project selection (Firebase split, 2026-07-11) --
// FIREBASE_SERVICE_ACCOUNT is the SAME env var name on every Netlify
// deploy context (Production / branch deploys), just a DIFFERENT value per
// context (Netlify's per-context env var scoping) -- production resolves
// to the real watkins-service-orders service account, dev branch deploys
// resolve to watkins-service-orders-dev's. No project id/name is ever
// hardcoded here; every Admin SDK call anywhere in this app (Firestore,
// Auth, Storage) goes through this one admin.initializeApp() and picks up
// whichever project the credentials JSON actually belongs to.
//
// storageBucket is derived from the SAME credentials JSON's project_id
// (Firebase's current default bucket-naming convention is
// "{project_id}.firebasestorage.app", confirmed against production's real
// bucket) rather than a second hardcoded constant living in photos.js --
// one source of truth, correct automatically for whichever project the
// service account belongs to. FIREBASE_STORAGE_BUCKET is an optional
// override for the rare case the derived name doesn't match (e.g. a
// project still on the legacy ".appspot.com" bucket naming).
// Safety net, added after a real incident (2026-07-12): a dev-branch
// deploy briefly ran with PRODUCTION's FIREBASE_SERVICE_ACCOUNT still in
// effect (the Netlify branch-deploy env var hadn't actually taken effect
// yet), which would have made every dev-triggered server action -- admin
// actions, photo uploads, user creation, audit writes -- silently act on
// Mark's real production data while the CLIENT correctly believed it was
// talking to the dev sandbox. Silent cross-project writes are exactly the
// failure this whole split exists to prevent, so this check is deliberately
// unforgiving: if the incoming request's own hostname doesn't match which
// project the loaded service account actually belongs to, refuse to
// initialize at all rather than proceed on a guess.
//
// NOTE: this originally tried to key off Netlify's documented CONTEXT env
// var (production/deploy-preview/branch-deploy) -- confirmed EMPTY at
// runtime in this Functions environment (verified live via whoami_project:
// CONTEXT, BRANCH, DEPLOY_PRIME_URL, DEPLOY_ID were all null on a real
// invocation), so that check was silently a no-op in the one direction that
// matters most (production accidentally holding dev credentials would not
// have been caught). Switched to the incoming request's Host header
// instead -- Netlify's own routing is what decided this function instance
// should handle this request, so the Host header is tied to the actual
// dispatch decision, not a metadata var that may or may not be populated.
// Mirrors isDevEnvironment() in js/core.js exactly, server-side.
//
// hostname must be threaded in from event.headers.host by the FIRST
// getAdmin()/getDb()/getAuth() call in each function file's handler --
// admin.apps.length caches init for the process's lifetime, so only that
// first call matters, but every handler must make it (checked: admin.js,
// auth.js, photos.js, changeorders.js all prime it at the top). If no
// hostname is passed (defensive default), the check is skipped rather than
// false-tripping -- fail loud on a real mismatch, not on missing wiring.
const EXPECTED_PRODUCTION_PROJECT_ID = "watkins-service-orders";
function isDevHostname(h) {
  h = String(h || "");
  return h.indexOf("dev--") !== -1 || h === "localhost" || h.indexOf("localhost:") === 0 ||
    h === "127.0.0.1" || h.indexOf("127.0.0.1:") === 0 || h.indexOf("deploy-preview-") !== -1;
}
function getAdmin(hostname) {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set. Add it in Netlify > Environment variables, then redeploy.");
    let creds;
    try { creds = JSON.parse(raw); }
    catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON."); }

    if (hostname) {
      const looksDev = isDevHostname(hostname);
      const isProductionCreds = creds.project_id === EXPECTED_PRODUCTION_PROJECT_ID;
      if (!looksDev && !isProductionCreds) {
        throw new Error(
          "SAFETY GUARD TRIPPED: request came in on \"" + hostname + "\" (looks like production) but " +
          "FIREBASE_SERVICE_ACCOUNT belongs to project \"" + creds.project_id + "\", not \"" +
          EXPECTED_PRODUCTION_PROJECT_ID + "\". Refusing to initialize -- production would otherwise be running " +
          "on the wrong Firebase project. Fix the Production-scoped FIREBASE_SERVICE_ACCOUNT env var in Netlify " +
          "(Site configuration > Environment variables) and redeploy."
        );
      }
      if (looksDev && isProductionCreds) {
        throw new Error(
          "SAFETY GUARD TRIPPED: request came in on \"" + hostname + "\" (looks like dev) but " +
          "FIREBASE_SERVICE_ACCOUNT belongs to the PRODUCTION project \"" + EXPECTED_PRODUCTION_PROJECT_ID +
          "\". Refusing to initialize -- this deploy would otherwise write to Mark's real production data. " +
          "Fix the Branch deploy-scoped FIREBASE_SERVICE_ACCOUNT env var in Netlify (it should hold " +
          "watkins-service-orders-dev's service account JSON, not production's) and redeploy."
        );
      }
    }

    const bucket = process.env.FIREBASE_STORAGE_BUCKET || (creds.project_id + ".firebasestorage.app");
    admin.initializeApp({ credential: admin.credential.cert(creds), storageBucket: bucket });
  }
  return admin;
}
function getDb(hostname) { return getAdmin(hostname).firestore(); }
function getAuth(hostname) { return getAdmin(hostname).auth(); }
function hostnameFromEvent(event) {
  const h = (event && event.headers) || {};
  return h.host || h.Host || h["x-forwarded-host"] || null;
}

// Extracts the bearer token from a Netlify Function event's headers.
// Header names arrive lowercased in Netlify's event.headers.
function extractBearerToken(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// CROSS-PROJECT TOKEN DIAGNOSTIC (added 2026-07-31)
// ---------------------------------------------------------------------
// Since the 2026-07-11 Firebase split, dev and production are SEPARATE
// Firebase projects. A Firebase ID token is audience-bound: one minted for
// "watkins-service-orders" is valid on production and MUST be rejected by the
// dev deployment, which verifies against "watkins-service-orders-dev" (and
// vice versa). That rejection is the project boundary working correctly -- it
// is the whole point of the split.
//
// The problem was never the decision, it was the MESSAGE. A perfectly valid
// production token sent to dev produced a bare "Invalid or expired session",
// which reads as "my session died". Because the same endpoints also accept a
// non-Firebase credential (the ASIL bridge key), callers using that key kept
// succeeding side by side with the 401s -- so the failure looked INTERMITTENT
// and got chased as an expiring session, twice, when it was in fact perfectly
// deterministic: wrong-project token every time, ASIL key fine every time.
//
// So: on a verification failure, read the token's `aud` claim WITHOUT verifying
// it, purely to name the mismatch. This is never trusted for any auth decision
// -- the token has ALREADY been rejected by verifyIdToken() before this runs,
// and nothing here can turn a rejection into an acceptance. `aud` is also not a
// secret: it is a Firebase project id, already public in js/core.js's
// FIREBASE_CONFIG, and it is the caller's own token.
function unverifiedTokenAudience(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const aud = payload && payload.aud;
    // Firebase project ids are a narrow charset. Anything else is not echoed
    // back -- an error string must never become a channel for attacker text.
    return typeof aud === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(aud) ? aud : null;
  } catch (e) {
    return null;
  }
}

// Which Firebase project THIS deployment verifies against. Parsed from the same
// credentials JSON getAdmin() initializes with (identical approach to auth.js's
// whoami_project), so it cannot drift from the real verifier. Returns null if
// unreadable -- a diagnostic must never throw and change an auth outcome.
function initializedProjectId() {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;
    const id = JSON.parse(raw).project_id;
    return typeof id === "string" && id ? id : null;
  } catch (e) {
    return null;
  }
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
  // hostnameFromEvent(event) here (not a bare getAuth()) so any caller that
  // only ever calls verifyCaller()/requirePermission() -- e.g.
  // send-workorder.js, which has no separate priming call -- still primes
  // the safety guard on a cold container, not just files that happen to
  // call getDb()/getAuth() directly first. Deliberately OUTSIDE the
  // verifyIdToken try/catch below: a thrown safety-guard error must surface
  // with its real, specific message (caught by the handler's own outer
  // try/catch as a 500 "Server error: ...") -- folding it into the generic
  // "Invalid or expired session" 401 would hide exactly the diagnostic this
  // guard exists to provide.
  const authInstance = getAuth(hostnameFromEvent(event));
  let decoded;
  try {
    decoded = await authInstance.verifyIdToken(token, !!opts.checkRevoked);
  } catch (e) {
    // The token is already rejected at this point. Everything below only
    // chooses WORDING -- same 401, same refusal, in every branch.
    let message = "Invalid or expired session";
    const aud = unverifiedTokenAudience(token);
    const expected = initializedProjectId();
    if (aud && expected && aud !== expected) {
      message += ": this token was issued for Firebase project \"" + aud +
        "\", but this deployment verifies against \"" + expected + "\". " +
        "Dev and production are separate Firebase projects, so a token minted " +
        "against one is correctly refused by the other -- mint the token against \"" +
        expected + "\", or use a non-Firebase credential this endpoint accepts.";
    }
    // If the audience MATCHES, the wording stays deliberately bare: that is a
    // real expiry/signature/revocation failure and we say nothing about which.
    const err = new Error(message);
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

module.exports = { getAdmin, getDb, getAuth, verifyCaller, tryVerifyCaller, getPermissionValue, requirePermission, hostnameFromEvent, unverifiedTokenAudience, initializedProjectId };
