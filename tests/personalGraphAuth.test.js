// Isolation + scope tests for the PERSONAL assistant Microsoft Graph auth.
//
// THE POINT OF THIS MODULE IS SEPARATION. Mark's personal morning brief must
// run on its OWN Azure app registration (PA_MS_* env vars), scoped to Mail +
// Calendar only, and must NEVER fall back to the RoofOps business grant
// (GRAPH_* env vars + secrets/ms_graph_delegated). These tests assert exactly
// that: with the personal creds absent, the module fails closed with a clear
// "not configured" error even when the business creds ARE present — there is no
// code path from here to the broad token.
//
// No Firestore and no network are ever touched: every assertion is on the
// config/refusal path, which throws before getDb() or any fetch is reached.
//
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "netlify", "functions", "lib", "personalGraphAuth.js");

// The full set of env vars this module could conceivably read. We clear ALL of
// them (personal AND business) before each scenario, then set only what the
// scenario intends, so a leaked read of a business var would show up as a test
// failure rather than passing silently.
const PA_VARS = ["PA_MS_TENANT_ID", "PA_MS_CLIENT_ID", "PA_MS_CLIENT_SECRET", "PA_MS_REFRESH_TOKEN", "PA_MS_MAILBOX"];
const BIZ_VARS = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_MAILBOX"];

function clearAll() {
  for (const k of PA_VARS.concat(BIZ_VARS)) delete process.env[k];
}

function load(env) {
  clearAll();
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

const FULL_PA = {
  PA_MS_TENANT_ID: "pa-tenant",
  PA_MS_CLIENT_ID: "pa-client",
  PA_MS_CLIENT_SECRET: "pa-secret",
  PA_MS_REFRESH_TOKEN: "pa-seed-refresh-token",
};

const FULL_BIZ = {
  GRAPH_TENANT_ID: "biz-tenant",
  GRAPH_CLIENT_ID: "biz-client",
  GRAPH_CLIENT_SECRET: "biz-secret",
  GRAPH_MAILBOX: "marks@watkinsroofing.net",
};

// =====================================================================
// SCOPE: Mail + Calendar ONLY. The personal app must not be consented for —
// and this string must not request — Contacts, Files, or MailboxSettings.
// =====================================================================
test("PERSONAL_SCOPES is Mail + Calendar only", () => {
  const m = load(FULL_PA);
  const scopes = m.PERSONAL_SCOPES.split(/\s+/);
  ["offline_access", "Mail.ReadWrite", "Calendars.ReadWrite", "User.Read"].forEach(s =>
    assert.ok(scopes.includes(s), "missing expected personal scope: " + s));
});

test("PERSONAL_SCOPES does NOT request business-grant scopes", () => {
  const m = load(FULL_PA);
  const scopes = m.PERSONAL_SCOPES.split(/\s+/);
  ["Contacts.ReadWrite", "Files.ReadWrite", "MailboxSettings.ReadWrite", "Files.Read"].forEach(s =>
    assert.ok(!scopes.includes(s), "personal scope must NOT include " + s + " (that's the broad business grant)"));
});

// =====================================================================
// ISOLATION: no fallback to the business grant. This is the headline test.
// =====================================================================
test("ISOLATION: with PA_MS_* unset it fails closed — even when business GRAPH_* are set", () => {
  const m = load(FULL_BIZ); // business creds present, personal creds ABSENT
  assert.strictEqual(m.isPersonalConfigured(), false,
    "the presence of business creds must not make the personal path look configured");
  assert.throws(() => m.requirePersonalEnv(), /personal assistant credential not configured/,
    "must refuse rather than borrow the business grant");
});

test("ISOLATION: getPersonalAccessToken throws PA_NOT_CONFIGURED (503), never reaching Firestore/network", async () => {
  const m = load(FULL_BIZ);
  await assert.rejects(
    () => m.getPersonalAccessToken(),
    (err) => {
      assert.strictEqual(err.code, "PA_NOT_CONFIGURED");
      assert.strictEqual(err.statusCode, 503);
      assert.match(err.message, /never falls back to the RoofOps business/i);
      return true;
    },
    "an unconfigured personal path must fail closed, not fall back"
  );
});

test("ISOLATION: the not-configured error names the exact missing PA_MS_* vars", () => {
  // Only the seed refresh token is missing.
  const partial = Object.assign({}, FULL_PA);
  delete partial.PA_MS_REFRESH_TOKEN;
  const m = load(partial);
  assert.throws(() => m.requirePersonalEnv(), (err) => {
    assert.strictEqual(err.code, "PA_NOT_CONFIGURED");
    // The "Missing: ..." clause lists only the vars that are actually absent
    // (the generic guidance sentence names them all, so assert on this clause).
    const missing = /Missing: ([^.]*)\./.exec(err.message);
    assert.ok(missing, "error should carry a 'Missing: ...' clause");
    assert.match(missing[1], /PA_MS_REFRESH_TOKEN/);
    assert.ok(!/PA_MS_CLIENT_ID/.test(missing[1]), "should not list vars that ARE set");
    return true;
  });
});

// =====================================================================
// CONFIGURED path: with the personal creds present, config checks pass and the
// module reads ONLY the personal values.
// =====================================================================
test("with the full personal creds set, it reports configured", () => {
  const m = load(FULL_PA);
  assert.strictEqual(m.isPersonalConfigured(), true);
  const env = m.requirePersonalEnv();
  assert.strictEqual(env.tenantId, "pa-tenant");
  assert.strictEqual(env.clientId, "pa-client");
  assert.strictEqual(env.seedRefreshToken, "pa-seed-refresh-token");
});

test("configured personal creds do NOT depend on any business var being present", () => {
  // Personal set, business entirely absent — must still be configured.
  const m = load(FULL_PA);
  assert.strictEqual(m.isPersonalConfigured(), true);
});

test("the personal token store doc is SEPARATE from the business doc", () => {
  const m = load(FULL_PA);
  assert.strictEqual(m._SECRET_DOC_ID, "pa_ms_graph_delegated");
  assert.notStrictEqual(m._SECRET_DOC_ID, "ms_graph_delegated",
    "must not share the business refresh-token doc");
});
