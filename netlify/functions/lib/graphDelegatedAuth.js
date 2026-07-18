// Microsoft Graph DELEGATED ("acts as you") auth — authorization-code flow
// with a long-lived refresh token, as opposed to lib/graphAuth.js's
// app-only (client-credentials) flow. Delegated auth is required for
// anything that has to act as Mark personally rather than as the service
// principal — his OneDrive/Excel/Word, and Outlook inbox rules
// (messageRules), which Microsoft Graph does not expose to application
// permissions at all (confirmed empirically: every messageRules POST under
// the app-only token returned 403 ErrorAccessDenied while every other
// Graph call — folders, messages, moves — succeeded under the identical
// token, which is the signature of a permission-model wall, not a
// scope/consent gap).
//
// Same app registration as lib/graphAuth.js (same GRAPH_TENANT_ID /
// GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET env vars) — delegated and app-only
// are just two different OAuth flows against one Azure app registration,
// not two separate apps.
//
// Required env vars (Netlify > Project configuration > Environment
// variables):
//   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET — same as
//     lib/graphAuth.js. GRAPH_CLIENT_SECRET is also reused (intentionally
//     — see signState() below) to HMAC-sign the OAuth `state` param, so no
//     separate state-signing secret is needed.
//   FIREBASE_SERVICE_ACCOUNT — same Firestore service account JSON used by
//     admin.js, needed here to read/write the stored refresh token.
//
// Redirect URIs are fixed, not env-configurable — Azure AD rejects any
// redirect_uri that doesn't exactly match what's registered on the app,
// so hardcoding (and validating the request host against an allow-list)
// removes any chance of an env-var typo silently breaking sign-in:
//   https://leak-work-orders.netlify.app/.netlify/functions/ms-auth-callback
//   https://dev--leak-work-orders.netlify.app/.netlify/functions/ms-auth-callback
//
// Refresh token storage: Firestore, collection `secrets`, doc
// `ms_graph_delegated`, written/read ONLY via the Firebase Admin SDK
// (server-side, same pattern as admin.js) — never exposed to any client
// SDK call. firestore.rules (repo root) has an explicit
// `allow read, write: if false` block for this collection as defense in
// depth, on top of Firestore's own implicit deny-by-default for any
// collection with no matching rule. See DEV_NOTES.md "Outlook /
// Microsoft 365 — delegated auth" for the full writeup, including why
// Firestore (not, say, a Netlify env var) is the storage — a refresh
// token needs to be updatable at runtime (Azure AD v2 rotates it on every
// refresh when offline_access is used) and env vars are static/deploy-time
// in Netlify.

const admin = require("firebase-admin");
const crypto = require("crypto");

// MailboxSettings.ReadWrite is REQUIRED for Outlook inbox rules
// (/me/mailFolders/inbox/messageRules) -- which is, per this module's own
// header above, the entire reason delegated auth exists here. It was missing
// from this scope string, so the headline feature would have failed with a
// permission error even after a successful sign-in. Contacts.ReadWrite is
// likewise part of the consented delegated permission set.
//
// Calendars.ReadWrite is the DESIRED set for the morning-brief assistant's
// calendar actions (contacts-sync calendar_list / calendar_create). It is NOT
// yet admin-consented on the RoofOps app registration as of this change, so:
//   * This constant drives ONLY the interactive AUTHORIZE flow (ms-auth-start's
//     authorize URL + exchangeCodeForToken). Once Steve adds Calendars.ReadWrite
//     to the app and grants admin consent, Mark re-runs ms-auth-start and the
//     resulting refresh token carries the calendar scope.
//   * The REFRESH path deliberately does NOT send this scope string (see
//     refreshAccessToken) — requesting an un-consented scope on a refresh_token
//     grant would fail the whole refresh and take down the working mail/contacts
//     integration. Omitting scope on refresh returns exactly the scopes actually
//     granted to the stored token, so calendar "lights up" automatically after
//     the re-sign-in and is simply absent before it. hasCalendarScope() reads
//     the stored grant so callers can gate cleanly instead of 403-ing.
const DELEGATED_SCOPES = [
  "offline_access",
  "Mail.ReadWrite",
  "MailboxSettings.ReadWrite",
  "Contacts.ReadWrite",
  "Files.ReadWrite",
  "Calendars.ReadWrite",
  "User.Read"
].join(" ");

// The one scope the calendar actions need. Used to detect whether the stored
// delegated grant actually carries it yet (it won't until Steve consents +
// Mark re-signs-in), so calendar_list / calendar_create can no-op with a clear
// message rather than failing with a raw Graph 403.
const CALENDAR_SCOPE = "Calendars.ReadWrite";

const ALLOWED_REDIRECTS = {
  "leak-work-orders.netlify.app": "https://leak-work-orders.netlify.app/.netlify/functions/ms-auth-callback",
  "dev--leak-work-orders.netlify.app": "https://dev--leak-work-orders.netlify.app/.netlify/functions/ms-auth-callback",
};

