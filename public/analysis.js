// Analysis of charge records: simultaneous charging, busy hours and the
// hourly-average peaks that an effektavgift (power tariff) is billed on.
// Pure functions shared by the browser (Analysis tab) and the tests.
//
// ChargeNode reports one energy total per session, not a power curve, so the
// power inside a session is modelled:
//   front: the car charges at rateKw from plug-in until its energy is
//          delivered, then idles (how cars behave; a ceiling before the cap)
//   even:  the energy is spread evenly over the plugged-in time (a floor)
// Hour buckets are whole clock hours, which is what the tariff counts.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// Main fuse of the whole facility and what a current allows at 400 V three-phase.
export const MAIN_FUSE_A = 125;
export const ampsToKw = (amps, volts = 400) => (Math.sqrt(3) * volts * amps) / 1000;
export const MAIN_FUSE_KW = ampsToKw(MAIN_FUSE_A);

// What ChargeNode's load balancing has actually been set to, from their
// e-mails. kind 'chargers': the chargers together may draw at most kw.
// kind 'facility': the whole facility may draw at most kw and the chargers get
// whatever the rest of the club leaves under it (dynamic, meter-based).
export const LIMIT_HISTORY = [
  { from: '2024-06-01', kind: 'chargers', amps: null, kw: 57, label: 'Chargers ≤ about 57 kW', note: 'Setting before July 2026 (approximate)' },
  { from: '2026-07-17', kind: 'chargers', amps: 63, kw: 43.5, label: 'Chargers ≤ 63 A (43.5 kW)', note: 'ChargeNode e-mail of 17 Jul 2026' },
  { from: '2026-11-02', kind: 'facility', amps: 36, kw: ampsToKw(36), label: 'Whole facility ≤ 36 A (≈ 25 kW)', note: 'ChargeNode e-mail of 2 Nov 2026: chargers only use the room left under 25 kW' },
];

// The club's yearly plan after the settings above: ChargeNode is asked on
// 26 October to hold the whole facility under 36 A (≈ 25 kW) for the winter,
// and on 1 March to give the chargers 63 A (43.5 kW) again for the season.
// Dates are month-day, local time.
export const SEASON_PLAN = {
  winterFrom: '10-26',
  seasonFrom: '03-01',
  winter: { kind: 'facility', amps: 36, kw: ampsToKw(36), label: 'Whole facility ≤ 36 A (≈ 25 kW)', note: 'Yearly plan: ChargeNode lowers it on 26 Oct' },
  season: { kind: 'chargers', amps: 63, kw: 43.5, label: 'Chargers ≤ 63 A (43.5 kW)', note: 'Yearly plan: ChargeNode raises it on 1 Mar' },
};

// limits 'actual': the dated settings, then the yearly plan. limits
// 'seasonal' is a what-if on the plan's dates: in season the chargers may
// take capKw, in winter the whole facility is held under winterCapKw.
// peakCount: the month's billed effekt is the average of that many highest
// hours, each on a different day (1 = the single highest).
export const DEFAULT_OPTIONS = {
  model: 'front',
  rateKw: 11,
  limits: 'actual',
  capKw: 43.5,
  winterCapKw: 25,
  krPerKw: 120.8, // E.ON E4N04L 2026: single highest hour, same all year (energy analysis v1.31)
  peakCount: 1,
  chargers: 6,
};

const pad2 = (n) => String(n).padStart(2, '0');

// Local midnight of a "YYYY-MM-DD" date.
export const dayStart = (date) => new Date(`${date}T00:00:00`).getTime();

// Is t in the winter window, 26 Oct up to (not including) 1 Mar?
export function isWinter(t, plan = SEASON_PLAN) {
  const d = new Date(t);
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return md >= plan.winterFrom || md < plan.seasonFrom;
}

