// Read-only proxy to the CompanyCam API. The token is read from the
// COMPANYCAM_TOKEN environment variable in Netlify settings and never
// reaches the browser.
function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
exports.handler = async function (event) {
  const token = process.env.COMPANYCAM_TOKEN;
  if (!token) {
    return resp(500, { error: "COMPANYCAM_TOKEN is not set. Add it in Netlify > Project configuration > Environment variables, then redeploy." });
  }
  const p = event.queryStringParameters || {};
  const H = { "Authorization": "Bearer " + token, "Accept": "application/json" };
  try {
    if (p.action === "projects") {
      const q = String(p.q || "").slice(0, 100);
      const url = "https://api.companycam.com/v2/projects?per_page=25" +
        (q ? "&query=" + encodeURIComponent(q) : "");
      const r = await fetch(url, { headers: H });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        return resp(502, { error: "CompanyCam said: " + r.status + " " + t });
      }
      const arr = await r.json();
      const projects = (Array.isArray(arr) ? arr : []).map(pr => ({
        id: String(pr.id),
        name: pr.name || "(unnamed project)",
        address: [
          pr.address && pr.address.street_address_1,
          pr.address && pr.address.city,
          pr.address && pr.address.state
        ].filter(Boolean).join(", ")
      }));
      return resp(200, { projects });
    }

    if (p.action === "photos") {
      const id = String(p.project_id || "").replace(/[^A-Za-z0-9_-]/g, "");
      if (!id) return resp(400, { error: "Missing project_id" });
      const page = Math.max(1, parseInt(p.page || "1", 10) || 1);
      const url = "https://api.companycam.com/v2/projects/" + id + "/photos?per_page=30&page=" + page;
      const r = await fetch(url, { headers: H });
      if (!r.ok) return resp(502, { error: "CompanyCam said: " + r.status });
      const arr = await r.json();
      const photos = (Array.isArray(arr) ? arr : []).map(ph => {
        const uris = Array.isArray(ph.uris) ? ph.uris : [];
        const find = t => {
          const u = uris.find(x => x && x.type === t);
          return u ? (u.uri || u.url || "") : "";
        };
        return {
          id: String(ph.id),
          thumb: find("thumbnail") || find("web") || find("original"),
          full: find("web") || find("original") || find("thumbnail"),
          captured_at: ph.captured_at || null
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
