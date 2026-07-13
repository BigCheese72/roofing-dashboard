// Graph capability self-test -- a DIAGNOSTIC endpoint, dev-only in intent.
//
// Purpose: answer "which Microsoft Graph capabilities does this app-only app
// registration ACTUALLY have against Mark's mailbox, right now" with observed
// HTTP results instead of a screenshot of somebody's PowerShell window.
//
// It exists because nothing else deployed exercises Contacts, Files/OneDrive,
// or mail WRITE: outlook.js only ever listed folders and messages. Without
// this, capabilities 2-4 could only be asserted, not demonstrated.
//
// SAFETY / SCOPE:
//   * Behind requirePermission(..., "warranty.manage_reports") -- the same
//     gate as outlook.js and inspection-reports.js. Auth runs FIRST, before
//     the env check, so an unauthenticated caller gets 401, never a 500 that
//     leaks configuration state.
//   * NEVER returns the access token, the client secret, or any mail CONTENT.
//     It returns HTTP status codes, Graph error codes, the token's granted
//     `roles` claim (the list of consented APPLICATION permissions -- a list
//     of permission names, not a credential), and counts. No subjects, no
//     bodies, no addresses, no attachment contents.
//   * Every write probe is REVERSIBLE and cleans up after itself: it creates
//     an obviously-named throwaway object and immediately deletes it. Each
//     probe reports whether cleanup succeeded, so a leftover is visible
//     rather than silent.
//   * Read-only against production data in the sense that matters: it never
//     touches Firestore, Storage, CompanyCam, or any RoofOps record.
const { requirePermission } = require("./lib/authGuard");
const { getAppOnlyToken, graphFetch, requireEnv } = require("./lib/graphAuth");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj, null, 2) };
}

const STAMP = "RoofOps-Graph-Selftest-" + Date.now();

// Reads a Graph response into a compact, SAFE result: status, ok, and (on
// failure) Graph's own error code/message, which is what actually
// distinguishes "AppOnly AccessPolicy blocked this" from "permission not
// consented" from "endpoint doesn't exist".
async function probe(label, path, options) {
  try {
    const r = await graphFetch(path, options);
    const text = await r.text();
    let errCode = null, errMsg = null, count = null, id = null;
    if (!r.ok) {
      try {
        const j = JSON.parse(text);
        errCode = (j.error && j.error.code) || null;
        errMsg = (j.error && j.error.message) || null;
      } catch (e) { errMsg = text.slice(0, 200); }
    } else if (text) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j.value)) count = j.value.length;
        if (j.id) id = j.id;
      } catch (e) { /* 204 No Content etc. */ }
    }
    return {
      label,
      status: r.status,
      ok: r.ok,
      graphErrorCode: errCode,
      // Truncated: Graph error messages are descriptive but never contain
      // mail content. Truncate anyway, on principle.
      graphErrorMessage: errMsg ? String(errMsg).slice(0, 300) : null,
      itemsReturned: count,
      createdId: id,
    };
  } catch (e) {
    return { label, status: -1, ok: false, graphErrorCode: "REQUEST_FAILED", graphErrorMessage: String(e && e.message).slice(0, 200) };
  }
}

// Decodes the app-only JWT's payload and returns ONLY the granted-permission
// list and non-sensitive claims. The token itself is never returned or logged.
// The `roles` claim is authoritative for what APPLICATION permissions Azure
// actually consented -- more reliable than any screenshot.
async function tokenRoles() {
  try {
    const token = await getAppOnlyToken();
    const parts = String(token).split(".");
    if (parts.length < 2) return { ok: false, error: "token was not a JWT" };
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return {
      ok: true,
      grantedApplicationPermissions: (payload.roles || []).sort(),
      appId: payload.appid || null,
      tenantId: payload.tid || null,
      audience: payload.aud || null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message).slice(0, 300) };
  }
}

