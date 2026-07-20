const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/* AI summary: seed-and-expand + client-downscaled vision images
   (Mark, 2026-07-19).

   TWO behaviours are under test.

   SEED: the text a technician has already typed in the Summary box used to be
   read ONLY as an overwrite guard -- the model never saw it, so a half-written
   summary was discarded and regenerated from scratch. It is now the starting
   point, and the prompt is explicit that his facts outrank anything inferred
   from a photo, because he stood on the roof and the model did not.

   VISION IMAGES: photos now reach the model as ~900px downscales produced by
   the SAME helper the PDF export uses. Anthropic re-scales anything over
   ~1568px and bills the resized token count anyway, so a 1600px capture costs
   roughly 3x a 900px one for detail the model cannot use. */

const provider = require("../netlify/functions/lib/aiProvider");
const clientSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "generate-summary.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const B64 = "QUJDREVGR0g=";

/* ================= seed: both allow-lists ================= */

test("the client payload carries the technician's seed text", () => {
  /* The gap this closes: buildSummaryDraftPayload() had no `summary` field at
     all, so the typed text could never reach the model however the server was
     written. */
  const block = between(clientSource, "function buildSummaryDraftPayload", "function draftReportSummary");
  assert.match(block, /summary: s\(o\.summary, 4000\)/);
});

test("the server keeps the seed and clamps it independently", () => {
  /* The client clamp is a courtesy; this one is the trust boundary. */
  const r = provider.sanitizeReport({ summary: "x".repeat(9000) });
  assert.equal(r.summary.length, 4000);
});

test("a missing seed round-trips as empty, never undefined", () => {
  const r = provider.sanitizeReport({ jobName: "Somewhere" });
  assert.equal(r.summary, "", "an absent seed must be an empty string, so the prompt can test it plainly");
});

test("the prompt instructs the model to BUILD ON the seed, not replace it", () => {
  const block = between(serverSource, "var seed = (r.summary", "return \"You draft the Summary");
  assert.match(block, /technician_draft/, "the seed is delimited so the model can see where it ends");
  assert.match(block, /BUILD ON IT/i);
  assert.match(block, /[Nn]ever contradict/);
  assert.match(block, /COMPLETE summary/i, "must return the whole summary, not just its additions");
});

test("no seed means no seed instruction — the prompt stays clean", () => {
  /* A generate-from-scratch draft must not carry dangling instructions about
     a technician draft that does not exist. */
  const block = between(serverSource, "var seed = (r.summary", "return \"You draft the Summary");
  assert.match(block, /!seed \? "" :/, "the seed rule is conditional on there being a seed");
});

test("the confirm tells the truth about what happens to his text", () => {
  /* It used to say "Replace the current Summary text" -- which was accurate
     then and would be a lie now. */
  const block = between(clientSource, "async function draftReportSummary", "var payload = buildSummaryDraftPayload");
  assert.match(block, /starting point/i);
  assert.doesNotMatch(block, /Replace the current Summary text with a generated draft/);
});

/* ================= the hint under the button ================= */

test("the Draft Summary hint no longer claims there is no AI", () => {
  /* It read "Placeholder generator for now (no AI yet)" long after prod was
     keyed -- a false claim sitting in front of the user on every report. */
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const block = between(indexSource, 'id="wo-draft-summary-row"', '<textarea id="summary"');
  assert.doesNotMatch(block, /no AI yet/i);
  assert.doesNotMatch(block, /Placeholder generator/i);
  assert.match(block, /review and edit/i, "the review-before-sending instruction must survive");
});

test("the hint does not assert a key exists on THIS deploy", () => {
  /* The button is a teaser on a keyless deploy -- shown, but a tap toasts
     "coming soon". So the hint is visible with and without a key and must
     describe the FEATURE, not the deploy's key state. Saying "AI drafts..."
     is fine; "now wired up"/"is enabled" would be the old bug with the
     opposite sign. */
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const block = between(indexSource, 'id="wo-draft-summary-row"', '<textarea id="summary"');
  assert.doesNotMatch(block, /now (live|wired|enabled|active)/i);
  assert.doesNotMatch(block, /AI is (on|enabled|configured)/i);
});

/* ================= vision images ================= */

