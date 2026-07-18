"use strict";
/* Owner-only estimating workspace.
   This is intentionally estimate-first: it starts from drawings, photos,
   field notes, cores, wall heights, and system choices. A work order can be
   created later if the job sells, but this model does not depend on one. */

var ESTIMATOR_DEFAULTS = {
  projectName: "Warrensburg Post Office",
  location: "Warrensburg, MO",
  contact: "Dan Staat",
  roofMapId: "",
  roofMapName: "",
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
  curbPerimeterLf: 0,
  stoneCopingIn: 5,
  maxTaperIn: 4.5,
  tearoffIn: 2,
  blockingCost: 10120,
  metalLfCost: 20,
  equipmentCost: 10000,
  disposalCost: 6000,
  retrofitDrainCount: 8,
  retrofitDrainCost: 1000,
  scupperCount: 1,
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
  seamPlateCount: 1000,
  rpfFastenerPricePerM: 644,
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

var ESTIMATOR_STARTER_DEFAULTS = Object.assign({}, ESTIMATOR_DEFAULTS, {
  projectName: "",
  location: "",
  contact: "",
  roofMapId: "",
  roofMapName: "",
  companyCamProjectId: "",
  companyCamProjectName: "",
  fieldNotes: "",
  areaSf: 0,
  taperCost: 0,
  overlaySq: 0,
  perimeterLf: 0,
  curbPerimeterLf: 0,
  blockingCost: 0,
  equipmentCost: 0,
  disposalCost: 0,
  retrofitDrainCount: 0,
  scupperCount: 0,
  hotelNights: 0,
  extraSaRollsForWalls: 0,
  spliceTapeRolls: 0,
  battenCoverRolls: 0,
  quickSeamFlashingRolls: 0,
  quickPrimePails: 0,
  rpfRolls: 0,
  insulationPlateCount: 0,
  seamPlateCount: 0,
  screwRows: [],
  tJointCovers: 0,
  waterBlockTubes: 0,
  lapSealantTubes: 0,
  cleanerGallons: 0,
  pipeBoots: 0,
  scupperFlashing: 0,
  miscDetailMaterials: 0
});

var ESTIMATOR_FIELDS = {
  projectName: "est-project-name",
  location: "est-location",
  contact: "est-contact",
  roofMapId: "est-roofmap-id",
  roofMapName: "est-roofmap-name",
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
  curbPerimeterLf: "est-curb-perimeter-lf",
  stoneCopingIn: "est-stone-coping-in",
  maxTaperIn: "est-max-taper-in",
  tearoffIn: "est-tearoff-in",
  blockingCost: "est-blocking-cost",
  metalLfCost: "est-metal-lf-cost",
  equipmentCost: "est-equipment-cost",
  disposalCost: "est-disposal-cost",
  retrofitDrainCount: "est-retrofit-drain-count",
  pipeBoots: "est-pipe-boots",
  scupperCount: "est-scupper-count",
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
var estimatorRoofMapperMaps = [];
var estimatorLineItems = null;
var estimatorLastInput = null;
var estimatorActiveSavedEstimate = null;
var estimatorInputSeed = ESTIMATOR_STARTER_DEFAULTS;
var ESTIMATOR_STORE_KEY = "roofops_estimates_v1";
var ESTIMATOR_ROOFMAPPER_LOCAL_KEY = "roofmapper-local-outlines-v1";

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
  if (nameEl && !nameEl.value) estimatorLoadStarter({ quiet: true });
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

function estimatorSetFormFromModel(model){
  Object.keys(ESTIMATOR_FIELDS).forEach(function(key){
    estimatorSetVal(ESTIMATOR_FIELDS[key], model[key]);
  });
}

function estimatorReadForm(){
  var out = Object.assign({}, estimatorInputSeed || ESTIMATOR_STARTER_DEFAULTS);
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

function estimatorLoadStarter(opts){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorInputSeed = ESTIMATOR_STARTER_DEFAULTS;
  estimatorSetFormFromModel(ESTIMATOR_STARTER_DEFAULTS);
  estimatorRenderCompanyCamLink();
  estimatorRenderRoofMapLink();
  estimatorLineItems = null;
  estimatorActiveSavedEstimate = null;
  var results = document.getElementById("estimator-results");
  if (results) results.innerHTML = "<p class=\"hint\">Load a RoofMapper map or enter values, then calculate.</p>";
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Blank estimate started.");
  }
}

function estimatorLoadWarrensburg(opts){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorInputSeed = ESTIMATOR_DEFAULTS;
  estimatorSetFormFromModel(ESTIMATOR_DEFAULTS);
  estimatorRenderCompanyCamLink();
  estimatorRenderRoofMapLink();
  estimatorLineItems = null;
  estimatorActiveSavedEstimate = null;
  estimatorCalculateFromForm({ quiet: true });
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Warrensburg estimate model loaded.");
  }
}

function estimatorPricingChoice(result, method){
  var key = method === "our" ? "our" : "edge";
  return {
    method: key,
    label: key === "our" ? "Our Way" : "EDGE",
    proposalAmount: key === "our" ? result.ourTotal : result.edgeTotal,
    pricePerSquare: key === "our" ? result.pricePerSquareOur : result.pricePerSquareEdge
  };
}

function estimatorTotalsForJobFile(result){
  return {
    taxableMaterials: result.taxableMaterials,
    materialTax: result.materialTax,
    otherCosts: result.otherCosts,
    manHours: result.manHours,
    edgeLabor: result.edgeLabor,
    ourLabor: result.ourLabor,
    edgeSubtotal: result.edgeSubtotal,
    edgeProfit: result.edgeProfit,
    edgeBond: result.edgeBond,
    edgeTotal: result.edgeTotal,
    ourDirect: result.ourDirect,
    ourMarkup: result.ourMarkup,
    ourTotal: result.ourTotal,
    edgePerSquare: result.pricePerSquareEdge,
    ourPerSquare: result.pricePerSquareOur
  };
}

function estimatorCurrentSnapshot(method){
  var input = estimatorReadForm();
  var result = estimatorCalculate(input, estimatorLineItems || undefined);
  var choice = estimatorPricingChoice(result, method);
  var materialList = result.lineItems.map(function(item){
    return {
      name: item.name || "",
      qty: item.qty || "",
      unit: item.unit || "",
      total: Number(item.total || 0),
      taxable: item.taxable !== false
    };
  });
  var totals = estimatorTotalsForJobFile(result);
  return {
    id: "est_" + Date.now(),
    savedAt: Date.now(),
    recordType: "estimate_job_file",
    projectName: input.projectName || "(untitled estimate)",
    location: input.location || "",
    contact: input.contact || "",
    pricingMethod: choice.method,
    pricingLabel: choice.label,
    proposalAmount: choice.proposalAmount,
    proposalPricePerSquare: choice.pricePerSquare,
    input: input,
    lineItems: materialList,
    totals: totals,
    jobFile: {
      projectName: input.projectName || "(untitled estimate)",
      location: input.location || "",
      contact: input.contact || "",
      roofMapId: input.roofMapId || "",
      roofMapName: input.roofMapName || "",
      companyCamProjectId: input.companyCamProjectId || "",
      companyCamProjectName: input.companyCamProjectName || "",
      fieldNotes: input.fieldNotes || "",
      membrane: input.membrane || "",
      warrantyYears: input.warrantyYears,
      roofAreaSf: input.areaSf,
      slopeType: input.slopeType,
      pricingMethod: choice.method,
      pricingLabel: choice.label,
      proposalAmount: choice.proposalAmount,
      proposalPricePerSquare: choice.pricePerSquare,
      inputs: input,
      materialList: materialList,
      totals: totals
    }
  };
}

function estimatorSaveCurrent(method){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var snap = estimatorCurrentSnapshot(method);
  var db = estimatorSavedDb();
  db.estimates = db.estimates.filter(function(e){ return e.id !== snap.id; });
  db.estimates.unshift(snap);
  db.estimates = db.estimates.slice(0, 50);
  try{
    estimatorWriteSavedDb(db);
    estimatorActiveSavedEstimate = snap;
    if (typeof toast === "function") toast(snap.pricingLabel + " estimate job file saved.");
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
    host.innerHTML = "<p class=\"hint\">No saved estimate job files on this device yet.</p>";
    return;
  }
  host.innerHTML = db.estimates.map(function(e){
    var chosen = e.pricingLabel || (e.pricingMethod === "our" ? "Our Way" : "EDGE");
    var amount = e.proposalAmount || (e.pricingMethod === "our" ? e.totals && e.totals.ourTotal : e.totals && e.totals.edgeTotal);
    return "<div class=\"saved-item\"><div class=\"info\"><div class=\"name\">" + esc(e.projectName || "(untitled estimate)") +
      "</div><div class=\"meta\">" + esc(e.location || "") + " - saved as " + esc(chosen) + " " + estimatorMoney(amount) +
      " - EDGE " + estimatorMoney(e.totals && e.totals.edgeTotal) +
      " - Our Way " + estimatorMoney(e.totals && e.totals.ourTotal) + "</div></div>" +
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
  estimatorInputSeed = Object.assign({}, ESTIMATOR_STARTER_DEFAULTS, found.input || {});
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
  estimatorActiveSavedEstimate = found;
  estimatorRenderCompanyCamLink();
  estimatorRecalculateLineItems();
  if (typeof toast === "function") toast((found.pricingLabel || "Saved") + " estimate job file loaded.");
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

function estimatorRenderRoofMapLink(){
  var host = document.getElementById("est-roofmap-link");
  if (!host) return;
  var idEl = document.getElementById("est-roofmap-id");
  var nameEl = document.getElementById("est-roofmap-name");
  var id = idEl ? String(idEl.value || "").trim() : "";
  var name = nameEl ? String(nameEl.value || "").trim() : "";
  host.innerHTML = id ? ("Loaded RoofMapper map: <b>" + esc(name || id) + "</b>") : "No RoofMapper map loaded.";
}

function estimatorRoofMapperTitle(outline){
  if (typeof rmOutlineTitle === "function") return rmOutlineTitle(outline);
  var tags = outline && outline.tags ? outline.tags : {};
  var addr = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return tags.name || addr || "RoofMapper Map";
}

function estimatorLoadRoofMapperLocalOutlines(){
  if (typeof rmLoadLocalOutlines === "function") return rmLoadLocalOutlines();
  try{ return JSON.parse(localStorage.getItem(ESTIMATOR_ROOFMAPPER_LOCAL_KEY) || "[]"); }catch(e){ return []; }
}

function estimatorCollectRoofMapperMaps(){
  var maps = [];
  if (typeof rmState !== "undefined" && rmState && rmState.outline && rmState.outline.areaSqFt){
    maps.push({ source: "current", outline: rmState.outline });
  }
  estimatorLoadRoofMapperLocalOutlines().forEach(function(outline){
    if (outline && outline.areaSqFt) maps.push({ source: "saved", outline: outline });
  });
  return maps;
}

function estimatorOpenRoofMapperMaps(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorRoofMapperMaps = estimatorCollectRoofMapperMaps();
  var card = document.getElementById("estimator-roofmapper-card");
  var host = document.getElementById("estimator-roofmapper-list");
  if (card) card.style.display = "";
  if (!host) return;
  if (!estimatorRoofMapperMaps.length){
    host.innerHTML = "<p class=\"hint\">No RoofMapper maps found on this device yet. Open RoofMapper, trace or load a roof outline, then save it on this device.</p>";
    return;
  }
  host.innerHTML = estimatorRoofMapperMaps.map(function(entry, i){
    var outline = entry.outline || {};
    var title = estimatorRoofMapperTitle(outline);
    var area = Math.round(Number(outline.areaSqFt || 0)).toLocaleString();
    var perimeter = Math.round(Number(outline.perimeterFt || 0)).toLocaleString();
    var source = entry.source === "current" ? "currently open" : "saved on this device";
    return "<div class=\"saved-item\"><div class=\"info\"><div class=\"name\">" + esc(title) +
      "</div><div class=\"meta\">" + esc(source) + " - " + area + " SF - " + perimeter + " LF perimeter</div></div>" +
      "<button class=\"btn\" type=\"button\" onclick=\"estimatorApplyRoofMapperMap(" + i + ")\">Use Map</button></div>";
  }).join("");
}

function estimatorApplyRoofMapperMap(index){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var entry = estimatorRoofMapperMaps[index];
  var outline = entry && entry.outline;
  if (!outline){
    if (typeof toast === "function") toast("RoofMapper map not found.");
    return;
  }
  var title = estimatorRoofMapperTitle(outline);
  var area = Math.round(Number(outline.areaSqFt || 0));
  var perimeter = Math.round(Number(outline.perimeterFt || 0));
  if (!area){
    if (typeof toast === "function") toast("That RoofMapper map does not have a measured area.");
    return;
  }
  if (!String(document.getElementById("est-project-name").value || "").trim()) estimatorSetVal("est-project-name", title);
  estimatorSetVal("est-roofmap-id", outline.id || ("roofmap_" + Date.now()));
  estimatorSetVal("est-roofmap-name", title);
  estimatorSetVal("est-area-sf", area);
  estimatorSetVal("est-overlay-sq", Math.ceil(area / 100));
  if (perimeter) estimatorSetVal("est-perimeter-lf", perimeter);
  var notesEl = document.getElementById("est-field-notes");
  var note = "RoofMapper map loaded: " + title + " - " + area.toLocaleString() + " SF" +
    (perimeter ? ", " + perimeter.toLocaleString() + " LF perimeter" : "") + ".";
  if (notesEl && String(notesEl.value || "").indexOf("RoofMapper map loaded:") === -1){
    notesEl.value = (String(notesEl.value || "").trim() ? String(notesEl.value || "").trim() + "\n" : "") + note;
  }
  estimatorRenderRoofMapLink();
  var card = document.getElementById("estimator-roofmapper-card");
  if (card) card.style.display = "none";
  estimatorLineItems = null;
  estimatorActiveSavedEstimate = null;
  estimatorCalculateFromForm({ quiet: true });
  if (typeof toast === "function") toast("RoofMapper map loaded into estimate.");
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
  estimatorActiveSavedEstimate = null;
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
  estimatorActiveSavedEstimate = null;
  estimatorRenderCompanyCamLink();
}

function estimatorAiStatus(html){
  var host = document.getElementById("estimator-ai-status");
  if (host) host.innerHTML = html || "";
}

function estimatorAiList(label, items){
  items = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!items.length) return "";
  return "<b>" + esc(label) + ":</b> " + items.map(esc).join("; ") + ". ";
}

function estimatorApplyAiFields(fields){
  fields = fields && typeof fields === "object" ? fields : {};
  Object.keys(fields).forEach(function(key){
    if (ESTIMATOR_FIELDS[key]) estimatorSetVal(ESTIMATOR_FIELDS[key], fields[key]);
  });
  estimatorInputSeed = Object.assign({}, estimatorInputSeed || ESTIMATOR_STARTER_DEFAULTS, estimatorReadForm());
  estimatorActiveSavedEstimate = null;
}

async function estimatorAskAi(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (typeof authHeaders !== "function"){
    estimatorAiStatus("AI estimate review is not available in this session.");
    return;
  }
  estimatorAiStatus("Reviewing intake against the Warrensburg EPDM SA playbook...");
  try{
    var r = await fetch("/.netlify/functions/ai-service", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ action: "estimate_epdm_sa", estimate: estimatorReadForm() })
    });
    var out = null; try{ out = await r.json(); }catch(e){}
    if (!r.ok || !out || !out.ok) throw new Error((out && out.error) || ("server error " + r.status));
    var result = out.result || {};
    estimatorApplyAiFields(result.fields || {});
    var calc = estimatorApplyEpdmSaRules();
    var status = (out.llm ? ("AI reviewed with " + esc(out.model || out.provider) + ". ") : "AI key not used; applied the local Warrensburg playbook. ") +
      estimatorAiList("Applied", result.rulesApplied) +
      estimatorAiList("Missing", result.missingInputs) +
      estimatorAiList("Watch", result.warnings);
    estimatorAiStatus(status);
    if (typeof toast === "function") toast("Estimate seeded from Warrensburg playbook.");
    return { ai: out, estimate: calc };
  }catch(e){
    estimatorAiStatus("AI estimate review failed: " + esc(e.message));
    if (typeof toast === "function") toast("AI estimate review failed.");
  }
}

