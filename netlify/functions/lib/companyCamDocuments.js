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

// ============================ RULE EXCEPTION ==============================
// CREATE a CompanyCam project. RoofOps' standing hard rule is "never
// auto-create CompanyCam projects — link/push to existing ones only" (enforced
// structurally elsewhere: every other CompanyCam call is a GET or a POST to a
// sub-resource of a project id the caller already holds). Mark DELIBERATELY
// authorized this ONE create path for the Service Manager dispatch flow
// (2026-07-17): when a proposal is Foundation-linked and NO CompanyCam project
// matches the address, a service manager may create one via an explicit,
// permission-gated, audit-logged one-click action — NOT silent auto-create.
// The caller (companycam.js `create_project`) owns the permission gate + audit
// log; this function only performs the write. Uses the write token, mirrors
// uploadDocumentToCompanyCam()'s success-requires-an-id honesty.
async function createCompanyCamProject(name, address, coordinates) {
  const readToken = process.env.COMPANYCAM_TOKEN;
  const writeToken = process.env.COMPANYCAM_WRITE_TOKEN || readToken;
  if (!writeToken) {
    return { ok: false, error: "COMPANYCAM_WRITE_TOKEN (or COMPANYCAM_TOKEN) is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy." };
  }
  const nm = String(name || "").trim().slice(0, 150);
  if (!nm) return { ok: false, error: "Missing project name" };

  const headers = { "Authorization": "Bearer " + writeToken, "Accept": "application/json", "Content-Type": "application/json" };
  if (process.env.COMPANYCAM_USER_EMAIL) headers["X-CompanyCam-User"] = process.env.COMPANYCAM_USER_EMAIL;

  const project = { name: nm };
  if (address && typeof address === "object") {
    const a = {};
    if (address.street_address_1) a.street_address_1 = String(address.street_address_1).slice(0, 200);
    if (address.street_address_2) a.street_address_2 = String(address.street_address_2).slice(0, 200);
    if (address.city) a.city = String(address.city).slice(0, 100);
    if (address.state) a.state = String(address.state).slice(0, 50);
    if (address.postal_code) a.postal_code = String(address.postal_code).slice(0, 20);
    if (Object.keys(a).length) project.address = a;
  }
  if (coordinates && typeof coordinates.lat === "number" && typeof coordinates.lon === "number") {
    project.coordinates = { lat: coordinates.lat, lon: coordinates.lon };
  }

  try {
    const r = await fetch("https://api.companycam.com/v2/projects", {
      method: "POST", headers, body: JSON.stringify({ project })
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, error: "CompanyCam rejected the project: " + r.status + " " + t.slice(0, 300) };
    let out = null; try { out = JSON.parse(t); } catch (e) {}
    // Same honesty rule as uploadDocumentToCompanyCam: a 2xx WITHOUT an id is a
    // FAILURE, never a silent "created" with a null id (which would leave the WO
    // linked to nothing). Accept both {id,...} and {project:{id,...}} shapes.
    const projObj = (out && out.project && out.project.id) ? out.project : out;
    const projectId = (projObj && projObj.id) ? String(projObj.id) : null;
    if (!projectId) {
      return { ok: false, error: "CompanyCam returned " + r.status + " but no project id — treating as FAILED, not created. Body: " + String(t || "(empty)").slice(0, 300) };
    }
    return { ok: true, projectId: projectId, project: projObj, name: projObj.name || nm };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { uploadDocumentToCompanyCam, verifyDocumentOnCompanyCam, createCompanyCamProject };
