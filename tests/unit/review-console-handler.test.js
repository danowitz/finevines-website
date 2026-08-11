import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { createReviewConsole } from '../../edge/review-console/handler.mjs';

before(() => { globalThis.crypto ??= webcrypto; });

function fixture() {
  const files = new Map([
    ['_review/test/current.json', JSON.stringify({ packageId: 'pkg-1' })],
    ['_review/test/packages/pkg-1/manifest.json', JSON.stringify({ packageId: 'pkg-1', wines: [] })],
  ]);
  const writes = [];
  const storage = {
    get: async (path) => files.get(path),
    putImmutable: async (path, body) => { if (files.has(path)) throw new Error('exists'); files.set(path, body); writes.push(path); },
  };
  const config = { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', password: 'correct horse', sessionSecret: 'session-secret' };
  const handle = createReviewConsole({ config, storage, dispatch: async () => {}, now: () => new Date('2026-08-11T20:00:00Z'), uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
  return { handle, writes };
}

async function login(handle) {
  const body = new URLSearchParams({ password: 'correct horse' });
  const res = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body }));
  return res.headers.get('set-cookie').split(';')[0];
}

describe('review console handler', () => {
  it('hides protected routes and candidate data before login', async () => {
    const { handle } = fixture();
    const res = await handle(new Request('https://review.finevines.biz/api/current'));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
  });

  it('sets a secure host-only cookie without a Domain attribute', async () => {
    const { handle } = fixture();
    const res = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body: new URLSearchParams({ password: 'correct horse' }) }));
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Domain=/i);
  });

  it('writes one immutable action and one pending pointer after origin and csrf checks', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', reviewer: 'Barbara', sku: 'AB-1', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    assert.equal(res.status, 202);
    assert.deepEqual(writes.map((p) => p.replace(/00000000-0000-4000-8000-\d{12}/, '<id>')), ['_review/test/actions/<id>.json', '_review/test/pending/<id>.json']);
  });

  it('refuses cross-origin and missing-csrf submissions', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(res.status, 403); assert.equal(writes.length, 0);
  });
});