function estimatorRoundUpTo(n, step){
  step = step || 1;
  return Math.ceil(Number(n || 0) / step) * step;
}

function estimatorScrewRowsForAssembly(input){
  var area = Number(input.areaSf || 0);
  if (!area) return [];
  var boards = Math.ceil(area / 32);
  var installed = boards * 8;
  var overlay = Number(input.overlayIn || 0);
  var taper = input.slopeType === "tapered" ? Number(input.maxTaperIn || 0) : 0;
  var minLength = Math.max(6, Math.ceil(overlay + 2));
  var maxLength = Math.max(minLength, Math.ceil(overlay + taper + 2));
  maxLength = Math.min(10, maxLength);
  var priceByLength = { 6: 644.00, 7: 837.25, 8: 934.00, 9: 1133.50, 10: 1217.25 };
  var lengths = [];
  for (var l = minLength; l <= maxLength; l++) lengths.push(l);
  if (!lengths.length) lengths = [6];
  var weights = lengths.length === 1 ? [1] : [0.30, 0.25, 0.20, 0.15, 0.10].slice(0, lengths.length);
  var weightTotal = weights.reduce(function(sum, w){ return sum + w; }, 0) || 1;
  var used = 0;
  return lengths.map(function(length, i){
    var needed = i === lengths.length - 1 ? installed - used : Math.round(installed * (weights[i] / weightTotal));
    used += needed;
    var pails = Math.max(1, Math.ceil(needed / 500));
    return {
      length: length + "\"",
      needed: needed,
      pails: pails,
      ordered: pails * 500,
      pricePerM: priceByLength[length] || priceByLength[10]
    };
  });
}

