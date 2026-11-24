// Grid meter maths for the Meter tab. Pure functions shared by the browser and
// the tests.
//
// E.ON measures the whole facility's energy per hour (and per quarter hour on
// quarter-metered installations). kWh in one hour is the hour's average power
// in kW, which is what the effektavgift is billed on. ChargeNode only gives
// energy per charging session, so the chargers' part of each hour comes from
// the model in analysis.js; the rest of the measured hour is everything else
// (clubhouse, kitchen, heating, pumps...).
import { HOUR_MS, billedPeak, limitAt, limitsBetween, monthKey, isWinter, MAIN_FUSE_KW, DEFAULT_OPTIONS } from './analysis.js';
import { GRID_2027 } from './contracts.js';

const MINUTE_MS = 60_000;
const QUARTER_MS = 15 * MINUTE_MS;
const GRID_SPOT_FROM = new Date(`${GRID_2027.from}T00:00:00`).getTime(); // local midnight

// What one kWh and one month cost, öre and kr excl. VAT. Replace them with the
// numbers on the club's own invoices (grid: E.ON Elnät; energy: the retailer).
// Energy is priced per quarter hour where the snapshot has SE4 spot prices
// (the club's contract is quarter-hour spot, P15M): spot + surchargeOre. The
// flat retailOre is used only for hours without a spot price.
export const DEFAULT_TARIFF = {
  surchargeOre: 8.0, // elhandel on top of spot: surcharge, fees, certificates. Fitted to E.ON's bill: 7.96 öre in Jul 2025 – Jun 2026, 7.58 the year before
  retailOre: 80, // flat elhandel price, only where no spot price is known
  transferOre: 17.3, // E.ON Elnät energiavgift until 2026 (bill: 28,589 kr for 165,686 kWh); from 2027 6.40 öre + 12.1 % of spot
  energyTaxOre: 36, // energiskatt 2026 (Skatteverket: 36.0 öre/kWh; 43.9 in 2025)
  fixedKr: Date.now() >= new Date(2027, 0, 1).getTime() ? 712 : 709, // E.ON Elnät fixed fee per month (2027 price list)
  krPerKw: DEFAULT_OPTIONS.krPerKw, // effektavgift per kW of the month's billed peak
  peakCount: 1, // the billed peak is the average of this many highest hours (on different days)
  vatPct: 25,
};

export function expandSeries(compact) {
  const map = new Map();
  if (!compact?.values) return map;
  const start = Date.parse(compact.start);
  const stepMs = compact.step_min * MINUTE_MS;
  compact.values.forEach((v, i) => {
    if (v !== null && v !== undefined) map.set(start + i * stepMs, v);
  });
  return map;
}

// Hour start (ms) -> kWh in that hour (= average kW). Uses the hourly series,
// filling hours it lacks from complete quarter-hour groups.
export function meterHours(installation) {
  const hours = expandSeries(installation?.hourly);
  const quarters = expandSeries(installation?.quarter);
  const fromQuarters = new Map();
  for (const [t, kwh] of quarters) {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    const h = fromQuarters.get(hour) || { kwh: 0, n: 0 };
    h.kwh += kwh;
    h.n += 1;
    fromQuarters.set(hour, h);
  }
  for (const [hour, h] of fromQuarters) if (h.n === 4 && !hours.has(hour)) hours.set(hour, h.kwh);
  return new Map([...hours.entries()].sort((a, b) => a[0] - b[0]));
}

// Quarter start (ms) -> average kW over the quarter (kWh × 4).
export function meterQuarters(installation) {
  const out = new Map();
  for (const [t, kwh] of expandSeries(installation?.quarter)) out.set(t, kwh * 4);
  return out;
}

// Hour start (ms) -> the spot price the club paid on average in that hour,
// öre/kWh: each quarter's price weighted by the energy measured in that
// quarter, so Σ hour kWh × this = Σ quarter kWh × quarter price exactly.
// Hours without quarter values get the plain mean of their quarter prices.
// Also returns `plain`: hour -> unweighted mean, for comparison.
export function hourlySpot(installation, spot) {
  const prices = expandSeries(spot);
  const kwh = expandSeries(installation?.quarter);
  const hours = new Map();
  for (const [t, ore] of prices) {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    const h = hours.get(hour) || { sum: 0, n: 0, wSum: 0, w: 0 };
    h.sum += ore;
    h.n += 1;
    const q = kwh.get(t);
    if (q !== undefined) {
      h.wSum += ore * q;
      h.w += q;
    }
    hours.set(hour, h);
  }
  const weighted = new Map();
  const plain = new Map();
  for (const [hour, h] of hours) {
    plain.set(hour, h.sum / h.n);
    weighted.set(hour, h.w > 0 ? h.wSum / h.w : h.sum / h.n);
  }
  return { weighted, plain };
}