// Every dated limit: the confirmed settings, then the plan's switch dates up
// to the end of untilYear. Entries after today are marked planned.
const timelines = new Map();
export function limitTimeline(untilYear = new Date().getFullYear() + 1) {
  if (timelines.has(untilYear)) return timelines.get(untilYear);
  const last = LIMIT_HISTORY.at(-1);
  const out = [...LIMIT_HISTORY];
  for (let year = Number(last.from.slice(0, 4)); year <= untilYear; year += 1) {
    for (const key of ['season', 'winter']) {
      const from = `${year}-${key === 'winter' ? SEASON_PLAN.winterFrom : SEASON_PLAN.seasonFrom}`;
      if (from > last.from) out.push({ from, ...SEASON_PLAN[key], planned: true });
    }
  }
  out.sort((a, b) => a.from.localeCompare(b.from));
  timelines.set(untilYear, out);
  return out;
}

// The limit in force at instant t: { kind, kw, amps, label } or null.
export function limitAt(t, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (o.limits === 'none') return null;
  if (o.limits === 'seasonal') {
    if (isWinter(t) && o.winterCapKw > 0) {
      return { kind: 'facility', kw: o.winterCapKw, amps: null, label: `Whole facility ≤ ${Math.round(o.winterCapKw * 10) / 10} kW (winter)` };
    }
    return o.capKw > 0 ? { kind: 'chargers', kw: o.capKw, amps: null, label: `Chargers ≤ ${Math.round(o.capKw * 10) / 10} kW (season)` } : null;
  }
  let current = null;
  for (const limit of limitTimeline(new Date(t).getFullYear())) {
    if (dayStart(limit.from) > t) break;
    current = limit;
  }
  return current || LIMIT_HISTORY[0];
}

// Every limit in force at some point in [from, to), oldest first; a month in
// which ChargeNode changed the setting lists both.
export function limitsBetween(from, to, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (o.limits === 'none') return [];
  if (o.limits === 'seasonal') {
    const a = limitAt(from, o);
    const b = limitAt(to - 1, o);
    return [a, b].filter((l, i, all) => l && all.findIndex((x) => x?.label === l.label) === i);
  }
  const timeline = limitTimeline(new Date(Math.min(to, 8.64e15) - 1).getFullYear());
  return timeline.filter((l, i) => {
    const start = dayStart(l.from);
    const end = i + 1 < timeline.length ? dayStart(timeline[i + 1].from) : Infinity;
    return start < to && end > from;
  });
}

// The most the chargers can have drawn at t (Infinity when unlimited). Under
// a facility ceiling that is the ceiling itself when nothing else runs; with
// meter data the Meter tab narrows it to ceiling − the rest of the club.
export function capAt(t, options = {}) {
  const limit = limitAt(t, options);
  return limit && limit.kw > 0 ? limit.kw : Infinity;
}

const floorHour = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;

// Monday = 0 ... Sunday = 6
export const mondayIndex = (jsDay) => (jsDay + 6) % 7;

