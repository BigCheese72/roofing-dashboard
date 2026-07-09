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

  const defaultFrom = process.env.FROM_EMAIL || "Watkins Roofing Work Orders <workorders@watkinsroofing.net>";
  // Sending domain lives in FROM_EMAIL (or its default) so a per-job local
  // part can be built without hardcoding the domain here — SPF/DKIM/DMARC
  // are verified at the domain level, so any address on it authenticates
  // the same way, no per-address Resend config needed.
  const domainMatch = defaultFrom.match(/@([^>\s]+)/);
  const domain = domainMatch ? domainMatch[1] : "watkinsroofing.net";
  const jobNo = String(data.jobNo || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 30);
  // WO{jobnumber}@ isn't a real mailbox — replies would otherwise hit
  // Microsoft 365 (the root domain's MX) and bounce. REPLY_TO_EMAIL lets
  // this point at whatever inbox is actually monitored; defaults to
  // Mark's real monitored mailbox (marks@<domain>) if unset — no env var
  // required for the correct default to take effect.
  const from = jobNo ? "Watkins Roofing Work Orders <WO" + jobNo + "@" + domain + ">" : defaultFrom;
  const replyTo = process.env.REPLY_TO_EMAIL || ("marks@" + domain);
  const payload = {
    from: from,
    to: to,
    reply_to: replyTo,
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