// Energy price per kWh for one hour, öre excl. VAT: the contract (spot +
// surcharge, or the flat price without spot) and the grid energy fee (flat
// until 2026; from 2027 a fixed part plus a share of the quarter-hour spot).
export function hourPrices(at, spotOre, t = DEFAULT_TARIFF) {
  const hasSpot = Number.isFinite(spotOre);
  const retail = hasSpot ? spotOre + t.surchargeOre : t.retailOre;
  const spotForGrid = hasSpot ? spotOre : t.retailOre - t.surchargeOre;
  const transfer = at >= GRID_SPOT_FROM ? GRID_2027.energyOre + (GRID_2027.energySpotPct / 100) * Math.max(0, spotForGrid) : t.transferOre;
  return { retail, transfer, tax: t.energyTaxOre, total: retail + transfer + t.energyTaxOre };
}

// One entry per measured hour: the meter's kW, the chargers' estimated kW
// (never more than the meter measured), everything else, the limit in force
// and how much room that limit left for the chargers. Under a facility
// ceiling the room is the ceiling minus everything else; under a charger cap
// it is the cap. `spot`: hourlySpot()'s result; each row carries the hour's
// consumption-weighted spotOre and its plain mean spotPlainOre (null without
// a price).
export function splitHours(meter, chargerProfile, range = null, capOptions = {}, spot = null) {
  const rows = [];
  for (const [at, meterKw] of meter) {
    if (range && (at < range.from || at >= range.to)) continue;
    const estimated = chargerProfile?.get(at)?.kw || 0;
    const limit = limitAt(at, capOptions);
    let chargerKw = Math.min(estimated, meterKw);
    // Under a whole-facility ceiling the load balancing only gives the chargers
    // the room the rest of the club leaves, so they cannot have drawn more
    // than ceiling − everything else (none at all when the rest was above it).
    if (limit?.kind === 'facility') chargerKw = Math.min(chargerKw, Math.max(0, limit.kw - (meterKw - chargerKw)));
    const otherKw = meterKw - chargerKw;
    const roomKw = !limit ? null : limit.kind === 'facility' ? Math.max(0, limit.kw - otherKw) : limit.kw;
    rows.push({ at, meterKw, chargerKw, otherKw, limitKw: limit?.kw ?? null, limitKind: limit?.kind ?? null, roomKw, overEstimate: estimated > chargerKw + 0.05, spotOre: spot?.weighted.get(at) ?? null, spotPlainOre: spot?.plain.get(at) ?? null });
  }
  return rows;
}

// One row per day: the day's highest metered hour and what the chargers drew in it.
export function dailyPeaks(rows) {
  const days = new Map();
  for (const r of rows) {
    const d = new Date(r.at);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    const day = days.get(key);
    if (!day) days.set(key, { day: key, kwh: r.meterKw, chargerKwh: r.chargerKw, peak: r });
    else {
      day.kwh += r.meterKw;
      day.chargerKwh += r.chargerKw;
      if (r.meterKw > day.peak.meterKw) day.peak = r;
    }
  }
  return [...days.values()].sort((a, b) => a.day - b.day);
}

const money = (ore, kwh) => (ore * kwh) / 100;

