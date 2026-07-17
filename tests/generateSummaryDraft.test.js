"use strict";
/* AI-drafted summary, Phase 1 scaffold (see "AI-drafted report summary" in
   DEV_NOTES.md). Guards the three promises the scaffold makes:

     1. The client payload builder (buildSummaryDraftPayload in
        js/workorders.js) projects summary-relevant text plus each photo's
        caption AND Storage ref (the vision path's handle — the server signs
        it, the client never does) — but never photo bytes, pins, GPS, ids,
        or signatures — maps checklist keys to labels, drops N/A rows and
        empty finding/repair rows, and clamps everything.
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
  repairDescription: "", repairItems: [],
  photos: [
    { img: "data:image/jpeg;base64,AAAA", caption: "Open seam at north lap", finding_id: "fnd_1", gps: { lat: 1, lng: 2 }, storageRef: "workorders/wo_123/0.jpg" },
    { img: "data:image/jpeg;base64,BBBB", caption: "  ", finding_id: null, gps: null } // captured this visit, not cloud-saved yet: no storageRef
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
  // Photos: caption + Storage ref (the vision path's handle — signed
  // server-side only). The unsaved photo (blank caption, no ref) is dropped;
  // photoCount still reflects everything on the order.
  assert.deepEqual(p.photos, [{ caption: "Open seam at north lap", storageRef: "workorders/wo_123/0.jpg" }]);
  assert.equal(p.photoCount, 2);
  // NOTHING heavy or sensitive leaves the client: no bytes, pins, ids, gps,
  // signature — the exact fields the future LLM prompt must never receive
  // accidentally. (storageRef is deliberately NOT on this list: it's the
  // photo's cloud path, not its bytes, and the vision call needs it.)
  const flat = JSON.stringify(p);
  ["img", "thumb", "base64", "pin", "gps", "fnd_1", "chk_1", "SIG", "signature"].forEach(tok => {
    assert.equal(flat.indexOf(tok), -1, "payload leaked: " + tok);
  });
});

test("payload carries Work Order (Repair) scope: description + itemized rows", () => {
  const p = buildSummaryDraftPayload({
    woType: "Repair", jobName: "Flat Branch Pub", technician: "J. Alvarez",
    repairDescription: "Remove and replace saturated insulation at the north drain sump.",
    repairItems: [
      { id: "ri_1", type: "TPO membrane patch", qty: "2", notes: "60-mil, north sump" },
      { id: "ri_2", type: " ", qty: "", notes: "" } // empty row a tech never filled
    ],
    repairs: [{ id: "rep_1", repair: "Replaced drain strainer", location: "North drain", pin: null }]
  });
  assert.equal(p.repairDescription, "Remove and replace saturated insulation at the north drain sump.");
  assert.deepEqual(p.repairItems, [{ type: "TPO membrane patch", qty: "2", notes: "60-mil, north sump" }]);
  assert.deepEqual(p.repairs, [{ repair: "Replaced drain strainer", location: "North drain" }]);
});

test("payload survives a sparse/legacy order (all arrays missing)", () => {
  const p = buildSummaryDraftPayload({ woType: "Inspection", jobName: "Old One" });
  assert.deepEqual(p.inspectionChecklist, []);
  assert.deepEqual(p.findings, []);
  assert.deepEqual(p.repairs, []);
  assert.deepEqual(p.repairItems, []);
  assert.deepEqual(p.photos, []);
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
  assert.equal(p.photos.length, 60);
});

/* ================= Part 2: server function (auth + composer) ================= */
const VALID_TECH = "VALID_TECH_TOKEN";     // field_tech: doc.generate === true
const VALID_NOPERM = "VALID_NOPERM_TOKEN"; // real user, role grants nothing

/* Storage stub: every getSignedUrl call is recorded so tests can assert the
   ONE signing invariant that matters — the stub path never signs; only a
   live provider call mints URLs. The returned URL carries X-Goog-Signature
   so it passes aiProvider's isSignedPhotoUrl gate, like a real V4 URL. */
