"use strict";

// DPR weather — the day's conditions at the job, auto-pulled from Open-Meteo
// and SAVED with the report. Same VM-sandbox approach as tests/dpr.test.js /
// tests/dprCrewHours.test.js: the REAL shipped js/dpr.js runs against stubbed
// globals; fetch is a URL-routing stub.
//
// Coverage:
//   1. dprWeatherFromApi — maps a real-shaped Open-Meteo daily response
//      (indexes the requested day, rounds, WMO code -> words), null on garbage
//   2. dprWeatherSummary — compact line; plain mode drops the emoji (jsPDF
//      helvetica can't draw it)
//   3. collect() / fill() round-trip the weather snapshot
//   4. dprRefreshWeather — fetches once per (coord, date) and caches; stores
//      lat/lng with the snapshot; a failed fetch leaves the report usable
//      (weather null, no throw, no retry-hammer); saved same-date snapshot
//      and locked reports never refetch; no job/date = no fetch

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "dpr.js"), "utf8");

function realSlugify(s){
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}
function plain(o){ return JSON.parse(JSON.stringify(o)); }

// A fetch stub routing by URL: Open-Meteo answered from `plan`, any other URL
// (e.g. the crew-hours day_hours endpoint a dprFill may schedule) 400s.
function weatherFetch(plan){
  const calls = [];
  const fn = async (url) => {
    url = String(url);
    if (!/open-meteo\.com/.test(url)) return { ok: false, status: 400, json: async () => ({}) };
    calls.push(url);
    if (plan.fail) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => plan.body };
  };
  fn.calls = calls;
  return fn;
}

const OM_BODY = {
  daily: {
    time: ["2026-07-16"],
    weather_code: [61],
    temperature_2m_max: [87.3],
    temperature_2m_min: [68.05],
    precipitation_sum: [0.12],
    wind_speed_10m_max: [12.456]
  }
};

function makeSandbox(opts){
  opts = opts || {};
  const sandbox = {
    console: { warn(){}, log(){}, error(){} },
    document: { getElementById(){ return null; } },
    fdb: null,
    currentAuthClaims: null,
    currentAuthUser: null,
    slugify: realSlugify,
    customerIdFor(billTo){ const n = (billTo || "").trim(); return n ? ("cust_" + realSlugify(n)) : null; },
    buildingIdFor(billTo, jobName){
      const b = (jobName || "").trim();
      if (!b) return null;
      const c = (billTo || "").trim() ? ("cust_" + realSlugify(billTo.trim())) : null;
      return "bld_" + realSlugify((c || "nocust") + "_" + b);
    },
    __fields: {},
    val(id){ return sandbox.__fields[id] || ""; },
    setVal(id, v){ sandbox.__fields[id] = v == null ? "" : String(v); },
    toast(){},
    esc(s){ return String(s == null ? "" : s); },
    getBuildingRoofs(){ return [{ id: "roof_default", label: "Roof 1" }]; },
    L: { latLng(lat, lng){ return { lat: lat, lng: lng }; } },
    setTimeout, clearTimeout,
    authHeaders: async () => ({}),
    fetch: opts.fetch
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  // The coordinate resolver walks photos/Firestore/geocoders — pin it for tests.
  sandbox.dprResolveJobCenter = async () => (opts.center === undefined
    ? { lat: 38.9517, lng: -92.3341, zoom: 20 } : opts.center);
  return sandbox;
}

// ---------------- 1. the API mapper ----------------

test("dprWeatherFromApi maps the day's Open-Meteo response (WMO code -> words, rounded numbers)", () => {
  const s = makeSandbox();
  const w = s.dprWeatherFromApi(OM_BODY, "2026-07-16");
  assert.deepStrictEqual(plain(w), {
    date: "2026-07-16", source: "open-meteo", code: 61,
    conditions: "Light rain", icon: "🌧️",
    tempMaxF: 87.3, tempMinF: 68.05, windMph: 12.46, precipIn: 0.12
  });
});

test("dprWeatherFromApi indexes the requested date when multiple days come back", () => {
  const s = makeSandbox();
  const body = { daily: {
    time: ["2026-07-15", "2026-07-16"], weather_code: [0, 3],
    temperature_2m_max: [90, 80], temperature_2m_min: [70, 60],
    precipitation_sum: [0, 0.5], wind_speed_10m_max: [5, 15]
  } };
  const w = s.dprWeatherFromApi(body, "2026-07-16");
  assert.strictEqual(w.conditions, "Overcast");
  assert.strictEqual(w.tempMaxF, 80);
});

test("dprWeatherFromApi returns null on empty/garbage responses", () => {
  const s = makeSandbox();
  assert.strictEqual(s.dprWeatherFromApi(null, "2026-07-16"), null);
  assert.strictEqual(s.dprWeatherFromApi({}, "2026-07-16"), null);
  assert.strictEqual(s.dprWeatherFromApi({ daily: { time: [] } }, "2026-07-16"), null);
});

test("unknown WMO codes degrade to empty label, not a crash", () => {
  const s = makeSandbox();
  assert.deepStrictEqual(plain(s.dprWeatherLabel(42)), { label: "", icon: "" });
});

// ---------------- 2. the summary line ----------------

test("dprWeatherSummary: display line has the glyph, plain (PDF) line doesn't", () => {
  const s = makeSandbox();
  const w = s.dprWeatherFromApi(OM_BODY, "2026-07-16");
  assert.strictEqual(s.dprWeatherSummary(w), "🌧️ Light rain · 87.3°/68.05°F · wind 12.46 mph · precip 0.12 in");
  assert.strictEqual(s.dprWeatherSummary(w, true), "Light rain · 87.3°/68.05°F · wind 12.46 mph · precip 0.12 in");
  assert.strictEqual(s.dprWeatherSummary(null), "");
});

// ---------------- 3. round-trip ----------------

test("collect() carries the weather snapshot and fill() restores it", () => {
  const s = makeSandbox();
  const w = { date: "2026-07-16", source: "open-meteo", code: 0, conditions: "Clear", icon: "☀️",
    tempMaxF: 91, tempMinF: 66, windMph: 8, precipIn: 0, lat: 38.95, lng: -92.33 };
  s.dprFill({ date: "2026-07-16", jobName: "North Warehouse", billTo: "Acme", weather: w });
  const out = s.dprCollect();
  assert.deepStrictEqual(plain(out.weather), w);
});

test("a report without weather collects null (older docs unchanged)", () => {
  const s = makeSandbox();
  s.dprFill({ date: "2026-07-15", jobName: "N", billTo: "A" });
  assert.strictEqual(s.dprCollect().weather, null);
});

// ---------------- 4. the refresh plumbing ----------------

function fillFresh(s){
  s.dprFill({ date: "2026-07-16", jobName: "North Warehouse", billTo: "Acme" });
}

test("dprRefreshWeather pulls the day for the resolved coords and saves lat/lng with it", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch });
  fillFresh(s);
  await s.dprRefreshWeather();
  const w = s.dprCollect().weather;
  assert.strictEqual(w.conditions, "Light rain");
  assert.strictEqual(w.lat, 38.9517);
  assert.strictEqual(w.lng, -92.3341);
  assert.strictEqual(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /latitude=38\.9517/);
  assert.match(fetch.calls[0], /start_date=2026-07-16&end_date=2026-07-16/);
  assert.match(fetch.calls[0], /temperature_unit=fahrenheit/);
});

