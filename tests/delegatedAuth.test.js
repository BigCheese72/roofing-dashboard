// Security regression tests for Microsoft Graph DELEGATED auth.
//
// THESE EXIST BECAUSE ms-auth-callback USED TO LET ANYONE HIJACK THE APP'S
// DELEGATED IDENTITY. It called /me as a "best-effort" nicety and then stored
// the returned refresh token in secrets/ms_graph_delegated regardless of who
// had signed in -- or even when the /me lookup had failed and the identity was
// completely unknown. Any Microsoft account that reached the public callback
// URL would overwrite Mark's stored token, and every delegated Graph call
// afterwards -- his mail, his OneDrive, his inbox rules -- would run as that
// account.
//
// The gate is enforced at the STORAGE layer (saveDelegatedToken), so it fails
// closed even if a future caller forgets to check first. These tests assert
// that a wrong or unknown account can never be persisted.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "netlify", "functions", "lib", "graphDelegatedAuth.js");

// Load the module fresh with a chosen GRAPH_MAILBOX. No Firestore is ever
// touched: every assertion below is on the refusal path, which throws before
// getDb() is reached.
function load(mailbox) {
  delete require.cache[require.resolve(MODULE)];
  if (mailbox === undefined) delete process.env.GRAPH_MAILBOX;
  else process.env.GRAPH_MAILBOX = mailbox;
  return require(MODULE);
}

const OWNER = "marks@watkinsroofing.net";

test("the account that IS GRAPH_MAILBOX is recognized", () => {
  const m = load(OWNER);
  assert.strictEqual(m.isExpectedAccount(OWNER), true);
});

test("matching is case- and whitespace-insensitive (UPNs are not case sensitive)", () => {
  const m = load(OWNER);
  assert.strictEqual(m.isExpectedAccount("MarkS@WatkinsRoofing.NET"), true);
  assert.strictEqual(m.isExpectedAccount("  marks@watkinsroofing.net  "), true);
});

test("HIJACK: an attacker's Microsoft account is NOT the expected account", () => {
  const m = load(OWNER);
  assert.strictEqual(m.isExpectedAccount("attacker@evil.example"), false);
  assert.strictEqual(m.isExpectedAccount("someone.else@watkinsroofing.net"), false);
});

test("HIJACK: a lookalike account does not slip through", () => {
  const m = load(OWNER);
  assert.strictEqual(m.isExpectedAccount("marks@watkinsroofing.net.evil.example"), false);
  assert.strictEqual(m.isExpectedAccount("evil-marks@watkinsroofing.net"), false);
  assert.strictEqual(m.isExpectedAccount("marks@watkinsroofing.co"), false);
});

test("an unknown identity (null/empty UPN) is never accepted", () => {
  const m = load(OWNER);
  assert.strictEqual(m.isExpectedAccount(null), false);
  assert.strictEqual(m.isExpectedAccount(undefined), false);
  assert.strictEqual(m.isExpectedAccount(""), false);
});

test("STORAGE LAYER FAILS CLOSED: saveDelegatedToken refuses a wrong account", async () => {
  const m = load(OWNER);
  await assert.rejects(
    () => m.saveDelegatedToken({
      refreshToken: "not-a-real-token",
      accountUpn: "attacker@evil.example",
      accountName: "Attacker",
      scope: "offline_access Mail.ReadWrite",
    }),
    (err) => {
      assert.strictEqual(err.code, "DELEGATED_ACCOUNT_MISMATCH");
      assert.strictEqual(err.statusCode, 403);
      return true;
    },
    "an attacker's token must NEVER reach Firestore"
  );
});

test("STORAGE LAYER FAILS CLOSED: saveDelegatedToken refuses an unconfirmed identity", async () => {
  const m = load(OWNER);
  await assert.rejects(
    () => m.saveDelegatedToken({ refreshToken: "not-a-real-token", accountUpn: null }),
    (err) => err.code === "DELEGATED_ACCOUNT_MISMATCH",
    "a token with no confirmed identity must NEVER be stored"
  );
});

test("with GRAPH_MAILBOX unset, nothing can be stored at all (fail closed, not open)", async () => {
  const m = load(undefined);
  assert.throws(() => m.expectedAccountUpn(), /GRAPH_MAILBOX is not set/);
  await assert.rejects(
    () => m.saveDelegatedToken({ refreshToken: "x", accountUpn: OWNER }),
    "with no GRAPH_MAILBOX configured, even the real owner must not be stored"
  );
});

// =====================================================================
// Scopes: the module exists so Outlook inbox rules work. messageRules
// REQUIRES MailboxSettings.ReadWrite, which the scope string omitted.
// =====================================================================
test("DELEGATED_SCOPES requests MailboxSettings.ReadWrite (required for messageRules)", () => {
  const m = load(OWNER);
  const scopes = m.DELEGATED_SCOPES.split(/\s+/);
  assert.ok(scopes.includes("MailboxSettings.ReadWrite"),
    "inbox rules are the stated reason this module exists; without this scope they 403");
});

test("DELEGATED_SCOPES requests the full consented delegated set", () => {
  const m = load(OWNER);
  const scopes = m.DELEGATED_SCOPES.split(/\s+/);
  ["offline_access", "Mail.ReadWrite", "MailboxSettings.ReadWrite",
    "Contacts.ReadWrite", "Files.ReadWrite", "User.Read"].forEach(s => {
      assert.ok(scopes.includes(s), "missing delegated scope: " + s);
    });
});

// =====================================================================
// The host allowlist must keep failing closed.
// =====================================================================
test("redirect URI resolution fails closed on an unknown host", () => {
  const m = load(OWNER);
  assert.strictEqual(m.resolveRedirectUri("evil.example"), null);
  assert.strictEqual(m.resolveRedirectUri(""), null);
  assert.strictEqual(m.resolveRedirectUri(null), null);
  assert.ok(m.resolveRedirectUri("dev--leak-work-orders.netlify.app"));
  assert.ok(m.resolveRedirectUri("leak-work-orders.netlify.app"));
});
