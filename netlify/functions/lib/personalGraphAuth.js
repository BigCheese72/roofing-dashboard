// Microsoft Graph DELEGATED auth for Mark's PERSONAL morning-brief assistant.
//
// This module is deliberately, structurally isolated from the RoofOps business
// M365 integration (lib/graphDelegatedAuth.js + lib/graphAuth.js):
//
//   * SEPARATE Azure app registration. It reads ONLY the PA_MS_* env vars
//     (PA = Personal Assistant). It NEVER reads GRAPH_TENANT_ID /
//     GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET, and NEVER touches the business
//     refresh-token doc (secrets/ms_graph_delegated). There is no code path
//     from here to the broad business grant — if the PA_MS_* creds are not
//     configured, this throws "personal assistant credential not configured"
//     rather than falling back to the business app's token. That fail-closed,
//     no-fallback behavior is the whole point of the separation and is covered
//     by tests/personalGraphAuth.test.js.
//
//   * NARROW scope. Mail + Calendar ONLY (Mail.ReadWrite for read + draft;
//     Calendars.ReadWrite for read + additive event create). No Contacts, no
//     Files/OneDrive, no MailboxSettings/inbox-rules — the personal brief has
//     no business touching any of those, so the app registration must not be
//     consented for them and this scope string must not request them.
//
// CREDENTIAL SOURCE (env vars Mark provisions in Netlify — see
// docs/personal-assistant-setup.md):
//   PA_MS_TENANT_ID     — Azure AD tenant id of the personal app registration
//   PA_MS_CLIENT_ID     — the personal app registration's (client) id
//   PA_MS_CLIENT_SECRET — the personal app registration's client secret
//   PA_MS_REFRESH_TOKEN — a delegated refresh token obtained once, by Mark,
//                         consenting the personal app for the narrow scopes
//                         below (offline_access included). Used as the SEED.
//   PA_MS_MAILBOX       — OPTIONAL. Mark's UPN (e.g. marks@watkinsroofing.net).
//                         If set, the diag action asserts the connected account
//                         matches it. Not required to function.
//
// TOKEN ROTATION: Azure AD v2 rotates the refresh token on refresh when
// offline_access is granted. Netlify env vars are static/deploy-time, so the
// rotated token is persisted to Firestore (secrets/pa_ms_graph_delegated — a
// SEPARATE doc from the business ms_graph_delegated), read/written ONLY via the
// Firebase Admin SDK. The PA_MS_REFRESH_TOKEN env var is the bootstrap seed:
// used when the Firestore doc is empty (first run, or after Mark rotates the
// seed). firestore.rules already denies all client access to secrets/{secretId}
// (wildcard), so the new doc is covered with no rules change.
//
// The client secret is never logged, returned, or written to disk.

const admin = require("firebase-admin");

// Mail + Calendar ONLY. offline_access for the refresh token, User.Read so the
// diag action can name the connected account. Intentionally NO Contacts.ReadWrite,
// NO Files.ReadWrite, NO MailboxSettings.ReadWrite — those belong to the business
// grant, not the personal brief.
const PERSONAL_SCOPES = [
  "offline_access",
  "Mail.ReadWrite",
  "Calendars.ReadWrite",
  "User.Read",
].join(" ");

const NOT_CONFIGURED =
  "personal assistant credential not configured. Set PA_MS_TENANT_ID, " +
  "PA_MS_CLIENT_ID, PA_MS_CLIENT_SECRET and PA_MS_REFRESH_TOKEN in Netlify " +
  "> Environment variables (see docs/personal-assistant-setup.md), then " +
  "redeploy. This function never falls back to the RoofOps business M365 grant.";

// Reads ONLY PA_MS_* — never the business GRAPH_* vars. If any required PA_MS_*
// var is missing, throw a clear, actionable error whose statusCode is 503
// (Service Unavailable — the capability is unconfigured, not the caller's
// fault) so the handler can surface it as-is.
function requirePersonalEnv() {
  const tenantId = process.env.PA_MS_TENANT_ID;
  const clientId = process.env.PA_MS_CLIENT_ID;
  const clientSecret = process.env.PA_MS_CLIENT_SECRET;
  const seedRefreshToken = process.env.PA_MS_REFRESH_TOKEN;
  const missing = [];
  if (!tenantId) missing.push("PA_MS_TENANT_ID");
  if (!clientId) missing.push("PA_MS_CLIENT_ID");
  if (!clientSecret) missing.push("PA_MS_CLIENT_SECRET");
  if (!seedRefreshToken) missing.push("PA_MS_REFRESH_TOKEN");
  if (missing.length) {
    const err = new Error(NOT_CONFIGURED + " Missing: " + missing.join(", ") + ".");
    err.code = "PA_NOT_CONFIGURED";
    err.statusCode = 503;
    throw err;
  }
  return { tenantId, clientId, clientSecret, seedRefreshToken };
}

