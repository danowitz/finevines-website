import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runReviewPreflight } from '../../tools/review-console/preflight.mjs';

const complete = Object.fromEntries([
  'FINEVINES_BUNNY_API_KEY', 'FINEVINES_REVIEW_STORAGE_ENDPOINT', 'FINEVINES_REVIEW_STORAGE_ZONE', 'FINEVINES_REVIEW_STORAGE_KEY',
  'FINEVINES_REVIEW_DATABASE_URL', 'FINEVINES_REVIEW_DATABASE_TOKEN', 'FINEVINES_REVIEW_GITHUB_DISPATCH_TOKEN',
  'FINEVINES_SMTP_HOST', 'FINEVINES_SMTP_PORT', 'FINEVINES_SMTP_USER', 'FINEVINES_SMTP_PASS', 'FINEVINES_NOTIFY_FROM',
].map((name) => [name, name === 'FINEVINES_SMTP_PORT' ? '587' : name === 'FINEVINES_REVIEW_STORAGE_ENDPOINT' ? 'https://storage.example' : 'configured-value']));
complete.FINEVINES_REVIEW_TEST_SESSION_SECRET = 't'.repeat(32);
complete.FINEVINES_REVIEW_PRODUCTION_SESSION_SECRET = 'p'.repeat(32);

test('review preflight is read-only and proves storage, database, and processing trigger access', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    return url.includes('api.github.com') ? Response.json({ state: 'active' }) : new Response('[]');
  };
  const database = [];
  const result = await runReviewPreflight({ environment: complete, fetchImpl, createClientImpl: () => ({ execute: async (sql) => database.push(sql), close: () => {} }) });
  assert.deepEqual(result, { storage: 'reachable', database: 'reachable', processingTrigger: 'active', email: 'configured' });
  assert.ok(requests.every(({ method }) => method === 'GET'));
  assert.deepEqual(database, ['SELECT 1 AS ready']);
});

test('review preflight fails before any network call when one credential is absent', async () => {
  let called = false;
  await assert.rejects(runReviewPreflight({ environment: { ...complete, FINEVINES_SMTP_PASS: '' }, fetchImpl: async () => { called = true; return new Response(); } }), /FINEVINES_SMTP_PASS/);
  assert.equal(called, false);
});
