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

const MINUTE_MS = 60_000;

// What one kWh and one month cost. Every default is a placeholder to be
// replaced with the numbers on the club's own invoices (grid: E.ON Elnät;
// energy: the electricity retailer). Öre and kr are excl. VAT.
export const DEFAULT_TARIFF = {
  retailOre: 100, // elhandel: spot price + retailer's surcharge, average
  transferOre: 20, // E.ON Elnät överföringsavgift
  energyTaxOre: 36, // energiskatt (set by the state; check the invoice)
  fixedKr: 600, // E.ON Elnät fast abonnemangsavgift per month
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

// One entry per measured hour: the meter's kW, the chargers' estimated kW
// (never more than the meter measured), everything else, the limit in force
// and how much room that limit left for the chargers. Under a facility
// ceiling the room is the ceiling minus everything else; under a charger cap
// it is the cap.
export function splitHours(meter, chargerProfile, range = null, capOptions = {}) {
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
    rows.push({ at, meterKw, chargerKw, otherKw, limitKw: limit?.kw ?? null, limitKind: limit?.kind ?? null, roomKw, overEstimate: estimated > chargerKw + 0.05 });
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
  const perKwhOre = t.retailOre + t.transferOre + t.energyTaxOre;
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

    const energy = money(t.retailOre, kwh);
    const transfer = money(t.transferOre, kwh);
    const energyTax = money(t.energyTaxOre, kwh);
    const effect = peak.kw * t.krPerKw;
    const fixed = t.fixedKr;
    const exVat = energy + transfer + energyTax + effect + fixed;
    const chargerEnergyCost = money(perKwhOre, chargerKwh);
    const chargerEffectCost = Math.max(0, peak.kw - peakWithout.kw) * t.krPerKw;
    const chargerCostInclVat = (chargerEnergyCost + chargerEffectCost) * vat;
    const monthRevenue = revenue?.get(month) || 0;
    const limit = limitAt(atPeak[0]?.at ?? monthStart, capOptions); // in force at the peak hour
    return {
      month,
      hours: hours.length,
      partial: (range ? monthStart < range.from : false) || monthEnd > until || hours.length < ((monthEnd - monthStart) / HOUR_MS) - 2,
      winter: isWinter(monthStart, capOptions.winterMonths),
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
