import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpotData, dayToQuarters, daysBetween, dayUrl } from './spot.js';
import { hourlySpot, hourPrices, splitHours, monthlyMeter, DEFAULT_TARIFF } from '../public/meter.js';

const Q = 15 * 60_000;
const H = 3_600_000;

test('dayToQuarters: quarter prices stay, hourly prices become four quarters', () => {
  const quarters = dayToQuarters([
    { SEK_per_kWh: 1.0, time_start: '2026-11-23T00:00:00+01:00', time_end: '2026-11-23T00:15:00+01:00' },
    { SEK_per_kWh: 0.5, time_start: '2026-11-23T00:15:00+01:00', time_end: '2026-11-23T00:30:00+01:00' },
  ]);
  assert.deepEqual([...quarters.values()], [100, 50]);
  assert.equal([...quarters.keys()][0], Date.parse('2026-11-22T23:00:00Z'));
  const hourly = dayToQuarters([{ SEK_per_kWh: 0.42, time_start: '2025-09-15T10:00:00+02:00', time_end: '2025-09-15T11:00:00+02:00' }]);
  assert.equal(hourly.size, 4);
  assert.ok([...hourly.values()].every((v) => v === 42));
});

test('daysBetween and dayUrl follow Swedish days, also across DST', () => {
  const days = daysBetween(Date.parse('2025-10-25T12:00:00Z'), Date.parse('2025-10-27T12:00:00Z'));
  assert.equal(days.length, 3);
  assert.match(dayUrl(days[1]), /2025\/10-26_SE4\.json$/);
  assert.equal(days[1] - days[0], 24 * H);
  assert.equal(days[2] - days[1], 25 * H); // 26 Oct has 25 hours
});

test('buildSpotData extends a base series and only asks for the last days', async () => {
  const asked = [];
  const fakeFetch = async (url) => {
    asked.push(url);
    const m = url.match(/(\d{4})\/(\d{2})-(\d{2})_SE4/);
    const start = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+01:00`);
    if (start >= Date.parse('2026-11-25T00:00:00+01:00')) return { ok: false, status: 404 }; // tomorrow not out yet
    const body = Array.from({ length: 96 }, (_, i) => ({ SEK_per_kWh: 0.5 + (i % 4) / 100, time_start: new Date(start + i * Q).toISOString(), time_end: new Date(start + (i + 1) * Q).toISOString() }));
    return { ok: true, status: 200, json: async () => body };
  };
  const now = Date.parse('2026-11-24T12:00:00Z');
  const first = await buildSpotData({ historyFrom: '2026-11-20', now, fetchImpl: fakeFetch });
  assert.equal(first.step_min, 15);
  assert.equal(first.fetch.not_published, 1); // tomorrow's prices are not out yet
  asked.length = 0;
  const next = await buildSpotData({ base: first, historyFrom: '2026-11-20', now, fetchImpl: fakeFetch });
  assert.ok(asked.length <= 5, `asked ${asked.length} days`);
  assert.equal(next.values.length, first.values.length);
});

test('hourlySpot weights quarter prices by the energy measured in each quarter', () => {
  const t0 = Date.parse('2026-01-15T09:00:00Z');
  const installation = { quarter: { start: new Date(t0).toISOString(), step_min: 15, values: [3, 1, 0, 0] } };
  const spot = { start: new Date(t0).toISOString(), step_min: 15, values: [100, 20, 50, 50] };
  const { weighted, plain } = hourlySpot(installation, spot);
  assert.equal(weighted.get(t0), (3 * 100 + 1 * 20) / 4); // 80 öre: Σ kWh × price / Σ kWh
  assert.equal(plain.get(t0), 55);
});

test('hourPrices: spot + surcharge; the 2027 grid fee follows spot', () => {
  const t = DEFAULT_TARIFF;
  const p26 = hourPrices(new Date(2026, 5, 1).getTime(), 50, t);
  assert.equal(p26.retail, 50 + t.surchargeOre);
  assert.equal(p26.transfer, t.transferOre);
  const p27 = hourPrices(new Date(2027, 5, 1).getTime(), 50, t);
  assert.ok(Math.abs(p27.transfer - (6.4 + 0.121 * 50)) < 1e-9);
  const flat = hourPrices(new Date(2026, 5, 1).getTime(), null, t);
  assert.equal(flat.retail, t.retailOre);
});

test('monthlyMeter prices energy per hour and reports the timing of use', () => {
  const t0 = new Date(2026, 0, 10, 8).getTime();
  const meter = new Map([[t0, 10], [t0 + H, 2]]);
  const spot = { weighted: new Map([[t0, 100], [t0 + H, 20]]), plain: new Map([[t0, 100], [t0 + H, 20]]) };
  const rows = splitHours(meter, null, null, {}, spot);
  const [m] = monthlyMeter(rows, { tariff: { ...DEFAULT_TARIFF, vatPct: 0 }, now: t0 + 2 * H });
  const expected = (10 * (100 + DEFAULT_TARIFF.surchargeOre) + 2 * (20 + DEFAULT_TARIFF.surchargeOre)) / 100;
  assert.ok(Math.abs(m.cost.energy - expected) < 1e-9);
  // Most energy in the dear hour: paid more than the plain average.
  assert.ok(Math.abs(m.spot.paidOre - (10 * 100 + 2 * 20) / 12) < 1e-9);
  assert.equal(m.spot.averageOre, 60);
  assert.ok(m.spot.timingKr > 0);
});
