const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Regression cover for the Change Order CompanyCam gap: hiding
   #wo-globalphotos-card for Change Orders (onWoTypeChange(), js/core.js) also
   hid #cc-link-info and the "Import from CompanyCam" button — the ONLY
   CompanyCam entry point a Change Order had. These tests pin the two halves
   of the fix: the banner renders into the Change Order's own host, and a CO on
   an already-linked building inherits that link so its signed PDF pushes. */
const source = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

function fakeHost(){ return { innerHTML: "" }; }

function makeSandbox(opts){
  opts = opts || {};
  const hosts = {
    "cc-link-info": fakeHost(),
    "cc-link-info-co": fakeHost()
  };
  const sandbox = {
    hosts,
    isAdmin: false,
    ccLinkedProjectId: opts.linkedProjectId || null,
    ccLinkedProjectName: opts.linkedProjectName || "",
    fdb: opts.fdb === undefined ? {
      collection(){ return { doc(){ return { async get(){ return opts.buildingSnap || { exists: false }; } }; } }; }
    } : opts.fdb,
    __fields: Object.assign({}, opts.fields),
    __toasts: [],
    console: { warn(){} },
    document: { getElementById(id){ return hosts[id] || null; } },
    esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, ""); },
    toast(m){ sandbox.__toasts.push(m); },
    val(id){ return sandbox.__fields[id] || ""; },
    currentWorkOrderBuildingId(){ return opts.buildingId === undefined ? "bld_acme_north" : opts.buildingId; }
  };
  vm.createContext(sandbox);
  vm.runInContext(between("var CC_LINK_INFO_HOST_IDS", "function unlinkCC"), sandbox);
  return sandbox;
}

test("index.html gives the Change Order form its own CompanyCam link host and button", () => {
  const coCard = indexHtml.slice(
    indexHtml.indexOf('id="wo-changeorder-card"'),
    indexHtml.indexOf('id="wo-warrantydetermination-card"')
  );
  assert.ok(coCard.indexOf('id="cc-link-info-co"') !== -1,
    "Change Order card must host the CompanyCam link banner");
  assert.ok(coCard.indexOf("openCC()") !== -1,
    "Change Order card must have a CompanyCam link/import affordance");
});

test("the link banner renders into BOTH hosts, so a Change Order can see it", () => {
  const s = makeSandbox({ linkedProjectId: "ccp_123", linkedProjectName: "Acme North Warehouse" });
  s.renderCCLinkInfo();
  assert.ok(s.hosts["cc-link-info"].innerHTML.indexOf("Acme North Warehouse") !== -1);
  assert.ok(s.hosts["cc-link-info-co"].innerHTML.indexOf("Acme North Warehouse") !== -1);
});

test("unlinked: the Change Order host says the PDF will not be saved to CompanyCam", () => {
  const s = makeSandbox({});
  s.renderCCLinkInfo();
  assert.strictEqual(s.hosts["cc-link-info"].innerHTML, "", "global host behavior is unchanged");
  assert.ok(s.hosts["cc-link-info-co"].innerHTML.indexOf("No CompanyCam project linked") !== -1);
});

test("a Change Order on a linked building inherits the building's CompanyCam project", async () => {
  const s = makeSandbox({
    fields: { woType: "Change Order" },
    buildingSnap: { exists: true, data(){ return { companyCamProjectId: "ccp_777", name: "North Warehouse" }; } }
  });
  const out = await s.resolveChangeOrderCompanyCamLink();
  assert.strictEqual(out.linked, true);
  assert.strictEqual(s.ccLinkedProjectId, "ccp_777");
  /* This is exactly what uploadLinkedPdfToCompanyCam() gates on: with a
     project id on the collected order it pushes; without one it returns
     { skipped: true }. */
  assert.ok(s.hosts["cc-link-info-co"].innerHTML.indexOf("North Warehouse") !== -1);
});

test("a building with no CompanyCam project stays unlinked — nothing is auto-created", async () => {
  const s = makeSandbox({
    fields: { woType: "Change Order" },
    buildingSnap: { exists: true, data(){ return { name: "Brand New Building" }; } }
  });
  const out = await s.resolveChangeOrderCompanyCamLink();
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, "building-not-linked");
  assert.strictEqual(s.ccLinkedProjectId, null);
});

test("an explicit link made in this session is never clobbered", async () => {
  const s = makeSandbox({
    linkedProjectId: "ccp_manual",
    fields: { woType: "Change Order" },
    buildingSnap: { exists: true, data(){ return { companyCamProjectId: "ccp_777" }; } }
  });
  const out = await s.resolveChangeOrderCompanyCamLink();
  assert.strictEqual(out.alreadyLinked, true);
  assert.strictEqual(s.ccLinkedProjectId, "ccp_manual");
});

test("non-Change-Order types are not touched by the resolver", async () => {
  for (const woType of ["Leak / Service", "Repair", "Inspection", "Warranty"]){
    const s = makeSandbox({
      fields: { woType: woType },
      buildingSnap: { exists: true, data(){ return { companyCamProjectId: "ccp_777" }; } }
    });
    const out = await s.resolveChangeOrderCompanyCamLink();
    assert.strictEqual(out.reason, "not-a-change-order", woType);
    assert.strictEqual(s.ccLinkedProjectId, null, woType + " must stay as it was");
  }
});

test("offline: no link is invented", async () => {
  const s = makeSandbox({ fdb: null, fields: { woType: "Change Order" } });
  const out = await s.resolveChangeOrderCompanyCamLink();
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, "offline");
  assert.strictEqual(s.ccLinkedProjectId, null);
});
