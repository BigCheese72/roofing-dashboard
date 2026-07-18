"use strict";
/* Owner-only estimating workspace.
   This is intentionally estimate-first: it starts from drawings, photos,
   field notes, cores, wall heights, and system choices. A work order can be
   created later if the job sells, but this model does not depend on one. */

var ESTIMATOR_DEFAULTS = {
  projectName: "Warrensburg Post Office",
  location: "Warrensburg, MO",
  contact: "Dan Staat",
  companyCamProjectId: "",
  companyCamProjectName: "",
  fieldNotes: "60 mil Elevate RubberGard EPDM SA. Tapered package plus continuous 2.6 inch ISO overlay. Rebuild perimeter above highest roof point after 4-5 inch stone coping removal. Include 20-year warranty, retrofit drains, lift/rental equipment, disposal, travel, metal, and both EDGE / Our Way pricing.",
  membrane: "epdm-sa",
  warrantyYears: 20,
  areaSf: 9725.6,
  slopeType: "tapered",
  taperCost: 17300,
  overlayIn: 2.6,
  overlaySq: 100,
  overlayCostSq: 140,
  perimeterLf: 575,
  stoneCopingIn: 5,
  maxTaperIn: 4.5,
  tearoffIn: 2,
  blockingCost: 10120,
  metalLfCost: 20,
  equipmentCost: 10000,
  disposalCost: 6000,
  retrofitDrainCount: 8,
  retrofitDrainCost: 1000,
  crewSize: 5,
  hoursPerDay: 10,
  workingDays: 20,
  edgeLaborRate: 113,
  ourLaborRate: 85,
  perDiem: 50,
  hotelRooms: 3,
  hotelNightCost: 150,
  hotelNights: 16,
  materialTaxRate: 0.0798,
  edgeProfitRate: 0.06,
  edgeBondRate: 0.0185,
  ourMarkupRate: 0.35,
  warrantyRateSf: 0.17,
  membraneWasteRate: 0.10,
  membraneRollSq: 10,
  membraneSqPrice: 185,
  extraSaRollsForWalls: 2,
  spliceTapeRolls: 17,
  spliceTapeRollPrice: 289.35,
  battenCoverRolls: 6,
  battenCoverRollPrice: 450,
  quickSeamFlashingRolls: 5,
  quickSeamFlashingRollPrice: 289.35,
  quickPrimePails: 8,
  quickPrimePrice: 156,
  rpfRolls: 7,
  rpfRollPrice: 275,
  insulationPlateCount: 2500,
  insulationPlatePricePerM: 264,
  screwRows: [
    { length: "6\"", needed: 750, pails: 2, ordered: 1000, pricePerM: 644.00 },
    { length: "7\"", needed: 650, pails: 2, ordered: 1000, pricePerM: 837.25 },
    { length: "8\"", needed: 500, pails: 1, ordered: 500, pricePerM: 934.00 },
    { length: "9\"", needed: 400, pails: 1, ordered: 500, pricePerM: 1133.50 },
    { length: "10\"", needed: 250, pails: 1, ordered: 500, pricePerM: 1217.25 }
  ],
  seamPlateCost: 338.15,
  tJointCovers: 2,
  tJointCoverPrice: 125,
  waterBlockTubes: 24,
  waterBlockPrice: 9,
  lapSealantTubes: 48,
  lapSealantPrice: 10,
  cleanerGallons: 10,
  cleanerPricePerGal: 23,
  pipeBoots: 2,
  pipeBootPrice: 95,
  scupperFlashing: 200,
  miscDetailMaterials: 1500
};

