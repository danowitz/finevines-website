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

test('one readable anchor cannot transfer identity to an unverified group member', async () => {
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
  assert.equal(result.matchingImages, 2);
  assert.equal(result.inspectedImages, 3);
  assert.equal(result.diagnostics.selectorReceived, 3);
  assert.equal(result.diagnostics.strongestGroupImages, 2);
  assert.equal(result.diagnostics.identityAnchors, 1);
  assert.equal(result.diagnostics.explicitConflicts, 1);
  assert.equal(result.diagnostics.publishableAnchors, 1);
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

test('a clean product shot can be the center of scene and lineup corroboration', async () => {
  const result = await selector({
    pairs: [
      { a: 0, b: 1, score: 0.72, local_inliers: 8, local_ratio: 0.80 },
      { a: 0, b: 2, score: 0.68, local_inliers: 7, local_ratio: 0.80 },
      // The two scenes need not resemble one another globally.
      { a: 1, b: 2, score: 0.30, local_inliers: 2, local_ratio: 0.20 },
    ],
    evidence: [
      { id: 'clean', anchor: true },
      { id: 'scene', anchor: false },
      { id: 'lineup', anchor: false, explicitConflict: true },
    ],
  }).select({ name: 'Arrow & Branch Red Wine Napa Valley', vintage: '2012' }, [
    candidate('clean', { cleanBackground: true, width: 90, height: 335 }),
    candidate('scene', { shapeOk: false, width: 768, height: 1024 }),
    candidate('lineup', { shapeOk: false, width: 300, height: 200 }),
  ]);

  assert.equal(result.pick.id, 'clean');
  assert.equal(result.matchingImages, 3);
  assert.deepEqual(result.trace.groups[0], ['clean', 'scene', 'lineup']);
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
  assert.deepEqual(result.expansionSeeds, []);
});

test('two matching conflict-free images yield one provisional reverse-search seed', async () => {
  const result = await selector({
    pairs: [{ a: 0, b: 1, score: 0.98 }],
    evidence: [{ id: 'scene' }, { id: 'clean' }],
  }).select({ name: 'Target Wine', vintage: '2022' }, [
    candidate('scene', { width: 900, height: 1200 }),
    candidate('clean', { cleanBackground: true, width: 500, height: 900 }),
  ]);

  assert.equal(result.pick, null);
  assert.equal(result.expansionSeeds.length, 1);
  assert.equal(result.expansionSeeds[0].id, 'clean');
  assert.equal(result.expansionSeeds[0].verifiedIdentity, false);
  assert.equal(result.diagnostics.provisionalExpansionSeeds, 1);
});

test('every candidate supplied by the pipeline enters the selector', async () => {
  let inspected = 0;
  const subject = createBottleSelector({
    inspect: async () => { inspected++; return { shapeOk: false }; },
    compare: async () => [],
    read: async () => [],
  });
  await subject.select({}, Array.from({ length: 12 }, (_, index) => candidate(String(index))));
  assert.equal(inspected, 12);
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

test('an exact smaller group beats a larger sibling group without donating identity', async () => {
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
  assert.equal(result.pick.id, 'target-readable');
  assert.equal(result.matchingImages, 2);
  assert.deepEqual(result.pick.anchorIds, ['target-readable']);
});

test('reserves a reader slot for a target-relevant bottle outside a tighter sibling cluster', async () => {
  const reads = [];
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [
      { a: 0, b: 1, score: 0.99 },
      { a: 0, b: 2, score: 0.98 },
      { a: 1, b: 2, score: 0.97 },
      { a: 2, b: 3, score: 0.90 },
    ],
    read: async (_wine, candidates) => {
      reads.push(candidates.map(({ id }) => id));
      return candidates.map(({ id }) => id === 'aux-thorey-2019'
        ? { id, anchor: true, label: 'Domaine Chicotot Aux Thorey 2019' }
        : { id, anchor: false, explicitConflict: false });
    },
  });
  const result = await subject.select(
    {
      name: 'Chicotot Domaine Georges Chicotot Nuits Saint Georges 1er Cru aux Thorey',
      vintage: '2019',
    },
    [
      candidate('sibling-one', { title: 'Nuits Saint Georges Les Pruliers' }),
      candidate('sibling-two', { title: 'Nuits Saint Georges Les Saint Georges' }),
      candidate('flat-label-2020', {
        title: 'Domaine Georges Chicotot Nuits-Saint-Georges 1er Cru Aux Thorey',
        shapeOk: false,
      }),
      candidate('aux-thorey-2019', {
        title: 'Nuits-Saint-Georges 1er Cru Aux Thorey',
        url: 'https://tiger.example/images/aux-thorey-2019.png',
        cleanBackground: true,
        width: 1800,
        height: 2400,
      }),
    ],
  );

  assert.equal(reads.length, 1);
  assert.equal(reads[0].length, 3);
  assert.equal(reads[0][0], 'aux-thorey-2019');
  assert.equal(result.pick.id, 'aux-thorey-2019');
  assert.equal(result.matchingImages, 2);
});

test('target-relevant reader priority cannot override a wrong-producer conflict', async () => {
  const subject = createBottleSelector({
    inspect: async (item) => ({ visualOk: true, shapeOk: item.shapeOk, cleanBackground: item.cleanBackground }),
    compare: async () => [{ a: 0, b: 1, score: 0.96 }],
    read: async (_wine, candidates) => candidates.map(({ id }) => ({
      id,
      anchor: false,
      explicitConflict: id === 'wrong-producer',
      conflict: id === 'wrong-producer' ? 'candidate producer is not Domaine des Epeneaux' : undefined,
    })),
  });
  const result = await subject.select(
    { name: 'Domaine des Epeneaux Volnay 1er Cru les Fremiets', vintage: '2018' },
    [
      candidate('wrong-producer', {
        title: 'Volnay 1er Cru Les Fremiets 2018',
        url: 'https://wrong.example/domaine-des-epeneaux-volnay-les-fremiets-2018.jpg',
        cleanBackground: true,
      }),
      candidate('lookalike', { title: 'Volnay 1er Cru Les Fremiets' }),
    ],
  );

  assert.equal(result.trace.representatives[0], 'wrong-producer');
  assert.equal(result.pick, null);
  assert.equal(result.diagnostics.publishableAnchors, 0);
});

test('a Web Detection full match inherits identity from its verified seed', async () => {
  const result = await selector({
    pairs: [{ a: 0, b: 1, score: 0.99 }],
    evidence: [{ id: 'seed', anchor: true, label: 'Exact Wine' }],
  }).select({ name: 'Exact Wine' }, [
    candidate('seed', { cleanBackground: false, width: 400, height: 700 }),
    candidate('web-copy', {
      trustedFullMatch: true,
      cleanBackground: true,
      width: 900,
      height: 1500,
    }),
  ]);
  assert.equal(result.pick.id, 'web-copy');
  assert.deepEqual(result.pick.anchorIds, ['seed', 'web-copy']);
});

test('a provisional Web Detection copy must earn identity from its own evidence', async () => {
  const subject = selector({
    pairs: [{ a: 0, b: 1, score: 0.99 }],
    evidence: [{ id: 'seed' }, { id: 'web-copy' }],
  });
  const result = await subject.select({ name: 'Domaine Example Target Cuvee', vintage: '2022' }, [
    candidate('seed'),
    candidate('web-copy', { provisionalFullMatch: true, cleanBackground: true }),
  ]);

  assert.equal(result.pick, null);
  assert.equal(result.diagnostics.identityAnchors, 0);
});

test('an exact product title can promote a provisional Web Detection copy', async () => {
  const subject = selector({
    pairs: [{ a: 0, b: 1, score: 0.99 }],
    evidence: [{ id: 'seed' }, { id: 'web-copy' }],
  });
  const result = await subject.select({ name: 'Domaine Example Target Cuvee', vintage: '2022' }, [
    candidate('seed'),
    candidate('web-copy', {
      provisionalFullMatch: true,
      title: 'Domaine Example Target Cuvee 2022',
      cleanBackground: true,
      width: 900,
      height: 1500,
    }),
  ]);

  assert.equal(result.pick.id, 'web-copy');
  assert.deepEqual(result.sourceAnchorIds, ['web-copy']);
});
