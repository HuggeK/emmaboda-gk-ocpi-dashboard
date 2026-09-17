import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from './demo-data.js';
import { normalizeCdr } from './normalize.js';
import {
  HOUR_MS,
  analyze,
  chargingWindow,
  concurrencySegments,
  hourlyProfile,
  hoursByConcurrency,
  monthlyPeaks,
  peakConcurrency,
  weekdayHourMatrix,
} from '../public/analysis.js';

// Mid-day UTC timestamps keep weekday and month the same in every time zone.
const T0 = Date.parse('2026-06-10T10:30:00Z'); // a Wednesday
const record = (id, startMs, hours, kwh) => ({ id, start: new Date(startMs).toISOString(), end: new Date(startMs + hours * HOUR_MS).toISOString(), energy_kwh: kwh });

test('chargingWindow: front-loaded charges at the rate until the energy is delivered, even spreads it', () => {
  const r = record('a', T0, 4, 22);
  const front = chargingWindow(r, { model: 'front', rateKw: 11 });
  assert.equal(front.end - front.start, 2 * HOUR_MS);
  assert.equal(front.kw, 11);
  const even = chargingWindow(r, { model: 'even' });
  assert.equal(even.end - even.start, 4 * HOUR_MS);
  assert.equal(even.kw, 5.5);
  // A session shorter than kwh / rate simply charged faster.
  const fast = chargingWindow(record('b', T0, 1, 22), { model: 'front', rateKw: 11 });
  assert.equal(fast.end - fast.start, HOUR_MS);
  assert.equal(fast.kw, 22);
  assert.equal(chargingWindow(record('c', T0, 2, 0)), null);
});

test('concurrency: segments, peak and hours per count', () => {
  const windows = [
    { start: T0, end: T0 + 3 * HOUR_MS },
    { start: T0 + HOUR_MS, end: T0 + 2 * HOUR_MS },
    { start: T0 + 1.5 * HOUR_MS, end: T0 + 4 * HOUR_MS },
  ];
  const segments = concurrencySegments(windows);
  const peak = peakConcurrency(segments);
  assert.equal(peak.count, 3);
  assert.equal(peak.start, T0 + 1.5 * HOUR_MS);
  assert.equal(peak.end, T0 + 2 * HOUR_MS);
  const hours = hoursByConcurrency(segments, 6);
  assert.equal(hours[3], 0.5);
  assert.equal(hours[2], 1.5); // 1 h with two, plus 1 h (2 to 3) with two
  assert.equal(hours[1], 2); // first hour alone, plus 3 to 4 alone
  assert.equal(hoursByConcurrency(segments, 2)[2], 2); // counts above the cap fold into it
  assert.equal(peakConcurrency([]).count, 0);
});

test('hourlyProfile: clock-hour buckets, session counts and the cap', () => {
  const r = record('a', T0, 4, 22); // 10:30 to 14:30, charging 10:30 to 12:30 at 11 kW
  const profile = hourlyProfile([r], { model: 'front', rateKw: 11 });
  const at = (h) => profile.get(Date.parse(`2026-06-10T${String(h).padStart(2, '0')}:00:00Z`));
  assert.equal(at(10).kw, 5.5);
  assert.equal(at(11).kw, 11);
  assert.equal(at(12).kw, 5.5);
  assert.equal(at(13), undefined);
  assert.equal(at(11).sessions, 1);
  const capped = hourlyProfile([r, record('b', T0, 4, 22)], { model: 'front', rateKw: 11, capKw: 15 });
  assert.equal(capped.get(Date.parse('2026-06-10T11:00:00Z')).kw, 15);
  assert.equal(capped.get(Date.parse('2026-06-10T11:00:00Z')).rawKw, 22);
  assert.equal(capped.get(Date.parse('2026-06-10T11:00:00Z')).sessions, 2);
});

test('monthlyPeaks: one row per month with cost and partial flags', () => {
  const july = Date.parse('2026-07-15T10:00:00Z');
  const profile = hourlyProfile([record('a', T0, 2, 22), record('b', july, 2, 33)], { model: 'front', rateKw: 11 });
  // Ranges are local midnights, as the UI builds them; months are local too.
  const range = { from: new Date(2026, 5, 1).getTime(), to: new Date(2026, 7, 1).getTime() };
  const months = monthlyPeaks(profile, { krPerKw: 120, range, now: Date.parse('2026-07-20T00:00:00Z') });
  assert.deepEqual(months.map((m) => m.month), ['2026-06', '2026-07']);
  assert.equal(months[0].peakKw, 11);
  assert.equal(months[0].cost, 1320);
  assert.equal(months[0].partial, false);
  assert.equal(months[1].partial, true); // July is still running at "now"
});

test('weekdayHourMatrix averages over the days of each weekday in the range', () => {
  const onTheHour = Date.parse('2026-06-10T10:00:00Z'); // a Wednesday; one full clock hour at 11 kW
  const profile = hourlyProfile([record('a', onTheHour, 1, 11)], { model: 'front', rateKw: 11 });
  const range = { from: new Date(2026, 5, 8).getTime(), to: new Date(2026, 5, 22).getTime() }; // two full weeks, local midnights
  const matrix = weekdayHourMatrix(profile, range);
  assert.deepEqual(matrix.days, [2, 2, 2, 2, 2, 2, 2]);
  const hour = new Date(onTheHour).getHours();
  assert.equal(matrix.cells[2][hour], 5.5);
  assert.equal(matrix.max, 5.5);
});

test('analyze runs on demo data and stays within the charger count', async () => {
  const client = createDemoClient();
  const { items } = await client.getAll('cdrs', {});
  const records = items.map(normalizeCdr);
  const now = Date.now();
  const result = analyze(records, { from: now - 365 * 86_400_000, to: now }, { chargers: 6, now });
  assert.ok(result.records > 0);
  assert.ok(result.plugged.peak.count >= 1 && result.plugged.peak.count <= 6);
  assert.ok(result.charging.peak.count <= result.plugged.peak.count);
  assert.ok(result.months.length >= 1);
  assert.ok(result.peakHour.kw <= 43.5);
  assert.equal(result.matrix.cells.length, 7);
  assert.equal(result.top.length, 10);
});
