// RoofOps AI endpoint (provider-agnostic, stub-until-keyed) -- the HTTP
// surface over netlify/functions/lib/aiProvider.js for small AI drafting
// capabilities such as leak-photo ISSUE-ID and owner-only estimate intake.
//
// ONE CAPABILITY PER ENDPOINT (post-#119 cross-review convergence):
//   * SUMMARY drafting lives at netlify/functions/generate-summary.js -- it
//     owns the summary-specific pieces (server-side V4 signed-URL minting
//     from Storage refs, inline Firestore photo reads, the
//     SUMMARY_TARGET_WORDS / STYLE_EXEMPLAR prompt) and consumes the SAME
//     lib/aiProvider.js seam. This file's original "summary" action was
//     retired before it ever had a caller, so there is exactly one summary
//     contract to evolve.
//   * ISSUE-ID lives here: one signed leak-photo URL + context in,
//     structured { issue, likelyCause, confidence } out -- controlled
//     vocabulary only. The future leak-photo UI builds against this.
//   * ESTIMATE INTAKE lives here: owner-only current estimator fields in,
//     structured field recommendations out. RoofOps still calculates the
//     material list and totals client-side from deterministic estimating rules.
//
// Whether a real model answers is decided per deploy context by which env
// vars exist (dev holds ANTHROPIC_API_KEY as of 2026-07-16; production
// deliberately has no key). With no key this runs as a deterministic stub --
// clearly marked via provider:"stub" / llm:false -- and makes ZERO external
// network calls. See aiProvider.js for provider-selection and cost-control
// rules.
//
// ============================ CONTRACT =====================================
// POST /.netlify/functions/ai-service
// Headers: Authorization: Bearer <Firebase ID token>   (required)
//
// Request body (JSON):
//   {
//     "action": "issue_id",
//     "photoUrl": "https://...",      // required, SIGNED url only. When the
//                                     // leak-photo UI lands, follow
//                                     // generate-summary.js's pattern: the
//                                     // SERVER mints a short-lived V4 signed
//                                     // READ url from the photo's Storage
//                                     // ref -- never a public URL. (On dev,
//                                     // which has no Storage bucket, extend
//                                     // this endpoint with the inline
//                                     // Firestore-read pattern instead.)
//     "context":  { "woType", "jobName", "roofSystem", "reportedArea",
//                   "notes" }         // optional structured hints
//   }
// or
//   {
//     "action": "estimate_epdm_sa",
//     "estimate": { ...current estimator intake fields... } // owner-only
//   }
//
// Response 200 (JSON) -- provenance fields mirror generate-summary.js's
// (ok / source / llm / model / fallback) so the client toast pattern from
// PR #144 carries over verbatim:
//   {
//     "ok": true,
//     "draft": true,                  // ALWAYS true -- human confirms/edits;
//                                     // this endpoint never persists anything
//     "action": "issue_id",
//     "source": "keyword_stub_v1" | "anthropic" | "openai",
//     "provider": "stub" | "anthropic" | "openai",  // what actually answered
//     "model": null | "<model id>",
//     "llm": false | true,            // true only when a real model answered
//     "fallback": true,               // present only when a key exists but
//                                     // the provider call failed and the
//                                     // deterministic stub answered instead
//
//     // values drawn ONLY from aiProvider.js's ISSUE_VOCABULARY /
//     // CAUSE_VOCABULARY / CONFIDENCE_LEVELS, server-clamped regardless of
//     // what any model emitted
//     "result": { "issue": "...", "likelyCause": "...",
//                 "confidence": "low"|"medium"|"high", "rationale": "..." }
//   }
//
// Errors: 405 method, 401 {"error":"Unauthorized"} (opaque -- leaks nothing),
// 403 {"error":"Forbidden"}, 400 {"error":"..."} for malformed input
// (including a non-signed photo URL -- rejected loudly, not silently
// dropped, so clients learn the privacy boundary), 500 for server faults.
// ===========================================================================
//
// AUTH: identity-first, same trust boundary as every other function here.
// Requires the `doc.generate` permission on the caller's LIVE role doc --
// the boolean-only key every seed role holds (field-first: the tech on the
// roof IDs their own leak photo). Chosen over workorder.edit /
// capture.photos because those are "proj"-scoped for several roles and
// requirePermission() deliberately does not resolve scopes; this endpoint
// also writes NOTHING, so the normal edit-gated save path keeps its own
// gate. Same reasoning as generate-summary.js -- kept consistent on
// purpose. Open question from the #119 cross-review: whether leak-photo ID
// deserves its own permission key once the UI lands.
const { verifyCaller, getPermissionValue } = require("./lib/authGuard");
const ai = require("./lib/aiProvider");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  try {
    // Identity first, body second -- an unauthenticated caller learns nothing,
    // not even which actions exist. verifyCaller also primes the dev/prod
    // credentials safety guard via the event's Host header.
    let caller;
    try {
      caller = await verifyCaller(event);
    } catch (e) {
      if (e && e.statusCode === 403) return resp(403, { error: "Forbidden" });
      if (e && e.statusCode) return resp(401, { error: "Unauthorized" });
      throw e; // real server fault (e.g. safety guard) -> outer 500 with detail
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return resp(400, { error: "Bad request" }); }

    if (body.action === "issue_id") {
      if (!caller.owner) {
        const allowed = await getPermissionValue(caller.role, "doc.generate");
        if (allowed !== true) return resp(403, { error: "Forbidden" });
      }
      if (!ai.isSignedPhotoUrl(body.photoUrl)) {
        return resp(400, { error: "photoUrl must be a signed https URL" });
      }
      const out = await ai.identifyIssue(
        { photoUrl: body.photoUrl, context: body.context },
        { env: process.env }
      );
      const r = {
        ok: true, draft: true, action: "issue_id",
        source: out.llm ? out.provider : "keyword_stub_v1",
        provider: out.provider, model: out.model, llm: out.llm,
        result: {
          issue: out.issue, likelyCause: out.likelyCause,
          confidence: out.confidence, rationale: out.rationale
        }
      };
      if (out.fallback) r.fallback = true;
      return resp(200, r);
    }

    if (body.action === "estimate_epdm_sa") {
      if (!caller.owner) return resp(403, { error: "Forbidden" });
      const out = await ai.draftEstimate(
        { estimate: body.estimate || {} },
        { env: process.env }
      );
      const r = {
        ok: true, draft: true, action: "estimate_epdm_sa",
        source: out.llm ? out.provider : "estimate_stub_v1",
        provider: out.provider, model: out.model, llm: out.llm,
        result: {
          fields: out.fields || {},
          assumptions: out.assumptions || [],
          missingInputs: out.missingInputs || [],
          warnings: out.warnings || [],
          rulesApplied: out.rulesApplied || []
        }
      };
      if (out.fallback) r.fallback = true;
      if (out.errorDetail) r.errorDetail = out.errorDetail;
      return resp(200, r);
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
