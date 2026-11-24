import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from './demo-data.js';
import { normalizeCdr } from './normalize.js';
import { createDemoEonClient } from './eon-demo.js';
import {
  buildEonData,
  compactSeries,
  eonFailure,
  measurementsToMap,
  parseEonTime,
  pickSeries,
  toWall,
  wallToUtc,
} from './eon.js';
import { expandSeries, meterHours, splitHours, monthlyMeter, dailyPeaks, rateFromMeter, DEFAULT_TARIFF } from '../public/meter.js';
import { HOUR_MS, capAt, limitAt, limitsBetween, isWinter, hourlyProfile, billedPeak, rateFromRecords } from '../public/analysis.js';

const iso = (ms) => new Date(ms).toISOString();

test('parseEonTime: Swedish wall time, both DST nights', () => {
  // Ordinary winter and summer hours.
  assert.equal(iso(parseEonTime('2026-01-15T10:00:00')), '2026-01-15T09:00:00.000Z');
  assert.equal(iso(parseEonTime('2026-07-15T10:00:00')), '2026-07-15T08:00:00.000Z');
  // October 2025: 03:00 CEST becomes 02:00 CET, so 02:00 happens twice.
  assert.equal(iso(parseEonTime('2025-10-26T02:00:00')), '2025-10-26T00:00:00.000Z');
  assert.equal(iso(parseEonTime('2025-10-26T02:00:00.01')), '2025-10-26T01:00:00.000Z');
  assert.equal(iso(parseEonTime('2025-10-26T02:00:01')), '2025-10-26T01:00:00.000Z');
  assert.equal(iso(parseEonTime('2025-10-26T03:00:00')), '2025-10-26T02:00:00.000Z');
  // A wall time seen twice in one response is the later one the second time.
  const seen = new Set();
  assert.equal(iso(parseEonTime('2025-10-26T02:15:00', seen)), '2025-10-26T00:15:00.000Z');
  assert.equal(iso(parseEonTime('2025-10-26T02:15:00', seen)), '2025-10-26T01:15:00.000Z');
  // March 2026: 02:00 CET jumps to 03:00 CEST; read time 03:00 ends the 01:00-02:00 CET hour.
  assert.equal(iso(parseEonTime('2026-03-29T03:00:00')), '2026-03-29T01:00:00.000Z');
  // Stamps with their own offset are taken as they are.
  assert.equal(iso(parseEonTime('2026-01-15T10:00:00+01:00')), '2026-01-15T09:00:00.000Z');
  assert.ok(Number.isNaN(parseEonTime('yesterday')));
});

test('toWall and wallToUtc round-trip, and midnight is local', () => {
  const t = Date.parse('2026-07-01T22:00:00Z');
  assert.equal(toWall(t), '2026-07-02T00:00:00');
  assert.equal(wallToUtc(2026, 7, 2), t);
});

test('measurementsToMap: read time -> interval start, 25-hour day, unit scaling', () => {
  const hourly = [];
  // Every hour of 26 October 2025 as E.ON writes it: 25 read times.
  for (let t = Date.parse('2025-10-25T22:00:00Z'); t < Date.parse('2025-10-26T23:00:00Z'); t += HOUR_MS) {
    const readAt = t + HOUR_MS;
    const wall = toWall(readAt);
    const later = wallToUtc(...wall.split(/[-T:]/).map(Number).slice(0, 5), 0, false) !== readAt;
    hourly.push({ timeStamp: later ? `${wall}.01` : wall, value: 1000 });
  }
  assert.equal(hourly.length, 25);
  const map = measurementsToMap(hourly, 'hour', 'Wh');
  assert.equal(map.size, 25, 'no hour may collapse onto another');
  assert.deepEqual([...new Set(map.values())], [1]);
  assert.equal(iso(Math.min(...map.keys())), '2025-10-25T22:00:00.000Z');
});

test('compactSeries and expandSeries round-trip with gaps', () => {
  const t0 = Date.parse('2026-02-01T00:00:00Z');
  const map = new Map([[t0, 1.5], [t0 + 2 * HOUR_MS, 2], [t0 + 3 * HOUR_MS, null]]);
  const compact = compactSeries(map, 60);
  assert.deepEqual(compact, { start: iso(t0), step_min: 60, values: [1.5, null, 2] });
  assert.deepEqual([...expandSeries(compact)], [[t0, 1.5], [t0 + 2 * HOUR_MS, 2]]);
});

test('pickSeries prefers active energy consumption, and honours an explicit id', () => {
  const series = [
    { id: 1, seriesType: 'Reactive consumption', unit: 'kVArh' },
    { id: 2, seriesType: 'Production', unit: 'kWh' },
    { id: 3, seriesType: 'Consumption', unit: 'kWh' },
  ];
  assert.equal(pickSeries(series).id, 3);
  assert.equal(pickSeries(series, '2').id, 2);
  assert.equal(pickSeries([]), null);
});

