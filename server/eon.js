// Grid meter values from E.ON's Energidata API, shaped for the dashboard.
//
// E.ON reports energy per interval (kWh per hour or per quarter hour). The
// average power over an interval is that energy divided by its length, which
// is exactly what an effektavgift is billed on, so this is the measured
// counterpart to the chargers' estimated hourly profile in public/analysis.js.
//
// Timestamps: E.ON gives Swedish local wall time with no offset. For hour and
// quarter values the stamp is the *read time*, i.e. the end of the interval.
// The night the clocks go back, the repeated hour is marked by a ".01"
// fraction (02:00.01 is the second 02:00); a stamp seen twice in one response
// is treated the same way, so either convention works. Everything here is
// stored as UTC instants of the interval *start*.
import { createHash } from 'node:crypto';
import { expandSeries } from '../public/meter.js';

export { expandSeries };

export const TIME_ZONE = 'Europe/Stockholm';
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const STEP_MIN = { hour: 60, quarter: 15 };
// Longest span E.ON accepts per request (quarter: 3 months, hour: 1 year), with margin.
const CHUNK_DAYS = { hour: 300, quarter: 80 };
const OVERLAP_DAYS = 3; // an incremental fetch re-asks this far back, catching late corrections
const MAX_INSTALLATIONS = 4;

