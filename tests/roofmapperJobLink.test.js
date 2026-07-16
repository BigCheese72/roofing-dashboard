"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "roofmapper.js"), "utf8");

function between(a, b) {
  const s = src.indexOf(a), e = src.indexOf(b, s);
  assert.notStrictEqual(s, -1, "start marker not found: " + a);
  assert.notStrictEqual(e, -1, "end marker not found: " + b);
  return src.slice(s, e);
}

function makeCtx() {
  const ctx = {
    String, Array, Object, JSON,
    rmState: {},
    esc: (s) => String(s == null ? "" : s),
    fdnComposeAddress: (j) => {
      const line2 = [j.city, [j.state, j.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return [j.address, line2].filter(Boolean).join(", ");
    }
  };
  vm.runInNewContext(between("var rmJobPickerJobs", "/* ---- save to building"), ctx);
  return ctx;
}

test("RoofMapper selected job remembers job identity, address, and matched building", () => {
  const ctx = makeCtx();
  const job = {
    job_no: "17053",
    name: "CPS West Middle RTU replacement",
    customer_no: "C-42",
    address: "1200 Main St",
    city: "Springfield",
    state: "IL",
    zip: "62701"
  };
  const building = { id: "bld_west", name: "West Middle School" };

  ctx.rmSetLinkedJobState(job, building);

  assert.strictEqual(ctx.rmState.linkedJobNo, "17053");
  assert.strictEqual(ctx.rmState.linkedJobName, "CPS West Middle RTU replacement");
  assert.strictEqual(ctx.rmState.linkedJobCustomerNo, "C-42");
  assert.strictEqual(ctx.rmState.linkedJobAddress, "1200 Main St, Springfield, IL 62701");
  assert.strictEqual(ctx.rmState.pendingBuildingId, "bld_west");
  assert.strictEqual(ctx.rmState.pendingBuildingName, "West Middle School");
  assert.strictEqual(ctx.rmState.pendingBuildingSource, "job");
});

test("RoofMapper selected job without an app building keeps create-building data and clears pending building", () => {
  const ctx = makeCtx();

  ctx.rmSetLinkedJobState({
    job_no: "17054",
    name: "New School Roof",
    customer_no: "C-77",
    address: "99 Oak Rd",
    city: "Belleville",
    state: "IL"
  }, null);

  assert.strictEqual(ctx.rmState.linkedJobNo, "17054");
  assert.strictEqual(ctx.rmState.linkedJobAddress, "99 Oak Rd, Belleville, IL");
  assert.strictEqual(ctx.rmState.pendingBuildingId, null);
  assert.strictEqual(ctx.rmState.pendingBuildingSource, null);
});

test("RoofMapper job picker search includes composed address fields", () => {
  const ctx = makeCtx();
  const job = {
    job_no: "17055",
    name: "Library RTU",
    customer_no: "C-99",
    address: "500 Pine Ave",
    city: "Alton",
    state: "IL"
  };

  assert.strictEqual(ctx.rmJobMatchesSearch(job, "pine"), true);
  assert.strictEqual(ctx.rmJobMatchesSearch(job, "alton"), true);
  assert.strictEqual(ctx.rmJobMatchesSearch(job, "c-99"), true);
  assert.strictEqual(ctx.rmJobMatchesSearch(job, "decatur"), false);
});