function estimatorApplyEpdmSaRules(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  var input = estimatorReadForm();
  var area = Number(input.areaSf || 0);
  if (!area){
    if (typeof toast === "function") toast("Load a RoofMapper map or enter roof area first.");
    return;
  }
  var perimeter = Number(input.perimeterLf || 0);
  var curbPerimeter = Number(input.curbPerimeterLf || 0);
  var drainCount = Number(input.retrofitDrainCount || 0);
  var pipeCount = Number(input.pipeBoots || 0);
  var scupperCount = Number(input.scupperCount || 0);
  var fieldRolls = Math.ceil((area * (1 + input.membraneWasteRate)) / (input.membraneRollSq * 100));
  var wallRolls = perimeter ? Math.ceil((perimeter * 3) / 1000) : 0;
  var membraneRolls = fieldRolls + wallRolls;
  var longFieldSeamsLf = Math.max(0, fieldRolls - 1) * 100;
  var wallAndCurbSpliceLf = perimeter + curbPerimeter;
  var detailSpliceLf = (drainCount * 12) + (pipeCount * 8) + (scupperCount * 12);
  var spliceTapeRolls = Math.max(Math.ceil(fieldRolls * 1.5), Math.ceil((longFieldSeamsLf + wallAndCurbSpliceLf + detailSpliceLf) / 100));
  var endLapLf = Math.max(0, fieldRolls - 1) * 10;
  var exposedAdhesiveLf = (fieldRolls * 12) + (curbPerimeter * 0.5) + (scupperCount * 10);
  var battenCoverRolls = Math.max(1, Math.ceil(fieldRolls * 0.5), Math.ceil((endLapLf + exposedAdhesiveLf) / 100));
  var quickSeamFlashingRolls = Math.max(2, Math.ceil((curbPerimeter + (pipeCount * 6) + (scupperCount * 10) + (drainCount * 8)) / 100));
  var quickPrimePails = Math.max(1, Math.ceil(area / 1250));
  var rpfLf = (perimeter + curbPerimeter) * 1.1;
  var rpfRolls = rpfLf ? Math.ceil(rpfLf / 100) : 0;
  var plateCount = estimatorRoundUpTo(Math.ceil(area / 32) * 8 * 1.05, 500);
  var seamPlateCount = rpfLf ? estimatorRoundUpTo(Math.ceil(rpfLf), 1000) : 0;
  var netRise = Math.max(0, Number(input.maxTaperIn || 0) + Number(input.overlayIn || 0) - Number(input.tearoffIn || 0));
  var layerCount = netRise ? Math.max(1, Math.ceil(netRise / 1.5)) : 0;
  var blockingCost = input.blockingCost || (perimeter && layerCount ? perimeter * 1.1 * layerCount * 4 : 0);
  var next = Object.assign({}, estimatorInputSeed || ESTIMATOR_STARTER_DEFAULTS, input, {
    membrane: "epdm-sa",
    overlaySq: input.overlayIn ? Math.ceil(area / 100) : 0,
    extraSaRollsForWalls: wallRolls,
    spliceTapeRolls: spliceTapeRolls,
    battenCoverRolls: battenCoverRolls,
    quickSeamFlashingRolls: quickSeamFlashingRolls,
    quickPrimePails: quickPrimePails,
    rpfRolls: rpfRolls,
    insulationPlateCount: plateCount,
    seamPlateCount: seamPlateCount,
    screwRows: estimatorScrewRowsForAssembly(input),
    tJointCovers: Math.max(1, Math.ceil((membraneRolls + drainCount + pipeCount + scupperCount + Math.ceil(curbPerimeter / 20)) / 12)),
    waterBlockTubes: (drainCount * 2) + (scupperCount * 2) + (perimeter ? Math.ceil(perimeter / 72) : 0) + (curbPerimeter ? Math.ceil(curbPerimeter / 100) : 0),
    lapSealantTubes: Math.ceil((longFieldSeamsLf + endLapLf + wallAndCurbSpliceLf + detailSpliceLf) / 35),
    cleanerGallons: Math.ceil(area / 1000),
    pipeBoots: pipeCount,
    scupperFlashing: input.scupperFlashing || (scupperCount * 200),
    miscDetailMaterials: input.miscDetailMaterials || 1500,
    blockingCost: blockingCost
  });
  estimatorInputSeed = next;
  estimatorSetVal("est-membrane", next.membrane);
  estimatorSetVal("est-overlay-sq", next.overlaySq);
  estimatorSetVal("est-blocking-cost", next.blockingCost);
  estimatorLineItems = estimatorGeneratedLineItems(next).items;
  estimatorActiveSavedEstimate = null;
  var result = estimatorCalculate(next, estimatorLineItems);
  estimatorRender(result);
  if (typeof toast === "function") toast("EPDM SA estimate built from intake.");
  return result;
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
  add("3\" QuickSeam splice tape", input.spliceTapeRolls + " rolls / " + (input.spliceTapeRolls * 100) + " LF", estimatorMoney(input.spliceTapeRollPrice) + "/100 LF roll, Warrensburg rule: 1.5 per field roll minimum", input.spliceTapeRolls * input.spliceTapeRollPrice);
  add("6\" QuickSeam batten cover", input.battenCoverRolls + " rolls / " + (input.battenCoverRolls * 100) + " LF", estimatorMoney(input.battenCoverRollPrice) + "/100 LF roll, end laps/exposed SA adhesive", input.battenCoverRolls * input.battenCoverRollPrice);
  add("5\" QuickSeam flashing", input.quickSeamFlashingRolls + " rolls / " + (input.quickSeamFlashingRolls * 100) + " LF", estimatorMoney(input.quickSeamFlashingRollPrice) + "/100 LF roll, pipes/drains/scuppers/curbs", input.quickSeamFlashingRolls * input.quickSeamFlashingRollPrice);
  add("QuickPrime Plus", input.quickPrimePails + " pails / " + (input.quickPrimePails * 3) + " gal", estimatorMoney(input.quickPrimePrice) + "/3-gal pail", input.quickPrimePails * input.quickPrimePrice);
  add("RPF/RUSS strip", input.rpfRolls + " rolls / " + (input.rpfRolls * 100) + " LF", estimatorMoney(input.rpfRollPrice) + "/100 LF roll", input.rpfRolls * input.rpfRollPrice);
  add("3\" insulation plates", input.insulationPlateCount + " plates / " + Math.ceil((input.insulationPlateCount || 0) / 500) + " pails", estimatorMoney(input.insulationPlatePricePerM) + "/M", (input.insulationPlateCount / 1000) * input.insulationPlatePricePerM);
  (input.screwRows || []).forEach(function(row){
    add(row.length + " insulation screws", row.pails + " pail" + (row.pails === 1 ? "" : "s") +
      " / " + row.ordered + " screws", estimatorMoney(row.pricePerM) + "/M, need " + row.needed,
      (row.ordered / 1000) * row.pricePerM);
  });
  add("2\" seam plates for RPF", input.seamPlateCount + " plates / " + Math.ceil((input.seamPlateCount || 0) / 1000) + " cartons", input.seamPlateCount ? "1 plate per LF, rounded to cartons" : "not carried", input.seamPlateCount ? (Math.ceil(input.seamPlateCount / 1000) * input.seamPlateCost) : 0);
  add("RPF / curb securement fasteners", input.seamPlateCount + " screws", estimatorMoney(input.rpfFastenerPricePerM) + "/M, length by field thickness", (input.seamPlateCount / 1000) * input.rpfFastenerPricePerM);
  add("T-joint covers / detail patches", input.tJointCovers + " cartons", estimatorMoney(input.tJointCoverPrice) + "/carton, T-joints/angle changes/seam intersections", input.tJointCovers * input.tJointCoverPrice);
  add("Water Block", input.waterBlockTubes + " tubes", estimatorMoney(input.waterBlockPrice) + "/tube, drains/scuppers/perimeter/curbs", input.waterBlockTubes * input.waterBlockPrice);
  add("Lap/all-purpose sealant", input.lapSealantTubes + " tubes", estimatorMoney(input.lapSealantPrice) + "/tube, seam edge/detail allowance", input.lapSealantTubes * input.lapSealantPrice);
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
  var pricingSquares = generated.areaSquares > 0 ? generated.areaSquares : 0;

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
    pricePerSquareEdge: pricingSquares ? edgeTotal / pricingSquares : 0,
    pricePerSquareOur: pricingSquares ? ourTotal / pricingSquares : 0,
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
  var sq = result.areaSquares > 0 ? result.areaSquares : 0;
  function costPerSquare(amount){
    return sq ? amount / sq : 0;
  }
  var basis = estimatorTakeoffBasisHtml(result);
  host.innerHTML =
    "<div class=\"estimator-results-grid\">" +
      "<div class=\"estimator-total\"><b>EDGE Method</b><strong>" + estimatorMoney(result.edgeTotal) + "</strong><span>" + estimatorMoney(result.pricePerSquareEdge) + " / SQ</span></div>" +
      "<div class=\"estimator-total\"><b>Our Way</b><strong>" + estimatorMoney(result.ourTotal) + "</strong><span>" + estimatorMoney(result.pricePerSquareOur) + " / SQ</span></div>" +
      "<div class=\"estimator-total\"><b>Difference</b><strong>" + estimatorMoney(result.ourTotal - result.edgeTotal) + "</strong><span>Our Way over EDGE</span></div>" +
    "</div>" +
    "<div class=\"estimator-note\">" + esc(result.wallNote) + "</div>" +
    basis +
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
      estimatorRowHtml("EDGE labor - " + result.manHours + " MH @ " + estimatorMoney(result.input.edgeLaborRate) + "/hr", result.edgeLabor, costPerSquare(result.edgeLabor)) +
      estimatorRowHtml("Our labor - " + result.manHours + " MH @ " + estimatorMoney(result.input.ourLaborRate) + "/hr", result.ourLabor, costPerSquare(result.ourLabor)) +
      estimatorRowHtml("Other editable costs / allowances", result.otherCosts, costPerSquare(result.otherCosts)) +
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

function estimatorTakeoffBasisHtml(result){
  var input = result.input || {};
  var fieldRolls = Math.ceil((input.areaSf * (1 + input.membraneWasteRate)) / (input.membraneRollSq * 100));
  var wallRolls = Number(input.extraSaRollsForWalls || 0);
  var screwsOrdered = (input.screwRows || []).reduce(function(sum, row){ return sum + Number(row.ordered || 0); }, 0);
  function basisRow(label, value){
    return "<tr><td>" + esc(label) + "</td><td class=\"num\">" + esc(value) + "</td></tr>";
  }
  return "<table class=\"estimator-table\"><thead><tr><th>Takeoff Basis</th><th class=\"num\">Quantity</th></tr></thead><tbody>" +
    basisRow("Field SA EPDM rolls", fieldRolls) +
    basisRow("Wall/curb SA roll allowance", wallRolls) +
    basisRow("3\" splice tape rule", (input.spliceTapeRolls || 0) + " rolls (1.5 per field roll minimum)") +
    basisRow("6\" batten cover allowance", (input.battenCoverRolls || 0) + " rolls") +
    basisRow("Top-layer insulation plates", (input.insulationPlateCount || 0) + " plates") +
    basisRow("Insulation screws purchased", screwsOrdered + " screws") +
    basisRow("RPF/RUSS rolls", (input.rpfRolls || 0) + " rolls") +
    basisRow("2\" RPF seam plates", (input.seamPlateCount || 0) + " plates") +
    basisRow("Water Block / Lap Sealant", (input.waterBlockTubes || 0) + " tubes / " + (input.lapSealantTubes || 0) + " tubes") +
  "</tbody></table>";
}

function estimatorProposalText(source){
  var saved = source && source.recordType === "estimate_job_file" ? source : null;
  var result = saved ? estimatorCalculate(saved.input, saved.lineItems) : source;
  var input = saved ? saved.input : result.input;
  var price = saved ? saved.proposalAmount : result.edgeTotal;
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

function estimatorCurrentMatchesSaved(saved){
  if (!saved) return false;
  var currentInput = estimatorReadForm();
  var currentLineItems = estimatorLineItems || estimatorCalculate(currentInput).lineItems;
  return JSON.stringify(currentInput) === JSON.stringify(saved.input) &&
    JSON.stringify(currentLineItems) === JSON.stringify(saved.lineItems || []);
}

function estimatorCreateProposal(){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (!estimatorActiveSavedEstimate){
    if (typeof toast === "function") toast("Save EDGE or Save Our Way first.");
    return;
  }
  if (!estimatorCurrentMatchesSaved(estimatorActiveSavedEstimate)){
    estimatorActiveSavedEstimate = null;
    if (typeof toast === "function") toast("Estimate changed. Save EDGE or Save Our Way again before creating the proposal.");
    return;
  }
  var text = estimatorProposalText(estimatorActiveSavedEstimate);
  var card = document.getElementById("estimator-proposal-card");
  var pre = document.getElementById("estimator-proposal-text");
  if (pre) pre.textContent = text;
  if (card) card.style.display = "";
  if (typeof toast === "function") toast("Proposal draft created from saved " + (estimatorActiveSavedEstimate.pricingLabel || "estimate") + " job file.");
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
  var input = estimatorActiveSavedEstimate ? estimatorActiveSavedEstimate.input : estimatorReadForm();
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
  estimatorActiveSavedEstimate = null;
  return estimatorRecalculateLineItems();
}

function estimatorDeleteLineItem(index){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  if (!estimatorLineItems || !estimatorLineItems[index]) return;
  estimatorLineItems.splice(index, 1);
  estimatorActiveSavedEstimate = null;
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
  estimatorActiveSavedEstimate = null;
  return estimatorRecalculateLineItems();
}

function estimatorCalculateFromForm(opts){
  if (!estimatorIsOwner()){
    if (typeof toast === "function") toast("Owner login required.");
    return;
  }
  estimatorActiveSavedEstimate = null;
  estimatorLastInput = estimatorReadForm();
  estimatorLineItems = estimatorGeneratedLineItems(estimatorLastInput).items;
  var result = estimatorCalculate(estimatorLastInput, estimatorLineItems);
  estimatorRender(result);
  if (!opts || !opts.quiet){
    if (typeof toast === "function") toast("Estimate calculated.");
  }
  return result;
}