var ESTIMATOR_FIELDS = {
  projectName: "est-project-name",
  location: "est-location",
  contact: "est-contact",
  companyCamProjectId: "est-companycam-id",
  companyCamProjectName: "est-companycam-name",
  fieldNotes: "est-field-notes",
  membrane: "est-membrane",
  warrantyYears: "est-warranty-years",
  areaSf: "est-area-sf",
  slopeType: "est-slope-type",
  taperCost: "est-taper-cost",
  overlayIn: "est-overlay-in",
  overlaySq: "est-overlay-sq",
  overlayCostSq: "est-overlay-cost-sq",
  perimeterLf: "est-perimeter-lf",
  stoneCopingIn: "est-stone-coping-in",
  maxTaperIn: "est-max-taper-in",
  tearoffIn: "est-tearoff-in",
  blockingCost: "est-blocking-cost",
  metalLfCost: "est-metal-lf-cost",
  equipmentCost: "est-equipment-cost",
  disposalCost: "est-disposal-cost",
  crewSize: "est-crew-size",
  hoursPerDay: "est-hours-day",
  workingDays: "est-working-days",
  edgeLaborRate: "est-edge-labor-rate",
  ourLaborRate: "est-our-labor-rate",
  perDiem: "est-per-diem",
  hotelRooms: "est-hotel-rooms",
  hotelNightCost: "est-hotel-night",
  hotelNights: "est-hotel-nights",
  materialTaxRate: "est-tax-rate",
  edgeProfitRate: "est-edge-profit",
  edgeBondRate: "est-edge-bond",
  ourMarkupRate: "est-our-markup"
};

var estimatorCompanyCamProjects = [];
var estimatorLineItems = null;
var estimatorLastInput = null;
var ESTIMATOR_STORE_KEY = "roofops_estimates_v1";

function estimatorIsOwner(){
  return !!(currentAuthClaims && currentAuthClaims.owner === true);
}

function estimatorOnShow(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    showView("edit");
    return;
  }
  var nameEl = document.getElementById("est-project-name");
  if (nameEl && !nameEl.value) estimatorLoadWarrensburg({ quiet: true });
}

function estimatorMoney(n){
  return "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function estimatorSlug(s){
  return String(s || "estimate").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "estimate";
}

function estimatorSavedDb(){
  try{
    var raw = localStorage.getItem(ESTIMATOR_STORE_KEY);
    var parsed = raw ? JSON.parse(raw) : null;
    return parsed && Array.isArray(parsed.estimates) ? parsed : { estimates: [] };
  }catch(e){
    return { estimates: [] };
  }
}

function estimatorWriteSavedDb(db){
  localStorage.setItem(ESTIMATOR_STORE_KEY, JSON.stringify(db || { estimates: [] }));
}

function estimatorNumber(n, digits){
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0 });
}

function estimatorParseNumber(value){
  var n = Number(String(value == null ? "" : value).replace(/[$,%\s,]/g, ""));
  return isFinite(n) ? n : 0;
}

function estimatorRateFromInput(value){
  var n = estimatorParseNumber(value);
  return n > 1 ? n / 100 : n;
}

function estimatorSetVal(id, value){
  var el = document.getElementById(id);
  if (!el) return;
  if (id === "est-tax-rate" || id === "est-edge-profit" || id === "est-edge-bond" || id === "est-our-markup"){
    el.value = String(Math.round(Number(value || 0) * 10000) / 100) + "%";
  }else{
    el.value = value == null ? "" : String(value);
  }
}

function estimatorReadForm(){
  var out = Object.assign({}, ESTIMATOR_DEFAULTS);
  Object.keys(ESTIMATOR_FIELDS).forEach(function(key){
    var id = ESTIMATOR_FIELDS[key];
    var el = document.getElementById(id);
    if (!el) return;
    var raw = el.value;
    if (key === "materialTaxRate" || key === "edgeProfitRate" || key === "edgeBondRate" || key === "ourMarkupRate"){
      out[key] = estimatorRateFromInput(raw);
    }else if (typeof ESTIMATOR_DEFAULTS[key] === "number"){
      out[key] = estimatorParseNumber(raw);
    }else{
      out[key] = raw;
    }
  });
  return out;
}

function estimatorLoadWarrensburg(opts){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  Object.keys(ESTIMATOR_FIELDS).forEach(function(key){
    estimatorSetVal(ESTIMATOR_FIELDS[key], ESTIMATOR_DEFAULTS[key]);
  });
  estimatorRenderCompanyCamLink();
  estimatorLineItems = null;
  estimatorCalculateFromForm({ quiet: true });
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Warrensburg estimate model loaded.");
  }
}

function estimatorCurrentSnapshot(){
  var input = estimatorReadForm();
  var result = estimatorCalculate(input, estimatorLineItems || undefined);
  return {
    id: "est_" + Date.now(),
    savedAt: Date.now(),
    projectName: input.projectName || "(untitled estimate)",
    location: input.location || "",
    contact: input.contact || "",
    input: input,
    lineItems: result.lineItems,
    totals: {
      edgeTotal: result.edgeTotal,
      ourTotal: result.ourTotal,
      edgePerSquare: result.pricePerSquareEdge,
      ourPerSquare: result.pricePerSquareOur
    }
  };
}

