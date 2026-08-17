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

const packageWines = [
  { sku: '500740*', wineRevision: 'a'.repeat(64) },
  { sku: '500741*', wineRevision: 'b'.repeat(64) },
  { sku: '500742*', wineRevision: 'c'.repeat(64) },
];

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

  it('queues different wines independently and returns durable package status', async () => {
    const state = stateAt();
    await state.initialize();
    const first = action('00000000-0000-4000-8000-000000000011');
    const second = action('00000000-0000-4000-8000-000000000012', { wineRevision: 'b'.repeat(64), sku: '500741*' });
    await Promise.all([state.queue(first), state.queue(second)]);
    await state.transition(first.id, 'queued', 'processing', 'worker claimed action');
    await state.transition(first.id, 'processing', 'completed', 'deployment verified');
    await state.transition(second.id, 'queued', 'needs_attention', 'catalog revision changed');

    assert.deepEqual(await state.packageStatus('test', packageWines), {
      counts: { needsDecision: 1, queued: 0, processing: 0, completed: 1, needsAttention: 1 },
      oldestPendingAt: null,
      decisions: [packageWines[2]],
      statuses: {
        ['a'.repeat(64)]: { actionId: first.id, status: 'completed', attentionReason: '' },
        ['b'.repeat(64)]: { actionId: second.id, status: 'needs_attention', attentionReason: 'catalog revision changed' },
      },
    });
    assert.deepEqual(await state.actionStatus(second.id, 'test'), {
      id: second.id, status: 'needs_attention', attentionReason: 'catalog revision changed',
      submittedAt: second.submittedAt, startedAt: '', completedAt: '',
    });
  });

  it('claims at most fifty actions and leaves an immediate continuation signal', async () => {
    const state = stateAt();
    await state.initialize();
    for (let index = 1; index <= 51; index += 1) {
      const suffix = String(index).padStart(12, '0');
      await state.queue(action(`00000000-0000-4000-8000-${suffix}`, {
        wineRevision: index.toString(16).padStart(64, '0'), sku: `SKU-${index}`,
      }));
    }
    const claimed = await state.claim('test', { limit: 50, staleBefore: '2026-08-16T11:15:00.000Z' });
    assert.equal(claimed.actionIds.length, 50);
    assert.equal(claimed.remaining, 1);
    assert.equal((await state.counts('test')).processing, 50);
    assert.equal((await state.counts('test')).queued, 1);
  });
});
