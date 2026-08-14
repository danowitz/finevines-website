import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createImageDiscovery,
  validateImageDiscoveryCredentials,
} from '../../tools/labelfetch/image-discovery.mjs';

test('combined discovery requires both provider credentials before any request', () => {
  assert.throws(
    () => validateImageDiscoveryCredentials('brave-serper', { braveKey: 'brave' }),
    /Serper image credentials are missing/,
  );
});

test('preflight and pipeline factory exercise both combined endpoints', async () => {
  const endpoints = [];
  const discover = createImageDiscovery({
    name: 'brave-serper',
    braveKey: 'brave',
    serperKey: 'serper',
    fetchImpl: async (url) => {
      endpoints.push(String(url));
      return String(url).includes('brave.com')
        ? { ok: true, status: 200, json: async () => ({ results: [] }) }
        : { ok: true, status: 200, json: async () => ({ images: [] }) };
    },
  });

  const result = await discover('wine');
  assert.equal(result.complete, true);
  assert.deepEqual(endpoints.sort(), [
    'https://api.search.brave.com/res/v1/images/search?q=wine&country=US&search_lang=en&count=15&safesearch=strict',
    'https://google.serper.dev/images',
  ]);
});
