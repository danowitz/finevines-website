import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebMatchExpander } from '../../tools/labelfetch/web-match-expander.mjs';

test('returns provenance-paired permitted full matches and preserves anchor trust', async () => {
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
        visuallySimilarImages: [],
      } }] }) };
    },
  });
  const result = await expand([{
    id: 'anchor-1', file: 'anchor.png', url: 'https://seed.test/a.jpg', verifiedIdentity: true,
  }]);
  assert.match(request.url, /vision\.googleapis\.com/);
  assert.equal(request.headers['x-goog-api-key'], 'vision-key');
  assert.equal(request.body.requests[0].features[0].type, 'WEB_DETECTION');
  assert.equal(request.body.requests[0].image.content, Buffer.from('anchor').toString('base64'));
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
    provisionalFullMatch: false,
    webMatchKind: 'full',
    identityAnchorUrl: 'https://seed.test/a.jpg',
    discovery: 'google-web-detection',
  }]);
});

test('uses the injected label-crop preparation seam', async () => {
  let prepared;
  let content;
  const expand = createWebMatchExpander({
    apiKey: 'vision-key',
    prepareSeed: async (seed) => {
      prepared = seed;
      return Buffer.from('cropped-label');
    },
    fetchImpl: async (_url, options) => {
      content = JSON.parse(options.body).requests[0].image.content;
      return { ok: true, json: async () => ({ responses: [{}] }) };
    },
  });
  const seed = { id: 'seed', file: 'bottle.png' };
  await expand([seed]);

  assert.equal(prepared, seed);
  assert.equal(content, Buffer.from('cropped-label').toString('base64'));
});

test('missing credentials disable expansion without turning a wine into a miss', async () => {
  const result = await createWebMatchExpander()([{ id: 'anchor' }]);
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.items, []);
});

test('a full match from a provisional seed does not inherit verified identity', async () => {
  const expand = createWebMatchExpander({
    apiKey: 'vision-key',
    readFileImpl: async () => Buffer.from('hypothesis'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ responses: [{ webDetection: {
      pagesWithMatchingImages: [{
        url: 'https://merchant.test/target-wine-2022',
        pageTitle: 'Target Wine 2022',
        fullMatchingImages: [{ url: 'https://merchant.test/bottle.jpg' }],
      }],
    } }] }) }),
  });
  const result = await expand([{
    id: 'pair-seed', file: 'seed.png', url: 'https://seed.test/a.jpg', verifiedIdentity: false,
  }]);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].trustedFullMatch, false);
  assert.equal(result.items[0].provisionalFullMatch, true);
  assert.equal(result.items[0].webMatchKind, 'full');
});

test('partial results remain provisional and unpaired similar images are excluded', async () => {
  const expand = createWebMatchExpander({
    apiKey: 'vision-key',
    readFileImpl: async () => Buffer.from('anchor'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ responses: [{ webDetection: {
      pagesWithMatchingImages: [{
        url: 'https://merchant.test/wine',
        pageTitle: 'Requested Wine 2022',
        partialMatchingImages: [
          { url: 'https://merchant.test/partial.jpg' },
          { url: 'https://vivino.com/blocked.jpg' },
        ],
      }],
      visuallySimilarImages: [{ url: 'https://images.test/similar.jpg' }],
    } }] }) }),
  });
  const result = await expand([{
    id: 'verified-seed', file: 'seed.png', url: 'https://seed.test/a.jpg', verifiedIdentity: true,
  }]);

  assert.deepEqual(result.items.map(({ webMatchKind, trustedFullMatch, context }) => ({
    webMatchKind, trustedFullMatch, context,
  })), [
    { webMatchKind: 'partial', trustedFullMatch: false, context: 'https://merchant.test/wine' },
  ]);
  assert.equal(result.blocked, 1);
});