function demoRecords(now) {
  return createDemoClient().getAll('cdrs', {}).then(({ items }) => items.map(normalizeCdr)).then((items) => ({ items, now }));
}

test('buildEonData on the demo API: hourly + quarter values, no raw installation id', async () => {
  const now = Date.now();
  const { items } = await demoRecords(now);
  const client = createDemoEonClient({ records: items, now });
  const eon = await buildEonData({ client, now, historyFrom: toWall(now - 60 * 86_400_000).slice(0, 10) });
  assert.equal(eon.error, null);
  assert.equal(eon.installations.length, 1);
  const inst = eon.installations[0];
  assert.equal(inst.selected_series.type, 'Consumption');
  assert.ok(inst.hourly.values.length > 50 * 24);
  assert.ok(inst.quarter.values.length > 30 * 96);
  assert.equal(inst.errors.length, 0);
  // The same energy whichever resolution it is read in.
  const hours = expandSeries(inst.hourly);
  const quarters = expandSeries(inst.quarter);
  const someHour = [...hours.keys()].at(-30);
  const fromQuarters = [0, 1, 2, 3].reduce((sum, i) => sum + quarters.get(someHour + i * 900_000), 0);
  assert.ok(Math.abs(fromQuarters - hours.get(someHour)) < 0.01);
  const text = JSON.stringify(eon);
  assert.ok(!text.includes('735999000000000001'), 'the anläggnings-id must not be published');
  assert.ok(!text.includes('000000-0000'), 'the org number must not be published');

  // Extending: a second build asks only for the last few days.
  const again = await buildEonData({ client, now, base: eon });
  const fetch = again.installations[0].fetch;
  assert.equal(fetch.hour.incremental, true);
  assert.ok(fetch.hour.fetched < 5 * 24);
  assert.deepEqual(again.installations[0].hourly.values.length, inst.hourly.values.length);
});

test('eonFailure keeps the previous values and the reason', () => {
  const base = { source: 'eon', generated_at: '2026-11-01T00:00:00.000Z', installations: [{ ref: 'abc' }] };
  const failed = eonFailure(new Error('boom'), base);
  assert.equal(failed.error.message, 'boom');
  assert.deepEqual(failed.installations, base.installations);
  assert.equal(failed.generated_at, base.generated_at);
});

test('limits: the dated ChargeNode settings, and the seasonal what-if', () => {
  const at = (s) => Date.parse(s);
  assert.equal(limitAt(at('2025-05-01T12:00:00Z')).kw, 57);
  assert.equal(capAt(at('2026-08-01T12:00:00Z')), 43.5); // 63 A, as ChargeNode states it
  // November 2026 changed from the charger cap to the facility ceiling on the 2nd.
  const nov = limitsBetween(at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'));
  assert.deepEqual(nov.map((l) => l.kind), ['chargers', 'facility']);
  const now = limitAt(at('2026-11-20T12:00:00Z'));
  assert.equal(now.kind, 'facility');
  assert.equal(Math.round(now.kw), 25); // 36 A
  // After the confirmed settings, the yearly plan: 1 Mar chargers 43.5 kW, 26 Oct facility 25 kW.
  const local = (d) => new Date(`${d}T12:00:00`).getTime();
  assert.equal(limitAt(local('2027-02-28')).kind, 'facility');
  assert.equal(limitAt(local('2027-03-01')).kw, 43.5);
  assert.equal(limitAt(local('2027-03-01')).planned, true);
  assert.equal(limitAt(local('2027-10-25')).kind, 'chargers');
  assert.equal(limitAt(local('2027-10-26')).kind, 'facility');
  assert.equal(limitAt(local('2031-07-01')).kw, 43.5);
  const oct = limitsBetween(new Date(2027, 9, 1).getTime(), new Date(2027, 10, 1).getTime());
  assert.deepEqual(oct.map((l) => [l.from, l.kind]), [['2027-03-01', 'chargers'], ['2027-10-26', 'facility']]);
  assert.equal(isWinter(local('2027-10-26')), true);
  assert.equal(isWinter(local('2027-03-01')), false);
  const seasonal = { limits: 'seasonal', capKw: 43.5, winterCapKw: 25 };
  assert.equal(capAt(at('2026-07-01T12:00:00Z'), seasonal), 43.5);
  assert.equal(capAt(at('2026-01-10T12:00:00Z'), seasonal), 25);
  assert.equal(limitAt(at('2026-01-10T12:00:00Z'), seasonal).kind, 'facility');
  assert.equal(capAt(at('2026-01-10T12:00:00Z'), { limits: 'none' }), Infinity);
  const t = at('2026-01-10T10:00:00Z');
  const profile = hourlyProfile([{ id: 'x', start: iso(t), end: iso(t + HOUR_MS), energy_kwh: 40 }], { model: 'even', ...seasonal });
  assert.equal(profile.get(t).kw, 25);
  assert.equal(profile.get(t).rawKw, 40);
});

test('charging power: from short records, and from the meter step at plug-in', () => {
  // 12 short sessions that charged the whole time at 11 kW, plus long ones that say nothing.
  const day = 86_400_000;
  const t0 = Date.parse('2026-06-01T08:00:00Z');
  const short = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, start: iso(t0 + i * day), end: iso(t0 + i * day + HOUR_MS), energy_kwh: 11 }));
  const long = [{ id: 'l', start: iso(t0), end: iso(t0 + 10 * HOUR_MS), energy_kwh: 20 }];
  assert.equal(rateFromRecords([...short, ...long]).kw, 11);
  assert.equal(rateFromRecords(short.slice(0, 3)), null); // too few to say

  // Meter: a flat 20 kW club; each day one car plugs in at 10:30 and charges 7.4 kW for hours.
  const meter = new Map();
  const sessions = [];
  for (let d = 0; d < 60; d += 1) {
    const base = Date.parse('2026-06-01T00:00:00Z') + d * day;
    for (let h = 0; h < 24; h += 1) meter.set(base + h * HOUR_MS, 20);
    if (d % 2 === 0) {
      const start = base + 10.5 * HOUR_MS;
      sessions.push({ id: `m${d}`, start: iso(start), end: iso(start + 5 * HOUR_MS), energy_kwh: 30 });
      meter.set(base + 10 * HOUR_MS, 20 + 3.7); // half the plug-in hour
      for (let h = 11; h < 15; h += 1) meter.set(base + h * HOUR_MS, 27.4);
    }
  }
  const measured = rateFromMeter(meter, sessions, { minRateKw: 5 });
  assert.equal(measured.n, 30);
  assert.ok(Math.abs(measured.kw - 7.4) < 0.01);
});

