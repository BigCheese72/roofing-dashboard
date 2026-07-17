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
//   * PHASE 1.5 -- INLINE photos see the model too. The dev Firebase project
//     has no Storage bucket (Spark plan), so every photo there -- app-saved
//     or seeded by tools/seed_dev_from_prod.js -- is a base64 data-URL on
//     the Firestore photo doc with NO storageRef to sign. Without this, dev
//     (the only context with a key) could never exercise vision at all. The
//     client sends the work-order ID (never bytes); the server reads those
//     photo docs itself (collectInlinePhotoImages()) and hands the model
//     base64 image blocks. See that function's comment for the exposure
//     argument.
//   * Cost control is the BUTTON: drafts fire on demand only, never
//     automatically on save/open. aiProvider caps vision inputs at
//     MAX_VISION_PHOTOS (8) per call across BOTH kinds -- signed URLs take
//     the budget first, inline images fill what's left.
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
const { resolveProvider, generateSummary, cleanInlineImage, cleanStorageRef, sanitizeReport, MAX_VISION_PHOTOS } = require("./lib/aiProvider");

// ---- Length/style tuning knobs for the Phase-1 LLM prompt. Mark's verdict
// on his ChatGPT Flat Branch Pub summary (the exemplar below, ~340 words):
// right voice, "a little long" -- so the target sits meaningfully under it.
// Tune HERE, nowhere else. ----
const SUMMARY_TARGET_WORDS = 280;
const SUMMARY_MAX_PARAGRAPHS = 4; // generic-voice branch only; with the exemplar, structure follows it
// Mark's Flat Branch Pub summary, VERBATIM from the report he generated via
// ChatGPT and approved (inspection job #17455, 2026-07-15 -- supplied
// 2026-07-16). This is the voice/structure target; the prompt asks for the
// same, tighter. Note the plain-text "Recommended Repairs" section is part
// of the pattern -- the PDF's Summary block renders pre-wrap text, so it
// prints fine.
const STYLE_EXEMPLAR = `The roof is a fully adhered EPDM system that is generally in fair condition. Most of the main roof membrane, perimeter details, rooftop equipment, and penetrations remain serviceable. However, several areas have been damaged by prolonged exposure to grease and require corrective work.

The most significant concern is the east half of the internal north gutter, where a neoprene coating or overlay has failed. Water is becoming trapped between the failed neoprene layer and the existing EPDM membrane below. Based on the visible deterioration and the reported leakage near the northeast corner and west end of the internal gutter, the underlying EPDM membrane may also be compromised.

Grease discharge from three rooftop exhaust areas has caused deterioration of the EPDM membrane and flashing materials. Additional deficiencies include an open rain collar and areas of failed or missing sealant along termination bars. These conditions may allow water intrusion during heavy rainfall.

The observed damage appears to be related primarily to grease contamination, failed aftermarket coating materials, and maintenance-related sealant deterioration. These conditions would generally be considered non-warrantable.

Recommended Repairs

Remove the failed neoprene material from the affected internal gutter area and inspect the underlying EPDM membrane, insulation, and substrate for moisture damage. Replace all damaged or contaminated roofing materials as necessary and install new compatible EPDM membrane and flashing details.

Remove and replace grease-damaged membrane and flashing around the affected exhaust equipment. The exhaust systems should also be evaluated and fitted with appropriate grease containment measures to prevent continued contamination of the roof.

Reseal the open termination bars, repair the open rain collar, and inspect all nearby flashing details for additional deterioration. After repairs are completed, the internal gutter and scupper areas should be water-tested to confirm proper drainage and watertightness.

Due to the barrel-shaped roof configuration, appropriate fall-protection and access precautions should be used while performing the repairs.`;
// Signed photo URLs live just long enough for one model call to fetch them.
const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// ---- Input sanitizing: the client sends a compact projection of the work
// order (see buildSummaryDraftPayload() in js/workorders.js), and the server
// re-clamps everything anyway -- request bodies are attacker-controlled text,
// and the sanitized object becomes LLM prompt context, so the bounds are also
// the token-cost ceiling. The sanitizer itself LIVES IN lib/aiProvider.js
// (sanitizeReport + cleanStorageRef + cleanWorkOrderId) -- one shape for
// every AI caller, moved there after the post-#119 cross-review caught this
// file's local copy and the lib's drifting apart. Re-exported at the bottom
// so tests (and any reader looking here first) still find it. ----

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
    ? "Match the voice and structure of this example summary from an approved report -- short plain " +
      "paragraphs, then a plain-text 'Recommended Repairs' section when the findings warrant repairs -- " +
      "but run tighter and more concise than it. The example's FACTS describe a DIFFERENT roof: imitate " +
      "its voice and structure only; every fact in your output must come from THIS report's data and " +
      "photos.\n---\n" + STYLE_EXEMPLAR + "\n---\n"
    : "Write in a professional commercial-roofing service-report voice addressed to the building's " +
      "customer, in at most " + SUMMARY_MAX_PARAGRAPHS + " short paragraphs. ";
  return "You draft the Summary section of a commercial roofing report. " +
    "Use ONLY the report data and the attached photos -- never invent conditions, causes, " +
    "measurements, or recommendations that they do not support. Where a photo shows a condition, " +
    "ground the description in what is visible. " + style +
    "Target about " + SUMMARY_TARGET_WORDS + " words, covering: what was done on site, the key " +
    "findings/conditions, and recommended next actions. " +
    // Output hygiene, learned from the first two live drafts (2026-07-16):
    // one added its own "Summary" heading (the PDF already prints one), the
    // other appended a "Note: this is a draft" disclaimer -- both would
    // print to the customer if the tech didn't catch them.
    "Plain text only, no markdown. Output the summary body only: do not add a 'Summary' title or any " +
    "heading except 'Recommended Repairs', and do not add any note, disclaimer, or mention that this " +
    "is a draft. This is a DRAFT a technician will review and edit before it is sent.";
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
      // Existence first. V4 signing is pure local crypto -- it happily mints
      // a valid-looking URL for an object that ISN'T THERE, and Anthropic
      // then 400s the ENTIRE request over the one dead download ("Unable to
      // download the file") instead of skipping it. Found live on dev
      // 2026-07-16: Flat Branch has one photo doc whose storageRef points at
      // an object missing in production (and so missing from the seed) --
      // that single dead ref killed every draft. A missing object now
      // degrades to that photo's caption, same rule as every other photo
      // fault here.
      var existsArr = await bucket.file(ref).exists();
      if (!existsArr || existsArr[0] !== true) continue;
      var signed = await bucket.file(ref).getSignedUrl({
        version: "v4", action: "read", expires: Date.now() + (ttlMs || SIGNED_URL_TTL_MS)
      });
      out.push({ caption: (p.caption || ""), url: signed[0] });
    } catch (e) { /* skip: unsignable photo -> captions-only for this one */ }
  }
  return out;
}

