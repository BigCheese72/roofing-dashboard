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

function makeFootprintCtx(state) {
  const elements = {
    "rm-footprint-info": { innerHTML: "" },
    "rm-generate-btn": { textContent: "", classList: { toggle() {} } },
    "rm-footprint-panel": { style: {}, scrollIntoView() {} }
  };
  const ctx = {
    String, Array, Object, Math,
    rmState: Object.assign({
      footprints: [],
      footprintLayers: {},
      selectedId: null,
      linkedJobNo: null,
      linkedJobName: "",
      linkedJobAddress: "",
      linkedJobBuildingName: "",
      pendingBuildingName: null
    }, state),
    esc: (s) => String(s == null ? "" : s),
    rmClearGeneratedOutline() {},
    rmFootprintStyle() { return {}; },
    document: { getElementById(id) { return elements[id]; } }
  };
  vm.runInNewContext(between("function rmSelectedFootprintTitle", "function rmDeselectFootprint"), ctx);
  ctx.elements = elements;
  return ctx;
}

function makeSaveCtx(fnStart, fnEnd, extra) {
  const ctx = Object.assign({
    String, Array, Object, Error,
    rmState: {
      outline: { tags: {} },
      linkedJobNo: "17053",
      linkedJobCustomerNo: "C-42",
      linkedJobAddress: "1200 Main St, Springfield, IL"
    },
    rmSplitState: {},
    fdb: null,
    toast() {},
    rmFailSafeSaveOutline() { throw new Error("unexpected fail-safe save"); }
  }, extra || {});
  vm.runInNewContext(between(fnStart, fnEnd), ctx);
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

test("RoofMapper selected footprint shows linked job instead of unnamed OSM fallback", () => {
  const ctx = makeFootprintCtx({
    linkedJobNo: "17053",
    linkedJobName: "CPS West Middle RTU replacement",
    linkedJobAddress: "1200 Main St, Springfield, IL",
    footprints: [{
      id: "way/99",
      osmType: "way",
      tags: { building: "school" },
      areaSqFt: 12345
    }]
  });

  ctx.rmSelectFootprint("way/99");

  const html = ctx.elements["rm-footprint-info"].innerHTML;
  assert.match(html, /<b>CPS West Middle RTU replacement<\/b>/);
  assert.match(html, /Linked Foundation job: #17053 - 1200 Main St, Springfield, IL/);
  assert.doesNotMatch(html, /<b>Unnamed building<\/b>/);
});

test("RoofMapper selected footprint prefers matched app building name when linked", () => {
  const ctx = makeFootprintCtx({
    linkedJobNo: "17053",
    linkedJobName: "CPS West Middle RTU replacement",
    linkedJobBuildingName: "West Middle School",
    footprints: [{
      id: "way/99",
      osmType: "way",
      tags: {},
      areaSqFt: 12345
    }]
  });

  ctx.rmSelectFootprint("way/99");

  assert.match(ctx.elements["rm-footprint-info"].innerHTML, /<b>West Middle School<\/b>/);
});

test("RoofMapper selected footprint still shows linked job subtitle when OSM has a name", () => {
  const ctx = makeFootprintCtx({
    linkedJobNo: "17053",
    linkedJobName: "CPS West Middle RTU replacement",
    linkedJobAddress: "1200 Main St, Springfield, IL",
    footprints: [{
      id: "way/99",
      osmType: "way",
      tags: { name: "OSM School Name", building: "school" },
      areaSqFt: 12345
    }]
  });

  ctx.rmSelectFootprint("way/99");

  const html = ctx.elements["rm-footprint-info"].innerHTML;
  assert.match(html, /<b>CPS West Middle RTU replacement<\/b>/);
  assert.match(html, /Linked Foundation job: #17053 - 1200 Main St, Springfield, IL/);
});

test("RoofMapper create-building save stamps linked Foundation anchor", async () => {
  let payload = null;
  const ctx = makeSaveCtx("async function rmCreateBuildingAndSave", "/* ---- Phase 2", {
    val(id) {
      return id === "rm-new-jobname" ? "CPS West Middle RTU replacement" : "C-42";
    },
    ensureCustomerAndBuilding(o) {
      payload = o;
      return Promise.resolve({ buildingId: "bld_1" });
    },
    rmSaveOutlineToBuilding(id) {
      assert.strictEqual(id, "bld_1");
      return Promise.resolve();
    }
  });

  await ctx.rmCreateBuildingAndSave();

  assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), {
    jobName: "CPS West Middle RTU replacement",
    billTo: "C-42",
    location: "1200 Main St, Springfield, IL",
    foundationJobNo: "17053",
    foundationCustomerNo: "C-42",
    foundationAddress: "1200 Main St, Springfield, IL"
  });
});

test("RoofMapper CompanyCam create path stamps linked Foundation anchor", async () => {
  let payload = null;
  let pickerBuildingId = null;
  const ctx = makeSaveCtx("async function rmBpSelectCompanyCamProject", "/* Always shows a picker", {
    rmBpCcVisibleCache: [{ id: "cc_1", name: "Drone Project", address: "1200 Main St" }],
    ensureCustomerAndBuilding(o) {
      payload = o;
      return Promise.resolve({ buildingId: "bld_1" });
    },
    rmRenderRoofPickerFor(id) {
      pickerBuildingId = id;
    }
  });

  await ctx.rmBpSelectCompanyCamProject(0);

  assert.strictEqual(pickerBuildingId, "bld_1");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), {
    jobName: "Drone Project",
    billTo: "",
    location: "1200 Main St",
    companyCamProjectId: "cc_1",
    foundationJobNo: "17053",
    foundationCustomerNo: "C-42",
    foundationAddress: "1200 Main St, Springfield, IL"
  });
});
