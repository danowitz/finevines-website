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

function mutableStateAt(iso) {
  let clock = new Date(iso);
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  return {
    state: createReviewState({ client, now: () => new Date(clock) }),
    setTime: (value) => { clock = new Date(value); },
  };
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
  it('migrates the preceding transactional action schema without losing queued work', async () => {
    const client = createClient({ url: 'file::memory:' }); clients.push(client);
    await client.execute(`CREATE TABLE review_actions (
      id TEXT PRIMARY KEY, environment TEXT NOT NULL, package_id TEXT NOT NULL, wine_revision TEXT NOT NULL,
      sku TEXT NOT NULL, reviewer_email TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','needs_attention')),
      action_json TEXT NOT NULL, decision_open INTEGER NOT NULL DEFAULT 0, launch_excluded INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, attention_reason TEXT)`);
    const prior = action('00000000-0000-4000-8000-000000000000');
    await client.execute({ sql: `INSERT INTO review_actions
      (id, environment, package_id, wine_revision, sku, reviewer_email, kind, status, action_json, submitted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, args: [prior.id, prior.environment, prior.packageId, prior.wineRevision, prior.sku, prior.reviewer, prior.kind, JSON.stringify(prior), prior.submittedAt, prior.submittedAt] });
    const reopened = action('00000000-0000-4000-8000-000000000099', { wineRevision: '9'.repeat(64), sku: '500799*' });
    await client.execute({ sql: `INSERT INTO review_actions
      (id, environment, package_id, wine_revision, sku, reviewer_email, kind, status, action_json, decision_open, submitted_at, updated_at, attention_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_attention', ?, 1, ?, ?, 'review it again')`, args: [reopened.id, reopened.environment, reopened.packageId, reopened.wineRevision, reopened.sku, reopened.reviewer, reopened.kind, JSON.stringify(reopened), reopened.submittedAt, reopened.submittedAt] });
    const state = createReviewState({ client });
    await state.initialize();
    assert.equal((await state.actionStatus(prior.id, 'test')).status, 'queued');
    assert.equal((await state.actionStatus(reopened.id, 'test')).status, 'needs_decision');
    assert.equal((await state.packageStatus('test', [{ sku: reopened.sku, wineRevision: reopened.wineRevision }])).counts.needsDecision, 1);
    await state.transition(prior.id, 'queued', 'needs_attention', 'manual review');
    assert.equal((await state.recoverAction(prior.id, 'reopen', 'show it again')).status, 'needs_decision');
  });

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

  it('atomically stores a reviewer upload with its authoritative queue action', async () => {
    const state = stateAt(); await state.initialize();
    const selected = { ...action('00000000-0000-4000-8000-000000000003'), kind: 'reviewer-image', imageStorageName: 'image.png', imageMIME: 'image/png' };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await state.queue(selected, { bytes });
    const payloads = await state.pendingActionPayloads('test');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].action.id, selected.id);
    assert.deepEqual(new Uint8Array(payloads[0].upload.bytes), bytes);
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
      launchExcluded: false, submittedAt: second.submittedAt, startedAt: '', completedAt: '',
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

  it('does not move claims without their processing trace events', async () => {
    const base = createClient({ url: 'file::memory:' }); clients.push(base);
    let failClaimBatch = false;
    const client = {
      execute: (...args) => base.execute(...args),
      batch: (statements, mode) => {
        if (failClaimBatch && statements.some((statement) => String(statement.sql || statement).includes('processor claimed action'))) {
          throw new Error('trace storage failed');
        }
        return base.batch(statements, mode);
      },
    };
    const state = createReviewState({ client, now: () => new Date('2026-08-16T12:00:00.000Z') });
    await state.initialize();
    await state.queue(action('00000000-0000-4000-8000-000000000052'));
    failClaimBatch = true;
    await assert.rejects(state.claim('test', { limit: 50, staleBefore: '2026-08-16T11:15:00.000Z' }), /trace storage failed/);
    assert.equal((await state.counts('test')).queued, 1);
    assert.equal((await state.counts('test')).processing, 0);
  });

  it('opens, escalates, and recovers one deduplicated incident notification sequence', async () => {
    const { state, setTime } = mutableStateAt('2026-08-16T12:00:00.000Z');
    await state.initialize();
    const queued = action('00000000-0000-4000-8000-000000000071');
    await state.queue(queued);
    setTime('2026-08-16T12:11:00.000Z');
    let incidents = await state.scanIncidents('test', 'joel@gritautomation.com');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].sku, queued.sku);
    assert.match(incidents[0].reason, /10 minutes/);
    await state.scanIncidents('test', 'joel@gritautomation.com');
    let messages = await state.claimNotifications();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'joel@gritautomation.com');
    await state.completeNotification(messages[0].id);

    setTime('2026-08-16T16:12:00.000Z');
    await state.scanIncidents('test', 'joel@gritautomation.com');
    messages = await state.claimNotifications();
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /four hours/);
    await state.completeNotification(messages[0].id);

    await state.transition(queued.id, 'queued', 'processing', 'retry');
    await state.transition(queued.id, 'processing', 'completed', 'verified');
    incidents = await state.scanIncidents('test', 'joel@gritautomation.com');
    assert.deepEqual(incidents, []);
    messages = await state.claimNotifications();
    assert.equal(messages.length, 1);
    assert.match(messages[0].subject, /recovered/);
  });

  it('redacts a password reset link after the sensitive notification is delivered', async () => {
    const client = createClient({ url: 'file::memory:' }); clients.push(client);
    const state = createReviewState({ client, now: () => new Date('2026-08-16T12:00:00.000Z') });
    await state.initialize();
    await state.enqueueNotification({
      dedupeKey: 'password-reset:barb:1',
      to: 'barb.fultz@finevines.com',
      subject: 'Reset your Fine Vines review password',
      text: 'Use https://review.finevines.com/reset-password?token=private-token',
      sensitive: true,
    });

    const [message] = await state.claimNotifications();
    assert.match(message.text, /private-token/);
    await state.completeNotification(message.id);

    const stored = await client.execute({
      sql: 'SELECT status, sensitive, text_body FROM review_notifications WHERE id = ?',
      args: [message.id],
    });
    assert.equal(stored.rows[0].status, 'sent');
    assert.equal(Number(stored.rows[0].sensitive), 1);
    assert.equal(stored.rows[0].text_body, '[sensitive notification delivered and redacted]');
  });

  it('enforces password-flow limits transactionally across console instances', async () => {
    const client = createClient({ url: 'file::memory:' }); clients.push(client);
    let clock = new Date('2026-08-16T12:00:00.000Z');
    const first = createReviewState({ client, now: () => new Date(clock) });
    const second = createReviewState({ client, now: () => new Date(clock) });
    await first.initialize();
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(await first.consumeRateLimit('reset:hashed-client', 5, 600_000), true);
    assert.equal(await second.consumeRateLimit('reset:hashed-client', 5, 600_000), true);
    assert.equal(await second.consumeRateLimit('reset:hashed-client', 5, 600_000), false);
    clock = new Date('2026-08-16T12:10:00.001Z');
    assert.equal(await second.consumeRateLimit('reset:new-client', 5, 600_000), true);
    const remaining = await client.execute('SELECT bucket_key FROM review_rate_limits');
    assert.deepEqual(remaining.rows.map(({ bucket_key: bucket }) => bucket), ['reset:new-client'], 'expired buckets are pruned opportunistically');
  });

  it('keeps a rejected candidate set locked through rediscovery and supports explicit recovery outcomes', async () => {
    const state = stateAt();
    await state.initialize();
    const rejected = {
      ...action('00000000-0000-4000-8000-000000000081'),
      kind: 'no-image', candidateId: '', wineSlug: 'producer-wine-2022',
      rejectedCandidates: [{ candidateId: 'candidate-1', sha256: 'd'.repeat(64), sourceImageUrl: 'https://images.example/one.png', sourceUrl: 'https://example.test/wine' }],
    };
    await state.queue(rejected);
    await state.claim('test', { limit: 50, staleBefore: '2026-08-16T11:15:00.000Z' });
    assert.deepEqual(await state.scheduleRecovery(rejected.id, 'test'), { actionId: rejected.id, slug: 'producer-wine-2022', rejected: 1 });
    assert.equal((await state.actionStatus(rejected.id, 'test')).status, 'processing');
    assert.deepEqual(await state.pendingRecoveries('test'), [{ actionId: rejected.id, slug: 'producer-wine-2022', rejectedCandidates: rejected.rejectedCandidates }]);
    await assert.rejects(state.queue(action('00000000-0000-4000-8000-000000000082')), ActiveWineLockError);
    await state.resolveRecovery(rejected.id, 'needs_attention', 'broader discovery returned no new candidates');
    assert.equal((await state.actionStatus(rejected.id, 'test')).status, 'needs_attention');
    await state.recoverAction(rejected.id, 'reopen', 'review the original choices again');
    const packageStatus = await state.packageStatus('test', [packageWines[0]]);
    assert.equal(packageStatus.counts.needsDecision, 1);
    assert.deepEqual(packageStatus.decisions, [packageWines[0]]);
  });

  it('requires reasons for reopen/exclusion and can explicitly restart failed rediscovery', async () => {
    const client = createClient({ url: 'file::memory:' }); clients.push(client);
    const state = createReviewState({ client, now: () => new Date('2026-08-16T12:00:00.000Z') }); await state.initialize();
    const makeRejected = (id, revision, sku, slug) => ({ ...action(id, { wineRevision: revision, sku }), kind: 'no-image', candidateId: '', wineSlug: slug, rejectedCandidates: [{ candidateId: 'old', sha256: 'e'.repeat(64), sourceImageUrl: '', sourceUrl: '' }] });
    const rediscover = makeRejected('00000000-0000-4000-8000-000000000083', '3'.repeat(64), 'SKU-3', 'wine-three');
    await state.queue(rediscover); await state.claim('test', { limit: 50, staleBefore: '2026-08-16T11:15:00.000Z' }); await state.scheduleRecovery(rediscover.id, 'test');
    await state.resolveRecovery(rediscover.id, 'needs_attention', 'no new candidates');
    assert.equal((await state.recoverAction(rediscover.id, 'rediscover')).status, 'processing');
    assert.deepEqual((await state.pendingRecoveries('test')).map(({ actionId }) => actionId), [rediscover.id]);

    const directRediscover = makeRejected('00000000-0000-4000-8000-000000000085', '5'.repeat(64), 'SKU-5', 'wine-five');
    await state.queue(directRediscover); await state.transition(directRediscover.id, 'queued', 'needs_attention', 'discovery failed before recovery was scheduled');
    assert.equal((await state.recoverAction(directRediscover.id, 'rediscover')).status, 'processing');
    assert.ok((await state.pendingRecoveries('test')).some(({ actionId }) => actionId === directRediscover.id));

    const excluded = makeRejected('00000000-0000-4000-8000-000000000084', '4'.repeat(64), 'SKU-4', 'wine-four');
    await state.queue(excluded); await state.transition(excluded.id, 'queued', 'needs_attention', 'operator decision required');
    await assert.rejects(state.recoverAction(excluded.id, 'exclude', ''), /reason/);
    assert.equal((await state.recoverAction(excluded.id, 'exclude', 'supplier image required')).status, 'needs_attention');
    assert.equal((await state.actionStatus(excluded.id, 'test')).launchExcluded, true);
    const excludedStatus = await state.packageStatus('test', [{ sku: excluded.sku, wineRevision: excluded.wineRevision }]);
    assert.equal(excludedStatus.counts.needsAttention, 0);
    assert.deepEqual(await state.launchExclusions('test'), [{ sku: excluded.sku, wineRevision: excluded.wineRevision, reason: 'supplier image required' }]);
    assert.deepEqual(await state.scanIncidents('test', 'joel@gritautomation.com'), []);

    const eventRows = await client.execute({ sql: 'SELECT status, detail FROM review_action_events WHERE action_id = ? ORDER BY sequence', args: [excluded.id] });
    assert.equal(eventRows.rows.at(-1).status, 'needs_attention');
    assert.match(eventRows.rows.at(-1).detail, /temporarily excluded.*supplier image required/);
  });
});
