// Unit tests for the personal assistant-mail function: the pure per-action
// logic (mail row mapping, calendar range resolution, event-payload building,
// draft composition) plus the auth-first guarantee on the handler.
//
// Graph itself is never called — the pure helpers are exported on _internals,
// and the one handler test exercises the no-token path, which throws 401 in
// requirePermission BEFORE any env read or Graph/Firebase call.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "netlify", "functions", "assistant-mail.js");
const mod = require(MODULE);
const H = mod._internals;

// ---------------------------------------------------------------------
// create_draft discipline (mirrored from contacts-sync)
// ---------------------------------------------------------------------
test("textWithSignoff appends Mark's sign-off to a bare body", () => {
  const out = H.textWithSignoff("Sounds good, see you at 9.");
  assert.match(out, /Sounds good, see you at 9\./);
  assert.match(out, /Respectfully,\nMark$/);
});

test("textWithSignoff is idempotent — never doubles an existing sign-off", () => {
  const already = "Here's the plan.\n\nRespectfully,\nMark";
  assert.strictEqual(H.textWithSignoff(already), already);
});

test("textWithSignoff handles empty/nullish input without a leading blank line", () => {
  assert.strictEqual(H.textWithSignoff(""), "Respectfully,\nMark");
  assert.strictEqual(H.textWithSignoff(null), "Respectfully,\nMark");
});

test("escapeHtml neutralizes markup so a drafted body can't inject HTML", () => {
  assert.strictEqual(H.escapeHtml('a <b> & <script>'), "a &lt;b&gt; &amp; &lt;script&gt;");
});

test("normalizeRecipients accepts strings and objects, drops non-addresses", () => {
  const out = H.normalizeRecipients([
    "a@b.com",
    { address: "c@d.com", name: "Carol" },
    { email: "e@f.com" },
    "not-an-email",
    "",
    null,
    42,
  ]);
  assert.deepStrictEqual(out, [
    { emailAddress: { address: "a@b.com" } },
    { emailAddress: { address: "c@d.com", name: "Carol" } },
    { emailAddress: { address: "e@f.com" } },
  ]);
});

test("normalizeRecipients returns [] for non-array input", () => {
  assert.deepStrictEqual(H.normalizeRecipients(undefined), []);
  assert.deepStrictEqual(H.normalizeRecipients("a@b.com"), []);
});

// ---------------------------------------------------------------------
// mail_list / mail_read row mapping
// ---------------------------------------------------------------------
test("mapMessage (list mode) returns metadata + preview, and NEVER a body", () => {
  const row = H.mapMessage({
    id: "AAA",
    subject: "Roof estimate",
    from: { emailAddress: { name: "Sam Vendor", address: "Sam@Vendor.COM" } },
    receivedDateTime: "2026-07-17T12:00:00Z",
    isRead: false,
    bodyPreview: "  Here is the quote you asked for  ",
    body: { content: "FULL BODY SHOULD NOT LEAK IN LIST MODE" },
    webLink: "https://outlook/AAA",
  });
  assert.strictEqual(row.id, "AAA");
  assert.strictEqual(row.subject, "Roof estimate");
  assert.deepStrictEqual(row.from, { name: "Sam Vendor", address: "sam@vendor.com" });
  assert.strictEqual(row.date, "2026-07-17T12:00:00Z");
  assert.strictEqual(row.isRead, false);
  assert.strictEqual(row.preview, "Here is the quote you asked for");
  assert.strictEqual(row.body, undefined, "list mode must not include the body");
});

test("mapMessage (read mode) includes plain-text body and recipients", () => {
  const row = H.mapMessage({
    id: "BBB",
    subject: "Re: schedule",
    from: { emailAddress: { name: "Pat", address: "pat@x.com" } },
    toRecipients: [{ emailAddress: { address: "marks@watkinsroofing.net" } }],
    ccRecipients: [{ emailAddress: { address: "steve@watkinsroofing.net" } }],
    receivedDateTime: "2026-07-17T09:00:00Z",
    body: { contentType: "text", content: "  Can we push to 10am?  " },
  }, { withBody: true, withRecipients: true });
  assert.strictEqual(row.body, "Can we push to 10am?");
  assert.deepStrictEqual(row.to, ["marks@watkinsroofing.net"]);
  assert.deepStrictEqual(row.cc, ["steve@watkinsroofing.net"]);
});

test("mapMessage tolerates a missing sender/preview", () => {
  const row = H.mapMessage({ id: "C", receivedDateTime: null });
  assert.strictEqual(row.subject, "(no subject)");
  assert.deepStrictEqual(row.from, { name: null, address: null });
  assert.strictEqual(row.preview, null);
});

// ---------------------------------------------------------------------
// calendar_list range resolution
// ---------------------------------------------------------------------
test("resolveCalendarRange 'today' spans local midnight to local midnight+1", () => {
  const now = new Date(2026, 6, 17, 14, 30, 0); // 2026-07-17 14:30 local
  const { startDateTime, endDateTime } = H.resolveCalendarRange({ range: "today" }, now);
  assert.strictEqual(new Date(startDateTime).getTime(), new Date(2026, 6, 17, 0, 0, 0, 0).getTime());
  assert.strictEqual(new Date(endDateTime).getTime(), new Date(2026, 6, 18, 0, 0, 0, 0).getTime());
});

test("resolveCalendarRange defaults to 'today' when no range is given", () => {
  const now = new Date(2026, 6, 17, 14, 30, 0);
  const a = H.resolveCalendarRange({}, now);
  const b = H.resolveCalendarRange({ range: "today" }, now);
  assert.deepStrictEqual(a, b);
});

