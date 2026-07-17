// AI-drafted report Summary -- shared scaffold (deterministic stub, no AI
// key). ONE function serves all three report types that carry a Summary:
// Inspection, Leak / Service, and Work Order (stored type "Repair") -- each
// sends its own findings/checklist/repair-scope/photos through the same
// payload shape and gets a draft back for the SAME editable #summary box.
//
// WHAT THIS IS TODAY: the tech taps "Draft Summary" and this composes a
// plain-English draft from the report's OWN structured data (checklist
// ratings + notes, findings, repair scope + items, work performed, photo
// captions). The composer below is a deterministic template -- same input,
// same output, no external calls, no API key. It exists so the whole flow
// (button -> auth -> server -> editable draft) is real and testable before
// any AI is wired.
//
// PHASE 1 = LLM WITH PHOTO VISION -- NOW WIRED, through the shared provider
// seam (lib/aiProvider.js, PR #122). Mark provisioned ANTHROPIC_API_KEY on
// the DEV deploy context (2026-07-16); production's context deliberately has
// no key, so prod resolves to the stub until a promotion Mark chooses.
// Mark's requirement: the model actually LOOKS AT the photos, not just the
// written findings. How a draft is produced:
//   * resolveProvider(process.env) decides stub vs live -- purely from which
//     env vars exist on THIS deploy context. No key -> deterministic
//     template below, byte-identical to the pre-wiring behavior.
//   * Live path: collectSignedPhotoUrls() turns the payload's Storage refs
//     into SHORT-LIVED V4 SIGNED READ URLS (SIGNED_URL_TTL_MS) which ride to
//     the vision model as image blocks. Signed URLs ONLY -- no photo is ever
//     made public, no bucket ACL changes, and the stub path never signs
//     anything (URLs are minted only when a live call consumes them).
//   * buildLlmPrompt(report) supplies the feature-tuned system prompt: the
//     length target in ONE constant (SUMMARY_TARGET_WORDS -- Mark liked his
//     ChatGPT Flat Branch Pub summary but called it "a little long", so we
//     target tighter) and his exact Flat Branch text drops into
//     STYLE_EXEMPLAR verbatim when the relay supplies it.
//   * Cost control is the BUTTON: drafts fire on demand only, never
//     automatically on save/open. aiProvider caps photos at 8 per call.
// Requirements already decided, do not relitigate here:
//   * The key lives ONLY in a Netlify environment variable
//     (ANTHROPIC_API_KEY), same handling as RESEND_API_KEY /
//     COMPANYCAM_TOKEN. It is never sent to, stored in, or readable by the
//     client. This file must never gain a key, a default, or a new provider
//     without Mark's explicit sign-off.
//   * The output stays a DRAFT: this function returns text for the client to
//     put in the (editable) Summary textarea. It never writes to Firestore,
//     never marks anything final, and the normal save/send paths (and their
//     own permission gates) are unchanged.
//   * If the LLM call fails or the key is absent, the template below answers
//     instead (flagged fallback) -- the field flow must never dead-end on a
//     roof.
//
// AUTH: identity-first, same trust boundary as every other function here.
// requirePermission() verifies the Firebase ID token signature and then
// requires doc.generate on the caller's LIVE role doc -- the semantically
// matching gate (drafting summary text IS document generation; every seed
// role that can generate a report PDF holds it, including field_tech).
// Nothing here writes anywhere, so no stronger gate is needed: the draft
// only becomes part of the record through the normal workorder.edit-gated
// save the tech performs afterward.
const { requirePermission, getAdmin, hostnameFromEvent } = require("./lib/authGuard");
const { resolveProvider, generateSummary } = require("./lib/aiProvider");

