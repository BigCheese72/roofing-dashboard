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
const { getDb, getAuth, getAdmin, verifyCaller, getPermissionValue, hostnameFromEvent } = require("./lib/authGuard");
const { SEED_ROLES } = require("./lib/permissions");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Real incident, fixed here: the original invite flow relied on Firebase
// Auth's own built-in password-reset email (fauth.sendPasswordResetEmail(),
// client-side), sent via generatePasswordResetLink()'s implicit mail
// delivery. It never arrived -- most likely auth/unauthorized-continue-uri
// (the production domain was never added to Firebase's Authorized domains
// list), and the client wrapped that call in a bare try/catch that
// swallowed the error and told the inviting admin "email sent (Y)"
// regardless of whether it actually was. No crew member could ever be
// onboarded and nobody knew.
//
// Fix: generate the reset LINK via the Admin SDK (generatePasswordResetLink
// -- this does NOT send anything itself, just returns a URL) and send the
// actual email ourselves via Resend, the same real, already-verified
// delivery path send-workorder.js uses. No dependency on Firebase's own
// mail delivery or its Authorized-domains gate at all anymore.
//
// appUrl is supplied by the CALLER (the inviting admin's own browser
// already knows window.location.origin -- same principle as
// passwordResetActionCodeSettings() in js/core.js) but is validated
// against a real allowlist here, not trusted blindly -- it becomes the
// base of the emailed invite link, so a bad value must be rejected
// outright, not silently used.
const ALLOWED_APP_URLS = [
  "https://leak-work-orders.netlify.app",
  "https://dev--leak-work-orders.netlify.app",
  "http://localhost:4321", "http://localhost:4322", "http://127.0.0.1:4321", "http://127.0.0.1:4322"
];
function validateAppUrl(raw) {
  var u = String(raw || "").replace(/\/$/, "");
  return ALLOWED_APP_URLS.indexOf(u) !== -1 ? u : null;
}

// ---- Custom long-lived invite tokens (2026-07-16) ----
// Real field problem, fixed here: the invite email's "set your password"
// button used to be a Firebase password-reset action link
// (generatePasswordResetLink). Firebase expires those out-of-band codes
// about an HOUR after they're minted, the window is not configurable
// anywhere (not in ActionCodeSettings, not in the console, not in the
// Admin SDK), and a roofing crew does not sit at an inbox -- most invites
// were dead before they were ever opened, and the recipient landed on
// Firebase's hosted "link expired" page with no way forward.
//
// Replaced with our own invite token: 32 random bytes, emailed as
// ?invite=<token> on the app's own URL (js/core.js's login gate handles
// it -- see loginGateAcceptInviteHtml/gateAcceptInvite there), stored
// ONLY as a SHA-256 hash in invites/{uid} (a Firestore leak can never
// mint a login; the raw token exists nowhere but the email itself), valid
// for INVITE_TTL_DAYS, single-use (usedAt), revoked when the account is
// disabled/deleted (revokedAt, plus resolveInvite() independently checks
// the live user status), and invalidated wholesale by a resend -- the doc
// is keyed by uid, ONE active invite per user, so a fresh invite
// overwrites the old hash and the old link dies with it.
//
// check_invite/accept_invite below are deliberately UNauthenticated: the
// token itself is the credential, exactly the trust model of the Firebase
// link it replaces, just on a window sized for how crews actually work --
// and at 256 random bits, unguessable in a way no rate limit needs to
// prop up. The signed-in "Forgot password?" flow keeps using Firebase's
// own short-lived reset links: one hour is fine when you're actively
// standing at the login screen; it was only ever wrong for onboarding.
const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
async function issueInvite(db, opts) {
  const token = crypto.randomBytes(32).toString("hex");
  // merge:false on purpose -- a resend must leave NOTHING of the previous
  // invite behind (old hash, old usedAt/revokedAt state), not blend with it.
  await db.collection("invites").doc(opts.uid).set({
    tokenHash: hashInviteToken(token),
    uid: opts.uid, email: opts.email, role: opts.role,
    createdAt: Date.now(), expiresAt: Date.now() + INVITE_TTL_MS,
    usedAt: null, revokedAt: null, createdBy: opts.createdBy
  }, { merge: false });
  return opts.appUrl + "/?invite=" + token;
}
// Resolves a raw invite token to its invite record + live user doc, or
// null. ONE null for every failure reason (unknown token, already used,
// revoked, expired, account disabled/deleted since) -- the accept page
// tells the recipient the same thing regardless ("ask your admin to
// resend"), and a probing caller learns nothing about which stage failed
// or whether an email/account exists at all.
async function resolveInvite(db, rawToken) {
  const token = String(rawToken || "");
  if (token.length < 32) return null;
  const q = await db.collection("invites").where("tokenHash", "==", hashInviteToken(token)).limit(1).get();
  if (q.empty) return null;
  const invite = q.docs[0].data();
  if (invite.usedAt || invite.revokedAt) return null;
  if (typeof invite.expiresAt !== "number" || Date.now() > invite.expiresAt) return null;
  const userDoc = await db.collection("users").doc(invite.uid).get();
  if (!userDoc.exists) return null;
  const user = userDoc.data();
  if ((user.status || "active") !== "active") return null;
  return { invite: invite, user: user };
}
// Single message for every dead-invite case -- see resolveInvite() above.
const INVITE_DEAD_MSG = "This invite link is no longer valid. Ask your admin to tap \"Resend invite\" on your account -- a fresh link arrives in seconds.";

