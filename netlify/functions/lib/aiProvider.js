// Shared, provider-agnostic server-side AI inference core for RoofOps.
//
// This is the ONE place AI provider plumbing lives. Two features build on it:
//   (a) SUMMARY  -- AI-drafted report Summary (generate-summary.js / PR #119's
//                   Phase 2 swaps its composer seam for generateSummary() here)
//   (b) ISSUE-ID -- leak-photo issue identification (future UI builds against
//                   identifyIssue() via netlify/functions/ai-service.js)
//
// DESIGN RULES (decided up front, do not relitigate here):
//   * NO API KEY IS PROVISIONED YET. Mark provisions ANTHROPIC_API_KEY (or
//     OPENAI_API_KEY) as a Netlify env var later. Until a key exists in env,
//     every call below resolves to the deterministic STUB provider -- same
//     input, same output, zero network calls. The whole flow stays testable
//     without a key, and nothing in this file may gain a default key, an
//     embedded key, or a new fallback provider without Mark's sign-off.
//   * Provider-agnostic on purpose: the switch reads env and can talk to
//     Anthropic (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY) over plain
//     fetch -- no SDK dependency for a code path that can't run yet.
//     Precedence: AI_PROVIDER env forces a provider; otherwise Anthropic
//     wins when both keys exist. AI_MODEL / ANTHROPIC_MODEL / OPENAI_MODEL
//     override the per-provider default model.
//   * Vision inputs are SIGNED URLs (Firebase Storage tokens, GCS/S3
//     signature params -- isSignedPhotoUrl() is the gate) or SERVER-READ
//     inline base64 blocks (cleanInlineImage() is the gate). Never a public
//     URL. Inline base64 exists because the dev Firebase project has no
//     Storage bucket (Spark plan) -- its photos live as data-URLs on the
//     Firestore photo docs, so there is nothing to sign; passing the bytes
//     as an in-request image block exposes strictly LESS than a signed URL
//     (no fetchable URL ever exists). The bytes come from the server's own
//     Firestore read (generate-summary.js), never from the client request.
//   * Every result is a DRAFT for human confirmation. Nothing here writes to
//     Firestore or marks anything final; callers put the output in front of a
//     person. The `draft: true` in ai-service.js's response is a contract
//     invariant, not decoration.
//   * Cost-control friendly: on-demand only (no polling, no batching), input
//     clamps in the callers are the token ceiling, and MAX_TOKENS below caps
//     each response. If the provider call fails the stub answers instead
//     (flagged `fallback: true`) -- a roof-side flow must never dead-end on
//     an AI outage.
//
// The request/response CONTRACT is documented on ai-service.js (the HTTP
// surface). This file's exports are the server-side seam other functions use
// directly.

const MAX_SUMMARY_TOKENS = 1000; // ~ half-page draft
const MAX_ISSUE_TOKENS = 400;    // small JSON object + short rationale

// Vision budget PER CALL, shared across both input kinds (signed URLs are
// taken first, inline base64 fills what's left) -- this cap is the image
// token-cost ceiling the same way the text clamps are the prompt ceiling.
const MAX_VISION_PHOTOS = 8;
// Inline base64 gates: the media types Anthropic/OpenAI vision accept, and a
// per-image size cap under the providers' ~5MB image limit (chars of base64,
// so ~3.7MB decoded). Anything outside these is dropped, never an error --
// the draft degrades to that photo's caption.
const INLINE_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_INLINE_IMAGE_B64_CHARS = 5 * 1024 * 1024;

// Default models. Anthropic default follows current guidance (Opus 4.8);
// Mark can dial cost down via ANTHROPIC_MODEL / AI_MODEL when he provisions
// the key -- model choice is env config, not a code change.
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
const DEFAULT_OPENAI_MODEL = "gpt-4o";

// ---- Controlled vocabulary for ISSUE-ID -----------------------------------
// The issue-ID feature returns { issue, likelyCause, confidence } drawn ONLY
// from these lists. The LLM is instructed to pick from them, and
// clampIssueResult() re-enforces it server-side regardless of what the model
// actually said -- an out-of-vocab value degrades to the "indeterminate"
// bucket rather than leaking free text into a structured field.
//
// PARITY CONTRACT (vocab convergence, PR #122/#123 coordination): these keys
// are the canonical AI_ISSUE_LABELS keys from js/ailabels.js -- what the
// model answers with is exactly what a tech's confirmation stores in
// ai_training_labels, no mapping table anywhere. This list must stay a
// SUBSET of AI_ISSUE_LABELS (browser/CommonJS split means hand-sync, same
// discipline as getBuildingRoofsServer(); the parity test in
// tests/aiLabels.test.js fails the suite if the two drift). The original
// clogged_drain_or_scupper key is split into drain_clogged/scupper_blocked
// to match -- a photo usually shows which one it is, and the split is a
// richer training signal.
const ISSUE_VOCABULARY = [
  "puncture",
  "open_seam",
  "flashing_failed",
  "ponding_water",
  "drain_clogged",
  "scupper_blocked",
  "penetration_seal_failed",
  "sealant_deteriorated",
  "pitch_pan_deteriorated",
  "coping_failure",
  "blister",
  "hail_damage",
  "wind_uplift",
  "no_defect_found",
  "indeterminate"
];
const CAUSE_VOCABULARY = [
  "weathering_age",
  "mechanical_damage",
  "foot_traffic",
  "storm_event",
  "installation_defect",
  "debris_accumulation",
  "thermal_movement",
  "drainage_deficiency",
  "previous_repair_failure",
  "unconfirmed"
];
const CONFIDENCE_LEVELS = ["low", "medium", "high"];

