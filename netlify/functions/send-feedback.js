// Emails every in-app Send Feedback submission to Mark via Resend. Mirrors
// send-workorder.js's pattern (same RESEND_API_KEY, same fetch-to-Resend
// shape) but tailored to feedback: no PDF, an optional screenshot/photo
// attachment instead, and a stable "[RoofOps Feedback]" leading subject
// token on every email regardless of type, so a mail rule can reliably
// file all of these into one Outlook folder. See "Send Feedback" in
// DEV_NOTES.md.
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

  const to = process.env.FEEDBACK_TO_EMAIL || "marks@watkinsroofing.net";
  const from = process.env.FROM_EMAIL || "Watkins Roofing Work Orders <workorders@watkinsroofing.net>";

  const typeLabel = String(data.typeLabel || "Feedback").slice(0, 60);
  const screen = String(data.screen || "").slice(0, 60);
  // Stable leading token, identical on every submission regardless of
  // type/screen, so a mail rule can match "[RoofOps Feedback]" and file
  // it into a RoofOps/Feedback folder reliably — Mark's explicit ask.
  const subject = ("[RoofOps Feedback] " + typeLabel + (screen ? " — " + screen : "")).slice(0, 200);

  const lines = [
    "Type: " + typeLabel,
    "Screen: " + screen,
    "Technician: " + String(data.technician || "(not set)"),
    "Admin mode: " + (data.adminMode ? "yes" : "no"),
    "Device: " + String(data.device || ""),
    "Work order: " + (data.workOrderJobName
      ? data.workOrderJobName + (data.workOrderId ? " (" + data.workOrderId + ")" : "")
      : "(none open)"),
    "Submitted: " + new Date(data.createdAt || Date.now()).toLocaleString(),
    "",
    "Comments:",
    String(data.comments || "(none)")
  ];

  const payload = {
    from: from,
    to: [to],
    subject: subject,
    text: lines.join("\n")
  };

  if (data.screenshot && typeof data.screenshot === "string" && data.screenshot.length < 2000000) {
    const base64 = data.screenshot.split("base64,")[1];
    if (base64) {
      payload.attachments = [{ filename: "feedback-screenshot.jpg", content: base64 }];
    }
  }

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
