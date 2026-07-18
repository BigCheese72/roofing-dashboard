"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEstimator(){
  const elements = {};
  const storage = {};
  const sandbox = {
    currentAuthClaims: { owner: true },
    localStorage: {
      getItem(key){ return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
      setItem(key, value){ storage[key] = String(value); },
      removeItem(key){ delete storage[key]; }
    },
    document: {
      getElementById(id){
        if (!elements[id]){
          elements[id] = { value: "", innerHTML: "", style: {} };
        }
        return elements[id];
      }
    },
    toast: function(){},
    showView: function(){},
    esc: function(s){
      return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    },
    Date, Math, JSON, Number, String, Boolean, Array, Object, Promise, isFinite
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "estimator.js"), "utf8"), sandbox);
  sandbox.__elements = elements;
  sandbox.__storage = storage;
  return sandbox;
}

test("estimator calculates Warrensburg with lift, warranty, and both pricing paths", () => {
  const sb = loadEstimator();
  const result = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS);
  assert.equal(result.input.equipmentCost, 10000);
  assert.equal(result.membraneRolls, 13);
  assert.equal(result.manHours, 1000);
  assert.ok(result.warrantyFee > 1600);
  assert.ok(result.edgeTotal > 270000);
  assert.ok(result.ourTotal > result.edgeTotal);
  assert.match(result.wallNote, /4" coping stone is short/);
});

test("structurally sloped roofs do not carry the taper package", () => {
  const sb = loadEstimator();
  const result = sb.estimatorCalculate({ slopeType: "structural", taperCost: 17300 });
  const taper = result.materialItems.find((item) => item.name === "Tapered insulation package");
  assert.equal(taper.total, 0);
});

test("estimator refuses owner-only actions for non-owner users", () => {
  const sb = loadEstimator();
  sb.currentAuthClaims = { owner: false, role: "admin" };
  const result = sb.estimatorCalculateFromForm({ quiet: true });
  assert.equal(result, undefined);
});

test("estimator opens with a blank starter instead of the Warrensburg sample", () => {
  const sb = loadEstimator();
  sb.estimatorOnShow();
  assert.equal(sb.__elements["est-project-name"].value, "");
  assert.equal(sb.__elements["est-area-sf"].value, "0");
  assert.match(sb.__elements["estimator-results"].innerHTML, /Load a RoofMapper map/);
});

test("estimator imports a saved RoofMapper outline into estimate fields", () => {
  const sb = loadEstimator();
  const outline = {
    id: "rmo_local_1",
    tags: { name: "Prairie Farms" },
    areaSqFt: 12345.6,
    perimeterFt: 487.2,
    createdAt: 1770000000000
  };
  sb.localStorage.setItem(sb.ESTIMATOR_ROOFMAPPER_LOCAL_KEY, JSON.stringify([outline]));

  sb.estimatorOnShow();
  sb.estimatorOpenRoofMapperMaps();
  assert.match(sb.__elements["estimator-roofmapper-list"].innerHTML, /Prairie Farms/);

  sb.estimatorApplyRoofMapperMap(0);
  assert.equal(sb.__elements["est-project-name"].value, "Prairie Farms");
  assert.equal(sb.__elements["est-roofmap-id"].value, "rmo_local_1");
  assert.equal(sb.__elements["est-area-sf"].value, "12346");
  assert.equal(sb.__elements["est-overlay-sq"].value, "124");
  assert.equal(sb.__elements["est-perimeter-lf"].value, "487");

  const input = sb.estimatorReadForm();
  assert.equal(input.roofMapId, "rmo_local_1");
  assert.equal(input.spliceTapeRolls, 0);
  assert.deepEqual(input.screwRows, []);
  assert.equal(sb.estimatorLineItems.find((item) => item.name === '3" QuickSeam splice tape').total, 0);
});

test("estimator links a real CompanyCam project id and name", () => {
  const sb = loadEstimator();
  sb.estimatorCompanyCamProjects = [
    { id: "123", name: "Warrensburg Post Office", address: "Warrensburg, MO" }
  ];
  sb.estimatorSelectCompanyCamProject(0);
  assert.equal(sb.__elements["est-companycam-id"].value, "123");
  assert.equal(sb.__elements["est-companycam-name"].value, "Warrensburg Post Office");
  assert.match(sb.__elements["est-companycam-link"].innerHTML, /Linked to CompanyCam project/);
  const model = sb.estimatorReadForm();
  assert.equal(model.companyCamProjectId, "123");
  assert.equal(model.companyCamProjectName, "Warrensburg Post Office");
});