const signedCalls = [];
const fakeAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp(cfg) { this.apps.push(cfg); return this; },
  storage() {
    return {
      bucket: () => ({
        file: (path) => ({
          getSignedUrl: async (opts) => {
            signedCalls.push({ path, opts });
            return ["https://storage.googleapis.com/fake/" + path + "?X-Goog-Signature=abc123"];
          }
        })
      })
    };
  },
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
// No AI key in the test env -> provider resolves to stub. The trap still
// stands for every stub-path test: WITHOUT a key there must be zero network.
// Live-path tests below temporarily swap in a mock fetch, then restore this.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.AI_PROVIDER;
const NETWORK_TRAP = async () => { throw new Error("REACHED AN EXTERNAL NETWORK CALL with no key configured"); };
global.fetch = NETWORK_TRAP;

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
    repairItems: [{ type: "t".repeat(9999), qty: "1", notes: "" }, "junk"],
    photos: [{ caption: "  ok  ", storageRef: "workorders/wo_1/0.jpg" }, { caption: 123 }],
    photoCount: 99999
  });
  assert.equal(r.jobName.length, 200);
  assert.equal(r.inspectionChecklist.length, 1); // label-less + junk rows dropped
  assert.equal(r.inspectionChecklist[0].notes.length, 500);
  assert.equal(r.findings.length, 50);
  assert.equal(r.repairItems.length, 1);
  assert.equal(r.repairItems[0].type.length, 120);
  assert.deepEqual(r.photos, [
    { caption: "ok", storageRef: "workorders/wo_1/0.jpg" },
    { caption: "123", storageRef: null }
  ]);
  assert.equal(r.photoCount, 500);
  assert.equal(fn.sanitizeReport(null), null);
  assert.equal(fn.sanitizeReport("string"), null);
});

test("sanitizeReport rejects any photo ref outside our own workorders/ tree", () => {
  const r = fn.sanitizeReport({
    woType: "Inspection",
    photos: [
      { caption: "traversal", storageRef: "workorders/../secrets/key.json" },
      { caption: "foreign bucket path", storageRef: "warranty_reports/b/x.pdf" },
      { caption: "absolute-ish", storageRef: "/workorders/wo_1/0.jpg" },
      { caption: "fine", storageRef: "workorders/wo_1/1.jpg" }
    ]
  });
  // Bad refs become null (caption still rides along); only the clean ref
  // survives as a signable path.
  assert.deepEqual(r.photos.map(p => p.storageRef), [null, null, null, "workorders/wo_1/1.jpg"]);
});

/* ---- Phase-1 seams: the LLM prompt and the signed-URL helper. Neither is
   reachable from the stub handler (the fetch trap above proves no network
   happens) — these pin down their contracts so wiring the key later is a
   transport change only. ---- */
test("buildLlmPrompt: grounded, draft-only, and length-tunable via the one constant", () => {
  const p = fn.buildLlmPrompt(fn.sanitizeReport(REPORT));
  assert.equal(typeof p, "string", "system prompt string (report JSON + images are aiProvider's job)");
  assert.ok(p.includes(String(fn.SUMMARY_TARGET_WORDS)), "word target comes from the constant");
  assert.ok(/never invent/i.test(p), "anti-fabrication instruction");
  assert.ok(/DRAFT/.test(p), "draft-only framing");
  assert.ok(/photo/i.test(p), "photos are part of the grounding instructions");
  // Style exemplar not supplied yet -> generic professional-voice fallback.
  assert.ok(/professional/i.test(p));
});

test("collectSignedPhotoUrls signs only clean workorders/ refs, short-lived, and never throws on a bad one", async () => {
  const signedCalls = [];
  const fakeBucket = {
    file: (path) => ({
      getSignedUrl: async (opts) => {
        if (path.indexOf("boom") !== -1) throw new Error("storage hiccup");
        signedCalls.push({ path, opts });
        return ["https://storage.example/signed/" + path];
      }
    })
  };
  const before = Date.now();
  const out = await fn.collectSignedPhotoUrls(fakeBucket, [
    { caption: "good", storageRef: "workorders/wo_1/0.jpg" },
    { caption: "traversal", storageRef: "workorders/../secrets/key.json" },
    { caption: "foreign", storageRef: "warranty_reports/b/x.pdf" },
    { caption: "no ref (unsaved photo)", storageRef: null },
    { caption: "signing fails", storageRef: "workorders/wo_1/boom.jpg" }
  ]);
  // Only the clean ref produced a URL; the failing one was skipped, not fatal.
  assert.deepEqual(out, [{ caption: "good", url: "https://storage.example/signed/workorders/wo_1/0.jpg" }]);
  assert.equal(signedCalls.length, 1);
  const o = signedCalls[0].opts;
  assert.equal(o.version, "v4");
  assert.equal(o.action, "read"); // read-only, never write/delete
  // Expiry is bounded: at most the default TTL from now (no long-lived URLs).
  assert.ok(o.expires <= before + fn.SIGNED_URL_TTL_MS + 60000, "expiry within default TTL");
  assert.ok(o.expires > before, "expiry in the future");
});