exports.handler = async function (event) {
  // AUTH FIRST -- before requireEnv, before any Graph call.
  try {
    await requirePermission(event, "warranty.manage_reports");
  } catch (e) {
    return resp(e.statusCode || 401, { error: e.message });
  }

  let mailbox;
  try { ({ mailbox } = requireEnv()); }
  catch (e) { return resp(500, { error: e.message }); }

  const U = "/users/" + encodeURIComponent(mailbox);
  const results = { mailbox, stamp: STAMP, token: null, capabilities: {}, cleanup: [] };

  results.token = await tokenRoles();

  // ---- 1. MAIL READ (app-only). The CCM pipeline needs ONLY this.
  // A 403 with "AppOnly AccessPolicy" here means Steve's Exchange
  // Application Access Policy is still blocking the app.
  results.capabilities.mail_read_folders = await probe("GET mailFolders", U + "/mailFolders?$top=1");
  results.capabilities.mail_read_messages = await probe("GET messages", U + "/messages?$top=1&$select=id");

  // ---- 2. MAIL WRITE (Mail.ReadWrite): create a throwaway folder, delete it.
  const mkFolder = await probe("POST mailFolders (create)", U + "/mailFolders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: STAMP }),
  });
  results.capabilities.mail_write = mkFolder;
  if (mkFolder.ok && mkFolder.createdId) {
    const del = await probe("DELETE mailFolders (cleanup)", U + "/mailFolders/" + encodeURIComponent(mkFolder.createdId), { method: "DELETE" });
    results.cleanup.push({ what: "mail folder " + STAMP, deleted: del.ok, status: del.status });
  }

  // ---- 3. CONTACTS (Contacts.ReadWrite): read, then create+delete.
  results.capabilities.contacts_read = await probe("GET contacts", U + "/contacts?$top=1&$select=id");
  const mkContact = await probe("POST contacts (create)", U + "/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ givenName: "RoofOps", surname: "Selftest", fileAs: STAMP }),
  });
  results.capabilities.contacts_write = mkContact;
  if (mkContact.ok && mkContact.createdId) {
    const del = await probe("DELETE contacts (cleanup)", U + "/contacts/" + encodeURIComponent(mkContact.createdId), { method: "DELETE" });
    results.cleanup.push({ what: "contact " + STAMP, deleted: del.ok, status: del.status });
  }

  // ---- 4. FILES / ONEDRIVE (Files.ReadWrite.All): read drive, then
  // upload+delete a tiny text file.
  results.capabilities.files_read_drive = await probe("GET drive root children", U + "/drive/root/children?$top=1&$select=id");
  const put = await probe("PUT drive file (create)", U + "/drive/root:/" + STAMP + ".txt:/content", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "RoofOps Graph capability self-test. Safe to delete.",
  });
  results.capabilities.files_write = put;
  if (put.ok && put.createdId) {
    const del = await probe("DELETE drive file (cleanup)", U + "/drive/items/" + encodeURIComponent(put.createdId), { method: "DELETE" });
    results.cleanup.push({ what: "OneDrive file " + STAMP + ".txt", deleted: del.ok, status: del.status });
  }

  // ---- Summary: did the AppOnly AccessPolicy 403 appear ANYWHERE?
  const all = Object.keys(results.capabilities).map(k => results.capabilities[k]);
  const accessPolicyBlocked = all.filter(r =>
    r.status === 403 && /AppOnly|AccessPolicy|ApplicationAccessPolicy/i.test(
      (r.graphErrorMessage || "") + " " + (r.graphErrorCode || "")
    )
  ).map(r => r.label);

  results.summary = {
    worked: all.filter(r => r.ok).map(r => r.label),
    failed: all.filter(r => !r.ok).map(r => r.label + " -> " + r.status + " " + (r.graphErrorCode || "")),
    appOnlyAccessPolicyStillBlocking: accessPolicyBlocked.length > 0,
    appOnlyAccessPolicyBlockedCalls: accessPolicyBlocked,
  };

  return resp(200, results);
};
