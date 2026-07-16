"use strict";
/* AI-drafted summary, Phase 1 scaffold (see "AI-drafted report summary" in
   DEV_NOTES.md). Guards the three promises the scaffold makes:

     1. The client payload builder (buildSummaryDraftPayload in
        js/workorders.js) projects ONLY summary-relevant text — no photo
        bytes, pins, ids, or signatures — maps checklist keys to labels,
        drops N/A rows and empty finding/repair rows, and clamps everything.
     2. The server function (netlify/functions/generate-summary.js) is
        auth-gated exactly like its siblings: no token -> 401 that leaks
        nothing; a signed-in role WITHOUT doc.generate -> 403; a plain
        field tech (doc.generate: true) CAN draft — field-first.
     3. The Phase-1 composer is a DETERMINISTIC template: same input, same
        output, built only from the report's own data, and it makes no
        network calls of any kind (the fetch trap below throws if the stub
        ever grows an external call before Mark signs off on a key).

   firebase-admin is stubbed the same way tests/functionsAuth.test.js does
   it, so this runs offline with no credentials and no secrets. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("module");

/* ================= Part 1: client payload builder ================= */
const woSrc = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker + " not found in workorders.js");
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, endMarker + " not found after " + startMarker);
  return src.slice(start, end);
}
const ctx = {};
vm.runInNewContext(
  slice(woSrc, "var INSPECTION_CHECKLIST_COMPONENTS", "var INSPECTION_RATINGS") +
  slice(woSrc, "function buildSummaryDraftPayload", "async function draftReportSummary"),
  ctx
);
/* JSON round-trip: the extracted function runs in the vm realm, so its
   objects fail deepStrictEqual on cross-realm Object.prototype (same note
   as tests/reportRoofPlanImageFrame.test.js). Serializing also mirrors what
   actually crosses the wire to the server function. */
const buildSummaryDraftPayload = (o) => JSON.parse(JSON.stringify(ctx.buildSummaryDraftPayload(o)));

const FULL_ORDER = {
  id: "wo_123", woType: "Inspection",
  jobName: "Tri-Delta Warehouse", location: "1200 Industrial Pkwy",
  serviceDate: "2026-07-14", technician: "J. Alvarez", roofSystem: "60-mil TPO, fully adhered",
  reportedArea: "", warrantable: "", nonWarrantable: "",
  inspectionChecklist: [
    { id: "chk_1", key: "membrane", rating: "Poor", notes: "Seam failures along north lap", linkedFindingId: "fnd_1", pin: { lat: 1, lng: 2 } },
    { id: "chk_2", key: "drainage", rating: "Fair", notes: "Ponding at NW drain", linkedFindingId: null, pin: null },
    { id: "chk_3", key: "flashings", rating: "Good", notes: "", linkedFindingId: null, pin: null },
    { id: "chk_4", key: "interior", rating: "N/A", notes: "", linkedFindingId: null, pin: null }
  ],
  findings: [
    { id: "fnd_1", condition: "Open seam", location: "North lap, panel 4", warranty: "Undetermined", pin: { lat: 1, lng: 2 } },
    { id: "fnd_2", condition: "", location: "", warranty: "Warrantable", pin: null } // empty row a tech never filled
  ],
  repairs: [
    { id: "rep_1", repair: "Temporary seam patch", location: "North lap", pin: null },
    { id: "rep_2", repair: " ", location: "", pin: null } // whitespace-only row
  ],
  photos: [
    { img: "data:image/jpeg;base64,AAAA", caption: "Open seam at north lap", finding_id: "fnd_1", gps: { lat: 1, lng: 2 } },
    { img: "data:image/jpeg;base64,BBBB", caption: "  ", finding_id: null, gps: null }
  ],
  changeOrderSignature: { img: "data:image/png;base64,SIG", printName: "X", date: "2026-07-14" }
};

