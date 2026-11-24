import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainPeak, inHours, FACILITY_LOADS } from '../public/facility.js';
import { typicalDay, monthlyTopHours } from '../public/meter.js';
import { HOUR_MS, isWinter } from '../public/analysis.js';

const at = (y, mo, d, h) => new Date(y, mo - 1, d, h).getTime();

test('inHours wraps past midnight', () => {
  assert.equal(inHours(23, [22, 3]), true);
  assert.equal(inHours(2, [22, 3]), true);
  assert.equal(inHours(3, [22, 3]), false);
  assert.equal(inHours(12, [9, 15]), true);
  assert.equal(inHours(15, [9, 15]), false);
});

test('explainPeak: irrigation at night in season, heating on winter days, chargers estimated', () => {
  const night = explainPeak({ at: at(2025, 5, 12, 23), meterKw: 49, chargerKw: 0 }, { isWinter });
  assert.deepEqual(night.causes.map((c) => c.key), ['irrigation']);
  assert.equal(night.causes[0].confidence, 'likely');

  const summerDay = explainPeak({ at: at(2025, 7, 13, 11), meterKw: 52, chargerKw: 23 }, { isWinter });
  assert.deepEqual(summerDay.causes.map((c) => c.key), ['chargers', 'daytime']);
  assert.equal(summerDay.causes[0].confidence, 'estimated');

  const winterDay = explainPeak({ at: at(2026, 2, 11, 9), meterKw: 39, chargerKw: 0 }, { isWinter });
  assert.deepEqual(winterDay.causes.map((c) => c.key), ['heating']);

  const odd = explainPeak({ at: at(2025, 12, 24, 16), meterKw: 32, chargerKw: 0 }, { isWinter });
  assert.deepEqual(odd.causes.map((c) => c.key), ['unexplained']);
});

test('the published load descriptions do not give away the number of golf carts', () => {
  const text = JSON.stringify(FACILITY_LOADS);
  assert.ok(!/\b\d+\s*(golf ?carts|golfbilar)/i.test(text));
  assert.ok(!/11 kW together/.test(text));
});

test('typicalDay and monthlyTopHours', () => {
  const rows = [];
  for (let d = 1; d <= 30; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const kw = h === 23 ? 40 + d / 10 : 15;
      rows.push({ at: at(2025, 6, d, h), meterKw: kw, chargerKw: 0, otherKw: kw });
    }
  }
  const day = typicalDay(rows);
  assert.equal(day[23].otherAvg > 40, true);
  assert.equal(day[3].otherAvg, 15);
  const tops = monthlyTopHours(rows, 3);
  assert.equal(tops.length, 3);
  assert.ok(tops.every((t) => new Date(t.at).getHours() === 23 && t.complete));
  assert.equal(tops[0].rank, 1);
  assert.equal(new Date(tops[0].at).getDate(), 30);
  assert.ok(HOUR_MS > 0);
});