function requireEnv() {
  const keys = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"];
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error("Missing required env var(s): " + missing.join(", ") +
      ". Add them in Netlify > Project configuration > Environment variables, then redeploy.");
  }
  return {
    tenantId: process.env.GRAPH_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET,
  };
}

// Resolves the incoming request's Host header to one of the two exact,
// pre-registered redirect URIs — never builds one dynamically from
// arbitrary input, so a spoofed/unexpected Host header just fails closed
// (returns null) instead of producing a URL Azure AD would reject anyway.
function resolveRedirectUri(host) {
  const h = String(host || "").toLowerCase().split(":")[0];
  return ALLOWED_REDIRECTS[h] || null;
}

// Stateless CSRF protection for the OAuth `state` param — no server-side
// session to store a nonce in, so state is a HMAC-signed timestamp
// ("<ts>.<hex hmac>", base64url-encoded) instead. verifyState() recomputes
// the HMAC and checks the timestamp isn't stale, entirely without storage.
function signState() {
  const { clientSecret } = requireEnv();
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", clientSecret).update(ts).digest("hex");
  return Buffer.from(ts + "." + sig, "utf8").toString("base64url");
}

function verifyState(state, maxAgeMs) {
  maxAgeMs = maxAgeMs || 10 * 60 * 1000; // 10 minutes
  try {
    const { clientSecret } = requireEnv();
    const decoded = Buffer.from(String(state || ""), "base64url").toString("utf8");
    const dot = decoded.indexOf(".");
    if (dot < 0) return false;
    const ts = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    if (!ts || !sig) return false;
    const expectedSig = crypto.createHmac("sha256", clientSecret).update(ts).digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const age = Date.now() - Number(ts);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function postToken(params) {
  const { tenantId, clientId, clientSecret } = requireEnv();
  const url = "https://login.microsoftonline.com/" + encodeURIComponent(tenantId) + "/oauth2/v2.0/token";
  const body = new URLSearchParams(Object.assign({ client_id: clientId, client_secret: clientSecret }, params));
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Token request failed: " + r.status + " " + t.slice(0, 500));
  let json;
  try { json = JSON.parse(t); } catch (e) { throw new Error("Token response was not valid JSON"); }
  return json;
}

function exchangeCodeForToken(code, redirectUri) {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: DELEGATED_SCOPES,
  });
}