function estimatorSaveCurrent(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var snap = estimatorCurrentSnapshot();
  var db = estimatorSavedDb();
  db.estimates = db.estimates.filter(function(e){ return e.id !== snap.id; });
  db.estimates.unshift(snap);
  db.estimates = db.estimates.slice(0, 50);
  try{
    estimatorWriteSavedDb(db);
    if (typeof toast === "function") toast("Estimate saved on this device.");
    estimatorRenderSavedList();
  }catch(e){
    if (typeof toast === "function") toast("Could not save estimate: " + e.message);
  }
}

function estimatorOpenSaved(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorRenderSavedList();
  var card = document.getElementById("estimator-saved-card");
  if (card) card.style.display = "";
}

function estimatorRenderSavedList(){
  var host = document.getElementById("estimator-saved-list");
  if (!host) return;
  var db = estimatorSavedDb();
  if (!db.estimates.length){
    host.innerHTML = "<p class=\"hint\">No saved estimates on this device yet.</p>";
    return;
  }
  host.innerHTML = db.estimates.map(function(e){
    return "<div class=\"saved-item\"><div class=\"info\"><div class=\"name\">" + esc(e.projectName || "(untitled estimate)") +
      "</div><div class=\"meta\">" + esc(e.location || "") + " · EDGE " + estimatorMoney(e.totals && e.totals.edgeTotal) +
      " · Our Way " + estimatorMoney(e.totals && e.totals.ourTotal) + "</div></div>" +
      "<button class=\"btn\" onclick=\"estimatorLoadSaved('" + esc(e.id) + "')\">Open</button></div>";
  }).join("");
}

function estimatorLoadSaved(id){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var db = estimatorSavedDb();
  var found = db.estimates.filter(function(e){ return e.id === id; })[0];
  if (!found){
    if (typeof toast === "function") toast("Saved estimate not found.");
    return;
  }
  Object.keys(ESTIMATOR_FIELDS).forEach(function(key){
    estimatorSetVal(ESTIMATOR_FIELDS[key], found.input ? found.input[key] : "");
  });
  estimatorLineItems = (found.lineItems || []).map(function(item){
    return {
      name: item.name || "",
      qty: item.qty || "",
      unit: item.unit || "",
      total: Number(item.total || 0),
      taxable: item.taxable !== false
    };
  });
  estimatorRenderCompanyCamLink();
  estimatorRecalculateLineItems();
  if (typeof toast === "function") toast("Estimate loaded.");
}

function estimatorRenderCompanyCamLink(){
  var host = document.getElementById("est-companycam-link");
  if (!host) return;
  var id = document.getElementById("est-companycam-id");
  var name = document.getElementById("est-companycam-name");
  var projectId = id ? String(id.value || "").trim() : "";
  var projectName = name ? String(name.value || "").trim() : "";
  if (!projectId){
    host.innerHTML = "No CompanyCam project linked.";
    return;
  }
  host.innerHTML = "Linked to CompanyCam project: <b>" + esc(projectName || projectId) + "</b> " +
    "<button class=\"btn danger\" type=\"button\" onclick=\"estimatorUnlinkCompanyCam()\">Unlink</button>";
}

function estimatorProjectButtonHtml(project, index){
  return "<button class=\"cc-proj\" type=\"button\" onclick=\"estimatorSelectCompanyCamProject(" + index + ")\">" +
    "<b>" + esc(project.name || "(unnamed project)") + "</b>" +
    (project.address ? "<div class=\"addr\">" + esc(project.address) + "</div>" : "") +
    "</button>";
}

async function estimatorSearchCompanyCam(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var results = document.getElementById("est-companycam-results");
  var search = document.getElementById("est-companycam-search");
  var q = search ? search.value : "";
  if (!results) return;
  if (typeof ccApi !== "function"){
    results.innerHTML = "<p class=\"hint\">CompanyCam API is not available.</p>";
    return;
  }
  results.innerHTML = "<p class=\"hint\">Searching CompanyCam...</p>";
  try{
    var out = await ccApi({ action: "projects", q: q || "" });
    estimatorCompanyCamProjects = out.projects || [];
    if (!estimatorCompanyCamProjects.length){
      results.innerHTML = "<p class=\"hint\">No CompanyCam projects found" + (q ? " for \"" + esc(q) + "\"" : "") + ".</p>";
      return;
    }
    results.innerHTML = estimatorCompanyCamProjects.map(estimatorProjectButtonHtml).join("");
  }catch(e){
    results.innerHTML = "<p class=\"hint\">Couldn't search CompanyCam: " + esc(e.message) + "</p>";
  }
}

