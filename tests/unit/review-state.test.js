import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createClient } from '@libsql/client';
import { ActiveWineLockError, createReviewState } from '../../edge/review-console/review-state.mjs';

const clients = [];
afterEach(() => {
  while (clients.length) clients.pop().close();
});

function stateAt(iso = '2026-08-16T12:00:00.000Z') {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  return createReviewState({ client, now: () => new Date(iso) });
}

function action(id, { wineRevision = 'a'.repeat(64), sku = '500740*' } = {}) {
  return {
    schemaVersion: 1,
    id,
    environment: 'test',
    reviewer: 'barb.fultz@finevines.com',
    sku,
    kind: 'image-select',
    packageId: 'pkg-1',
    targetCatalogCommit: 'abcdef1',
    wineRevision,
    candidateId: 'candidate-1',
    submittedAt: '2026-08-16T12:00:00.000Z',
    csrfSessionId: 'session-1',
  };
}

describe('review state', () => {
  it('atomically queues only one active action for a wine revision', async () => {
    const state = stateAt();
    await state.initialize();

    const results = await Promise.allSettled([
      state.queue(action('00000000-0000-4000-8000-000000000001')),
      state.queue(action('00000000-0000-4000-8000-000000000002')),
    ]);

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.ok(rejected.reason instanceof ActiveWineLockError);
    assert.equal(rejected.reason.sku, '500740*');
    assert.deepEqual(await state.counts(), {
      needsDecision: 0,
      queued: 1,
      processing: 0,
      completed: 0,
      needsAttention: 0,
      oldestPendingAt: '2026-08-16T12:00:00.000Z',
    });
  });
});
