import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchReviewWorkflow } from '../../tools/review-console/dispatch.mjs';

test('review continuation dispatch uses the authenticated GitHub repository endpoint', async () => {
  const calls = [];
  const result = await dispatchReviewWorkflow({
    repository: 'danowitz/finevines-website',
    token: 'test-token',
    eventType: 'review-console-continue',
    environment: 'test',
    reason: 'time-budget-yield',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); },
  });
  assert.deepEqual(result, { eventType: 'review-console-continue', environment: 'test', reason: 'time-budget-yield' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/danowitz/finevines-website/dispatches');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'review-console-continue',
    client_payload: { environment: 'test', reason: 'time-budget-yield' },
  });
});

test('review continuation dispatch fails closed on invalid input or GitHub rejection', async () => {
  await assert.rejects(dispatchReviewWorkflow({ repository: '../bad', token: 'x', eventType: 'review-console-continue' }), /owner\/name/);
  await assert.rejects(dispatchReviewWorkflow({ repository: 'owner/repo', token: 'x', eventType: 'review-recovery' }), /unsupported/);
  await assert.rejects(dispatchReviewWorkflow({
    repository: 'owner/repo', token: 'x', eventType: 'review-console-continue',
    fetchImpl: async () => new Response(null, { status: 403 }),
  }), /HTTP 403/);
});