async function sendInviteEmail(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set. Add it in Netlify > Environment variables, then redeploy.");
  // Real bug, fixed here: this used to invent its own sender identity
  // ("RoofOps <noreply@...>"). send-workorder.js's real work-order emails
  // reach real recipients successfully using a DIFFERENT, already-verified
  // From value -- reusing that exact value (not just the same domain)
  // rather than a new local part this account may never have proven out
  // in Resend. Same default construction as send-workorder.js, verbatim.
  const from = process.env.FROM_EMAIL || "Watkins Roofing Work Orders <workorders@watkinsroofing.net>";
  const subject = "You've been added to RoofOps — set your password";
  const roleLabel = opts.roleLabel || opts.roleId;
  // ?openHelp=1 is read by js/help.js on load and auto-opens the in-app Help
  // Center once the login gate clears -- a brand-new crew member's first
  // stop after setting their password is straight into "how do I..." rather
  // than a blank Home screen. Added 2026-07-12 alongside the Help Center.
  const helpLink = opts.appUrl + "/?openHelp=1";
  // Add-to-home-screen instructions are platform-specific. On iOS BOTH
  // Safari and Chrome can do it: iOS 16.4+ (March 2023) lets third-party
  // browsers add web apps to the Home Screen, and Chrome-on-iOS exposes it
  // in its share/menu -- Mark uses Chrome on iOS exclusively and it works.
  // (This copy previously insisted Safari was the only iOS browser that
  // could do it; that was stale pre-16.4 knowledge and told Chrome-on-iOS
  // users their working browser couldn't do the thing it can. Corrected
  // 2026-07-16; tests/inviteEmailA2hsCopy.test.js guards the fix.)
  const text = "Hi" + (opts.displayName ? " " + opts.displayName : "") + ",\n\n" +
    opts.inviterEmail + " has added you to RoofOps (Watkins Roofing's field work order app) as a " + roleLabel + ".\n\n" +
    "1. SET YOUR PASSWORD (this link works for " + INVITE_TTL_DAYS + " days)\n" + opts.inviteLink + "\n" +
    "   If it's expired, ask " + opts.inviterEmail + " to tap \"Resend invite\" on your account -- a fresh link arrives in seconds.\n\n" +
    "2. ADD ROOFOPS TO YOUR HOME SCREEN (do this once, in the field it's much faster than a browser tab)\n" +
    "   iPhone/iPad (Safari or Chrome): open " + opts.appUrl + " -> tap the Share button (or the ... menu in Chrome) -> \"Add to Home Screen\" -> Add.\n" +
    "   Android: open " + opts.appUrl + " in Chrome -> tap the three-dot menu -> \"Install app\" or \"Add to Home screen.\"\n" +
    "   Computer (Chrome/Edge): click the install icon in the address bar, or the three-dot menu -> \"Install RoofOps.\"\n" +
    "   This makes it open full-screen like a real app, one tap from your home screen.\n\n" +
    "3. NEED HELP?\n" + helpLink + " -- searchable how-tos, right in the app, or tap the ❓ button on any screen once you're signed in.\n\n" +
    "Sign in any time at " + opts.appUrl + "\n\n" +
    "If you weren't expecting this, you can ignore this email.";
  const html = "<p>Hi" + (opts.displayName ? " " + escapeHtml(opts.displayName) : "") + ",</p>" +
    "<p><b>" + escapeHtml(opts.inviterEmail) + "</b> has added you to <b>RoofOps</b> (Watkins Roofing's field work order app) as a <b>" + escapeHtml(roleLabel) + "</b>.</p>" +
    "<p style=\"margin:20px 0 8px\"><b>1. Set your password</b></p>" +
    "<p><a href=\"" + opts.inviteLink + "\" style=\"display:inline-block;background:#E8600A;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold\">Set Your Password and Sign In</a></p>" +
    "<p style=\"color:#666;font-size:13px;margin:6px 0 0\">This link works for " + INVITE_TTL_DAYS + " days. If it's expired, ask " + escapeHtml(opts.inviterEmail) + " to tap “Resend invite” on your account — a fresh link arrives in seconds.</p>" +
    "<p style=\"margin:22px 0 8px\"><b>2. Add RoofOps to your home screen</b> (do this once — in the field it's much faster than a browser tab)</p>" +
    "<ul style=\"margin:0 0 16px;padding-left:20px;line-height:1.6\">" +
    "<li><b>iPhone/iPad (Safari or Chrome):</b> open the app → tap the Share button (or the ⋯ menu in Chrome) → <b>Add to Home Screen</b> → Add.</li>" +
    "<li><b>Android:</b> open the app in Chrome → three-dot menu → <b>Install app</b> or <b>Add to Home screen</b>.</li>" +
    "<li><b>Computer (Chrome/Edge):</b> the install icon in the address bar, or three-dot menu → <b>Install RoofOps</b>.</li>" +
    "</ul>" +
    "<p style=\"color:#666;font-size:13px;margin:0 0 16px\">It'll open full-screen like a real app, one tap from your home screen — no digging through browser tabs on a roof.</p>" +
    "<p style=\"margin:22px 0 8px\"><b>3. Need help?</b></p>" +
    "<p style=\"margin:0 0 16px\"><a href=\"" + helpLink + "\">Open the Help Center</a> — searchable how-tos, or tap ❓ on any screen once you're signed in.</p>" +
    "<p>Sign in any time at <a href=\"" + opts.appUrl + "\">" + opts.appUrl + "</a>.</p>" +
    "<p style=\"color:#666;font-size:13px\">If you weren't expecting this, you can ignore this email.</p>";
  const resp2 = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: from, to: [opts.email], subject: subject, text: text, html: html })
  });
  const out = await resp2.text();
  // Real bug, fixed here (same silent-failure pattern flagged before):
  // Resend's actual response body was discarded on success and never
  // returned -- a 200-level "accepted" is not proof of actual delivery
  // (Resend can accept into its queue and bounce afterward), and there was
  // no way to see the real message id/response to check delivery status
  // against. Both callers (create_user/resend_invite) now get this back
  // and can report/log it, not just a blind "it worked."
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (e) { /* non-JSON body, keep raw text below */ }
  if (!resp2.ok) throw new Error("Email service rejected it (status " + resp2.status + "): " + out.slice(0, 300));
  return { status: resp2.status, resendId: parsed && parsed.id ? parsed.id : null, raw: out.slice(0, 500) };
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

  // ---- whoami_project: read-only diagnostic, added 2026-07-12 to
  // investigate a suspected half-split (dev's CLIENT correctly isolated,
  // but dev's SERVER FUNCTIONS possibly still holding production
  // credentials). Deliberately does NOT call getDb()/getAuth() for the raw
  // env-var report below -- reads FIREBASE_SERVICE_ACCOUNT itself and
  // parses only project_id out of it, no Firestore/Auth call, no write,
  // nothing sensitive returned (project_id is already public in the
  // client's own FIREBASE_CONFIG). Separately calls getAdmin() so the
  // safety guard in authGuard.js actually runs and its verdict (pass, or
  // the specific mismatch error) is visible too -- if the guard trips,
  // that error message IS the diagnosis. No auth required: this reveals
  // no secret, and requiring a caller identity would be circular during
  // exactly the "is anything working at all" investigation this exists
  // for. ----
  if (body.action === "whoami_project") {
    const hostname = hostnameFromEvent(event);
    const out = {
      requestHostname: hostname,
      context: process.env.CONTEXT || null, branch: process.env.BRANCH || null, deployUrl: process.env.URL || null,
      deployPrimeUrl: process.env.DEPLOY_PRIME_URL || null, deployUrl2: process.env.DEPLOY_URL || null,
      siteName: process.env.SITE_NAME || null, deployId: process.env.DEPLOY_ID || null
    };
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      out.serviceAccountSet = !!raw;
      if (raw) { try { out.rawProjectId = JSON.parse(raw).project_id || null; } catch (e) { out.rawParseError = String(e.message || e); } }
    } catch (e) { out.envReadError = String(e.message || e); }
    try {
      getAdmin(hostname);
      out.guardResult = "pass";
      out.initializedProjectId = out.rawProjectId;
    } catch (e) {
      out.guardResult = "BLOCKED";
      out.guardError = e.message;
    }
    return resp(200, out);
  }

  try {
    const db = getDb(hostnameFromEvent(event));
    const auth = getAuth();

    // ---- mint_disposable_test_session: added 2026-07-12 to run REAL,
    // live negative-permission tests on dev (field_tech can't self-promote,
    // can't approve pricing, etc.) without ever touching a human's
    // password. Anonymous auth isn't enabled on this project, so this
    // mints a Firebase custom token (a signed, ~1hr-lived JWT tied to one
    // specific uid) the same way a backend would provision a service
    // session -- NOT a password, never entered anywhere, exchanged
    // client-side via signInWithCustomToken() for a real ID token with
    // real custom claims that requirePermission()/firestore.rules check
    // exactly like any other session. Locked down three ways: owner-only,
    // dev-hostname-only (defense in depth on top of the project-level
    // safety guard in authGuard.js), and every minted account is tagged
    // isDisposableTestAccount:true so it's obviously not a real user if
    // anyone ever finds it lingering. Delete the account when done testing
    // -- this does not expire or clean up on its own. ----
    if (body.action === "mint_disposable_test_session") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
      if (!caller.owner) return resp(403, { error: "Owner only" });

      const hostname = hostnameFromEvent(event) || "";
      const looksDev = hostname.indexOf("dev--") !== -1 || hostname === "localhost" ||
        hostname.indexOf("localhost:") === 0 || hostname === "127.0.0.1" || hostname.indexOf("127.0.0.1:") === 0;
      if (!looksDev) return resp(403, { error: "mint_disposable_test_session is dev-only (request hostname: " + hostname + ")" });

      const roleId = String(body.roleId || "");
      if (!roleId || roleId === "owner") return resp(400, { error: "Invalid roleId" });
      const roleDoc = await db.collection("roles").doc(roleId).get();
      if (!roleDoc.exists) return resp(400, { error: "Unknown role: " + roleId });

      let uid = String(body.uid || "");
      if (!uid) {
        const rec = await auth.createUser({ displayName: "DISPOSABLE_TEST_ACCOUNT (safe to delete)" });
        uid = rec.uid;
      }
      await auth.setCustomUserClaims(uid, { owner: false, role: roleId, mfaOk: false });
      await db.collection("users").doc(uid).set({
        uid: uid, email: null, displayName: "DISPOSABLE_TEST_ACCOUNT", role: roleId,
        permissions: {}, projectRoles: {}, status: "active", mfaEnrolled: false, owner: false,
        isDisposableTestAccount: true, createdAt: Date.now(), updatedAt: Date.now(),
        createdBy: "mint_disposable_test_session:" + caller.uid, lastLoginAt: null
      }, { merge: true });
      const customToken = await auth.createCustomToken(uid, { disposableTest: true });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: "owner", action: "mint_disposable_test_session",
        target: { collection: "users", id: uid }, before: null, after: { role: roleId }
      });
      return resp(200, { ok: true, uid: uid, customToken: customToken });
    }

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
    // anywhere -- this endpoint hands back only {ok, uid, email}. The real
    // invite delivery is issueInvite() (our own 7-day token -- see the
    // invite-token comment block above for why this replaced Firebase's
    // ~1-hour password-reset links) + sendInviteEmail() via Resend -- see
    // the comment on sendInviteEmail() above for why THAT replaced the
    // earlier Firebase-built-in-email approach, which silently never
    // delivered.
    // If the email send fails, the account still exists (real value,
    // recoverable) but the caller is told explicitly rather than being
    // lied to with a false "sent" -- and resend_invite below can retry
    // without recreating the account. No human (not Mark, not an admin,
    // not this assistant) ever types, sees, or transmits another person's
    // password at any point in this flow. ----
    if (body.action === "create_user") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const email = String(body.email || "").trim().toLowerCase();
      const roleId = String(body.roleId || "");
      const displayName = String(body.displayName || "").trim();
      const appUrl = validateAppUrl(body.appUrl);
      if (!email || !EMAIL_RE.test(email)) return resp(400, { error: "Invalid email" });
      if (!roleId) return resp(400, { error: "Missing roleId" });
      if (roleId === "owner") return resp(400, { error: "The owner role can't be assigned here -- it's unique, set only via bootstrap or transfer_owner" });
      if (!appUrl) return resp(400, { error: "Invalid or missing appUrl" });

      const roleDoc = await db.collection("roles").doc(roleId).get();
      if (!roleDoc.exists) return resp(400, { error: "Unknown role: " + roleId });
      const roleLabel = roleDoc.data().label || roleId;

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

      let emailSent = false, emailError = null, resendResult = null;
      try {
        // If issueInvite succeeds but the email send below fails, the
        // invite record exists with no email out -- harmless: resend_invite
        // overwrites it wholesale (merge:false), same recovery path as any
        // other failed send.
        const inviteLink = await issueInvite(db, { uid: userRecord.uid, email: email, role: roleId, createdBy: caller.uid, appUrl: appUrl });
        resendResult = await sendInviteEmail({ email: email, displayName: displayName, roleId: roleId, roleLabel: roleLabel,
          inviterEmail: caller.email, inviteLink: inviteLink, appUrl: appUrl });
        emailSent = true;
      } catch (e) { emailError = e && e.message ? e.message : "unknown error"; }

      return resp(200, { ok: true, uid: userRecord.uid, email: email, emailSent: emailSent, emailError: emailError, resend: resendResult });
    }

    // ---- resend_invite: rescues any invite that expired, failed, got
    // lost, or landed in spam without recreating the account --
    // issueInvite() works on any existing account regardless of when or
    // how it was created (accounts invited under the old Firebase-link
    // scheme included), and overwrites any previous invite record wholesale
    // so exactly one link is ever live per user. Same hierarchy check as
    // create_user, evaluated against the TARGET's CURRENT role (an admin
    // could have been created, then demoted, then need a resend -- always
    // check live state, not what was true at creation time). ----
    if (body.action === "resend_invite") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const targetUid = String(body.targetUid || "");
      const appUrl = validateAppUrl(body.appUrl);
      if (!targetUid) return resp(400, { error: "Missing targetUid" });
      if (!appUrl) return resp(400, { error: "Invalid or missing appUrl" });

      const targetDoc = await db.collection("users").doc(targetUid).get();
      if (!targetDoc.exists) return resp(404, { error: "User not found" });
      const target = targetDoc.data();

      if (target.role === "admin" || target.owner) {
        if (!caller.owner) return resp(403, { error: "Only the owner may resend an admin's invite" });
      } else {
        if (!caller.owner) {
          const canManage = await getPermissionValue(caller.role, "users.manage_nonadmin");
          if (canManage !== true) return resp(403, { error: "Forbidden: missing permission users.manage_nonadmin" });
        }
      }

      const roleDoc = await db.collection("roles").doc(target.role).get();
      const roleLabel = roleDoc.exists ? (roleDoc.data().label || target.role) : target.role;

      const inviteLink = await issueInvite(db, { uid: targetUid, email: target.email, role: target.role, createdBy: caller.uid, appUrl: appUrl });
      const resendResult = await sendInviteEmail({ email: target.email, displayName: target.displayName, roleId: target.role, roleLabel: roleLabel,
        inviterEmail: caller.email, inviteLink: inviteLink, appUrl: appUrl });

      await writeAudit(db, {
        actorUid: caller.uid, actorRole: caller.owner ? "owner" : caller.role, action: "resend_invite",
        target: { collection: "users", id: targetUid }, before: null, after: { email: target.email }
      });
      return resp(200, { ok: true, resend: resendResult });
    }

    // ---- check_invite: the accept page's first call on load -- resolves
    // a raw ?invite= token to "who is this for" so the form can greet the
    // recipient and fail FAST with a clear message on a dead link, before
    // they've typed anything. Unauthenticated by design (the recipient has
    // no account password yet -- the token IS the credential; see the
    // invite-token comment block above). Returns only what the recipient's
    // own email already told them (their email/name), and only against a
    // live, unused, unexpired token. ----
    if (body.action === "check_invite") {
      const found = await resolveInvite(db, body.token);
      if (!found) return resp(410, { error: INVITE_DEAD_MSG });
      return resp(200, { ok: true, email: found.user.email, displayName: found.user.displayName || "" });
    }

    // ---- accept_invite: sets the recipient's real password against a
    // valid token, then burns the token (usedAt) -- single-use, same as
    // the Firebase link it replaced. usedAt is marked AFTER updateUser()
    // on purpose: if the password write fails, the invite must stay
    // usable for a retry rather than stranding the recipient behind an
    // admin resend. (The token stays a 256-bit secret either way -- the
    // narrow double-submit race this ordering allows just sets the same
    // account's password twice, by the same token holder.) ----
    if (body.action === "accept_invite") {
      const password = String(body.password || "");
      if (password.length < 8) return resp(400, { error: "Password must be at least 8 characters" });
      const found = await resolveInvite(db, body.token);
      if (!found) return resp(410, { error: INVITE_DEAD_MSG });

      await getAuth().updateUser(found.invite.uid, { password: password });
      await db.collection("invites").doc(found.invite.uid).set({ usedAt: Date.now() }, { merge: true });
      await db.collection("users").doc(found.invite.uid).set({ updatedAt: Date.now() }, { merge: true });
      await writeAudit(db, {
        actorUid: found.invite.uid, actorRole: found.user.role, action: "accept_invite",
        target: { collection: "users", id: found.invite.uid }, before: null, after: { inviteAccepted: true }
      });
      // email comes back so the client can sign straight in with the
      // password it just set -- no retyping on a roof.
      return resp(200, { ok: true, email: found.user.email });
    }

    // ---- disable_user / enable_user / delete_user: Mark's explicit design
    // (see docs/AUTH_DESIGN.md) -- disable, not delete, is the primary
    // removal action. A user's name is attached to work orders, findings,
    // photos, and audit entries; hard-deleting their record would orphan
    // that history and break attribution, which defeats the whole "digital
    // memory of every roof" premise. All three share the exact same
    // hierarchy guard as resend_invite/assign_role, evaluated against the
    // TARGET's CURRENT role/owner status:
    //   - caller can never target themselves (self-lockout guard -- the
    //     owner must never be able to disable/delete their OWN account,
    //     same principle as assign_role's "cannot change your own role").
    //   - targeting the owner (as anyone but the owner, which is already
    //     blocked by the self-target check above) is never allowed --
    //     an admin can never disable/delete the owner.
    //   - targeting an admin requires the caller to BE owner.
    //   - targeting anyone else requires owner OR users.manage_nonadmin.
    if (body.action === "disable_user" || body.action === "enable_user") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

      const targetUid = String(body.targetUid || "");
      if (!targetUid) return resp(400, { error: "Missing targetUid" });
      if (targetUid === caller.uid) return resp(403, { error: "You can't " + (body.action === "disable_user" ? "disable" : "re-enable") + " your own account" });

      const targetDoc = await db.collection("users").doc(targetUid).get();
      if (!targetDoc.exists) return resp(404, { error: "User not found" });
      const target = targetDoc.data();
      if (target.owner) return resp(403, { error: "The owner's account can't be disabled -- transfer ownership first" });

      if (target.role === "admin") {
        if (!caller.owner) return resp(403, { error: "Only the owner may disable or re-enable an admin" });
      } else {
        if (!caller.owner) {
          const canManage = await getPermissionValue(caller.role, "users.manage_nonadmin");
          if (canManage !== true) return resp(403, { error: "Forbidden: missing permission users.manage_nonadmin" });
        }
      }

      const disabling = body.action === "disable_user";
      await getAuth().updateUser(targetUid, { disabled: disabling });
      if (disabling) {
        await getAuth().revokeRefreshTokens(targetUid); // kills any already-open session immediately, not after natural token expiry
        // Burn any outstanding invite link too -- resolveInvite() would
        // already reject it via the live status check below, but the
        // invite record should SAY it's dead rather than merely be dead
        // (revokedAt is state a future admin UI can display, and defense
        // in depth costs one merge). Re-enabling doesn't resurrect it --
        // that's what Resend invite is for.
        try { await db.collection("invites").doc(targetUid).set({ revokedAt: Date.now() }, { merge: true }); } catch (e) { /* best-effort */ }
      }
      await db.collection("users").doc(targetUid).set({
        status: disabling ? "disabled" : "active", updatedAt: Date.now()
      }, { merge: true });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: caller.owner ? "owner" : caller.role, action: body.action,
        target: { collection: "users", id: targetUid },
        before: { status: target.status || "active" }, after: { status: disabling ? "disabled" : "active" }
      });
      return resp(200, { ok: true });
    }

    // delete_user: OWNER-ONLY, permanent. Deletes the Firebase Auth account
    // (they can never sign in again, the uid is gone from Auth entirely)
    // but the users/{uid} Firestore doc is RETAINED, marked archived --
    // never deleted -- so every work order/finding/photo/audit entry that
    // references this uid still resolves to a real name instead of an
    // orphaned id. This is the one hard line even the owner can't cross for
    // themselves (self-target blocked below, same as disable/enable).
    if (body.action === "delete_user") {
      let caller;
      try { caller = await verifyCaller(event); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
      if (!caller.owner) return resp(403, { error: "Only the owner may permanently delete a user" });

      const targetUid = String(body.targetUid || "");
      if (!targetUid) return resp(400, { error: "Missing targetUid" });
      if (targetUid === caller.uid) return resp(403, { error: "You can't delete your own account" });

      const targetDoc = await db.collection("users").doc(targetUid).get();
      if (!targetDoc.exists) return resp(404, { error: "User not found" });
      const target = targetDoc.data();
      if (target.owner) return resp(403, { error: "The owner's account can't be deleted -- transfer ownership first" });

      try { await getAuth().deleteUser(targetUid); }
      catch (e) { if (!e || e.code !== "auth/user-not-found") throw e; } // already gone from Auth -- still archive the Firestore record below
      // Same invite burn as disable_user above -- a deleted account's
      // invite link must never resolve again.
      try { await db.collection("invites").doc(targetUid).set({ revokedAt: Date.now() }, { merge: true }); } catch (e) { /* best-effort */ }
      await db.collection("users").doc(targetUid).set({
        status: "deleted", archived: true, deletedAt: Date.now(), deletedBy: caller.uid, updatedAt: Date.now()
      }, { merge: true });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: "owner", action: "delete_user",
        target: { collection: "users", id: targetUid },
        before: { status: target.status || "active", email: target.email }, after: { status: "deleted" }
      });
      return resp(200, { ok: true });
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
