// The one write path companycam.js has ever had: POST a base64 PDF to a
// CompanyCam project's Documents endpoint. Extracted out of companycam.js
// so inspection-reports.js's warranty-report filing can call the exact
// same code (not a re-implementation) that js/history.js's
// uploadPdfToCompanyCam() has been using successfully for generated
// leak-report PDFs -- Mark's explicit instruction when this feature was
// specced: reuse that path, don't write a new uploader.
async function uploadDocumentToCompanyCam(projectId, name, attachmentBase64) {
  const readToken = process.env.COMPANYCAM_TOKEN;
  const writeToken = process.env.COMPANYCAM_WRITE_TOKEN || readToken;
  if (!writeToken) {
    return { ok: false, error: "COMPANYCAM_WRITE_TOKEN (or COMPANYCAM_TOKEN) is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy." };
  }
  const id = String(projectId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return { ok: false, error: "Missing project_id" };
  if (!attachmentBase64) return { ok: false, error: "Missing attachment" };
  if (attachmentBase64.length > 42000000) return { ok: false, error: "PDF too large for CompanyCam upload (limit ~30MB)" };

  const headers = { "Authorization": "Bearer " + writeToken, "Accept": "application/json", "Content-Type": "application/json" };
  if (process.env.COMPANYCAM_USER_EMAIL) headers["X-CompanyCam-User"] = process.env.COMPANYCAM_USER_EMAIL;
  try {
    const r = await fetch("https://api.companycam.com/v2/projects/" + id + "/documents", {
      method: "POST",
      headers,
      body: JSON.stringify({ document: { name: String(name || "Document.pdf").slice(0, 150), attachment: attachmentBase64 } })
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, error: "CompanyCam rejected the document: " + r.status + " " + t.slice(0, 300) };
    let out = null; try { out = JSON.parse(t); } catch (e) {}
    // Mark's Flat Branch bug (workorders/wo_1784122808661): a 2xx whose body
    // couldn't be parsed, or whose shape didn't carry an id where we looked,
    // used to return ok:true with documentId:null — the client then recorded
    // companyCamUploadStatus:"saved" with NO artifact anywhere. Success now
    // REQUIRES a document id: accept both response shapes ({id,...} and
    // {document:{id,...}}), and anything 2xx WITHOUT an id is reported as a
    // failure carrying the raw body, never as saved.
    const docObj = (out && out.document && out.document.id) ? out.document : out;
    const documentId = (docObj && docObj.id) ? String(docObj.id) : null;
    if (!documentId) {
      return { ok: false, error: "CompanyCam returned " + r.status + " but no document id — treating the upload as FAILED, not saved. Body: " + String(t || "(empty)").slice(0, 300) };
    }
    return { ok: true, document: docObj, documentId: documentId, url: docObj.url || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Artifact-truth verification (Sophia's Curb Flashing false negative, Job
// 17476 / wo_1784203041457): a transient client-side "Load failed" was
// recorded as a FINAL "failed" status while the document was demonstrably
// on CompanyCam (the work order holds its ccDocumentId). This read-only
// check lets the client reconcile a stale "failed" to "saved" — or a stale
// id to genuinely-gone — from the source of truth instead of the last
// fetch's luck. READ token; never mutates anything.
async function verifyDocumentOnCompanyCam(documentId) {
  const readToken = process.env.COMPANYCAM_TOKEN;
  if (!readToken) return { ok: false, error: "COMPANYCAM_TOKEN is not set." };
  const id = String(documentId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return { ok: false, error: "Missing document_id" };
  try {
    const r = await fetch("https://api.companycam.com/v2/documents/" + id, {
      headers: { "Authorization": "Bearer " + readToken, "Accept": "application/json" }
    });
    if (r.status === 404) return { ok: true, exists: false };
    if (!r.ok) return { ok: false, error: "CompanyCam document check failed: " + r.status };
    return { ok: true, exists: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { uploadDocumentToCompanyCam, verifyDocumentOnCompanyCam };