// ---- Provider resolution ---------------------------------------------------
// Pure function of an env object (pass process.env in real handlers, a plain
// object in tests). Returns { name, apiKey, model }; name === "stub" is the
// no-key deterministic mode.
function resolveProvider(env) {
  env = env || {};
  const stub = { name: "stub", apiKey: null, model: null };
  const forced = String(env.AI_PROVIDER || "").toLowerCase().trim();
  if (forced === "stub") return stub;
  if (forced === "anthropic") {
    return env.ANTHROPIC_API_KEY ? anthropicProvider(env) : stub;
  }
  if (forced === "openai") {
    return env.OPENAI_API_KEY ? openaiProvider(env) : stub;
  }
  // No forced provider: Anthropic first, then OpenAI, then stub.
  if (env.ANTHROPIC_API_KEY) return anthropicProvider(env);
  if (env.OPENAI_API_KEY) return openaiProvider(env);
  return stub;
}
function anthropicProvider(env) {
  return {
    name: "anthropic",
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL || env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL
  };
}
function openaiProvider(env) {
  return {
    name: "openai",
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || env.AI_MODEL || DEFAULT_OPENAI_MODEL
  };
}

// ---- Signed-URL gate --------------------------------------------------------
// "Signed URLs only, never public": require https AND a recognizable
// signature/token query parameter. Covers Firebase Storage download tokens
// (`token=`), GCS V4/V2 signed URLs (`X-Goog-Signature=` / `Signature=`),
// S3 presigned (`X-Amz-Signature=`) and Azure SAS (`sig=`). A bare public
// URL fails this check by construction -- exactly the point.
const SIGNATURE_PARAMS = ["token", "x-goog-signature", "signature", "x-amz-signature", "sig"];
function isSignedPhotoUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); }
  catch (e) { return false; }
  if (parsed.protocol !== "https:") return false;
  for (const key of parsed.searchParams.keys()) {
    if (SIGNATURE_PARAMS.indexOf(key.toLowerCase()) !== -1) return true;
  }
  return false;
}