function estimatorSelectCompanyCamProject(index){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var project = estimatorCompanyCamProjects[index];
  if (!project) return;
  estimatorSetVal("est-companycam-id", project.id || "");
  estimatorSetVal("est-companycam-name", project.name || "");
  var search = document.getElementById("est-companycam-search");
  if (search) search.value = project.name || "";
  var results = document.getElementById("est-companycam-results");
  if (results) results.innerHTML = "";
  estimatorRenderCompanyCamLink();
  if (typeof toast === "function") toast("CompanyCam project linked to estimate.");
}

function estimatorUnlinkCompanyCam(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorSetVal("est-companycam-id", "");
  estimatorSetVal("est-companycam-name", "");
  estimatorRenderCompanyCamLink();
}

function estimatorGeneratedLineItems(input){
  var areaSquares = input.areaSf / 100;
  var fieldRolls = Math.ceil((input.areaSf * (1 + input.membraneWasteRate)) / (input.membraneRollSq * 100));
  var membraneRolls = fieldRolls + input.extraSaRollsForWalls;
  var items = [];
  function add(name, qty, unit, total, taxable){
    items.push({
      name: name,
      qty: qty,
      unit: unit,
      total: Number(total || 0),
      taxable: taxable !== false
    });
  }
  add("60 mil EPDM SA membrane", membraneRolls + " rolls", estimatorMoney(input.membraneSqPrice) + "/SQ, 10 SQ/roll", membraneRolls * input.membraneRollSq * input.membraneSqPrice);
  add("Tapered insulation package", input.slopeType === "tapered" ? "quote" : "structural slope", input.slopeType === "tapered" ? "supplier quote" : "not carried", input.slopeType === "tapered" ? input.taperCost : 0);
  add(input.overlayIn + "\" ISO overlay", input.overlaySq + " SQ", estimatorMoney(input.overlayCostSq) + "/SQ", input.overlaySq * input.overlayCostSq);
  add("3\" QuickSeam splice tape", input.spliceTapeRolls + " rolls", estimatorMoney(input.spliceTapeRollPrice) + "/roll", input.spliceTapeRolls * input.spliceTapeRollPrice);
  add("6\" QuickSeam batten cover", input.battenCoverRolls + " rolls", estimatorMoney(input.battenCoverRollPrice) + "/roll", input.battenCoverRolls * input.battenCoverRollPrice);
  add("5\" QuickSeam flashing", input.quickSeamFlashingRolls + " rolls", estimatorMoney(input.quickSeamFlashingRollPrice) + "/roll", input.quickSeamFlashingRolls * input.quickSeamFlashingRollPrice);
  add("QuickPrime Plus", input.quickPrimePails + " pails", estimatorMoney(input.quickPrimePrice) + "/pail", input.quickPrimePails * input.quickPrimePrice);
  add("RPF/RUSS strip", input.rpfRolls + " rolls", estimatorMoney(input.rpfRollPrice) + "/100 LF roll", input.rpfRolls * input.rpfRollPrice);
  add("3\" insulation plates", input.insulationPlateCount + " plates", estimatorMoney(input.insulationPlatePricePerM) + "/M", (input.insulationPlateCount / 1000) * input.insulationPlatePricePerM);
  (input.screwRows || []).forEach(function(row){
    add(row.length + " insulation screws", row.pails + " pail" + (row.pails === 1 ? "" : "s") +
      " / " + row.ordered + " screws", estimatorMoney(row.pricePerM) + "/M, need " + row.needed,
      (row.ordered / 1000) * row.pricePerM);
  });
  add("2\" seam plates for RPF", "1000", "carton", input.seamPlateCost);
  add("T-joint covers", input.tJointCovers + " cartons", estimatorMoney(input.tJointCoverPrice) + "/carton", input.tJointCovers * input.tJointCoverPrice);
  add("Water Block", input.waterBlockTubes + " tubes", estimatorMoney(input.waterBlockPrice) + "/tube", input.waterBlockTubes * input.waterBlockPrice);
  add("Lap/all-purpose sealant", input.lapSealantTubes + " tubes", estimatorMoney(input.lapSealantPrice) + "/tube", input.lapSealantTubes * input.lapSealantPrice);
  add("Membrane cleaner", input.cleanerGallons + " gal", estimatorMoney(input.cleanerPricePerGal) + "/gal", input.cleanerGallons * input.cleanerPricePerGal);
  add("Pipe boots", input.pipeBoots, estimatorMoney(input.pipeBootPrice) + "/EA", input.pipeBoots * input.pipeBootPrice);
  add("Scupper flashing material", "allowance", "allowance", input.scupperFlashing);
  add("Miscellaneous detail materials", "allowance", "allowance", input.miscDetailMaterials);
  add("Wall / blocking rebuild allowance", "allowance", "installed allowance", input.blockingCost, false);
  add("New perimeter sheet metal", input.perimeterLf + " LF", estimatorMoney(input.metalLfCost) + "/LF", input.perimeterLf * input.metalLfCost, false);
  add("Retrofit drains", input.retrofitDrainCount + " drains", estimatorMoney(input.retrofitDrainCost) + "/EA", input.retrofitDrainCount * input.retrofitDrainCost, false);
  add("Disposal / dumpsters", "allowance", "allowance", input.disposalCost, false);
  add("Lift / rental equipment", "allowance", "rental allowance", input.equipmentCost, false);
  add("Travel - per diem and hotels", "allowance", estimatorMoney(input.perDiem) + "/man/day + hotels", (input.crewSize * input.perDiem * input.workingDays) +
    (input.hotelRooms * input.hotelNightCost * input.hotelNights), false);
  add(input.warrantyYears + "-year warranty fee", input.areaSf + " SF", estimatorMoney(input.warrantyRateSf) + "/SF", input.areaSf * input.warrantyRateSf, false);
  return { items: items, fieldRolls: fieldRolls, membraneRolls: membraneRolls, areaSquares: areaSquares };
}

