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

export const DEFAULT_OPTIONS = { model: 'front', rateKw: 11, capKw: 43.5, krPerKw: 120, chargers: 6 };

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

// Map of hour start (ms) -> { kw, rawKw, sessions, revenue }. kw is the
// average power over that clock hour (kWh delivered in the hour), capped at
// capKw when set. revenue is each session's charged amount, allocated to the
// hours in proportion to the energy delivered in them.
export function hourlyProfile(records, options = {}) {
  const capKw = options.capKw > 0 ? options.capKw : Infinity;
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
    profile.set(t, { kw: Math.min(b.kwh, capKw), rawKw: b.kwh, sessions: b.sessions.size, revenue: b.revenue });
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

// One row per month: the peak hour, what it costs at the tariff, the revenue
// earned in that hour and in the whole month, and whether the month's charging
// revenue covered the effektavgift.
export function monthlyPeaks(profile, { krPerKw = DEFAULT_OPTIONS.krPerKw, range = null, now = Date.now(), revenue = null } = {}) {
  const months = new Map();
  for (const [t, h] of profile) {
    const key = monthKey(t);
    const m = months.get(key) || { month: key, peakKw: 0, at: null, sessions: 0, spikeRevenue: 0 };
    if (h.kw > m.peakKw) {
      m.peakKw = h.kw;
      m.at = t;
      m.sessions = h.sessions;
      m.spikeRevenue = h.revenue || 0;
    }
    months.set(key, m);
  }
  const limit = range ? Math.min(range.to, now) : now;
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const [year, month] = m.month.split('-').map(Number);
      const monthStart = new Date(year, month - 1, 1).getTime();
      const monthEnd = new Date(year, month, 1).getTime();
      const partial = (range ? monthStart < range.from : false) || monthEnd > limit;
      const cost = m.peakKw * krPerKw;
      const monthRevenue = revenue?.get(m.month) || 0;
      const net = monthRevenue - cost;
      return { ...m, cost, partial, monthRevenue, net, covered: net >= 0 };
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
    months: monthlyPeaks(profile, { krPerKw: o.krPerKw, range, now, revenue }),
    floorMonths: monthlyPeaks(floor, { krPerKw: o.krPerKw, range, now, revenue }),
    top: topHours(profile),
    peakHour: topHours(profile, 1)[0] || null,
    floorPeakHour: topHours(floor, 1)[0] || null,
    matrix: weekdayHourMatrix(profile, range),
  };
}