// ---- Inline-image gate --------------------------------------------------------
// The base64 counterpart of isSignedPhotoUrl(): an inline photo enters a
// prompt only as { mediaType, data } that passes ALL of these -- an accepted
// image media type, base64-charset-only payload, bounded size. Anything else
// returns null and the photo simply doesn't ride. The charset check also
// means nothing here can smuggle text/JSON into what the model is told is an
// image.
function cleanInlineImage(p) {
  if (!p || typeof p !== "object") return null;
  const mediaType = String(p.mediaType || "");
  const data = typeof p.data === "string" ? p.data : "";
  if (INLINE_IMAGE_MEDIA_TYPES.indexOf(mediaType) === -1) return null;
  if (!data || data.length > MAX_INLINE_IMAGE_B64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return { mediaType: mediaType, data: data };
}

// ---- Shared input clamps ----------------------------------------------------
// Request bodies are attacker-controlled text, and everything sanitized here
// becomes LLM prompt context once a key exists -- so these bounds are both
// the security clamp and the token-cost ceiling. sanitizeReport() is the ONE
// server-side clamp for the projection buildSummaryDraftPayload()
// (js/workorders.js) sends -- structured text, each photo's caption AND
// Storage ref, and the work-order id. The ref and the id exist ONLY so
// generate-summary.js can fetch pixels server-side (signed READ url / inline
// Firestore read); generateSummary() below strips BOTH out of prompt text.
// Never photo bytes, pins, GPS, per-row ids, or signatures.
// generate-summary.js requires this function (and re-exports it for its
// tests) -- its local copy moved here after the post-#119 cross-review
// caught the two sanitizers drifting apart.
function s(v, max) { return String(v == null ? "" : v).slice(0, max || 300); }
function rows(arr, max, map) {
  return (Array.isArray(arr) ? arr : []).slice(0, max).map(map).filter(Boolean);
}
// A photo Storage ref may be passed through to a signed READ url on the
// vision path, so it is validated hard: our own workorders/ prefix only, no
// traversal, sane length. Anything else becomes null (caption may still be
// useful) -- never an error, never a signable path.
function cleanStorageRef(v) {
  const ref = s(v, 300);
  if (!ref || ref.indexOf("workorders/") !== 0 || ref.indexOf("..") !== -1) return null;
  return ref;
}
// The work-order id is the server's handle for reading INLINE photo bytes
// back out of Firestore itself (Phase 1.5) -- it becomes a Firestore doc
// path, so it is id-shaped or it is nothing.
function cleanWorkOrderId(v) {
  const id = s(v, 80);
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}
function sanitizeReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    workOrderId: cleanWorkOrderId(raw.workOrderId),
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
      const label = s(it.label, 60), rating = s(it.rating, 20);
      return (label && rating) ? { label: label, rating: rating, notes: s(it.notes, 500) } : null;
    }),
    findings: rows(raw.findings, 50, function (f) {
      if (!f || typeof f !== "object") return null;
      const condition = s(f.condition, 500), location = s(f.location, 300);
      return (condition || location) ? { condition: condition, location: location, warranty: s(f.warranty, 40) } : null;
    }),
    repairs: rows(raw.repairs, 50, function (r) {
      if (!r || typeof r !== "object") return null;
      const repair = s(r.repair, 500), location = s(r.location, 300);
      return (repair || location) ? { repair: repair, location: location } : null;
    }),
    repairItems: rows(raw.repairItems, 50, function (it) {
      if (!it || typeof it !== "object") return null;
      const type = s(it.type, 120), notes = s(it.notes, 500);
      return (type || notes) ? { type: type, qty: s(it.qty, 20), notes: notes } : null;
    }),
    photos: rows(raw.photos, 60, function (p) {
      if (!p || typeof p !== "object") return null;
      const caption = s(p.caption, 300).trim();
      const storageRef = cleanStorageRef(p.storageRef);
      return (caption || storageRef) ? { caption: caption, storageRef: storageRef } : null;
    }),
    photoCount: Math.max(0, Math.min(500, parseInt(raw.photoCount, 10) || 0))
  };
}
// Issue-ID context: the small structured hints that ride alongside the photo.
function sanitizeIssueContext(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  return {
    woType: s(raw.woType, 40),
    jobName: s(raw.jobName, 200),
    roofSystem: s(raw.roofSystem, 200),
    reportedArea: s(raw.reportedArea, 300),
    notes: s(raw.notes, 1000)
  };
}

// ---- Deterministic stubs (the no-key mode) ---------------------------------
// These are clearly-marked placeholders: same input -> byte-identical output,
// no inference, no network. They exist so the ENTIRE flow (auth -> HTTP ->
// contract -> UI) is real and testable before Mark provisions a key.
const STUB_MARKER = "[DRAFT — deterministic placeholder: no AI key configured]";

function composeStubSummary(report) {
  const lines = [STUB_MARKER, ""];
  const head = [];
  if (report.woType) head.push(report.woType + " report");
  if (report.jobName) head.push("for " + report.jobName);
  if (report.serviceDate) head.push("on " + report.serviceDate);
  lines.push((head.length ? head.join(" ") : "Service report") + ".");
  if (report.roofSystem) lines.push("Roof system: " + report.roofSystem + ".");
  const cl = report.inspectionChecklist || [];
  const flagged = cl.filter(function (it) { return it.rating === "Poor" || it.rating === "Critical" || it.rating === "Fair"; });
  if (cl.length) {
    lines.push(cl.length + " checklist item" + (cl.length === 1 ? "" : "s") + " recorded" +
      (flagged.length ? " (" + flagged.length + " flagged Fair or worse)" : "") + ".");
  }
  if ((report.findings || []).length) lines.push((report.findings.length) + " documented condition" + (report.findings.length === 1 ? "" : "s") + ".");
  if ((report.repairs || []).length) lines.push((report.repairs.length) + " repair" + (report.repairs.length === 1 ? "" : "s") + " performed this visit.");
  if (report.photoCount > 0) lines.push(report.photoCount + " photo" + (report.photoCount === 1 ? "" : "s") + " on file.");
  lines.push("");
  lines.push("(This placeholder restates counts only. Once an AI key is configured, a full draft is generated from the same data — always for your review before saving.)");
  return lines.join("\n");
}

