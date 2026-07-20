const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* Building dedup + merge + CompanyCam name-sync (Mark, 106 Orr St, 2026-07-19).

   One real building became TWO records: "(unnamed project)" holding the base
   map and all 4 roofs, and "Orr St Studios - Roof Eval" holding the correct
   name and nothing else. Root cause: buildingIdFor() derives a building's
   document id FROM ITS NAME, so a save under a different name creates a second
   record instead of updating the first.

   These tests pin the three fixes: match an existing building on save,
   combine the two that already exist, and resolve the display name live so a
   CompanyCam rename actually shows. */

const coreSource = fs.readFileSync(path.join(__dirname, "..", "js", "core.js"), "utf8");
const companycamSource = fs.readFileSync(path.join(__dirname, "..", "js", "companycam.js"), "utf8");
const foundationSource = fs.readFileSync(path.join(__dirname, "..", "js", "foundation.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
const adminSource = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "admin.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(source, start, end){
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notStrictEqual(a, -1, "missing start marker: " + start);
  assert.notStrictEqual(b, -1, "missing end marker: " + end);
  return source.slice(a, b);
}

const ADDR_SRC = between(foundationSource, "function fdnNormalizeText", "function fdnUniqueMatch");
const DEDUP_SRC = between(coreSource, "async function findExistingBuildingId", "async function ensureCustomerAndBuilding");
const RANK_SRC = between(companycamSource, "function mergeRankDuplicateBuildings", "function mergeModalRender");
const NAME_SRC = between(companycamSource, "function ccBuildingDisplayName", "async function ccResolveBuildingProjectName");

/* A Firestore stand-in that records what was asked for, so the tests can assert
   the dedup consulted the identities in the intended ORDER of trust rather than
   just landing on a right-looking answer. */
function fakeDb(docs){
  const asked = [];
  return {
    asked,
    collection(){
      const api = {
        _field: null, _value: null,
        where(field, _op, value){ api._field = field; api._value = value; return api; },
        orderBy(){ return api; },
        limit(){ return api; },
        async get(){
          let hits;
          if (api._field){
            asked.push(api._field);
            hits = docs.filter(d => d[api._field] === api._value);
          } else {
            asked.push("scan");
            hits = docs.slice();
          }
          return { forEach(fn){ hits.forEach(d => fn({ id: d.id, data: () => d })); } };
        }
      };
      return api;
    }
  };
}

function dedupSandbox(docs){
  const sandbox = { fdb: fakeDb(docs), console: { warn(){} } };
  vm.createContext(sandbox);
  vm.runInContext(ADDR_SRC, sandbox);
  vm.runInContext(DEDUP_SRC, sandbox);
  return sandbox;
}

/* ================= dedup on save ================= */

test("a save matches the existing building by CompanyCam project id", () => {
  /* The 106 Orr St case exactly: both records carry the same CompanyCam
     project, and the save must land on the existing one. */
  const sb = dedupSandbox([
    { id: "bld_unnamed", companyCamProjectId: "cc_991", location: "106 Orr St, Columbia, MO" }
  ]);
  return sb.findExistingBuildingId({ companyCamProjectId: "cc_991", jobName: "Orr St Studios - Roof Eval" })
    .then(id => assert.equal(id, "bld_unnamed"));
});

test("Foundation job matches when there is no CompanyCam link", () => {
  const sb = dedupSandbox([{ id: "bld_a", foundationJobNo: "17460" }]);
  return sb.findExistingBuildingId({ foundationJobNo: "17460" })
    .then(id => assert.equal(id, "bld_a"));
});

test("address matches when neither stronger identity is present", () => {
  const sb = dedupSandbox([{ id: "bld_a", location: "106 Orr St, Columbia, MO 65201" }]);
  return sb.findExistingBuildingId({ location: "106 Orr Street, Columbia, MO 65201" })
    .then(id => assert.equal(id, "bld_a", "Orr St and Orr Street must normalise the same"));
});

test("identities are consulted strongest-first", () => {
  /* CompanyCam before Foundation before address. If a weaker identity were
     checked first it could win on a building the stronger one disagrees with. */
  const sb = dedupSandbox([
    { id: "bld_cc", companyCamProjectId: "cc_991" },
    { id: "bld_fdn", foundationJobNo: "17460" }
  ]);
  return sb.findExistingBuildingId({ companyCamProjectId: "cc_991", foundationJobNo: "17460" })
    .then(id => {
      assert.equal(id, "bld_cc");
      assert.equal(sb.fdb.asked[0], "companyCamProjectId", "CompanyCam must be asked first");
    });
});

test("an AMBIGUOUS match returns null rather than guessing", () => {
  /* Two buildings sharing an identity means the data is already wrong.
     Silently writing into one of them would be worse than the duplicate this
     is preventing -- fall back to the old name-derived path instead. */
  const sb = dedupSandbox([
    { id: "bld_a", companyCamProjectId: "cc_991" },
    { id: "bld_b", companyCamProjectId: "cc_991" }
  ]);
  return sb.findExistingBuildingId({ companyCamProjectId: "cc_991" })
    .then(id => assert.equal(id, null));
});

test("archived buildings are never matched", () => {
  /* A record archived by a merge must not be resurrected by the next save --
     that would undo the merge one work order at a time. */
  const sb = dedupSandbox([
    { id: "bld_merged_away", companyCamProjectId: "cc_991", archived: true }
  ]);
  return sb.findExistingBuildingId({ companyCamProjectId: "cc_991" })
    .then(id => assert.equal(id, null));
});

test("no identities at all returns null, leaving old behaviour intact", () => {
  const sb = dedupSandbox([{ id: "bld_a", location: "106 Orr St" }]);
  return sb.findExistingBuildingId({ jobName: "Something New" })
    .then(id => assert.equal(id, null));
});

test("a dedup failure never blocks a save", () => {
  /* Offline, or a missing Firestore index, must degrade to the old path rather
     than throwing inside the save. */
  const sandbox = { fdb: { collection(){ throw new Error("offline"); } }, console: { warn(){} } };
  vm.createContext(sandbox);
  vm.runInContext(ADDR_SRC, sandbox);
  vm.runInContext(DEDUP_SRC, sandbox);
  return sandbox.findExistingBuildingId({ companyCamProjectId: "cc_991" })
    .then(id => assert.equal(id, null));
});

test("the save path consults dedup BEFORE deriving an id from the name", () => {
  const line = between(coreSource, "var bldId = o.buildingId", ";");
  assert.match(line, /findExistingBuildingId\(o\)/);
  assert.match(line, /o\.buildingId \|\|/, "a stored id must still win outright");
  assert.ok(line.indexOf("findExistingBuildingId") < line.indexOf("buildingIdFor"),
    "matching must be attempted before falling back to the name-derived id");
});

/* ================= finding the duplicates that already exist ================= */

function rankSandbox(){
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(ADDR_SRC, sandbox);
  vm.runInContext(RANK_SRC, sandbox);
  return sandbox;
}

test("the 106 Orr St pair is found — the pair name-matching MISSED", () => {
  /* buildingsLikelyDuplicate() requires a shared customer name, and the
     "(unnamed project)" record has none, so it never saw this pair. Identity
     matching does. */
  const sb = rankSandbox();
  const survivor = { id: "bld_named", name: "Orr St Studios - Roof Eval",
    customerName: "ORRST", companyCamProjectId: "cc_991", location: "106 Orr St, Columbia, MO" };
  const out = sb.mergeRankDuplicateBuildings([
    { id: "bld_other", name: "Somewhere Else", location: "9 Elm St, Springfield, IL" },
    { id: "bld_unnamed", name: "(unnamed project)", customerName: "", companyCamProjectId: "cc_991",
      location: "106 Orr St, Columbia, MO", roofs: [1,2,3,4] }
  ], survivor);
  assert.equal(out.length, 1, "only the real duplicate should be offered");
  assert.equal(out[0].building.id, "bld_unnamed");
  assert.equal(out[0].why, "same CompanyCam project");
});

test("candidates rank CompanyCam over Foundation over address", () => {
  const sb = rankSandbox();
  const survivor = { companyCamProjectId: "cc_1", foundationJobNo: "17460", location: "106 Orr St, Columbia, MO" };
  const out = sb.mergeRankDuplicateBuildings([
    { id: "by_addr", location: "106 Orr St, Columbia, MO" },
    { id: "by_fdn", foundationJobNo: "17460" },
    { id: "by_cc", companyCamProjectId: "cc_1" }
  ], survivor);
  assert.deepEqual(out.map(r => r.building.id), ["by_cc", "by_fdn", "by_addr"]);
});

test("unrelated buildings are never offered as merge candidates", () => {
  /* Merging is hard to reverse; an unrelated building must not be one mis-tap
     away from absorbing another. */
  const sb = rankSandbox();
  const out = sb.mergeRankDuplicateBuildings(
    [{ id: "x", name: "Unrelated", location: "9 Elm St, Springfield, IL" }],
    { companyCamProjectId: "cc_1", location: "106 Orr St, Columbia, MO" });
  assert.equal(out.length, 0);
});

/* ================= display name ================= */

function nameSandbox(cache){
  const sandbox = { ccProjectNameCache: cache || {} };
  vm.createContext(sandbox);
  vm.runInContext("var ccProjectNameCache = ccProjectNameCache || {};", sandbox);
  vm.runInContext(NAME_SRC, sandbox);
  return sandbox;
}

test("the placeholder never wins over a live CompanyCam name", () => {
  const sb = nameSandbox({ cc_991: "Orr Street Studios" });
  assert.equal(sb.ccBuildingDisplayName({ name: "(unnamed project)", companyCamProjectId: "cc_991" }),
    "Orr Street Studios");
});

test("a real stored name is never overridden by CompanyCam", () => {
  /* A tech's deliberate building name must survive a CompanyCam rename. */
  const sb = nameSandbox({ cc_991: "Something Else In CompanyCam" });
  assert.equal(sb.ccBuildingDisplayName({ name: "Orr St Studios - Roof Eval", companyCamProjectId: "cc_991" }),
    "Orr St Studios - Roof Eval");
});

test("Foundation job name is the fallback when CompanyCam has no name either", () => {
  const sb = nameSandbox({ cc_991: "(unnamed project)" });
  assert.equal(sb.ccBuildingDisplayName({ name: "(unnamed project)", companyCamProjectId: "cc_991",
    foundationJobName: "Orr Street Studios" }), "Orr Street Studios");
});

test("a building with nothing at all still renders something usable", () => {
  const sb = nameSandbox({});
  assert.equal(sb.ccBuildingDisplayName({}), "Unnamed building");
  assert.equal(sb.ccBuildingDisplayName(null), "Unnamed building");
});

/* ================= server merge + wiring ================= */

test("merge_buildings moves roofs, history and reports, and archives the source", () => {
  const block = between(adminSource, 'if (body.action === "merge_buildings")', 'if (body.action === "move_roof")');
  assert.match(block, /requirePermission\(event, "settings\.company"\)/, "same tier as move_roof");
  assert.match(block, /building_history_events/);
  assert.match(block, /collection\("reports"\)/);
  assert.match(block, /archived: true/);
  assert.match(block, /mergedIntoBuildingId/, "the archived record must record where it went");
  assert.match(block, /writeAuditLog/);
  assert.doesNotMatch(block, /\.delete\(\)/, "a merge must archive, never delete");
});

test("history/report re-pointing is NOT filtered by roofId", () => {
  /* Events written before roofs[] existed carry no roofId. Filtering by roof
     would strand exactly the oldest history a merge is meant to rescue. */
  const block = between(adminSource, 'if (body.action === "merge_buildings")', 'if (body.action === "move_roof")');
  const evtLine = between(block, 'collection("building_history_events")', ".get()");
  assert.doesNotMatch(evtLine, /roofId/);
});

test("the merge writes in chunks so a long history cannot hit the batch cap", () => {
  const block = between(adminSource, 'if (body.action === "merge_buildings")', 'if (body.action === "move_roof")');
  assert.match(block, /i \+= 400/, "Firestore caps a batch at 500 writes");
});

test("the placeholder can never become the surviving name", () => {
  const block = between(adminSource, 'if (body.action === "merge_buildings")', 'if (body.action === "move_roof")');
  assert.match(block, /PLACEHOLDER = "\(unnamed project\)"/);
  assert.match(block, /realName/);
});

test("links are carried forward only where the survivor has none", () => {
  /* A merge must never silently re-point a building that already has its own
     CompanyCam project. */
  const block = between(adminSource, 'if (body.action === "merge_buildings")', 'if (body.action === "move_roof")');
  assert.match(block, /if \(!dstBld\.companyCamProjectId && srcBld\.companyCamProjectId\)/);
  assert.match(block, /if \(!dstBld\.foundationJobNo && srcBld\.foundationJobNo\)/);
});

test("Building History resolves the CompanyCam name live before rendering", () => {
  assert.match(historySource, /ccResolveBuildingProjectName\(buildingId, bld\)/);
  assert.match(historySource, /ccRefreshBuildingProjectName/, "manual refresh is wired");
  assert.match(historySource, /openMergeBuildingModal/, "merge is reachable from Building History");
});

test("the merge and refresh controls are admin-gated in both render paths", () => {
  const decl = between(historySource, "var mergeBtnHtml", "var roofPickerHtml");
  assert.match(decl, /isAdmin \?/);
  const merges = historySource.split("mergeBtnHtml").length - 1;
  assert.ok(merges >= 3, "declared once, rendered in both roof paths, saw " + merges);
});

test("the merge modal exists and is wired", () => {
  assert.match(indexSource, /id="merge-bld-modal"/);
  assert.match(indexSource, /id="merge-bld-list"/);
  assert.match(indexSource, /id="merge-bld-keep"/);
  assert.match(indexSource, /closeMergeBuildingModal\(\)/);
});

test("the merge is confirmed and spells out what moves", () => {
  const block = between(companycamSource, "async function mergeModalPick", "live CompanyCam name resolution");
  assert.match(block, /confirm\(/);
  assert.match(block, /ARCHIVED \(not deleted\)/);
  assert.match(block, /not instant to reverse/);
});
