import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createGoogleImageDiscovery } from '../../tools/labelfetch/google-images.mjs';

const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

describe('Google image discovery', () => {
  test('uses image mode and returns direct URLs before context pages', async () => {
    let requested = '';
    const discover = createGoogleImageDiscovery({
      key: 'key',
      cx: 'cx',
      fetchImpl: async (url) => {
        requested = String(url);
        return response(200, { items: [
          { link: 'https://producer.example/bottle.png', image: { contextLink: 'https://producer.example/wine' } },
        ] });
      },
    });

    const result = await discover('Domaine Example Cuvee bottle');
    assert.equal(new URL(requested).searchParams.get('searchType'), 'image');
    assert.equal(new URL(requested).searchParams.get('num'), '10');
    assert.equal(new URL(requested).searchParams.has('imgSize'), false);
    assert.equal(new URL(requested).searchParams.has('imgType'), false);
    assert.equal(result.searched, true);
    assert.equal(result.status, 'ok');
    assert.equal(result.returned, 1);
    assert.equal(result.blocked, 0);
    assert.deepEqual(result.items, [{
      url: 'https://producer.example/bottle.png',
      context: 'https://producer.example/wine',
      host: 'producer.example',
      title: '', width: 0, height: 0,
    }]);
  });

  test('keeps distinct direct images from the same host', async () => {
    const discover = createGoogleImageDiscovery({
      key: 'key', cx: 'cx',
      fetchImpl: async () => response(200, { items: [
        { link: 'https://importer.example/a.png' },
        { link: 'https://importer.example/b.png' },
      ] }),
    });
    assert.deepEqual((await discover('wine')).items.map((item) => item.url), [
      'https://importer.example/a.png', 'https://importer.example/b.png',
    ]);
  });

  test('filters blocked image and context hosts', async () => {
    const discover = createGoogleImageDiscovery({
      key: 'key', cx: 'cx',
      fetchImpl: async () => response(200, { items: [
        { link: 'https://images.vivino.com/wine.png', image: { contextLink: 'https://producer.example/wine' } },
        { link: 'https://producer.example/good.png', image: { contextLink: 'https://wine-searcher.com/find/wine' } },
      ] }),
    });
    const result = await discover('wine');
    assert.deepEqual(result.items, []);
    assert.equal(result.returned, 2);
    assert.equal(result.blocked, 2);
  });

  test('reports missing credentials and API failures as not searched', async () => {
    const missing = createGoogleImageDiscovery({});
    assert.deepEqual(await missing('wine'), {
      status: 'unavailable', searched: false, items: [], error: 'credentials missing', returned: 0, blocked: 0,
    });

    let calls = 0;
    const failed = createGoogleImageDiscovery({
      key: 'key', cx: 'cx',
      fetchImpl: async () => { calls++; return response(403); },
    });
    assert.equal((await failed('wine')).searched, false);
    assert.equal((await failed('another wine')).searched, false);
    assert.equal(calls, 1);
  });

  test('surfaces a permission failure and never retries it as an empty search', async () => {
    let calls = 0;
    const failed = createGoogleImageDiscovery({
      key: 'key', cx: 'cx',
      fetchImpl: async () => {
        calls++;
        return response(403, { error: { message: 'Requests from referer <empty> are blocked.' } });
      },
    });
    const first = await failed('wine');
    const second = await failed('another wine');
    assert.equal(first.status, 'unavailable');
    assert.equal(first.searched, false);
    assert.deepEqual(first.items, []);
    assert.equal(first.returned, 0);
    assert.equal(first.blocked, 0);
    assert.match(first.error, /HTTP 403.*referer.*blocked/i);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });
});
