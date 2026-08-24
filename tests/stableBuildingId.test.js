const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const workordersSource = fs.readFileSync(path.join(__dirname, "..", "js", "workorders.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "..", "js", "export.js"), "utf8");
const photosSource = fs.readFileSync(path.join(__dirname, "..", "js", "photos.js"), "utf8");
const dprSource = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* ---- the ONE canonical slug formula (js/core.js) ---- */
function makeIdSandbox(){
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    between(coreSource, "function slugify", "async function ensureCustomerAndBuilding"),
    sandbox
  );
  return sandbox;
}

test("buildingIdFor reproduces the historical slug byte-for-byte (legacy compatibility)", () => {
  const sb = makeIdSandbox();
  /* The exact formula that used to be hand-copied in six places: */
  const legacy = (billTo, jobName) => {
    const custName = (billTo || "").trim(), bldName = (jobName || "").trim();
    if (!bldName) return null;
    const custId = custName ? ("cust_" + sb.slugify(custName)) : null;
    return "bld_" + sb.slugify((custId || "nocust") + "_" + bldName);
  };
  [["Acme Roofing", "North Warehouse"], ["", "Solo Building"], ["  Tri-Delta  ", "Hangar #3"],
   ["Beta, LLC", "12 Ünïcode Plaza"]].forEach(function(pair){
    assert.strictEqual(sb.buildingIdFor(pair[0], pair[1]), legacy(pair[0], pair[1]),
      "must match legacy slug for " + JSON.stringify(pair));
  });
  assert.strictEqual(sb.buildingIdFor("Acme", ""), null, "no job name -> no id");
  assert.strictEqual(sb.customerIdFor("Acme Roofing"), "cust_acme-roofing");
  assert.strictEqual(sb.customerIdFor("   "), null);
});

test("no other file carries its own copy of the bld_ slug formula anymore", () => {
  /* The tell-tale of a hand-copied formula is the "nocust" literal. Allowed
     ONLY in core.js (the canonical helper). */
  [["workorders", workordersSource], ["history", historySource], ["export", exportSource],
   ["photos", photosSource], ["dpr", dprSource]].forEach(function(f){
    assert.ok(f[1].indexOf('"nocust"') === -1, "js/" + f[0] + ".js still has an inline slug formula");
  });
});

/* ---- ensureCustomerAndBuilding honors the stored identity ---- */
function makeEnsureSandbox(opts){
  opts = opts || {};
  const writes = [];
  const sandbox = {
    __writes: writes,
    console: { warn(){} },
    Date: Date,
    getBuildingRoofs(){ return []; },
    saveBuildingRoofs(){ return Promise.resolve(); },
    fdb: opts.fdb === undefined ? {
      collection(name){
        return { doc(id){
          return {
            set(data, o){ writes.push({ path: name + "/" + id, data: data }); return Promise.resolve(); },
            get(){ return Promise.resolve({ exists: true, data(){ return {}; } }); }
          };
        } };
      }
    } : opts.fdb
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(coreSource, "function slugify", "/* ================= building roofs data layer"),
    sandbox
  );
  return sandbox;
}

test("a stored buildingId wins over the name slug — renaming updates the SAME building doc", async () => {
  const sb = makeEnsureSandbox();
  const ids = await sb.ensureCustomerAndBuilding({
    buildingId: "bld_cust-acme_north-warehouse",
    customerId: "cust_acme",
    billTo: "Acme",
    jobName: "North Warehouse — Building B" /* renamed: slug would differ */
  });
  assert.strictEqual(ids.buildingId, "bld_cust-acme_north-warehouse");
  assert.strictEqual(ids.customerId, "cust_acme");
  const bldWrite = sb.__writes.find(function(w){ return w.path.indexOf("buildings/") === 0; });
  assert.strictEqual(bldWrite.path, "buildings/bld_cust-acme_north-warehouse",
    "rename must write to the stored id, not fork a new slug doc");
  assert.strictEqual(bldWrite.data.name, "North Warehouse — Building B",
    "the rename updates the building's name in place");
});

test("legacy order (no stored id) derives the slug exactly as before", async () => {
  const sb = makeEnsureSandbox();
  const ids = await sb.ensureCustomerAndBuilding({ billTo: "Acme", jobName: "North Warehouse" });
  assert.strictEqual(ids.buildingId, sb.buildingIdFor("Acme", "North Warehouse"));
  assert.strictEqual(ids.customerId, "cust_acme");
});

test("blank job name: nothing is written, but a stored identity is never lost", async () => {
  const sb = makeEnsureSandbox();
  const ids = await sb.ensureCustomerAndBuilding({ buildingId: "bld_x", customerId: "cust_y", jobName: "  " });
  assert.strictEqual(ids.buildingId, "bld_x");
  assert.strictEqual(ids.customerId, "cust_y");
  assert.strictEqual(sb.__writes.length, 0, "no write may blank the building's name");
});

test("offline: stored identity is passed straight through", async () => {
  const sb = makeEnsureSandbox({ fdb: null });
  const ids = await sb.ensureCustomerAndBuilding({ buildingId: "bld_x", customerId: "cust_y", jobName: "Real Name" });
  assert.strictEqual(ids.buildingId, "bld_x");
  assert.strictEqual(ids.customerId, "cust_y");
});

/* ---- form-side identity: currentWorkOrderBuildingId / fill / collect / bpSelectBuilding ---- */
function makeFormSandbox(fields){
  const sandbox = {
    currentBuildingId: null,
    currentCustomerId: null,
    __fields: Object.assign({}, fields),
    val(id){ return sandbox.__fields[id] || ""; },
    slugify(s){
      return String(s || "").toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between(coreSource, "function customerIdFor", "async function ensureCustomerAndBuilding") +
    between(workordersSource, "function lookupRoofInfoMatchesBuilding", "function clearStaleLookupRoofInfoForCurrentOrder"),
    sandbox
  );
  return sandbox;
}

test("currentWorkOrderBuildingId prefers the stable id; slug is the fallback only", () => {
  const sb = makeFormSandbox({ billTo: "Acme", jobName: "North Warehouse" });
  const slug = sb.buildingIdFor("Acme", "North Warehouse");
  assert.strictEqual(sb.currentWorkOrderBuildingId(), slug, "no stored id -> slug fallback (legacy/new)");
  sb.currentBuildingId = "bld_stored_identity";
  sb.__fields.jobName = "North Warehouse RENAMED BY TECH";
  assert.strictEqual(sb.currentWorkOrderBuildingId(), "bld_stored_identity",
    "renaming the job must not re-derive a different building");
});

test("collect() stamps the identity onto the doc; fill() adopts it back (round-trip)", () => {
  assert.match(between(workordersSource, "o.buildingId = currentBuildingId", ";"), /currentBuildingId \|\| null/);
  assert.match(workordersSource, /o\.customerId = currentCustomerId \|\| null;/);
  assert.match(workordersSource, /currentBuildingId = o\.buildingId \|\| null;/);
  assert.match(workordersSource, /currentCustomerId = o\.customerId \|\| null;/);
});

test("bpSelectBuilding adopts the picked building's own doc id as the stable identity", () => {
  const block = between(workordersSource, "function bpSelectBuilding", "async function openMoveRoofModal");
  assert.match(block, /currentBuildingId = b\.id;/);
  assert.match(block, /currentCustomerId = b\.customerId \|\| null;/);
});

test("saveOrder stamps ids via ensureCustomerAndBuilding BEFORE the cloud doc write", () => {
  const block = between(coreSource, "function saveOrder", "function deleteOrder");
  const ensureIdx = block.indexOf("ensureCustomerAndBuilding(o)");
  const cloudIdx = block.indexOf("cloudSaveOrder(o)");
  assert.ok(ensureIdx !== -1 && cloudIdx !== -1 && ensureIdx < cloudIdx,
    "ensureCustomerAndBuilding must resolve ids before cloudSaveOrder persists the doc");
  assert.match(block, /o\.buildingId = ids\.buildingId/);
});

/* ---- readers prefer the stored id (legacy slug fallback stays) ---- */
test("every reader uses stored-id-first with the canonical fallback", () => {
  assert.match(historySource, /var bldId = v\.buildingId \|\| buildingIdFor\(v\.billTo, v\.jobName\);/);
  assert.match(historySource, /ctx\.bldId = o\.buildingId \|\| buildingIdFor\(o\.billTo, o\.jobName\);/);
  assert.match(exportSource, /var bldId = o\.buildingId \|\| buildingIdFor\(o\.billTo, o\.jobName\);/);
  assert.match(photosSource, /var bldId = o\.buildingId \|\| buildingIdFor\(o\.billTo, o\.jobName\);/);
});

/* ---- blank job name: report/history events no longer vanish silently ---- */
test("a dropped report event warns out loud; plain Saved stays silent by design", () => {
  const block = between(historySource, "async function logReportAndHistoryEvent", "var pdfRef = null;");
  assert.match(block, /if \(kind !== "Saved"\) toast\(/);
  assert.match(block, /Not logged to Building History/);
});
