// SE4 day-ahead spot prices per quarter hour, for pricing the club's measured
// quarter-hour consumption. Source: elprisetjustnu.se's free API (Nord Pool
// day-ahead prices, öre excl. VAT, fees and surcharges). Since 1 Oct 2025 the
// day-ahead market sets one price per quarter hour; before that one per hour,
// which is stored as four equal quarters so the series has one shape.
//
// The series is kept in the snapshot and extended run by run: past prices
// never change, so only the last days and tomorrow (published about 13:00)
// are asked for. A failure never fails the build: the previous series is kept.
import { compactSeries, expandSeries, stockholmParts, stockholmMidnight } from './eon.js';

export const SPOT_SOURCE = 'elprisetjustnu.se (Nord Pool day-ahead)';
export const SPOT_AREA = 'SE4';
const QUARTER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const REFETCH_DAYS = 2; // re-ask this far back, in case a day was fetched before it was complete
const CONCURRENCY = 6;

const pad = (n) => String(n).padStart(2, '0');

export function dayUrl(dayStartMs, area = SPOT_AREA) {
  const p = stockholmParts(dayStartMs + 3_600_000); // any instant inside the Swedish day
  return `https://www.elprisetjustnu.se/api/v1/prices/${p.y}/${pad(p.mo)}-${pad(p.d)}_${area}.json`;
}

// One day's API answer -> Map(quarter start ms -> öre/kWh). Hourly entries
// become four quarters with the hour's price.
export function dayToQuarters(entries) {
  const out = new Map();
  for (const e of entries || []) {
    const from = Date.parse(e.time_start);
    const to = Date.parse(e.time_end);
    const ore = Number(e.SEK_per_kWh) * 100;
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(ore)) continue;
    for (let t = from; t < to; t += QUARTER_MS) out.set(t, Math.round(ore * 100) / 100);
  }
  return out;
}

// Swedish day starts (UTC ms) from `fromMs`'s day up to and including `toMs`'s day.
export function daysBetween(fromMs, toMs) {
  const days = [];
  for (let d = stockholmMidnight(fromMs); d <= toMs; d = stockholmMidnight(d + DAY_MS + 3_600_000)) days.push(d);
  return days;
}

async function fetchDay(day, fetchImpl) {
  const res = await fetchImpl(dayUrl(day), { headers: { Accept: 'application/json', 'User-Agent': 'emmaboda-gk-ocpi-dashboard (github.com/HuggeK/emmaboda-gk-ocpi-dashboard)' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null; // not published yet
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${dayUrl(day)}`);
  return dayToQuarters(await res.json());
}

// Made-up prices for the demo: dearer mornings and evenings, a midday dip in
// summer, a day-to-day level, and steps between quarters from Oct 2025.
export function createDemoSpot({ historyFrom = '2024-01-01', now = Date.now() } = {}) {
  const prices = new Map();
  const quarterFrom = Date.parse('2025-09-30T22:00:00Z');
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let level = 70;
  const end = stockholmMidnight(now + DAY_MS) + DAY_MS;
  for (let t = Date.parse(`${historyFrom}T00:00:00Z`); t < end; t += QUARTER_MS) {
    const p = stockholmParts(t);
    if (p.h === 0 && p.mi === 0) level = Math.max(15, Math.min(160, level + (rand() - 0.5) * 30));
    const hour = p.h + (t >= quarterFrom ? p.mi / 60 : 0);
    const summer = p.mo >= 4 && p.mo <= 9;
    const shape = 1 + 0.45 * Math.exp(-((hour - 8) ** 2) / 3) + 0.55 * Math.exp(-((hour - 18.5) ** 2) / 4)
      - (summer ? 0.5 * Math.exp(-((hour - 13) ** 2) / 6) : 0) - 0.25 * Math.exp(-((hour - 3) ** 2) / 4);
    prices.set(t, Math.round(level * shape * 100) / 100);
  }
  return { area: SPOT_AREA, source: 'demo', unit: 'öre/kWh excl. VAT', quarter_from: '2025-10-01', ...compactSeries(prices, 15), last_value_end: new Date(end).toISOString() };
}

// Builds the snapshot's spot series. `base`: the previous snapshot's `spot`.
// `historyFrom`: first day wanted (the meter history's start).
export async function buildSpotData({ base = null, historyFrom = '2024-01-01', now = Date.now(), fetchImpl = fetch, log = () => {} } = {}) {
  const prices = base?.area === SPOT_AREA ? expandSeries(base) : new Map();
  const lastKnown = prices.size ? Math.max(...prices.keys()) : null;
  const wantedFrom = Date.parse(`${historyFrom}T00:00:00Z`);
  const firstKnown = prices.size ? Math.min(...prices.keys()) : null;
  const from = lastKnown === null || firstKnown > wantedFrom + DAY_MS ? wantedFrom : lastKnown - REFETCH_DAYS * DAY_MS;
  const days = daysBetween(from, now + DAY_MS); // through tomorrow
  let fetched = 0;
  let missing = 0;
  const errors = [];
  for (let i = 0; i < days.length; i += CONCURRENCY) {
    const batch = days.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((d) => fetchDay(d, fetchImpl)));
    results.forEach((r, k) => {
      if (r.status === 'rejected') errors.push(r.reason?.message || String(r.reason));
      else if (!r.value) missing += 1;
      else {
        for (const [t, ore] of r.value) prices.set(t, ore);
        fetched += 1;
      }
      if (r.status === 'fulfilled' && r.value) log(`spot ${new Date(batch[k]).toISOString().slice(0, 10)}: ${r.value.size} quarters`);
    });
  }
  if (!prices.size) throw new Error(errors[0] || 'no spot prices published');
  const series = compactSeries(prices, 15);
  // compactSeries keeps three decimals for kWh; öre needs two, which is shorter.
  series.values = series.values.map((v) => (v === null ? null : Math.round(v * 100) / 100));
  const last = Math.max(...prices.keys()) + QUARTER_MS;
  return {
    area: SPOT_AREA,
    source: SPOT_SOURCE,
    unit: 'öre/kWh excl. VAT',
    quarter_from: '2025-10-01', // one price per quarter from here; before, hourly prices repeated four times
    ...series,
    last_value_end: new Date(last).toISOString(),
    fetch: { days: days.length, fetched, not_published: missing, errors: errors.slice(0, 5) },
  };
}
