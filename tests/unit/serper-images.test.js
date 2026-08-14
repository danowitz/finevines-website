import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSerperImageDiscovery } from '../../tools/labelfetch/serper-images.mjs';

const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

describe('Serper image discovery', () => {
  test('posts the exact query and preserves original-image/source-page pairing', async () => {
    let requested = {};
    const discover = createSerperImageDiscovery({
      apiKey: 'serper-key',
      fetchImpl: async (url, options) => {
        requested = { url, options, body: JSON.parse(options.body) };
        return response(200, { images: [{
          title: 'Exact Wine 2022',
          imageUrl: 'https://cdn.producer.example/bottle.png',
          imageWidth: 900,
          imageHeight: 1200,
          link: 'https://producer.example/wines/exact-2022',
          domain: 'producer.example',
          position: 1,
        }] });
      },
    });

    const result = await discover('Producer Exact Wine 2022');

    assert.equal(requested.url, 'https://google.serper.dev/images');
    assert.equal(requested.options.method, 'POST');
    assert.equal(requested.options.headers['X-API-KEY'], 'serper-key');
    assert.deepEqual(requested.body, {
      q: 'Producer Exact Wine 2022', gl: 'us', hl: 'en', num: 15,
    });
    assert.deepEqual(result.items, [{
      url: 'https://cdn.producer.example/bottle.png',
      context: 'https://producer.example/wines/exact-2022',
      host: 'producer.example',
      title: 'Exact Wine 2022',
      width: 900,
      height: 1200,
      discovery: 'serper',
    }]);
    assert.equal(result.status, 'ok');
    assert.equal(result.searched, true);
  });

  test('blocks the complete provenance record when either side violates policy', async () => {
    const discover = createSerperImageDiscovery({ apiKey: 'key', fetchImpl: async () => response(200, { images: [
      { imageUrl: 'https://images.vivino.com/a.jpg', link: 'https://producer.example/wine' },
      { imageUrl: 'https://producer.example/b.jpg', link: 'https://wine-searcher.com/find/wine' },
    ] }) });
    const result = await discover('wine');
    assert.equal(result.returned, 2);
    assert.equal(result.blocked, 2);
    assert.deepEqual(result.items, []);
  });

  test('credential failure is unavailable and short-circuits later calls', async () => {
    let calls = 0;
    const discover = createSerperImageDiscovery({
      apiKey: 'bad',
      fetchImpl: async () => { calls++; return response(403, { message: 'Invalid API key' }); },
    });
    const first = await discover('wine');
    const second = await discover('another wine');
    assert.equal(first.searched, false);
    assert.match(first.error, /HTTP 403.*Invalid API key/);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });
});
