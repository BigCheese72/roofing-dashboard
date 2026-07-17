"use strict";
/* Tests for the shared, provider-agnostic AI inference service:
   netlify/functions/ai-service.js + netlify/functions/lib/aiProvider.js.

   Three invariants this file exists to hold forever:

     1. NO KEY -> NO NETWORK. Until Mark provisions an AI key, the service is
        a deterministic stub. global.fetch is a trap that fails the suite if
        the no-key path ever grows an external call.
     2. THE CONTRACT. Both actions return { draft:true, provider, model, llm }
        plus their payload; issue_id results are ALWAYS clamped to the
        controlled vocabulary, no matter what a (mocked) model emitted.
     3. THE GATES. 401 opaque without a valid token, 403 without doc.generate,
        400 for malformed input INCLUDING any non-signed photo URL -- the
        signed-URL rule is the privacy boundary for the future vision path.

   firebase-admin is stubbed (same Module-hook pattern as
   functionsAuth.test.js) so this runs offline with no credentials. */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const VALID_TECH = "VALID_TECH_TOKEN";     // role "tech"   -> doc.generate: true
const VALID_VIEWER = "VALID_VIEWER_TOKEN"; // role "viewer" -> doc.generate: false

const ROLES = {
  tech: { permissions: { "doc.generate": true, "workorder.create": true } },
  viewer: { permissions: { "doc.generate": false } }
};

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === VALID_TECH) return { uid: "crew_tech_1", email: "tech@watkins.com", owner: false, role: "tech" };
        if (token === VALID_VIEWER) return { uid: "viewer_1", email: "viewer@watkins.com", owner: false, role: "viewer" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() {
    return {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => {
            if (name === "roles" && ROLES[id]) return { exists: true, data: () => ROLES[id] };
            return { exists: false };
          }
        })
      })
    };
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN"] = {
  id: "FAKE_FIREBASE_ADMIN", filename: "FAKE_FIREBASE_ADMIN", loaded: true, exports: fakeAdmin
};

// Dev-project service account on a dev host -- satisfies authGuard's
// cross-project safety guard. No real key anywhere in this file.
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });

// THE POINT OF THIS SUITE: no AI key is provisioned. Make absolutely sure the
// environment doesn't accidentally have one, then trap all network calls.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.AI_PROVIDER;
delete process.env.AI_MODEL;
const NETWORK_TRAP = async () => { throw new Error("REACHED EXTERNAL AI NETWORK CALL WITHOUT A KEY"); };
global.fetch = NETWORK_TRAP;

const aiService = require("../netlify/functions/ai-service.js");
const ai = require("../netlify/functions/lib/aiProvider.js");

function ev(method, body, token) {
  const headers = { host: "dev--watkins.netlify.app" };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: method, headers: headers, body: body ? JSON.stringify(body) : "" };
}

// A signed Firebase Storage download URL (shape only -- fake token).
const SIGNED_URL = "https://firebasestorage.googleapis.com/v0/b/x.firebasestorage.app/o/leak.jpg?alt=media&token=fake-token";
const REPORT = {
  woType: "Inspection", jobName: "Acme Plaza", serviceDate: "2026-07-16",
  roofSystem: "TPO", inspectionChecklist: [{ label: "Field membrane", rating: "Fair", notes: "surface crazing" }],
  findings: [{ condition: "Open lap seam", location: "NW corner" }],
  repairs: [], photoCaptions: ["seam at NW corner"], photoCount: 3
};

// ---------- auth surface ----------

test("GET is rejected with 405", async () => {
  const res = await aiService.handler(ev("GET", null, VALID_TECH));
  assert.equal(res.statusCode, 405);
});

test("no token -> opaque 401, leaks nothing", async () => {
  const res = await aiService.handler(ev("POST", { action: "summary", report: REPORT }, null));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, '{"error":"Unauthorized"}');
});

test("garbage token -> opaque 401", async () => {
  const res = await aiService.handler(ev("POST", { action: "summary", report: REPORT }, "FORGED"));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, '{"error":"Unauthorized"}');
});

test("authenticated user WITHOUT doc.generate -> 403", async () => {
  const res = await aiService.handler(ev("POST", { action: "summary", report: REPORT }, VALID_VIEWER));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '{"error":"Forbidden"}');
});

test("a plain field tech CAN use both actions (field-first)", async () => {
  const r1 = await aiService.handler(ev("POST", { action: "summary", report: REPORT }, VALID_TECH));
  assert.equal(r1.statusCode, 200);
  const r2 = await aiService.handler(ev("POST", { action: "issue_id", photoUrl: SIGNED_URL }, VALID_TECH));
  assert.equal(r2.statusCode, 200);
});

