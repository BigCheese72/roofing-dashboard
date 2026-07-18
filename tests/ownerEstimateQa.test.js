"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadQa(){
  const elements = {};
  const sandbox = {
    currentAuthClaims: { owner: true },
    currentId: "wo_1",
    ccLinkedProjectId: "cc_1",
    ccLinkedProjectName: "Warrensburg Post Office",
    photos: [
      { caption: "Existing stone coping and parapet wall." },
      { caption: "Roof drain needs retrofit insert." },
      { caption: "Lift access on east side." }
    ],
    findings: [
      { condition: "Canopy roof needs taper/slope confirmed.", location: "R1" },
      { condition: "RTU curb flashing at roof transition.", location: "Main roof" }
    ],
    materials: [],
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
    Date, Math, JSON, Number, String, Boolean, Array, Object, Promise
  };
  elements.jobName = { value: "Warrensburg Post Office" };
  elements.location = { value: "Warrensburg, MO" };
  elements.billTo = { value: "Dan Staat" };
  elements.woType = { value: "Estimate" };
  elements.woDescription = { value: "20-year EPDM SA roof replacement with tear-off and disposal." };
  elements.repairDescription = { value: "" };
  elements.roofSystem = { value: "60 mil EPDM SA" };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "owner-estimate-qa.js"), "utf8"), sandbox);
  sandbox.__elements = elements;
  return sandbox;
}

test("Owner Estimate QA groups job evidence into estimating risk categories", () => {
  const sb = loadQa();
  const result = sb.ownerEstimateQaScanActive({ quiet: true });
  assert.ok(result.groups.access.length, "lift/access evidence should be detected");
  assert.ok(result.groups.drain.length, "drain evidence should be detected");
  assert.ok(result.groups.wall.length, "coping/parapet evidence should be detected");
  assert.ok(result.groups.taper.length, "taper/slope evidence should be detected");
  assert.ok(result.groups.curb.length, "curb/RTU evidence should be detected");
  assert.ok(result.groups.tearoff.length, "tear-off/disposal evidence should be detected");
  assert.match(sb.__elements["ownerqa-checklist"].innerHTML, /Lift \/ access allowance/);
  assert.match(sb.__elements["ownerqa-evidence"].innerHTML, /Walls \/ Coping/);
});

test("Owner Estimate QA refuses to run for non-owner users", () => {
  const sb = loadQa();
  sb.currentAuthClaims = { owner: false, role: "admin" };
  const result = sb.ownerEstimateQaScanActive({ quiet: true });
  assert.strictEqual(result, undefined);
});
