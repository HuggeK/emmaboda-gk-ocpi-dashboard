// Solar on the club's measured consumption, per quarter hour: what each roof
// (and generic east/west sizes) would save in electricity and effektavgift.
//
//   node tools/roof-solar/simulate.mjs <snapshot.json> [--roofs public/data/solar-roofs.json]
//        [--spot <spot.json>] [--out public/data/solar-effekt.json] [--sizes <sizes.json>]
//        [--from 2025-11-01] [--to 2026-11-01]
//
// Inputs: the published snapshot (E.ON quarter values and, from it or --spot,
// SE4 spot prices per quarter hour) and the roof faces from roof_solar.py.
// Solar output comes from PVGIS (EU JRC, hourly, weather years 2019–2023) for
// every roof face's tilt and direction; flat roofs get east–west racks at 10°.
// Hourly PVGIS output is spread over the hour's four quarters by linear
// interpolation between hour centres, keeping each hour's energy.
//
// Per quarter: the club's measured load L and the panels' output P (kW).
// Used on site min(L, P) saves spot + surcharge + the 2027 grid energy fee
// (6.40 öre + 12.1 % of spot) + energy tax; the rest is exported at spot, up
// to 43.5 kW (above that E.ON charges a fee, so it is not counted). The
// effektavgift is billed on the month's highest *hourly* mean of what is
// bought, so the quarters' imports are averaged per hour for that.
// The same sets are also run on hourly values, for comparison.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const M = await import(new URL('../../public/meter.js', import.meta.url));
const A = await import(new URL('../../public/analysis.js', import.meta.url));
const { GRID_2027, SOLAR_STEPS } = await import(new URL('../../public/contracts.js', import.meta.url));

const args = process.argv.slice(2);
const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const snapPath = args[0];
if (!snapPath || snapPath.startsWith('--')) throw new Error('usage: simulate.mjs <snapshot.json> [options]');
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const roofs = JSON.parse(fs.readFileSync(arg('--roofs', path.join(ROOT, 'public/data/solar-roofs.json')), 'utf8'));
// --exclude kansli:W,studio: leave out roof faces (building:direction) or whole
// buildings, e.g. a roof that may not get panels (glare, load capacity).
for (const spec of (arg('--exclude') || '').split(',').filter(Boolean)) {
  const [key, dir] = spec.split(':');
  const b = roofs.buildings.find((x) => x.key === key);
  if (!b) throw new Error(`--exclude: no building ${key}`);
  if (!dir) { roofs.buildings = roofs.buildings.filter((x) => x !== b); continue; }
  for (const f of b.faces.filter((x) => (x.flat ? 'flat' : x.direction) === dir)) {
    b.kwp -= f.kwp; b.kwh_year -= f.kwh_year; b.panels -= f.panels;
    f.panels = 0; f.kwp = 0; f.kwh_year = 0;
  }
}
const spot = arg('--spot') ? JSON.parse(fs.readFileSync(arg('--spot'), 'utf8')) : snap.spot;
if (!spot?.values) throw new Error('no spot prices: the snapshot has none, pass --spot');
const outPath = arg('--out', path.join(ROOT, 'public/data/solar-effekt.json'));
const sizesPath = arg('--sizes');
const from = new Date(`${arg('--from', '2025-11-01')}T00:00:00`).getTime();
const to = new Date(`${arg('--to', '2026-11-01')}T00:00:00`).getTime();

const Q = 15 * 60_000;
const H = 3_600_000;
const KR_PER_KW = GRID_2027.krPerKw;
const SURCHARGE_ORE = M.DEFAULT_TARIFF.surchargeOre;
const TAX_ORE = M.DEFAULT_TARIFF.energyTaxOre;
const EXPORT_CAP_KW = 43.5;
const LAT = 56.53;
const LON = 15.58;

