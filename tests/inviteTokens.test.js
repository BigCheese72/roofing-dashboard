"use strict";
/* Custom long-lived invite tokens (2026-07-16) -- regression guard.

   The invite email's "set your password" button used to be a Firebase
   password-reset action link: ~1-hour expiry, not configurable anywhere,
   dead before most of the crew ever opened the email. These tests pin
   down the replacement's guarantees (see the invite-token comment block
   in netlify/functions/auth.js):

     1. create_user/resend_invite email a 7-DAY ?invite= token link --
        never a Firebase reset link again (the stub below throws if
        generatePasswordResetLink is ever reached).
     2. The raw token is NEVER stored -- only its SHA-256 hash. A
        Firestore leak can't mint a login.
     3. accept_invite sets the real password against a valid token, then
        burns it: single-use, expired tokens dead, resend invalidates the
        old link, disable/delete revoke outstanding invites.
     4. Every dead-invite failure returns ONE generic message -- a probing
        caller can't distinguish unknown/used/revoked/expired, and can't
        confirm an email or account exists.
     5. The privileged actions stay privileged: no token -> 401. (check_/
        accept_invite are deliberately UNauthenticated -- the 256-bit
        token itself is the credential, same trust model as the Firebase
        link it replaced.)

   Same offline stub pattern as functionsAuth.test.js: firebase-admin is
   faked, no credentials, no secrets, no network. */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const Module = require("module");

const OWNER = "VALID_OWNER_TOKEN";

/* ---- in-memory Firestore: just enough surface for auth.js ---- */
const store = new Map(); // "collection/docId" -> plain data object
let autoId = 0;
function makeDoc(name, id) {
  const key = name + "/" + id;
  return {
    id: id,
    get: async () => ({ exists: store.has(key), id: id, data: () => store.get(key) }),
    set: async (data, opts) => {
      if (opts && opts.merge) store.set(key, Object.assign({}, store.get(key) || {}, data));
      else store.set(key, Object.assign({}, data));
    }
  };
}
const fakeDb = {
  collection(name) {
    return {
      doc: (id) => makeDoc(name, id || ("auto_" + (++autoId))),
      where: (field, op, value) => ({
        limit: (n) => ({
          get: async () => {
            assert.strictEqual(op, "==", "fake Firestore only supports ==");
            const docs = [];
            for (const [k, v] of store) {
              if (k.indexOf(name + "/") === 0 && v[field] === value) {
                docs.push({ id: k.slice(name.length + 1), exists: true, data: () => v });
              }
            }
            return { empty: docs.length === 0, docs: docs.slice(0, n) };
          }
        })
      })
    };
  }
};

/* ---- fake Auth: real enough to hold accounts + passwords ---- */
const authUsers = new Map(); // uid -> { uid, email, password, displayName, disabled }
let uidCounter = 0;
const fakeAuth = {
  verifyIdToken: async (token) => {
    if (token !== OWNER) throw new Error("Decoding Firebase ID token failed");
    return { uid: "owner_1", email: "mark@watkinsroofing.net", owner: true, role: "owner" };
  },
  createUser: async (opts) => {
    for (const u of authUsers.values()) {
      if (u.email === opts.email) { const e = new Error("exists"); e.code = "auth/email-already-exists"; throw e; }
    }
    const uid = "uid_" + (++uidCounter);
    authUsers.set(uid, { uid: uid, email: opts.email, password: opts.password, displayName: opts.displayName || "", disabled: false });
    return { uid: uid };
  },
  updateUser: async (uid, opts) => {
    const u = authUsers.get(uid);
    if (!u) { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
    Object.assign(u, opts);
    return u;
  },
  deleteUser: async (uid) => {
    if (!authUsers.has(uid)) { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
    authUsers.delete(uid);
  },
  setCustomUserClaims: async () => {},
  revokeRefreshTokens: async () => {},
  // THE tripwire: if the invite flow ever falls back to Firebase's
  // ~1-hour reset links, this fails the suite loudly instead of quietly
  // reintroducing the expired-invite problem this feature exists to kill.
  generatePasswordResetLink: async () => {
    throw new Error("REACHED generatePasswordResetLink -- invites must use custom 7-day tokens, never Firebase reset links");
  }
};

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() { return fakeAuth; },
  firestore() { return fakeDb; }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN"] = {
  id: "FAKE_FIREBASE_ADMIN", filename: "FAKE_FIREBASE_ADMIN", loaded: true, exports: fakeAdmin
};

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
process.env.RESEND_API_KEY = "re_fake_key";

/* Capture every outbound email; refuse any OTHER network call. */
const sentEmails = [];
global.fetch = async (url, opts) => {
  if (String(url) !== "https://api.resend.com/emails") throw new Error("UNEXPECTED NETWORK CALL: " + url);
  sentEmails.push(JSON.parse(opts.body));
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: "re_msg_" + sentEmails.length }) };
};

