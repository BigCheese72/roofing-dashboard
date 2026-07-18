// Unit tests for the morning-brief actions folded into contacts-sync.js:
// mail_read body mapping, calendar range resolution, event-payload building,
// and the calendar-not-granted no-op shape. All pure — no Graph, no mailbox.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const H = require(path.join(__dirname, "..", "netlify", "functions", "contacts-sync.js"))._internals;

// ---------------------------------------------------------------------
// mail_read body mapping
// ---------------------------------------------------------------------
test("mapMailMessage (preview mode) returns metadata + preview, NEVER a body", () => {
  const row = H.mapMailMessage({
    id: "AAA",
    subject: "Roof estimate",
    from: { emailAddress: { name: "Sam Vendor", address: "Sam@Vendor.COM" } },
    receivedDateTime: "2026-07-17T12:00:00Z",
    isRead: false,
    bodyPreview: "  Here is the quote  ",
    body: { content: "FULL BODY MUST NOT LEAK IN PREVIEW MODE" },
    webLink: "https://outlook/AAA",
  });
  assert.strictEqual(row.subject, "Roof estimate");
  assert.deepStrictEqual(row.from, { name: "Sam Vendor", address: "sam@vendor.com" });
  assert.strictEqual(row.date, "2026-07-17T12:00:00Z");
  assert.strictEqual(row.read, false);
  assert.strictEqual(row.preview, "Here is the quote");
  assert.strictEqual(row.body, undefined, "preview mode must not include the body");
  assert.strictEqual(row.to, undefined);
});

test("mapMailMessage (withBody) includes plain-text body + recipients", () => {
  const row = H.mapMailMessage({
    id: "BBB",
    subject: "Re: schedule",
    from: { emailAddress: { name: "Pat", address: "pat@x.com" } },
    toRecipients: [{ emailAddress: { address: "marks@watkinsroofing.net" } }],
    ccRecipients: [{ emailAddress: { address: "steve@watkinsroofing.net" } }],
    receivedDateTime: "2026-07-17T09:00:00Z",
    body: { contentType: "text", content: "  Can we push to 10am?  " },
  }, { withBody: true });
  assert.strictEqual(row.body, "Can we push to 10am?");
  assert.deepStrictEqual(row.to, ["marks@watkinsroofing.net"]);
  assert.deepStrictEqual(row.cc, ["steve@watkinsroofing.net"]);
});

test("mapMailMessage tolerates a missing sender/preview", () => {
  const row = H.mapMailMessage({ id: "C", receivedDateTime: null });
  assert.strictEqual(row.subject, "(no subject)");
  assert.deepStrictEqual(row.from, { name: null, address: null });
  assert.strictEqual(row.preview, null);
});

// ---------------------------------------------------------------------
// calendar_list range resolution
// ---------------------------------------------------------------------
test("resolveCalendarRange 'today' spans local midnight to local midnight+1", () => {
  const now = new Date(2026, 6, 17, 14, 30, 0);
  const { startDateTime, endDateTime } = H.resolveCalendarRange({ range: "today" }, now);
  assert.strictEqual(new Date(startDateTime).getTime(), new Date(2026, 6, 17, 0, 0, 0, 0).getTime());
  assert.strictEqual(new Date(endDateTime).getTime(), new Date(2026, 6, 18, 0, 0, 0, 0).getTime());
});

test("resolveCalendarRange defaults to 'today' when no range given", () => {
  const now = new Date(2026, 6, 17, 14, 30, 0);
  assert.deepStrictEqual(H.resolveCalendarRange({}, now), H.resolveCalendarRange({ range: "today" }, now));
});

test("resolveCalendarRange 'week' spans now to now+7 days", () => {
  const now = new Date(Date.UTC(2026, 6, 17, 14, 30, 0));
  const { startDateTime, endDateTime } = H.resolveCalendarRange({ range: "week" }, now);
  assert.strictEqual(startDateTime, now.toISOString());
  assert.strictEqual(new Date(endDateTime).getTime() - now.getTime(), 7 * 24 * 3600 * 1000);
});