test("editable estimate line items change, delete, and add costs", () => {
  const sb = loadEstimator();
  const base = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS);
  sb.estimatorLineItems = base.lineItems.slice();
  const taperIndex = sb.estimatorLineItems.findIndex((item) => item.name === "Tapered insulation package");
  sb.estimatorUpdateLineItem(taperIndex, "total", "20000");
  let changed = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS, sb.estimatorLineItems);
  assert.equal(changed.materialItems[taperIndex].total, 20000);
  assert.ok(changed.edgeTotal > base.edgeTotal);

  sb.estimatorDeleteLineItem(taperIndex);
  changed = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS, sb.estimatorLineItems);
  assert.equal(changed.lineItems.some((item) => item.name === "Tapered insulation package"), false);
  assert.ok(changed.edgeTotal < base.edgeTotal);

  sb.estimatorAddLineItem(false);
  const last = sb.estimatorLineItems.length - 1;
  sb.estimatorUpdateLineItem(last, "name", "Extra lift delivery");
  sb.estimatorUpdateLineItem(last, "total", "2500");
  changed = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS, sb.estimatorLineItems);
  assert.ok(changed.otherItems.some((item) => item.name === "Extra lift delivery" && item.total === 2500));
});

test("generated estimate line items expose the prices used", () => {
  const sb = loadEstimator();
  const result = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS);
  const byName = Object.fromEntries(result.lineItems.map((item) => [item.name, item]));
  assert.match(byName["60 mil EPDM SA membrane"].unit, /\$185\.00\/SQ/);
  assert.match(byName["6\" QuickSeam batten cover"].unit, /\$450\.00\/roll/);
  assert.match(byName["New perimeter sheet metal"].unit, /\$20\.00\/LF/);
  assert.match(byName["20-year warranty fee"].unit, /\$0\.17\/SF/);
});

test("Warrensburg screw order is broken out by length and pail count", () => {
  const sb = loadEstimator();
  const result = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS);
  const screws = result.lineItems.filter((item) => item.name.includes("insulation screws"));
  assert.deepEqual(screws.map((item) => item.name), [
    '6" insulation screws',
    '7" insulation screws',
    '8" insulation screws',
    '9" insulation screws',
    '10" insulation screws'
  ]);
  assert.match(screws[0].qty, /2 pails \/ 1000 screws/);
  assert.match(screws[0].unit, /\$644\.00\/M, need 750/);
  assert.match(screws[4].qty, /1 pail \/ 500 screws/);
  assert.match(screws[4].unit, /\$1,217\.25\/M, need 250/);
});

test("estimator saves and reloads editable estimate snapshots", () => {
  const sb = loadEstimator();
  sb.estimatorLoadWarrensburg({ quiet: true });
  const result = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS);
  sb.estimatorLineItems = result.lineItems.slice();
  const liftIndex = sb.estimatorLineItems.findIndex((item) => item.name === "Lift / rental equipment");
  sb.estimatorUpdateLineItem(liftIndex, "total", "12500");
  sb.estimatorSaveCurrent("edge");

  const db = JSON.parse(sb.__storage[sb.ESTIMATOR_STORE_KEY]);
  assert.equal(db.estimates.length, 1);
  assert.equal(db.estimates[0].projectName, "Warrensburg Post Office");
  assert.equal(db.estimates[0].recordType, "estimate_job_file");
  assert.equal(db.estimates[0].pricingMethod, "edge");
  assert.equal(db.estimates[0].proposalAmount, db.estimates[0].totals.edgeTotal);
  assert.ok(db.estimates[0].jobFile.materialList.length > 20);

  sb.estimatorLineItems = null;
  sb.estimatorLoadSaved(db.estimates[0].id);
  const loadedLift = sb.estimatorLineItems.find((item) => item.name === "Lift / rental equipment");
  assert.equal(loadedLift.total, 12500);
});

test("saving Our Way creates a job file and proposal from that pricing path", () => {
  const sb = loadEstimator();
  sb.estimatorLoadWarrensburg({ quiet: true });
  sb.estimatorSaveCurrent("our");

  const db = JSON.parse(sb.__storage[sb.ESTIMATOR_STORE_KEY]);
  const saved = db.estimates[0];
  assert.equal(saved.recordType, "estimate_job_file");
  assert.equal(saved.pricingMethod, "our");
  assert.equal(saved.pricingLabel, "Our Way");
  assert.equal(saved.proposalAmount, saved.totals.ourTotal);
  assert.equal(saved.jobFile.companyCamProjectId, "");
  assert.ok(saved.jobFile.materialList.some((item) => item.name === '10" insulation screws'));

  sb.estimatorLoadSaved(saved.id);
  const text = sb.estimatorCreateProposal();
  assert.match(text, /WATKINS ROOFING PROPOSAL/);
  assert.match(text, /Proposal Amount:\n\$304,042\.94/);
  assert.doesNotMatch(text, /Our Way/);
  assert.doesNotMatch(text, /EDGE/);
});

test("proposal creation requires saving the selected pricing method first", () => {
  const sb = loadEstimator();
  sb.estimatorLoadWarrensburg({ quiet: true });
  const text = sb.estimatorCreateProposal();
  assert.equal(text, undefined);
});

test("proposal draft uses the EDGE proposal amount without internal alternate pricing", () => {
  const sb = loadEstimator();
  const result = sb.estimatorCalculate(sb.ESTIMATOR_DEFAULTS);
  const text = sb.estimatorProposalText(result);
  assert.match(text, /WATKINS ROOFING PROPOSAL/);
  assert.match(text, /Proposal Amount:\n\$273,375\.59/);
  assert.doesNotMatch(text, /Our Way/);
  assert.doesNotMatch(text, /Internal alternate/);
});