/* Seed the one role the tests invite against. */
store.set("roles/field_tech", { id: "field_tech", label: "Field Tech", permissions: {}, rank: 10 });

const auth = require("../netlify/functions/auth.js");

const APP_URL = "https://dev--leak-work-orders.netlify.app";
function ev(body, token) {
  const headers = { host: "dev--leak-work-orders.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: "POST", headers: headers, body: JSON.stringify(body) };
}
function lastEmailText() { return sentEmails[sentEmails.length - 1].text; }
function tokenFromLastEmail() {
  const m = /\?invite=([0-9a-f]{64})/.exec(lastEmailText());
  assert.ok(m, "invite email must contain a 64-hex-char ?invite= token link, got:\n" + lastEmailText());
  return m[1];
}
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
async function createUser(email, displayName) {
  const r = await auth.handler(ev({ action: "create_user", email: email, roleId: "field_tech", displayName: displayName || "", appUrl: APP_URL }, OWNER));
  assert.strictEqual(r.statusCode, 200, "create_user should succeed: " + r.body);
  const out = JSON.parse(r.body);
  assert.strictEqual(out.emailSent, true, "invite email must have been sent: " + r.body);
  return { uid: out.uid, token: tokenFromLastEmail() };
}

test("create_user emails a 7-day custom invite link; only the HASH is stored", async () => {
  const { uid, token } = await createUser("tech1@watkins.com", "Roof Tech One");

  // The link points at the app itself, not Firebase's hosted handler.
  assert.strictEqual(lastEmailText().indexOf("firebaseapp.com"), -1, "no Firebase-hosted action link in the invite email");
  assert.ok(lastEmailText().indexOf(APP_URL + "/?invite=" + token) !== -1, "link is appUrl + ?invite=<token>");

  // Copy sets the expectation the old email never did.
  assert.match(lastEmailText(), /works for 7 days/i, "email must state the 7-day validity window");
  assert.match(lastEmailText(), /Resend invite/i, "email must say what to do when it expires");

  // Stored record: hash only, 7-day window, single-use fields primed.
  const invite = store.get("invites/" + uid);
  assert.ok(invite, "invites/{uid} record written");
  assert.strictEqual(invite.tokenHash, sha256(token), "stored hash must be SHA-256 of the emailed token");
  assert.strictEqual(invite.expiresAt - invite.createdAt, 7 * 24 * 60 * 60 * 1000, "expiry window is exactly 7 days");
  assert.strictEqual(invite.usedAt, null);
  assert.strictEqual(invite.revokedAt, null);

  // The RAW token appears in NO stored document, anywhere, ever.
  for (const [key, doc] of store) {
    assert.strictEqual(JSON.stringify(doc).indexOf(token), -1, "raw token leaked into stored doc " + key);
  }
});

test("check_invite resolves a live token; accept_invite sets the password, signs off, and burns the token", async () => {
  const { uid, token } = await createUser("tech2@watkins.com", "Roof Tech Two");
  const beforePassword = authUsers.get(uid).password;

  const chk = await auth.handler(ev({ action: "check_invite", token: token }));
  assert.strictEqual(chk.statusCode, 200, chk.body);
  assert.strictEqual(JSON.parse(chk.body).email, "tech2@watkins.com");

  // Too-short password rejected before anything is touched.
  const weak = await auth.handler(ev({ action: "accept_invite", token: token, password: "short" }));
  assert.strictEqual(weak.statusCode, 400);
  assert.strictEqual(store.get("invites/" + uid).usedAt, null, "a rejected password must not burn the token");

  const acc = await auth.handler(ev({ action: "accept_invite", token: token, password: "roofer-strong-pw" }));
  assert.strictEqual(acc.statusCode, 200, acc.body);
  assert.strictEqual(JSON.parse(acc.body).email, "tech2@watkins.com", "email returned so the client can sign straight in");
  assert.strictEqual(authUsers.get(uid).password, "roofer-strong-pw", "real password set via Admin SDK");
  assert.notStrictEqual(authUsers.get(uid).password, beforePassword, "throwaway creation password replaced");
  assert.ok(store.get("invites/" + uid).usedAt, "token burned (usedAt set)");

  // Single-use: the same link never works twice.
  const again = await auth.handler(ev({ action: "accept_invite", token: token, password: "another-password" }));
  assert.strictEqual(again.statusCode, 410, "second accept must be rejected");
  assert.strictEqual(authUsers.get(uid).password, "roofer-strong-pw", "password unchanged by the replayed link");
});

test("expired token is dead -- and indistinguishable from any other dead link", async () => {
  const { uid, token } = await createUser("tech3@watkins.com");
  store.get("invites/" + uid).expiresAt = Date.now() - 1000; // 7 days pass

  const chk = await auth.handler(ev({ action: "check_invite", token: token }));
  const acc = await auth.handler(ev({ action: "accept_invite", token: token, password: "roofer-strong-pw" }));
  const junk = await auth.handler(ev({ action: "check_invite", token: "f".repeat(64) }));

  for (const r of [chk, acc, junk]) assert.strictEqual(r.statusCode, 410);
  assert.strictEqual(chk.body, junk.body, "expired and unknown tokens must return the IDENTICAL body -- no probing signal");
  assert.match(JSON.parse(chk.body).error, /Resend invite/i, "dead-link message says what to do next");
});

test("resend_invite mints a fresh 7-day link and kills the old one -- old-scheme accounts included", async () => {
  const { uid, token: oldToken } = await createUser("tech4@watkins.com");

  // Simulate an account invited under the old Firebase-link scheme: no
  // invite record at all. resend must still work from nothing.
  store.delete("invites/" + uid);

  const r = await auth.handler(ev({ action: "resend_invite", targetUid: uid, appUrl: APP_URL }, OWNER));
  assert.strictEqual(r.statusCode, 200, r.body);
  const newToken = tokenFromLastEmail();
  assert.notStrictEqual(newToken, oldToken, "resend must mint a new token");

  // Old link: dead. New link: works.
  const oldTry = await auth.handler(ev({ action: "accept_invite", token: oldToken, password: "roofer-strong-pw" }));
  assert.strictEqual(oldTry.statusCode, 410, "pre-resend link must be dead");
  const newTry = await auth.handler(ev({ action: "accept_invite", token: newToken, password: "roofer-strong-pw" }));
  assert.strictEqual(newTry.statusCode, 200, newTry.body);
});

test("disable_user revokes the outstanding invite; delete_user too", async () => {
  const a = await createUser("tech5@watkins.com");
  const dis = await auth.handler(ev({ action: "disable_user", targetUid: a.uid }, OWNER));
  assert.strictEqual(dis.statusCode, 200, dis.body);
  assert.ok(store.get("invites/" + a.uid).revokedAt, "disable must stamp revokedAt on the invite");
  const acc = await auth.handler(ev({ action: "accept_invite", token: a.token, password: "roofer-strong-pw" }));
  assert.strictEqual(acc.statusCode, 410, "a disabled account's invite link must be dead");

  const b = await createUser("tech6@watkins.com");
  const del = await auth.handler(ev({ action: "delete_user", targetUid: b.uid }, OWNER));
  assert.strictEqual(del.statusCode, 200, del.body);
  assert.ok(store.get("invites/" + b.uid).revokedAt, "delete must stamp revokedAt on the invite");
  const acc2 = await auth.handler(ev({ action: "accept_invite", token: b.token, password: "roofer-strong-pw" }));
  assert.strictEqual(acc2.statusCode, 410, "a deleted account's invite link must be dead");
});

test("privileged actions still demand auth; token-bearing actions demand a real token", async () => {
  // The admin-side actions: 401 with no bearer token, exactly as before.
  for (const body of [
    { action: "create_user", email: "x@y.com", roleId: "field_tech", appUrl: APP_URL },
    { action: "resend_invite", targetUid: "uid_1", appUrl: APP_URL }
  ]) {
    const r = await auth.handler(ev(body));
    assert.strictEqual(r.statusCode, 401, body.action + " must 401 without a token, got " + r.statusCode + ": " + r.body);
  }
  // The unauthenticated pair: garbage/absent invite tokens die generically.
  for (const body of [
    { action: "check_invite" },
    { action: "check_invite", token: "tooshort" },
    { action: "accept_invite", token: "", password: "roofer-strong-pw" }
  ]) {
    const r = await auth.handler(ev(body));
    assert.strictEqual(r.statusCode, 410, JSON.stringify(body) + " must 410, got " + r.statusCode + ": " + r.body);
  }
});