// ---------- input validation ----------

test("bad JSON body -> 400", async () => {
  const e = ev("POST", null, VALID_TECH);
  e.body = "{not json";
  const res = await aiService.handler(e);
  assert.equal(res.statusCode, 400);
});

test("unknown / missing action -> 400", async () => {
  for (const body of [{ action: "bogus" }, {}]) {
    const res = await aiService.handler(ev("POST", body, VALID_TECH));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "Unknown action");
  }
});

test("summary without a report -> 400", async () => {
  const res = await aiService.handler(ev("POST", { action: "summary" }, VALID_TECH));
  assert.equal(res.statusCode, 400);
});

test("summary rejects UNSIGNED photo URLs loudly (privacy boundary)", async () => {
  for (const bad of [
    ["https://example.com/public.jpg"],                 // public https, no signature
    ["http://firebasestorage.googleapis.com/x?token=t"], // not https
    [SIGNED_URL, "https://example.com/public.jpg"]       // one bad apple rejects all
  ]) {
    const res = await aiService.handler(ev("POST", { action: "summary", report: REPORT, photoUrls: bad }, VALID_TECH));
    assert.equal(res.statusCode, 400, "should reject: " + JSON.stringify(bad));
  }
});

test("issue_id requires a SIGNED photo URL", async () => {
  for (const bad of [undefined, "", "https://example.com/leak.jpg", "http://x.com/a?token=t", "not a url"]) {
    const res = await aiService.handler(ev("POST", { action: "issue_id", photoUrl: bad }, VALID_TECH));
    assert.equal(res.statusCode, 400, "should reject: " + JSON.stringify(bad));
  }
});

test("isSignedPhotoUrl accepts the real signed-URL shapes", () => {
  assert.ok(ai.isSignedPhotoUrl(SIGNED_URL));                                              // Firebase token
  assert.ok(ai.isSignedPhotoUrl("https://storage.googleapis.com/b/o.jpg?X-Goog-Signature=abc")); // GCS V4
  assert.ok(ai.isSignedPhotoUrl("https://s3.amazonaws.com/b/o.jpg?X-Amz-Signature=abc"));  // S3 presigned
  assert.ok(!ai.isSignedPhotoUrl("https://companycam.com/photo.jpg"));                     // public
  assert.ok(!ai.isSignedPhotoUrl("https://example.com/?tokenish=1&signatureless=2"));      // lookalike params
});

// ---------- the no-key deterministic stub ----------

test("summary stub: contract shape, clearly marked, deterministic, NO network", async () => {
  const res = await aiService.handler(ev("POST", { action: "summary", report: REPORT, photoUrls: [SIGNED_URL] }, VALID_TECH));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.draft, true);
  assert.equal(body.action, "summary");
  assert.equal(body.provider, "stub");
  assert.equal(body.model, null);
  assert.equal(body.llm, false);
  assert.ok(!("fallback" in body), "no-key stub is not a fallback");
  assert.ok(body.summaryText.startsWith(ai.STUB_MARKER), "stub output must be clearly marked");
  assert.match(body.summaryText, /Acme Plaza/);

  // Determinism: same input, byte-identical output.
  const res2 = await aiService.handler(ev("POST", { action: "summary", report: REPORT, photoUrls: [SIGNED_URL] }, VALID_TECH));
  assert.equal(res.body, res2.body);
});

test("issue_id stub: controlled vocabulary, keyword match, low confidence", async () => {
  const res = await aiService.handler(ev("POST", {
    action: "issue_id", photoUrl: SIGNED_URL,
    context: { reportedArea: "standing water near the roof drain", notes: "" }
  }, VALID_TECH));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.draft, true);
  assert.equal(body.provider, "stub");
  assert.equal(body.llm, false);
  assert.equal(body.result.issue, "ponding_water");
  assert.equal(body.result.likelyCause, "drainage_deficiency");
  assert.equal(body.result.confidence, "low", "the stub never saw the photo -- confidence must be low");
  assert.ok(ai.ISSUE_VOCABULARY.includes(body.result.issue));
  assert.ok(ai.CAUSE_VOCABULARY.includes(body.result.likelyCause));
});

test("issue_id stub with no matching keywords -> indeterminate/unconfirmed/low", async () => {
  const res = await aiService.handler(ev("POST", {
    action: "issue_id", photoUrl: SIGNED_URL, context: { notes: "photo of the roof" }
  }, VALID_TECH));
  const body = JSON.parse(res.body);
  assert.deepEqual(
    [body.result.issue, body.result.likelyCause, body.result.confidence],
    ["indeterminate", "unconfirmed", "low"]
  );
});

// ---------- provider resolution (pure, env-object driven) ----------

