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
const ISSUE_VOCABULARY = [
  "membrane_puncture",
  "open_seam",
  "flashing_failure",
  "ponding_water",
  "clogged_drain_or_scupper",
  "penetration_seal_failure",
  "deteriorated_sealant",
  "pitch_pan_failure",
  "coping_or_edge_metal_failure",
  "blistering",
  "hail_damage",
  "wind_damage",
  "no_visible_issue",
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
// the security clamp and the token-cost ceiling. sanitizeReport() is the
// SAME projection generate-summary.js (PR #119) established client-side in
// buildSummaryDraftPayload(): structured text only -- never photo bytes,
// pins, GPS, ids, or signatures. Exported so the two functions converge on
// one shape instead of drifting.
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
    photoCaptions: rows(raw.photoCaptions, 60, function (c) {
      const t = s(c, 300).trim();
      return t || null;
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
  { re: /pitch\s*(pan|pocket)/i, issue: "pitch_pan_failure", cause: "weathering_age" },
  { re: /ponding|standing water/i, issue: "ponding_water", cause: "drainage_deficiency" },
  { re: /drain|scupper|clog/i, issue: "clogged_drain_or_scupper", cause: "debris_accumulation" },
  { re: /puncture|tear|hole|gouge/i, issue: "membrane_puncture", cause: "mechanical_damage" },
  { re: /seam|lap/i, issue: "open_seam", cause: "weathering_age" },
  { re: /flashing|counterflash/i, issue: "flashing_failure", cause: "weathering_age" },
  { re: /coping|edge metal|drip edge/i, issue: "coping_or_edge_metal_failure", cause: "weathering_age" },
  { re: /sealant|caulk|mastic/i, issue: "deteriorated_sealant", cause: "weathering_age" },
  { re: /penetration|pipe boot|curb|hvac/i, issue: "penetration_seal_failure", cause: "weathering_age" },
  { re: /blister/i, issue: "blistering", cause: "thermal_movement" },
  { re: /hail/i, issue: "hail_damage", cause: "storm_event" },
  { re: /wind|blow[- ]?off|uplift/i, issue: "wind_damage", cause: "storm_event" }
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
    'If the photo does not clearly show a roofing issue, use "no_visible_issue" or "indeterminate" ' +
    'with cause "unconfirmed" and confidence "low". Your answer is a DRAFT for human confirmation.';
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
  if (!res.ok) throw new Error("Anthropic API error " + res.status);
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
  if (!res.ok) throw new Error("OpenAI API error " + res.status);
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
async function generateSummary(input, opts) {
  opts = opts || {};
  const report = input.report;
  const photoUrls = (input.photoUrls || []).filter(isSignedPhotoUrl).slice(0, MAX_VISION_PHOTOS);
  const photoImages = rows(input.photoImages, Math.max(0, MAX_VISION_PHOTOS - photoUrls.length), cleanInlineImage);
  const provider = resolveProvider(opts.env || process.env);
  const stubText = opts.stubText || composeStubSummary(report);
  const system = opts.system || SUMMARY_SYSTEM;

  if (provider.name === "stub") {
    return { text: stubText, provider: "stub", model: null, llm: false };
  }
  try {
    const parts = photoUrls.map(function (u) { return { kind: "image", url: u }; });
    photoImages.forEach(function (im) { parts.push({ kind: "image_b64", mediaType: im.mediaType, data: im.data }); });
    parts.push({
      kind: "text",
      text: "Draft the Summary for this report. Report data (JSON):\n" + JSON.stringify(report)
    });
    const text = await callProvider(provider, system, parts, MAX_SUMMARY_TOKENS);
    return { text: String(text).slice(0, 8000), provider: provider.name, model: provider.model, llm: true };
  } catch (e) {
    return { text: stubText, provider: "stub", model: null, llm: false, fallback: true };
  }
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

module.exports = {
  ISSUE_VOCABULARY,
  CAUSE_VOCABULARY,
  CONFIDENCE_LEVELS,
  STUB_MARKER,
  MAX_VISION_PHOTOS,
  resolveProvider,
  isSignedPhotoUrl,
  cleanInlineImage,
  sanitizeReport,
  sanitizeIssueContext,
  extractJson,
  clampIssueResult,
  generateSummary,
  identifyIssue
};
