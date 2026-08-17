import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runReviewPreflight } from '../../tools/review-console/preflight.mjs';

const complete = Object.fromEntries([
  'FINEVINES_BUNNY_API_KEY', 'FINEVINES_REVIEW_STORAGE_ENDPOINT', 'FINEVINES_REVIEW_STORAGE_ZONE', 'FINEVINES_REVIEW_STORAGE_KEY',
  'FINEVINES_REVIEW_DATABASE_URL', 'FINEVINES_REVIEW_DATABASE_TOKEN', 'FINEVINES_REVIEW_GITHUB_DISPATCH_TOKEN',
  'FINEVINES_SMTP_HOST', 'FINEVINES_SMTP_PORT', 'FINEVINES_SMTP_USER', 'FINEVINES_SMTP_PASS', 'FINEVINES_NOTIFY_FROM',
].map((name) => [name, name === 'FINEVINES_SMTP_PORT' ? '587' : name === 'FINEVINES_REVIEW_STORAGE_ENDPOINT' ? 'https://storage.example' : 'configured-value']));
complete.FINEVINES_REVIEW_DATABASE_URL = 'libsql://finevines-review.lite.bunnydb.net/';
complete.FINEVINES_REVIEW_TEST_SESSION_SECRET = 't'.repeat(32);
complete.FINEVINES_REVIEW_PRODUCTION_SESSION_SECRET = 'p'.repeat(32);

test('review preflight proves storage, database, and an actual harmless processing dispatch', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    return url.endsWith('/dispatches') ? new Response(null, { status: 204 }) : url.includes('api.github.com') ? Response.json({ state: 'active' }) : new Response('[]');
  };
  const database = [];
  const result = await runReviewPreflight({ environment: complete, fetchImpl, createClientImpl: () => ({ execute: async (sql) => database.push(sql), close: () => {} }) });
  assert.deepEqual(result, { storage: 'reachable', database: 'reachable', processingTrigger: 'dispatched', email: 'configured' });
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET', 'POST']);
  assert.deepEqual(database, ['SELECT 1 AS ready']);
});

test('review preflight fails before any network call when one credential is absent', async () => {
  let called = false;
  await assert.rejects(runReviewPreflight({ environment: { ...complete, FINEVINES_SMTP_PASS: '' }, fetchImpl: async () => { called = true; return new Response(); } }), /FINEVINES_SMTP_PASS/);
  assert.equal(called, false);
});

test('review preflight retries transient GitHub failures without blocking Bunny reconciliation', async () => {
  let dispatches = 0;
  const waits = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/dispatches')) {
      dispatches += 1;
      return new Response(null, { status: 503 });
    }
    return url.includes('api.github.com') ? Response.json({ state: 'active' }) : new Response('[]');
  };
  const result = await runReviewPreflight({
    environment: complete,
    fetchImpl,
    createClientImpl: () => ({ execute: async () => {}, close: () => {} }),
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.processingTrigger, 'temporarily unavailable');
  assert.equal(dispatches, 4);
  assert.deepEqual(waits, [250, 1_000, 4_000]);
});

test('review preflight rejects a non-Bunny transactional database before any network call', async () => {
  let called = false;
  await assert.rejects(runReviewPreflight({
    environment: { ...complete, FINEVINES_REVIEW_DATABASE_URL: 'libsql://example.turso.io' },
    fetchImpl: async () => { called = true; return new Response(); },
  }), /must use Bunny Database/);
  assert.equal(called, false);
});
