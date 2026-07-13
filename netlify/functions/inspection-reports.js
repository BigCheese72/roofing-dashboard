// Inspection-report ingestion: CCM Inspect (rogelio.ruiz@ccminspect.com)
// emails warranty inspection PDFs to marks@watkinsroofing.net; this files
// them onto the matching building's Warranty section and (when the
// building has a linked CompanyCam project) uploads a copy there too,
// reusing the exact upload path js/history.js's uploadPdfToCompanyCam()
// already uses for generated leak-report PDFs (companycam.js's
// upload_document action) -- no new CompanyCam-side code needed.
//
// Matching a report to the WRONG roof is explicitly worse than not filing
// it (Mark's framing) -- every match here is address-first, then name,
// both requiring a confident (near-exact) match; anything short of that
// goes to a review queue for a human to assign by hand. Nothing here ever
// guesses.
//
// Storage: every report gets its own copy in this app's Firebase Storage
// (buildings/{buildingId}/warranty_reports/{reportId}.pdf, or
// warranty_reports/pending/{itemId}.pdf while unmatched) -- the source of
// truth for RoofOps' own in-app viewer, independent of whether/how
// CompanyCam's upload succeeds. The CompanyCam copy is a best-effort
// second copy for Mark's existing CompanyCam-centric workflow, recorded
// on the report doc but never blocking the RoofOps-side filing.
//
// Idempotency: ingested_email_attachments/{deterministic id} is written
// once a Graph message+attachment pair has been turned into either a
// warranty_reports doc or a review-queue item -- checked before any work
// starts on a poll pass, so running the poller twice (scheduled + a manual
// tap landing close together, or a retried scheduled invocation) never
// double-files the same PDF.
// ---------------------------------------------------------------------
// AUTHENTICATION (rewritten 2026-07-13 -- the poller used to be PUBLIC)
// ---------------------------------------------------------------------
// This function previously treated a CALLER-SUPPLIED BODY FIELD as proof of
// identity:
//
//     const isScheduledInvocation = !!body.next_run;   // <-- anyone can type this
//     if (body.action === "poll" || isScheduledInvocation) {
//       if (!isScheduledInvocation) { await requirePermission(...) }
//
// Netlify's scheduler POSTs {"next_run": "..."} and cannot attach custom
// headers, so the field's presence was taken as "this must be Netlify". It
// isn't. A caller-supplied field is not authentication -- anyone on the
// internet could POST {"next_run":"x"} and drive the poller: read Mark's
// mailbox through Graph, pull attachments, write to Firestore/Storage/
// CompanyCam, and read attachment filenames and building ids back out of the
// response. Confirmed reachable: an anonymous POST reached the handler.
//
// There is no forgery-proof signal in a Netlify scheduled invocation -- the
// request carries nothing a stranger could not reproduce. So the scheduled
// path is now gated on a SHARED SECRET that Netlify holds and the internet
// does not (POLLER_SHARED_SECRET, sent as the x-roofops-poll-key header,
// compared with timingSafeEqual). Netlify's own cron cannot send that header,
// so the netlify.toml schedule is removed and the automated trigger moves to
// a caller that CAN authenticate (.github/workflows/poll-inspection-reports.yml).
//
// Rules now, without exception:
//   * NO action is reachable without a real, verified identity -- a Firebase
//     ID token, or the poll key. Not one.
//   * Identity is established BEFORE the body is parsed and BEFORE any config
//     check, so an unauthenticated caller cannot even learn which actions
//     exist, and the endpoint never depends on being misconfigured to be safe.
//   * Unauthenticated callers get a bare 401. No filenames, no building ids,
//     no "Unknown action" telling them the handler ran.
const crypto = require("crypto");
const { getDb, getAdmin, verifyCaller, getPermissionValue, hostnameFromEvent } = require("./lib/authGuard");
const { graphFetch, requireEnv: requireGraphEnv } = require("./lib/graphAuth");
const { extractAddressCandidates } = require("./lib/textMatch");
const { matchBuilding } = require("./lib/buildingMatch");
const { uploadDocumentToCompanyCam } = require("./lib/companyCamDocuments");

const CCM_SENDER = "rogelio.ruiz@ccminspect.com";
const REVISION_WORDS = /\b(revised|corrected|updated|amended|resupersede|resupercedes)\b/i;
const REVISION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- see supersede logic below

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Deliberately opaque. An unauthenticated caller learns nothing from us --
// not which actions exist, not whether the handler ran, not how it's
// configured.
const UNAUTHORIZED = { error: "Unauthorized" };

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  // Length is not secret (and timingSafeEqual throws on a length mismatch),
  // but the CONTENT comparison must not short-circuit on the first differing
  // byte -- that's what leaks a secret one character at a time.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// The ONLY non-human caller allowed in. Holds a secret Netlify has and the