function estimatorMaterialItems(input){
  var generated = estimatorGeneratedLineItems(input);
  return {
    items: generated.items.filter(function(item){ return item.taxable; }),
    fieldRolls: generated.fieldRolls,
    membraneRolls: generated.membraneRolls,
    areaSquares: generated.areaSquares
  };
}

function estimatorCalculate(input, lineItems){
  input = Object.assign({}, ESTIMATOR_DEFAULTS, input || {});
  var generated = estimatorGeneratedLineItems(input);
  var activeItems = (lineItems || generated.items).map(function(item){
    return {
      name: item.name || "",
      qty: item.qty || "",
      unit: item.unit || "",
      total: Number(item.total || 0),
      taxable: item.taxable !== false
    };
  });
  var taxableMaterials = activeItems.reduce(function(sum, item){ return sum + (item.taxable ? item.total : 0); }, 0);
  var otherCosts = activeItems.reduce(function(sum, item){ return sum + (!item.taxable ? item.total : 0); }, 0);
  var materialTax = taxableMaterials * input.materialTaxRate;
  var manHours = input.crewSize * input.hoursPerDay * input.workingDays;
  var edgeLabor = manHours * input.edgeLaborRate;
  var ourLabor = manHours * input.ourLaborRate;
  var travel = activeItems.filter(function(item){ return item.name === "Travel - per diem and hotels"; })
    .reduce(function(sum, item){ return sum + item.total; }, 0);
  var metal = activeItems.filter(function(item){ return item.name === "New perimeter sheet metal"; })
    .reduce(function(sum, item){ return sum + item.total; }, 0);
  var drains = activeItems.filter(function(item){ return item.name === "Retrofit drains"; })
    .reduce(function(sum, item){ return sum + item.total; }, 0);
  var warrantyFee = activeItems.filter(function(item){ return item.name.indexOf("warranty fee") !== -1; })
    .reduce(function(sum, item){ return sum + item.total; }, 0);
  var allowances = otherCosts;
  var edgeSubtotal = taxableMaterials + materialTax + edgeLabor + allowances;
  var edgeProfit = edgeSubtotal * input.edgeProfitRate;
  var edgeContract = edgeSubtotal + edgeProfit;
  var edgeBond = edgeContract * input.edgeBondRate;
  var edgeTotal = edgeContract + edgeBond;
  var ourDirect = taxableMaterials + materialTax + ourLabor + allowances;
  var ourMarkup = ourDirect * input.ourMarkupRate;
  var ourTotal = ourDirect + ourMarkup;
  var netWallRise = Math.max(0, input.maxTaperIn + input.overlayIn - input.tearoffIn);

  return {
    input: input,
    lineItems: activeItems,
    materialItems: activeItems.filter(function(item){ return item.taxable; }),
    otherItems: activeItems.filter(function(item){ return !item.taxable; }),
    fieldRolls: generated.fieldRolls,
    membraneRolls: generated.membraneRolls,
    areaSquares: generated.areaSquares,
    taxableMaterials: taxableMaterials,
    otherCosts: otherCosts,
    materialTax: materialTax,
    manHours: manHours,
    edgeLabor: edgeLabor,
    ourLabor: ourLabor,
    travel: travel,
    metal: metal,
    drains: drains,
    warrantyFee: warrantyFee,
    allowances: allowances,
    edgeSubtotal: edgeSubtotal,
    edgeProfit: edgeProfit,
    edgeBond: edgeBond,
    edgeTotal: edgeTotal,
    ourDirect: ourDirect,
    ourMarkup: ourMarkup,
    ourTotal: ourTotal,
    pricePerSquareEdge: edgeTotal / generated.areaSquares,
    pricePerSquareOur: ourTotal / generated.areaSquares,
    wallBuildRequiredIn: netWallRise,
    wallNote: "Max taper " + input.maxTaperIn + "\" + " + input.overlayIn + "\" overlay - " +
      input.tearoffIn + "\" tear-off = " + (Math.round(netWallRise * 10) / 10) +
      "\" net build-up. A 4\" coping stone is short; 5\" is nearly flush. The current 6\" wall/blocking allowance still belongs in the estimate."
  };
}

