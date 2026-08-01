// RoofOps ASIL backend agent endpoint — the HTTP surface over
// netlify/functions/lib/asilConversation.js. This is Claude's backend lane for
// the ASIL embodied voice interface (Codex owns the face on `codex/asil-face`;
// event contract + lane split recorded in COORDINATION.md 2026-07-31).
//
// The browser adapter (js/asil-agent-adapter.js) posts the user's spoken/typed
// command here; the server applies the system prompt, calls the model provider,
// and returns a short reply plus a face state. Provider keys and the system
// prompt stay server-side — the browser never sees them.
//
// ============================ CONTRACT =====================================
// POST /.netlify/functions/asil-agent
// Headers: Authorization: Bearer <Firebase ID token>   (required)
//
// Request body (JSON):
//   { "text": "what's my next work order?",           // required
//     "history": [ { "role": "user"|"assistant", "text": "..." } ] }  // optional
//
// Response 200 (JSON) — provenance mirrors ai-service.js / generate-summary.js:
//   { "ok": true,
//     "reply": "...",                 // short, safe to speak aloud
//     "state": "speaking"|"acting"|"needs_attention"|"success"|"error",
//     "provider": "stub"|"anthropic"|"openai",
//     "model": null | "<model id>",
//     "llm": false|true,              // true only when a real model answered
//     "fallback": true }              // present only when a keyed provider
//                                     // failed and the stub answered instead
//
// Errors: 405 method, 401 {"error":"Unauthorized"} (opaque), 403 Forbidden,
// 400 {"error":"..."} malformed/empty input, 500 server fault.
//
// AUTH: identity-first, same trust boundary as ai-service.js — requires the
// `doc.generate` permission on the caller's LIVE role doc (the field-first key
// every seed role holds). ASIL is a field/office assistant; this endpoint
// persists nothing. Server-to-server (ASIL key) access is a later slice.
// ===========================================================================
"use strict";
const { requirePermission } = require("./lib/authGuard");
const conversation = require("./lib/asilConversation");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  try {
    // Identity first, body second — an unauthenticated caller learns nothing.
    // (requirePermission also primes the dev/prod credentials safety guard.)
    try {
      await requirePermission(event, "doc.generate");
    } catch (e) {
      if (e && e.statusCode === 403) return resp(403, { error: "Forbidden" });
      if (e && e.statusCode) return resp(401, { error: "Unauthorized" });
      throw e; // real server fault (e.g. safety guard) -> outer 500
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return resp(400, { error: "Bad request" }); }

    let out;
    try {
      out = await conversation.respond(
        { text: body.text, history: body.history },
        { env: process.env }
      );
    } catch (e) {
      if (e && e.code === "EMPTY_INPUT") return resp(400, { error: "text is required" });
      throw e;
    }

    return resp(200, {
      ok: true,
      reply: out.reply,
      state: out.state,
      provider: out.provider,
      model: out.model,
      llm: out.llm,
      fallback: !!out.fallback
    });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
