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
  screwPackageCost: 3123.63,
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
  estimatorCalculateFromForm({ quiet: true });
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Warrensburg estimate model loaded.");
  }
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

function estimatorMaterialItems(input){
  var areaSquares = input.areaSf / 100;
  var fieldRolls = Math.ceil((input.areaSf * (1 + input.membraneWasteRate)) / (input.membraneRollSq * 100));
  var membraneRolls = fieldRolls + input.extraSaRollsForWalls;
  var items = [];
  function add(name, qty, unit, total){
    items.push({ name: name, qty: qty, unit: unit, total: Number(total || 0) });
  }
  add("60 mil EPDM SA membrane", membraneRolls + " rolls", "10 SQ", membraneRolls * input.membraneRollSq * input.membraneSqPrice);
  add("Tapered insulation package", input.slopeType === "tapered" ? "quote" : "structural slope", "", input.slopeType === "tapered" ? input.taperCost : 0);
  add(input.overlayIn + "\" ISO overlay", input.overlaySq + " SQ", estimatorMoney(input.overlayCostSq) + "/SQ", input.overlaySq * input.overlayCostSq);
  add("3\" QuickSeam splice tape", input.spliceTapeRolls + " rolls", "", input.spliceTapeRolls * input.spliceTapeRollPrice);
  add("6\" QuickSeam batten cover", input.battenCoverRolls + " rolls", "", input.battenCoverRolls * input.battenCoverRollPrice);
  add("5\" QuickSeam flashing", input.quickSeamFlashingRolls + " rolls", "", input.quickSeamFlashingRolls * input.quickSeamFlashingRollPrice);
  add("QuickPrime Plus", input.quickPrimePails + " pails", "", input.quickPrimePails * input.quickPrimePrice);
  add("RPF/RUSS strip", input.rpfRolls + " rolls", "100 LF", input.rpfRolls * input.rpfRollPrice);
  add("3\" insulation plates", input.insulationPlateCount + " plates", "", (input.insulationPlateCount / 1000) * input.insulationPlatePricePerM);
  add("Insulation screws 6-10 inch", "packaged", "", input.screwPackageCost);
  add("2\" seam plates for RPF", "1000", "", input.seamPlateCost);
  add("T-joint covers", input.tJointCovers + " cartons", "", input.tJointCovers * input.tJointCoverPrice);
  add("Water Block", input.waterBlockTubes + " tubes", "", input.waterBlockTubes * input.waterBlockPrice);
  add("Lap/all-purpose sealant", input.lapSealantTubes + " tubes", "", input.lapSealantTubes * input.lapSealantPrice);
  add("Membrane cleaner", input.cleanerGallons + " gal", "", input.cleanerGallons * input.cleanerPricePerGal);
  add("Pipe boots", input.pipeBoots, "", input.pipeBoots * input.pipeBootPrice);
  add("Scupper flashing material", "allowance", "", input.scupperFlashing);
  add("Miscellaneous detail materials", "allowance", "", input.miscDetailMaterials);
  return { items: items, fieldRolls: fieldRolls, membraneRolls: membraneRolls, areaSquares: areaSquares };
}

