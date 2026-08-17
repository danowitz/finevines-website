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

  it('delivers incident email through an injected capture transport without network access', async () => {
    const state = await fixture();
    const stalled = action('00000000-0000-4000-8000-000000000081', 'f'.repeat(64));
    await state.queue(stalled);
    const sent = [];
    const args = ['notify', '--environment', 'test', '--recipient', 'joel@gritautomation.com', '--from', 'catalog@finevines.com'];
    const first = await runQueueCommand({ args, state, mailer: { send: async (message) => { sent.push(message); } } });
    assert.equal(first.sent, 1);
    assert.equal(sent[0].to, 'joel@gritautomation.com');
    assert.match(sent[0].subject, /needs attention/);
    const second = await runQueueCommand({ args, state, mailer: { send: async (message) => { sent.push(message); } } });
    assert.equal(second.sent, 0);
    assert.equal(sent.length, 1);
  });

  it('synchronizes eligible accounts and queues only an explicit invitation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'finevines-review-roster-'));
    const roster = join(directory, 'team.json');
    await writeFile(roster, JSON.stringify([
      { name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' },
      { name: 'Sales Person', email: 'sales@finevines.com', role: 'Sales Rep' },
    ]));
    const calls = [];
    const accounts = {
      sync: async (people) => calls.push(['sync', people]),
      list: async () => [{ email: 'barb.fultz@finevines.com' }, { email: 'joel@danowitz.com' }],
      activate: async (email) => calls.push(['activate', email]),
    };
    const state = { initialize: async () => {} };
    const synced = await runQueueCommand({ args: ['sync-accounts', '--environment', 'test', '--roster', roster], state, accounts });
    assert.equal(synced.eligible, 2);
    assert.deepEqual(calls[0], ['sync', [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }]]);
    assert.equal(calls.length, 1);
    await runQueueCommand({ args: ['invite', '--environment', 'test', '--email', 'BARB.FULTZ@finevines.com'], state, accounts });
    assert.deepEqual(calls[1], ['activate', 'BARB.FULTZ@finevines.com']);
  });

  it('exports rejected identities and reopens only when broader discovery finds new candidates', async () => {
    const client = createClient({ url: 'file::memory:' }); clients.push(client);
    const state = createReviewState({ client, now: () => new Date('2026-08-16T12:00:00Z') });
    await state.initialize();
    const rejectedAction = {
      ...action('00000000-0000-4000-8000-000000000091', 'a'.repeat(64)), kind: 'no-image', candidateId: '', wineSlug: 'producer-wine-2022',
      rejectedCandidates: [{ candidateId: 'old', sha256: 'e'.repeat(64), sourceImageUrl: 'https://images.example/old.png', sourceUrl: 'https://example.test/old' }],
    };
    await state.queue(rejectedAction);
    await state.claim('test', { limit: 50, staleBefore: '2026-08-16T11:00:00Z' });
    const decisionsFile = await tempFile('decisions.json');
    await writeFile(decisionsFile, JSON.stringify([{ id: rejectedAction.id, status: 'rediscover' }]));
    const reconciled = await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisionsFile], state });
    assert.equal(reconciled.recoveries[0].slug, 'producer-wine-2022');
    const exported = await tempFile('rejected.json');
    await runQueueCommand({ args: ['export-recovery', '--environment', 'test', '--action-id', rejectedAction.id, '--output', exported], state });
    assert.equal(JSON.parse(await readFile(exported)).rejectedCandidates[0].candidateId, 'old');
    const draft = await tempFile('draft.json');
    const catalog = await tempFile('catalog.json');
    await writeFile(draft, JSON.stringify({ wines: [{ slug: 'producer-wine-2022', candidates: [{ candidateId: 'new' }] }] }));
    await writeFile(catalog, JSON.stringify([{ slug: 'producer-wine-2022', imagePath: 'assets/img/wines/producer-wine-2022.svg', imageSource: 'generated-label' }]));
    const resolved = await runQueueCommand({ args: ['resolve-recovery', '--environment', 'test', '--action-id', rejectedAction.id, '--draft', draft, '--catalog', catalog], state });
    assert.equal(resolved.outcome, 'ready');
    assert.equal((await state.actionStatus(rejectedAction.id, 'test')).status, 'reopened');
  });

  it('idempotently imports immutable legacy pending actions before claiming', async () => {
    const state = await fixture();
    const legacy = action('00000000-0000-4000-8000-000000000095', '5'.repeat(64));
    const storage = {
      list: async () => [`${legacy.id}.json`],
      get: async () => JSON.stringify(legacy),
    };
    const first = await runQueueCommand({ args: ['migrate', '--environment', 'test'], state, storage });
    const second = await runQueueCommand({ args: ['migrate', '--environment', 'test'], state, storage });
    assert.deepEqual(first, { command: 'migrate', scanned: 1, queued: 1, existing: 0, needs_attention: 0 });
    assert.deepEqual(second, { command: 'migrate', scanned: 1, queued: 0, existing: 1, needs_attention: 0 });
  });
});
