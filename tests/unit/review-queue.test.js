import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createReviewState } from '../../edge/review-console/review-state.mjs';
import { runQueueCommand } from '../../tools/review-console/queue.mjs';

const clients = [];
const tempDirectories = [];
afterEach(async () => {
  while (clients.length) clients.pop().close();
  while (tempDirectories.length) await rm(tempDirectories.pop(), { recursive: true, force: true });
});

async function tempFile(name) {
  const directory = await mkdtemp(join(tmpdir(), 'finevines-review-'));
  tempDirectories.push(directory);
  return join(directory, name);
}

function action(id, wineRevision) {
  return {
    schemaVersion: 1, id, environment: 'test', reviewer: 'barb.fultz@finevines.com', sku: id,
    kind: 'no-image', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision,
    candidateId: '', submittedAt: '2026-08-16T12:00:00.000Z', csrfSessionId: 'session-1',
  };
}

async function fixture() {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  const state = createReviewState({ client, now: () => new Date('2026-08-16T13:00:00.000Z') });
  await state.initialize();
  return state;
}

describe('review queue command', () => {
  it('claims a bounded batch and writes only claimed IDs', async () => {
    const state = await fixture();
    for (let index = 1; index <= 51; index += 1) {
      await state.queue(action(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, index.toString(16).padStart(64, '0')));
    }
    const output = await tempFile('claims.json');
    const result = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', output], state, now: () => new Date('2026-08-16T13:00:00.000Z') });
    assert.equal(result.claimed, 50);
    assert.equal(result.remaining, 1);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).length, 50);
  });

  it('isolates action-specific failures and completes only deployed decisions', async () => {
    const state = await fixture();
    const prepared = action('00000000-0000-4000-8000-000000000061', 'd'.repeat(64));
    const rejected = action('00000000-0000-4000-8000-000000000062', 'e'.repeat(64));
    await state.queue(prepared);
    await state.queue(rejected);
    const claims = await tempFile('claims.json');
    await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', claims], state, now: () => new Date('2026-08-16T13:00:00.000Z') });
    const decisions = await tempFile('decisions.json');
    await writeFile(decisions, JSON.stringify([
      { id: prepared.id, status: 'prepared' },
      { id: rejected.id, status: 'rejected', reason: 'selected image could not be decoded' },
    ]));
    await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisions], state });
    assert.equal((await state.actionStatus(rejected.id, 'test')).status, 'needs_attention');
    assert.equal((await state.actionStatus(prepared.id, 'test')).status, 'processing');
    await runQueueCommand({ args: ['complete', '--environment', 'test', '--decisions', decisions], state });
    assert.equal((await state.actionStatus(prepared.id, 'test')).status, 'completed');
    assert.equal((await state.actionStatus(rejected.id, 'test')).status, 'needs_attention');
  });
});
