// AI-drafted report Summary -- Phase 1 scaffold (deterministic stub).
//
// WHAT THIS IS TODAY: the tech taps "Draft Summary" on an Inspection work
// order and this function composes a plain-English draft of the report's
// Summary section from the report's OWN structured data (checklist ratings +
// notes, findings, work performed, photo captions). The composer below is a
// deterministic template -- same input, same output, no external calls, no
// API key. It exists so the whole flow (button -> auth -> server -> editable
// draft in the Summary textarea) is real and testable before any AI is wired.
//
// WHAT PHASE 2 LOOKS LIKE (NOT BUILT -- blocked on Mark provisioning a key):
// composeTemplateSummary() below is the exact seam. Replace its call in the
// handler with a server-side LLM call (Anthropic Messages API recommended;
// claude-haiku-tier is plenty for a half-page summary and costs well under a
// cent per report) that receives the SAME sanitized `report` object as its
// prompt context. Requirements already decided, do not relitigate them here:
//   * The key lives ONLY in a Netlify environment variable
//     (ANTHROPIC_API_KEY), same handling as RESEND_API_KEY /
//     COMPANYCAM_TOKEN. It is never sent to, stored in, or readable by the
//     client. MARK PROVISIONS THE KEY -- this file must not gain a key, a
//     default, or a fallback provider without his explicit sign-off.
//   * The output stays a DRAFT: this function returns text for the client to
//     put in the (editable) Summary textarea. It never writes to Firestore,
//     never marks anything final, and the normal save/send paths (and their
//     own permission gates) are unchanged. Phase 3 (optional, also not
//     built): pass photo THUMBNAILS for vision grounding.
//   * If the LLM call fails or the key is absent, fall back to this
//     template -- the field flow must never dead-end on a roof.
//
// AUTH: identity-first, same trust boundary as every other function here.
// requirePermission() verifies the Firebase ID token signature and then
// requires doc.generate on the caller's LIVE role doc -- the semantically
// matching gate (drafting summary text IS document generation; every seed
// role that can generate a report PDF holds it, including field_tech).
// Nothing here writes anywhere, so no stronger gate is needed: the draft
// only becomes part of the record through the normal workorder.edit-gated
// save the tech performs afterward.
const { requirePermission } = require("./lib/authGuard");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// ---- Input sanitizing: the client sends a compact projection of the work
// order (see buildSummaryDraftPayload() in js/workorders.js), but the server
// re-clamps everything anyway -- request bodies are attacker-controlled text,
// and in Phase 2 this exact object becomes LLM prompt context, so bounding it
// here (lengths AND row counts) is also the token-cost ceiling. ----
function s(v, max) { return String(v == null ? "" : v).slice(0, max || 300); }
function rows(arr, max, map) {
  return (Array.isArray(arr) ? arr : []).slice(0, max).map(map).filter(Boolean);
}
function sanitizeReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    woType: s(raw.woType, 40),
    jobName: s(raw.jobName, 200),
    location: s(raw.location, 300),
    serviceDate: s(raw.serviceDate, 40),
    technician: s(raw.technician, 120),
    roofSystem: s(raw.roofSystem, 200),
    reportedArea: s(raw.reportedArea, 300),
    warrantable: s(raw.warrantable, 1000),
    nonWarrantable: s(raw.nonWarrantable, 1000),
    inspectionChecklist: rows(raw.inspectionChecklist, 20, function (it) {
      if (!it || typeof it !== "object") return null;
      var label = s(it.label, 60), rating = s(it.rating, 20);
      return (label && rating) ? { label: label, rating: rating, notes: s(it.notes, 500) } : null;
    }),
    findings: rows(raw.findings, 50, function (f) {
      if (!f || typeof f !== "object") return null;
      var condition = s(f.condition, 500), location = s(f.location, 300);
      return (condition || location) ? { condition: condition, location: location, warranty: s(f.warranty, 40) } : null;
    }),
    repairs: rows(raw.repairs, 50, function (r) {
      if (!r || typeof r !== "object") return null;
      var repair = s(r.repair, 500), location = s(r.location, 300);
      return (repair || location) ? { repair: repair, location: location } : null;
    }),
    photoCaptions: rows(raw.photoCaptions, 60, function (c) {
      var t = s(c, 300).trim();
      return t || null;
    }),
    photoCount: Math.max(0, Math.min(500, parseInt(raw.photoCount, 10) || 0))
  };
}

