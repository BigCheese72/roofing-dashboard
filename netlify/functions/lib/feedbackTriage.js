"use strict";

const AREAS = [
  {
    key: "companycam",
    label: "CompanyCam/photo import",
    files: ["js/companycam.js", "netlify/functions/companycam.js", "js/photos.js"],
    terms: ["companycam", "company cam", "import photo", "import photos", "photo feed", "link project", "unlink"]
  },
  {
    key: "email",
    label: "Email/report sending",
    files: ["js/core.js", "js/export.js", "netlify/functions/send-workorder.js"],
    terms: ["email", "send email", "recipient", "bcc", "pdf send", "share pdf"]
  },
  {
    key: "pdf",
    label: "Report/PDF preview",
    files: ["js/export.js", "js/core.js"],
    terms: ["pdf", "preview", "print", "download", "report preview", "summary", "caption"]
  },
  {
    key: "roofmapper",
    label: "RoofMapper",
    files: ["js/roofmapper.js", "js/core.js"],
    terms: ["roofmapper", "roof mapper", "trace", "outline", "calibrate", "dimension", "scale", "kmz", "geotiff", "orthophoto", "ortho"]
  },
  {
    key: "map",
    label: "Roof map/pins",
    files: ["js/photos.js", "js/buildinghistory.js", "js/roofmapper.js"],
    terms: ["map", "pin", "gps", "location", "base map", "satellite", "near me", "building near"]
  },
  {
    key: "history",
    label: "Building History/Reports",
    files: ["js/buildinghistory.js", "js/history.js", "js/core.js"],
    terms: ["building history", "timeline", "reports tab", "all reports", "duplicate building", "merge"]
  },
  {
    key: "dpr",
    label: "Daily Progress Report",
    files: ["js/dpr.js", "index.html"],
    terms: ["dpr", "daily progress", "daily report", "crew", "weather delay"]
  },
  {
    key: "auth",
    label: "Login/admin permissions",
    files: ["js/core.js", "netlify/functions/auth.js", "netlify/functions/admin.js", "firestore.rules"],
    terms: ["login", "sign in", "admin", "permission", "role", "owner", "locked out", "unauthorized", "forbidden"]
  },
  {
    key: "save",
    label: "Saving/sync/offline",
    files: ["js/core.js", "js/workorders.js", "firestore.rules"],
    terms: ["save", "saved", "sync", "offline", "queue", "lost", "missing", "disappear", "didn't save", "did not save"]
  }
];

const URGENT_TERMS = [
  "data loss", "lost", "deleted", "missing", "disappear", "can't save", "cannot save",
  "didn't save", "did not save", "email won't send", "cannot send", "wrong building",
  "privacy", "security", "permission", "unauthorized", "crash", "freeze", "blank screen"
];

function cleanText(value, maxLen) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const limit = maxLen || 600;
  return text.length > limit ? text.slice(0, limit - 1).trim() + "..." : text;
}

function lower(value) {
  return cleanText(value, 2000).toLowerCase();
}

function hasAny(text, terms) {
  return terms.some(term => text.indexOf(term) !== -1);
}

function issueSafeLine(value, fallback) {
  return cleanText(value, 160) || fallback;
}

function summarizeComment(item) {
  const comments = cleanText(item && item.comments, 160);
  if (comments) return comments;
  const type = cleanText(item && (item.typeLabel || item.type), 80);
  return type ? type + " feedback with no comment" : "Feedback with no comment";
}

function inferArea(item) {
  const combined = lower([
    item && item.screen,
    item && item.comments,
    item && item.typeLabel,
    item && item.workOrderJobName
  ].join(" "));

  const found = AREAS.find(area => hasAny(combined, area.terms));
  if (found) return found;

  const screen = lower(item && item.screen);
  if (screen.indexOf("preview") !== -1) return AREAS.find(a => a.key === "pdf");
  if (screen.indexOf("roofmapper") !== -1) return AREAS.find(a => a.key === "roofmapper");
  if (screen.indexOf("history") !== -1 || screen.indexOf("reports") !== -1) return AREAS.find(a => a.key === "history");

  return {
    key: "field-workflow",
    label: "Field workflow",
    files: ["js/core.js", "index.html"],
    terms: []
  };
}

function inferSeverity(item) {
  const type = lower(item && item.type);
  const combined = lower([
    item && item.comments,
    item && item.screen,
    item && item.typeLabel
  ].join(" "));

  if (hasAny(combined, URGENT_TERMS)) return "P1";
  if (type === "bug") return "P2";
  if (type === "confusing") return "P2";
  if (type === "feature") return "P3";
  if (type === "praise") return "FYI";
  return "P3";
}

