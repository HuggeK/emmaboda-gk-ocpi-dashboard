// Economics of the chargers for the Economics tab: what they earn, what they
// cost (electricity, the effektavgift they add, ChargeNode, this system) and
// what price per kWh covers it. Pure functions shared by the browser and tests.
//
// All amounts are kr excl. VAT unless a name says otherwise. The club charges
// a fixed price incl. VAT (5 kr/kWh); 1 kr of it is VAT that goes to the state.
import { billedPeak, monthKey, limitAt, limitsBetween, isWinter } from './analysis.js';

// What running the chargers and this dashboard costs besides the electricity.
export const DEFAULT_COSTS = {
  chargeNodePerPointMonth: 60, // kr per outlet (uttag) per month, ChargeNode's fee to the club
  chargeNodeSharePct: 0, // % of the charging revenue excl. VAT
  chargeNodeOrePerKwh: 0, // öre per kWh charged
  eonMeterKrMonth: 19, // E.ON Energidata, mätvärden (bought)
  eonCostsKrMonth: 0, // E.ON Energidata, kostnadsuppdelning (49 kr/month if bought)
  otherKrYear: 0, // anything else; GitHub Actions and Pages are free within the plan
  systemSince: '2026-11', // first month the E.ON subscriptions and other system costs were paid
  targetMarginOre: 0, // margin wanted on top of all costs, for the price suggestion
};

// Public AC charging prices in Sweden, 2026, incl. VAT: Mer's plans averaged
// 3.75–4.98 kr, Recharge and OKQ8 without subscription 5.49 kr (see the README).
export const MARKET_BAND = { low: 3.75, high: 5.49 };

const sum = (items, f) => items.reduce((total, x) => total + (f(x) || 0), 0);

export function revenueExVat(record) {
  if (record.cost_excl_vat !== null && record.cost_excl_vat !== undefined) return Number(record.cost_excl_vat) || 0;
  return (Number(record.cost_incl_vat) || 0) / 1.25;
}

// monthKey -> number of calendar months in [from, to) (partial months count).
export function monthsIn(from, to) {
  const keys = [];
  const d = new Date(from);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() < to) {
    keys.push(monthKey(d.getTime()));
    d.setMonth(d.getMonth() + 1);
  }
  return keys;
}

// One period's account. chargerMonths: monthlyPeaks() of the chargers alone
// (the worst case: their own peak lands on top of the club's peak every
// month). meterMonths: monthlyMeter() rows, which measure what the chargers
// actually added; months without meter values fall back to the range.
export function account({ records, period, tariff, costs = DEFAULT_COSTS, points = 6, chargerMonths = [], meterMonths = [] }) {
  const c = { ...DEFAULT_COSTS, ...costs };
  const inPeriod = records.filter((r) => {
    const t = Date.parse(r.start || r.end || '');
    return t >= period.from && t < period.to;
  });
  const months = monthsIn(period.from, period.to);
  const monthSet = new Set(months);
  const kwh = sum(inPeriod, (r) => Number(r.energy_kwh));
  const revenueInclVat = sum(inPeriod, (r) => Number(r.cost_incl_vat ?? (r.cost_excl_vat ?? 0) * 1.25));
  const revenue = sum(inPeriod, revenueExVat);
  const energyCost = (kwh * (tariff.retailOre + tariff.transferOre + tariff.energyTaxOre)) / 100;
  const chargeNode = c.chargeNodePerPointMonth * points * months.length + (revenue * c.chargeNodeSharePct) / 100 + (kwh * c.chargeNodeOrePerKwh) / 100;
  const paidMonths = months.filter((k) => !c.systemSince || k >= c.systemSince).length;
  const system = (c.eonMeterKrMonth + c.eonCostsKrMonth) * paidMonths + (c.otherKrYear * paidMonths) / 12;

  const worstByMonth = new Map(chargerMonths.filter((m) => monthSet.has(m.month)).map((m) => [m.month, m.peakKw * tariff.krPerKw]));
  const measuredByMonth = new Map(meterMonths.filter((m) => monthSet.has(m.month)).map((m) => [m.month, m.chargers.effectCost]));
  const worst = sum([...worstByMonth.values()], (v) => v);
  // Measured where E.ON has values, the worst case elsewhere.
  const expected = sum(months, (k) => (measuredByMonth.has(k) ? measuredByMonth.get(k) : worstByMonth.get(k) || 0));
  const effekt = { none: 0, measured: measuredByMonth.size ? sum([...measuredByMonth.values()], (v) => v) : null, measuredMonths: measuredByMonth.size, expected, worst };

  const fixedCosts = energyCost + chargeNode + system;
  const net = { none: revenue - fixedCosts, expected: revenue - fixedCosts - expected, worst: revenue - fixedCosts - worst };
  // Break-even price per kWh incl. VAT for each effektavgift assumption.
  const perKwh = (extra) => (kwh > 0 ? ((fixedCosts + extra + (kwh * c.targetMarginOre) / 100) / kwh) * 1.25 : null);
  const breakEven = { none: perKwh(0), expected: perKwh(expected), worst: perKwh(worst) };
  // How much effektavgift the current revenue can absorb before the chargers lose money.
  const effektRoom = revenue - fixedCosts - (kwh * c.targetMarginOre) / 100;
  const avgPrice = kwh > 0 ? revenueInclVat / kwh : null;
  return {
    sessions: inPeriod.filter((r) => Number(r.energy_kwh) > 0).length,
    months: months.length,
    kwh,
    revenueInclVat,
    revenue,
    avgPrice,
    energyCost,
    chargeNode,
    system,
    effekt,
    net,
    breakEven,
    effektRoom,
    effektRoomKwMonths: tariff.krPerKw > 0 ? effektRoom / tariff.krPerKw : null,
  };
}

