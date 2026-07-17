// RoofOps AI SCOPE-DRAFT endpoint (provider-agnostic, stub-until-keyed) — the
// HTTP surface over lib/aiProvider.js's draftScope() for the Service Manager
// pre-create flow. ONE CAPABILITY PER ENDPOINT (post-#119 convergence): summary
// drafting lives in generate-summary.js, leak-photo issue-id in ai-service.js,
// and SCOPE drafting here.
//
// WHAT IT DOES: turns a proposal's TEXT (subject / body a service manager pulled
// from Outlook, or a pasted description) plus light job context into a plain-
// text scope-of-work DRAFT for the manager to confirm/edit. Text-only — the
// source is the proposal's words, not pixels; PDF-pixel/vision extraction is a
// flagged follow-up.
//
// Whether a real model answers is decided per deploy context by which env vars
// exist (dev holds ANTHROPIC_API_KEY as of 2026-07-16; production deliberately
// has none). With no key this is a deterministic stub — clearly marked
// (source:"scope_stub_v1" / llm:false) — and makes ZERO external calls. The
// client hides the button on a keyless deploy via the `capability` probe.
//
// ============================ CONTRACT =====================================
// POST /.netlify/functions/generate-scope
// Headers: Authorization: Bearer <Firebase ID token>   (required)
//
//   { "action": "capability" }
//     -> 200 { ok:true, configured: <bool> }   // is a real model wired here?
//
//   { "action": "draft_scope",
//     "proposalText": "...",                    // required, the proposal's text
//     "context": { "jobName": "...", "location": "..." } }  // optional hints
//     -> 200 { ok:true, draft:"...", source, llm, model, fallback? }
//
// Errors: 405 method, 401 Unauthorized (opaque), 403 Forbidden, 400 bad input,
// 500 server. Never persists anything — the draft only becomes part of a work
// order through the normal (workorder.edit-gated) save the manager performs.
//
// AUTH: identity-first, same trust boundary as the other AI endpoints —
// requirePermission(event, "doc.generate"): drafting text IS document
// generation, the boolean key every seed role holds, and this endpoint writes
// NOTHING. Kept consistent with generate-summary.js / ai-service.js on purpose.
// ===========================================================================
const { requirePermission } = require("./lib/authGuard");
const { resolveProvider, draftScope } = require("./lib/aiProvider");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  try {
    // Identity first, body second — an unauthenticated caller learns nothing.
    await requirePermission(event, "doc.generate");

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return resp(400, { error: "Bad request" }); }

    // Capability probe: lets the client HIDE the "AI: draft scope" button on a
    // keyless deploy (production today). Configured-state isn't sensitive but
    // stays behind the same doc.generate gate as the draft.
    if (body.action === "capability") {
      return resp(200, { ok: true, configured: resolveProvider(process.env).name !== "stub" });
    }

    if (body.action !== "draft_scope") return resp(400, { error: "Unknown action" });
    if (!body.proposalText || !String(body.proposalText).trim()) return resp(400, { error: "Missing proposalText" });

    const result = await draftScope(
      { proposalText: body.proposalText, context: body.context },
      { env: process.env }
    );
    return resp(200, {
      ok: true,
      draft: result.text,
      source: result.llm ? result.provider : "scope_stub_v1",
      llm: !!result.llm,
      model: result.model || null,
      fallback: !!result.fallback,
      aiError: result.fallback ? (result.errorDetail || null) : null
    });
  } catch (e) {
    if (e.statusCode === 401) return resp(401, { error: "Unauthorized" });
    if (e.statusCode === 403) return resp(403, { error: "Forbidden" });
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
