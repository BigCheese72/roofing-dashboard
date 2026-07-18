"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEstimator(){
  const elements = {};
  const sandbox = {
    currentAuthClaims: { owner: true },
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
