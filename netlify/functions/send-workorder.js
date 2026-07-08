// Sends a work order PDF via Resend. The API key is read from the
// RESEND_API_KEY environment variable set in Netlify site settings —
// it is never exposed to the browser.
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({
      error: "RESEND_API_KEY is not set. Add it in Netlify: Site configuration > Environment variables, then redeploy." }) };
  }
  let data;
  try { data = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Bad request" }) }; }

  const to = Array.isArray(data.to)
    ? data.to.filter(x => typeof x === "string" && x.indexOf("@") > 0).slice(0, 10)
    : [];
  if (!to.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "No valid recipients" }) };
  }
  if (!data.pdfBase64 || typeof data.pdfBase64 !== "string" || data.pdfBase64.length > 8000000) {
    return { statusCode: 400, body: JSON.stringify({ error: "PDF missing or too large (limit ~6MB)" }) };
  }

  const from = process.env.FROM_EMAIL || "Watkins Roofing Work Orders <workorders@watkinsroofing.net>";
  const payload = {
    from: from,
    to: to,
    subject: String(data.subject || "Leak Work Order").slice(0, 200),
    text: String(data.body || "Work order attached.").slice(0, 10000),
    attachments: [{
      filename: String(data.filename || "WorkOrder.pdf").slice(0, 100),
      content: data.pdfBase64
    }]
  };

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const out = await resp.text();
  if (!resp.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: "Email service rejected it: " + out.slice(0, 300) }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
