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
const { uploadDocumentToCompanyCam } = require("./lib/companyCamDocuments");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
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
        return resp(200, { ok: true, document: result.document });
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