// Per month: energy, the billed peak with and without the chargers, and the
// cost split. "Chargers' share" is what the club would not have paid without
// the chargers: their energy at the per-kWh prices, plus the drop in
// effektavgift if their part of every hour were removed (peak with chargers
// minus peak without them). Revenue is what the chargers took in, incl. VAT.
export function monthlyMeter(rows, { tariff = DEFAULT_TARIFF, revenue = null, range = null, now = Date.now(), capOptions = {} } = {}) {
  const t = { ...DEFAULT_TARIFF, ...tariff };
  const vat = 1 + (t.vatPct || 0) / 100;
  const months = new Map();
  for (const r of rows) {
    const key = monthKey(r.at);
    const m = months.get(key) || { month: key, rows: [] };
    m.rows.push(r);
    months.set(key, m);
  }
  const until = range ? Math.min(range.to, now) : now;
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(({ month, rows: hours }) => {
    const [year, mo] = month.split('-').map(Number);
    const monthStart = new Date(year, mo - 1, 1).getTime();
    const monthEnd = new Date(year, mo, 1).getTime();
    const kwh = hours.reduce((sum, h) => sum + h.meterKw, 0);
    const chargerKwh = hours.reduce((sum, h) => sum + h.chargerKw, 0);
    const peak = billedPeak(hours.map((h) => ({ at: h.at, kw: h.meterKw, row: h })), t.peakCount);
    const peakWithout = billedPeak(hours.map((h) => ({ at: h.at, kw: h.otherKw })), t.peakCount);
    const atPeak = peak.hours.map((h) => h.row);
    const chargersAtPeakKw = atPeak.length ? atPeak.reduce((sum, h) => sum + h.chargerKw, 0) / atPeak.length : 0;

    // Energy priced hour by hour at the quarter-hour spot prices (weighted by
    // the quarters' measured kWh) where known, the flat tariff elsewhere.
    let energy = 0;
    let transfer = 0;
    let chargerEnergyCost = 0;
    let spotKwh = 0;
    let spotPaid = 0;
    let spotPlain = 0;
    let spotHours = 0;
    for (const h of hours) {
      const p = hourPrices(h.at, h.spotOre, t);
      energy += money(p.retail, h.meterKw);
      transfer += money(p.transfer, h.meterKw);
      chargerEnergyCost += money(p.total, h.chargerKw);
      if (h.spotOre !== null && h.spotOre !== undefined) {
        spotKwh += h.meterKw;
        spotPaid += h.spotOre * h.meterKw;
        spotPlain += h.spotPlainOre ?? h.spotOre;
        spotHours += 1;
      }
    }
    const energyTax = money(t.energyTaxOre, kwh);
    const effect = peak.kw * t.krPerKw;
    const fixed = t.fixedKr;
    const exVat = energy + transfer + energyTax + effect + fixed;
    // Spot the club paid (consumption-weighted, öre/kWh) against the month's
    // plain average: the gap × kWh is what the timing of its use cost (+) or
    // saved (−) on the contract, excl. VAT.
    const spot = spotHours ? {
      hours: spotHours,
      paidOre: spotKwh > 0 ? spotPaid / spotKwh : null,
      averageOre: spotPlain / spotHours,
      timingKr: spotKwh > 0 ? ((spotPaid / spotKwh - spotPlain / spotHours) * spotKwh) / 100 : 0,
    } : null;
    const chargerEffectCost = Math.max(0, peak.kw - peakWithout.kw) * t.krPerKw;
    const chargerCostInclVat = (chargerEnergyCost + chargerEffectCost) * vat;
    const monthRevenue = revenue?.get(month) || 0;
    const limit = limitAt(atPeak[0]?.at ?? monthStart, capOptions); // in force at the peak hour
    return {
      month,
      hours: hours.length,
      partial: (range ? monthStart < range.from : false) || monthEnd > until || hours.length < ((monthEnd - monthStart) / HOUR_MS) - 2,
      winter: isWinter(monthStart + 15 * 86_400_000), // by the middle of the month
      limit,
      limits: limitsBetween(monthStart, monthEnd, capOptions),
      capKw: limit?.kw ?? null,
      overLimitHours: hours.filter((h) => h.limitKind === 'facility' && h.meterKw > h.limitKw + 0.5).length,
      fuseKw: MAIN_FUSE_KW,
      kwh,
      chargerKwh,
      peakKw: peak.kw,
      peakAt: atPeak[0]?.at ?? null,
      peakHours: atPeak.map((h) => ({ at: h.at, meterKw: h.meterKw, chargerKw: h.chargerKw })),
      chargersAtPeakKw,
      otherAtPeakKw: peak.kw - chargersAtPeakKw,
      peakWithoutChargersKw: peakWithout.kw,
      cost: { energy, transfer, energyTax, effect, fixed, exVat, vat: exVat * (vat - 1), inclVat: exVat * vat },
      spot,
      chargers: {
        energyCost: chargerEnergyCost,
        effectCost: chargerEffectCost,
        costInclVat: chargerCostInclVat,
        revenue: monthRevenue,
        net: monthRevenue - chargerCostInclVat,
      },
    };
  });
}

