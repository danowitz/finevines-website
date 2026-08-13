import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebMatchExpander } from '../../tools/labelfetch/web-match-expander.mjs';

test('returns only provenance-paired permitted full matches and preserves anchor trust', async () => {
  let request;
  const expand = createWebMatchExpander({
    apiKey: 'vision-key',
    readFileImpl: async () => Buffer.from('anchor'),
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ responses: [{ webDetection: {
        pagesWithMatchingImages: [
          { url: 'https://producer.test/wine', pageTitle: 'Exact wine', fullMatchingImages: [
            { url: 'https://seed.test/a.jpg', score: 1 },
            { url: 'https://cdn.producer.test/bottle.jpg', score: 0.99 },
          ] },
          { url: 'https://vivino.com/wine', fullMatchingImages: [
            { url: 'https://clean.test/bottle.jpg', score: 0.98 },
          ] },
        ],
        visuallySimilarImages: [{ url: 'https://producer.test/sibling.jpg' }],
      } }] }) };
    },
  });
  const result = await expand([{ id: 'anchor-1', file: 'anchor.png', url: 'https://seed.test/a.jpg' }]);
  assert.match(request.url, /vision\.googleapis\.com/);
  assert.equal(request.headers['x-goog-api-key'], 'vision-key');
  assert.equal(request.body.requests[0].features[0].type, 'WEB_DETECTION');
  assert.equal(result.requests, 1);
  assert.equal(result.blocked, 1);
  assert.deepEqual(result.corroborationPages, [{
    url: 'https://producer.test/wine',
    title: 'Exact wine',
    fullMatches: ['https://seed.test/a.jpg', 'https://cdn.producer.test/bottle.jpg'],
    partialMatches: [],
  }]);
  assert.deepEqual(result.items, [{
    url: 'https://cdn.producer.test/bottle.jpg',
    context: 'https://producer.test/wine',
    host: 'producer.test',
    title: 'Exact wine',
    width: 0,
    height: 0,
    trustedFullMatch: true,
    identityAnchorUrl: 'https://seed.test/a.jpg',
    discovery: 'google-web-detection',
  }]);
});

test('missing credentials disable expansion without turning a wine into a miss', async () => {
  const result = await createWebMatchExpander()([{ id: 'anchor' }]);
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.items, []);
});
