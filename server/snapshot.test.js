import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from './demo-data.js';
import { buildSnapshot, stripPersonalFields } from './snapshot.js';

test('stripPersonalFields removes token ids at any depth and keeps the rest', () => {
  const input = { token_uid: 'a', nested: [{ contract_id: 'b', keep: 1 }], keep: 'x', empty: null };
  assert.deepEqual(stripPersonalFields(input), { nested: [{ keep: 1 }], keep: 'x', empty: null });
});

test('buildSnapshot returns the shapes the UI reads, without personal fields', async () => {
  const now = new Date();
  const snapshot = await buildSnapshot({ client: createDemoClient(), now, cdrDays: 60, generator: 'demo' });

  assert.equal(snapshot.status.mode, 'snapshot');
  assert.equal(snapshot.status.generator, 'demo');
  assert.equal(snapshot.status.generated_at, now.toISOString());
  assert.equal(snapshot.status.discovery.version, '2.2.1');
  assert.equal(snapshot.status.cdr_window.days, 60);
  assert.ok(snapshot.locations.length > 0);
  assert.equal(snapshot.live.summary.evses_total, snapshot.locations.reduce((n, l) => n + l.evses.length, 0));
  assert.ok(snapshot.cdrs.items.length > 0);
  assert.equal(snapshot.status.counts.cdrs, snapshot.cdrs.items.length);

  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes('"token_uid"'), 'token_uid must not be published');
  assert.ok(!text.includes('"contract_id"'), 'contract_id must not be published');
  assert.ok(!text.includes('tokenPreview'), 'no part of the token may be published');
});

test('buildSnapshot can keep personal fields for local use', async () => {
  const snapshot = await buildSnapshot({ client: createDemoClient(), cdrDays: 60, keepPersonalFields: true });
  assert.ok(snapshot.cdrs.items.some((c) => c.token_uid));
});
