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
