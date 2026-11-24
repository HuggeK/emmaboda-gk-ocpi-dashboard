import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, limitSavings, priceAdvice, monthsIn, winterCeilingCheck, nightOffCheck, DEFAULT_COSTS } from '../public/economics.js';
import { BILL, billTotal } from '../public/contracts.js';
import { HOUR_MS } from '../public/analysis.js';

const tariff = { retailOre: 80, transferOre: 20, energyTaxOre: 36, fixedKr: 0, krPerKw: 120, peakCount: 1, vatPct: 25 };
const rec = (id, start, kwh, priceInclVat = 5) => ({ id, start, end: new Date(Date.parse(start) + 2 * HOUR_MS).toISOString(), energy_kwh: kwh, cost_incl_vat: kwh * priceInclVat, cost_excl_vat: (kwh * priceInclVat) / 1.25 });

test('monthsIn counts calendar months, partial ones included', () => {
  assert.deepEqual(monthsIn(new Date(2026, 0, 15).getTime(), new Date(2026, 2, 1).getTime()), ['2026-01', '2026-02']);
});

test('account: revenue, electricity, ChargeNode, system, effektavgift range and break-even', () => {
  const records = [rec('a', '2026-06-10T10:00:00Z', 100), rec('b', '2026-07-10T10:00:00Z', 100)];
  const period = { from: new Date(2026, 5, 1).getTime(), to: new Date(2026, 7, 1).getTime() };
  const chargerMonths = [{ month: '2026-06', peakKw: 10 }, { month: '2026-07', peakKw: 20 }];
  const costs = { ...DEFAULT_COSTS, chargeNodePerPointMonth: 10, chargeNodeSharePct: 10, eonMeterKrMonth: 19, systemSince: '2026-01' };
  // Before the subscriptions started, the system cost nothing.
  assert.equal(account({ records, period, tariff, costs: { ...costs, systemSince: '2026-07' }, chargerMonths }).system, 19);
  const a = account({ records, period, tariff, costs, points: 6, chargerMonths });
  assert.equal(a.kwh, 200);
  assert.equal(a.revenueInclVat, 1000);
  assert.equal(a.revenue, 800);
  assert.ok(Math.abs(a.energyCost - 272) < 1e-9); // 200 kWh × 1.36 kr
  assert.ok(Math.abs(a.chargeNode - (10 * 6 * 2 + 80)) < 1e-9);
  assert.equal(a.system, 38);
  assert.equal(a.effekt.measured, null);
  assert.equal(a.effekt.worst, 30 * 120);
  assert.ok(Math.abs(a.net.none - (800 - 272 - 200 - 38)) < 1e-9);
  assert.ok(Math.abs(a.breakEven.none - ((272 + 200 + 38) / 200) * 1.25) < 1e-9);
  // Measured months replace the worst case.
  const meterMonths = [{ month: '2026-06', chargers: { effectCost: 0 } }, { month: '2026-07', chargers: { effectCost: 600 } }];
  const b = account({ records, period, tariff, costs, points: 6, chargerMonths, meterMonths });
  assert.equal(b.effekt.measured, 600);
  assert.equal(b.effekt.expected, 600);
});

test('priceAdvice: ok, warn (depends on the peaks) and bad', () => {
  const base = { months: 12, effektRoom: 12000, effektRoomKwMonths: 100 };
  assert.equal(priceAdvice({ ...base, effekt: { measured: null, measuredMonths: 0 }, breakEven: { none: 2, expected: 3, worst: 4 } }).level, 'ok');
  assert.equal(priceAdvice({ ...base, effekt: { measured: null, measuredMonths: 0 }, breakEven: { none: 2, expected: 7, worst: 7.8 } }).level, 'warn');
  assert.equal(priceAdvice({ ...base, effekt: { measured: 5000, measuredMonths: 12 }, breakEven: { none: 2, expected: 6, worst: 7.8 } }).level, 'bad');
  assert.match(priceAdvice({ ...base, effekt: { measured: null, measuredMonths: 0 }, breakEven: { none: 2, expected: 3, worst: 4 } }).market, /Within/);
});

test('nightOffCheck: only night charging that sets the peak counts as a saving', () => {
  const day = new Date(2025, 4, 10, 12).getTime();
  const night = new Date(2025, 4, 11, 23).getTime();
  const rows = [
    { at: day, meterKw: 50, chargerKw: 20, otherKw: 30 }, // the month's peak is in the daytime
    { at: night, meterKw: 45, chargerKw: 11, otherKw: 34 }, // irrigation plus a car at night
  ];
  const r = nightOffCheck(rows, { from: 22, to: 6, krPerKw: 100, marginPerKwh: 2 });
  assert.equal(r.savedKr, 0); // the daytime hour still sets the peak
  assert.equal(r.nightKwh, 11);
  assert.equal(r.lostMarginKr, 22);
  const r2 = nightOffCheck([{ ...rows[0], meterKw: 40, chargerKw: 10 }, rows[1]], { from: 22, to: 6, krPerKw: 100, marginPerKwh: 2 });
  assert.equal(r2.savedKr, 500); // peak 45 at night → 40 in the daytime
});

test('the bill parts add up to the export totals', () => {
  assert.equal(billTotal(BILL[0]), 315099);
  assert.equal(billTotal(BILL[1]), 254079);
  assert.ok(!JSON.stringify(BILL).match(/735999|559064/), 'no meter id or org number');
});

test('winterCeilingCheck: saved effektavgift against the charging the ceiling holds back', () => {
  const t = new Date(2025, 11, 10, 12).getTime(); // December 2025, a winter month
  const rows = [
    { at: t, otherKw: 30, meterKw: 41, chargerKw: 11 }, // the club alone above 25 kW: chargers get nothing
    { at: t + HOUR_MS, otherKw: 20, meterKw: 31, chargerKw: 11 }, // 5 kW of room
    { at: new Date(2026, 6, 1, 12).getTime(), otherKw: 40, meterKw: 40, chargerKw: 0 }, // summer: ignored
  ];
  const unlimited = new Map([[t, { rawKw: 11 }], [t + HOUR_MS, { rawKw: 11 }]]);
  const [w] = winterCeilingCheck(rows, unlimited, { ceilingKw: 25, krPerKw: 100, marginPerKwh: 2, now: new Date(2026, 5, 1).getTime() });
  assert.equal(w.winter, '2025/26');
  assert.equal(w.addedWithoutKr, 11 * 100); // peak 41 instead of 30
  assert.equal(w.addedWithKr, 0); // with the ceiling the peak stays 30
  assert.equal(w.heldKwh, 11 + 6);
  assert.equal(w.netKr, 1100 - 17 * 2);
});

test('limitSavings: what the chargers would have added unlimited, minus what they added', () => {
  const t = Date.parse('2026-11-20T10:00:00Z');
  // Rest of the club 20 kW; under the ceiling the chargers got 5 kW; unlimited they would have drawn 22.
  const rows = [{ at: t, meterKw: 25, chargerKw: 5, otherKw: 20 }, { at: t + HOUR_MS, meterKw: 18, chargerKw: 0, otherKw: 18 }];
  const unlimited = new Map([[t, { rawKw: 22 }]]);
  const [m] = limitSavings(rows, unlimited, { krPerKw: 120 });
  assert.equal(m.actualKw, 25);
  assert.equal(m.withoutChargersKw, 20);
  assert.equal(m.unlimitedKw, 42);
  assert.equal(m.addedKr, 600);
  assert.equal(m.savedKr, 17 * 120);
});
