import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBraveImageDiscovery } from '../../tools/labelfetch/brave-images.mjs';

const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

describe('Brave image discovery', () => {
  test('requests the bounded 10+5 US English window and maps source-page provenance to the original image', async () => {
    let requested = '';
    let headers = {};
    const discover = createBraveImageDiscovery({
      token: 'brave-token',
      fetchImpl: async (url, options) => {
        requested = String(url);
        headers = options.headers;
        return response(200, { query: { altered: 'corrected wine' }, results: [{
          title: 'Exact Wine',
          url: 'https://producer.example/wine',
          properties: { url: 'https://producer.example/bottle.jpg', width: 600, height: 1200 },
        }] });
      },
    });
    const result = await discover('Exact Wnie');
    const params = new URL(requested).searchParams;
    assert.equal(params.get('q'), 'Exact Wnie');
    assert.equal(params.get('count'), '15');
    assert.equal(params.get('country'), 'US');
    assert.equal(params.get('search_lang'), 'en');
    assert.equal(headers['X-Subscription-Token'], 'brave-token');
    assert.equal(result.correctedQuery, 'corrected wine');
    assert.deepEqual(result.items, [{
      url: 'https://producer.example/bottle.jpg',
      context: 'https://producer.example/wine',
      host: 'producer.example',
      title: 'Exact Wine', width: 600, height: 1200,
    }]);
  });

  test('blocks a candidate when either its original image or source page violates policy', async () => {
    const discover = createBraveImageDiscovery({ token: 'token', fetchImpl: async () => response(200, { results: [
      { url: 'https://producer.example/wine', properties: { url: 'https://images.vivino.com/a.jpg' } },
      { url: 'https://wine-searcher.com/find/wine', properties: { url: 'https://producer.example/b.jpg' } },
    ] }) });
    const result = await discover('wine');
    assert.equal(result.returned, 2);
    assert.equal(result.blocked, 2);
    assert.deepEqual(result.items, []);
  });

  test('a credential failure is an outage and is not retried as an empty search', async () => {
    let calls = 0;
    const discover = createBraveImageDiscovery({
      token: 'bad',
      fetchImpl: async () => { calls++; return response(401, { error: { detail: 'invalid subscription token' } }); },
    });
    const first = await discover('wine');
    const second = await discover('another wine');
    assert.equal(first.searched, false);
    assert.match(first.error, /HTTP 401.*invalid subscription token/);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });
});