// NOTE: `scope` is intentionally OMITTED here. On a refresh_token grant, Azure
// AD v2 returns an access token for exactly the scopes the refresh token was
// granted when `scope` is absent — which is what we want: it can never fail by
// requesting a scope that isn't consented yet (the reason we must not pin
// DELEGATED_SCOPES here now that it lists the not-yet-granted Calendars.ReadWrite),
// and it automatically starts returning the calendar scope the moment Mark
// re-signs-in after Steve grants it. Pinning an explicit list would instead
// SILENTLY DROP any newly consented scope on the next refresh.
function refreshAccessToken(refreshToken) {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// Firestore access — duplicated (not shared/imported) from admin.js's
// getDb(), same rationale as the getBuildingRoofsServer() duplication
// documented in admin.js: this module can be required standalone by any
// future function without pulling in admin.js's PIN-gated action surface.
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

const SECRET_COLLECTION = "secrets";
const SECRET_DOC_ID = "ms_graph_delegated";

// ---------------------------------------------------------------------
// WHO IS ALLOWED TO AUTHORIZE THIS APP
// ---------------------------------------------------------------------
// ms-auth-start is necessarily a PUBLIC endpoint -- it's a plain link Mark
// clicks in a browser, so it cannot carry a Firebase bearer token and cannot
// be put behind requirePermission(). That means anyone on the internet can
// begin the sign-in flow. That is fine, and by itself harmless.
//
// What was NOT fine: ms-auth-callback used to take whoever came back from
// Microsoft, call /me purely as a "best-effort" nicety, and then store their
// refresh token in secrets/ms_graph_delegated regardless -- even if the /me
// call had failed and the identity was entirely unknown. Any Microsoft
// account that reached the callback URL would overwrite Mark's stored token,
// and every subsequent delegated Graph call -- his mail, his OneDrive, his
// inbox rules -- would run as THAT account instead of his.
//
// The control is here, at the storage layer, not only in the callback: the
// gate is enforced by the function that actually persists the token, so it
// still fails closed if some future caller forgets to check first.
// GRAPH_MAILBOX is the single source of truth for the one account permitted
// to authorize this app -- the same env var app-only auth already uses to
// decide whose mailbox this integration is for.
function expectedAccountUpn() {
  const v = process.env.GRAPH_MAILBOX;
  if (!v) {
    throw new Error(
      "GRAPH_MAILBOX is not set. Refusing to store a delegated refresh token without knowing " +
      "which account is allowed to authorize this app. Set it in Netlify > Environment variables."
    );
  }
  return String(v).trim().toLowerCase();
}

function isExpectedAccount(upn) {
  if (!upn) return false;
  return String(upn).trim().toLowerCase() === expectedAccountUpn();
}

// Security-relevant auth events go to the same audit_logs collection the rest
// of the app uses. Never allowed to change the security outcome: an audit
// write failure must not turn a refusal into an acceptance.
async function logDelegatedAuthEvent(entry) {
  try {
    const db = getDb();
    await db.collection("audit_logs").doc().set(Object.assign({
      ts: Date.now(),
      actorUid: "ms-auth-callback",
      actorRole: "system",
    }, entry));
  } catch (e) { /* swallow -- see above */ }
}

async function saveDelegatedToken({ refreshToken, accountUpn, accountName, scope }) {
  // FAIL CLOSED. An unknown or non-matching account never gets stored, no
  // matter who called this or how.
  if (!isExpectedAccount(accountUpn)) {
    await logDelegatedAuthEvent({
      action: "ms_delegated_auth_rejected",
      after: {
        attemptedAccountUpn: accountUpn || "(unknown - /me lookup failed or was skipped)",
        expectedAccountUpn: (() => { try { return expectedAccountUpn(); } catch (e) { return "(GRAPH_MAILBOX unset)"; } })(),
        reason: accountUpn ? "account_mismatch" : "identity_unconfirmed",
      },
    });
    const err = new Error(
      "Refusing to store a delegated refresh token for account \"" +
      (accountUpn || "(unknown)") + "\". Only the GRAPH_MAILBOX account may authorize this app."
    );
    err.code = "DELEGATED_ACCOUNT_MISMATCH";
    err.statusCode = 403;
    throw err;
  }

  const db = getDb();
  await db.collection(SECRET_COLLECTION).doc(SECRET_DOC_ID).set({
    refreshToken,
    accountUpn: accountUpn,
    accountName: accountName || null,
    scope: scope || null,
    updatedAt: Date.now(),
  }, { merge: true });
}

async function loadDelegatedTokenDoc() {
  const db = getDb();
  const snap = await db.collection(SECRET_COLLECTION).doc(SECRET_DOC_ID).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data && data.refreshToken ? data : null;
}

// In-memory access-token cache, per warm function instance only (same
// pattern as lib/graphAuth.js) — never persisted, a cold start just
// re-derives it from the stored refresh token.
let cachedAccess = null; // { accessToken, expiresAt }

async function getDelegatedAccessToken() {
  const now = Date.now();
  if (cachedAccess && cachedAccess.expiresAt > now + 60000) return cachedAccess.accessToken;

  const stored = await loadDelegatedTokenDoc();
  if (!stored) {
    throw new Error("No delegated refresh token on file yet — visit /.netlify/functions/ms-auth-start to sign in as Mark first.");
  }
  const json = await refreshAccessToken(stored.refreshToken);
  cachedAccess = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 3600) * 1000,
  };
  // Azure AD v2 issues a new refresh token on (most) refreshes when
  // offline_access is granted — the old one may stop working once a new
  // one is issued, so persist it immediately or the next refresh fails.
  if (json.refresh_token && json.refresh_token !== stored.refreshToken) {
    await saveDelegatedToken({
      refreshToken: json.refresh_token,
      accountUpn: stored.accountUpn,
      accountName: stored.accountName,
      scope: json.scope || stored.scope,
    });
  }
  return cachedAccess.accessToken;
}

// Does a granted-scope string carry the calendar scope? Pure + case-insensitive
// (Azure echoes scopes back with inconsistent casing), matched on whole
// space-separated tokens so a substring can't false-positive. Exported for tests.
function scopeStringHasCalendar(scopeStr) {
  const want = CALENDAR_SCOPE.toLowerCase();
  return String(scopeStr || "").toLowerCase().split(/\s+/).filter(Boolean).includes(want);
}

// Whether the CURRENTLY STORED delegated grant includes Calendars.ReadWrite.
// Reads the token doc's `scope` (populated at sign-in and refreshed on rotation)
// — no Graph call. Returns false (fail closed → calendar gated off) if the doc
// is missing, has no scope recorded, or is unreadable, so calendar actions stay
// disabled until a re-sign-in demonstrably grants the scope.
async function hasCalendarScope() {
  try {
    const stored = await loadDelegatedTokenDoc();
    return scopeStringHasCalendar(stored && stored.scope);
  } catch (e) {
    return false;
  }
}

async function graphFetchDelegated(pathOrUrl, options) {
  const token = await getDelegatedAccessToken();
  const opts = Object.assign({}, options);
  opts.headers = Object.assign({ Authorization: "Bearer " + token, Accept: "application/json" }, opts.headers || {});
  const url = pathOrUrl.indexOf("http") === 0 ? pathOrUrl : "https://graph.microsoft.com/v1.0" + pathOrUrl;
  return fetch(url, opts);
}

module.exports = {
  DELEGATED_SCOPES,
  CALENDAR_SCOPE,
  scopeStringHasCalendar,
  hasCalendarScope,
  requireEnv,
  resolveRedirectUri,
  signState,
  verifyState,
  exchangeCodeForToken,
  refreshAccessToken,
  saveDelegatedToken,
  loadDelegatedTokenDoc,
  getDelegatedAccessToken,
  graphFetchDelegated,
  expectedAccountUpn,
  isExpectedAccount,
  logDelegatedAuthEvent,
};