test("resolveCalendarRange honors explicit start/end over the named range", () => {
  const r = H.resolveCalendarRange({ range: "week", start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" }, new Date(2026, 6, 17));
  assert.strictEqual(r.startDateTime, "2026-08-01T00:00:00.000Z");
  assert.strictEqual(r.endDateTime, "2026-08-02T00:00:00.000Z");
});

test("resolveCalendarRange rejects unparseable explicit dates with 400 (not a 500)", () => {
  assert.throws(() => H.resolveCalendarRange({ start: "not-a-date", end: "also-bad" }, new Date(2026, 6, 17)),
    (e) => { assert.strictEqual(e.statusCode, 400); return true; });
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
    location: { displayName: "Flat Branch" },
    organizer: { emailAddress: { name: "Mark", address: "Marks@watkinsroofing.net" } },
    attendees: [{ emailAddress: { name: "Sam", address: "SAM@x.com" }, status: { response: "accepted" } }],
    bodyPreview: "bring the drone",
  });
  assert.strictEqual(row.subject, "Site walk — Flat Branch");
  assert.strictEqual(row.start, "2026-07-17T15:00:00.0000000");
  assert.strictEqual(row.location, "Flat Branch");
  assert.strictEqual(row.organizer.address, "marks@watkinsroofing.net");
  assert.deepStrictEqual(row.attendees, [{ name: "Sam", address: "sam@x.com", response: "accepted" }]);
});

// ---------------------------------------------------------------------
// calendar_create payload building (additive; non-sending; validating)
// ---------------------------------------------------------------------
test("buildEventPayload builds a timed event with the Central tz default", () => {
  const ev = H.buildEventPayload({ subject: "Call with GC", start: "2026-07-18T14:00:00Z", end: "2026-07-18T14:30:00Z" });
  assert.strictEqual(ev.subject, "Call with GC");
  assert.strictEqual(ev.start.dateTime, "2026-07-18T14:00:00.000Z");
  assert.strictEqual(ev.end.dateTime, "2026-07-18T14:30:00.000Z");
  assert.strictEqual(ev.start.timeZone, "America/Chicago");
});

test("buildEventPayload includes location and body when given", () => {
  const ev = H.buildEventPayload({
    subject: "Roof inspection", start: "2026-07-18T14:00:00Z", end: "2026-07-18T15:00:00Z",
    timeZone: "America/New_York", location: "1600 Elm St", body: "Bring ladder",
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
    "creating an event must not email an invitation to anyone");
});

test("buildEventPayload builds a date-only all-day event without a UTC day-shift", () => {
  const ev = H.buildEventPayload({ subject: "PTO", isAllDay: true, start: "2026-07-20", end: "2026-07-21" });
  assert.strictEqual(ev.isAllDay, true);
  assert.strictEqual(ev.start.dateTime, "2026-07-20T00:00:00");
  assert.strictEqual(ev.end.dateTime, "2026-07-21T00:00:00");
});

test("buildEventPayload rejects a missing subject / missing start-end (400)", () => {
  assert.throws(() => H.buildEventPayload({ start: "2026-07-18T14:00:00Z", end: "2026-07-18T15:00:00Z" }),
    (e) => { assert.strictEqual(e.statusCode, 400); assert.match(e.message, /subject/); return true; });
  assert.throws(() => H.buildEventPayload({ subject: "x", start: "2026-07-18T14:00:00Z" }),
    (e) => { assert.strictEqual(e.statusCode, 400); return true; });
});

test("buildEventPayload rejects end <= start (timed and all-day) with 400", () => {
  assert.throws(() => H.buildEventPayload({ subject: "x", start: "2026-07-18T15:00:00Z", end: "2026-07-18T15:00:00Z" }),
    (e) => { assert.strictEqual(e.statusCode, 400); assert.match(e.message, /after start/); return true; });
  assert.throws(() => H.buildEventPayload({ subject: "PTO", isAllDay: true, start: "2026-07-20", end: "2026-07-20" }),
    (e) => { assert.strictEqual(e.statusCode, 400); return true; });
});

// ---------------------------------------------------------------------
// The gated no-op response shape
// ---------------------------------------------------------------------
test("CALENDAR_NOT_GRANTED clearly signals the scope gap and the one remaining step", () => {
  assert.strictEqual(H.CALENDAR_NOT_GRANTED.calendarScopeGranted, false);
  assert.match(H.CALENDAR_NOT_GRANTED.error, /Calendars\.ReadWrite/);
  assert.match(H.CALENDAR_NOT_GRANTED.error, /ms-auth-start/);
});