test('billedPeak averages the highest hours on different days', () => {
  const day = 86_400_000;
  const t = Date.parse('2026-03-02T10:00:00Z');
  const hours = [{ at: t, kw: 50 }, { at: t + HOUR_MS, kw: 49 }, { at: t + day, kw: 40 }, { at: t + 2 * day, kw: 30 }];
  assert.equal(billedPeak(hours, 1).kw, 50);
  assert.equal(billedPeak(hours, 3).kw, 40); // 50, 40, 30: the 49 is the same day as the 50
});

test('monthlyMeter: cost split and what the chargers add to the peak', () => {
  const t = Date.parse('2026-06-10T10:00:00Z');
  const meter = new Map([[t, 60], [t + HOUR_MS, 30], [t + 86_400_000, 45]]);
  const chargers = new Map([[t, { kw: 20 }], [t + 86_400_000, { kw: 5 }]]);
  const rows = splitHours(meter, chargers);
  assert.deepEqual(rows.map((r) => r.otherKw), [40, 30, 40]);
  const tariff = { ...DEFAULT_TARIFF, retailOre: 100, transferOre: 0, energyTaxOre: 0, fixedKr: 0, krPerKw: 100, peakCount: 1, vatPct: 0 };
  const revenue = new Map([['2026-06', 1000]]);
  const [june] = monthlyMeter(rows, { tariff, revenue });
  assert.equal(june.kwh, 135);
  assert.equal(june.peakKw, 60);
  assert.equal(june.chargersAtPeakKw, 20);
  assert.equal(june.peakWithoutChargersKw, 40);
  assert.equal(june.cost.effect, 6000);
  assert.equal(june.cost.energy, 135);
  assert.equal(june.chargers.effectCost, 2000); // (60 - 40) kW × 100 kr/kW
  assert.equal(june.chargers.energyCost, 25);
  assert.equal(june.chargers.net, 1000 - 2025);
  assert.equal(dailyPeaks(rows).length, 2);
  assert.equal(meterHours({ hourly: compactSeries(meter, 60) }).size, 3);
});

test('splitHours: under a facility ceiling the chargers only get the room left', () => {
  const t = Date.parse('2026-11-20T10:00:00Z'); // after the 25 kW ceiling began
  const meter = new Map([[t, 30], [t + HOUR_MS, 20]]);
  const chargers = new Map([[t, { kw: 8 }], [t + HOUR_MS, { kw: 8 }]]);
  const [busy, quiet] = splitHours(meter, chargers);
  assert.equal(busy.limitKind, 'facility');
  // Ceiling 36 A = 24.94 kW. Busy hour: 30 − 8 = 22 kW of other load leaves 2.94 kW.
  assert.ok(Math.abs(busy.chargerKw - 2.94) < 0.01);
  assert.equal(busy.roomKw, 0);
  // Quiet hour: 12 kW of other load leaves 12.94 kW, more than the 8 kW estimated.
  assert.equal(quiet.chargerKw, 8);
  assert.ok(Math.abs(quiet.roomKw - 12.94) < 0.01);
});
