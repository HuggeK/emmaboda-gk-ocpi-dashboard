import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cheapestWindow, monthPeakSoFar, presenceByMonthHour, priceBands, quarterPrices, typicalLoadByHour } from '../public/now.js';
import { DEFAULT_TARIFF } from '../public/meter.js';

const Q = 15 * 60_000;
const H = 3_600_000;
const T0 = Date.parse('2026-11-25T10:00:00+01:00');

test('quarterPrices: from the quarter containing now, with everything on top of spot', () => {
  const spot = { start: new Date(T0 - 2 * Q).toISOString(), step_min: 15, values: [10, 20, 30, 40, 50] };
  const q = quarterPrices(spot, T0 + 5 * 60_000, DEFAULT_TARIFF);
  assert.deepEqual(q.map((x) => x.spotOre), [30, 40, 50]);
  const onTop = DEFAULT_TARIFF.surchargeOre + DEFAULT_TARIFF.transferOre + DEFAULT_TARIFF.energyTaxOre; // 2026: flat grid fee
  assert.ok(Math.abs(q[0].totalOre - (30 + onTop)) < 1e-9);
});

test('cheapestWindow: the cheapest run of consecutive quarters', () => {
  const quarters = [50, 40, 10, 10, 10, 10, 60, 5].map((totalOre, i) => ({ at: T0 + i * Q, totalOre }));
  const w = cheapestWindow(quarters, 1);
  assert.equal(w.start, T0 + 2 * Q);
  assert.equal(w.end, T0 + 6 * Q);
  assert.equal(w.meanOre, 10);
  assert.equal(cheapestWindow(quarters.slice(0, 3), 1), null);
});

test('priceBands: thirds of the prices shown', () => {
  const b = priceBands([1, 2, 3, 4, 5, 6].map((totalOre) => ({ totalOre })));
  assert.equal(b.low, 3);
  assert.equal(b.high, 5);
});

test('monthPeakSoFar: the highest hour of the current month only', () => {
  const hours = new Map([
    [Date.parse('2026-10-31T12:00:00+01:00'), 90],
    [Date.parse('2026-11-03T12:00:00+01:00'), 40],
    [Date.parse('2026-11-20T08:00:00+01:00'), 55],
    [Date.parse('2026-11-26T08:00:00+01:00'), 99], // after now
  ]);
  const p = monthPeakSoFar(hours, T0);
  assert.equal(p.kw, 55);
});

test('typicalLoadByHour: median and busy day per clock hour', () => {
  const hours = new Map();
  for (let d = 0; d < 10; d += 1) hours.set(T0 - d * 24 * H, 10 + d); // 10:00 local each day
  const t = typicalLoadByHour(hours, T0);
  assert.equal(t[10].days, 10);
  assert.equal(t[10].median, 15);
  assert.equal(t[10].busy, 19);
  assert.equal(t[3].median, null);
});

test('presenceByMonthHour: plugged-in hours per month and hour, busiest = 1; overnight stays ignored', () => {
  const rec = (start, end) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  const july = Date.parse('2026-07-10T10:00:00+02:00');
  const m = presenceByMonthHour([rec(july, july + 2 * H), rec(july, july + H), rec(july - 10 * H, july + 10 * H)]);
  assert.equal(m[6][10], 1);
  assert.equal(m[6][11], 0.5);
  assert.equal(m[6][3], 0);
});
