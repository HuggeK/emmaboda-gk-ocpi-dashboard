import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from './demo-data.js';
import { buildSnapshot, buildEmptySnapshot, stripPersonalFields } from './snapshot.js';

test('stripPersonalFields removes token ids at any depth and keeps the rest', () => {
  const input = { token_uid: 'a', nested: [{ contract_id: 'b', keep: 1 }], keep: 'x', empty: null };
  assert.deepEqual(stripPersonalFields(input), { nested: [{ keep: 1 }], keep: 'x', empty: null });
});

test('buildSnapshot returns the shapes the UI reads, without personal fields', async () => {
  const now = new Date();
  const snapshot = await buildSnapshot({ client: createDemoClient(), now, generator: 'demo' });

  assert.equal(snapshot.status.mode, 'snapshot');
  assert.equal(snapshot.status.generator, 'demo');
  assert.equal(snapshot.status.generated_at, now.toISOString());
  assert.equal(snapshot.status.discovery.version, '2.2.1');
  assert.equal(snapshot.status.cdr_window.incremental, false);
  assert.equal(snapshot.status.cdr_window.from, snapshot.cdrs.items.at(-1).start); // earliest record
  assert.equal(snapshot.status.counts.cdr_fetched, snapshot.cdrs.items.length);
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
  const snapshot = await buildSnapshot({ client: createDemoClient(), keepPersonalFields: true });
  assert.ok(snapshot.cdrs.items.some((c) => c.token_uid));
});

test('buildSnapshot extends a previous snapshot with only the records changed since it was built', async () => {
  const client = createDemoClient();
  const now = new Date();
  const full = await buildSnapshot({ client, now, generator: 'demo' });
  // Pretend the base was built ten days ago: only records updated in the
  // last twelve days (ten plus the two-day overlap) are fetched again.
  const base = { ...full, status: { ...full.status, generated_at: new Date(now.getTime() - 10 * 86_400_000).toISOString() } };
  const extended = await buildSnapshot({ client, now, generator: 'demo', base });

  assert.equal(extended.status.cdr_window.incremental, true);
  assert.ok(extended.status.counts.cdr_fetched < full.cdrs.items.length);
  assert.ok(extended.status.counts.cdr_fetched > 0);
  assert.equal(extended.cdrs.items.length, full.cdrs.items.length); // nothing lost, nothing duplicated
  assert.deepEqual(extended.cdrs.items.map((c) => c.id), full.cdrs.items.map((c) => c.id));
  assert.equal(extended.status.cdr_window.from, full.status.cdr_window.from);

  // A base from another source, or one without data, is ignored.
  const foreign = { ...base, status: { ...base.status, versionsUrl: 'https://elsewhere.example/versions' } };
  assert.equal((await buildSnapshot({ client, now, generator: 'demo', base: foreign })).status.cdr_window.incremental, false);
  const empty = { ...base, status: { ...base.status, data_error: { code: 'UNAUTHORIZED' } } };
  assert.equal((await buildSnapshot({ client, now, generator: 'demo', base: empty })).status.cdr_window.incremental, false);
});

test('buildEmptySnapshot keeps the connection facts and carries the data error', async () => {
  const client = createDemoClient();
  const discovery = await client.discover();
  const dataError = { message: 'The OCPI server rejected the token (HTTP 401)', code: 'UNAUTHORIZED', httpStatus: 401, url: 'https://example.test/locations' };
  const snapshot = buildEmptySnapshot({ client, discovery, dataError, generator: 'github-actions' });

  assert.equal(snapshot.status.mode, 'snapshot');
  assert.equal(snapshot.status.generator, 'github-actions');
  assert.deepEqual(snapshot.status.data_error, dataError);
  assert.equal(snapshot.status.discovery.version, '2.2.1');
  assert.deepEqual(snapshot.locations, []);
  assert.deepEqual(snapshot.cdrs.items, []);
  assert.equal(snapshot.live.summary.evses_total, 0);
  assert.equal(snapshot.status.counts.cdrs, 0);
});