// ---- Phase-1.5 seam: vision for INLINE photos. Dev's Firebase project has
// no Storage bucket (Spark plan), so a photo there lives as a base64
// data-URL on the Firestore photo doc (`img`) with no storageRef -- nothing
// for collectSignedPhotoUrls() to sign, which made vision untestable on the
// one deploy context that has a key. This reads the photo docs SERVER-SIDE
// (same admin handle the request's hostname already resolved) and returns
// aiProvider-shaped { mediaType, data } image blocks.
//   * The client still never sends bytes -- it sends the work-order id.
//   * Exposure class is unchanged: doc.generate already lets this caller
//     generate the full report PDF carrying every photo on a work order;
//     these bytes go only to the model call, never into the response.
//   * Only photos WITHOUT a signable storageRef ride this path -- a doc
//     carrying both (prod's cooling-off base64 backup) is already covered
//     by its signed URL, and sending both would duplicate the image.
//   * Docs are walked in photo-index order (ids are numeric indexes) so
//     which photos make the budget is deterministic.
//   * Per-image gates (media type, base64 charset, ~5MB cap) live in
//     aiProvider's cleanInlineImage(), applied here so the count we report
//     as photosSeen is the count that actually rode.
// NOT called on the stub path -- no bytes are read without a live model to
// consume them.
async function collectInlinePhotoImages(db, workOrderId, max) {
  var out = [];
  if (!workOrderId || !(max > 0)) return out;
  var snap = await db.collection("workorders").doc(workOrderId)
    .collection("photos").select("img", "storageRef").get();
  var docs = snap.docs.slice().sort(function (a, b) {
    return (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0);
  });
  for (var i = 0; i < docs.length && out.length < max; i++) {
    var d = docs[i].data() || {};
    if (cleanStorageRef(d.storageRef)) continue; // the signed-URL path owns this one
    var m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/.exec(typeof d.img === "string" ? d.img : "");
    if (!m) continue;
    var im = cleanInlineImage({ mediaType: m[1], data: m[2] });
    if (im) out.push(im);
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

    // Lightweight capability probe: does THIS deploy have an AI key? Lets the
    // client HIDE the "Draft Summary" button on a keyless deploy (production
    // today) instead of showing a button that can only insert a deterministic
    // placeholder. No report data is touched; configured-state is not
    // sensitive, but it stays behind the same doc.generate gate as the draft.
    if (body.action === "capability") {
      return resp(200, { ok: true, configured: resolveProvider(process.env).name !== "stub" });
    }

    if (body.action !== "draft_summary") return resp(400, { error: "Unknown action" });
    const report = sanitizeReport(body.report);
    if (!report) return resp(400, { error: "Missing report" });

    // Stub vs live is decided by which env vars exist on THIS deploy context
    // (dev holds ANTHROPIC_API_KEY; production deliberately doesn't yet).
    // Signed photo URLs are minted ONLY when a live model will consume them
    // -- the stub path must never create a live URL with no purpose.
    const provider = resolveProvider(process.env);
    let photoUrls = [];
    let photoImages = [];
    if (provider.name !== "stub") {
      if ((report.photos || []).some(function (p) { return p.storageRef; })) {
        try {
          const bucket = getAdmin(hostnameFromEvent(event)).storage().bucket();
          // Sign only what the model can consume: the provider seam sends at
          // most MAX_VISION_PHOTOS images per call, so refs past the budget
          // are never signed (post-#119 cross-review fix -- signing all 60
          // minted up to 52 live URLs with no consumer).
          const signable = report.photos.filter(function (p) { return p.storageRef; }).slice(0, MAX_VISION_PHOTOS);
          photoUrls = (await collectSignedPhotoUrls(bucket, signable)).map(function (p) { return p.url; });
        } catch (e) { /* vision degrades to text-only; a draft must never dead-end on Storage */ }
      }
      // Inline photos (Phase 1.5) fill whatever vision budget the signed
      // URLs left. On dev this is ALL the photos (no Storage bucket to
      // sign against); on prod it covers a photo saved before migration.
      if (report.workOrderId && photoUrls.length < MAX_VISION_PHOTOS) {
        try {
          const db = getAdmin(hostnameFromEvent(event)).firestore();
          photoImages = await collectInlinePhotoImages(db, report.workOrderId, MAX_VISION_PHOTOS - photoUrls.length);
        } catch (e) { /* same rule: degrade, never dead-end */ }
      }
    }

    const result = await generateSummary(
      { report: report, photoUrls: photoUrls, photoImages: photoImages },
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
      // Present only on the fallback path: the provider's own (truncated)
      // rejection text, so a failed AI call is diagnosable from the toast
      // instead of requiring server-log access. Caller is already
      // doc.generate-authenticated; the detail is the provider's RESPONSE
      // body and never contains the key.
      aiError: result.fallback ? (result.errorDetail || null) : null,
      // photosSeen = what the model CONSUMED (result.photosUsed -- the
      // provider seam's own count, re-gated and budget-capped there), never
      // what this handler collected -- it feeds the "N photos reviewed"
      // toast (#144).
      photosSeen: result.photosUsed || 0
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
exports.collectInlinePhotoImages = collectInlinePhotoImages;
exports.SUMMARY_TARGET_WORDS = SUMMARY_TARGET_WORDS;
exports.SIGNED_URL_TTL_MS = SIGNED_URL_TTL_MS;
