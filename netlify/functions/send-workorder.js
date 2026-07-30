// Sends a work order PDF via Resend. The API key is read from the
// RESEND_API_KEY environment variable set in Netlify site settings —
// it is never exposed to the browser.
//
// Auth Phase 5 (see docs/AUTH_DESIGN.md) -- gated by doc.email_customer.
// Before this, ANY caller who could reach this endpoint could send an
// email as Watkins Roofing to anyone, with no check at all -- not just a
// gap relative to the mandatory "field_tech emailing a customer document"
// negative test, a real, live hole regardless of that test existing.
const { requirePermission } = require("./lib/authGuard");

const SEND_MAX_BODY_BYTES = 6000000;
const SEND_ENVELOPE_RESERVE = 32768;
const MAX_PDF_BASE64 = SEND_MAX_BODY_BYTES - SEND_ENVELOPE_RESERVE;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try { await requirePermission(event, "doc.email_customer"); }
  catch (e) { return { statusCode: e.statusCode || 401, body: JSON.stringify({ error: e.message }) }; }

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
  // Mirror of SEND_MAX_PDF_BASE64 in js/export.js -- see the long comment
  // there for the measurement behind 6,000,000 and 32,768.
  // tests/largeReportSendBudget.test.js reads BOTH files and fails if these
  // two numbers ever drift apart.
  //
  // This guard was 8,000,000 and was DEAD CODE: Netlify Functions run on AWS
  // Lambda, whose 6 MiB synchronous payload limit rejects an oversized
  // request at the platform edge (413, empty body) before this handler is
  // ever invoked, so no request that would have failed this check could
  // arrive to fail it. At the corrected number the check is genuinely
  // reachable -- a body just under the platform wall but over our budget now
  // gets this clean JSON 400 instead of something the client can't parse.
  if (!data.pdfBase64 || typeof data.pdfBase64 !== "string" || data.pdfBase64.length > MAX_PDF_BASE64) {
    const mb = n => Math.round((n * 3 / 4) / 1048576 * 10) / 10;
    return { statusCode: 400, body: JSON.stringify({
      error: !data.pdfBase64 || typeof data.pdfBase64 !== "string"
        ? "PDF missing"
        : "This report is too big to email (" + mb(data.pdfBase64.length) + " MB; the limit is " +
          mb(MAX_PDF_BASE64) + " MB). Use Download PDF and attach it yourself, or remove some photos." }) };
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
  // this point at whatever inbox(es) are actually monitored (comma-
  // separated); defaults to Mark's and Charlotte's real monitored
  // mailboxes if unset — no env var required for the correct default to
  // take effect. Resend's reply_to accepts an array, same as `to`.
  const from = jobNo ? "Watkins Roofing Work Orders <WO" + jobNo + "@" + domain + ">" : defaultFrom;
  const replyTo = process.env.REPLY_TO_EMAIL
    ? process.env.REPLY_TO_EMAIL.split(",").map(s => s.trim()).filter(Boolean)
    : ["marks@" + domain, "charlottew@" + domain];
  // Mark wants a guaranteed blind copy of every outgoing work-order email,
  // regardless of who else it's addressed to — enforced here server-side so
  // it can't be dropped by omitting it from the client payload. But he
  // doesn't want duplicate emails: if he's manually added as an explicit To
  // recipient (still selectable on the client's quick-pick list, just no
  // longer a default), skip the BCC so he gets exactly one copy, not two.
  const bccAddr = "marks@" + domain;
  const alreadyInTo = to.some(a => a.toLowerCase() === bccAddr.toLowerCase());
  const payload = {
    from: from,
    to: to,
    reply_to: replyTo,
    subject: String(data.subject || "Service Work Order").slice(0, 200),
    text: String(data.body || "Work order attached.").slice(0, 10000),
    attachments: [{
      filename: String(data.filename || "WorkOrder.pdf").slice(0, 100),
      content: data.pdfBase64
    }]
  };
  if (!alreadyInTo) payload.bcc = [bccAddr];

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
