// Receives the authorization code from Microsoft after Mark signs in
// (ms-auth-start.js sends him here), exchanges it server-side for an
// access token + refresh token, confirms identity with a lightweight
// /me call, and stores the refresh token in Firestore (never returned to
// the browser). This exact path is what must be registered as the
// redirect URI in the Azure app registration — see lib/graphDelegatedAuth.js
// for why both are hardcoded rather than env-configurable:
//   https://leak-work-orders.netlify.app/.netlify/functions/ms-auth-callback
//   https://dev--leak-work-orders.netlify.app/.netlify/functions/ms-auth-callback
const {
  resolveRedirectUri,
  verifyState,
  exchangeCodeForToken,
  saveDelegatedToken,
  isExpectedAccount,
  logDelegatedAuthEvent,
} = require("./lib/graphDelegatedAuth");

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function page(code, title, bodyHtml) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: "<!doctype html><html><head><meta charset='utf-8'><title>" + esc(title) +
      "</title></head><body style='font-family:sans-serif;max-width:520px;margin:60px auto;padding:0 20px'>" +
      bodyHtml + "</body></html>",
  };
}

exports.handler = async function (event) {
  const p = event.queryStringParameters || {};

  if (p.error) {
    return page(400, "Sign-in failed", "<h3>Sign-in failed</h3><p>" + esc(p.error) + "</p><p>" + esc(p.error_description || "") + "</p>");
  }
  if (!p.code || !p.state) {
    return page(400, "Missing code or state", "<h3>Missing code or state</h3><p>This page must be reached via the Microsoft sign-in redirect (from ms-auth-start), not visited directly.</p>");
  }
  if (!verifyState(p.state)) {
    return page(400, "Expired or invalid link", "<h3>Expired or invalid sign-in link</h3><p>Sign-in links expire after 10 minutes. Please start over from the ms-auth-start link.</p>");
  }

  const host = event.headers && (event.headers.host || event.headers.Host);
  const redirectUri = resolveRedirectUri(host);
  if (!redirectUri) {
    return page(400, "Unrecognized host", "<h3>Unrecognized host</h3><p>'" + esc(host) + "' is not a registered redirect URI host.</p>");
  }

  try {
    const tokenJson = await exchangeCodeForToken(p.code, redirectUri);
    if (!tokenJson.refresh_token) {
      return page(500, "No refresh token returned",
        "<h3>Sign-in succeeded but no refresh token was returned</h3>" +
        "<p>Check that the app registration's delegated permissions include <code>offline_access</code> and that admin consent was granted.</p>");
    }

    // IDENTITY CONFIRMATION IS MANDATORY, not best-effort.
    //
    // This endpoint is necessarily public (it's the redirect target of a
    // browser sign-in, so it can't carry a bearer token). It used to treat
    // the /me lookup as a nicety and store the refresh token regardless of
    // who came back -- or even if the lookup failed and the identity was
    // completely unknown. That meant ANY Microsoft account that reached this
    // URL could overwrite secrets/ms_graph_delegated, and every delegated
    // Graph call afterwards -- Mark's mail, his OneDrive, his inbox rules --
    // would run as that account instead of his.
    //
    // Now: if we cannot positively confirm the signed-in account, we refuse.
    // saveDelegatedToken() independently enforces the same rule at the
    // storage layer (fail closed twice, on purpose).
    let who = null;
    try {
      const meResp = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,displayName", {
        headers: { Authorization: "Bearer " + tokenJson.access_token, Accept: "application/json" },
      });
      if (meResp.ok) who = await meResp.json();
    } catch (e) { /* handled below -- an unconfirmed identity is a refusal, not a shrug */ }

    if (!who || !who.userPrincipalName) {
      await logDelegatedAuthEvent({
        action: "ms_delegated_auth_rejected",
        after: { reason: "identity_unconfirmed", attemptedAccountUpn: "(/me lookup failed)" },
      });
      return page(403, "Could not confirm identity",
        "<h3>Sign-in refused</h3><p>We could not confirm which Microsoft account signed in, " +
        "so no delegated access was stored. Nothing has been changed.</p>");
    }

    if (!isExpectedAccount(who.userPrincipalName)) {
      // Refusal is logged inside saveDelegatedToken() too, but we never even
      // get that far -- log it here and stop.
      await logDelegatedAuthEvent({
        action: "ms_delegated_auth_rejected",
        after: {
          reason: "account_mismatch",
          attemptedAccountUpn: who.userPrincipalName,
          attemptedAccountName: who.displayName || null,
        },
      });
      return page(403, "Wrong account",
        "<h3>Sign-in refused</h3><p>This app may only be authorized by the mailbox it is " +
        "configured for. <strong>" + esc(who.userPrincipalName) + "</strong> is not that account, " +
        "so no delegated access was stored and nothing has been changed.</p>");
    }

    await saveDelegatedToken({
      refreshToken: tokenJson.refresh_token,
      accountUpn: who.userPrincipalName,
      accountName: who.displayName || null,
      scope: tokenJson.scope || null,
    });

    await logDelegatedAuthEvent({
      action: "ms_delegated_auth_granted",
      after: { accountUpn: who.userPrincipalName, accountName: who.displayName || null, scope: tokenJson.scope || null },
    });

    const whoLine = esc(who.displayName) + " (" + esc(who.userPrincipalName) + ")";
    return page(200, "Signed in", "<h3>Signed in ✓</h3><p>Delegated access is now stored for " + whoLine + ".</p><p>You can close this tab.</p>");
  } catch (e) {
    return page(500, "Token exchange failed", "<h3>Token exchange failed</h3><p>" + esc(e && e.message ? e.message : "unknown error") + "</p>");
  }
};
