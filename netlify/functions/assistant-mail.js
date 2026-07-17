// assistant-mail — Mark's PERSONAL morning-brief assistant against his own
// mailbox and calendar, on a SEPARATE, narrowly-scoped Microsoft 365 credential
// (lib/personalGraphAuth.js, PA_MS_* env vars) — NOT the RoofOps business grant.
//
// WHY A SEPARATE FUNCTION + CREDENTIAL:
//   The business integration (contacts-sync.js + lib/graphDelegatedAuth.js) runs
//   on a broad delegated grant (Mail/Contacts/Files/MailboxSettings). Mark's
//   personal brief has no business riding on that token. This function reaches
//   Graph ONLY through personalGraphAuth.getPersonalAccessToken(), which reads
//   ONLY PA_MS_* env vars and NEVER falls back to the business credential. If the
//   personal creds aren't configured, every action here returns a clear 503
//   "personal assistant credential not configured" — it does not, and cannot,
//   borrow the business grant.
//
// SCOPE — Mail + Calendar ONLY. The personal app registration is consented for
// Mail.ReadWrite + Calendars.ReadWrite (+ offline_access, User.Read). No
// Contacts, no Files/OneDrive, no inbox rules.
//
// GUARDRAILS (this function is deliberately incapable of the dangerous things):
//   * AUTH FIRST — behind requirePermission(..., "warranty.manage_reports"),
//     the same Firebase-login gate as contacts-sync. Runs before any env read
//     or Graph call, so an unauthenticated caller gets 401, never a 500 that
//     leaks configuration state.
//   * MAIL is READ + DRAFT-ONLY. mail_list / mail_read issue GETs only and never
//     PATCH isRead (reading via Graph does not mark a message read — that's an
//     Outlook-client behavior, not a Graph one). create_draft only CREATES a
//     draft in Drafts and sends nothing. There is NO action here that sends,
//     replies-and-sends, forwards, deletes, or marks mail read.
//   * CALENDAR is READ + CREATE-ONLY. calendar_list reads events; calendar_create
//     adds an event to Mark's OWN calendar (additive, his calendar, reversible in
//     Outlook). There is deliberately NO update/delete action — this function
//     cannot modify or remove any existing event, his or anyone else's. Moving
//     someone else's meeting would require a capability that simply does not
//     exist in this file.
//   * It never returns the refresh token, the client secret, or the access token.
const { requirePermission } = require("./lib/authGuard");
const { graphFetchPersonal, isPersonalConfigured, requirePersonalEnv } = require("./lib/personalGraphAuth");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function gj(pathOrUrl, options) {
  const r = await graphFetchPersonal(pathOrUrl, options);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON (204 etc.) */ }
  if (!r.ok) {
    const err = new Error("Graph " + r.status + " " + ((json && json.error && json.error.code) || "") +
      " " + ((json && json.error && json.error.message) || String(text).slice(0, 200)));
    err.statusCode = r.status;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// PURE HELPERS (no Graph, no I/O) — exported on _internals for unit testing.
// ---------------------------------------------------------------------------

// Mark's house sign-off, mirrored from contacts-sync's create_draft discipline
// so a brief that writes only the substance still drafts in his voice.
const SIGNOFF_TEXT = "Respectfully,\nMark";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Append the sign-off to plain-text body content unless it already signs off
// (idempotent — never doubles it).
function textWithSignoff(text) {
  const t = String(text == null ? "" : text).replace(/\s+$/, "");
  if (/(^|\n)\s*respectfully\b/i.test(t)) return t;
  return (t ? t + "\n\n" : "") + SIGNOFF_TEXT;
}

// Normalize a caller's recipient list into Graph's shape. Accepts bare address
// strings or {address|email, name} objects; drops anything without a plausible
// "@" local so a typo can't produce a bad recipient — and it's a DRAFT anyway,
// so Mark sees every recipient before sending.
function normalizeRecipients(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) {
    let address = null, name = null;
    if (typeof r === "string") address = r;
    else if (r && typeof r === "object") { address = r.address || r.email || null; name = r.name || null; }
    address = String(address == null ? "" : address).trim();
    if (address.indexOf("@") < 1) continue;
    out.push({ emailAddress: name ? { address, name: String(name) } : { address } });
  }
  return out;
}