// Keyword table for the stub issue-ID: a deterministic first-match scan over
// the caller's own context text. Order matters and is fixed -- more specific
// phrases before generic ones. Confidence is ALWAYS "low": the stub never saw
// the photo, and pretending otherwise would poison the human-confirmation UX.
const STUB_ISSUE_KEYWORDS = [
  { re: /pitch\s*(pan|pocket)/i, issue: "pitch_pan_deteriorated", cause: "weathering_age" },
  { re: /ponding|standing water/i, issue: "ponding_water", cause: "drainage_deficiency" },
  { re: /scupper/i, issue: "scupper_blocked", cause: "debris_accumulation" },
  { re: /drain|clog/i, issue: "drain_clogged", cause: "debris_accumulation" },
  { re: /puncture|tear|hole|gouge/i, issue: "puncture", cause: "mechanical_damage" },
  { re: /seam|lap/i, issue: "open_seam", cause: "weathering_age" },
  { re: /flashing|counterflash/i, issue: "flashing_failed", cause: "weathering_age" },
  { re: /coping|edge metal|drip edge/i, issue: "coping_failure", cause: "weathering_age" },
  { re: /sealant|caulk|mastic/i, issue: "sealant_deteriorated", cause: "weathering_age" },
  { re: /penetration|pipe boot|curb|hvac/i, issue: "penetration_seal_failed", cause: "weathering_age" },
  { re: /blister/i, issue: "blister", cause: "thermal_movement" },
  { re: /hail/i, issue: "hail_damage", cause: "storm_event" },
  { re: /wind|blow[- ]?off|uplift/i, issue: "wind_uplift", cause: "storm_event" }
];
function composeStubIssue(context) {
  const text = [context.reportedArea, context.notes].join(" ");
  for (const row of STUB_ISSUE_KEYWORDS) {
    if (row.re.test(text)) {
      return {
        issue: row.issue,
        likelyCause: row.cause,
        confidence: "low",
        rationale: "Placeholder match on the reported description — the photo was not analyzed (no AI key configured). Confirm on site."
      };
    }
  }
  return {
    issue: "indeterminate",
    likelyCause: "unconfirmed",
    confidence: "low",
    rationale: "Placeholder — the photo was not analyzed (no AI key configured). Confirm on site."
  };
}

// ---- Prompts ----------------------------------------------------------------
const SUMMARY_SYSTEM =
  "You draft the Summary section of a commercial roofing service report for Watkins Roofing. " +
  "Write 1-3 short paragraphs of plain professional prose. Restate ONLY what the provided report data " +
  "and photos document — never infer conditions that are not shown, never recommend work that is not listed, " +
  "never estimate costs. If photos are provided, you may describe visible roof conditions they corroborate. " +
  "Your output is a DRAFT a human technician will review and edit before anything is saved or sent. " +
  "Output plain text only — no markdown, no headings, no preamble.";

function buildIssueSystem() {
  return "You identify the roofing issue visible in a single jobsite leak photo. " +
    "Respond with ONLY a JSON object, no other text, of the shape " +
    '{"issue": string, "likelyCause": string, "confidence": string, "rationale": string}. ' +
    '"issue" MUST be one of: ' + ISSUE_VOCABULARY.join(", ") + ". " +
    '"likelyCause" MUST be one of: ' + CAUSE_VOCABULARY.join(", ") + ". " +
    '"confidence" MUST be one of: ' + CONFIDENCE_LEVELS.join(", ") + ". " +
    '"rationale" is at most two short sentences grounded in what the photo shows. ' +
    'If the photo clearly shows a roof with no defect, use "no_defect_found" with cause "unconfirmed". ' +
    'If you cannot tell from this photo, use "indeterminate" with cause "unconfirmed" and confidence "low". ' +
    "Your answer is a DRAFT for human confirmation.";
}

// ---- Provider HTTP calls ----------------------------------------------------
// Raw fetch on purpose (see header): two providers behind one seam, no SDK
// dependency for a path that cannot run until a key exists. `parts` is a
// provider-neutral content list: {kind:"image", url}, {kind:"image_b64",
// mediaType, data}, and {kind:"text", text}.
async function callAnthropic(provider, system, parts, maxTokens) {
  const content = parts.map(function (p) {
    if (p.kind === "image") return { type: "image", source: { type: "url", url: p.url } };
    if (p.kind === "image_b64") return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };
    return { type: "text", text: p.text };
  });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: "user", content: content }]
    })
  });
  if (!res.ok) {
    // Carry the provider's own words: Anthropic's error bodies name the
    // exact problem ("invalid x-api-key", "model not found", credit
    // exhaustion) and this message is what the caller's fallback surfaces
    // for diagnosis. Body only, truncated -- never the request (the key
    // lives in the request headers).
    const detail = await res.text().catch(function () { return ""; });
    throw new Error("Anthropic API error " + res.status + (detail ? ": " + detail.slice(0, 300) : ""));
  }
  const json = await res.json();
  const block = (json.content || []).find(function (b) { return b.type === "text"; });
  if (!block || !block.text) throw new Error("Anthropic API returned no text");
  return block.text;
}

