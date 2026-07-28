"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  inferArea,
  inferSeverity,
  triageFeedbackItem,
  triageFeedbackItems
} = require("../netlify/functions/lib/feedbackTriage");

test("triage routes photo import feedback to CompanyCam area with issue draft", () => {
  const item = triageFeedbackItem({
    id: "fb_cc",
    type: "bug",
    typeLabel: "Bug",
    comments: "CompanyCam import did not bring in the project photos",
    screen: "Work Order Form",
    technician: "Mark",
    workOrderJobName: "Orr St",
    createdAt: Date.UTC(2026, 6, 25)
  });

  assert.equal(item.severity, "P2");
  assert.equal(item.area.key, "companycam");
  assert.match(item.issueTitle, /CompanyCam\/photo import/);
  assert.match(item.issueBody, /js\/companycam\.js/);
  assert.match(item.issueBody, /Preserve the existing field workflow/);
});

test("urgent words escalate bug feedback to P1", () => {
  assert.equal(inferSeverity({
    type: "bug",
    comments: "The work order disappeared and did not save after I added photos"
  }), "P1");
});

test("triage does not embed screenshot data in GitHub draft", () => {
  const item = triageFeedbackItem({
    id: "fb_private",
    type: "bug",
    comments: "Preview looked wrong",
    screen: "Report Preview",
    screenshot: "data:image/jpeg;base64,SECRET_CUSTOMER_SCREENSHOT"
  });

  assert.equal(item.screenshotAttached, true);
  assert.match(item.issueBody, /Screenshot attached: yes/);
  assert.doesNotMatch(item.issueBody, /SECRET_CUSTOMER_SCREENSHOT/);
  assert.doesNotMatch(item.issueBody, /data:image\/jpeg/);
});

test("triage groups likely duplicate feedback", () => {
  const out = triageFeedbackItems([
    { id: "fb_1", type: "bug", screen: "RoofMapper", comments: "Trace outline is hard to save" },
    { id: "fb_2", type: "bug", screen: "RoofMapper", comments: "Trace outline is hard to save" }
  ]);

  assert.equal(out.count, 2);
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0].ids, ["fb_1", "fb_2"]);
});

test("admin triage endpoint is server-gated with audit.view", () => {
  const adminPath = path.join(__dirname, "..", "netlify", "functions", "admin.js");
  const src = fs.readFileSync(adminPath, "utf8");
  const start = src.indexOf('body.action === "triage_feedback"');
  assert.notEqual(start, -1);
  const end = src.indexOf('body.action === "list_audit_log"', start);
  assert.notEqual(end, -1);
  const block = src.slice(start, end);

  assert.match(block, /requirePermission\(event,\s*"audit\.view"\)/);
  assert.match(block, /db\.collection\("feedback"\)/);
  assert.match(block, /triageFeedbackItems\(items\)/);
});

test("auth-related feedback points reviewers at server or rules files", () => {
  const area = inferArea({
    type: "confusing",
    screen: "Admin",
    comments: "Permission denied when admin tries to open roles"
  });

  assert.equal(area.key, "auth");
  assert.ok(area.files.includes("netlify/functions/admin.js"));
  assert.ok(area.files.includes("firestore.rules"));
});

test("feedback backlog UI exposes batch and per-row triage actions", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const core = fs.readFileSync(path.join(root, "js", "core.js"), "utf8");

  assert.match(html, /Auto-triage visible/);
  assert.match(html, /id="feedback-triage-output"/);
  assert.match(core, /async function triageFeedbackBacklog/);
  assert.match(core, /action:\s*"triage_feedback"/);
  assert.match(core, /onclick="triageFeedbackBacklog\('/);
});
