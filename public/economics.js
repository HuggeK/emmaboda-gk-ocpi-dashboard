// Economics of the chargers for the Economics tab: what they earn, what they
// cost (electricity, the effektavgift they add, ChargeNode, this system) and
// what price per kWh covers it. Pure functions shared by the browser and tests.
//
// All amounts are kr excl. VAT unless a name says otherwise. The club charges
// a fixed price incl. VAT (5 kr/kWh); 1 kr of it is VAT that goes to the state.
import { billedPeak, monthKey, limitAt } from './analysis.js';

// What running the chargers and this dashboard costs besides the electricity.
// ChargeNode does not publish its fee to site owners: copy it from the contract.
export const DEFAULT_COSTS = {
  chargeNodePerPointMonth: 0, // kr per charging point per month
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
    const limit = limitAt(hours[0].at);
    return {
      month,
      limit,
      actualKw: actual,
      withoutChargersKw: without,
      unlimitedKw: unlimitedPeak,
      addedKr: Math.max(0, actual - without) * krPerKw,
      unlimitedAddedKr: Math.max(0, unlimitedPeak - without) * krPerKw,
      savedKr: Math.max(0, unlimitedPeak - actual) * krPerKw,
    };
  });
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