async function callOpenAI(provider, system, parts, maxTokens) {
  const content = parts.map(function (p) {
    if (p.kind === "image") return { type: "image_url", image_url: { url: p.url } };
    // OpenAI has no separate base64 shape -- an image_url carrying a data-URL
    // is its inline form.
    if (p.kind === "image_b64") return { type: "image_url", image_url: { url: "data:" + p.mediaType + ";base64," + p.data } };
    return { type: "text", text: p.text };
  });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + provider.apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: content }
      ]
    })
  });
  if (!res.ok) {
    // Same as callAnthropic: the provider's error body is the diagnosis.
    const detail = await res.text().catch(function () { return ""; });
    throw new Error("OpenAI API error " + res.status + (detail ? ": " + detail.slice(0, 300) : ""));
  }
  const json = await res.json();
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) throw new Error("OpenAI API returned no text");
  return text;
}

function callProvider(provider, system, parts, maxTokens) {
  if (provider.name === "anthropic") return callAnthropic(provider, system, parts, maxTokens);
  if (provider.name === "openai") return callOpenAI(provider, system, parts, maxTokens);
  throw new Error("Unknown provider: " + provider.name);
}

// ---- Output clamping --------------------------------------------------------
// Models are asked for bare JSON but sometimes wrap it in prose; take the
// first {...} span. Then clamp every field to the controlled vocabulary --
// the structured contract holds no matter what the model emitted.
function extractJson(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
function clampIssueResult(raw) {
  const obj = (raw && typeof raw === "object") ? raw : {};
  return {
    issue: ISSUE_VOCABULARY.indexOf(obj.issue) !== -1 ? obj.issue : "indeterminate",
    likelyCause: CAUSE_VOCABULARY.indexOf(obj.likelyCause) !== -1 ? obj.likelyCause : "unconfirmed",
    confidence: CONFIDENCE_LEVELS.indexOf(obj.confidence) !== -1 ? obj.confidence : "low",
    rationale: s(obj.rationale, 500)
  };
}

// ---- Public capabilities ----------------------------------------------------
// Both return { ..., provider, model, llm, fallback? }:
//   provider  "stub" | "anthropic" | "openai" -- what actually answered
//   model     model id when llm, else null
//   llm       true only when a real model produced the result
//   fallback  true when a key WAS configured but the provider call failed and
//             the stub answered instead (field flows must not dead-end)

// (a) SUMMARY: structured report findings + photos (signed URLs and/or
//     server-read inline base64 images) -> draft text. Signed URLs take the
//     MAX_VISION_PHOTOS budget first; inline images fill what's left.
//     input.photoImages  [{mediaType, data}] -- each re-gated by
//                        cleanInlineImage() here regardless of caller.
//     opts.env      env object (default process.env)
//     opts.stubText caller-supplied deterministic composer output to use as
//                   the stub/fallback text -- this is how generate-summary.js
//                   (PR #119) plugs its richer composeTemplateSummary() in as
//                   the no-key placeholder while sharing this provider seam.
//     opts.system   caller-supplied system prompt override -- how
//                   generate-summary.js supplies its feature-tuned prompt
//                   (SUMMARY_TARGET_WORDS length dial + Mark's STYLE_EXEMPLAR
//                   voice sample). Default stays this file's generic
//                   SUMMARY_SYSTEM so other callers are unaffected.
// Returns photosUsed: how many images the model call actually consumed
// (0 on the stub/fallback paths) -- the ONLY number a caller may surface as
// "photos reviewed" (#144's toast). Post-#119 cross-review REQUIRED fix:
// callers must not count what they minted/collected, only what rode.
async function generateSummary(input, opts) {
  opts = opts || {};
  const report = input.report;
  const photoUrls = (input.photoUrls || []).filter(isSignedPhotoUrl).slice(0, MAX_VISION_PHOTOS);
  const photoImages = rows(input.photoImages, Math.max(0, MAX_VISION_PHOTOS - photoUrls.length), cleanInlineImage);
  const provider = resolveProvider(opts.env || process.env);
  const stubText = opts.stubText || composeStubSummary(report);
  const system = opts.system || SUMMARY_SYSTEM;

  if (provider.name === "stub") {
    return { text: stubText, provider: "stub", model: null, llm: false, photosUsed: 0 };
  }
  try {
    const parts = photoUrls.map(function (u) { return { kind: "image", url: u }; });
    photoImages.forEach(function (im) { parts.push({ kind: "image_b64", mediaType: im.mediaType, data: im.data }); });
    parts.push({
      kind: "text",
      text: "Draft the Summary for this report. Report data (JSON):\n" + JSON.stringify(promptProjection(report))
    });
    const text = await callProvider(provider, system, parts, MAX_SUMMARY_TOKENS);
    return { text: String(text).slice(0, 8000), provider: provider.name, model: provider.model, llm: true, photosUsed: photoUrls.length + photoImages.length };
  } catch (e) {
    // Netlify function logs get the full story; the caller gets a truncated
    // detail to surface for diagnosis (safe: it is the provider's RESPONSE
    // body -- the key travels only in request headers and is never echoed).
    console.error("generateSummary provider call failed:", e && e.message);
    return {
      text: stubText, provider: "stub", model: null, llm: false, fallback: true,
      photosUsed: 0,
      errorDetail: String((e && e.message) || "unknown error").slice(0, 300)
    };
  }
}

// What the MODEL sees as text context. The work-order id and each photo's
// Storage ref exist ONLY so generate-summary.js can fetch pixels server-side
// -- they are internal identifiers/paths and never belong in prompt text
// (post-#119 cross-review REQUIRED fix). Photos reduce to their captions;
// the pixels themselves ride alongside as image blocks.
function promptProjection(report) {
  if (!report || typeof report !== "object") return report;
  const out = Object.assign({}, report);
  delete out.workOrderId;
  if (Array.isArray(report.photos)) {
    out.photoCaptions = report.photos.map(function (p) { return p && p.caption; }).filter(Boolean);
    delete out.photos;
  }
  return out;
}

// (b) ISSUE-ID: one signed leak-photo URL + context -> structured
//     { issue, likelyCause, confidence, rationale } from the controlled vocab.
async function identifyIssue(input, opts) {
  opts = opts || {};
  const context = sanitizeIssueContext(input.context);
  const provider = resolveProvider(opts.env || process.env);

  if (provider.name === "stub") {
    return Object.assign(composeStubIssue(context), { provider: "stub", model: null, llm: false });
  }
  if (!isSignedPhotoUrl(input.photoUrl)) {
    // Callers (ai-service.js) validate this first and 400; re-checked here so
    // no future caller can slip an unsigned/public URL into a prompt.
    throw new Error("identifyIssue requires a signed https photo URL");
  }
  try {
    const parts = [
      { kind: "image", url: input.photoUrl },
      { kind: "text", text: "Identify the issue in this leak photo. Context (JSON):\n" + JSON.stringify(context) }
    ];
    const text = await callProvider(provider, buildIssueSystem(), parts, MAX_ISSUE_TOKENS);
    const result = clampIssueResult(extractJson(text));
    return Object.assign(result, { provider: provider.name, model: provider.model, llm: true });
  } catch (e) {
    return Object.assign(composeStubIssue(context), { provider: "stub", model: null, llm: false, fallback: true });
  }
}

// (c) SCOPE DRAFT: proposal text + light job context -> a plain-text scope of
//     work draft for a service manager to confirm/edit. Text-only (no photos):
//     the source is a proposal's words, not pixels — PDF-pixel/vision extraction
//     is a flagged follow-up. Same stub-until-keyed contract as the others:
//     no key -> deterministic composeStubScope (zero external calls); a key ->
//     the model drafts, with fallback to the stub if the call fails. Returns
//     { text, provider, model, llm, fallback? } like the others.
const MAX_SCOPE_TOKENS = 700;
const SCOPE_SYSTEM =
  "You are a commercial roofing service manager drafting the SCOPE OF WORK for a work order from a proposal. " +
  "Use ONLY what the proposal text and the provided context state — never invent quantities, prices, materials, " +
  "or work the proposal does not describe. Write a concise, plain-text scope a crew can act on: what to do and " +
  "where. No markdown, no headings, no preamble, no pricing, no disclaimer. This is a DRAFT the service manager " +
  "will review and edit before it becomes the work order.";
function sanitizeProposalText(raw) { return s(raw, 6000); }
function composeStubScope(proposalText, context) {
  const jn = (context && context.jobName) ? s(context.jobName, 200) : "the site";
  const loc = (context && context.location) ? (" at " + s(context.location, 200)) : "";
  const body = s(proposalText, 1500).replace(/\s+/g, " ").trim();
  const head = "Scope of work for " + jn + loc + " (draft from proposal):\n";
  return body ? (head + body) : (head + "Review the proposal and enter the scope of work.");
}
async function draftScope(input, opts) {
  opts = opts || {};
  const text = sanitizeProposalText(input && input.proposalText);
  const context = {
    jobName: s(input && input.context && input.context.jobName, 200),
    location: s(input && input.context && input.context.location, 200),
  };
  const provider = resolveProvider(opts.env || process.env);
  const stub = composeStubScope(text, context);
  if (provider.name === "stub") return { text: stub, provider: "stub", model: null, llm: false };
  try {
    const parts = [{ kind: "text", text: "Draft the scope of work.\nContext (JSON): " + JSON.stringify(context) + "\nProposal text:\n" + text }];
    const out = await callProvider(provider, SCOPE_SYSTEM, parts, MAX_SCOPE_TOKENS);
    return { text: String(out).slice(0, 4000), provider: provider.name, model: provider.model, llm: true };
  } catch (e) {
    console.error("draftScope provider call failed:", e && e.message);
    return { text: stub, provider: "stub", model: null, llm: false, fallback: true, errorDetail: String((e && e.message) || "unknown error").slice(0, 300) };
  }
}

// (d) ESTIMATE INTAKE DRAFT: drawings/photo notes/field notes + current form
//     values -> structured estimate-field recommendations. This is NOT the
//     calculator. The model fills or flags inputs; RoofOps still computes the
//     material list and EDGE/Our Way totals with deterministic Warrensburg
//     rules in js/estimator.js.
const MAX_ESTIMATE_TOKENS = 1200;
const ESTIMATE_NUMERIC_FIELDS = [
  "warrantyYears", "areaSf", "taperCost", "overlayIn", "overlaySq",
  "overlayCostSq", "perimeterLf", "curbPerimeterLf", "stoneCopingIn",
  "maxTaperIn", "tearoffIn", "blockingCost", "metalLfCost",
  "equipmentCost", "disposalCost", "retrofitDrainCount",
  "retrofitDrainCost", "scupperCount", "crewSize", "hoursPerDay",
  "workingDays", "edgeLaborRate", "ourLaborRate", "perDiem",
  "hotelRooms", "hotelNightCost", "hotelNights", "materialTaxRate",
  "edgeProfitRate", "edgeBondRate", "ourMarkupRate", "warrantyRateSf",
  "pipeBoots"
];
const ESTIMATE_TEXT_FIELDS = [
  "projectName", "location", "contact", "roofMapId", "roofMapName",
  "companyCamProjectId", "companyCamProjectName", "fieldNotes"
];
const ESTIMATE_ENUMS = {
  membrane: ["epdm-sa", "tpo", "pvc"],
  slopeType: ["tapered", "structural"]
};
const ESTIMATE_PLAYBOOK =
  "Estimate like Mark/Watkins did for Warrensburg Post Office. Treat Warrensburg as the known-good EPDM SA example: " +
  "60 mil Elevate RubberGard EPDM SA, 10 SQ rolls, one factory selvage edge on the 100-foot side, 20-year warranty, " +
  "tapered insulation plus a continuous 2.6 inch ISO top layer when specified, mechanically fasten only the top layer, " +
  "8 fasteners per 4x8 top board, screw length = total insulation thickness plus 2 inches rounded up, screws purchased by pail, " +
  "RPF/RUSS around perimeter and curbs with 2 inch plates and fasteners at 12 inches on center, 3 inch splice tape at a minimum " +
  "of 1.5 rolls per field EPDM roll when the selvage lap is used, 6 inch batten cover for end laps or exposed SA adhesive, " +
  "5 inch QuickSeam flashing for pipes/drains/scuppers/curbs, QuickPrime, Water Block, lap sealant, T-joint/detail patches, " +
  "retrofit drains, warranty fee, dumpsters, lift/rental equipment, travel, material tax, EDGE profit/bond, and Our Way markup. " +
  "Some roofs are structurally sloped and do not carry tapered insulation unless field data says taper is needed. " +
  "Never invent a dimension, roof area, perimeter, drain count, lift cost, taper quote, labor duration, tax, bond, or markup. " +
  "Return missing items as missingInputs. RoofOps will calculate quantities and totals after you return fields.";
const ESTIMATE_SYSTEM =
  "You are the owner-only RoofOps estimating intake assistant for Watkins Roofing. " +
  "Use the provided estimating playbook and current estimate data to prepare structured input fields for the RoofOps calculator. " +
  "You do not produce a proposal price and you do not override the deterministic material calculator. " +
  "Respond with ONLY JSON of this shape: " +
  '{"fields": object, "assumptions": string[], "missingInputs": string[], "warnings": string[], "rulesApplied": string[]}. ' +
  "Only include fields that are directly supported by the notes/data or by the Warrensburg playbook defaults. " +
  "Use these exact field names when applicable: " +
  ESTIMATE_TEXT_FIELDS.concat(ESTIMATE_NUMERIC_FIELDS).concat(Object.keys(ESTIMATE_ENUMS)).join(", ") + ".";

function n(v) {
  const num = Number(String(v == null ? "" : v).replace(/[$,%\s,]/g, ""));
  return isFinite(num) ? num : null;
}
function sanitizeEstimateInput(raw) {
  raw = (raw && typeof raw === "object") ? raw : {};
  const out = {};
  ESTIMATE_TEXT_FIELDS.forEach(function (key) { out[key] = s(raw[key], key === "fieldNotes" ? 6000 : 300); });
  ESTIMATE_NUMERIC_FIELDS.forEach(function (key) {
    const val = n(raw[key]);
    out[key] = val == null ? 0 : val;
  });
  Object.keys(ESTIMATE_ENUMS).forEach(function (key) {
    const val = s(raw[key], 40);
    out[key] = ESTIMATE_ENUMS[key].indexOf(val) !== -1 ? val : "";
  });
  return out;
}
function clampEstimateFields(raw) {
  const obj = (raw && typeof raw === "object") ? raw : {};
  const fields = {};
  ESTIMATE_TEXT_FIELDS.forEach(function (key) {
    if (obj[key] != null) fields[key] = s(obj[key], key === "fieldNotes" ? 6000 : 300);
  });
  ESTIMATE_NUMERIC_FIELDS.forEach(function (key) {
    if (obj[key] == null || obj[key] === "") return;
    const val = n(obj[key]);
    if (val != null) fields[key] = val;
  });
  Object.keys(ESTIMATE_ENUMS).forEach(function (key) {
    const val = s(obj[key], 40);
    if (ESTIMATE_ENUMS[key].indexOf(val) !== -1) fields[key] = val;
  });
  return fields;
}
function clampEstimateDraft(raw) {
  const obj = (raw && typeof raw === "object") ? raw : {};
  return {
    fields: clampEstimateFields(obj.fields),
    assumptions: rows(obj.assumptions, 12, function (x) { return s(x, 220); }),
    missingInputs: rows(obj.missingInputs, 16, function (x) { return s(x, 180); }),
    warnings: rows(obj.warnings, 12, function (x) { return s(x, 220); }),
    rulesApplied: rows(obj.rulesApplied, 16, function (x) { return s(x, 220); })
  };
}
function composeStubEstimateDraft(estimate) {
  const notes = [estimate.fieldNotes, estimate.projectName, estimate.roofMapName].join(" ").toLowerCase();
  const fields = {};
  if (/epdm|rubbergard|sa membrane|self[- ]?adhered/.test(notes)) fields.membrane = "epdm-sa";
  if (/structural|structurally sloped/.test(notes)) fields.slopeType = "structural";
  else if (/taper/.test(notes)) fields.slopeType = "tapered";
  if (/2\.6|2-6|two point six/.test(notes)) fields.overlayIn = 2.6;
  if (/20[- ]?year|20 year/.test(notes)) fields.warrantyYears = 20;
  return {
    fields: fields,
    assumptions: ["Using the saved Warrensburg EPDM SA estimating playbook; no live AI key was used."],
    missingInputs: ["Review roof area, perimeter, taper quote, drains, curb perimeter, lift, disposal, and labor days before saving."],
    warnings: ["This placeholder does not read PDFs or photos. It only applies obvious field-note cues."],
    rulesApplied: [
      "EPDM SA quantities are calculated by RoofOps after intake fields are set.",
      "Warrensburg rules include 1.5 splice-tape rolls per field EPDM roll minimum, 6 inch batten cover, RPF/RUSS, and screws by thickness."
    ]
  };
}
async function draftEstimate(input, opts) {
  opts = opts || {};
  const estimate = sanitizeEstimateInput(input && input.estimate);
  const provider = resolveProvider(opts.env || process.env);
  const stub = composeStubEstimateDraft(estimate);
  if (provider.name === "stub") return Object.assign(stub, { provider: "stub", model: null, llm: false });
  try {
    const parts = [{
      kind: "text",
      text: "Estimate playbook:\n" + ESTIMATE_PLAYBOOK +
        "\n\nCurrent estimate intake (JSON):\n" + JSON.stringify(estimate)
    }];
    const out = await callProvider(provider, ESTIMATE_SYSTEM, parts, MAX_ESTIMATE_TOKENS);
    const result = clampEstimateDraft(extractJson(out));
    return Object.assign(result, { provider: provider.name, model: provider.model, llm: true });
  } catch (e) {
    console.error("draftEstimate provider call failed:", e && e.message);
    return Object.assign(stub, {
      provider: "stub", model: null, llm: false, fallback: true,
      errorDetail: String((e && e.message) || "unknown error").slice(0, 300)
    });
  }
}

module.exports = {
  ISSUE_VOCABULARY,
  CAUSE_VOCABULARY,
  CONFIDENCE_LEVELS,
  STUB_MARKER,
  MAX_VISION_PHOTOS,
  resolveProvider,
  isSignedPhotoUrl,
  cleanInlineImage,
  cleanStorageRef,
  cleanWorkOrderId,
  sanitizeReport,
  sanitizeIssueContext,
  sanitizeProposalText,
  sanitizeEstimateInput,
  composeStubScope,
  extractJson,
  clampIssueResult,
  clampEstimateDraft,
  generateSummary,
  identifyIssue,
  draftScope,
  draftEstimate
};
