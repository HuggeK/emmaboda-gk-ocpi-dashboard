// "Right now" for the staff on site: what a kWh costs per quarter hour from
// now on, the cheapest stretch to run heavy loads, this month's peak so far
// (the effektavgift ceiling not to go above) and the room under it hour by
// hour. Also when golfers are on the course (from the charging sessions), to
// weight glare by whether anyone is there to be dazzled. Pure functions.
import { DEFAULT_TARIFF, expandSeries, hourPrices } from './meter.js';
import { pluggedWindow } from './analysis.js';
import { GRID_2027 } from './contracts.js';

const QUARTER_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Swedish local month (0–11), hour (0–23) and date of an instant.
const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
export function swedishParts(t) {
  const p = Object.fromEntries(parts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), hour: Number(p.hour) };
}

// The effektavgift per kW of the month's peak, for the date.
export const krPerKwAt = (t) => (t >= new Date(`${GRID_2027.from}T00:00:00`).getTime() ? GRID_2027.krPerKw : GRID_2027.krPerKw2026);

// Every published quarter from the one containing `now`: spot and the full
// price per kWh excl. VAT (spot + the contract's surcharge and fees + the grid
// energy fee + energy tax), öre.
export function quarterPrices(spot, now, t = DEFAULT_TARIFF) {
  const from = Math.floor(now / QUARTER_MS) * QUARTER_MS;
  const out = [];
  for (const [at, spotOre] of expandSeries(spot)) {
    if (at < from) continue;
    const p = hourPrices(at, spotOre, t);
    out.push({ at, spotOre, retailOre: p.retail - spotOre, transferOre: p.transfer, taxOre: p.tax, totalOre: p.total });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The cheapest run of `hours` consecutive hours in the quarters (mean full price).
export function cheapestWindow(quarters, hours) {
  const n = Math.round(hours * 4);
  if (quarters.length < n) return null;
  let best = null;
  let sum = 0;
  for (let i = 0; i < quarters.length; i += 1) {
    sum += quarters[i].totalOre;
    if (i >= n) sum -= quarters[i - n].totalOre;
    if (i >= n - 1 && quarters[i].at - quarters[i - n + 1].at === (n - 1) * QUARTER_MS) {
      const mean = sum / n;
      if (!best || mean < best.meanOre) best = { start: quarters[i - n + 1].at, end: quarters[i].at + QUARTER_MS, meanOre: mean };
    }
  }
  return best;
}

// Price bands relative to the quarters shown: the cheapest third, the middle
// and the dearest third.
export function priceBands(quarters) {
  const sorted = quarters.map((q) => q.totalOre).sort((a, b) => a - b);
  const at = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  return { low: at(1 / 3), high: at(2 / 3) };
}

// This month's highest hourly mean so far (meterHours: hour start -> kWh),
// which E.ON bills the effektavgift on.
export function monthPeakSoFar(hours, now) {
  const { year, month } = swedishParts(now);
  let best = null;
  for (const [at, kw] of hours) {
    if (at > now) continue;
    const p = swedishParts(at);
    if (p.year !== year || p.month !== month) continue;
    if (!best || kw > best.kw) best = { at, kw };
  }
  return best;
}

// The usual load at each hour of the day over the last `days` days with
// values: the median, and the 90th percentile (a busy day).
export function typicalLoadByHour(hours, now, days = 28) {
  const last = Math.max(...[...hours.keys()].filter((t) => t <= now));
  const from = last - days * DAY_MS;
  const byHour = Array.from({ length: 24 }, () => []);
  for (const [at, kw] of hours) if (at > from && at <= last) byHour[swedishParts(at).hour].push(kw);
  const pick = (arr, f) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(f * s.length))];
  };
  return byHour.map((arr) => ({ median: pick(arr, 0.5), busy: pick(arr, 0.9), days: arr.length }));
}

// When golfers are on the course: cars plugged in at the club's chargers per
// month and hour (Swedish time), scaled so the busiest month-hour is 1. Golfers
// charge while they play, so this follows the tee sheet closely enough to say
// when nobody is out there.
export function presenceByMonthHour(records) {
  const m = Array.from({ length: 12 }, () => new Array(24).fill(0));
  for (const r of records) {
    const w = pluggedWindow(r);
    if (!w || w.end - w.start > 12 * HOUR_MS) continue; // overnight stays say nothing about play
    for (let t = Math.floor(w.start / HOUR_MS) * HOUR_MS; t < w.end; t += HOUR_MS) {
      const overlap = (Math.min(t + HOUR_MS, w.end) - Math.max(t, w.start)) / HOUR_MS;
      if (overlap <= 0) continue;
      const p = swedishParts(t);
      m[p.month][p.hour] += overlap;
    }
  }
  const max = Math.max(...m.flat());
  return max > 0 ? m.map((row) => row.map((v) => v / max)) : null;
}