function estimatorRowHtml(label, amount, costSq){
  return "<tr><td>" + esc(label) + "</td><td class=\"num\">" + estimatorMoney(amount) + "</td><td class=\"num\">" +
    (costSq == null ? "" : estimatorMoney(costSq)) + "</td></tr>";
}

function estimatorLineItemRowsHtml(items){
  return items.map(function(item, i){
    return "<tr>" +
      "<td><input type=\"text\" value=\"" + esc(item.name) + "\" onchange=\"estimatorUpdateLineItem(" + i + ",'name',this.value)\"></td>" +
      "<td><input type=\"text\" value=\"" + esc(item.qty) + "\" onchange=\"estimatorUpdateLineItem(" + i + ",'qty',this.value)\"></td>" +
      "<td><input type=\"text\" value=\"" + esc(item.unit || "") + "\" onchange=\"estimatorUpdateLineItem(" + i + ",'unit',this.value)\"></td>" +
      "<td><select onchange=\"estimatorUpdateLineItem(" + i + ",'taxable',this.value)\">" +
        "<option value=\"true\"" + (item.taxable ? " selected" : "") + ">Material / taxed</option>" +
        "<option value=\"false\"" + (!item.taxable ? " selected" : "") + ">Cost / allowance</option>" +
      "</select></td>" +
      "<td><input type=\"text\" value=\"" + esc(estimatorMoney(item.total)) + "\" onchange=\"estimatorUpdateLineItem(" + i + ",'total',this.value)\"></td>" +
      "<td class=\"num\"><button class=\"btn danger estimator-row-x\" type=\"button\" onclick=\"estimatorDeleteLineItem(" + i + ")\" title=\"Remove line item\" aria-label=\"Remove line item\">X</button></td>" +
    "</tr>";
  }).join("");
}

