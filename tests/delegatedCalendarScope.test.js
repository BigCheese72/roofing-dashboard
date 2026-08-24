// Tests for the calendar-scope plumbing added to graphDelegatedAuth.js for the
// morning-brief assistant:
//   * DELEGATED_SCOPES now requests Calendars.ReadWrite (so a re-sign-in picks
//     it up once Steve grants admin consent).
//   * scopeStringHasCalendar() is the pure gating decision — does the GRANTED
//     scope string carry the calendar scope? (hasCalendarScope() just wraps it
//     around the stored token doc.)
//   * refreshAccessToken() must NOT send `scope` — pinning a list that includes
//     a not-yet-consented scope would fail the refresh (breaking the working
//     mail/contacts integration) and pinning the old list would silently drop
//     the calendar scope after it IS granted.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "netlify", "functions", "lib", "graphDelegatedAuth.js");

function load(mailbox) {
  delete require.cache[require.resolve(MODULE)];
  process.env.GRAPH_MAILBOX = mailbox || "marks@watkinsroofing.net";
  return require(MODULE);
}

test("DELEGATED_SCOPES requests Calendars.ReadWrite (for the re-consent re-sign-in)", () => {
  const m = load();
  assert.ok(m.DELEGATED_SCOPES.split(/\s+/).includes("Calendars.ReadWrite"));
});

test("DELEGATED_SCOPES still requests the pre-existing consented set", () => {
  const m = load();
  const scopes = m.DELEGATED_SCOPES.split(/\s+/);
  ["offline_access", "Mail.ReadWrite", "MailboxSettings.ReadWrite", "Contacts.ReadWrite",
    "Files.ReadWrite", "User.Read"].forEach(s => assert.ok(scopes.includes(s), "missing: " + s));
});

test("scopeStringHasCalendar detects the calendar scope, case-insensitively", () => {
  const m = load();
  assert.strictEqual(m.scopeStringHasCalendar("Mail.ReadWrite Calendars.ReadWrite User.Read"), true);
  assert.strictEqual(m.scopeStringHasCalendar("mail.readwrite calendars.readwrite"), true);
});

test("scopeStringHasCalendar is false for the CURRENT (pre-grant) scope set", () => {
  const m = load();
  // Exactly what the RoofOps app is consented for today — no Calendars.
  assert.strictEqual(
    m.scopeStringHasCalendar("Mail.ReadWrite MailboxSettings.ReadWrite Contacts.ReadWrite Files.ReadWrite User.Read"),
    false);
});

test("scopeStringHasCalendar fails closed on empty/nullish and never substring-matches", () => {
  const m = load();
  assert.strictEqual(m.scopeStringHasCalendar(""), false);
  assert.strictEqual(m.scopeStringHasCalendar(null), false);
  assert.strictEqual(m.scopeStringHasCalendar(undefined), false);
  // A scope that merely CONTAINS the substring but isn't the whole token must not match.
  assert.strictEqual(m.scopeStringHasCalendar("Calendars.ReadWrite.Shared"), false);
});

test("refreshAccessToken omits `scope` so it can never request an un-consented scope", async () => {
  process.env.GRAPH_TENANT_ID = "t";
  process.env.GRAPH_CLIENT_ID = "c";
  process.env.GRAPH_CLIENT_SECRET = "s";
  const m = load();

  const realFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (url, opts) => {
    capturedBody = String(opts && opts.body);
    return { ok: true, text: async () => JSON.stringify({ access_token: "x", expires_in: 3600, scope: "Mail.ReadWrite" }) };
  };
  try {
    await m.refreshAccessToken("some-refresh-token");
  } finally {
    globalThis.fetch = realFetch;
  }
  const params = new URLSearchParams(capturedBody);
  assert.strictEqual(params.get("grant_type"), "refresh_token");
  assert.strictEqual(params.get("refresh_token"), "some-refresh-token");
  assert.strictEqual(params.get("scope"), null, "refresh must NOT pin a scope list");
});