// What lowering the limits saved, per month with meter values: the
// effektavgift the chargers would have added without any limit (their
// unlimited estimate on top of the measured rest of the club) minus what
// they added under the limit in force. rows: splitHours() rows (with the
// limit applied); unlimited: hourlyProfile() with limits 'none'.
export function limitSavings(rows, unlimited, { krPerKw }) {
  const months = new Map();
  for (const r of rows) {
    const key = monthKey(r.at);
    const m = months.get(key) || [];
    m.push(r);
    months.set(key, m);
  }
  return [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, hours]) => {
    const without = billedPeak(hours.map((h) => ({ at: h.at, kw: h.otherKw })), 1).kw;
    const actual = billedPeak(hours.map((h) => ({ at: h.at, kw: h.meterKw })), 1).kw;
    const unlimitedPeak = billedPeak(hours.map((h) => ({ at: h.at, kw: h.otherKw + (unlimited.get(h.at)?.rawKw || 0) })), 1).kw;
    const [year, mo] = month.split('-').map(Number);
    const limit = limitAt(hours[0].at);
    const limits = limitsBetween(new Date(year, mo - 1, 1).getTime(), new Date(year, mo, 1).getTime());
    return {
      month,
      limit,
      limits,
      actualKw: actual,
      withoutChargersKw: without,
      unlimitedKw: unlimitedPeak,
      addedKr: Math.max(0, actual - without) * krPerKw,
      unlimitedAddedKr: Math.max(0, unlimitedPeak - without) * krPerKw,
      savedKr: Math.max(0, unlimitedPeak - actual) * krPerKw,
    };
  });
}

// Is the winter ceiling worth the yearly e-mail? For each winter with meter
// values (26 Oct – 28 Feb), with the chargers' unlimited estimate on top of
// the measured rest of the club: the effektavgift they would add without a
// ceiling, what they add with one at ceilingKw (they only get ceiling − the
// rest), and the charging the ceiling holds back. Held-back energy is often
// only delayed (cars stay plugged in for hours), so its margin is an upper
// bound on what the ceiling costs. rows: splitHours() rows; unlimited:
// hourlyProfile() with limits 'none'.
export function winterCeilingCheck(rows, unlimited, { ceilingKw, krPerKw, marginPerKwh, now = Date.now() }) {
  const winters = new Map();
  for (const r of rows) {
    if (!isWinter(r.at)) continue;
    const d = new Date(r.at);
    const startYear = d.getMonth() >= 9 ? d.getFullYear() : d.getFullYear() - 1; // Oct–Dec start it, Jan–Feb belong to it
    const w = winters.get(startYear) || new Map();
    const key = monthKey(r.at);
    (w.get(key) || w.set(key, []).get(key)).push(r);
    winters.set(startYear, w);
  }
  return [...winters.entries()].sort((a, b) => a[0] - b[0]).map(([year, months]) => {
    let without = 0;
    let withCeiling = 0;
    let charged = 0;
    let held = 0;
    let hours = 0;
    for (const hs of months.values()) {
      const demand = (h) => unlimited.get(h.at)?.rawKw || 0;
      const allowed = (h) => Math.min(demand(h), Math.max(0, ceilingKw - h.otherKw));
      const rest = Math.max(...hs.map((h) => h.otherKw));
      without += Math.max(0, Math.max(...hs.map((h) => h.otherKw + demand(h))) - rest) * krPerKw;
      withCeiling += Math.max(0, Math.max(...hs.map((h) => h.otherKw + allowed(h))) - rest) * krPerKw;
      for (const h of hs) {
        charged += demand(h);
        held += demand(h) - allowed(h);
      }
      hours += hs.length;
    }
    const saved = without - withCeiling;
    const lostMargin = held * marginPerKwh;
    return {
      winter: `${year}/${String(year + 1).slice(2)}`,
      complete: new Date(year + 1, 2, 1).getTime() <= now && hours > 2800,
      chargedKwh: charged,
      heldKwh: held,
      addedWithoutKr: without,
      addedWithKr: withCeiling,
      savedKr: saved,
      lostMarginKr: lostMargin,
      netKr: saved - lostMargin,
    };
  });
}

