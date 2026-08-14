import assert from 'node:assert/strict';
import test from 'node:test';
import { createCombinedImageDiscovery } from '../../tools/labelfetch/combined-image-discovery.mjs';

const result = (provider, items, overrides = {}) => ({
  status: 'ok', searched: true, returned: items.length, blocked: 0, error: '',
  correctedQuery: '', trace: items.map((item, index) => ({ index: index + 1, outcome: 'permitted', image: item.url })),
  items: items.map((item) => ({ ...item, discovery: provider })),
  ...overrides,
});

test('combines independent indexes fairly and deduplicates identical image URLs', async () => {
  const discover = createCombinedImageDiscovery({ providers: [
    { name: 'brave', discover: async () => result('brave', [
      { url: 'https://a.test/1.jpg' }, { url: 'https://same.test/bottle.jpg' }, { url: 'https://a.test/3.jpg' },
    ]) },
    { name: 'serper', discover: async () => result('serper', [
      { url: 'https://b.test/1.jpg' }, { url: 'https://same.test/bottle.jpg' }, { url: 'https://b.test/3.jpg' },
    ]) },
  ], limit: 5 });

  const output = await discover('exact wine');

  assert.deepEqual(output.items.map((item) => item.url), [
    'https://a.test/1.jpg', 'https://b.test/1.jpg',
    'https://same.test/bottle.jpg', 'https://a.test/3.jpg', 'https://b.test/3.jpg',
  ]);
  assert.equal(output.status, 'ok');
  assert.equal(output.complete, true);
  assert.deepEqual(output.providers.map(({ name, searched }) => ({ name, searched })), [
    { name: 'brave', searched: true }, { name: 'serper', searched: true },
  ]);
});

test('a partial provider outage remains visible and makes the miss non-final', async () => {
  const discover = createCombinedImageDiscovery({ providers: [
    { name: 'brave', discover: async () => result('brave', [], {
      status: 'unavailable', searched: false, error: 'HTTP 503',
    }) },
    { name: 'serper', discover: async () => result('serper', [{ url: 'https://b.test/1.jpg' }]) },
  ] });

  const output = await discover('exact wine');
  assert.equal(output.status, 'partial');
  assert.equal(output.searched, true);
  assert.equal(output.complete, false);
  assert.match(output.error, /brave: HTTP 503/);
  assert.equal(output.items.length, 1);
});

test('all providers unavailable is an outage rather than an empty result', async () => {
  const unavailable = (error) => ({ status: 'unavailable', searched: false, complete: false, items: [], returned: 0, blocked: 0, error, trace: [] });
  const discover = createCombinedImageDiscovery({ providers: [
    { name: 'brave', discover: async () => unavailable('bad brave key') },
    { name: 'serper', discover: async () => unavailable('bad serper key') },
  ] });

  const output = await discover('exact wine');
  assert.equal(output.status, 'unavailable');
  assert.equal(output.searched, false);
  assert.equal(output.complete, false);
  assert.deepEqual(output.items, []);
});

test('an unexpected provider exception is isolated as a partial outage', async () => {
  const discover = createCombinedImageDiscovery({ providers: [
    { name: 'brave', discover: async () => { throw new Error('socket reset'); } },
    { name: 'serper', discover: async () => result('serper', [{ url: 'https://b.test/1.jpg' }]) },
  ] });

  const output = await discover('exact wine');
  assert.equal(output.status, 'partial');
  assert.equal(output.complete, false);
  assert.match(output.error, /brave: socket reset/);
  assert.equal(output.items.length, 1);
});
