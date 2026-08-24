// Start of the Microsoft Graph DELEGATED sign-in flow — Mark visits this
// URL directly (a plain link, no form/button needed) and gets redirected
// to Microsoft's own sign-in page to authenticate and consent once. See
// lib/graphDelegatedAuth.js for the full design writeup and DEV_NOTES.md
// "Outlook / Microsoft 365 — delegated auth" for setup.
//
// Sign-in URLs (pick the one matching whichever site you're testing):
//   https://leak-work-orders.netlify.app/.netlify/functions/ms-auth-start
//   https://dev--leak-work-orders.netlify.app/.netlify/functions/ms-auth-start
const { requireEnv, resolveRedirectUri, signState, DELEGATED_SCOPES } = require("./lib/graphDelegatedAuth");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  let tenantId, clientId;
  try {
    ({ tenantId, clientId } = requireEnv());
  } catch (e) {
    return resp(500, { error: e.message });
  }

  const host = event.headers && (event.headers.host || event.headers.Host);
  const redirectUri = resolveRedirectUri(host);
  if (!redirectUri) {
    return resp(400, {
      error: "Request host '" + host + "' is not one of the registered redirect URI hosts " +
        "(leak-work-orders.netlify.app or dev--leak-work-orders.netlify.app).",
    });
  }

  const state = signState();
  const authorizeUrl = "https://login.microsoftonline.com/" + encodeURIComponent(tenantId) + "/oauth2/v2.0/authorize" +
    "?client_id=" + encodeURIComponent(clientId) +
    "&response_type=code" +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&response_mode=query" +
    "&scope=" + encodeURIComponent(DELEGATED_SCOPES) +
    "&state=" + encodeURIComponent(state);

  return { statusCode: 302, headers: { Location: authorizeUrl } };
};