function estimatorRender(result){
  var host = document.getElementById("estimator-results");
  if (!host) return;
  var sq = result.areaSquares;
  host.innerHTML =
    "<div class=\"estimator-results-grid\">" +
      "<div class=\"estimator-total\"><b>EDGE Method</b><strong>" + estimatorMoney(result.edgeTotal) + "</strong><span>" + estimatorMoney(result.pricePerSquareEdge) + " / SQ</span></div>" +
      "<div class=\"estimator-total\"><b>Our Way</b><strong>" + estimatorMoney(result.ourTotal) + "</strong><span>" + estimatorMoney(result.pricePerSquareOur) + " / SQ</span></div>" +
      "<div class=\"estimator-total\"><b>Difference</b><strong>" + estimatorMoney(result.ourTotal - result.edgeTotal) + "</strong><span>Our Way over EDGE</span></div>" +
    "</div>" +
    "<div class=\"estimator-note\">" + esc(result.wallNote) + "</div>" +
    "<div class=\"btnrow\" style=\"margin:0 0 8px\">" +
      "<button class=\"btn\" type=\"button\" onclick=\"estimatorAddLineItem(true)\">Add Material</button>" +
      "<button class=\"btn\" type=\"button\" onclick=\"estimatorAddLineItem(false)\">Add Equipment / Cost</button>" +
    "</div>" +
    "<table class=\"estimator-table estimator-edit-table\"><thead><tr><th>Item</th><th>Qty</th><th>Unit Price / Basis</th><th>Type</th><th>Amount</th><th></th></tr></thead><tbody>" +
      estimatorLineItemRowsHtml(result.lineItems) +
      "<tr><td><b>Material subtotal</b></td><td></td><td></td><td></td><td class=\"num\"><b>" + estimatorMoney(result.taxableMaterials) + "</b></td><td></td></tr>" +
      "<tr><td>Material tax</td><td></td><td>" + esc(String(Math.round(result.input.materialTaxRate * 10000) / 100)) + "%</td><td></td><td class=\"num\">" + estimatorMoney(result.materialTax) + "</td><td></td></tr>" +
      "<tr><td>Other costs / allowances</td><td></td><td></td><td></td><td class=\"num\">" + estimatorMoney(result.otherCosts) + "</td><td></td></tr>" +
    "</tbody></table>" +
    "<table class=\"estimator-table\"><thead><tr><th>Direct / Allowance</th><th class=\"num\">Amount</th><th class=\"num\">Cost / SQ</th></tr></thead><tbody>" +
      estimatorRowHtml("EDGE labor - " + result.manHours + " MH @ " + estimatorMoney(result.input.edgeLaborRate) + "/hr", result.edgeLabor, result.edgeLabor / sq) +
      estimatorRowHtml("Our labor - " + result.manHours + " MH @ " + estimatorMoney(result.input.ourLaborRate) + "/hr", result.ourLabor, result.ourLabor / sq) +
      estimatorRowHtml("Other editable costs / allowances", result.otherCosts, result.otherCosts / sq) +
    "</tbody></table>" +
    "<table class=\"estimator-table\"><thead><tr><th>Pricing Method</th><th class=\"num\">Subtotal</th><th class=\"num\">Add-on</th><th class=\"num\">Total</th></tr></thead><tbody>" +
      "<tr><td>EDGE: material tax + " + esc(String(Math.round(result.input.edgeProfitRate * 10000) / 100)) + "% profit + " +
        esc(String(Math.round(result.input.edgeBondRate * 10000) / 100)) + "% bond</td><td class=\"num\">" +
        estimatorMoney(result.edgeSubtotal) + "</td><td class=\"num\">" + estimatorMoney(result.edgeProfit + result.edgeBond) +
        "</td><td class=\"num\"><b>" + estimatorMoney(result.edgeTotal) + "</b></td></tr>" +
      "<tr><td>Our Way: " + esc(String(Math.round(result.input.ourMarkupRate * 10000) / 100)) + "% markup on everything</td><td class=\"num\">" +
        estimatorMoney(result.ourDirect) + "</td><td class=\"num\">" + estimatorMoney(result.ourMarkup) +
        "</td><td class=\"num\"><b>" + estimatorMoney(result.ourTotal) + "</b></td></tr>" +
    "</tbody></table>";
}

