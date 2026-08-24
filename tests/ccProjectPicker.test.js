const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* CompanyCam project picker for a BUILDING (Mark, field 2026-07-19).

   A building linked to the wrong CompanyCam project -- or one reading
   "(unnamed project)" -- had no in-app fix. Building History's "Move to
   Different Building" re-points a ROOF at a different RoofOps building; this
   re-points the BUILDING at a different CompanyCam project, which is what
   decides where its photos and signed PDFs actually land.

   The ranking under test carries the PRAIRIE FARMS lesson: a CompanyCam site
   name routinely differs from the Foundation customer name, so ADDRESS is the
   reliable key and name is only a fallback. If these assertions ever fail
   because ranking changed, check that rule still holds before relaxing them. */

const companycamSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const foundationSource = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const roofmapperSource = fs.readFileSync(path.join(__dirname, "..", "js", "roofmapper.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

/* The ranker leans on Foundation's address normaliser rather than restating
   one -- so the suite loads the real thing, not a stand-in. A stub here would
   test nothing about how a real address actually normalises. */
const ADDR_SRC = between(foundationSource, "function fdnNormalizeText", "function fdnUniqueMatch");
const RANK_SRC = between(companycamSource,
  "function ccRankProjectsForBuilding", "var ccLinkModalBuildingId");

function rank(projects, address, name){
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(ADDR_SRC, sandbox);
  vm.runInContext(RANK_SRC, sandbox);
  return sandbox.ccRankProjectsForBuilding(projects, address, name);
}

const PRAIRIE = { id: "1", name: "Prairie Farms Dairy - Carlinville", address: "1200 W Main St, Carlinville, IL 62626" };
const OTHER   = { id: "2", name: "Some Other Site", address: "45 Elm Ave, Springfield, IL 62701" };
const SAMENUM = { id: "3", name: "Different Town Site", address: "1200 W Main St, Decatur, IL 62521" };
const NAMEONLY= { id: "4", name: "Prairie Farms Dairy - Carlinville", address: "" };

test("address beats name — the Prairie Farms rule", () => {
  /* The customer is "Prairie Farms Dairy Inc" in Foundation but the CompanyCam
     site is named for the town. Matching on the address must win, and must not
     be outranked by a project that merely shares the name. */
  const out = rank([OTHER, NAMEONLY, PRAIRIE], "1200 W Main St, Carlinville, IL 62626", "Prairie Farms Dairy Inc");
  assert.equal(out[0].project.id, "1");
  assert.equal(out[0].why, "address match");
});

test("a same street number in a DIFFERENT city is not called an address match", () => {
  /* "1200 W Main St" exists in a lot of towns. Treating that as an address
     match is precisely how the wrong customer's project gets linked. */
  const out = rank([SAMENUM], "1200 W Main St, Carlinville, IL 62626", "Prairie Farms");
  assert.notEqual(out[0].why, "address match");
  assert.equal(out[0].why, "same street, different city/state");
});

test("the true address match outranks the same-street-different-city near miss", () => {
  const out = rank([SAMENUM, PRAIRIE], "1200 W Main St, Carlinville, IL 62626", "");
  assert.equal(out[0].project.id, "1", "Carlinville must come first");
  assert.equal(out[1].project.id, "3");
});

test("name matching still works when the building has no address", () => {
  const out = rank([OTHER, NAMEONLY], "", "Prairie Farms Dairy - Carlinville");
  assert.equal(out[0].project.id, "4");
  assert.equal(out[0].why, "name match");
});

test("a partial name match ranks below an exact one but above nothing", () => {
  const exact   = { id: "e", name: "Watkins Warehouse", address: "" };
  const partial = { id: "p", name: "Watkins Warehouse North Annex", address: "" };
  const out = rank([OTHER, partial, exact], "", "Watkins Warehouse");
  assert.equal(out[0].project.id, "e");
  assert.equal(out[1].project.id, "p");
  assert.equal(out[1].why, "partial name match");
  assert.equal(out[2].why, "", "an unrelated project gets no match reason");
});

test("every candidate is returned, never filtered away", () => {
  /* This is a PICKER, not an auto-matcher: the user must be able to choose a
     project the ranking did not favour. smMatchCompanyCamProject() returns one
     match or null; that behaviour would make this feature useless. */
  const out = rank([OTHER, SAMENUM, PRAIRIE, NAMEONLY], "1200 W Main St, Carlinville, IL 62626", "Prairie Farms");
  assert.equal(out.length, 4);
  assert.deepEqual(out.map(r => r.project.id).sort(), ["1","2","3","4"]);
});

test("no address and no name still returns every project, unranked", () => {
  /* A building with nothing recorded must still let the user browse and pick,
     rather than showing an empty list. */
  const out = rank([OTHER, PRAIRIE], "", "");
  assert.equal(out.length, 2);
  out.forEach(r => assert.equal(r.why, ""));
});

test("an empty project list is handled without throwing", () => {
  assert.deepEqual(rank([], "1200 W Main St", "Anything"), []);
  assert.deepEqual(rank(null, "", ""), []);
});

test("projects missing name or address do not break ranking", () => {
  const ragged = [{ id: "x" }, { id: "y", name: null, address: null }];
  const out = rank(ragged, "1200 W Main St, Carlinville, IL", "Prairie Farms");
  assert.equal(out.length, 2);
});

/* ================= wiring ================= */

test("Building History exposes the picker, admin-gated like Move", () => {
  /* Re-pointing the building decides where its photos and PDFs land, so it
     sits at the same tier as the cross-building Move beside it -- not a label
     edit. */
  assert.match(historySource, /openCcProjectPicker\(/);
  const btn = between(historySource, "var ccLinkBtnHtml", "'</select>' + renameBtnHtml");
  assert.match(btn, /isAdmin \?/, "the CompanyCam re-link must be admin-gated");
  /* It has to be rendered in BOTH the multi-roof <select> path and the
     single-roof line, or it silently disappears on one of them. */
  const renders = historySource.split("ccLinkBtnHtml").length - 1;
  assert.ok(renders >= 3, "declared once and rendered in both paths, saw " + renders);
});

test("RoofMapper exposes the picker once a roof is linked to a building", () => {
  const block = between(roofmapperSource, "function rmRenderLinkedJobInfo", "function rmClearLinkedJob");
  assert.match(block, /rmState\.linkedBuildingId/);
  assert.match(block, /openCcProjectPicker/);
  assert.match(block, /isAdmin/, "same admin tier as the Building History control");
});

test("the modal exists and is wired to the picker's handlers", () => {
  assert.match(indexSource, /id="cc-link-modal"/);
  assert.match(indexSource, /id="cc-link-search"/);
  assert.match(indexSource, /id="cc-link-results"/);
  assert.match(indexSource, /id="cc-link-current"/);
  assert.match(indexSource, /ccLinkModalOnInput\(\)/);
  assert.match(indexSource, /closeCcProjectPicker\(\)/);
});

test("the search is read-only against CompanyCam — no project is ever created", () => {
  /* RoofOps creates CompanyCam projects in exactly one permission-gated,
     audit-logged place (Service Manager). A re-link picker must never become a
     second one: picking the wrong thing here should be correctable, not
     generative. */
  const block = between(companycamSource, "function ccRankProjectsForBuilding", "toast(\"Linked to \"");
  assert.match(block, /action: "projects"/, "reads via the existing search action");
  assert.doesNotMatch(block, /create_project/, "the picker must never create a CompanyCam project");
});

test("linking writes both the id and the name onto the building", () => {
  /* The stored name is what Building History renders; writing only the id is
     how a building ends up displaying "(unnamed project)" despite pointing at
     a perfectly well-named one. */
  const block = between(companycamSource, "async function ccLinkModalPick", "toast(\"Linked to \"");
  assert.match(block, /companyCamProjectId: String\(p\.id\)/);
  assert.match(block, /companyCamProjectName/);
  assert.match(block, /confirm\(/, "re-pointing must be confirmed, not one-tap");
});