test("resolveProvider: no keys -> stub; keys select providers; AI_PROVIDER forces", () => {
  assert.equal(ai.resolveProvider({}).name, "stub");
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "k" }).name, "anthropic");
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "k" }).model, "claude-opus-4-8");
  assert.equal(ai.resolveProvider({ OPENAI_API_KEY: "k" }).name, "openai");
  // Anthropic wins when both keys exist...
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }).name, "anthropic");
  // ...unless AI_PROVIDER forces otherwise.
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", AI_PROVIDER: "openai" }).name, "openai");
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "a", AI_PROVIDER: "stub" }).name, "stub");
  // Forcing a provider whose key is absent degrades to stub, never throws.
  assert.equal(ai.resolveProvider({ AI_PROVIDER: "anthropic" }).name, "stub");
  // Model overrides.
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "k", AI_MODEL: "claude-haiku-4-5" }).model, "claude-haiku-4-5");
  assert.equal(ai.resolveProvider({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m1", AI_MODEL: "m2" }).model, "m1");
});

// ---------- provider wire paths (mocked fetch -- still no real network) ----------

function mockFetch(responder) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: url, init: init, body: JSON.parse(init.body) });
    return responder(url, init);
  };
  return calls;
}
function jsonRes(obj, status) {
  return { ok: (status || 200) < 300, status: status || 200, json: async () => obj };
}
test.afterEach(() => { global.fetch = NETWORK_TRAP; });

test("anthropic path: correct wire shape, image-by-URL, text extracted", async () => {
  const calls = mockFetch(() => jsonRes({ content: [{ type: "text", text: "Drafted summary." }] }));
  const out = await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT), photoUrls: [SIGNED_URL] },
    { env: { ANTHROPIC_API_KEY: "test-key" } }
  );
  assert.equal(out.text, "Drafted summary.");
  assert.deepEqual([out.provider, out.model, out.llm], ["anthropic", "claude-opus-4-8", true]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  const content = calls[0].body.messages[0].content;
  assert.deepEqual(content[0], { type: "image", source: { type: "url", url: SIGNED_URL } });
  assert.equal(content[1].type, "text");
  assert.ok(calls[0].body.max_tokens > 0);
});

test("openai path: correct wire shape, image_url block, text extracted", async () => {
  const calls = mockFetch(() => jsonRes({ choices: [{ message: { content: "Drafted summary." } }] }));
  const out = await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT), photoUrls: [SIGNED_URL] },
    { env: { OPENAI_API_KEY: "test-key" } }
  );
  assert.equal(out.text, "Drafted summary.");
  assert.equal(out.provider, "openai");
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].init.headers["Authorization"], "Bearer test-key");
  const userContent = calls[0].body.messages[1].content;
  assert.deepEqual(userContent[0], { type: "image_url", image_url: { url: SIGNED_URL } });
});

test("anthropic path: inline base64 photo rides as a base64 image source (Phase 1.5)", async () => {
  const calls = mockFetch(() => jsonRes({ content: [{ type: "text", text: "Drafted with vision." }] }));
  const out = await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT), photoImages: [{ mediaType: "image/jpeg", data: "QUJD" }] },
    { env: { ANTHROPIC_API_KEY: "test-key" } }
  );
  assert.equal(out.llm, true);
  const content = calls[0].body.messages[0].content;
  assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  assert.equal(content[1].type, "text");
});

test("openai path: inline base64 photo rides as a data-URL image_url (its inline form)", async () => {
  const calls = mockFetch(() => jsonRes({ choices: [{ message: { content: "Drafted with vision." } }] }));
  await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT), photoImages: [{ mediaType: "image/png", data: "QUJD" }] },
    { env: { OPENAI_API_KEY: "test-key" } }
  );
  const userContent = calls[0].body.messages[1].content;
  assert.deepEqual(userContent[0], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
});

test("vision budget is SHARED: signed URLs take it first, inline images only fill what's left", async () => {
  const calls = mockFetch(() => jsonRes({ content: [{ type: "text", text: "ok" }] }));
  const urls = Array.from({ length: ai.MAX_VISION_PHOTOS + 2 }, (_, i) => SIGNED_URL + "&i=" + i);
  const images = Array.from({ length: 4 }, (_, i) => ({ mediaType: "image/jpeg", data: "AA" + i }));
  await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT), photoUrls: urls, photoImages: images },
    { env: { ANTHROPIC_API_KEY: "test-key" } }
  );
  const sent = calls[0].body.messages[0].content.filter(c => c.type === "image");
  assert.equal(sent.length, ai.MAX_VISION_PHOTOS, "cap holds across both kinds");
  assert.ok(sent.every(c => c.source.type === "url"), "URLs filled the whole budget; no inline rode");
});

