// Proxy to the CompanyCam API. The token is read from the
// COMPANYCAM_TOKEN environment variable in Netlify settings and never
// reaches the browser. Mostly read-only; the one write path is
// action=upload_document (POST), used to save a generated work order
// PDF back into the CompanyCam project it came from.
//
// Known API limitation (see DEV_NOTES.md): CompanyCam's v2 API exposes
// Projects and Photos/Documents, but not a general "activity log" or
// full historical audit trail. History sync in this app is therefore
// limited to project metadata + photo/document metadata (ids, URLs,
// timestamps) — it cannot pull things like who-changed-what or deleted
// items.
//
// AUTHENTICATION (2026-07-13): every action here -- both the GET read
// actions and the POST write -- is now gated on a VERIFIED Firebase ID
// token. This proxy previously had NO gate whatsoever, which meant anyone
// on the internet, with no token, could enumerate every CompanyCam project
// (names AND customer addresses), read jobsite photos, use `action=image`
// as an open image proxy, and `upload_document` INTO Mark's CompanyCam
// account -- all on Mark's own COMPANYCAM_TOKEN, which never leaves the
// server and so was effectively lent to the entire internet.
//
// The gate is AUTHENTICATION, not permission: any signed-in Watkins user
// passes, because every one of these is a normal field operation a tech
// does constantly (import photos, link a project, save a PDF back). It must
// NOT become a role/permission check. verifyCaller() proves WHO you are and
// throws 401 if you're nobody; requirePermission() is the role-gate and is
// deliberately NOT used here.
const { uploadDocumentToCompanyCam, verifyDocumentOnCompanyCam } = require("./lib/companyCamDocuments");
const { uploadPhotoToCompanyCam, deletePushedPhotoFromCompanyCam } = require("./lib/companyCamPhotos");
const { verifyCaller, requirePermission, getDb } = require("./lib/authGuard");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Fail-closed authentication gate -- identical contract to the one in
// photos.js. Leaks nothing to an unauthenticated caller: a flat
// "Unauthorized" whether the token was missing, malformed, expired, or
// revoked, never an echo of an internal message, and never a hint about
// whether a project/photo exists. Real reason goes to console.error
// (Netlify function logs), not to the caller.
//
// An infrastructure failure (missing FIREBASE_SERVICE_ACCOUNT, or the
// authGuard cross-project safety guard tripping) verifies nobody, so it
// returns 503 rather than falling open.
async function requireAuth(event) {
  try {
    return { caller: await verifyCaller(event) };
  } catch (e) {
    if (e && e.statusCode === 401) {
      return { errorResponse: resp(401, { error: "Unauthorized" }) };
    }
    console.error("companycam.js auth infrastructure failure:", e && e.message ? e.message : e);
    return { errorResponse: resp(503, { error: "Service unavailable" }) };
  }
}
function formatAddress(address) {
  if (!address) return "";
  if (typeof address === "string") return address;
  if (address.formatted_address) return String(address.formatted_address);
  const line1 = [
    address.street_address_1,
    address.street_address_2
  ].filter(Boolean).join(" ");
  const line2 = [
    address.city,
    [address.state, address.postal_code || address.zip].filter(Boolean).join(" ")
  ].filter(Boolean).join(", ");
  return [line1, line2].filter(Boolean).join(", ");
}
function mapProject(pr) {
  return {
    id: String(pr.id),
    name: pr.name || "(unnamed project)",
    address: formatAddress(pr.address),
    status: pr.status || "",
    created_at: pr.created_at || null
  };
}
exports.handler = async function (event) {
  // ---- AUTHENTICATION: first thing, for EVERY method and EVERY action. ----
  // Deliberately ahead of the COMPANYCAM_TOKEN env read below: an
  // unauthenticated caller must not be able to tell a configured deploy from
  // a misconfigured one (the old code's "COMPANYCAM_TOKEN is not set" 500 was
  // reachable by anyone), and the endpoint must never depend on being
  // correctly configured in order to be safe. Same ordering discipline as the
  // outlook.js fix.
  const gate = await requireAuth(event);
  if (gate.errorResponse) return gate.errorResponse;

  // Two possible tokens: COMPANYCAM_TOKEN is the read-only token used for
  // search/list/photo actions. COMPANYCAM_WRITE_TOKEN is an optional,
  // separately-scoped token for the one write action (upload_document) —
  // set it if your CompanyCam token setup keeps read and write scopes
  // separate. If COMPANYCAM_WRITE_TOKEN isn't set, uploads fall back to
  // COMPANYCAM_TOKEN so a single-token setup keeps working.
  const readToken = process.env.COMPANYCAM_TOKEN;

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return resp(400, { error: "Bad request" }); }
    try {
      if (body.action === "upload_document") {
        // Shared with inspection-reports.js's warranty-report filing --
        // see lib/companyCamDocuments.js -- same code path, not a
        // reimplementation, so a generated leak-report PDF and an emailed
        // inspection-report PDF hit CompanyCam's Documents endpoint
        // identically.
        const result = await uploadDocumentToCompanyCam(body.project_id, body.name || "WorkOrder.pdf", String(body.attachment || ""));
        if (!result.ok) {
          const code = /not set/.test(result.error) ? 500 : (/Missing/.test(result.error) ? 400 : 502);
          return resp(code, { error: result.error });
        }
        // documentId/url used to be DROPPED here (only `document` was
        // forwarded) — one of the two holes behind the dishonest "saved"
        // tracking (the client then depended entirely on the raw body's
        // shape). Forward the lib's extracted id explicitly.
        return resp(200, { ok: true, document: result.document, documentId: result.documentId, url: result.url });
      }

      // Artifact-truth reconciliation (Sophia's Curb Flashing false
      // negative): read-only existence check for a previously uploaded
      // document id, so the client can correct a stale "failed" status to
      // "saved" (or confirm a doc is genuinely gone) WITHOUT re-uploading a
      // duplicate version. Same requireAuth() gate as everything here;
      // read token; mutates nothing.
      if (body.action === "verify_document") {
        const result = await verifyDocumentOnCompanyCam(body.document_id);
        if (!result.ok) {
          const code = /not set/.test(result.error) ? 500 : (/Missing/.test(result.error) ? 400 : 502);
          return resp(code, { error: result.error });
        }
        return resp(200, { ok: true, exists: result.exists });
      }

      // Pushes ONE work-order photo into the linked project's PHOTO FEED,
      // map-pinned -- see lib/companyCamPhotos.js for the API contract and,
      // more importantly, for why this does NOT require opening the Storage
      // bucket (short-lived per-object V4 signed URL; the bucket stays
      // deny-all).
      //
      // Sits INSIDE the same requireAuth() gate as every other action in this
      // file -- deliberately not a new exception. It is a normal field
      // operation (a tech sends a work order; its photos land in CompanyCam),
      // so it is AUTHENTICATION-gated like upload_document, not
      // permission-gated. It also cannot create a project: it can only push
      // into a project id the caller already has linked.
      //
      // "Photo isn't in Storage yet" comes back as 200 { ok:false, skipped:true }
      // rather than an error status: it is an expected, self-healing state (the
      // next send picks it up), and one such photo must not fail the batch the
      // client is pushing.
      if (body.action === "upload_photo") {
        const result = await uploadPhotoToCompanyCam({
          projectId: body.project_id,
          workOrderId: body.workOrderId,
          photoIndex: body.photoIndex,
          coordinates: body.coordinates || null,
          capturedAt: body.captured_at,
          description: body.description || ""
        });
        if (result.skipped) return resp(200, { ok: false, skipped: true, reason: result.reason || "skipped" });
        if (!result.ok) {
          const code = /not set/.test(result.error) ? 500 : (/Missing|Invalid/.test(result.error) ? 400 : 502);
          return resp(code, { error: result.error });
        }
        return resp(200, { ok: true, photoId: result.photoId, coordinates: result.coordinates || null });
      }

      // Removes ONE integration-pushed photo from a CompanyCam project's feed
      // (undo-push). DESTRUCTIVE and integration-owned, so unlike every
      // authentication-only action above this one is PERMISSION-gated to
      // admin/owner (companycam.link -- the CompanyCam-management permission
      // admin already holds; owner passes automatically). The photo id to
      // delete is derived server-side from OUR stored ccFeedPhotoId -- the
      // client never supplies a raw CompanyCam id -- so a user-taken photo can
      // never be reached (see deletePushedPhotoFromCompanyCam). Every deletion
      // is audit-logged (what/where/who/when).
      if (body.action === "remove_pushed_photo") {
        let caller;
        try { caller = await requirePermission(event, "companycam.link"); }
        catch (e) { return resp(e.statusCode || 403, { error: e.message || "Forbidden" }); }
        const result = await deletePushedPhotoFromCompanyCam({
          workOrderId: body.workOrderId,
          photoIndex: body.photoIndex,
          expectedFeedPhotoId: body.expectedFeedPhotoId || null
        });
        if (result.skipped) return resp(200, { ok: false, skipped: true, reason: result.reason });
        if (!result.ok) {
          const code = /not set/.test(result.error) ? 500 : (/Invalid/.test(result.error) ? 400 : 502);
          return resp(code, { error: result.error });
        }
        try {
          await getDb().collection("audit_logs").doc().set({
            ts: Date.now(),
            action: "companycam_photo_removed",
            actorUid: caller.uid || null,
            actorEmail: caller.email || null,
            actorRole: caller.owner ? "owner" : (caller.role || null),
            ccFeedPhotoId: result.deletedPhotoId,
            projectId: result.projectId || null,
            workOrderId: body.workOrderId,
            photoIndex: body.photoIndex,
            alreadyGone: !!result.alreadyGone
          });
        } catch (e) { /* the deletion already happened -- the audit write is best-effort, never blocks it */ }
        return resp(200, { ok: true, deletedPhotoId: result.deletedPhotoId, projectId: result.projectId || null, alreadyGone: !!result.alreadyGone });
      }
      return resp(400, { error: "Unknown action" });
    } catch (e) {
      return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
    }
  }

  if (!readToken) {
    return resp(500, { error: "COMPANYCAM_TOKEN is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy." });
  }
  const H = { "Authorization": "Bearer " + readToken, "Accept": "application/json" };
  const p = event.queryStringParameters || {};
  try {
    if (p.action === "projects") {
      const q = String(p.q || "").slice(0, 100);
      // per_page bumped from CompanyCam's default (25) to 100 -- both the
      // Import-from-CompanyCam flow and the "Select Existing Building"
      // picker's CompanyCam merge (see "Change Order building picker" in
      // DEV_NOTES.md) want a browse-without-searching view that covers as
      // much of the project list as one page reasonably can, not just the
      // 25 most recent.
      const url = "https://api.companycam.com/v2/projects?per_page=100" +
        (q ? "&query=" + encodeURIComponent(q) : "");
      const r = await fetch(url, { headers: H });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        return resp(502, { error: "CompanyCam said: " + r.status + " " + t });
      }
      const arr = await r.json();
      const projects = (Array.isArray(arr) ? arr : []).map(mapProject);
      return resp(200, { projects });
    }

    if (p.action === "project_detail") {
      const id = String(p.project_id || "").replace(/[^A-Za-z0-9_-]/g, "");
      if (!id) return resp(400, { error: "Missing project_id" });
      const url = "https://api.companycam.com/v2/projects/" + id;
      const r = await fetch(url, { headers: H });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        return resp(502, { error: "CompanyCam said: " + r.status + " " + t });
      }
      const pr = await r.json();
      return resp(200, { project: mapProject(pr) });
    }

    if (p.action === "photos") {
      const id = String(p.project_id || "").replace(/[^A-Za-z0-9_-]/g, "");
      if (!id) return resp(400, { error: "Missing project_id" });
      const page = Math.max(1, parseInt(p.page || "1", 10) || 1);
      const url = "https://api.companycam.com/v2/projects/" + id + "/photos?per_page=30&page=" + page;
      const r = await fetch(url, { headers: H });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        return resp(502, { error: "CompanyCam said: " + r.status + " " + t });
      }
      const arr = await r.json();
      const photos = (Array.isArray(arr) ? arr : []).map(ph => {
        const uris = Array.isArray(ph.uris) ? ph.uris : [];
        const find = t => {
          const u = uris.find(x => x && x.type === t);
          return u ? (u.uri || u.url || "") : "";
        };
        // CompanyCam returns { lat, lon } (note: "lon", not "lng") when a
        // photo has GPS data. Used as an initial guess for roof-map pin
        // placement — never trusted as final without a tech confirming.
        const coords = ph.coordinates && typeof ph.coordinates.lat === "number" && typeof ph.coordinates.lon === "number"
          ? { lat: ph.coordinates.lat, lng: ph.coordinates.lon }
          : null;
        return {
          id: String(ph.id),
          thumb: find("thumbnail") || find("web") || find("original"),
          full: find("web") || find("original") || find("thumbnail"),
          captured_at: ph.captured_at || null,
          gps: coords
        };
      }).filter(x => x.full);
      return resp(200, { photos });
    }

    if (p.action === "image") {
      const u = String(p.url || "");
      let host = "";
      try { host = new URL(u).hostname; } catch (e) { return resp(400, { error: "Bad url" }); }
      if (!/companycam/i.test(host)) return resp(400, { error: "URL not allowed" });
      const r = await fetch(u);
      if (!r.ok) return resp(502, { error: "Image fetch failed: " + r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 5000000) return resp(413, { error: "Image too large" });
      const ct = r.headers.get("content-type") || "image/jpeg";
      return resp(200, { dataUrl: "data:" + ct + ";base64," + buf.toString("base64") });
    }

    return resp(400, { error: "Unknown action" });
  } catch (e) {
    return resp(500, { error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
};