/* ---- Live-provider wiring (Phase 1). These tests set a fake key and mock
   fetch, then restore the no-key trap — proving the handler's stub/live
   switch, the vision plumbing (signed URL -> image block), the feature-tuned
   system prompt reaching the wire, and the fallback that keeps a roof-side
   flow alive through an API outage. ---- */
test("stub path (no key): drafts fine and NEVER mints a signed URL", async () => {
  signedCalls.length = 0;
  const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }, VALID_TECH));
  assert.equal(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.llm, false);
  assert.equal(out.source, "template_stub_v1");
  assert.equal(out.photosSeen, 0);
  assert.equal(signedCalls.length, 0, "no signing without a live model to consume the URL");
});

test("live path (key set): signs the photo, sends it + the tuned prompt, returns the model's draft", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-fake";
  const wireCalls = [];
  global.fetch = async (url, init) => {
    wireCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "LIVE DRAFT: seam repair summary." }] }) };
  };
  signedCalls.length = 0;
  try {
    const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }, VALID_TECH));
    assert.equal(r.statusCode, 200);
    const out = JSON.parse(r.body);
    assert.equal(out.ok, true);
    assert.equal(out.llm, true);
    assert.equal(out.source, "anthropic");
    assert.equal(out.draft, "LIVE DRAFT: seam repair summary.");
    assert.equal(out.photosSeen, 1);
    // The photo was signed (v4, read-only) and rode to the API as an image block.
    assert.equal(signedCalls.length, 1);
    assert.equal(signedCalls[0].path, "workorders/wo_123/0.jpg");
    assert.equal(signedCalls[0].opts.action, "read");
    assert.equal(wireCalls.length, 1);
    assert.ok(wireCalls[0].url.includes("api.anthropic.com"));
    const content = wireCalls[0].body.messages[0].content;
    const img = content.find(c => c.type === "image");
    assert.ok(img && /X-Goog-Signature/.test(img.source.url), "signed URL reached the model as an image block");
    // The feature-tuned system prompt (word target) is what went on the wire,
    // not aiProvider's generic default.
    assert.ok(wireCalls[0].body.system.includes(String(fn.SUMMARY_TARGET_WORDS)));
    // The key itself only ever appears in the auth header set by aiProvider —
    // never in the response body we hand the client.
    assert.ok(!r.body.includes("sk-test-fake"));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    global.fetch = NETWORK_TRAP;
  }
});

test("live path outage: provider error falls back to the template draft, flagged, still 200", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-fake";
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const r = await fn.handler(ev({ action: "draft_summary", report: REPORT }, VALID_TECH));
    assert.equal(r.statusCode, 200, "an AI outage must never dead-end the field flow");
    const out = JSON.parse(r.body);
    assert.equal(out.llm, false);
    assert.equal(out.fallback, true);
    assert.equal(out.source, "template_stub_v1");
    assert.equal(out.draft, fn.composeTemplateSummary(fn.sanitizeReport(REPORT)), "fallback IS the deterministic template");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    global.fetch = NETWORK_TRAP;
  }
});

test("composer covers the Work Order (Repair) scope fields", () => {
  const d = fn.composeTemplateSummary(fn.sanitizeReport({
    woType: "Repair", jobName: "Flat Branch Pub", technician: "J. Alvarez",
    repairDescription: "Remove and replace saturated insulation at the north drain sump.",
    repairItems: [{ type: "TPO membrane patch", qty: "2", notes: "60-mil, north sump" }],
    repairs: [{ repair: "Replaced drain strainer", location: "North drain" }],
    photoCount: 4
  }));
  assert.ok(d.includes("roof repair work"), "type phrase");
  assert.ok(d.includes("Scope of work: Remove and replace saturated insulation"), "scope description");
  assert.ok(d.includes("TPO membrane patch (qty 2)"), "itemized row");
  assert.ok(d.includes("Replaced drain strainer"), "work performed");
  assert.ok(d.includes("4 photos"), "photo count");
});