function severityReason(severity, item) {
  if (severity === "P1") return "mentions possible data loss, blocked work, security, permissions, or a crash/freeze";
  if (severity === "P2") return "likely interrupts field work or causes confusion during an active workflow";
  if (severity === "P3") return "actionable improvement, but no clear blocker was reported";
  return "positive signal; keep for product notes unless it points at a related open change";
}

function duplicateKeyFor(item, area) {
  const screen = lower(item && item.screen).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const words = lower(item && item.comments).split(/[^a-z0-9]+/).filter(Boolean)
    .filter(w => w.length > 3)
    .slice(0, 6)
    .join("-");
  return [area.key, screen || "unknown", words || lower(item && item.type) || "no-comment"].join(":");
}

function acceptanceFor(item, area, severity) {
  const type = lower(item && item.type);
  if (type === "praise") {
    return [
      "Confirm whether this feedback reinforces an existing workflow decision.",
      "Link it to any related issue or release note if useful; no code change required by default."
    ];
  }

  const checks = [
    "Reproduce or validate the reported behavior from the captured screen/context.",
    "Fix the root cause without changing the existing field workflow.",
    "Add or update a focused test for the affected path."
  ];
  if (area.key === "auth") checks.push("Confirm the permission boundary is enforced server-side or in Firestore rules.");
  if (severity === "P1") checks.push("Verify no existing saved work order, building, report, or screenshot data is damaged by the fix.");
  return checks;
}

function triageFeedbackItem(item) {
  const source = item || {};
  const area = inferArea(source);
  const severity = inferSeverity(source);
  const duplicateKey = duplicateKeyFor(source, area);
  const comment = summarizeComment(source);
  const screen = issueSafeLine(source.screen, "Unknown screen");
  const tech = issueSafeLine(source.technician, "Unknown technician");
  const workOrder = issueSafeLine(source.workOrderJobName || source.workOrderId, "No work order captured");
  const created = source.createdAt ? new Date(source.createdAt).toISOString() : "Unknown time";
  const screenshotAttached = !!source.screenshot;
  const titleTail = comment.length > 72 ? comment.slice(0, 69).trim() + "..." : comment;
  const issueTitle = "[" + severity + "] Feedback: " + area.label + " - " + titleTail;
  const files = area.files.join(", ");
  const acceptance = acceptanceFor(source, area, severity).map(line => "- " + line).join("\n");
  const issueBody = [
    "## Source feedback",
    "- Feedback id: " + issueSafeLine(source.id, "(not supplied)"),
    "- Type: " + issueSafeLine(source.typeLabel || source.type, "Unknown"),
    "- Screen: " + screen,
    "- Submitted: " + created,
    "- Technician: " + tech,
    "- Work order: " + workOrder,
    "- Screenshot attached: " + (screenshotAttached ? "yes (review inside RoofOps; do not paste customer images into GitHub unless approved)" : "no"),
    "",
    "## Field report",
    comment,
    "",
    "## Initial diagnosis",
    "- Likely area: " + area.label,
    "- Suggested files to inspect first: " + files,
    "- Severity: " + severity + " because it " + severityReason(severity, source) + ".",
    "- Related-feedback key: " + duplicateKey,
    "",
    "## Repro notes",
    "- Start from the captured screen/context above.",
    "- If a work order is listed, check that workflow before and after the fix.",
    "- If there is a screenshot, review it in the admin backlog for private/customer context before sharing externally.",
    "",
    "## Acceptance",
    acceptance,
    "",
    "## Safety notes",
    "- Preserve the existing field workflow unless Mark approves a workflow change.",
    "- Enforce any permission-related fix server-side or through Firestore rules, not only in the UI."
  ].join("\n");

  return {
    id: source.id || null,
    severity,
    area: { key: area.key, label: area.label, files: area.files.slice() },
    summary: comment,
    duplicateKey,
    screenshotAttached,
    issueTitle,
    issueBody
  };
}

function triageFeedbackItems(items) {
  const triaged = (Array.isArray(items) ? items : []).map(triageFeedbackItem);
  const grouped = Object.create(null);
  triaged.forEach(item => {
    if (!grouped[item.duplicateKey]) grouped[item.duplicateKey] = [];
    grouped[item.duplicateKey].push(item.id);
  });
  const clusters = Object.keys(grouped)
    .filter(key => grouped[key].length > 1)
    .map(key => ({ duplicateKey: key, count: grouped[key].length, ids: grouped[key] }));
  return {
    generatedAt: Date.now(),
    count: triaged.length,
    items: triaged,
    clusters
  };
}

module.exports = {
  triageFeedbackItem,
  triageFeedbackItems,
  inferArea,
  inferSeverity
};