test("same coord+date is cached — no second fetch; saved snapshot short-circuits entirely", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch });
  fillFresh(s);
  await s.dprRefreshWeather();
  await s.dprRefreshWeather();  // snapshot for this date exists -> no fetch
  assert.strictEqual(fetch.calls.length, 1);
});

test("a failed fetch never blocks the report: weather stays null, no throw, no retry-hammer", async () => {
  const fetch = weatherFetch({ fail: true });
  const s = makeSandbox({ fetch });
  fillFresh(s);
  await s.dprRefreshWeather();
  await s.dprRefreshWeather();
  assert.strictEqual(s.dprCollect().weather, null);
  assert.strictEqual(fetch.calls.length, 1);   // null cached per coord/date
});

test("unresolvable coordinates = no fetch, report proceeds", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch, center: null });
  fillFresh(s);
  await s.dprRefreshWeather();
  assert.strictEqual(s.dprCollect().weather, null);
  assert.strictEqual(fetch.calls.length, 0);
});

test("no job = no fetch at all", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch });
  s.dprFill({ date: "2026-07-16" });        // no job name
  await s.dprRefreshWeather();
  assert.strictEqual(fetch.calls.length, 0);
});

test("no date = no fetch at all (fields set directly — dprFill would default the date to today)", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch });
  s.setVal("dpr-jobName", "North Warehouse");   // job but no date
  await s.dprRefreshWeather();
  assert.strictEqual(fetch.calls.length, 0);
});

test("a saved snapshot for the report's date is the record — an editable reopen does not refetch", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch });
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    weather: { date: "2026-07-16", conditions: "Clear", icon: "☀️", tempMaxF: 90, tempMinF: 70, windMph: 5, precipIn: 0 } });
  await s.dprRefreshWeather();
  assert.strictEqual(fetch.calls.length, 0);
  assert.strictEqual(s.dprCollect().weather.conditions, "Clear");
});

test("a locked (signed) report never refetches weather", async () => {
  const fetch = weatherFetch({ body: OM_BODY });
  const s = makeSandbox({ fetch });
  s.dprFill({ date: "2026-07-16", jobName: "N", billTo: "A",
    signoff: { signed: true, locked: true } });
  await s.dprRefreshWeather();
  assert.strictEqual(fetch.calls.length, 0);
});