// ---- The Phase-1 composer: deterministic prose from the report's own data.
// Every statement below is a restatement of something the tech entered --
// nothing is inferred, predicted, or recommended, which is exactly why this
// stub's output is safe to leave in a report even unedited. The LLM version
// replaces this function wholesale (see header). ----
function joinList(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return items[0] + " and " + items[1];
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}
function composeTemplateSummary(r) {
  var isInspection = r.woType === "Inspection";
  var typePhrase =
    isInspection ? "a roof inspection" :
    r.woType === "Repair" ? "roof repair work" :
    r.woType === "Warranty" ? "a warranty service visit" :
    "a leak investigation";
  var paras = [];

  // Opening: who / what / where / when, plus the roof system.
  var where = r.jobName ? (" at " + r.jobName + (r.location ? " (" + r.location + ")" : "")) :
    (r.location ? " at " + r.location : "");
  var opener = (r.technician || "Our technician") + " performed " + typePhrase + where +
    (r.serviceDate ? " on " + r.serviceDate : "") + ".";
  if (r.roofSystem) opener += " The roof system is " + r.roofSystem + ".";
  if (!isInspection && r.reportedArea) opener += " The reported problem area was: " + r.reportedArea + ".";
  paras.push(opener);

  // Checklist rollup (Inspection): deficiencies first, wear second, then the
  // clean bill for whatever was rated Good. N/A rows never reach the server
  // (filtered out client-side) and are re-ignored here regardless.
  var cl = (r.inspectionChecklist || []).filter(function (it) { return it.rating !== "N/A"; });
  if (cl.length) {
    var bad = cl.filter(function (it) { return it.rating === "Poor" || it.rating === "Critical"; });
    var fair = cl.filter(function (it) { return it.rating === "Fair"; });
    var good = cl.filter(function (it) { return it.rating === "Good"; });
    var bits = [];
    if (bad.length) {
      bits.push("Deficiencies were noted at " + joinList(bad.map(function (it) {
        return it.label + " (rated " + it.rating + (it.notes ? ": " + it.notes : "") + ")";
      })) + ".");
    }
    if (fair.length) {
      bits.push(joinList(fair.map(function (it) {
        return it.label + (it.notes ? " (" + it.notes + ")" : "");
      })) + " " + (fair.length === 1 ? "was" : "were") + " rated Fair and should be monitored.");
    }
    if (good.length) {
      bits.push((bad.length || fair.length ? "The remaining inspected components — " + joinList(good.map(function (it) { return it.label; })) + " — were" :
        "All inspected components were") + " found in serviceable condition.");
    }
    paras.push(bits.join(" "));
  }

  // Findings: one numbered line per documented condition.
  if ((r.findings || []).length) {
    var fLines = r.findings.map(function (f, i) {
      var line = (i + 1) + ". " + (f.condition || "Condition noted");
      if (f.location) line += " — " + f.location;
      if (!isInspection && f.warranty && f.warranty !== "Undetermined") line += " (" + f.warranty + ")";
      return line;
    });
    paras.push("The following condition" + (r.findings.length === 1 ? " was" : "s were") +
      " documented:\n" + fLines.join("\n"));
  }

  // Work performed during the visit, when any was recorded.
  if ((r.repairs || []).length) {
    paras.push("Work performed during this visit: " + joinList(r.repairs.map(function (rr) {
      return (rr.repair || "repair") + (rr.location ? " (" + rr.location + ")" : "");
    })) + ".");
  }

  // Warranty determination (non-Inspection types only -- the Inspection form
  // deliberately has no warranty-determination card).
  if (!isInspection && (r.warrantable || r.nonWarrantable)) {
    var wd = [];
    if (r.warrantable) wd.push("Warrantable: " + r.warrantable);
    if (r.nonWarrantable) wd.push("Non-warrantable: " + r.nonWarrantable);
    paras.push(wd.join(" "));
  }

  // Closing pointer at the photo record.
  if (r.photoCount > 0) {
    paras.push("The " + (r.photoCount === 1 ? "photo" : r.photoCount + " photos") +
      " in this report document" + (r.photoCount === 1 ? "s" : "") +
      " the conditions described above; refer to the Photo Documentation section for detail.");
  }

  return paras.join("\n\n");
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  try {
    // Identity first, body second -- an unauthenticated caller learns nothing.
    await requirePermission(event, "doc.generate");

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return resp(400, { error: "Bad request" }); }

    if (body.action !== "draft_summary") return resp(400, { error: "Unknown action" });
    const report = sanitizeReport(body.report);
    if (!report) return resp(400, { error: "Missing report" });

    const draft = composeTemplateSummary(report);
    // source/llm flag the draft's provenance for the client (and for anyone
    // reading a network trace later): template_stub_v1 = the deterministic
    // Phase-1 composer, no AI involved. The Phase-2 LLM path will report
    // source:"llm" + llm:true so the UI can label the two differently.
    return resp(200, { ok: true, draft: draft, source: "template_stub_v1", llm: false });
  } catch (e) {
    if (e.statusCode === 401) return resp(401, { error: "Unauthorized" });
    if (e.statusCode === 403) return resp(403, { error: "Forbidden" });
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};

// Exported for tests only (tests/generateSummaryDraft.test.js) -- Netlify
// itself only ever calls exports.handler.
exports.composeTemplateSummary = composeTemplateSummary;
exports.sanitizeReport = sanitizeReport;