// What switching the chargers off for part of the night would have saved: per
// month, the effektavgift their night-time charging added (the peak with it
// minus the peak with the chargers at zero in those hours), against the
// margin on the charging energy that would be lost. rows: splitHours() rows.
export function nightOffCheck(rows, { from, to, krPerKw, marginPerKwh }) {
  const night = (t) => {
    const h = new Date(t).getHours();
    return from > to ? h >= from || h < to : h >= from && h < to;
  };
  const months = new Map();
  for (const r of rows) {
    const key = monthKey(r.at);
    (months.get(key) || months.set(key, []).get(key)).push(r);
  }
  let savedKr = 0;
  let nightKwh = 0;
  let totalKwh = 0;
  const savingMonths = [];
  for (const [month, hs] of months) {
    const now = Math.max(...hs.map((h) => h.meterKw));
    const off = Math.max(...hs.map((h) => (night(h.at) ? h.otherKw : h.meterKw)));
    const saved = Math.max(0, now - off) * krPerKw;
    savedKr += saved;
    if (saved > 0) savingMonths.push({ month, savedKr: saved });
    for (const h of hs) {
      totalKwh += h.chargerKw;
      if (night(h.at)) nightKwh += h.chargerKw;
    }
  }
  const years = months.size / 12;
  const lostMarginKr = nightKwh * marginPerKwh;
  return {
    from,
    to,
    months: months.size,
    savedKr,
    savedPerYear: years ? savedKr / years : 0,
    nightKwh,
    totalKwh,
    nightShare: totalKwh ? nightKwh / totalKwh : 0,
    lostMarginKr,
    lostPerYear: years ? lostMarginKr / years : 0,
    netPerYear: years ? (savedKr - lostMarginKr) / years : 0,
    savingMonths,
  };
}

// A plain verdict on the price, from the account of the last 12 months.
export function priceAdvice(acc, { currentPrice = 5, market = MARKET_BAND, krPerKw = 120 } = {}) {
  const be = acc.effekt.measured !== null && acc.effekt.measuredMonths >= Math.min(6, acc.months) ? acc.breakEven.expected : null;
  const covers = (price, breakEven) => breakEven !== null && price >= breakEven;
  let verdict;
  if (be !== null) {
    verdict = covers(currentPrice, be)
      ? { level: 'ok', text: `${currentPrice} kr/kWh covers every cost, including the effektavgift the chargers were measured to add (break-even ${be.toFixed(2)} kr).` }
      : { level: 'bad', text: `${currentPrice} kr/kWh does not cover the costs including the measured effektavgift (break-even ${be.toFixed(2)} kr). Lower the chargers’ share of the peaks before raising the price: above ${market.high.toFixed(2)} kr the club is dearer than the public networks.` };
  } else if (covers(currentPrice, acc.breakEven.worst)) {
    verdict = { level: 'ok', text: `${currentPrice} kr/kWh covers every cost even in the worst case for the effektavgift.` };
  } else if (covers(currentPrice, acc.breakEven.none)) {
    verdict = {
      level: 'warn',
      text: `${currentPrice} kr/kWh covers electricity, ChargeNode and this system with about ${Math.round(acc.effektRoom).toLocaleString()} kr a year to spare for the effektavgift the chargers add: at ${krPerKw} kr/kW that is about ${Math.round(acc.effektRoom / krPerKw / 8)} kW added to the club’s peak in each month of an 8-month season. In the worst case, where the chargers’ own peak lands on top of the club’s every month, it would take ${acc.breakEven.worst.toFixed(2)} kr. The E.ON meter values will show which side of that the club is on.`,
    };
  } else {
    verdict = { level: 'bad', text: `${currentPrice} kr/kWh does not even cover the electricity and fixed costs (break-even ${acc.breakEven.none.toFixed(2)} kr).` };
  }
  const inMarket = currentPrice >= market.low && currentPrice <= market.high;
  return { ...verdict, market: inMarket ? `Within the public range of ${market.low.toFixed(2)}–${market.high.toFixed(2)} kr/kWh.` : currentPrice > market.high ? `Above the public range (${market.low.toFixed(2)}–${market.high.toFixed(2)} kr/kWh).` : `Below the public range (${market.low.toFixed(2)}–${market.high.toFixed(2)} kr/kWh).` };
}