function estimatorCalculate(input){
  input = Object.assign({}, ESTIMATOR_DEFAULTS, input || {});
  var material = estimatorMaterialItems(input);
  var taxableMaterials = material.items.reduce(function(sum, item){ return sum + item.total; }, 0);
  var materialTax = taxableMaterials * input.materialTaxRate;
  var manHours = input.crewSize * input.hoursPerDay * input.workingDays;
  var edgeLabor = manHours * input.edgeLaborRate;
  var ourLabor = manHours * input.ourLaborRate;
  var travel = (input.crewSize * input.perDiem * input.workingDays) +
    (input.hotelRooms * input.hotelNightCost * input.hotelNights);
  var metal = input.perimeterLf * input.metalLfCost;
  var drains = input.retrofitDrainCount * input.retrofitDrainCost;
  var warrantyFee = input.areaSf * input.warrantyRateSf;
  var allowances = input.blockingCost + metal + drains + input.disposalCost + input.equipmentCost + travel + warrantyFee;
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
    materialItems: material.items,
    fieldRolls: material.fieldRolls,
    membraneRolls: material.membraneRolls,
    areaSquares: material.areaSquares,
    taxableMaterials: taxableMaterials,
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
    pricePerSquareEdge: edgeTotal / material.areaSquares,
    pricePerSquareOur: ourTotal / material.areaSquares,
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

function estimatorRender(result){
  var host = document.getElementById("estimator-results");
  if (!host) return;
  var sq = result.areaSquares;
  var materialRows = result.materialItems.map(function(item){
    return "<tr><td>" + esc(item.name) + "</td><td>" + esc(item.qty) + "</td><td>" +
      esc(item.unit || "") + "</td><td class=\"num\">" + estimatorMoney(item.total) + "</td></tr>";
  }).join("");
  host.innerHTML =
    "<div class=\"estimator-results-grid\">" +
      "<div class=\"estimator-total\"><b>EDGE Method</b><strong>" + estimatorMoney(result.edgeTotal) + "</strong><span>" + estimatorMoney(result.pricePerSquareEdge) + " / SQ</span></div>" +
      "<div class=\"estimator-total\"><b>Our Way</b><strong>" + estimatorMoney(result.ourTotal) + "</strong><span>" + estimatorMoney(result.pricePerSquareOur) + " / SQ</span></div>" +
      "<div class=\"estimator-total\"><b>Difference</b><strong>" + estimatorMoney(result.ourTotal - result.edgeTotal) + "</strong><span>Our Way over EDGE</span></div>" +
    "</div>" +
    "<div class=\"estimator-note\">" + esc(result.wallNote) + "</div>" +
    "<table class=\"estimator-table\"><thead><tr><th>Material</th><th>Qty</th><th>Basis</th><th class=\"num\">Amount</th></tr></thead><tbody>" +
      materialRows +
      "<tr><td><b>Material subtotal</b></td><td></td><td></td><td class=\"num\"><b>" + estimatorMoney(result.taxableMaterials) + "</b></td></tr>" +
      "<tr><td>Material tax</td><td></td><td>" + esc(String(Math.round(result.input.materialTaxRate * 10000) / 100)) + "%</td><td class=\"num\">" + estimatorMoney(result.materialTax) + "</td></tr>" +
    "</tbody></table>" +
    "<table class=\"estimator-table\"><thead><tr><th>Direct / Allowance</th><th class=\"num\">Amount</th><th class=\"num\">Cost / SQ</th></tr></thead><tbody>" +
      estimatorRowHtml("EDGE labor - " + result.manHours + " MH @ " + estimatorMoney(result.input.edgeLaborRate) + "/hr", result.edgeLabor, result.edgeLabor / sq) +
      estimatorRowHtml("Our labor - " + result.manHours + " MH @ " + estimatorMoney(result.input.ourLaborRate) + "/hr", result.ourLabor, result.ourLabor / sq) +
      estimatorRowHtml("Wall / blocking rebuild allowance", result.input.blockingCost, result.input.blockingCost / sq) +
      estimatorRowHtml("New perimeter sheet metal", result.metal, result.metal / sq) +
      estimatorRowHtml("Retrofit drains", result.drains, result.drains / sq) +
      estimatorRowHtml("Disposal / dumpsters", result.input.disposalCost, result.input.disposalCost / sq) +
      estimatorRowHtml("Lift / rental equipment", result.input.equipmentCost, result.input.equipmentCost / sq) +
      estimatorRowHtml("Travel - per diem and hotels", result.travel, result.travel / sq) +
      estimatorRowHtml(result.input.warrantyYears + "-year warranty fee @ " + estimatorMoney(result.input.warrantyRateSf) + "/SF", result.warrantyFee, result.warrantyFee / sq) +
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

function estimatorCalculateFromForm(opts){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var result = estimatorCalculate(estimatorReadForm());
  estimatorRender(result);
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Estimate calculated.");
  }
  return result;
}
