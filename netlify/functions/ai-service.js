// RoofOps shared AI inference endpoint (provider-agnostic, stub-until-keyed).
//
// This is the HTTP surface over netlify/functions/lib/aiProvider.js -- the
// single backend both AI features call:
//   (a) SUMMARY  -- draft report-summary text from structured findings
//                   (+ optional signed photo URLs for vision grounding)
//   (b) ISSUE-ID -- structured issue identification from one signed leak
//                   photo URL + context, controlled vocabulary only
//
// NO API KEY EXISTS YET (Mark provisions ANTHROPIC_API_KEY or OPENAI_API_KEY
// in Netlify env later). Until then every response is served by the
// deterministic stub -- clearly marked via provider:"stub" / llm:false --
// and this function makes ZERO external network calls. See aiProvider.js
// header for the provider-selection and cost-control rules.
//
// ============================ CONTRACT =====================================
// POST /.netlify/functions/ai-service
// Headers: Authorization: Bearer <Firebase ID token>   (required)
//
// Request body (JSON):
//   {
//     "action": "summary" | "issue_id",
//
//     // action:"summary"
//     "report":    { ...projection of the work order's OWN structured text,
//                    same shape as generate-summary.js / PR #119's
//                    buildSummaryDraftPayload(): woType, jobName, location,
//                    serviceDate, technician, roofSystem, reportedArea,
//                    warrantable, nonWarrantable, inspectionChecklist[],
//                    findings[], repairs[], photoCaptions[], photoCount.
//                    NEVER photo bytes, pins, GPS, ids, or signatures. },
//     "photoUrls": ["https://..."],   // optional, max 8, SIGNED urls only
//
//     // action:"issue_id"
//     "photoUrl": "https://...",      // required, SIGNED url only
//     "context":  { "woType", "jobName", "roofSystem", "reportedArea",
//                   "notes" }         // optional structured hints
//   }
//
// Response 200 (JSON):
//   {
//     "draft": true,                  // ALWAYS true -- human confirms/edits;
//                                     // this endpoint never persists anything
//     "action": "summary" | "issue_id",
//     "provider": "stub" | "anthropic" | "openai",  // what actually answered
//     "model": null | "<model id>",
//     "llm": false | true,            // true only when a real model answered
//     "fallback": true,               // present only when a key exists but
//                                     // the provider call failed and the
//                                     // deterministic stub answered instead
//
//     // action:"summary"
//     "summaryText": "...",
//
//     // action:"issue_id" -- values drawn ONLY from aiProvider.js's
//     // ISSUE_VOCABULARY / CAUSE_VOCABULARY / CONFIDENCE_LEVELS,
//     // server-clamped regardless of what any model emitted
//     "result": { "issue": "...", "likelyCause": "...",
//                 "confidence": "low"|"medium"|"high", "rationale": "..." }
//   }
//
// Errors: 405 method, 401 {"error":"Unauthorized"} (opaque -- leaks nothing),
// 403 {"error":"Forbidden"}, 400 {"error":"..."} for malformed input
// (including any non-signed photo URL -- rejected loudly, not silently
// dropped, so clients learn the privacy boundary), 500 for server faults.
// ===========================================================================
//
// AUTH: identity-first, same trust boundary as every other function here.
// Both actions require the `doc.generate` permission on the caller's LIVE
// role doc -- the boolean-only key every seed role holds (field-first: the
// tech on the roof drafts their own summary / IDs their own leak photo).
// Chosen over workorder.edit / capture.photos because those are
// "proj"-scoped for several roles and requirePermission() deliberately does
// not resolve scopes; this endpoint also writes NOTHING, so the normal
// edit-gated save path keeps its own gate. Same reasoning as PR #119 --
// flagged there for cross-review; keeping the two consistent on purpose.
const { requirePermission } = require("./lib/authGuard");
const ai = require("./lib/aiProvider");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  try {
    // Identity first, body second -- an unauthenticated caller learns nothing,
    // not even which actions exist. (requirePermission also primes the
    // dev/prod credentials safety guard via the event's Host header.)
    try {
      await requirePermission(event, "doc.generate");
    } catch (e) {
      if (e && e.statusCode === 403) return resp(403, { error: "Forbidden" });
      if (e && e.statusCode) return resp(401, { error: "Unauthorized" });
      throw e; // real server fault (e.g. safety guard) -> outer 500 with detail
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return resp(400, { error: "Bad request" }); }

    if (body.action === "summary") {
      const report = ai.sanitizeReport(body.report);
      if (!report) return resp(400, { error: "Missing report" });

      // Photo URLs are optional, but if the client sends ANY it must send
      // signed ones -- reject the whole request rather than silently
      // dropping, so a public-URL bug surfaces in development, not in a
      // quiet privacy leak later.
      const rawUrls = Array.isArray(body.photoUrls) ? body.photoUrls : [];
      if (rawUrls.length && !rawUrls.every(ai.isSignedPhotoUrl)) {
        return resp(400, { error: "photoUrls must be signed https URLs" });
      }
      const out = await ai.generateSummary(
        { report: report, photoUrls: rawUrls.slice(0, 8) },
        { env: process.env }
      );
      const r = {
        draft: true, action: "summary",
        provider: out.provider, model: out.model, llm: out.llm,
        summaryText: out.text
      };
      if (out.fallback) r.fallback = true;
      return resp(200, r);
    }

    if (body.action === "issue_id") {
      if (!ai.isSignedPhotoUrl(body.photoUrl)) {
        return resp(400, { error: "photoUrl must be a signed https URL" });
      }
      const out = await ai.identifyIssue(
        { photoUrl: body.photoUrl, context: body.context },
        { env: process.env }
      );
      const r = {
        draft: true, action: "issue_id",
        provider: out.provider, model: out.model, llm: out.llm,
        result: {
          issue: out.issue, likelyCause: out.likelyCause,
          confidence: out.confidence, rationale: out.rationale
        }
      };
      if (out.fallback) r.fallback = true;
      return resp(200, r);
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
