import test from 'node:test';
import assert from 'node:assert/strict';
import { createBottleSelector } from '../../tools/labelfetch/bottle-selector.mjs';

const candidate = (id, overrides = {}) => ({
  id, url: `https://${id}.example/bottle.jpg`, width: 400, height: 800,
  shapeOk: true, cleanBackground: false, ...overrides,
});

function selector({ pairs = [], evidence = [] } = {}) {
  return createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => pairs,
    read: async () => evidence,
  });
}

test('one readable anchor does not transfer identity to an unreadable lookalike', async () => {
  const result = await selector({
    pairs: [{ a: 0, b: 1, score: 0.96 }, { a: 0, b: 2, score: 0.94 }],
    evidence: [
      { id: 'readable', anchor: true },
      { id: 'clean', anchor: false },
      { id: 'wrong', explicitConflict: true },
    ],
  }).select({ name: 'Wine' }, [
    candidate('readable'),
    candidate('clean', { cleanBackground: true, width: 700, height: 1200 }),
    candidate('wrong', { cleanBackground: true, width: 2000, height: 3000 }),
  ]);
  assert.equal(result.pick.id, 'readable');
  assert.equal(result.matchingImages, 3);
  assert.equal(result.inspectedImages, 3);
});

test('two independent exact result titles let a clean bottle corroborate a matching scene', async () => {
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [{ a: 0, b: 1, score: 0.65 }],
    read: async () => [
      { id: 'official', anchor: true, label: 'The Cider Farm Oak Aged' },
      { id: 'scene', anchor: true, label: 'The Cider Farm Oak Aged' },
    ],
  });
  const result = await subject.select({ name: 'Cider Farm Oak Aged Cider' }, [
    candidate('official', { title: 'Oak-Aged Cider - The Cider Farm', cleanBackground: true }),
    candidate('scene', { title: 'The Cider Farm - Oak Aged Cider', shapeOk: false }),
  ]);
  assert.equal(result.pick.id, 'official');
});

test('exact titles cannot merge visually dissimilar sibling bottles', async () => {
  let reads = 0;
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [],
    read: async () => { reads++; return [{ id: 'wrong', anchor: true }]; },
  });
  const result = await subject.select({ name: 'Domaine Chave Saint Joseph' }, [
    candidate('target', { title: 'Domaine Chave Saint Joseph' }),
    candidate('wrong', { title: 'Domaine Chave Saint Joseph' }),
  ]);
  assert.equal(result.pick, null);
  assert.equal(result.reason, 'no repeated bottle design');
  assert.equal(reads, 0);
});

test('does not call the reader when no two bottles look alike', async () => {
  let reads = 0;
  const subject = createBottleSelector({
    inspect: async () => ({ shapeOk: true, cleanBackground: true }),
    compare: async () => [],
    read: async () => { reads++; return []; },
  });
  const result = await subject.select({ name: 'Wine' }, [candidate('one'), candidate('two')]);
  assert.equal(result.pick, null);
  assert.equal(result.reason, 'no repeated bottle design');
  assert.equal(reads, 0);
});

test('similar siblings without an exact anchor remain a no-pick', async () => {
  const result = await selector({
    pairs: [{ a: 0, b: 1, score: 0.98 }],
    evidence: [{ id: 'one' }, { id: 'two', explicitConflict: true }],
  }).select({ name: 'Target' }, [candidate('one'), candidate('two')]);
  assert.equal(result.pick, null);
  assert.equal(result.reason, 'repeated designs lacked an exact readable anchor');
});

test('only the first ten search results enter the selector', async () => {
  let inspected = 0;
  const subject = createBottleSelector({
    inspect: async () => { inspected++; return { shapeOk: false }; },
    compare: async () => [],
    read: async () => [],
  });
  await subject.select({}, Array.from({ length: 12 }, (_, index) => candidate(String(index))));
  assert.equal(inspected, 10);
});