test("payload carries the summary-relevant text and nothing else", () => {
  const p = buildSummaryDraftPayload(FULL_ORDER);
  assert.equal(p.woType, "Inspection");
  assert.equal(p.jobName, "Tri-Delta Warehouse");
  assert.equal(p.technician, "J. Alvarez");
  // Checklist: keys became display labels, N/A row dropped, order kept.
  assert.deepEqual(p.inspectionChecklist.map(it => [it.label, it.rating]), [
    ["Membrane / Field", "Poor"], ["Drainage (incl. Ponding)", "Fair"], ["Flashings & Terminations", "Good"]
  ]);
  assert.equal(p.inspectionChecklist[0].notes, "Seam failures along north lap");
  // Findings/repairs: empty rows dropped.
  assert.deepEqual(p.findings, [{ condition: "Open seam", location: "North lap, panel 4", warranty: "Undetermined" }]);
  assert.deepEqual(p.repairs, [{ repair: "Temporary seam patch", location: "North lap" }]);
  // Photos: captions only (trimmed non-empty), plus a bare count.
  assert.deepEqual(p.photoCaptions, ["Open seam at north lap"]);
  assert.equal(p.photoCount, 2);
  // NOTHING heavy or sensitive leaves the client: no bytes, pins, ids, gps,
  // signature — the exact fields a future LLM prompt must never receive
  // accidentally.
  const flat = JSON.stringify(p);
  ["img", "thumb", "base64", "pin", "gps", "fnd_1", "chk_1", "SIG", "signature", "storageRef"].forEach(tok => {
    assert.equal(flat.indexOf(tok), -1, "payload leaked: " + tok);
  });
});

test("payload survives a sparse/legacy order (all arrays missing)", () => {
  const p = buildSummaryDraftPayload({ woType: "Inspection", jobName: "Old One" });
  assert.deepEqual(p.inspectionChecklist, []);
  assert.deepEqual(p.findings, []);
  assert.deepEqual(p.repairs, []);
  assert.deepEqual(p.photoCaptions, []);
  assert.equal(p.photoCount, 0);
});

test("payload clamps oversized text and row counts", () => {
  const p = buildSummaryDraftPayload({
    woType: "Inspection", jobName: "x".repeat(9999),
    findings: Array.from({ length: 200 }, (_, i) => ({ condition: "c" + i, location: "l" })),
    photos: Array.from({ length: 500 }, () => ({ caption: "cap" }))
  });
  assert.equal(p.jobName.length, 200);
  assert.equal(p.findings.length, 50);
  assert.equal(p.photoCaptions.length, 60);
});

/* ================= Part 2: server function (auth + composer) ================= */
const VALID_TECH = "VALID_TECH_TOKEN";     // field_tech: doc.generate === true
const VALID_NOPERM = "VALID_NOPERM_TOKEN"; // real user, role grants nothing

const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  auth() {
    return {
      verifyIdToken: async (token) => {
        if (token === VALID_TECH) return { uid: "crew_tech_1", email: "tech@watkins.com", owner: false, role: "field_tech" };
        if (token === VALID_NOPERM) return { uid: "viewer_1", email: "viewer@watkins.com", owner: false, role: "no_perm_role" };
        throw new Error("Decoding Firebase ID token failed");
      }
    };
  },
  firestore() {
    return {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => {
            if (name === "roles" && id === "field_tech") {
              return { exists: true, data: () => ({ permissions: { "doc.generate": true } }) };
            }
            if (name === "roles" && id === "no_perm_role") {
              return { exists: true, data: () => ({ permissions: { "doc.generate": false } }) };
            }
            return { exists: false };
          }
        })
      })
    };
  }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return "FAKE_FIREBASE_ADMIN";
  return origResolve.call(this, req, ...rest);
};
require.cache["FAKE_FIREBASE_ADMIN"] = {
  id: "FAKE_FIREBASE_ADMIN", filename: "FAKE_FIREBASE_ADMIN", loaded: true, exports: fakeAdmin
};
// Dev service account + dev host so authGuard's cross-project guard passes.
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "watkins-service-orders-dev" });
// Phase-1 promise: the stub NEVER reaches the network. If someone wires an
// LLM call in before Mark provisions and approves a key, this trips.
global.fetch = async () => { throw new Error("REACHED AN EXTERNAL NETWORK CALL — Phase 1 must stay offline"); };

const fn = require("../netlify/functions/generate-summary.js");

function ev(body, token) {
  return {
    httpMethod: "POST",
    headers: Object.assign({ host: "dev--roofops.netlify.app" }, token ? { authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body)
  };
}
const REPORT = buildSummaryDraftPayload(FULL_ORDER);

test("no token -> opaque 401", async () => {
  const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }));
  assert.equal(r.statusCode, 401);
  assert.deepEqual(JSON.parse(r.body), { error: "Unauthorized" });
});

test("garbage token -> 401", async () => {
  const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }, "forged"));
  assert.equal(r.statusCode, 401);
});

