import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createImageDiscovery,
  validateImageDiscoveryCredentials,
} from '../../tools/labelfetch/image-discovery.mjs';

test('the retired Google Custom Search provider is not accepted', () => {
  assert.throws(
    () => validateImageDiscoveryCredentials('google', { googleKey: 'key', googleCx: 'cx' }),
    /unknown image search provider: google/,
  );
});

test('the retired Serper provider is not accepted', () => {
  assert.throws(
    () => validateImageDiscoveryCredentials('serper'),
    /unknown image search provider: serper/,
  );
});

test('preflight and pipeline factory exercise the Brave image endpoint', async () => {
  const endpoints = [];
  const discover = createImageDiscovery({
    name: 'brave',
    braveKey: 'brave',
    fetchImpl: async (url) => {
      endpoints.push(String(url));
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    },
  });

  const result = await discover('wine');
  assert.equal(result.status, 'ok');
  assert.equal(result.searched, true);
  assert.deepEqual(endpoints, [
    'https://api.search.brave.com/res/v1/images/search?q=wine&country=US&search_lang=en&count=15&safesearch=strict',
  ]);
});