// ------------------------------------------------------------------ time zone
const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function stockholmParts(ms) {
  const p = {};
  for (const { type, value } of partsFormat.formatToParts(new Date(ms))) p[type] = Number(value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// Wall clock time in Stockholm -> UTC ms. During the repeated hour in October
// both CEST and CET match; `later` picks the second occurrence (CET).
export function wallToUtc(y, mo, d, h = 0, mi = 0, s = 0, later = false) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const matches = [2, 1]
    .map((offsetH) => naive - offsetH * HOUR_MS)
    .filter((utc) => {
      const p = stockholmParts(utc);
      return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
    });
  if (!matches.length) return naive - HOUR_MS; // a time skipped in March; does not occur as a read time
  return later ? matches[matches.length - 1] : matches[0];
}

const pad = (n) => String(n).padStart(2, '0');

// UTC ms -> "YYYY-MM-DDTHH:mm:ss" in Stockholm, the form E.ON's from / to take.
export function toWall(ms) {
  const p = stockholmParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

export function stockholmMidnight(ms) {
  const p = stockholmParts(ms);
  return wallToUtc(p.y, p.mo, p.d);
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

// Parses one E.ON timestamp. `seen` (a Set, shared across one response)
// detects a wall time that repeats, which can only be the October hour.
export function parseEonTime(text, seen = null) {
  const value = String(text || '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return Date.parse(value); // carries its own offset
  const m = WALL_RE.exec(value);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '0', fraction = '0'] = m;
  const wallKey = `${y}-${mo}-${d}T${h}:${mi}`;
  const marked = Number(s) > 0 || Number(`0.${fraction}`) > 0;
  const repeated = seen ? seen.has(wallKey) : false;
  seen?.add(wallKey);
  return wallToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), 0, marked || repeated);
}

// ------------------------------------------------------------------- series
const UNIT_FACTOR = { kwh: 1, wh: 0.001, mwh: 1000 };

export function unitFactor(unit) {
  return UNIT_FACTOR[String(unit || '').toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

// The series to read: active energy drawn from the grid. E.ON does not document
// the seriesType values, so this scores them; EON_SERIES_ID overrides.
export function pickSeries(series, preferredId = null) {
  if (!series?.length) return null;
  if (preferredId) {
    const chosen = series.find((s) => String(s.id) === String(preferredId));
    if (chosen) return chosen;
  }
  const score = (s) => {
    const type = String(s.seriesType || '').toLowerCase();
    let points = unitFactor(s.unit) !== null ? 10 : 0;
    if (/consum|förbruk|forbruk|uttag|import|deliver|active|aktiv/.test(type)) points += 5;
    if (/produ|inmat|export|reactive|reaktiv|kvar|var\b|effekt|effect|power|demand/.test(type)) points -= 12;
    return points;
  };
  return [...series].sort((a, b) => score(b) - score(a) || Number(a.id) - Number(b.id))[0];
}

// Raw E.ON measurements -> Map(interval start ms -> kWh).
export function measurementsToMap(measurements, resolution, unit) {
  const stepMs = STEP_MIN[resolution] * MINUTE_MS;
  const factor = unitFactor(unit) ?? 1;
  const seen = new Set();
  const out = new Map();
  for (const m of measurements || []) {
    const readAt = parseEonTime(m.timeStamp, seen);
    if (!Number.isFinite(readAt)) continue;
    const value = m.value === null || m.value === undefined ? null : Number(m.value) * factor;
    if (value !== null && !Number.isFinite(value)) continue;
    out.set(readAt - stepMs, value);
  }
  return out;
}

// Compact form for the snapshot: one start instant plus a dense array of kWh
// values, null where E.ON has no value. Hourly values for three years are
// about 130 kB this way.
export function compactSeries(map, stepMin) {
  const stepMs = stepMin * MINUTE_MS;
  const keys = [...map.keys()].filter((t) => map.get(t) !== null).sort((a, b) => a - b);
  if (!keys.length) return null;
  const first = keys[0];
  const last = keys[keys.length - 1];
  const values = new Array(Math.round((last - first) / stepMs) + 1).fill(null);
  for (const [t, v] of map) {
    const i = Math.round((t - first) / stepMs);
    if (i >= 0 && i < values.length && v !== null) values[i] = Math.round(v * 1000) / 1000;
  }
  return { start: new Date(first).toISOString(), step_min: stepMin, values };
}

// The installation id is the meter's anläggnings-id, which is enough to switch
// electricity supplier. The public snapshot only carries a short hash of it.
export const installationRef = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 10);

function describeInstallation(meta = {}, id) {
  return {
    ref: installationRef(id),
    name: meta.name || null,
    city: meta.city || null,
    grid_area: meta.gridArea || null,
    price_area: meta.priceArea || null,
    resolution: meta.resolution || null,
    fuse_a: meta.safetyLevel ?? null,
    energy_class: meta.energyClass || null,
    category: meta.category || null,
    active: meta.active ?? null,
    measurements_subscription: meta.hasMeasurementsSubscription ?? null,
    costs_subscription: meta.hasCostsSubscription ?? null,
  };
}

const seriesMeta = (s) => (s ? { id: s.id, type: s.seriesType || null, unit: s.unit || null, last_update: s.lastUpdate || null } : null);

// Fetches [fromMs, toMs) in chunks E.ON accepts. A chunk E.ON refuses (for
// example quarter-hour values from before the meter was read every 15
// minutes) is skipped and noted; only when every chunk fails is it an error.
async function fetchRange(client, seriesId, resolution, unit, fromMs, toMs, requests) {
  const merged = new Map();
  const chunkMs = CHUNK_DAYS[resolution] * DAY_MS;
  let firstError = null;
  let succeeded = 0;
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const from = toWall(start);
    const to = toWall(end);
    let measurements;
    try {
      measurements = await client.getMeasurements(seriesId, resolution, { from, to });
    } catch (err) {
      if (err.details?.code === 'UNAUTHORIZED' || err.details?.code === 'NETWORK') throw err;
      firstError ||= err;
      requests.push({ resolution, from, to, values: 0, skipped: err.message });
      continue;
    }
    succeeded += 1;
    requests.push({ resolution, from, to, values: measurements.length });
    for (const [t, v] of measurementsToMap(measurements, resolution, unit)) merged.set(t, v);
  }
  if (!succeeded && firstError) throw firstError;
  return merged;
}

// Smallest and largest key of a big map without spreading it into arguments.
function keyRange(map) {
  let min = Infinity;
  let max = -Infinity;
  for (const k of map.keys()) {
    if (k < min) min = k;
    if (k > max) max = k;
  }
  return map.size ? { min, max } : null;
}

export function usableEonInstallation(baseInstallation, seriesId) {
  return Boolean(baseInstallation?.selected_series && String(baseInstallation.selected_series.id) === String(seriesId) && baseInstallation.hourly?.values?.length);
}

// One resolution of one installation, extended from the base when possible.
// historyChecked: the base already asked E.ON for everything back to fullFrom.
// If it has not (an older snapshot that kept only recent quarter hours), the
// missing older range is fetched once.
async function loadResolution({ client, series, resolution, baseCompact, fullFrom, now, requests, historyChecked = false }) {
  const stepMs = STEP_MIN[resolution] * MINUTE_MS;
  const baseMap = expandSeries(baseCompact);
  const range = keyRange(baseMap);
  const incremental = range !== null;
  const fromMs = incremental ? stockholmMidnight(range.max - OVERLAP_DAYS * DAY_MS) : fullFrom;
  const toMs = stockholmMidnight(now + DAY_MS); // up to the end of today
  const fetched = await fetchRange(client, series.id, resolution, series.unit, fromMs, toMs, requests);
  const merged = new Map(baseMap);
  for (const [t, v] of fetched) merged.set(t, v);
  let backfilled = 0;
  if (incremental && !historyChecked && range.min > fullFrom + DAY_MS) {
    try {
      const older = await fetchRange(client, series.id, resolution, series.unit, fullFrom, stockholmMidnight(range.min), requests);
      for (const [t, v] of older) merged.set(t, v);
      backfilled = older.size;
    } catch {
      // nothing older exists; noted in the requests list
    }
  }
  return {
    compact: compactSeries(merged, STEP_MIN[resolution]),
    info: { incremental, fetched_from: new Date(fromMs).toISOString(), fetched: fetched.size, backfilled, step_ms: stepMs },
  };
}

// Everything the Meter tab shows. `base` is the eon part of the previously
// published snapshot; with it, only the last few days are requested again.
export async function buildEonData({
  client,
  now = Date.now(),
  base = null,
  full = false,
  historyFrom = '2024-01-01', // E.ON keeps the current year plus five calendar years back
  preferredSeriesId = null,
  preferredInstallationId = null,
}) {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const [installations, seriesByInstallation] = await Promise.all([client.getInstallations(), client.getMeasurementSeries()]);
  const metaById = new Map(installations.map((i) => [String(i.id), i]));
  const ids = [...new Set([...seriesByInstallation.map((i) => String(i.id)), ...installations.map((i) => String(i.id))])]
    .filter((id) => !preferredInstallationId || id === String(preferredInstallationId));

  const [hy, hm, hd] = String(historyFrom).slice(0, 10).split('-').map(Number);
  const fullFrom = wallToUtc(hy, hm || 1, hd || 1);
  const baseByRef = new Map((base?.installations || []).map((i) => [i.ref, i]));

  const out = [];
  for (const id of ids) {
    const meta = metaById.get(id);
    const entry = describeInstallation(meta, id);
    const series = seriesByInstallation.find((i) => String(i.id) === id)?.measurementSeries || [];
    entry.series = series.map(seriesMeta);
    entry.errors = [];
    entry.hourly = null;
    entry.quarter = null;
    const readable = meta ? meta.active !== false && meta.hasMeasurementsSubscription !== false : true;
    const chosen = readable && out.filter((i) => i.selected_series).length < MAX_INSTALLATIONS ? pickSeries(series, preferredSeriesId) : null;
    entry.selected_series = seriesMeta(chosen);
    if (!chosen) {
      if (readable && !series.length) entry.errors.push({ resolution: null, message: 'E.ON lists no measurement series for this installation.' });
      out.push(entry);
      continue;
    }

    const previous = baseByRef.get(entry.ref);
    const extend = !full && usableEonInstallation(previous, chosen.id);
    entry.history_from = extend ? { ...(previous.history_from || {}) } : {};
    const requests = [];
    entry.fetch = { requests };
    for (const resolution of ['hour', 'quarter']) {
      try {
        const { compact, info } = await loadResolution({
          client,
          series: chosen,
          resolution,
          baseCompact: extend ? previous[resolution === 'hour' ? 'hourly' : 'quarter'] : null,
          fullFrom,
          now: nowMs,
          requests,
          historyChecked: Boolean(extend && previous.history_from?.[resolution] && Date.parse(previous.history_from[resolution]) <= fullFrom),
        });
        entry[resolution === 'hour' ? 'hourly' : 'quarter'] = compact;
        entry.fetch[resolution] = info;
        // Everything back to fullFrom has now been asked for once.
        entry.history_from = { ...(entry.history_from || {}), [resolution]: new Date(fullFrom).toISOString() };
      } catch (err) {
        // Quarter values only exist for quarter-metered installations; an
        // hourly failure keeps whatever the previous snapshot had.
        if (extend && previous[resolution === 'hour' ? 'hourly' : 'quarter']) entry[resolution === 'hour' ? 'hourly' : 'quarter'] = previous[resolution === 'hour' ? 'hourly' : 'quarter'];
        entry.errors.push({ resolution, message: err.message, httpStatus: err.details?.httpStatus ?? null });
      }
    }
    const last = entry.hourly ? Date.parse(entry.hourly.start) + (entry.hourly.values.length) * HOUR_MS : null;
    entry.last_value_end = last ? new Date(last).toISOString() : null;
    out.push(entry);
  }

  return {
    configured: true,
    source: client.isDemo ? 'demo' : 'eon',
    generated_at: new Date(nowMs).toISOString(),
    error: null,
    installations: out,
    requests: (client.requests?.() || []).map(({ step, url, httpStatus }) => ({ step, url, httpStatus })),
  };
}

// When E.ON cannot be reached at all, keep the previous snapshot's values and
// say why, so the Meter tab shows stale data with a warning, not nothing.
export function eonFailure(err, base = null, now = Date.now()) {
  const error = typeof err?.toJSON === 'function' ? err.toJSON() : { message: err?.message || String(err) };
  return {
    configured: error.code !== 'NOT_CONFIGURED',
    source: base?.source || 'eon',
    generated_at: base?.generated_at || null,
    attempted_at: new Date(now).toISOString(),
    error,
    installations: base?.installations || [],
    requests: [],
  };
}
