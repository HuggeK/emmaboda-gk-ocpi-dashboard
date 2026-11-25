// What we know about the club's loads, for explaining when the peaks happen.
// Only the facility total is measured (E.ON's meter) and the EV chargers are
// estimated from their charge records; everything else here is inferred from
// the time of day and season, using the club's energy analysis
// ("Emmaboda GK energianalys", version 1.31, July 2026). Edit this file when a
// load is added, removed or measured.
//
// hours: [from, to) in local clock hours, wrapping past midnight when from > to.
// season: 'season' (1 Mar – 25 Oct), 'winter' (26 Oct – 28 Feb) or 'all'.
// confidence: 'measured', 'estimated', 'likely' (timing and size match the
// analysis) or 'possible' (fits the timing, but other loads could too).
export const FACILITY_LOADS = [
  {
    key: 'chargers',
    label: 'EV chargers',
    detail: '6 outlets via ChargeNode; their part of each hour is estimated from the charge records',
    hours: null,
    season: 'all',
    kw: null,
    confidence: 'estimated',
  },
  {
    key: 'irrigation',
    label: 'Irrigation pumps',
    detail: 'night watering, greens first from about 22:30, usually done by 03; a step of about 19 kW (probably two pumps, about 11 and 19–25 kW)',
    hours: [22, 3],
    season: 'season',
    kw: 19,
    confidence: 'likely',
  },
  {
    key: 'daytime',
    label: 'Clubhouse, restaurant and golf carts',
    detail: 'kitchen, cold rooms and freezers (the restaurant’s big freezer is switched off in winter), the shop, camping (25 pitches, laundry) and charging the golf carts (several kW together, on their own circuit, so not in ChargeNode’s data), mainly 09–15',
    hours: [9, 15],
    season: 'season',
    kw: null,
    confidence: 'possible',
  },
  {
    key: 'heating',
    label: 'Electric heating',
    detail: 'direct electric heating and heat pumps in the clubhouse, restaurant, old office, studio and cabins; in winter a daytime plateau of about 33–39 kW in total, 09–14',
    hours: [9, 14],
    season: 'winter',
    kw: null,
    confidence: 'likely',
  },
  {
    key: 'base',
    label: 'Base load',
    detail: 'what never switches off: heating, refrigeration, the pond’s UV pump and frost protection; median about 15.6 kW',
    hours: null,
    season: 'all',
    kw: 15.6,
    confidence: 'measured',
  },
];

export const BASE_LOAD_KW = 15.6;

export const inHours = (hour, [from, to]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to);

// The most likely explanation of one peak hour, from its time, season and the
// chargers' estimated part. Returns the loads that fit, strongest first, each
// with a confidence, and the kW above the base load the others must explain.
export function explainPeak(peak, { isWinter }) {
  const d = new Date(peak.at);
  const hour = d.getHours();
  const winter = isWinter(peak.at);
  const causes = [];
  const above = Math.max(0, peak.meterKw - BASE_LOAD_KW);
  if (peak.chargerKw >= 1) {
    causes.push({ key: 'chargers', kw: peak.chargerKw, share: above > 0 ? Math.min(1, peak.chargerKw / above) : 0, confidence: 'estimated' });
  }
  for (const load of FACILITY_LOADS) {
    if (!load.hours || load.key === 'chargers') continue;
    const seasonOk = load.season === 'all' || (load.season === 'winter') === winter;
    if (seasonOk && inHours(hour, load.hours)) causes.push({ key: load.key, kw: load.kw, confidence: load.confidence });
  }
  // A winter hour outside the heating plateau, or a season hour outside both
  // known windows, has no clear explanation from the analysis.
  if (!causes.some((c) => c.key !== 'chargers')) causes.push({ key: 'unexplained', kw: null, confidence: 'unknown' });
  return { hour, winter, aboveBaseKw: above, causes };
}

export const loadLabel = (key) => FACILITY_LOADS.find((l) => l.key === key)?.label || 'No clear match in the energy analysis';