test("signed-in but without doc.generate -> 403", async () => {
  const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }, VALID_NOPERM));
  assert.equal(r.statusCode, 403);
});

test("GET -> 405, wrong action -> 400, missing report -> 400", async () => {
  const g = await fn.handler({ httpMethod: "GET", headers: {} });
  assert.equal(g.statusCode, 405);
  const a = await fn.handler(ev({ action: "nope" }, VALID_TECH));
  assert.equal(a.statusCode, 400);
  const m = await fn.handler(ev({ action: "draft_summary" }, VALID_TECH));
  assert.equal(m.statusCode, 400);
});

test("a plain field tech CAN draft, and the draft restates the report's own data", async () => {
  const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }, VALID_TECH));
  assert.equal(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.ok, true);
  assert.equal(out.llm, false);
  assert.equal(out.source, "template_stub_v1");
  const d = out.draft;
  assert.ok(d.includes("J. Alvarez"), "technician");
  assert.ok(d.includes("roof inspection"), "type phrase");
  assert.ok(d.includes("Tri-Delta Warehouse"), "job name");
  assert.ok(d.includes("60-mil TPO"), "roof system");
  assert.ok(d.includes("Membrane / Field"), "deficient component named");
  assert.ok(d.includes("rated Poor"), "rating stated");
  assert.ok(d.includes("Drainage (incl. Ponding)"), "fair component named");
  assert.ok(d.includes("Open seam"), "finding condition");
  assert.ok(d.includes("Temporary seam patch"), "work performed");
  assert.ok(d.includes("2 photos"), "photo count");
  assert.ok(d.includes("Flashings & Terminations"), "good component named in clean bill");
});

test("composer is deterministic: same input -> byte-identical output", () => {
  const a = fn.composeTemplateSummary(fn.sanitizeReport(REPORT));
  const b = fn.composeTemplateSummary(fn.sanitizeReport(JSON.parse(JSON.stringify(REPORT))));
  assert.equal(a, b);
  assert.ok(a.length > 100, "draft has substance");
});

test("composer: all-Good inspection reads as a clean bill", () => {
  const d = fn.composeTemplateSummary(fn.sanitizeReport({
    woType: "Inspection", jobName: "Clean Roof Co", technician: "T",
    inspectionChecklist: [
      { label: "Membrane / Field", rating: "Good", notes: "" },
      { label: "Drainage (incl. Ponding)", rating: "Good", notes: "" }
    ],
    findings: [], repairs: [], photoCaptions: [], photoCount: 0
  }));
  assert.ok(d.includes("All inspected components were found in serviceable condition"));
  assert.ok(!d.includes("Deficiencies"));
});

test("composer: non-Inspection types get the warranty determination, Inspection never does", () => {
  const base = {
    jobName: "J", technician: "T", inspectionChecklist: [], findings: [], repairs: [],
    photoCaptions: [], photoCount: 0, warrantable: "Seam repair covered", nonWarrantable: "Ponding excluded"
  };
  const leak = fn.composeTemplateSummary(fn.sanitizeReport(Object.assign({}, base, { woType: "Leak / Service" })));
  assert.ok(leak.includes("leak investigation"));
  assert.ok(leak.includes("Warrantable: Seam repair covered"));
  assert.ok(leak.includes("Non-warrantable: Ponding excluded"));
  const insp = fn.composeTemplateSummary(fn.sanitizeReport(Object.assign({}, base, { woType: "Inspection" })));
  assert.ok(!insp.includes("Warrantable:"));
});

test("sanitizeReport re-clamps a hostile body server-side", () => {
  const r = fn.sanitizeReport({
    woType: "Inspection", jobName: "y".repeat(10000),
    inspectionChecklist: [{ label: "L", rating: "Poor", notes: "n".repeat(10000) }, { label: "", rating: "Poor" }, "junk", null],
    findings: Array.from({ length: 500 }, () => ({ condition: "c" })),
    photoCaptions: [123, "  ok  ", ""],
    photoCount: 99999
  });
  assert.equal(r.jobName.length, 200);
  assert.equal(r.inspectionChecklist.length, 1); // label-less + junk rows dropped
  assert.equal(r.inspectionChecklist[0].notes.length, 500);
  assert.equal(r.findings.length, 50);
  assert.deepEqual(r.photoCaptions, ["123", "ok"]);
  assert.equal(r.photoCount, 500);
  assert.equal(fn.sanitizeReport(null), null);
  assert.equal(fn.sanitizeReport("string"), null);
});