// internet does not. Fails closed in every degenerate case: env var unset,
// env var too weak to be a real secret, header absent, header wrong.
const MIN_POLL_KEY_LEN = 32;
function hasValidPollKey(event) {
  const expected = process.env.POLLER_SHARED_SECRET;
  if (!expected || String(expected).length < MIN_POLL_KEY_LEN) return false;
  const h = (event && event.headers) || {};
  const given = h["x-roofops-poll-key"] || h["X-RoofOps-Poll-Key"] || "";
  if (!given) return false;
  return timingSafeEqualStr(given, expected);
}

// Permission check against an already-verified caller, so we don't re-verify
// the ID token once per action. Mirrors requirePermission()'s semantics
// exactly: owner passes everything; otherwise the LIVE roles/{roleId} doc must
// grant the key unconditionally (true -- a "proj"/"own"/"billing" scoped value
// does not satisfy it).
async function callerHas(caller, permKey) {
  if (!caller) return false;
  if (caller.owner) return true;
  return (await getPermissionValue(caller.role, permKey)) === true;
}

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function sanitizeIdPart(s) {
  return String(s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}
async function writeAudit(db, entry) {
  try {
    await db.collection("audit_logs").doc().set(Object.assign({ ts: Date.now() }, entry));
  } catch (e) { /* never let an audit-log failure block the real action */ }
}

async function getBucket(hostname) {
  return getAdmin(hostname).storage().bucket();
}

// ---- Matching: address first, then name, both confident-only. Loads
// every non-archived building with a name/location, since a report could
// legitimately belong to a building with no CompanyCam project yet (still
// filed in RoofOps, CompanyCam upload just gets skipped -- see below). ----
async function loadCandidateBuildings(db) {
  const snap = await db.collection("buildings").get();
  const out = [];
  snap.forEach(d => {
    const v = d.data();
    if (v.archived) return;
    out.push({
      id: d.id, name: v.name || "", location: v.location || "",
      companyCamProjectId: v.companyCamProjectId || null
    });
  });
  return out;
}
// ---- Filing: stores the PDF in our own Storage, best-effort-uploads to
// CompanyCam if a project is linked, applies supersede logic, writes the
// warranty_reports doc + audit entry. Shared by the poller, manual upload,
// and review-queue assignment so all three paths behave identically. ----
async function fileReport(db, hostname, opts) {
  // opts: { buildingId, fileName, base64, byteSize, sourceType, sourceEmailId,
  //   sourceEmailSubject, sourceAttachmentId, matchMethod, matchedText,
  //   actorUid, actorLabel, supersedesReportId (optional, manual only) }
  const bldSnap = await db.collection("buildings").doc(opts.buildingId).get();
  if (!bldSnap.exists) return { ok: false, error: "Building not found" };
  const bld = bldSnap.data();
  const reportId = genId("wr");
  const storagePath = "warranty_reports/" + opts.buildingId + "/" + reportId + ".pdf";

  const bucket = await getBucket(hostname);
  const buf = Buffer.from(opts.base64, "base64");
  await bucket.file(storagePath).save(buf, { contentType: "application/pdf", resumable: false });

  let ccResult = { ok: false, error: null };
  let ccStatus = "skipped_no_project";
  if (bld.companyCamProjectId) {
    ccResult = await uploadDocumentToCompanyCam(bld.companyCamProjectId, opts.fileName, opts.base64);
    ccStatus = ccResult.ok ? "uploaded" : "failed";
  }

  // Supersede: fileReport() itself never decides this -- callers resolve
  // supersedesReportId beforehand, either explicitly (manual upload with a
  // human picking a report to replace) or via resolveSupersedes()'s
  // keyword+recency heuristic (the poller, and review-queue assignment).
  let supersedes = null;
  if (opts.supersedesReportId) {
    const oldRef = db.collection("buildings").doc(opts.buildingId).collection("warranty_reports").doc(opts.supersedesReportId);
    const oldSnap = await oldRef.get();
    if (oldSnap.exists) {
      await oldRef.set({ status: "superseded", supersededBy: reportId, updatedAt: Date.now() }, { merge: true });
      supersedes = opts.supersedesReportId;
    }
  }

  const doc = {
    id: reportId, buildingId: opts.buildingId, fileName: opts.fileName,
    storageRef: storagePath, byteSize: opts.byteSize || buf.length,
    companyCamProjectId: bld.companyCamProjectId || null,
    companyCamDocumentId: ccResult.documentId || null,
    companyCamDocumentUrl: ccResult.url || null,
    companyCamUploadStatus: ccStatus,
    companyCamUploadError: ccResult.error || null,
    sourceType: opts.sourceType, sourceEmailId: opts.sourceEmailId || null,
    sourceEmailSubject: opts.sourceEmailSubject || null, sourceAttachmentId: opts.sourceAttachmentId || null,
    matchMethod: opts.matchMethod, matchedText: opts.matchedText || null,
    inspectionDate: opts.inspectionDate || null,
    uploadedAt: Date.now(), uploadedBy: opts.actorLabel,
    status: "active", supersedes: supersedes, supersededBy: null
  };
  await db.collection("buildings").doc(opts.buildingId).collection("warranty_reports").doc(reportId).set(doc);
  await writeAudit(db, {
    actorUid: opts.actorUid, actorRole: opts.actorLabel, action: "warranty_report_filed",
    target: { collection: "buildings", id: opts.buildingId, subcollection: "warranty_reports", reportDocId: reportId },
    before: null,
    after: {
      fileName: opts.fileName, sourceType: opts.sourceType, matchMethod: opts.matchMethod,
      companyCamUploadStatus: ccStatus, supersedes: supersedes
    },
    // Full matching provenance: what it matched, what it rejected, and why.
    // Present on every filed report (email-matched, manual, or review-queue
    // assignment) so a wrong filing can always be traced back to the decision
    // that produced it. null for paths where a human chose the building.
    matchDecision: opts.matchDecision || null
  });
  return { ok: true, reportId, companyCamUploadStatus: ccStatus, companyCamUploadError: ccResult.error || null };
}

// A report is auto-superseded only when BOTH: (a) the source email subject
// contains an explicit revision word ("revised"/"corrected"/etc -- never
// guessed from content, only from what CCM Inspect itself wrote), AND
// (b) there's already an active report on the SAME building filed within
// the last 30 days (a genuine same-inspection correction arrives close
// together in time; a routine next annual inspection does not). Anything
// short of both conditions files as a brand-new, separate report -- the
// default and by far the common case, per Mark's explicit "do NOT
// overwrite... keep them all, dated."
async function resolveSupersedes(db, buildingId, subject) {
  if (!REVISION_WORDS.test(subject || "")) return null;
  const cutoff = Date.now() - REVISION_WINDOW_MS;
  const snap = await db.collection("buildings").doc(buildingId).collection("warranty_reports")
    .where("status", "==", "active").orderBy("uploadedAt", "desc").limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  if ((doc.data().uploadedAt || 0) < cutoff) return null;
  return doc.id;
}

// ---- Email polling ----
// Fetches every message from the CCM Inspect sender.
//
// The original query combined $filter on from/emailAddress/address with
// $orderby=receivedDateTime desc. Microsoft Graph REJECTS that combination:
//
//   400 InefficientFilter: "The restriction or sort order is too complex
//                           for this operation."
//
// Graph will not sort on one property while filtering on a nested one, so the
// poller's very first Graph call failed every time -- it could never have
// pulled a single report. This was invisible until the credentials were fixed:
// before that it died at token acquisition and never reached the query.
//
// $orderby is dropped rather than worked around. Sort order was only ever
// cosmetic here: every matching message is processed, and
// ingested_email_attachments makes re-processing a no-op, so the ORDER in which
// they arrive changes nothing. Losing the sort would only matter if we relied
// on $top to keep just the newest N -- so we don't: we page through
// @odata.nextLink instead and look at all of them (bounded, so a runaway
// mailbox can't spin forever).
const MAX_POLL_PAGES = 5;
const POLL_PAGE_SIZE = 50;

async function fetchCcmMessages(mailbox) {
  const filter = "from/emailAddress/address eq '" + CCM_SENDER.replace(/'/g, "''") + "'";
  let url = "/users/" + encodeURIComponent(mailbox) + "/messages?$filter=" + encodeURIComponent(filter) +
    "&$top=" + POLL_PAGE_SIZE + "&$select=id,subject,receivedDateTime,hasAttachments";

  const all = [];
  for (let page = 0; page < MAX_POLL_PAGES && url; page++) {
    const r = await graphFetch(url);
    const t = await r.text();
    if (!r.ok) return { ok: false, error: "Graph said: " + r.status + " " + t.slice(0, 500) };
    let json;
    try { json = JSON.parse(t); } catch (e) { return { ok: false, error: "Graph response was not valid JSON" }; }
    (json.value || []).forEach(m => all.push(m));
    url = json["@odata.nextLink"] || null;
  }
  return { ok: true, messages: all };
}

async function pollOnce(db, hostname, actorUid, actorLabel) {
  const { mailbox } = requireGraphEnv(); // throws with a clear message if GRAPH_* env vars aren't set

  const fetched = await fetchCcmMessages(mailbox);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const messages = fetched.messages.filter(m => m.hasAttachments);

  const summary = { checked: messages.length, filed: [], queued: [], skippedAlreadyProcessed: 0, errors: [] };
  const buildings = await loadCandidateBuildings(db);

  for (const msg of messages) {
    let attachments;
    try {
      const ar = await graphFetch("/users/" + encodeURIComponent(mailbox) + "/messages/" + encodeURIComponent(msg.id) + "/attachments");
      const at = await ar.text();
      if (!ar.ok) { summary.errors.push({ messageId: msg.id, error: "attachments fetch failed: " + ar.status }); continue; }
      attachments = (JSON.parse(at).value || []);
    } catch (e) { summary.errors.push({ messageId: msg.id, error: e.message }); continue; }

    for (const att of attachments) {
      if (att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
      const isPdf = (att.contentType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(att.name || "");
      if (!isPdf || !att.contentBytes) continue;

      const idemId = sanitizeIdPart(msg.id) + "__" + sanitizeIdPart(att.id);
      const idemRef = db.collection("ingested_email_attachments").doc(idemId);
      if ((await idemRef.get()).exists) { summary.skippedAlreadyProcessed++; continue; }

      try {
        const candidateText = (msg.subject || "") + " " + (att.name || "");
        const match = matchBuilding(buildings, candidateText);

        if (match.building) {
          const supersedesId = await resolveSupersedes(db, match.building.id, msg.subject);
          const fileResult = await fileReport(db, hostname, {
            buildingId: match.building.id, fileName: att.name || "InspectionReport.pdf",
            base64: att.contentBytes, byteSize: att.size || null,
            sourceType: "email", sourceEmailId: msg.id, sourceEmailSubject: msg.subject || "",
            sourceAttachmentId: att.id, matchMethod: match.method, matchedText: match.matchedText,
            actorUid: actorUid || "email-poller", actorLabel: actorLabel || "email-poller",
            supersedesReportId: supersedesId, matchDecision: match.decision
          });
          await idemRef.set({ outcome: "filed", buildingId: match.building.id, reportId: fileResult.reportId, processedAt: Date.now() });
          summary.filed.push({ messageId: msg.id, attachmentName: att.name, buildingId: match.building.id, method: match.method });
        } else {
          const itemId = genId("wq");
          const storagePath = "warranty_reports/pending/" + itemId + ".pdf";
          const bucket = await getBucket(hostname);
          await bucket.file(storagePath).save(Buffer.from(att.contentBytes, "base64"), { contentType: "application/pdf", resumable: false });
          const addrCandidates = extractAddressCandidates(candidateText);
          await db.collection("warranty_review_queue").doc(itemId).set({
            id: itemId, fileName: att.name || "InspectionReport.pdf", storageRef: storagePath,
            byteSize: att.size || null, sourceEmailId: msg.id, sourceEmailSubject: msg.subject || "",
            sourceAttachmentId: att.id, extractedAddress: addrCandidates[0] || null,
            extractedName: null, matchReason: match.method, status: "pending",
            // Carried onto the queue item so the review UI can show Mark WHY
            // this landed here -- and which buildings were considered and
            // rejected -- instead of presenting a bare unexplained PDF.
            matchDecision: match.decision || null,
            createdAt: Date.now(), resolvedAt: null, resolvedBy: null, resolvedReportId: null
          });
          await idemRef.set({ outcome: "queued", reviewItemId: itemId, processedAt: Date.now() });
          await writeAudit(db, {
            actorUid: actorUid || "email-poller", actorRole: actorLabel || "email-poller",
            action: "warranty_report_queued_for_review",
            target: { collection: "warranty_review_queue", id: itemId },
            before: null, after: { sourceEmailSubject: msg.subject || "", reason: match.method },
            matchDecision: match.decision || null
          });
          summary.queued.push({ messageId: msg.id, attachmentName: att.name, reason: match.method });
        }
      } catch (e) {
        summary.errors.push({ messageId: msg.id, attachmentName: att.name, error: e.message });
      }
    }
  }
  return { ok: true, summary };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });

  // ================= IDENTITY FIRST =================
  // Before the body is parsed. Before any config check. Before Firestore.
  // Exactly two callers can get past this line:
  //   1. the automated poller, holding POLLER_SHARED_SECRET, or
  //   2. a signed-in RoofOps user with a valid Firebase ID token.
  // Everyone else gets a bare 401 and learns nothing.
  const isPoller = hasValidPollKey(event);
  let caller = null;
  if (!isPoller) {
    try {
      caller = await verifyCaller(event);
    } catch (e) {
      // Genuine 401/403 -> opaque. Anything else (e.g. the authGuard project
      // safety guard tripping) is a real server fault and must surface with
      // its real message, exactly as it does elsewhere.
      if (e.statusCode === 401 || e.statusCode === 403) return resp(401, UNAUTHORIZED);
      throw e;
    }
  }
  // =================================================

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  const hostname = hostnameFromEvent(event);

  try {
    const db = getDb(hostname);

    // Every action below needs warranty.manage_reports, EXCEPT get_report_pdf,
    // which only needs a signed-in user (a field tech opening a warranty PDF on
    // a roof is normal field use -- see that action for the full reasoning).
    // The poller is trusted for the poll action only.
    const MANAGE = "warranty.manage_reports";
    const canManage = isPoller ? false : await callerHas(caller, MANAGE);

    // ---- poll: run by the automated poller (holding POLLER_SHARED_SECRET) or
    // by a human with warranty.manage_reports clicking "Check for New
    // Inspection Reports". body.next_run is now IGNORED ENTIRELY -- it is
    // caller-supplied text and proves nothing about who is calling. ----
    if (body.action === "poll") {
      let actorUid, actorLabel;
      if (isPoller) {
        actorUid = "email-poller"; actorLabel = "email-poller (scheduled)";
      } else if (canManage) {
        actorUid = caller.uid; actorLabel = caller.owner ? "owner" : caller.role;
      } else {
        return resp(403, { error: "Forbidden" });
      }
      const result = await pollOnce(db, hostname, actorUid, actorLabel);
      if (!result.ok) return resp(502, { error: result.error });
      return resp(200, { ok: true, summary: result.summary });
    }

    // Past this point the poll key grants nothing. It exists to run the
    // poller, not to be a skeleton key for the rest of the API.
    if (isPoller) return resp(403, { error: "Forbidden" });

    // ---- manual_upload: Mark uploads a PDF he already has directly onto a
    // building, same filing path as an auto-matched email (Storage +
    // best-effort CompanyCam), just skipping the matching step entirely --
    // he's already telling us which building. Optional supersedesReportId
    // lets him explicitly mark this as replacing a specific existing
    // report, instead of the poller's keyword-guessing heuristic (which
    // doesn't apply here -- there's a human right here making the call). ----
    if (body.action === "manual_upload") {
      if (!canManage) return resp(403, { error: "Forbidden" });

      const buildingId = String(body.buildingId || "");
      const base64 = String(body.base64 || "");
      const fileName = String(body.fileName || "InspectionReport.pdf").slice(0, 150);
      if (!buildingId) return resp(400, { error: "Missing buildingId" });
      if (!base64) return resp(400, { error: "Missing base64" });
      if (base64.length > 42000000) return resp(413, { error: "PDF too large (limit ~30MB)" });
      const supersedesReportId = body.supersedesReportId ? String(body.supersedesReportId) : null;

      const result = await fileReport(db, hostname, {
        buildingId, fileName, base64, byteSize: null,
        sourceType: "manual", sourceEmailId: null, sourceEmailSubject: null, sourceAttachmentId: null,
        matchMethod: "manual", matchedText: null,
        actorUid: caller.uid, actorLabel: caller.owner ? "owner" : caller.role,
        supersedesReportId
      });
      if (!result.ok) return resp(400, { error: result.error });
      return resp(200, result);
    }

    // ---- list_review_queue ----
    if (body.action === "list_review_queue") {
      if (!canManage) return resp(403, { error: "Forbidden" });
      const snap = await db.collection("warranty_review_queue").where("status", "==", "pending")
        .orderBy("createdAt", "desc").limit(100).get();
      const items = []; snap.forEach(d => items.push(d.data()));
      return resp(200, { items });
    }

    // ---- assign_review_item: human picks the building; moves the staged
    // PDF into fileReport()'s normal path (Storage + best-effort
    // CompanyCam), same as every other filing route. ----
    if (body.action === "assign_review_item") {
      if (!canManage) return resp(403, { error: "Forbidden" });

      const itemId = String(body.itemId || "");
      const buildingId = String(body.buildingId || "");
      if (!itemId || !buildingId) return resp(400, { error: "Missing itemId or buildingId" });
      const itemRef = db.collection("warranty_review_queue").doc(itemId);
      const itemSnap = await itemRef.get();
      if (!itemSnap.exists) return resp(404, { error: "Review item not found" });
      const item = itemSnap.data();
      if (item.status !== "pending") return resp(409, { error: "Already resolved" });

      const bucket = await getBucket(hostname);
      const [buf] = await bucket.file(item.storageRef).download();
      const base64 = buf.toString("base64");

      const supersedesReportId = await resolveSupersedes(db, buildingId, item.sourceEmailSubject);
      const result = await fileReport(db, hostname, {
        buildingId, fileName: item.fileName, base64, byteSize: item.byteSize,
        sourceType: "email", sourceEmailId: item.sourceEmailId, sourceEmailSubject: item.sourceEmailSubject,
        sourceAttachmentId: item.sourceAttachmentId, matchMethod: "manual_review", matchedText: null,
        actorUid: caller.uid, actorLabel: caller.owner ? "owner" : caller.role,
        supersedesReportId
      });
      if (!result.ok) return resp(400, { error: result.error });

      await itemRef.set({ status: "resolved", resolvedAt: Date.now(), resolvedBy: caller.uid, resolvedReportId: result.reportId }, { merge: true });
      await bucket.file(item.storageRef).delete({ ignoreNotFound: true });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: caller.owner ? "owner" : caller.role,
        action: "warranty_review_item_assigned",
        target: { collection: "warranty_review_queue", id: itemId },
        before: { status: "pending" }, after: { buildingId, reportId: result.reportId }
      });
      return resp(200, result);
    }

    // ---- dismiss_review_item: junk/false-positive, discard without filing
    // anywhere -- a real triage outcome, not just a one-way queue. ----
    if (body.action === "dismiss_review_item") {
      if (!canManage) return resp(403, { error: "Forbidden" });
      const itemId = String(body.itemId || "");
      if (!itemId) return resp(400, { error: "Missing itemId" });
      const itemRef = db.collection("warranty_review_queue").doc(itemId);
      const itemSnap = await itemRef.get();
      if (!itemSnap.exists) return resp(404, { error: "Review item not found" });
      const item = itemSnap.data();
      const bucket = await getBucket(hostname);
      await bucket.file(item.storageRef).delete({ ignoreNotFound: true });
      await itemRef.set({ status: "dismissed", resolvedAt: Date.now(), resolvedBy: caller.uid }, { merge: true });
      await writeAudit(db, {
        actorUid: caller.uid, actorRole: caller.owner ? "owner" : caller.role,
        action: "warranty_review_item_dismissed",
        target: { collection: "warranty_review_queue", id: itemId },
        before: { status: "pending" }, after: { status: "dismissed" }
      });
      return resp(200, { ok: true });
    }

    // ---- get_report_pdf: the ONE action that does not require
    // warranty.manage_reports -- a field tech standing on a roof opening the
    // warranty report for that roof is the entire point of this feature, and
    // a tech does not hold manage_reports. So: any SIGNED-IN user may read a
    // report PDF.
    //
    // It is no longer ANONYMOUS, though, which it used to be. Previously any
    // stranger with a storageRef could pull a customer's warranty document
    // straight out of Storage with no token at all -- security by unguessable
    // filename, which is not security. Authentication is now required; the
    // permission is not. That keeps the roof-side use case working while
    // closing the open door. ----
    if (body.action === "get_report_pdf") {
      // caller is guaranteed non-null here: isPoller was rejected above, and
      // an unauthenticated request never got past the identity gate.
      const storageRef = String(body.storageRef || "");
      if (!storageRef || storageRef.indexOf("warranty_reports/") !== 0) return resp(400, { error: "Invalid storageRef" });
      const bucket = await getBucket(hostname);
      const file = bucket.file(storageRef);
      const [exists] = await file.exists();
      if (!exists) return resp(404, { error: "Report PDF not found in storage" });
      const [buf] = await file.download();
      return resp(200, { ok: true, dataUrl: "data:application/pdf;base64," + buf.toString("base64") });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(e.statusCode || 500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