test("resolveCalendarRange 'week' spans now to now+7 days", () => {
  const now = new Date(Date.UTC(2026, 6, 17, 14, 30, 0));
  const { startDateTime, endDateTime } = H.resolveCalendarRange({ range: "week" }, now);
  assert.strictEqual(startDateTime, now.toISOString());
  assert.strictEqual(new Date(endDateTime).getTime() - now.getTime(), 7 * 24 * 3600 * 1000);
});

test("resolveCalendarRange honors an explicit start/end over the named range", () => {
  const now = new Date(2026, 6, 17);
  const r = H.resolveCalendarRange({ range: "week", start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" }, now);
  assert.strictEqual(r.startDateTime, "2026-08-01T00:00:00.000Z");
  assert.strictEqual(r.endDateTime, "2026-08-02T00:00:00.000Z");
});

// ---------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------
test("mapEvent flattens a Graph event into the brief's row shape", () => {
  const row = H.mapEvent({
    id: "E1",
    subject: "Site walk — Flat Branch",
    start: { dateTime: "2026-07-17T15:00:00.0000000", timeZone: "America/Chicago" },
    end: { dateTime: "2026-07-17T16:00:00.0000000", timeZone: "America/Chicago" },
    isAllDay: false,
    location: { displayName: "Flat Branch" },
    organizer: { emailAddress: { name: "Mark", address: "Marks@watkinsroofing.net" } },
    attendees: [{ emailAddress: { name: "Sam", address: "SAM@x.com" }, status: { response: "accepted" } }],
    bodyPreview: "bring the drone",
    webLink: "https://outlook/E1",
  });
  assert.strictEqual(row.subject, "Site walk — Flat Branch");
  assert.strictEqual(row.start, "2026-07-17T15:00:00.0000000");
  assert.strictEqual(row.location, "Flat Branch");
  assert.strictEqual(row.organizer.address, "marks@watkinsroofing.net");
  assert.deepStrictEqual(row.attendees, [{ name: "Sam", address: "sam@x.com", response: "accepted" }]);
});

// ---------------------------------------------------------------------
// calendar_create payload building (additive; validating)
// ---------------------------------------------------------------------
test("buildEventPayload builds a timed event with Central tz default", () => {
  const ev = H.buildEventPayload({
    subject: "Call with GC",
    start: "2026-07-18T14:00:00Z",
    end: "2026-07-18T14:30:00Z",
  });
  assert.strictEqual(ev.subject, "Call with GC");
  assert.strictEqual(ev.start.dateTime, "2026-07-18T14:00:00.000Z");
  assert.strictEqual(ev.end.dateTime, "2026-07-18T14:30:00.000Z");
  assert.strictEqual(ev.start.timeZone, "America/Chicago");
  assert.strictEqual(ev.attendees, undefined, "no attendees unless explicitly asked");
});

test("buildEventPayload includes location and body when given", () => {
  const ev = H.buildEventPayload({
    subject: "Roof inspection",
    start: "2026-07-18T14:00:00Z",
    end: "2026-07-18T15:00:00Z",
    timeZone: "America/New_York",
    location: "1600 Elm St",
    body: "Bring ladder",
  });
  assert.strictEqual(ev.location.displayName, "1600 Elm St");
  assert.strictEqual(ev.body.content, "Bring ladder");
  assert.strictEqual(ev.start.timeZone, "America/New_York");
});

test("buildEventPayload NEVER emits an attendees field (no invite = no outbound send)", () => {
  const ev = H.buildEventPayload({
    subject: "x", start: "2026-07-18T14:00:00Z", end: "2026-07-18T15:00:00Z",
    attendees: ["sam@x.com", { address: "pat@y.com", name: "Pat" }], // must be ignored
  });
  assert.strictEqual(ev.attendees, undefined,
    "the personal path must not create events that email invitations to anyone");
});

test("buildEventPayload builds a date-only all-day event without a UTC day-shift", () => {
  const ev = H.buildEventPayload({ subject: "PTO", isAllDay: true, start: "2026-07-20", end: "2026-07-21" });
  assert.strictEqual(ev.isAllDay, true);
  assert.strictEqual(ev.start.dateTime, "2026-07-20T00:00:00");
  assert.strictEqual(ev.end.dateTime, "2026-07-21T00:00:00");
});

test("buildEventPayload rejects a missing subject (400)", () => {
  assert.throws(() => H.buildEventPayload({ start: "2026-07-18T14:00:00Z", end: "2026-07-18T15:00:00Z" }),
    (e) => { assert.strictEqual(e.statusCode, 400); assert.match(e.message, /subject/); return true; });
});

test("buildEventPayload rejects a missing start/end (400)", () => {
  assert.throws(() => H.buildEventPayload({ subject: "x", start: "2026-07-18T14:00:00Z" }),
    (e) => { assert.strictEqual(e.statusCode, 400); return true; });
});

// ---------------------------------------------------------------------
// Handler: AUTH FIRST. No bearer token -> 401 before any Graph/env access.
// ---------------------------------------------------------------------
test("handler rejects an unauthenticated request with 401 before touching Graph", async () => {
  const res = await mod.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "mail_list" }) });
  assert.strictEqual(res.statusCode, 401);
  const j = JSON.parse(res.body);
  assert.match(j.error, /bearer token/i);
});

test("handler rejects an unauthenticated diag the same way (no config leak)", async () => {
  const res = await mod.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "diag" }) });
  assert.strictEqual(res.statusCode, 401,
    "auth runs before the config check, so an anon caller can't probe whether creds are set");
});