// The cars' charging power, measured by the facility meter: when a car plugs
// in on its own, the hourly average steps up by its charging power. The step
// is taken from the hour before plug-in to the first full hour after, minus
// the club's usual change between those clock hours (same month, days without
// charging), so the morning rise in the clubhouse is not counted. Only
// sessions that stayed plugged in through that hour, had energy for it at
// minRateKw, and did not overlap another session are used.
export function rateFromMeter(meter, records, { minRateKw = 7.4 } = {}) {
  const busy = new Set();
  const sessions = records.filter((r) => Number(r.energy_kwh) > 0 && r.start && r.end);
  for (const r of sessions) {
    for (let t = Math.floor(Date.parse(r.start) / HOUR_MS) * HOUR_MS - HOUR_MS; t <= Date.parse(r.end) + HOUR_MS; t += HOUR_MS) busy.add(t);
  }
  const usual = new Map();
  for (const t of meter.keys()) {
    if (busy.has(t) || busy.has(t - HOUR_MS) || busy.has(t + HOUR_MS)) continue;
    const before = meter.get(t - HOUR_MS);
    const after = meter.get(t + HOUR_MS);
    if (before === undefined || after === undefined) continue;
    const d = new Date(t);
    const key = `${d.getMonth()}-${d.getHours()}`;
    (usual.get(key) || usual.set(key, []).get(key)).push(after - before);
  }
  const med = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : null;
  };
  const steps = [];
  for (const r of sessions) {
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    const hour = Math.floor(start / HOUR_MS) * HOUR_MS;
    const before = hour - HOUR_MS;
    const after = hour + HOUR_MS;
    if (end < after + HOUR_MS) continue;
    if (r.energy_kwh < minRateKw * ((after + HOUR_MS - start) / HOUR_MS) * 0.9) continue;
    if (sessions.some((o) => o !== r && Date.parse(o.start) < after + HOUR_MS && Date.parse(o.end) > before)) continue;
    const mb = meter.get(before);
    const ma = meter.get(after);
    const u = med(usual.get(`${new Date(hour).getMonth()}-${new Date(hour).getHours()}`) || []);
    if (mb === undefined || ma === undefined || u === null) continue;
    steps.push(ma - mb - u);
  }
  if (steps.length < 30) return null;
  steps.sort((a, b) => a - b);
  const q = (p) => steps[Math.floor(p * (steps.length - 1))];
  return { kw: q(0.5), low: q(0.25), high: q(0.75), n: steps.length, source: 'meter' };
}

// A typical day: per clock hour, the average and 95th percentile of the rest
// of the club (measured − chargers) and the chargers' average, over the rows
// that pass `keep` (e.g. one season).
export function typicalDay(rows, keep = () => true) {
  const hours = Array.from({ length: 24 }, () => ({ other: [], chargers: 0, n: 0 }));
  for (const r of rows) {
    if (!keep(r)) continue;
    const h = hours[new Date(r.at).getHours()];
    h.other.push(r.otherKw);
    h.chargers += r.chargerKw;
    h.n += 1;
  }
  return hours.map((h, hour) => {
    const sorted = [...h.other].sort((a, b) => a - b);
    return {
      hour,
      n: h.n,
      otherAvg: h.n ? sorted.reduce((s, v) => s + v, 0) / h.n : 0,
      otherP95: h.n ? sorted[Math.floor(0.95 * (h.n - 1))] : 0,
      chargersAvg: h.n ? h.chargers / h.n : 0,
    };
  });
}

// The `count` highest hours of every complete month (each on a different day,
// as billedPeak picks them), with the chargers' estimated part of each.
export function monthlyTopHours(rows, count = 3) {
  const months = new Map();
  for (const r of rows) {
    const key = monthKey(r.at);
    (months.get(key) || months.set(key, []).get(key)).push(r);
  }
  const out = [];
  for (const [month, hs] of [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [y, m] = month.split('-').map(Number);
    const complete = hs.length >= ((new Date(y, m, 1) - new Date(y, m - 1, 1)) / HOUR_MS) - 24;
    const top = billedPeak(hs.map((h) => ({ at: h.at, kw: h.meterKw, row: h })), count).hours;
    top.forEach((t, rank) => out.push({ month, rank: rank + 1, complete, ...t.row }));
  }
  return out;
}

export function summarize(rows, months) {
  const top = rows.reduce((best, r) => (!best || r.meterKw > best.meterKw ? r : best), null);
  const kwh = rows.reduce((sum, r) => sum + r.meterKw, 0);
  const chargerKwh = rows.reduce((sum, r) => sum + r.chargerKw, 0);
  return {
    hours: rows.length,
    kwh,
    chargerKwh,
    chargerShare: kwh > 0 ? chargerKwh / kwh : 0,
    top,
    costInclVat: months.reduce((sum, m) => sum + m.cost.inclVat, 0),
    chargerCostInclVat: months.reduce((sum, m) => sum + m.chargers.costInclVat, 0),
    revenue: months.reduce((sum, m) => sum + m.chargers.revenue, 0),
    overEstimateHours: rows.filter((r) => r.overEstimate).length,
  };
}

// Typical loads by season, for the explainer: the average of the monthly
// billed peaks split into chargers and everything else.
export function seasonalPicture(months) {
  const pick = (winter) => {
    const ms = months.filter((m) => m.winter === winter && !m.partial);
    if (!ms.length) return null;
    const avg = (f) => ms.reduce((sum, m) => sum + f(m), 0) / ms.length;
    return { months: ms.length, peakKw: avg((m) => m.peakKw), otherKw: avg((m) => m.otherAtPeakKw), chargerKw: avg((m) => m.chargersAtPeakKw) };
  };
  return { winter: pick(true), summer: pick(false) };
}
