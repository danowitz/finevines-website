import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFunnel } from '../../tools/labelfetch/funnel-store.mjs';

test('stores a compact durable rule funnel without candidate file paths', () => {
  const store = {};
  recordFunnel(store, {
    slug: 'wine-2022', sku: '1', name: 'Wine', ok: false,
    failureStage: 'identity-anchor', tried: [{ why: 'no anchor' }],
    funnel: { searchResults: 10, identityAnchors: 0 },
    evidence: [{ id: 'candidate-1', explicitConflict: true, conflict: { expected: '2022', visible: '2021' }, file: 'ignored.png' }],
  }, new Date('2026-08-11T00:00:00Z'));
  assert.deepEqual(store['wine-2022'], {
    slug: 'wine-2022', sku: '1', name: 'Wine', ok: false,
    failureStage: 'identity-anchor', reason: 'no anchor',
    funnel: { searchResults: 10, identityAnchors: 0 },
    evidence: [{ id: 'candidate-1', anchor: false, explicitConflict: true, conflict: { expected: '2022', visible: '2021' } }],
    updatedAt: '2026-08-11T00:00:00.000Z',
  });
});