test("vision images are validated through the same gate as every inline image", () => {
  /* A client must not be able to smuggle arbitrary bytes in by relabelling
     them -- media type allow-list, base64 shape and size cap all still apply. */
  const r = provider.sanitizeReport({
    visionImages: [
      { mediaType: "image/jpeg", data: B64 },
      { mediaType: "text/html", data: B64 },              // wrong media type
      { mediaType: "image/png", data: "not!valid!b64" },  // wrong shape
      { mediaType: "image/png", data: "A".repeat(6 * 1024 * 1024) } // over cap
    ]
  });
  assert.equal(r.visionImages.length, 1);
  assert.equal(r.visionImages[0].mediaType, "image/jpeg");
});

test("vision images are capped at the photo budget", () => {
  const many = Array.from({ length: 20 }, () => ({ mediaType: "image/jpeg", data: B64 }));
  const r = provider.sanitizeReport({ visionImages: many });
  assert.equal(r.visionImages.length, provider.MAX_VISION_PHOTOS);
});

test("absent vision images round-trip as an empty list", () => {
  const r = provider.sanitizeReport({ jobName: "Somewhere" });
  assert.deepEqual(r.visionImages, []);
});

test("client-downscaled images are PREFERRED over the signed-URL and full-res paths", () => {
  const block = between(serverSource, "let photoImages = [];", "const result = await generateSummary");
  const takesClientFirst = block.indexOf("report.visionImages");
  const signsUrls = block.indexOf("collectSignedPhotoUrls");
  assert.ok(takesClientFirst !== -1 && takesClientFirst < signsUrls,
    "client images must fill the budget before any Storage URL is minted");
});

test("the signed-URL path only fills the budget the client images left", () => {
  /* Otherwise a report with 8 client images mints 8 more signed URLs that the
     provider seam immediately discards -- live URLs with no consumer, which is
     exactly the bug the #119 cross-review fixed once already. */
  const block = between(serverSource, "let photoImages = [];", "const result = await generateSummary");
  assert.match(block, /MAX_VISION_PHOTOS - photoImages\.length/);
});

test("the inline path APPENDS rather than overwriting the client images", () => {
  /* Assigning here would silently discard the downscaled images and fall back
     to full-res bytes -- three times the token cost, invisibly. */
  const block = between(serverSource, "let photoImages = [];", "const result = await generateSummary");
  assert.match(block, /photoImages = photoImages\.concat\(inline\)/);
  assert.doesNotMatch(block, /photoImages = await collectInlinePhotoImages/);
});

test("the total vision budget is never exceeded across all three sources", () => {
  const block = between(serverSource, "let photoImages = [];", "const result = await generateSummary");
  assert.match(block, /\(photoUrls\.length \+ photoImages\.length\) < MAX_VISION_PHOTOS/);
});

/* ================= the shared downscaler ================= */

test("there is ONE downscaler, shared, not a second implementation", () => {
  /* Two independent resize paths would drift. The vision helper reuses the
     PDF path that is already proven on production. */
  const block = between(exportSource, "function aiVisionImagePart", "function pdfFileName");
  assert.match(block, /pdfPhotoDataUrl\(dataUrl\)/);
  assert.doesNotMatch(block, /createElement\("canvas"\)/, "must not re-implement the resize");
});

test("the downscaler returns the exact shape cleanInlineImage validates", () => {
  const block = between(exportSource, "function aiVisionImagePart", "function aiVisionImageParts");
  assert.match(block, /mediaType/);
  assert.match(block, /data:\(image/, "strips the data: prefix, as the server gate expects");
  assert.match(block, /catch\(function\(\)\{ return null; \}\)/, "a photo that won't downscale is skipped, never an error");
});

test("a photo that cannot be downscaled is dropped, not sent raw", () => {
  const block = between(exportSource, "function aiVisionImageParts", "function pdfFileName");
  assert.match(block, /\.filter\(Boolean\)/);
});

test("a vision-image failure degrades to a text-only draft", () => {
  /* Same rule the server already applies to a Storage outage: a draft must
     never dead-end on a roof. */
  const block = between(clientSource, "var payload = buildSummaryDraftPayload", "var r = await fetch");
  assert.match(block, /try\{/);
  assert.match(block, /catch\(e\)\{/);
});