// Map a Graph message resource to the compact row the brief consumes. Never
// includes anything that could mark the message read; body is only present when
// the caller asked for it (mail_read), as plain text.
function mapMessage(m, opts) {
  opts = opts || {};
  const from = (m.from && m.from.emailAddress) || (m.sender && m.sender.emailAddress) || {};
  const row = {
    id: m.id,
    subject: (m.subject || "(no subject)"),
    from: { name: from.name || null, address: String(from.address || "").toLowerCase() || null },
    date: m.receivedDateTime || m.sentDateTime || null,
    isRead: !!m.isRead,
    preview: (m.bodyPreview || "").trim() || null,
    webLink: m.webLink || null,
  };
  if (opts.withBody) row.body = ((m.body && m.body.content) || "").trim() || null;
  if (opts.withRecipients) {
    row.to = (m.toRecipients || []).map(r => (r.emailAddress && r.emailAddress.address) || null).filter(Boolean);
    row.cc = (m.ccRecipients || []).map(r => (r.emailAddress && r.emailAddress.address) || null).filter(Boolean);
  }
  return row;
}

// Resolve a named window ("today" | "week") — or an explicit {start,end} —
// into the ISO boundaries /me/calendarView needs. `now` is injectable so the
// resolver is deterministically testable. "today" = local-midnight today to
// local-midnight tomorrow; "week" = now through 7 days out. Explicit start/end
// (ISO strings) win over the named range.
function resolveCalendarRange(input, now) {
  input = input || {};
  now = now instanceof Date ? now : new Date();
  if (input.start && input.end) {
    return { startDateTime: new Date(input.start).toISOString(), endDateTime: new Date(input.end).toISOString() };
  }
  const range = String(input.range || "today").toLowerCase();
  if (range === "week") {
    const end = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    return { startDateTime: now.toISOString(), endDateTime: end.toISOString() };
  }
  // "today": from local midnight to next local midnight.
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { startDateTime: startLocal.toISOString(), endDateTime: endLocal.toISOString() };
}

// Map a Graph event resource to the compact row the brief consumes.
function mapEvent(e) {
  const org = (e.organizer && e.organizer.emailAddress) || {};
  return {
    id: e.id,
    subject: e.subject || "(no title)",
    start: (e.start && e.start.dateTime) || null,
    end: (e.end && e.end.dateTime) || null,
    timeZone: (e.start && e.start.timeZone) || null,
    isAllDay: !!e.isAllDay,
    location: (e.location && e.location.displayName) || null,
    organizer: { name: org.name || null, address: String(org.address || "").toLowerCase() || null },
    attendees: (e.attendees || []).map(a => ({
      name: (a.emailAddress && a.emailAddress.name) || null,
      address: (a.emailAddress && String(a.emailAddress.address || "").toLowerCase()) || null,
      response: (a.status && a.status.response) || null,
    })),
    preview: (e.bodyPreview || "").trim() || null,
    webLink: e.webLink || null,
  };
}

