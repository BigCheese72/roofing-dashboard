// Shared Microsoft Graph app-only (client-credentials) auth helper for the
// Outlook / Microsoft 365 integration. Mirrors companycam.js/admin.js's
// plain-JS, no-framework style. The client secret is read from an
// environment variable and never logged, returned, or written to disk.
//
// Required env vars (set in Netlify > Project configuration > Environment
// variables — never hardcoded here):
//   GRAPH_TENANT_ID     — Azure AD tenant id
//   GRAPH_CLIENT_ID     — app registration (client) id
//   GRAPH_CLIENT_SECRET — app registration client secret
//   GRAPH_MAILBOX       — mailbox this app reads, e.g. marks@watkinsroofing.net
//
// App-only Graph access for this app registration is restricted by an
// Exchange Application Access Policy to a specific security group
// ("RoofOps Team"). A mailbox just added to that group can return 403 for
// up to ~30 minutes while the policy propagates through Exchange Online —
// see DEV_NOTES.md "Outlook / Microsoft 365 integration" for how to read
// that error instead of mistaking it for a credential/code bug.

// In-memory only, per warm function instance — never persisted. A cold
// start (new instance) just fetches a fresh token.
let cachedToken = null; // { accessToken, expiresAt }

function requireEnv() {
  const keys = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_MAILBOX"];
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error("Missing required env var(s): " + missing.join(", ") +
      ". Add them in Netlify > Project configuration > Environment variables, then redeploy.");
  }
  return {
    tenantId: process.env.GRAPH_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET,
    mailbox: process.env.GRAPH_MAILBOX
  };
}

async function getAppOnlyToken() {
  const { tenantId, clientId, clientSecret } = requireEnv();
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.accessToken;
  }
  const url = "https://login.microsoftonline.com/" + encodeURIComponent(tenantId) + "/oauth2/v2.0/token";
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const t = await r.text();
  if (!r.ok) {
    throw new Error("Token request failed: " + r.status + " " + t.slice(0, 300));
  }
  let json;
  try { json = JSON.parse(t); } catch (e) { throw new Error("Token response was not valid JSON"); }
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (Number(json.expires_in || 3600) * 1000)
  };
  return cachedToken.accessToken;
}

// Thin wrapper around fetch() that attaches a bearer token and resolves a
// relative path against the Graph v1.0 base URL. Pass a full URL (Graph's
// own @odata.nextLink pagination links, for example) and it's used as-is.
async function graphFetch(pathOrUrl, options) {
  const token = await getAppOnlyToken();
  const opts = Object.assign({}, options);
  opts.headers = Object.assign({ "Authorization": "Bearer " + token, "Accept": "application/json" }, opts.headers || {});
  const url = pathOrUrl.indexOf("http") === 0 ? pathOrUrl : "https://graph.microsoft.com/v1.0" + pathOrUrl;
  return fetch(url, opts);
}

module.exports = { getAppOnlyToken, graphFetch, requireEnv };
