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

test('one readable anchor transfers identity within its strict visual group', async () => {
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
  assert.equal(result.pick.id, 'clean');
  assert.equal(result.matchingImages, 2);
  assert.equal(result.inspectedImages, 3);
  assert.equal(result.diagnostics.selectorReceived, 3);
  assert.equal(result.diagnostics.strongestGroupImages, 2);
  assert.equal(result.diagnostics.identityAnchors, 1);
  assert.equal(result.diagnostics.explicitConflicts, 1);
  assert.equal(result.diagnostics.publishableAnchors, 2);
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
  assert.equal(result.diagnostics.repeatedGroups, 0);
  assert.equal(result.diagnostics.labelImagesRead, 0);
});

test('a wrong-vintage title cannot promote a weak visual pair', async () => {
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [{ a: 0, b: 1, score: 0.65 }],
    read: async () => [{ id: 'current', anchor: true }, { id: 'old', anchor: true }],
  });
  const result = await subject.select({ name: 'Domaine Jouan Chambolle Musigny', vintage: '2023' }, [
    candidate('current', { title: 'Domaine Jouan Chambolle Musigny 2023' }),
    candidate('old', { title: 'Domaine Jouan Chambolle Musigny 2022' }),
  ]);
  assert.equal(result.pick, null);
  assert.equal(result.reason, 'no repeated bottle design');
});

test('an exact-vintage source anchors a repeated vintage-neutral bottle when the reader returns nothing', async () => {
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [{ a: 0, b: 1, score: 0.99 }],
    read: async () => [
      { id: 'current', anchor: false, explicitConflict: false },
      { id: 'older', anchor: false, explicitConflict: false },
    ],
  });
  const result = await subject.select(
    { name: 'Domaine Philippe Jouan Chambolle Musigny', vintage: '2023' },
    [
      candidate('current', { title: '2023 Domaine Henri & Philippe Jouan Chambolle Musigny' }),
      candidate('older', { title: 'Domaine Henri & Philippe Jouan Chambolle Musigny 2022' }),
    ],
  );
  assert.equal(result.pick.id, 'current');
  assert.deepEqual(result.sourceAnchorIds, ['current']);
  assert.equal(result.diagnostics.sourceIdentityAnchors, 1);
});

test('an exact source title cannot override a readable identity conflict', async () => {
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [{ a: 0, b: 1, score: 0.99 }],
    read: async () => [
      { id: 'current', anchor: false, explicitConflict: true, conflict: 'different cuvee' },
      { id: 'older', anchor: false, explicitConflict: false },
    ],
  });
  const result = await subject.select(
    { name: 'Domaine Philippe Jouan Chambolle Musigny', vintage: '2023' },
    [
      candidate('current', { title: '2023 Domaine Philippe Jouan Chambolle Musigny' }),
      candidate('older', { title: 'Domaine Philippe Jouan Chambolle Musigny 2022' }),
    ],
  );
  assert.equal(result.pick, null);
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
  assert.equal(result.diagnostics.strongestGroupImages, 2);
  assert.equal(result.diagnostics.identityAnchors, 0);
  assert.equal(result.diagnostics.explicitConflicts, 1);
  assert.equal(result.reviewCandidates.length, 2);
  assert.equal(result.reviewCandidates[0].displayOk, true);
  assert.match(result.reviewCandidates[1].why, /identity not proven|conflict/i);
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

test('returns candidate-level trace through inspection, comparison, grouping, and identity', async () => {
  const result = await selector({
    pairs: [{ a: 0, b: 1, score: 0.96 }],
    evidence: [{ id: 'one', anchor: true, label: 'Exact Wine' }, { id: 'two', anchor: true }],
  }).select({ name: 'Exact Wine' }, [candidate('one'), candidate('two')]);

  assert.deepEqual(result.trace.inspections.map(({ id, shapeOk }) => ({ id, shapeOk })), [
    { id: 'one', shapeOk: true },
    { id: 'two', shapeOk: true },
  ]);
  assert.deepEqual(result.trace.pairs, [{ a: 0, b: 1, score: 0.96 }]);
  assert.deepEqual(result.trace.groups, [['one', 'two']]);
  assert.deepEqual(result.trace.representatives, ['one', 'two']);
  assert.equal(result.trace.evidence[0].label, 'Exact Wine');
  assert.equal(result.trace.pick, 'one');
});

test('weak transitive lookalikes cannot pull a sibling wine into the strongest group', async () => {
  const result = await selector({
    pairs: [
      { a: 0, b: 1, score: 0.96 },
      { a: 0, b: 2, score: 0.92 },
      { a: 1, b: 2, score: 0.94 },
      { a: 2, b: 3, score: 0.93 },
      { a: 0, b: 3, score: 0.70 },
      { a: 1, b: 3, score: 0.72 },
    ],
    evidence: [
      { id: 'target-1', anchor: true },
      { id: 'target-2', anchor: true },
      { id: 'target-scene', anchor: true },
    ],
  }).select({ name: 'Domaine Philippe Jouan Chambolle Musigny' }, [
    candidate('target-1'), candidate('target-2'), candidate('target-scene'),
    candidate('wrong-sibling', { width: 2000, height: 3000 }),
  ]);

  assert.deepEqual(result.trace.groups[0], ['target-1', 'target-2', 'target-scene']);
  assert.equal(result.pick.id, 'target-1');
});

test('an exact smaller group beats a larger sibling group and can donate identity to its clean member', async () => {
  const reads = [];
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [
      { a: 0, b: 1, score: 0.98 },
      { a: 0, b: 2, score: 0.97 },
      { a: 1, b: 2, score: 0.96 },
      { a: 3, b: 4, score: 0.99 },
    ],
    read: async (_wine, candidates) => {
      reads.push(candidates.map(({ id }) => id));
      return candidates.map(({ id }) => id === 'target-readable'
        ? { id, anchor: true, label: 'Domaine Paul Prieur Sancerre 2022' }
        : { id, anchor: false, explicitConflict: false });
    },
  });
  const result = await subject.select(
    { name: 'Domaine Paul Prieur Sancerre Blanc', vintage: '2022' },
    [
      candidate('sibling-1'), candidate('sibling-2'), candidate('sibling-3'),
      candidate('target-readable', {
        title: '2022 Domaine Paul Prieur Sancerre Blanc',
        width: 400,
        height: 700,
      }),
      candidate('target-clean', { cleanBackground: true, width: 900, height: 1500 }),
    ],
  );

  assert.deepEqual(reads, [['target-readable', 'target-clean', 'sibling-1']]);
  assert.equal(result.pick.id, 'target-clean');
  assert.equal(result.matchingImages, 2);
  assert.deepEqual(result.pick.anchorIds, ['target-readable']);
});
