// Outlook / Microsoft 365 integration — Phase 0 (auth + mailbox read).
// App-only (client-credentials) Graph access via lib/graphAuth.js — same
// proxy-pattern style as companycam.js (token never reaches the browser).
// Read-only today: lists mail folders and recent messages for the mailbox
// configured in GRAPH_MAILBOX. See DEV_NOTES.md "Outlook / Microsoft 365
// integration" for setup and the required env vars.
//
// Access to this mailbox is gated by an Exchange Application Access Policy
// restricted to a specific security group. A 403 here most likely means
// the mailbox hasn't finished propagating into that group yet (can take up
// to ~30 minutes after being added) — not a code/credential bug. The raw
// Graph error body is passed through in the response so that's easy to
// tell apart from a real auth failure.
const { graphFetch, requireEnv } = require("./lib/graphAuth");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function mapFolder(f) {
  return {
    id: f.id,
    displayName: f.displayName,
    totalItemCount: f.totalItemCount,
    unreadItemCount: f.unreadItemCount
  };
}

function mapMessage(m) {
  return {
    id: m.id,
    subject: m.subject || "(no subject)",
    from: (m.from && m.from.emailAddress) ? m.from.emailAddress.address : null,
    receivedDateTime: m.receivedDateTime || null,
    hasAttachments: !!m.hasAttachments,
    isRead: !!m.isRead,
    bodyPreview: m.bodyPreview || ""
  };
}

exports.handler = async function (event) {
  let mailbox;
  try {
    ({ mailbox } = requireEnv());
  } catch (e) {
    return resp(500, { error: e.message });
  }

  const p = event.queryStringParameters || {};
  const action = p.action || "folders";

  try {
    if (action === "folders") {
      const r = await graphFetch("/users/" + encodeURIComponent(mailbox) + "/mailFolders?$top=50");
      const t = await r.text();
      if (!r.ok) return resp(r.status === 403 ? 403 : 502, { error: "Graph said: " + r.status + " " + t.slice(0, 500) });
      const json = JSON.parse(t);
      const folders = (json.value || []).map(mapFolder);
      return resp(200, { folders });
    }

    if (action === "messages") {
      const folderId = p.folder_id ? String(p.folder_id) : null;
      const top = Math.min(50, Math.max(1, parseInt(p.top || "10", 10) || 10));
      const base = folderId
        ? "/users/" + encodeURIComponent(mailbox) + "/mailFolders/" + encodeURIComponent(folderId) + "/messages"
        : "/users/" + encodeURIComponent(mailbox) + "/messages";
      const url = base + "?$top=" + top + "&$orderby=receivedDateTime%20desc" +
        "&$select=id,subject,from,receivedDateTime,hasAttachments,isRead,bodyPreview";
      const r = await graphFetch(url);
      const t = await r.text();
      if (!r.ok) return resp(r.status === 403 ? 403 : 502, { error: "Graph said: " + r.status + " " + t.slice(0, 500) });
      const json = JSON.parse(t);
      const messages = (json.value || []).map(mapMessage);
      return resp(200, { messages });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};

/* ============================================================
 * NOT BUILT YET — left as notes for the next phases, per DEV_NOTES.md /
 * ROADMAP.md convention of documenting what's coming without building
 * ahead of a real spec.
 *
 * Phase 1: organize mail into folders by sender.
 *   Planned: an `organize` action that lists inbox messages, groups by
 *   sender/domain, and creates/moves them into per-sender child
 *   mailFolders — POST /users/{mailbox}/mailFolders to create,
 *   POST /users/{mailbox}/messages/{id}/move to file. Needs
 *   Mail.ReadWrite (app-only) — this Phase 0 build only requests/uses
 *   Mail.Read, so the Azure app registration's API permissions (and
 *   admin consent) need to be extended before this can be built.
 *
 * Phase 2: watch for inspection-report emails and file the PDF to the
 *   matching CompanyCam project.
 *   Planned: either polling (a scheduled Netlify function querying
 *   /messages?$filter=... for new mail matching a subject/sender
 *   pattern) or a Graph change-notification subscription
 *   (POST /subscriptions, needs a public HTTPS notification endpoint —
 *   a Netlify function URL would work). On a match: download the
 *   attachment (GET .../messages/{id}/attachments), match it to a
 *   CompanyCam project (reuse the name-matching approach already noted
 *   in "Push app-added photos to CompanyCam" in DEV_NOTES.md), then
 *   POST it through companycam.js's existing upload_document action.
 * ============================================================ */
