"use strict";
/* Tests for the `create_draft` action on netlify/functions/contacts-sync.js.
 *
 * create_draft lets a morning routine compose email replies into Mark's
 * Outlook DRAFTS for his review. The hard, load-bearing promise is that it
 * ONLY ever creates a draft — it NEVER sends, deletes, forwards, or marks mail
 * read. These tests assert both the happy path (a reply draft and a fresh
 * draft are created correctly, signed off in Mark's voice) AND, adversarially,
 * that no send/delete path exists — checked both by intercepting every Graph
 * call the handler makes AND by static inspection of the source.
 *
 * No network and no secrets: firebase-admin is stubbed (owner token verifies
 * offline) and lib/graphDelegatedAuth is replaced in require.cache with a
 * recorder that returns canned Graph responses and logs every call. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");

const VALID = "VALID_OWNER_TOKEN";

// --- stub firebase-admin so requirePermission() verifies offline as owner ---
const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token !== VALID) throw new Error("Decoding Firebase ID token failed");
        // Owner => requirePermission passes without any Firestore read.
        return { uid: "mark", email: "marks@watkinsroofing.net", owner: true, role: "owner" };
      },
    };
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN_CD";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN_CD"] = {
  id: "FAKE_FIREBASE_ADMIN_CD", filename: "FAKE_FIREBASE_ADMIN_CD", loaded: true, exports: fakeAdmin,
};
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });

// --- replace lib/graphDelegatedAuth with a recording stub ------------------
const CS_PATH = require.resolve("../netlify/functions/contacts-sync.js");
const GDA_PATH = require.resolve("../netlify/functions/lib/graphDelegatedAuth.js");

let calls = [];
let responder = () => { throw new Error("no responder set"); };

require.cache[GDA_PATH] = {
  id: GDA_PATH, filename: GDA_PATH, loaded: true,
  exports: {
    graphFetchDelegated: async (pathOrUrl, options) => {
      const method = (options && options.method) || "GET";
      let reqBody = null;
      try { reqBody = options && options.body ? JSON.parse(options.body) : null; } catch (e) { reqBody = options.body; }
      calls.push({ method, url: pathOrUrl, body: reqBody });
      const out = responder(pathOrUrl, method, reqBody) || { status: 200, json: {} };
      const text = JSON.stringify(out.json == null ? {} : out.json);
      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        headers: { get: () => null },
        text: async () => text,
      };
    },
  },
};

const cs = require("../netlify/functions/contacts-sync.js");

function ev(body, token) {
  const headers = { host: "dev--leak-work-orders.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: "POST", headers, body: body ? JSON.stringify(body) : "" };
}

// No Graph call the handler makes may ever be a send or a delete. This is the
// runtime half of the guardrail — checked after every test that hits Graph.
function assertNoSendOrDeletePath() {
  for (const c of calls) {
    assert.notStrictEqual(c.method, "DELETE", "create_draft must never issue a DELETE (call: " + c.url + ")");
    assert.ok(!/\/send(Mail)?(\b|$|\/|\?)/i.test(c.url),
      "create_draft must never hit a send endpoint (call: " + c.method + " " + c.url + ")");
    assert.ok(["GET", "POST", "PATCH"].includes(c.method),
      "unexpected Graph method " + c.method + " on " + c.url);
  }
}

test("create_draft reply: creates a reply draft, signs it off, preserves the quote, never sends", async () => {
  calls = [];
  responder = (url, method) => {
    if (/\/createReply$/.test(url) && method === "POST") {
      return { status: 201, json: {
        id: "AAreplyDraft", webLink: "https://outlook.office.com/mail/AAreplyDraft",
        body: { contentType: "html", content: "<div id='q'>On Tue wrote: ORIGINAL_THREAD</div>" },
      } };
    }
    if (url === "/me/messages/AAreplyDraft" && method === "PATCH") {
      return { status: 200, json: { id: "AAreplyDraft" } };
    }
    throw new Error("unexpected Graph call: " + method + " " + url);
  };

  const r = await cs.handler(ev({
    action: "create_draft",
    replyToMessageId: "AAoriginalMsg",
    bodyText: "Thanks for the update — we can be on site Thursday morning.",
  }, VALID));

  assert.strictEqual(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.created, true);
  assert.strictEqual(j.kind, "reply");
  assert.strictEqual(j.id, "AAreplyDraft");
  assert.strictEqual(j.webLink, "https://outlook.office.com/mail/AAreplyDraft");

  // Exactly two Graph writes: createReply (POST) then the body PATCH. No more.
  assert.strictEqual(calls.length, 2, "expected exactly createReply + PATCH, got " + calls.map(c => c.method + " " + c.url).join(", "));
  assert.strictEqual(calls[0].method, "POST");
  assert.match(calls[0].url, /\/me\/messages\/AAoriginalMsg\/createReply$/);
  assert.strictEqual(calls[1].method, "PATCH");
  assert.strictEqual(calls[1].url, "/me/messages/AAreplyDraft", "PATCH must target ONLY the just-created draft");

  const patched = calls[1].body.body;
  assert.strictEqual(patched.contentType, "HTML");
  assert.match(patched.content, /Thanks for the update/, "Mark's message must be in the draft");
  assert.match(patched.content, /Respectfully/, "the sign-off must be appended");
  assert.match(patched.content, /ORIGINAL_THREAD/, "the quoted original thread must be preserved");
  // Mark's text appears ABOVE the quoted history.
  assert.ok(patched.content.indexOf("Thanks for the update") < patched.content.indexOf("ORIGINAL_THREAD"),
    "Mark's reply must sit above the quoted history");

  assertNoSendOrDeletePath();
});

test("create_draft fresh: creates a new draft in Drafts with recipients, subject, signed-off body", async () => {
  calls = [];
  responder = (url, method) => {
    if (url === "/me/messages" && method === "POST") {
      return { status: 201, json: { id: "AAfreshDraft", webLink: "https://outlook.office.com/mail/AAfreshDraft" } };
    }
    throw new Error("unexpected Graph call: " + method + " " + url);
  };

  const r = await cs.handler(ev({
    action: "create_draft",
    toRecipients: ["customer@example.com", { address: "pm@example.com", name: "Pat M" }],
    subject: "Re: roof inspection",
    bodyText: "Following up on the inspection — the report is attached.",
    ccRecipients: ["office@watkinsroofing.net"],
  }, VALID));

  assert.strictEqual(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.created, true);
  assert.strictEqual(j.kind, "fresh");
  assert.strictEqual(j.id, "AAfreshDraft");
  assert.strictEqual(j.webLink, "https://outlook.office.com/mail/AAfreshDraft");

  // Exactly one Graph write: the message create. No send follow-up.
  assert.strictEqual(calls.length, 1, "a fresh draft is ONE POST to /me/messages and nothing else");
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].url, "/me/messages");

  const msg = calls[0].body;
  assert.strictEqual(msg.subject, "Re: roof inspection");
  assert.deepStrictEqual(msg.toRecipients, [
    { emailAddress: { address: "customer@example.com" } },
    { emailAddress: { address: "pm@example.com", name: "Pat M" } },
  ]);
  assert.deepStrictEqual(msg.ccRecipients, [{ emailAddress: { address: "office@watkinsroofing.net" } }]);
  assert.strictEqual(msg.body.contentType, "Text");
  assert.match(msg.body.content, /Following up on the inspection/);
  assert.match(msg.body.content, /Respectfully,\nMark$/, "fresh drafts end with Mark's sign-off");

  assertNoSendOrDeletePath();
});

test("create_draft: a full bodyHtml is used verbatim and NOT auto-signed", async () => {
  calls = [];
  responder = (url, method) => {
    if (url === "/me/messages" && method === "POST") return { status: 201, json: { id: "AAhtml" } };
    throw new Error("unexpected: " + method + " " + url);
  };
  const html = "<p>Hi Dana,</p><p>All set for Friday.</p><p>— Mark</p>";
  const r = await cs.handler(ev({
    action: "create_draft",
    toRecipients: ["dana@example.com"],
    subject: "Friday",
    bodyHtml: html,
  }, VALID));
  assert.strictEqual(r.statusCode, 200);
  const msg = calls[0].body;
  assert.strictEqual(msg.body.contentType, "HTML");
  assert.strictEqual(msg.body.content, html, "a full bodyHtml must be sent verbatim");
  assert.ok(!/Respectfully,\nMark/.test(msg.body.content), "no auto sign-off when the caller supplies a full body");
  assertNoSendOrDeletePath();
});

test("create_draft: neither replyToMessageId nor toRecipients => 400, and NO Graph call is made", async () => {
  calls = [];
  responder = () => { throw new Error("must not reach Graph"); };
  const r = await cs.handler(ev({ action: "create_draft", subject: "orphan", bodyText: "hello" }, VALID));
  assert.strictEqual(r.statusCode, 400);
  assert.match(JSON.parse(r.body).error, /replyToMessageId|toRecipients/);
  assert.strictEqual(calls.length, 0, "a malformed request must not touch Graph at all");
});

test("create_draft is AUTH-GATED: no token => 401 and NOT a single Graph call", async () => {
  calls = [];
  responder = () => { throw new Error("must not reach Graph unauthenticated"); };
  const r = await cs.handler(ev({ action: "create_draft", toRecipients: ["x@example.com"], bodyText: "hi" }, null));
  assert.strictEqual(r.statusCode, 401, "an unauthenticated caller must be turned away before any Graph call");
  assert.strictEqual(calls.length, 0, "auth runs FIRST — no Graph call on the unauthenticated path");
});

// --- pure helper unit tests -------------------------------------------------
test("textWithSignoff appends the sign-off, and is idempotent if already signed", () => {
  const { textWithSignoff } = cs._internals;
  assert.strictEqual(textWithSignoff("Sounds good."), "Sounds good.\n\nRespectfully,\nMark");
  assert.strictEqual(textWithSignoff(""), "Respectfully,\nMark");
  // Already signed off -> not doubled.
  const signed = "Sounds good.\n\nRespectfully,\nMark";
  assert.strictEqual(textWithSignoff(signed), signed);
});

test("normalizeRecipients accepts strings and objects and drops junk", () => {
  const { normalizeRecipients } = cs._internals;
  assert.deepStrictEqual(
    normalizeRecipients(["a@b.com", { email: "c@d.com", name: "C D" }, "garbage", "", null, { name: "no addr" }]),
    [
      { emailAddress: { address: "a@b.com" } },
      { emailAddress: { address: "c@d.com", name: "C D" } },
    ]
  );
  assert.deepStrictEqual(normalizeRecipients(null), []);
});

// --- STATIC guardrail: the source contains no send/delete path at all -------
test("SOURCE has no send/delete/isRead mail path anywhere in the file", () => {
  const src = fs.readFileSync(CS_PATH, "utf8");
  // Strip line comments so prose that merely NAMES these (to promise they are
  // absent) doesn't trip the check — we assert on executable code only.
  const code = src
    .split("\n")
    .map(line => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
  assert.ok(!/\/sendMail\b/.test(code), "no /sendMail endpoint may appear in code");
  assert.ok(!/\/send\b/.test(code), "no /send endpoint may appear in code");
  assert.ok(!/["']DELETE["']/.test(code), "no DELETE method may appear in code");
  // isRead may be READ (selected / inspected — list_messages does) but never
  // WRITTEN: an `isRead:` object key would be a mark-as-read mutation.
  assert.ok(!/isRead\s*:/.test(code), "create_draft/handler must never WRITE isRead (mark-as-read)");
});
