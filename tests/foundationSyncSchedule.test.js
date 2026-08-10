"use strict";
/* Regression guard for the Foundation-sync SCHEDULE target.
 *
 * WHY THIS FILE EXISTS — 2026-08-10 field outage. The hourly GitHub Actions
 * cron was succeeding, but every scheduled run resolved TARGET to 'dev'
 * (`github.event.inputs.target || 'dev'`) and synced only
 * dev--leak-work-orders.netlify.app. Production's foundation_jobs cache was
 * therefore NEVER refreshed on a schedule, so a newly-created Foundation job
 * (#17519) was unlinkable in the live app until someone hand-ran a prod sync.
 *
 * The fix: scheduled runs must refresh PRODUCTION (the live field environment);
 * dev rides along so it stays testable. If a future edit points the schedule
 * back at dev-only, this test MUST fail.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const yml = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "sync-foundation-jobs.yml"),
  "utf8"
);

test("the scheduled run does NOT default to dev-only", () => {
  // The exact bug: an empty workflow_dispatch input (i.e. a schedule) falling
  // back to 'dev'. That string must not be the scheduled default anymore.
  assert.ok(
    !/inputs\.target\s*\|\|\s*'dev'/.test(yml),
    "scheduled TARGET must not fall back to 'dev' — that only ever synced the dev deploy"
  );
});

test("the scheduled run defaults to production (via 'both')", () => {
  assert.match(
    yml,
    /inputs\.target\s*\|\|\s*'both'/,
    "scheduled TARGET should fall back to 'both' so production is always refreshed"
  );
});

test("both the production and dev deploy bases are wired", () => {
  assert.match(yml, /https:\/\/leak-work-orders\.netlify\.app/, "prod base present");
  assert.match(yml, /https:\/\/dev--leak-work-orders\.netlify\.app/, "dev base present");
});

test("'both' resolves to production AND dev; the run fails if any target fails", () => {
  assert.match(yml, /both\)\s*BASES="\$PROD_BASE \$DEV_BASE"/, "'both' syncs prod and dev");
  assert.match(yml, /FAILED=1/, "a non-200 from any target marks the run failed");
});

test("still runs about-hourly on the work day and stays authenticated by header", () => {
  assert.match(yml, /cron:\s*"0 12-21 \* \* \*"/, "hourly 7AM-4PM Central cron intact");
  assert.match(yml, /x-foundation-sync-key:\s*\$\{FOUNDATION_SYNC_SECRET\}/, "secret stays in a header");
  // The pull stays read-only from Foundation: the only action ever POSTed is sync.
  assert.match(yml, /-d '\{"action":"sync"\}'/, "only the read-only sync action is posted");
});