function estimatorProposalText(result){
  var input = result.input;
  var price = result.edgeTotal;
  var lines = [];
  lines.push("WATKINS ROOFING PROPOSAL");
  lines.push("");
  lines.push("Project: " + (input.projectName || ""));
  if (input.location) lines.push("Location: " + input.location);
  if (input.contact) lines.push("Attention: " + input.contact);
  lines.push("");
  lines.push("Scope of Work");
  lines.push("Furnish labor, materials, equipment, supervision, and insurance necessary to install a " +
    input.warrantyYears + "-year " + (input.membrane === "epdm-sa" ? "60 mil Elevate RubberGard EPDM SA" : input.membrane.toUpperCase()) +
    " roofing system.");
  lines.push("");
  lines.push("Includes:");
  lines.push("- Tear-off and disposal as carried in the estimate.");
  if (input.slopeType === "tapered") lines.push("- Tapered insulation package and continuous " + input.overlayIn + "\" ISO overlay.");
  else lines.push("- Continuous " + input.overlayIn + "\" ISO overlay over structurally sloped roof.");
  lines.push("- Required insulation fasteners, plates, seam accessories, flashing materials, and sealants.");
  lines.push("- Retrofit roof drains, perimeter blocking/wall build-up, and new perimeter sheet metal as carried.");
  lines.push("- " + input.warrantyYears + "-year manufacturer warranty allowance.");
  lines.push("");
  lines.push("Clarifications:");
  lines.push("- Proposal is based on the current estimate model and editable material list.");
  lines.push("- Hidden or unforeseen deck, wall, or substrate conditions are excluded unless specifically listed.");
  lines.push("- Final material quantities may be adjusted before ordering based on approved shop drawings and field verification.");
  lines.push("");
  lines.push("Proposal Amount:");
  lines.push(estimatorMoney(price));
  return lines.join("\n");
}

function estimatorCreateProposal(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var result = estimatorRecalculateLineItems() || estimatorCalculateFromForm({ quiet: true });
  var text = estimatorProposalText(result);
  var card = document.getElementById("estimator-proposal-card");
  var pre = document.getElementById("estimator-proposal-text");
  if (pre) pre.textContent = text;
  if (card) card.style.display = "";
  if (typeof toast === "function") toast("Proposal draft created.");
  return text;
}

function estimatorCopyProposal(){
  var pre = document.getElementById("estimator-proposal-text");
  if (!pre || !pre.textContent){
    if (typeof toast === "function") toast("Create a proposal first.");
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(pre.textContent).then(function(){
      if (typeof toast === "function") toast("Proposal copied.");
    }).catch(function(){
      if (typeof toast === "function") toast("Copy failed. Select the text and copy manually.");
    });
  }else if (typeof toast === "function"){
    toast("Select the proposal text and copy it.");
  }
}

function estimatorDownloadProposalText(){
  var pre = document.getElementById("estimator-proposal-text");
  if (!pre || !pre.textContent){
    if (typeof toast === "function") toast("Create a proposal first.");
    return;
  }
  var input = estimatorReadForm();
  var blob = new Blob([pre.textContent], { type: "text/plain;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = estimatorSlug(input.projectName) + "-proposal.txt";
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function estimatorRecalculateLineItems(){
  if (!estimatorLineItems) return estimatorCalculateFromForm({ quiet: true });
  estimatorLastInput = estimatorReadForm();
  var result = estimatorCalculate(estimatorLastInput, estimatorLineItems);
  estimatorRender(result);
  return result;
}

function estimatorUpdateLineItem(index, field, value){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (!estimatorLineItems || !estimatorLineItems[index]) return;
  if (field === "total"){
    estimatorLineItems[index].total = estimatorParseNumber(value);
  }else if (field === "taxable"){
    estimatorLineItems[index].taxable = String(value) === "true";
  }else{
    estimatorLineItems[index][field] = value;
  }
  return estimatorRecalculateLineItems();
}

function estimatorDeleteLineItem(index){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (!estimatorLineItems || !estimatorLineItems[index]) return;
  estimatorLineItems.splice(index, 1);
  return estimatorRecalculateLineItems();
}

function estimatorAddLineItem(taxable){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (!estimatorLineItems){
    var seed = estimatorCalculate(estimatorReadForm());
    estimatorLineItems = seed.lineItems.slice();
  }
  estimatorLineItems.push({
    name: taxable ? "New material item" : "New equipment / cost item",
    qty: "allowance",
    unit: "",
    total: 0,
    taxable: taxable !== false
  });
  return estimatorRecalculateLineItems();
}

function estimatorCalculateFromForm(opts){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorLastInput = estimatorReadForm();
  estimatorLineItems = estimatorGeneratedLineItems(estimatorLastInput).items;
  var result = estimatorCalculate(estimatorLastInput, estimatorLineItems);
  estimatorRender(result);
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Estimate calculated.");
  }
  return result;
}