test("cleanInlineImage: the base64 gate — media-type allowlist, charset, size, shape", () => {
  assert.deepEqual(ai.cleanInlineImage({ mediaType: "image/jpeg", data: "QUJD" }),
    { mediaType: "image/jpeg", data: "QUJD" });
  assert.deepEqual(ai.cleanInlineImage({ mediaType: "image/webp", data: "QQ==" }),
    { mediaType: "image/webp", data: "QQ==" });
  assert.equal(ai.cleanInlineImage({ mediaType: "application/pdf", data: "QUJD" }), null, "non-image media type");
  assert.equal(ai.cleanInlineImage({ mediaType: "image/svg+xml", data: "QUJD" }), null, "scriptable image type");
  assert.equal(ai.cleanInlineImage({ mediaType: "image/jpeg", data: "not base64!!" }), null, "charset");
  assert.equal(ai.cleanInlineImage({ mediaType: "image/jpeg", data: "" }), null, "empty");
  assert.equal(ai.cleanInlineImage({ mediaType: "image/jpeg", data: "A".repeat(5 * 1024 * 1024 + 1) }), null, "over the ~5MB provider limit");
  assert.equal(ai.cleanInlineImage(null), null);
  assert.equal(ai.cleanInlineImage("data:image/jpeg;base64,QUJD"), null, "a raw data-URL string is not the shape");
});

test("issue_id via anthropic: model JSON is vocab-clamped even when wrapped in prose", async () => {
  mockFetch(() => jsonRes({
    content: [{ type: "text", text: 'Here you go: {"issue":"open_seam","likelyCause":"weathering_age","confidence":"high","rationale":"Visible lap separation."}' }]
  }));
  const out = await ai.identifyIssue(
    { photoUrl: SIGNED_URL, context: { notes: "leak" } },
    { env: { ANTHROPIC_API_KEY: "test-key" } }
  );
  assert.deepEqual(
    [out.issue, out.likelyCause, out.confidence, out.llm],
    ["open_seam", "weathering_age", "high", true]
  );
});

test("issue_id: out-of-vocab model output degrades to indeterminate, never leaks free text", async () => {
  mockFetch(() => jsonRes({
    content: [{ type: "text", text: '{"issue":"alien_damage","likelyCause":"cosmic rays","confidence":"certain","rationale":"x"}' }]
  }));
  const out = await ai.identifyIssue(
    { photoUrl: SIGNED_URL, context: {} },
    { env: { ANTHROPIC_API_KEY: "test-key" } }
  );
  assert.deepEqual([out.issue, out.likelyCause, out.confidence], ["indeterminate", "unconfirmed", "low"]);
});

test("provider failure falls back to the stub, flagged fallback:true (no dead-end on a roof)", async () => {
  mockFetch(() => jsonRes({ error: "overloaded" }, 529));
  const sum = await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT) },
    { env: { ANTHROPIC_API_KEY: "test-key" } }
  );
  assert.deepEqual([sum.provider, sum.llm, sum.fallback], ["stub", false, true]);
  assert.ok(sum.text.startsWith(ai.STUB_MARKER));

  const issue = await ai.identifyIssue(
    { photoUrl: SIGNED_URL, context: { notes: "hail hit last week" } },
    { env: { OPENAI_API_KEY: "test-key" } }
  );
  assert.deepEqual([issue.provider, issue.fallback, issue.issue], ["stub", true, "hail_damage"]);
});

test("generateSummary honors caller-supplied stubText (the PR #119 convergence seam)", async () => {
  const out = await ai.generateSummary(
    { report: ai.sanitizeReport(REPORT) },
    { env: {}, stubText: "TEMPLATE COMPOSER OUTPUT" }
  );
  assert.equal(out.text, "TEMPLATE COMPOSER OUTPUT");
  assert.equal(out.provider, "stub");
});

// ---------- sanitizer clamps (token-cost ceiling + injection bound) ----------

test("sanitizeReport clamps lengths, row counts, and drops junk rows", () => {
  const big = ai.sanitizeReport({
    woType: "X".repeat(500),
    findings: Array.from({ length: 200 }, (_, i) => ({ condition: "c" + i })),
    inspectionChecklist: [{ label: "ok", rating: "Good" }, { junk: true }, null],
    photoCount: "99999"
  });
  assert.equal(big.woType.length, 40);
  assert.equal(big.findings.length, 50);
  assert.equal(big.inspectionChecklist.length, 1);
  assert.equal(big.photoCount, 500);
  assert.equal(ai.sanitizeReport(null), null);
  assert.equal(ai.sanitizeReport("string"), null);
});
