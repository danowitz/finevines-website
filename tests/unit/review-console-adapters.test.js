import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBunnyStorage } from '../../edge/review-console/bunny-storage.mjs';
import { createGitHubDispatch } from '../../edge/review-console/github-dispatch.mjs';

describe('review console adapters', () => {
  it('makes immutable storage writes idempotent and rejects different bytes', async () => {
    const files = new Map();
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if ((init.method || 'GET') === 'GET') return files.has(path) ? new Response(files.get(path)) : new Response('', { status: 404 });
      if (init.method === 'PUT') { files.set(path, init.body); return new Response('', { status: 201 }); }
      return new Response('', { status: 204 });
    };
    const storage = createBunnyStorage({ endpoint: 'https://storage.example', zone: 'zone', key: 'secret', fetchImpl });
    await storage.putImmutable('_review/test/actions/id.json', 'same');
    await storage.putImmutable('_review/test/actions/id.json', 'same');
    await assert.rejects(storage.putImmutable('_review/test/actions/id.json', 'different'), /different bytes/);
  });

  it('dispatches only the action id and environment to the configured repository', async () => {
    let seen;
    const dispatch = createGitHubDispatch({ token: 'token', repository: 'owner/repo', fetchImpl: async (url, init) => { seen = { url, init }; return new Response(null, { status: 204 }); } });
    await dispatch('action-id', 'test');
    assert.equal(seen.url, 'https://api.github.com/repos/owner/repo/dispatches');
    assert.deepEqual(JSON.parse(seen.init.body), { event_type: 'review-console', client_payload: { actionId: 'action-id', environment: 'test' } });
  });
});