// True iff the personal credential is fully configured — lets the handler
// answer a config-probe without throwing.
function isPersonalConfigured() {
  try { requirePersonalEnv(); return true; }
  catch (e) { return false; }
}

async function postToken(params) {
  const { tenantId, clientId, clientSecret } = requirePersonalEnv();
  const url = "https://login.microsoftonline.com/" + encodeURIComponent(tenantId) + "/oauth2/v2.0/token";
  const body = new URLSearchParams(Object.assign({ client_id: clientId, client_secret: clientSecret }, params));
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Personal token request failed: " + r.status + " " + t.slice(0, 400));
  let json;
  try { json = JSON.parse(t); } catch (e) { throw new Error("Personal token response was not valid JSON"); }
  return json;
}

function refreshAccessToken(refreshToken) {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: PERSONAL_SCOPES,
  });
}

// Firestore access — duplicated (not shared) from graphDelegatedAuth.js's
// getDb() for the same reason it does: this module can be required standalone
// without dragging in the business auth surface.
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

// SEPARATE doc from the business token. The business path uses
// secrets/ms_graph_delegated; the personal path uses this and only this.
const SECRET_COLLECTION = "secrets";
const SECRET_DOC_ID = "pa_ms_graph_delegated";

async function loadStoredRefreshToken() {
  const db = getDb();
  const snap = await db.collection(SECRET_COLLECTION).doc(SECRET_DOC_ID).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return (data && data.refreshToken) || null;
}

async function saveStoredRefreshToken(refreshToken, scope) {
  const db = getDb();
  await db.collection(SECRET_COLLECTION).doc(SECRET_DOC_ID).set({
    refreshToken,
    scope: scope || null,
    updatedAt: Date.now(),
  }, { merge: true });
}

// In-memory access-token cache, per warm function instance only — never
// persisted. A cold start re-derives it from the stored/seed refresh token.
let cachedAccess = null; // { accessToken, expiresAt }

// Resets the warm-instance cache. Test-only hook.
function _resetCache() { cachedAccess = null; }

async function getPersonalAccessToken() {
  const now = Date.now();
  if (cachedAccess && cachedAccess.expiresAt > now + 60000) return cachedAccess.accessToken;

  // Throws PA_NOT_CONFIGURED (503) if the personal creds are absent — this is
  // the no-fallback guarantee. We never reach the business token from here.
  const { seedRefreshToken } = requirePersonalEnv();

  // Prefer the rotated token in Firestore; fall back to the env-var seed on a
  // cold store (first run, or after Mark sets a fresh PA_MS_REFRESH_TOKEN).
  let refreshToken = null;
  try { refreshToken = await loadStoredRefreshToken(); } catch (e) { /* store unreadable — use seed */ }
  if (!refreshToken) refreshToken = seedRefreshToken;

  const json = await refreshAccessToken(refreshToken);
  cachedAccess = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 3600) * 1000,
  };
  // Persist the rotated refresh token so the next cold start doesn't lean on a
  // possibly-superseded seed.
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    try { await saveStoredRefreshToken(json.refresh_token, json.scope || PERSONAL_SCOPES); }
    catch (e) { /* non-fatal: the current access token is already valid */ }
  }
  return cachedAccess.accessToken;
}

// Thin fetch wrapper: attaches the personal bearer token and resolves relative
// paths against Graph v1.0. Full URLs (nextLink) are used as-is.
async function graphFetchPersonal(pathOrUrl, options) {
  const token = await getPersonalAccessToken();
  const opts = Object.assign({}, options);
  opts.headers = Object.assign({ Authorization: "Bearer " + token, Accept: "application/json" }, opts.headers || {});
  const url = pathOrUrl.indexOf("http") === 0 ? pathOrUrl : "https://graph.microsoft.com/v1.0" + pathOrUrl;
  return fetch(url, opts);
}

module.exports = {
  PERSONAL_SCOPES,
  NOT_CONFIGURED,
  requirePersonalEnv,
  isPersonalConfigured,
  refreshAccessToken,
  getPersonalAccessToken,
  graphFetchPersonal,
  _resetCache,
  _SECRET_DOC_ID: SECRET_DOC_ID,
};
