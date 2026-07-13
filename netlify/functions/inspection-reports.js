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
const { getDb, getAdmin, requirePermission, hostnameFromEvent } = require("./lib/authGuard");
const { graphFetch, requireEnv: requireGraphEnv } = require("./lib/graphAuth");
const { normalizeText, normalizeAddress, isConfidentContainmentMatch, extractAddressCandidates } = require("./lib/textMatch");
const { uploadDocumentToCompanyCam } = require("./lib/companyCamDocuments");

const CCM_SENDER = "rogelio.ruiz@ccminspect.com";
const REVISION_WORDS = /\b(revised|corrected|updated|amended|resupersede|resupercedes)\b/i;
const REVISION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- see supersede logic below

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
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
function matchBuilding(buildings, candidateText) {
  const addrCandidates = extractAddressCandidates(candidateText).map(normalizeAddress).filter(Boolean);
  const addrMatches = [];
  buildings.forEach(b => {
    const bAddr = normalizeAddress(b.location);
    if (!bAddr) return;
    if (addrCandidates.some(c => isConfidentContainmentMatch(c, bAddr))) addrMatches.push(b);
  });
  const uniqueAddr = dedupeById(addrMatches);
  if (uniqueAddr.length === 1) return { building: uniqueAddr[0], method: "address", matchedText: addrCandidates.join(" | ") };
  if (uniqueAddr.length > 1) return { building: null, method: "ambiguous_address", matchedText: addrCandidates.join(" | ") };

  const normCandidate = normalizeText(candidateText);
  const nameMatches = buildings.filter(b => {
    const bName = normalizeText(b.name);
    return bName && bName.length >= 4 && normCandidate.indexOf(bName) !== -1;
  });
  const uniqueName = dedupeById(nameMatches);
  if (uniqueName.length === 1) return { building: uniqueName[0], method: "name", matchedText: uniqueName[0].name };
  if (uniqueName.length > 1) return { building: null, method: "ambiguous_name", matchedText: normCandidate };

  return { building: null, method: "no_match", matchedText: normCandidate };
}
function dedupeById(list) {
  const seen = new Set(); const out = [];
  list.forEach(b => { if (!seen.has(b.id)) { seen.add(b.id); out.push(b); } });
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
    }
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
async function pollOnce(db, hostname, actorUid, actorLabel) {
  const { mailbox } = requireGraphEnv(); // throws with a clear message if GRAPH_* env vars aren't set
  const filter = "from/emailAddress/address eq '" + CCM_SENDER.replace(/'/g, "''") + "'";
  const url = "/users/" + encodeURIComponent(mailbox) + "/messages?$filter=" + encodeURIComponent(filter) +
    "&$top=25&$orderby=receivedDateTime desc&$select=id,subject,receivedDateTime,hasAttachments";
  const r = await graphFetch(url);
  const t = await r.text();
  if (!r.ok) {
    return { ok: false, error: "Graph said: " + r.status + " " + t.slice(0, 500) };
  }
  const json = JSON.parse(t);
  const messages = (json.value || []).filter(m => m.hasAttachments);

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
            supersedesReportId: supersedesId
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
            createdAt: Date.now(), resolvedAt: null, resolvedBy: null, resolvedReportId: null
          });
          await idemRef.set({ outcome: "queued", reviewItemId: itemId, processedAt: Date.now() });
          await writeAudit(db, {
            actorUid: actorUid || "email-poller", actorRole: actorLabel || "email-poller",
            action: "warranty_report_queued_for_review",
            target: { collection: "warranty_review_queue", id: itemId },
            before: null, after: { sourceEmailSubject: msg.subject || "", reason: match.method }
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
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad request" }); }

  const hostname = hostnameFromEvent(event);

  try {
    const db = getDb(hostname);

    // Netlify's scheduled-function invocation POSTs a body containing
    // next_run and nothing else -- there's no way to attach custom headers
    // to that auto-invocation, so its presence IS the "this is Netlify's
    // own scheduler" signal. Anything else (the manual "Check Now" button,
    // or a bare curl) must carry a real, permission-checked caller token.
    const isScheduledInvocation = !!body.next_run;
    if (body.action === "poll" || isScheduledInvocation) {
      let actorUid = "email-poller", actorLabel = "email-poller (scheduled)";
      if (!isScheduledInvocation) {
        let caller;
        try { caller = await requirePermission(event, "warranty.manage_reports"); }
        catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
        actorUid = caller.uid; actorLabel = caller.owner ? "owner" : caller.role;
      }
      const result = await pollOnce(db, hostname, actorUid, actorLabel);
      if (!result.ok) return resp(502, { error: result.error });
      return resp(200, { ok: true, summary: result.summary });
    }

    // ---- manual_upload: Mark uploads a PDF he already has directly onto a
    // building, same filing path as an auto-matched email (Storage +
    // best-effort CompanyCam), just skipping the matching step entirely --
    // he's already telling us which building. Optional supersedesReportId
    // lets him explicitly mark this as replacing a specific existing
    // report, instead of the poller's keyword-guessing heuristic (which
    // doesn't apply here -- there's a human right here making the call). ----
    if (body.action === "manual_upload") {
      let caller;
      try { caller = await requirePermission(event, "warranty.manage_reports"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

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
      try { await requirePermission(event, "warranty.manage_reports"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
      const snap = await db.collection("warranty_review_queue").where("status", "==", "pending")
        .orderBy("createdAt", "desc").limit(100).get();
      const items = []; snap.forEach(d => items.push(d.data()));
      return resp(200, { items });
    }

    // ---- assign_review_item: human picks the building; moves the staged
    // PDF into fileReport()'s normal path (Storage + best-effort
    // CompanyCam), same as every other filing route. ----
    if (body.action === "assign_review_item") {
      let caller;
      try { caller = await requirePermission(event, "warranty.manage_reports"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }

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
      let caller;
      try { caller = await requirePermission(event, "warranty.manage_reports"); }
      catch (e) { return resp(e.statusCode || 401, { error: e.message }); }
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

    // ---- get_report_pdf: same open, ungated read tier as photos.js's
    // "get" action -- viewing a warranty PDF on the roof is normal field
    // use, not a privileged action, matching the collection's own open
    // read rule in firestore.rules. ----
    if (body.action === "get_report_pdf") {
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