// A YYYY-MM-DD date, taken from the leading 10 chars of a date/ISO string when
// present (so "2026-07-20" and "2026-07-20T00:00:00Z" both stay the 20th — no
// timezone shift), else derived from a Date's LOCAL components. Never toISOString
// (that would convert to UTC and can roll an all-day date back a day).
function dateOnly(v) {
  const s = String(v == null ? "" : v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Build the POST /me/events payload for calendar_create. Pure + validating:
// throws a 400-tagged error when subject or a start/end pair is missing, so the
// handler can return a clean error without a Graph round-trip.
//
// ADDITIVE + NON-SENDING by construction: this shape can only CREATE an event on
// Mark's own calendar. It carries no id (cannot target/modify/delete an existing
// event) and DELIBERATELY has no `attendees` field — an event with attendees
// makes Graph email invitations immediately, which would be an outbound "send"
// with no review step. The personal path never sends mail, so it never invites
// anyone; if Mark wants to invite people he adds them in Outlook after review.
function buildEventPayload(input) {
  input = input || {};
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject) { const e = new Error("calendar_create needs a subject"); e.statusCode = 400; throw e; }

  const isAllDay = !!input.isAllDay;
  const tz = input.timeZone || "America/Chicago"; // Watkins is in the Central zone
  const ev = { subject };

  if (isAllDay) {
    // All-day events must have date-only (midnight) start/end in Graph.
    if (!input.start || !input.end) {
      const e = new Error("all-day calendar_create needs start and end dates"); e.statusCode = 400; throw e;
    }
    const sd = dateOnly(input.start), ed = dateOnly(input.end);
    if (!sd || !ed) { const e = new Error("all-day calendar_create needs valid start/end dates"); e.statusCode = 400; throw e; }
    ev.isAllDay = true;
    ev.start = { dateTime: sd + "T00:00:00", timeZone: tz };
    ev.end = { dateTime: ed + "T00:00:00", timeZone: tz };
  } else {
    if (!input.start || !input.end) {
      const e = new Error("calendar_create needs start and end date-times"); e.statusCode = 400; throw e;
    }
    const s = new Date(input.start), en = new Date(input.end);
    if (isNaN(s.getTime()) || isNaN(en.getTime())) {
      const e = new Error("calendar_create needs valid start/end date-times"); e.statusCode = 400; throw e;
    }
    ev.start = { dateTime: s.toISOString(), timeZone: tz };
    ev.end = { dateTime: en.toISOString(), timeZone: tz };
  }

  if (typeof input.location === "string" && input.location.trim()) {
    ev.location = { displayName: input.location.trim() };
  }
  if (typeof input.body === "string" && input.body.trim()) {
    ev.body = { contentType: "Text", content: input.body.trim() };
  }
  return ev;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async function (event) {
  // AUTH FIRST — before any env read, before any Graph call.
  try {
    await requirePermission(event, "warranty.manage_reports");
  } catch (e) {
    return resp(e.statusCode || 401, { error: e.message });
  }

  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad JSON body" }); }

  const action = body.action;

  // A config probe that never touches Graph — lets the brief detect "not set up
  // yet" without triggering a token error.
  if (action === "status") {
    return resp(200, { configured: isPersonalConfigured(), scope: "Mail + Calendar (personal, isolated)" });
  }

  // Fail closed and EARLY if the personal credential isn't configured, with a
  // clear message — never a silent fallback to the business grant.
  try {
    requirePersonalEnv();
  } catch (e) {
    return resp(e.statusCode || 503, { error: e.message });
  }

  try {
    // ---- diag: prove the personal credential works and name the connected
    // account. GET /me only. If PA_MS_MAILBOX is set, flag a mismatch.
    if (action === "diag") {
      const me = await gj("/me?$select=displayName,mail,userPrincipalName");
      const connected = String(me.userPrincipalName || me.mail || "").toLowerCase();
      const expected = String(process.env.PA_MS_MAILBOX || "").trim().toLowerCase();
      return resp(200, {
        ok: true,
        account: { displayName: me.displayName || null, mail: me.mail || null, userPrincipalName: me.userPrincipalName || null },
        expectedMatch: expected ? connected === expected : null,
        scope: "Mail + Calendar (personal, isolated)",
      });
    }

    // ---- mail_list: READ-ONLY list of recent messages with a short preview.
    // subject + from + date + isRead + bodyPreview. Never marks anything read.
    if (action === "mail_list") {
      const pages = Math.min(5, Math.max(1, parseInt(body.pages || "1", 10)));
      const top = Math.min(50, Math.max(1, parseInt(body.top || "20", 10)));
      let url = body.nextLink;
      if (!url) {
        const folderSeg = body.folderId ? "/mailFolders/" + encodeURIComponent(body.folderId) : "";
        const filter = body.unreadOnly ? "&$filter=" + encodeURIComponent("isRead eq false") : "";
        url = "/me" + folderSeg + "/messages?$top=" + top +
          "&$select=id,subject,from,sender,receivedDateTime,isRead,bodyPreview,webLink" +
          "&$orderby=receivedDateTime desc" + filter;
      }
      const rows = [];
      let next = url;
      for (let i = 0; i < pages && next; i++) {
        const j = await gj(next);
        for (const m of (j.value || [])) rows.push(mapMessage(m));
        next = j["@odata.nextLink"] || null;
      }
      return resp(200, { messages: rows, count: rows.length, nextLink: next });
    }

    // ---- mail_read: READ-ONLY full bodies (as plain text) for the messages the
    // brief wants to quote. Accepts a single messageId or an array (capped).
    // Prefer text so the brief gets clean quotable content, not HTML. GET only.
    if (action === "mail_read") {
      const ids = []
        .concat(body.messageId ? [body.messageId] : [])
        .concat(Array.isArray(body.messageIds) ? body.messageIds : [])
        .map(String).filter(Boolean).slice(0, 15);
      if (!ids.length) return resp(400, { error: "mail_read needs messageId or messageIds[]" });
      const out = [];
      for (const id of ids) {
        try {
          const m = await gj("/me/messages/" + encodeURIComponent(id) +
            "?$select=id,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,body,webLink",
            { headers: { Prefer: 'outlook.body-content-type="text"' } });
          out.push(mapMessage(m, { withBody: true, withRecipients: true }));
        } catch (e) {
          out.push({ id, error: String(e.message || e).slice(0, 160) });
        }
      }
      return resp(200, { messages: out });
    }

    // ---- calendar_list: READ-ONLY events in a window (today | week | explicit
    // start/end). Uses /me/calendarView so recurring instances are expanded.
    if (action === "calendar_list") {
      const { startDateTime, endDateTime } = resolveCalendarRange(body, new Date());
      const top = Math.min(100, Math.max(1, parseInt(body.top || "50", 10)));
      const url = "/me/calendarView?startDateTime=" + encodeURIComponent(startDateTime) +
        "&endDateTime=" + encodeURIComponent(endDateTime) +
        "&$select=id,subject,start,end,isAllDay,location,organizer,attendees,bodyPreview,webLink" +
        "&$orderby=start/dateTime&$top=" + top;
      // Prefer the user's Central time zone so start/end render in local time.
      const j = await gj(url, { headers: { Prefer: 'outlook.timezone="America/Chicago"' } });
      const events = (j.value || []).map(mapEvent);
      return resp(200, { events, count: events.length, window: { startDateTime, endDateTime } });
    }

    // ---- calendar_create: THE ONLY CALENDAR WRITE, and it is ADDITIVE. POST
    // /me/events puts a new event on Mark's OWN calendar. It cannot modify or
    // delete any existing event — no such action exists in this file — and the
    // payload carries no attendees, so it never emails an invitation to anyone
    // (see buildEventPayload). Creating an event sends no mail and notifies no one.
    if (action === "calendar_create") {
      let payload;
      try { payload = buildEventPayload(body); }
      catch (e) { return resp(e.statusCode || 400, { error: e.message }); }
      const created = await gj("/me/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return resp(200, {
        created: true,
        id: created && created.id,
        subject: created && created.subject,
        start: created && created.start,
        end: created && created.end,
        webLink: (created && created.webLink) || null,
      });
    }

    // ---- create_draft: THE ONLY MAIL-COMPOSE ACTION. Creates a DRAFT and sends
    // nothing (mirrors contacts-sync's discipline). Reply draft via createReply,
    // or a fresh draft via POST /me/messages — Graph files both in Drafts. Mark
    // reviews and sends every draft himself.
    if (action === "create_draft") {
      const hasHtml = typeof body.bodyHtml === "string" && body.bodyHtml.trim() !== "";
      const replyToMessageId = body.replyToMessageId ? String(body.replyToMessageId) : null;

      if (replyToMessageId) {
        const draft = await gj("/me/messages/" + encodeURIComponent(replyToMessageId) + "/createReply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const draftId = draft && draft.id;
        if (!draftId) return resp(502, { error: "createReply did not return a draft id" });

        const orig = (draft.body && draft.body.content) || "";
        const isText = String((draft.body && draft.body.contentType) || "html").toLowerCase() === "text";
        let contentType, content;
        if (isText) {
          const mine = hasHtml ? String(body.bodyHtml) : textWithSignoff(body.bodyText);
          contentType = "Text";
          content = orig ? mine + "\n\n" + orig : mine;
        } else {
          const mine = hasHtml
            ? String(body.bodyHtml)
            : escapeHtml(textWithSignoff(body.bodyText)).replace(/\n/g, "<br>");
          contentType = "HTML";
          content = orig ? mine + "<br><br>" + orig : mine;
        }
        await gj("/me/messages/" + encodeURIComponent(draftId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: { contentType, content } }),
        });
        return resp(200, { created: true, kind: "reply", id: draftId, webLink: draft.webLink || null, replyToMessageId });
      }

      const toRecipients = normalizeRecipients(body.toRecipients);
      if (!toRecipients.length) {
        return resp(400, {
          error: "create_draft needs either replyToMessageId (to draft a reply) " +
            "or toRecipients (a non-empty array of email addresses, for a fresh draft)",
        });
      }
      const message = {
        subject: typeof body.subject === "string" ? body.subject : "",
        toRecipients,
        body: hasHtml
          ? { contentType: "HTML", content: String(body.bodyHtml) }
          : { contentType: "Text", content: textWithSignoff(body.bodyText) },
      };
      const cc = normalizeRecipients(body.ccRecipients);
      if (cc.length) message.ccRecipients = cc;

      const created = await gj("/me/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      return resp(200, { created: true, kind: "fresh", id: created && created.id, webLink: (created && created.webLink) || null });
    }

    return resp(400, { error: "Unknown action: " + String(action) });
  } catch (e) {
    return resp(e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500, {
      error: String((e && e.message) || "unknown error").slice(0, 400),
    });
  }
};

// Exported for unit testing the pure logic without a mailbox or a token.
module.exports._internals = {
  textWithSignoff, escapeHtml, normalizeRecipients,
  mapMessage, mapEvent, resolveCalendarRange, buildEventPayload,
};