export function monthKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function pluggedWindow(record) {
  const start = Date.parse(record.start || '');
  const end = Date.parse(record.end || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

export function chargingWindow(record, options = {}) {
  const { model = 'front', rateKw = DEFAULT_OPTIONS.rateKw } = options;
  const plugged = pluggedWindow(record);
  if (!plugged) return null;
  const kwh = Number(record.energy_kwh) || 0;
  if (kwh <= 0) return null;
  const pluggedHours = (plugged.end - plugged.start) / HOUR_MS;
  if (model === 'even' || !(rateKw > 0)) return { ...plugged, kw: kwh / pluggedHours };
  // A session shorter than kwh / rateKw simply charged faster than assumed.
  const end = Math.min(plugged.end, plugged.start + (kwh / rateKw) * HOUR_MS);
  return { start: plugged.start, end, kw: kwh / ((end - plugged.start) / HOUR_MS) };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : null;
};

// The cars' charging power, estimated from the charge records: a short
// session with a fair amount of energy must have charged the whole time it
// was plugged in, so its energy / plugged-in time is the rate it charged at.
// ChargeNode's records have one charging period and no charging time, so
// nothing finer is available from OCPI.
export function rateFromRecords(records) {
  const rates = [];
  for (const r of records) {
    const w = pluggedWindow(r);
    const kwh = Number(r.energy_kwh) || 0;
    if (!w || kwh <= 3) continue;
    const hours = (w.end - w.start) / HOUR_MS;
    if (hours >= 0.25 && hours < 1.5) rates.push(kwh / hours);
  }
  return rates.length >= 10 ? { kw: median(rates), n: rates.length, source: 'records' } : null;
}

// Sweep line over intervals -> segments of constant overlap count (count > 0).
export function concurrencySegments(windows) {
  const events = [];
  for (const w of windows) {
    if (!w || !(w.end > w.start)) continue;
    events.push([w.start, 1], [w.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an end before a start at the same instant
  const segments = [];
  let count = 0;
  let since = null;
  for (const [t, delta] of events) {
    if (count > 0 && t > since) segments.push({ start: since, end: t, count });
    count += delta;
    since = t;
  }
  return segments;
}

export function peakConcurrency(segments) {
  let best = null;
  for (const s of segments) if (!best || s.count > best.count) best = s;
  return best ? { count: best.count, start: best.start, end: best.end } : { count: 0, start: null, end: null };
}

// hours[n] = hours during which exactly n sessions overlapped (n > maxCount folds into maxCount).
export function hoursByConcurrency(segments, maxCount = DEFAULT_OPTIONS.chargers) {
  const hours = new Array(maxCount + 1).fill(0);
  for (const s of segments) hours[Math.min(s.count, maxCount)] += (s.end - s.start) / HOUR_MS;
  return hours;
}

// What the session was charged for: the amount incl. VAT when ChargeNode gives
// it, otherwise excl. VAT. This is before any ChargeNode fee.
export const revenueOf = (record) => Number(record.cost_incl_vat ?? record.cost_excl_vat) || 0;

// Map of hour start (ms) -> { kw, rawKw, capKw, sessions, revenue }. kw is the
// average power over that clock hour (kWh delivered in the hour), capped at
// the limit in force that month (capAt). revenue is each session's charged amount, allocated to the
// hours in proportion to the energy delivered in them.
export function hourlyProfile(records, options = {}) {
  const buckets = new Map();
  for (const record of records) {
    const w = chargingWindow(record, options);
    if (!w) continue;
    const kwh = Number(record.energy_kwh) || 0;
    const revenue = revenueOf(record);
    for (let t = floorHour(w.start); t < w.end; t += HOUR_MS) {
      const overlap = Math.min(t + HOUR_MS, w.end) - Math.max(t, w.start);
      if (overlap <= 0) continue;
      const bucket = buckets.get(t) || { kwh: 0, revenue: 0, sessions: new Set() };
      const hourKwh = (w.kw * overlap) / HOUR_MS;
      bucket.kwh += hourKwh;
      bucket.revenue += kwh > 0 ? (revenue * hourKwh) / kwh : 0;
      bucket.sessions.add(record.id ?? record);
      buckets.set(t, bucket);
    }
  }
  const profile = new Map();
  for (const [t, b] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
    const capKw = capAt(t, options);
    profile.set(t, { kw: Math.min(b.kwh, capKw), rawKw: b.kwh, capKw: Number.isFinite(capKw) ? capKw : null, sessions: b.sessions.size, revenue: b.revenue });
  }
  return profile;
}

// Map of month key -> charged amount of the sessions that started in it.
export function revenueByMonth(records) {
  const months = new Map();
  for (const record of records) {
    const start = Date.parse(record.start || '');
    if (!Number.isFinite(start)) continue;
    const key = monthKey(start);
    months.set(key, (months.get(key) || 0) + revenueOf(record));
  }
  return months;
}

// The billed effekt of one month: the average of the peakCount highest hours,
// each taken from a different day. hours: [{ at, kw, ... }].
export function billedPeak(hours, peakCount = 1) {
  const bestPerDay = new Map();
  for (const h of hours) {
    const d = new Date(h.at);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!bestPerDay.has(day) || h.kw > bestPerDay.get(day).kw) bestPerDay.set(day, h);
  }
  const top = [...bestPerDay.values()].sort((a, b) => b.kw - a.kw || a.at - b.at).slice(0, Math.max(1, peakCount));
  const kw = top.length ? top.reduce((sum, h) => sum + h.kw, 0) / top.length : 0;
  return { kw, hours: top };
}

// One row per month: the peak hour(s), what they cost at the tariff, the
// revenue earned in them and in the whole month, and whether the month's
// charging revenue covered the effektavgift. capKw is the charger limit in
// force that month (lower in winter).
export function monthlyPeaks(profile, { krPerKw = DEFAULT_OPTIONS.krPerKw, range = null, now = Date.now(), revenue = null, peakCount = 1, ...capOptions } = {}) {
  const months = new Map();
  for (const [t, h] of profile) {
    const key = monthKey(t);
    const m = months.get(key) || { month: key, hours: [] };
    m.hours.push({ at: t, kw: h.kw, sessions: h.sessions, revenue: h.revenue || 0 });
    months.set(key, m);
  }
  const until = range ? Math.min(range.to, now) : now;
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(({ month, hours }) => {
      const [year, mo] = month.split('-').map(Number);
      const monthStart = new Date(year, mo - 1, 1).getTime();
      const monthEnd = new Date(year, mo, 1).getTime();
      const partial = (range ? monthStart < range.from : false) || monthEnd > until;
      const billed = billedPeak(hours, peakCount);
      const top = billed.hours[0] || null;
      const cost = billed.kw * krPerKw;
      const monthRevenue = revenue?.get(month) || 0;
      const net = monthRevenue - cost;
      const limit = limitAt(top ? top.at : monthStart, capOptions); // in force at the peak hour
      const capKw = limit?.kw ?? null;
      return {
        limit,
        limits: limitsBetween(monthStart, monthEnd, capOptions),
        month,
        peakKw: billed.kw,
        at: top ? top.at : null,
        sessions: top ? top.sessions : 0,
        // revenue earned in the billed hour(s), averaged like the effekt itself
        spikeRevenue: billed.hours.length ? billed.hours.reduce((sum, h) => sum + h.revenue, 0) / billed.hours.length : 0,
        peakHours: billed.hours.map((h) => ({ at: h.at, kw: h.kw })),
        capKw,
        winter: isWinter(monthStart + 15 * 86_400_000), // by the middle of the month
        cost,
        partial,
        monthRevenue,
        net,
        covered: net >= 0,
      };
    });
}

export function topHours(profile, n = 10) {
  return [...profile.entries()]
    .map(([at, h]) => ({ at, ...h }))
    .sort((a, b) => b.kw - a.kw || a.at - b.at)
    .slice(0, n);
}

// Average kW per (weekday, hour) over the days in the range. cells[weekday][hour], Monday first.
export function weekdayHourMatrix(profile, range) {
  const days = new Array(7).fill(0);
  const cursor = new Date(range.from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < range.to) {
    days[mondayIndex(cursor.getDay())] += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  const sum = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const [t, h] of profile) {
    const d = new Date(t);
    sum[mondayIndex(d.getDay())][d.getHours()] += h.kw;
  }
  let max = 0;
  const cells = sum.map((row, weekday) => row.map((v) => {
    const avg = days[weekday] ? v / days[weekday] : 0;
    if (avg > max) max = avg;
    return avg;
  }));
  return { cells, max, days };
}

export function analyze(records, range, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const now = o.now ?? Date.now();
  const inRange = records.filter((r) => {
    const t = Date.parse(r.start || r.end || '');
    return t >= range.from && t < range.to;
  });
  const pluggedSegments = concurrencySegments(inRange.map(pluggedWindow));
  const chargingSegments = concurrencySegments(inRange.map((r) => chargingWindow(r, o)));
  const profile = hourlyProfile(inRange, o);
  const floor = hourlyProfile(inRange, { ...o, model: 'even' });
  const revenue = revenueByMonth(inRange);
  return {
    records: inRange.length,
    revenue: [...revenue.values()].reduce((sum, v) => sum + v, 0),
    plugged: { peak: peakConcurrency(pluggedSegments), hours: hoursByConcurrency(pluggedSegments, o.chargers) },
    charging: { peak: peakConcurrency(chargingSegments), hours: hoursByConcurrency(chargingSegments, o.chargers) },
    profile,
    months: monthlyPeaks(profile, { ...o, range, now, revenue }),
    floorMonths: monthlyPeaks(floor, { ...o, range, now, revenue }),
    top: topHours(profile),
    peakHour: topHours(profile, 1)[0] || null,
    floorPeakHour: topHours(floor, 1)[0] || null,
    matrix: weekdayHourMatrix(profile, range),
  };
}