// ---- Length/style tuning knobs for the Phase-1 LLM prompt. Mark's verdict
// on his ChatGPT Flat Branch Pub summary: right voice, "a little long" --
// so the word target sits deliberately under a full ChatGPT-style page.
// Tune HERE, nowhere else. ----
const SUMMARY_TARGET_WORDS = 160;
const SUMMARY_MAX_PARAGRAPHS = 3;
// Mark's Flat Branch Pub summary text goes here VERBATIM when the relay
// supplies it -- the prompt then says "this voice, but tighter" instead of
// describing the voice abstractly. null until then (prompt degrades to the
// generic professional-voice instruction).
const STYLE_EXEMPLAR = null;
// Signed photo URLs live just long enough for one model call to fetch them.
const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

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
// A photo Storage ref may be passed through to a signed READ url on the
// Phase-1 LLM path, so it is validated hard: our own workorders/ prefix
// only, no traversal, sane length. Anything else becomes null (caption may
// still be useful) -- never an error, never a signable path.
function cleanStorageRef(v) {
  var ref = s(v, 300);
  if (!ref || ref.indexOf("workorders/") !== 0 || ref.indexOf("..") !== -1) return null;
  return ref;
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
    repairDescription: s(raw.repairDescription, 2000),
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
    repairItems: rows(raw.repairItems, 50, function (it) {
      if (!it || typeof it !== "object") return null;
      var type = s(it.type, 120), notes = s(it.notes, 500);
      return (type || notes) ? { type: type, qty: s(it.qty, 20), notes: notes } : null;
    }),
    photos: rows(raw.photos, 60, function (p) {
      if (!p || typeof p !== "object") return null;
      var caption = s(p.caption, 300).trim();
      var storageRef = cleanStorageRef(p.storageRef);
      return (caption || storageRef) ? { caption: caption, storageRef: storageRef } : null;
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

  // Repair scope (Work Order type): the tech's own scope description first,
  // then the itemized repair list.
  if (r.repairDescription) {
    paras.push("Scope of work: " + r.repairDescription);
  }
  if ((r.repairItems || []).length) {
    paras.push("Itemized work: " + joinList(r.repairItems.map(function (it) {
      var t = it.type || "item";
      if (it.qty) t += " (qty " + it.qty + ")";
      if (it.notes) t += " — " + it.notes;
      return t;
    })) + ".");
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

// ---- The feature-tuned SYSTEM prompt, passed to aiProvider's
// generateSummary() as opts.system (the report JSON + photo image blocks are
// the provider seam's job -- see lib/aiProvider.js). Returns the system
// string only. ----
function buildLlmPrompt(r) {
  var style = STYLE_EXEMPLAR
    ? "Match the voice of this example summary, but run tighter and more concise than it:\n---\n" + STYLE_EXEMPLAR + "\n---"
    : "Write in a professional commercial-roofing service-report voice addressed to the building's customer.";
  return "You draft the Summary section of a commercial roofing report. " +
    "Use ONLY the report data and the attached photos -- never invent conditions, causes, " +
    "measurements, or recommendations that they do not support. Where a photo shows a condition, " +
    "ground the description in what is visible. " + style + " " +
    "Target about " + SUMMARY_TARGET_WORDS + " words in at most " + SUMMARY_MAX_PARAGRAPHS + " short paragraphs, covering: " +
    "what was done on site, the key findings/conditions, and recommended next actions. " +
    "Plain text only, no headings or markdown. This is a DRAFT a technician will review and edit before it is sent.";
}

// ---- Phase-1 seam: photo access for the vision model. Turns the sanitized
// payload's Storage refs into SHORT-LIVED V4 signed READ urls. Signed urls
// only, never public: no ACL is touched, the url self-expires
// (SIGNED_URL_TTL_MS), and a ref that fails validation or signing is simply
// skipped (the model degrades to captions for that photo -- a draft must
// never dead-end on one bad photo). NOT called on the stub path: urls are
// minted only when there is an LLM call to consume them, so no live url
// ever exists without a purpose. ----
async function collectSignedPhotoUrls(bucket, photos, ttlMs) {
  var out = [];
  for (var i = 0; i < (photos || []).length; i++) {
    var p = photos[i];
    var ref = p && cleanStorageRef(p.storageRef);
    if (!ref) continue;
    try {
      var signed = await bucket.file(ref).getSignedUrl({
        version: "v4", action: "read", expires: Date.now() + (ttlMs || SIGNED_URL_TTL_MS)
      });
      out.push({ caption: (p.caption || ""), url: signed[0] });
    } catch (e) { /* skip: unsignable photo -> captions-only for this one */ }
  }
  return out;
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

    // Stub vs live is decided by which env vars exist on THIS deploy context
    // (dev holds ANTHROPIC_API_KEY; production deliberately doesn't yet).
    // Signed photo URLs are minted ONLY when a live model will consume them
    // -- the stub path must never create a live URL with no purpose.
    const provider = resolveProvider(process.env);
    let photoUrls = [];
    if (provider.name !== "stub" && (report.photos || []).some(function (p) { return p.storageRef; })) {
      try {
        const bucket = getAdmin(hostnameFromEvent(event)).storage().bucket();
        photoUrls = (await collectSignedPhotoUrls(bucket, report.photos)).map(function (p) { return p.url; });
      } catch (e) { /* vision degrades to text-only; a draft must never dead-end on Storage */ }
    }

    const result = await generateSummary(
      { report: report, photoUrls: photoUrls },
      { stubText: composeTemplateSummary(report), system: buildLlmPrompt(report) }
    );

    // Provenance for the client (and anyone reading a network trace later):
    // source "template_stub_v1" = the deterministic composer answered (no
    // key, or provider failure -> fallback:true); otherwise the provider
    // name + model that actually wrote the draft. Always a draft either way.
    return resp(200, {
      ok: true,
      draft: result.text,
      source: result.llm ? result.provider : "template_stub_v1",
      llm: !!result.llm,
      model: result.model || null,
      fallback: !!result.fallback,
      photosSeen: result.llm ? photoUrls.length : 0
    });
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
exports.buildLlmPrompt = buildLlmPrompt;
exports.collectSignedPhotoUrls = collectSignedPhotoUrls;
exports.SUMMARY_TARGET_WORDS = SUMMARY_TARGET_WORDS;
exports.SIGNED_URL_TTL_MS = SIGNED_URL_TTL_MS;
