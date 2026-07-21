const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Roof plan scale-to-fit on the inspection report (Mark, 2026-07-20).

   Mark's screenshot: a roof plan running off the right edge and getting
   clipped. Simulating the REAL sizing math across four geometries showed the
   jsPDF path cannot overflow -- it fits width first and clamps height, so
   planW <= availW always. The clipping came from the HTML report, where the
   SVG is emitted at its natural size (~1440px for a 52ft roof at the 20px/ft
   ceiling) inside a wrapper set to overflow:hidden. It was never scaled; it
   was cropped.

   The PDF path had its own defects the simulation exposed -- not overflow, but
   waste: a tall narrow roof rendered 97pt wide (18% of the column) and every
   plan hugged the left margin because x was hardcoded to M. */

const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");

function codeOnly(src){
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* Run the real responsive-SVG helper. */
function helper(){
  const src = between(exportSource, "function rmRoofPlanResponsiveSvg", "function rmBuildReportRoofPlanSvg");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb.rmRoofPlanResponsiveSvg;
}

/* Mirror of the PDF placement so the geometry can be asserted, not eyeballed. */
function place(svgW, svgH, yStart){
  const W = 612, H = 792, M = 40;
  const MIN = 220, MAX = 520;
  let y = yStart, paged = false;
  const availW = W - M * 2;
  let budgetH = (H - M) - y;
  if (budgetH < MIN){ paged = true; y = M; budgetH = (H - M) - y; }
  const maxPlanH = Math.min(budgetH, MAX);
  const fit = Math.min(availW / svgW, maxPlanH / svgH);
  const planW = svgW * fit, planH = svgH * fit;
  return { x: M + (availW - planW) / 2, y, w: planW, h: planH, paged, W, H, M, availW };
}

/* ================= the HTML clip — the actual bug ================= */

test("the embedded SVG is told to scale, not left at natural size", () => {
  const f = helper();
  const out = f({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1496" viewBox="0 0 1440 1496"><rect/></svg>' });
  assert.match(out, /max-width:100%/);
  assert.match(out, /height:auto/);
});

test("the viewBox survives — that is what makes it scale as a unit", () => {
  /* Without a viewBox, max-width would squash rather than scale, and the
     dimension labels would drift off their edges. */
  const out = helper()({ svg: '<svg xmlns="x" width="1440" height="1496" viewBox="0 0 1440 1496"><rect/></svg>' });
  assert.match(out, /viewBox="0 0 1440 1496"/);
});

test("an unexpected SVG shape is embedded untouched rather than corrupted", () => {
  const f = helper();
  assert.equal(f({ svg: "<div>not an svg</div>" }), "<div>not an svg</div>");
  assert.equal(f({}), "");
  assert.equal(f(null), "");
});

test("the wrapper no longer CROPS", () => {
  /* overflow:hidden is what turned an oversized drawing into a cut-off one.
     auto degrades to scrolling; it never silently loses content. */
  /* codeOnly FIRST. The fix's own comment explains that the wrapper *used to
     be* overflow:hidden, so a raw match fires on the explanation and reports
     the bug still present. Any absence assertion here has to read code. */
  const embed = codeOnly(between(exportSource, "<h3 class='cond'>Roof Plan</h3>", "planUnavailableRoofs.forEach"));
  assert.doesNotMatch(embed, /overflow:hidden/);
  assert.match(embed, /overflow:auto/);
  assert.match(embed, /rmRoofPlanResponsiveSvg\(plan\)/);
});

test("the PDF still rasterizes the RAW svg, not the responsive one", () => {
  /* rmRasterizeSvgToCanvas needs the natural pixel dimensions. Feeding it a
     max-width:100% SVG would constrain the offscreen render. */
  const pdf = between(exportSource, "var planCanvas = await rmRasterizeSvgToCanvas", "y += planH + 18;");
  assert.match(pdf, /rmRasterizeSvgToCanvas\(plan\.svg, plan\.width, plan\.height\)/);
  assert.doesNotMatch(codeOnly(pdf), /rmRoofPlanResponsiveSvg/);
});

/* ================= the PDF geometry ================= */

test("one fit ratio is applied to both axes — aspect preserved", () => {
  const pdf = codeOnly(between(exportSource, "var availW = W - M \* 2;", "y += planH + 18;"));
  assert.match(pdf, /Math\.min\(availW \/ plan\.width, maxPlanH \/ plan\.height\)/);
  assert.match(pdf, /plan\.width \* fit/);
  assert.match(pdf, /plan\.height \* fit/);
});

test("the plan is centred, not pinned to the left margin", () => {
  const pdf = between(exportSource, "var availW = W - M \* 2;", "y += planH + 18;");
  assert.match(pdf, /var planX = M \+ \(availW - planW\) \/ 2/);
  assert.match(pdf, /doc\.addImage\(planDataUrl, "PNG", planX, y, planW, planH\)/);
});

test("every geometry fits inside the content box, on both axes", () => {
  /* The four cases from the simulation, plus extremes. */
  [[1440,1496],[2200,1072],[600,2356],[2200,1704],[240,240],[4000,300],[300,4000]]
    .forEach(([w,h]) => {
      const p = place(w, h, 200);
      assert.ok(p.x >= p.M - 0.01, `left margin ${w}x${h}`);
      assert.ok(p.x + p.w <= p.W - p.M + 0.01, `right margin ${w}x${h}: ${p.x + p.w} > ${p.W - p.M}`);
      assert.ok(p.y + p.h <= p.H - p.M + 0.01, `bottom margin ${w}x${h}`);
    });
});

test("aspect ratio is held exactly", () => {
  [[1440,1496],[600,2356],[2200,1072]].forEach(([w,h]) => {
    const p = place(w, h, 200);
    assert.ok(Math.abs((p.w / p.h) - (w / h)) < 1e-9, `aspect drift on ${w}x${h}`);
  });
});

test("a tall narrow roof now uses the column instead of 18% of it", () => {
  /* The old math: 97pt wide. It fitted, but it was unreadable. */
  const p = place(600, 2356, 200);
  const oldW = 380 * 600 / 2356;
  assert.ok(p.w > oldW, `expected wider than the old ${Math.round(oldW)}pt, got ${Math.round(p.w)}pt`);
  assert.ok(p.h <= 520 + 0.01, "still bounded by the max height");
});

test("a cramped page break happens BEFORE sizing, not after", () => {
  /* Sizing to a 40pt gap and then paging would leave a postage stamp at the
     top of a blank page. */
  const cramped = place(1440, 1496, 700);
  assert.equal(cramped.paged, true);
  assert.equal(cramped.y, 40);
  assert.ok(cramped.h > 220, "after paging it gets a usable height, not the gap's");
  const roomy = place(1440, 1496, 120);
  assert.equal(roomy.paged, false);
});

test("the height budget is real page space, not a flat constant", () => {
  const pdf = codeOnly(between(exportSource, "var availW = W - M \* 2;", "y += planH + 18;"));
  assert.match(pdf, /var budgetH = \(H - M\) - y/);
  assert.match(pdf, /Math\.min\(budgetH, RM_PDF_PLAN_MAX_H\)/);
  assert.match(exportSource, /var RM_PDF_PLAN_MIN_H = \d+/);
  assert.match(exportSource, /var RM_PDF_PLAN_MAX_H = \d+/);
});

test("nothing is cropped — the drawing is only ever scaled", () => {
  const pdf = codeOnly(between(exportSource, "var availW = W - M \* 2;", "y += planH + 18;"));
  ["clip", "crop", "slice"].forEach(w =>
    assert.ok(!pdf.includes(w), "no cropping primitive: " + w));
});