// ---- load and prices per quarter -------------------------------------------
const inst = snap.eon.installations.find((i) => i.quarter);
const load = [...M.meterQuarters(inst).entries()].filter(([t]) => t >= from && t < to).sort((a, b) => a[0] - b[0]);
const expected = (to - from) / Q;
if (load.length < expected * 0.98) throw new Error(`only ${load.length} of ${expected} quarters measured in the period`);
const prices = M.expandSeries(spot);
let missingPrices = 0;
const priceAt = (t) => {
  const p = prices.get(t);
  if (p === undefined) missingPrices += 1;
  return p ?? 80;
};
const boughtOre = (s) => s + SURCHARGE_ORE + GRID_2027.energyOre + (GRID_2027.energySpotPct / 100) * Math.max(0, s) + TAX_ORE;

// ---- PVGIS -----------------------------------------------------------------
// Map(weather year -> Map(UTC hour ms -> kW per kWp)).
const pvgisCache = new Map();
async function hourlyPerKwp(tilt, azimuth) {
  const angle = Math.round(tilt);
  const aspect = Math.round(((azimuth - 180 + 540) % 360) - 180); // PVGIS: 0 = south, -90 = east
  const id = `${angle}/${aspect}`;
  if (pvgisCache.has(id)) return pvgisCache.get(id);
  const url = `https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat=${LAT}&lon=${LON}&peakpower=1&loss=14&angle=${angle}&aspect=${aspect}&startyear=2019&endyear=2023&pvcalculation=1&outputformat=json`;
  let json = null;
  for (let attempt = 1; !json; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      if (attempt >= 4) throw new Error(`PVGIS ${id}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  const years = new Map();
  for (const h of json.outputs.hourly) {
    const y = +h.time.slice(0, 4);
    const t = Date.UTC(y, +h.time.slice(4, 6) - 1, +h.time.slice(6, 8), +h.time.slice(9, 11));
    (years.get(y) || years.set(y, new Map()).get(y)).set(t, h.P / 1000);
  }
  pvgisCache.set(id, years);
  return years;
}

// A weather year's hour laid on the load year's calendar: same month, day and UTC hour.
const calendarKey = (t) => {
  const d = new Date(t);
  return `${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
};

// Hourly kW per kWp -> quarters: linear between hour centres, rescaled so the
// four quarters keep the hour's energy.
function toQuarters(hourMap) {
  const byKey = new Map();
  for (const [t, kw] of hourMap) byKey.set(calendarKey(t), kw);
  return (t) => {
    const hour = Math.floor(t / H) * H;
    const at = (h) => byKey.get(calendarKey(h)) || 0;
    const p0 = at(hour);
    if (p0 <= 0) return 0;
    const qs = [0, 1, 2, 3].map((k) => {
      const c = k * 15 + 7.5; // minutes into the hour
      return c < 30 ? at(hour - H) + (p0 - at(hour - H)) * ((c + 30) / 60) : p0 + (at(hour + H) - p0) * ((c - 30) / 60);
    }).map((v) => Math.max(0, v));
    const sum = qs.reduce((a, b) => a + b, 0);
    return sum > 0 ? (qs[Math.round((t - hour) / Q)] * 4 * p0) / sum : 0;
  };
}

// ---- SMHI STRÅNG: the actual weather of the load year ------------------------
// STRÅNG (SMHI's mesoscale model, 2.5 km, hourly) gives global (117), direct
// normal (118) and diffuse (122) irradiance as instantaneous values at the
// stamp. Per quarter the three are interpolated to the quarter's middle and
// put on the panel plane (beam × cos incidence, isotropic diffuse, ground
// reflection at albedo 0.2). One factor per face then scales that to PVGIS's
// output for the same face over 2019–2023 (STRÅNG for those years through the
// same plane model), so PVGIS's losses (temperature, reflection, system) are
// kept and only the weather changes.
const STRANG_PARAMS = { ghi: 117, dni: 118, dhi: 122 };
const STRANG_PERIODS = [['2019-01-01', '2024-01-01'], [new Date(from - H).toISOString().slice(0, 10), new Date(to + 2 * H).toISOString().slice(0, 10)]];
let strang = null; // Map(t -> { ghi, dni, dhi })
async function loadStrang() {
  if (strang) return strang;
  const cache = arg('--strang-cache');
  if (cache && fs.existsSync(cache)) {
    strang = new Map(Object.entries(JSON.parse(fs.readFileSync(cache, 'utf8'))).map(([t, v]) => [+t, v]));
    return strang;
  }
  strang = new Map();
  for (const [a, b] of STRANG_PERIODS) {
    for (let y = +a.slice(0, 4); y <= +b.slice(0, 4); y += 1) {
      const f = y === +a.slice(0, 4) ? a : `${y}-01-01`;
      const t = y === +b.slice(0, 4) ? b : `${y + 1}-01-01`;
      if (f >= t) continue;
      for (const [name, id] of Object.entries(STRANG_PARAMS)) {
        const url = `https://opendata-download-metanalys.smhi.se/api/category/strang1g/version/1/geotype/point/lon/${LON}/lat/${LAT}/parameter/${id}/data.json?from=${f}&to=${t}&interval=hourly`;
        let rows = null;
        for (let attempt = 1; !rows; attempt += 1) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            rows = await res.json();
          } catch (err) {
            if (attempt >= 4) throw new Error(`STRÅNG ${name} ${f}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
        for (const x of rows) {
          const at = Date.parse(x.date_time);
          (strang.get(at) || strang.set(at, {}).get(at))[name] = x.value === null || x.value < 0 ? null : x.value;
        }
      }
    }
  }
  if (cache) fs.writeFileSync(cache, JSON.stringify(Object.fromEntries(strang)));
  return strang;
}

const RAD = Math.PI / 180;
// Sun elevation and azimuth (deg, azimuth from north clockwise), NOAA approximation.
function sun(t) {
  const d = new Date(t);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = (2 * Math.PI / 365) * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = ((hr * 60 + eqt + 4 * LON) / 4 - 180) * RAD;
  const la = LAT * RAD;
  const sinEl = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(decl) - Math.sin(la) * sinEl) / (Math.cos(la) * Math.cos(el));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
  if (ha > 0) az = 360 - az;
  return { el: el / RAD, az };
}

// Irradiance on a plane (W/m²) at instant t, from STRÅNG interpolated to t.
function planeIrradiance(t, tilt, azimuth) {
  const t0 = Math.floor(t / H) * H;
  const a = strang.get(t0);
  const b = strang.get(t0 + H);
  if (!a || !b) return null;
  const f = (t - t0) / H;
  const mix = (k) => (a[k] === null || b[k] === null ? null : a[k] + (b[k] - a[k]) * f);
  const ghi = mix('ghi');
  const dni = mix('dni');
  const dhi = mix('dhi');
  if (ghi === null || dni === null || dhi === null) return null;
  const s = sun(t);
  if (s.el <= 0) return 0;
  const beta = tilt * RAD;
  const cosAoi = Math.cos(beta) * Math.sin(s.el * RAD) + Math.sin(beta) * Math.cos(s.el * RAD) * Math.cos((s.az - azimuth) * RAD);
  return Math.max(0, dni * Math.max(0, cosAoi) + dhi * (1 + Math.cos(beta)) / 2 + ghi * 0.2 * (1 - Math.cos(beta)) / 2);
}

// kW per kWp for each load quarter, from STRÅNG, scaled to PVGIS for that face.
const strangCache = new Map();
async function strangPerKwp(tilt, azimuth) {
  const id = `${Math.round(tilt)}/${Math.round(azimuth)}`;
  if (strangCache.has(id)) return strangCache.get(id);
  await loadStrang();
  // Calibration: hourly plane irradiance 2019–2023 against PVGIS's output.
  const pvgis = await hourlyPerKwp(tilt, azimuth);
  let pvKwh = 0;
  let irr = 0;
  for (const [, hours] of pvgis) {
    for (const [t, kw] of hours) {
      const g = planeIrradiance(t + 30 * 60_000, tilt, azimuth); // the hour's middle
      if (g === null) continue;
      pvKwh += kw;
      irr += g / 1000;
    }
  }
  const k = pvKwh / irr; // kW per kWp per kW/m² on the plane, PVGIS-equivalent
  // Quarters STRÅNG has no value for get PVGIS's mean over the five years.
  const typical = [...pvgis.values()].map(toQuarters);
  const arr = new Float64Array(load.length);
  let gaps = 0;
  load.forEach(([t], i) => {
    const g = planeIrradiance(t + 7.5 * 60_000, tilt, azimuth);
    if (g === null) {
      gaps += 1;
      arr[i] = typical.reduce((s, q) => s + q(t), 0) / typical.length;
    } else arr[i] = (g / 1000) * k;
  });
  const result = { arr, k, gaps };
  strangCache.set(id, result);
  return result;
}

const WEATHER = arg('--weather', 'pvgis');

// Days in the load year that STRÅNG has no values for (its days are UTC).
function strangGapDays() {
  const days = new Set();
  for (const [t, v] of strang || []) {
    if (t < from || t >= to) continue;
    if (v.ghi === null || v.dni === null || v.dhi === null || v.ghi === undefined) days.add(new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
  }
  return [...days];
}

// Production per set: { year -> Float64Array of kW per load quarter }. With
// --weather strang there is one "year": the actual weather of the load year.
async function production(parts, weather = WEATHER) {
  if (weather === 'strang') {
    const arr = new Float64Array(load.length);
    for (const { tilt, azimuth, kwp } of parts) {
      const s = await strangPerKwp(tilt, azimuth);
      s.arr.forEach((v, i) => { arr[i] += v * kwp; });
    }
    return { actual: arr };
  }
  const out = {};
  for (const { tilt, azimuth, kwp } of parts) {
    const years = await hourlyPerKwp(tilt, azimuth);
    for (const [y, hours] of years) {
      const q = toQuarters(hours);
      const arr = (out[y] ||= new Float64Array(load.length));
      load.forEach(([t], i) => {
        arr[i] += q(t) * kwp;
      });
    }
  }
  return out;
}

function facesOf(b) {
  return b.faces.filter((f) => f.panels > 0).flatMap((f) => (f.flat
    ? [{ tilt: 10, azimuth: 90, kwp: f.kwp / 2 }, { tilt: 10, azimuth: 270, kwp: f.kwp / 2 }]
    : [{ tilt: f.panel_tilt, azimuth: f.azimuth, kwp: f.kwp }]));
}

// ---- one weather year, quarters or hours -----------------------------------
function runYear(prod, step) {
  const n = step === 'quarter' ? 1 : 4;
  const months = new Map();
  let produced = 0;
  let self = 0;
  let energyKr = 0;
  const hourImport = new Map();
  const hourLoad = new Map();
  for (let i = 0; i < load.length; i += n) {
    const t = load[i][0];
    let L = 0;
    let P = 0;
    let s = 0;
    for (let k = 0; k < n; k += 1) {
      L += load[i + k][1];
      P += prod[i + k];
      s += priceAt(load[i + k][0]);
    }
    L /= n;
    P /= n;
    s /= n; // hourly runs: the hour's mean price
    const hours = n / 4; // length of this step in hours
    const used = Math.min(L, P);
    const exported = Math.min(Math.max(0, P - L), EXPORT_CAP_KW);
    produced += P * hours;
    self += used * hours;
    energyKr += ((used * boughtOre(s) + exported * Math.max(0, s)) * hours) / 100;
    const hour = Math.floor(t / H) * H;
    hourImport.set(hour, (hourImport.get(hour) || 0) + Math.max(0, L - P) * hours);
    hourLoad.set(hour, (hourLoad.get(hour) || 0) + L * hours);
  }
  for (const [hour, kwh] of hourLoad) {
    const key = A.monthKey(hour);
    const m = months.get(key) || { before: 0, after: 0 };
    m.before = Math.max(m.before, kwh);
    m.after = Math.max(m.after, hourImport.get(hour));
    months.set(key, m);
  }
  const perMonth = [...months.entries()].map(([month, m]) => ({ month, cutKw: m.before - m.after }));
  const summer = perMonth.filter((m) => { const mo = +m.month.slice(5); return mo >= 4 && mo <= 9; });
  return {
    produced, self, energyKr,
    effektKr: perMonth.reduce((s, m) => s + m.cutKw * KR_PER_KW, 0),
    summerCut: summer.reduce((s, m) => s + m.cutKw, 0) / summer.length,
    perMonth,
  };
}

function summarise(keys, kwp, byYear, step) {
  const results = Object.values(byYear).map((prod) => runYear(prod, step));
  const mean = (f) => results.reduce((s, r) => s + f(r), 0) / results.length;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    keys, kwp: Math.round(kwp * 100) / 100,
    kwh: Math.round(mean((r) => r.produced)),
    onSite: Math.round(mean((r) => r.self / r.produced) * 1000) / 1000,
    summerCutKw: r1(mean((r) => r.summerCut)),
    effektKr: Math.round(mean((r) => r.effektKr)),
    effektMin: Math.round(Math.min(...results.map((r) => r.effektKr))),
    effektMax: Math.round(Math.max(...results.map((r) => r.effektKr))),
    energyKr: Math.round(mean((r) => r.energyKr)),
    months: results[0].perMonth.map((m, i) => ({
      month: m.month,
      cutKw: r1(mean((r) => r.perMonth[i].cutKw)),
      minKw: r1(Math.min(...results.map((r) => r.perMonth[i].cutKw))),
      maxKw: r1(Math.max(...results.map((r) => r.perMonth[i].cutKw))),
    })),
  };
}

// ---- the sets ----------------------------------------------------------------
const buildings = roofs.buildings.filter((b) => !b.error && b.kwp > 0);
const prodByBuilding = {};
for (const b of buildings) prodByBuilding[b.key] = await production(facesOf(b));
const combine = (keys) => {
  const out = {};
  for (const y of Object.keys(prodByBuilding[keys[0]])) {
    out[y] = new Float64Array(load.length);
    for (const k of keys) prodByBuilding[k][y].forEach((v, i) => { out[y][i] += v; });
  }
  return out;
};
// Each building alone, the purchase steps (SOLAR_STEPS, cumulative) and all roofs.
const have = new Set(buildings.map((b) => b.key));
const roofSets = [...buildings.map((b) => [b.key]), ...SOLAR_STEPS.map((s) => s.keys.filter((k) => have.has(k))), buildings.map((b) => b.key)]
  .filter((keys, i, all) => keys.length && all.findIndex((o) => o.join() === keys.join()) === i);
const kwpOf = (keys) => keys.reduce((s, k) => s + buildings.find((b) => b.key === k).kwp, 0);

const results = { quarter: [], hour: [] };
for (const keys of roofSets) {
  const prod = combine(keys);
  for (const step of ['quarter', 'hour']) results[step].push(summarise(keys, kwpOf(keys), prod, step));
}

// --with-strang (with PVGIS as the main weather): each set also in the actual
// weather of the load year, as a check on the typical-year figures.
const WITH_STRANG = WEATHER === 'pvgis' && args.includes('--with-strang');
if (WITH_STRANG) {
  const actualBy = {};
  for (const b of buildings) actualBy[b.key] = (await production(facesOf(b), 'strang')).actual;
  results.quarter.forEach((r) => {
    const arr = new Float64Array(load.length);
    for (const k of r.keys) actualBy[k].forEach((v, i) => { arr[i] += v; });
    const a = summarise(r.keys, r.kwp, { actual: arr }, 'quarter');
    r.actual = { kwh: a.kwh, onSite: a.onSite, summerCutKw: a.summerCutKw, effektKr: a.effektKr, energyKr: a.energyKr };
  });
}

// Generic east/west roofs at 25°, for the "what size pays best" table.
const ew = await production([{ tilt: 25, azimuth: 90, kwp: 0.5 }, { tilt: 25, azimuth: 270, kwp: 0.5 }]);
const sizes = { quarter: [], hour: [] };
for (const kwp of [10, 20, 30, 40, 60, 80]) {
  const prod = Object.fromEntries(Object.entries(ew).map(([y, a]) => [y, a.map((v) => v * kwp)]));
  for (const step of ['quarter', 'hour']) {
    const r = summarise([`${kwp} kWp`], kwp, prod, step);
    sizes[step].push({ kwp, peakCutKw: r.summerCutKw, effektKr: r.effektKr, energyKr: r.energyKr, onSite: r.onSite, kwh: r.kwh });
  }
}
const genericYield = Math.round(sizes.quarter[0].kwh / 10);
const onSiteValue = (() => {
  // Average value of a solar kWh used on site: the bought price weighted by production (10 kWp, all used).
  let kr = 0;
  let kwh = 0;
  const prod = ew[Object.keys(ew)[0]];
  load.forEach(([t], i) => { kr += (prod[i] * boughtOre(priceAt(t))) / 100; kwh += prod[i]; });
  return Math.round((kr / kwh) * 100) / 100;
})();

const period = `${new Date(from).toLocaleString('en-GB', { month: 'short', year: 'numeric' })} – ${new Date(to - 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' })}`;
fs.writeFileSync(outPath, `${JSON.stringify({
  period,
  ...(arg('--exclude') ? { excluded: arg('--exclude') } : {}),
  weatherYears: WEATHER === 'strang' ? `the actual weather, ${period} (SMHI STRÅNG)` : '2019–2023',
  weather: WEATHER,
  ...(WITH_STRANG ? { actualWeather: `SMHI STRÅNG, ${period}; days without STRÅNG values (${strangGapDays().join(', ')}) use the PVGIS mean` } : {}),
  krPerKw: KR_PER_KW,
  resolution: 'quarter',
  note: WEATHER === 'strang'
    ? 'Each roof face with panels simulated with its own tilt and direction in the actual weather of the same months (SMHI STRÅNG irradiance per quarter hour, scaled to PVGIS for each face), on the club\'s measured quarter-hour consumption, SE4 quarter-hour spot prices with the contract surcharge, and E.ON Elnät 2027 prices. The effektavgift uses the hourly mean of what is bought.'
    : 'Each roof face with panels simulated with its own tilt and direction (PVGIS hourly output spread over quarters, 5 weather years) on the club\'s measured quarter-hour consumption, SE4 quarter-hour spot prices with the contract surcharge, and E.ON Elnät 2027 prices. The effektavgift uses the hourly mean of what is bought.',
  results: results.quarter,
}, null, 1)}\n`);
if (sizesPath) fs.writeFileSync(sizesPath, `${JSON.stringify({ period, genericYield, krPerKwhOnSite: onSiteValue, sizes: sizes.quarter.map(({ kwh, ...s }) => s) }, null, 1)}\n`);

// ---- report ------------------------------------------------------------------
const kr = (x) => Math.round(x).toLocaleString('en-GB');
if (WEATHER === 'strang') {
  console.log(`STRÅNG plane factors (kW per kWp per kW/m², gaps): ${[...strangCache].map(([id, s]) => `${id}° ${s.k.toFixed(3)} (${s.gaps})`).join(', ')}`);
}
console.log(`weather ${WEATHER}; ${load.length} quarters ${period}; ${missingPrices} without a spot price; surcharge ${SURCHARGE_ORE} öre; on-site value ${onSiteValue} kr/kWh; generic yield ${genericYield} kWh/kWp`);
console.log('set                              kWp  on-site q/h      effekt q / h         energy q / h          total q / h');
results.quarter.forEach((q, i) => {
  const h = results.hour[i];
  console.log(`${q.keys.join('+').padEnd(30)} ${q.kwp.toFixed(1).padStart(5)}  ${(q.onSite * 100).toFixed(0).padStart(3)}/${(h.onSite * 100).toFixed(0).padStart(3)}%  ${kr(q.effektKr).padStart(7)} / ${kr(h.effektKr).padStart(7)}  ${kr(q.energyKr).padStart(8)} / ${kr(h.energyKr).padStart(8)}  ${kr(q.effektKr + q.energyKr).padStart(8)} / ${kr(h.effektKr + h.energyKr).padStart(8)}`);
});
console.log('generic east/west sizes (quarter / hour):');
sizes.quarter.forEach((q, i) => {
  const h = sizes.hour[i];
  console.log(`  ${String(q.kwp).padStart(3)} kWp  cut ${q.peakCutKw}/${h.peakCutKw} kW  effekt ${kr(q.effektKr)}/${kr(h.effektKr)}  energy ${kr(q.energyKr)}/${kr(h.energyKr)}  on-site ${(q.onSite * 100).toFixed(1)}/${(h.onSite * 100).toFixed(1)}%`);
});
