import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { createReviewConsole } from '../../edge/review-console/handler.mjs';

before(() => { globalThis.crypto ??= webcrypto; });

function fixture({ dispatch = async () => {} } = {}) {
  const candidate = new Uint8Array([1, 2, 3, 4]);
  const files = new Map([
    ['_review/test/current.json', JSON.stringify({ packageId: 'pkg-1' })],
    ['_review/test/packages/pkg-1/manifest.json', JSON.stringify({
      schemaVersion: 1, packageId: 'pkg-1', environment: 'test', catalogCommit: 'abcdef1', createdAt: '2026-08-10T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z',
      wines: [{ sku: 'AB-1', displayIdentity: 'Producer Wine 2022', wineRevision: 'a'.repeat(64), candidates: [{ candidateId: 'c1', storageName: 'c1.png', mime: 'image/png', bytes: candidate.length, width: 400, height: 800 }] }],
    })],
    ['_review/test/packages/pkg-1/images/c1.png', candidate],
  ]);
  const writes = [];
  const storage = {
    get: async (path) => files.get(path),
    getBytes: async (path) => files.get(path),
    putImmutable: async (path, body) => { if (files.has(path)) throw new Error('exists'); files.set(path, body); writes.push(path); },
  };
  const config = { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', password: 'correct horse', sessionSecret: 'session-secret' };
  const handle = createReviewConsole({ config, storage, dispatch, now: () => new Date('2026-08-11T20:00:00Z'), uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
  return { handle, writes };
}

async function login(handle) {
  const body = new URLSearchParams({ password: 'correct horse' });
  const res = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body }));
  return res.headers.get('set-cookie').split(';')[0];
}

describe('review console handler', () => {
  it('serves a polished login document, stylesheet, and favicon before authentication', async () => {
    const { handle } = fixture();
    const page = await handle(new Request('https://review.finevines.biz/'));
    const markup = await page.text();
    assert.equal(page.status, 200);
    assert.match(markup, /<link rel="stylesheet" href="\/app\.css">/);
    assert.match(markup, /<link rel="icon" href="\/favicon\.ico"/);
    assert.match(markup, /class="login-shell"/);
    assert.match(markup, /Fine Vines image review/);

    const stylesheet = await handle(new Request('https://review.finevines.biz/app.css'));
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    assert.match(await stylesheet.text(), /\.login-shell/);

    const favicon = await handle(new Request('https://review.finevines.biz/favicon.ico'));
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/x-icon');
    assert.ok((await favicon.arrayBuffer()).byteLength > 0);
  });

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

  it('rate-limits repeated password failures without revealing protected data', async () => {
    const { handle } = fixture();
    for (let attempt = 0; attempt < 5; attempt++) {
      const denied = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong' }) }));
      assert.equal(denied.status, 401);
    }
    const blocked = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body: new URLSearchParams({ password: 'correct horse' }) }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    assert.doesNotMatch(await blocked.text(), /package|candidate/i);
  });

  it('keeps crawler and cache protections on unexpected storage failures', async () => {
    const { handle } = fixture();
    const cookie = await login(handle);
    const res = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    assert.equal(res.status, 200);
    const broken = createReviewConsole({
      config: { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', password: 'correct horse', sessionSecret: 'session-secret' },
      storage: { get: async () => { throw new Error('storage offline'); } }, dispatch: async () => {}, now: () => new Date('2026-08-11T20:00:00Z'),
    });
    const token = await login(broken);
    const failed = await broken(new Request('https://review.finevines.biz/api/current', { headers: { cookie: token } }));
    assert.equal(failed.status, 503);
    assert.match(failed.headers.get('x-robots-tag'), /noindex/);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
  });

  it('serves the authenticated gallery and candidate bytes without exposing storage paths', async () => {
    const { handle } = fixture();
    const cookie = await login(handle);
    const page = await handle(new Request('https://review.finevines.biz/', { headers: { cookie } }));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Compare the candidates/);
    const image = await handle(new Request('https://review.finevines.biz/api/packages/pkg-1/images/c1', { headers: { cookie } }));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3, 4]);
    assert.match(image.headers.get('x-robots-tag'), /noimageindex/);
  });

  it('does not serve candidate bytes before login', async () => {
    const { handle } = fixture();
    const image = await handle(new Request('https://review.finevines.biz/api/packages/pkg-1/images/c1'));
    assert.equal(image.status, 404);
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

  it('retains two simultaneous submissions as four independent immutable objects', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', reviewer: 'Barbara', sku: 'AB-1', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const request = () => new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) });
    const responses = await Promise.all([handle(request()), handle(request())]);
    assert.deepEqual(responses.map((response) => response.status), [202, 202]);
    assert.equal(new Set(writes).size, 4);
    assert.equal(writes.filter((path) => path.includes('/actions/')).length, 2);
    assert.equal(writes.filter((path) => path.includes('/pending/')).length, 2);
  });

  it('keeps the immutable pending action when immediate GitHub dispatch fails', async () => {
    const { handle, writes } = fixture({ dispatch: async () => { throw new Error('GitHub unavailable'); } });
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', reviewer: 'Barbara', sku: 'AB-1', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    assert.equal(res.status, 202);
    assert.equal((await res.json()).dispatched, false);
    assert.equal(writes.filter((path) => path.includes('/pending/')).length, 1);
  });

  it('refuses cross-origin and missing-csrf submissions', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(res.status, 403); assert.equal(writes.length, 0);
  });

  it('rejects a candidate that is not in the package wine', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', reviewer: 'Barbara', sku: 'AB-1', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'not-in-package' };
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    assert.equal(res.status, 400);
    assert.equal(writes.length, 0);
  });

  it('renders pending and durable receipt status', async () => {
    const { handle } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', reviewer: 'Barbara', sku: 'AB-1', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const queued = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    const { id } = await queued.json();
    const pending = await handle(new Request(`https://review.finevines.biz/api/actions/${id}`, { headers: { cookie } }));
    assert.equal((await pending.json()).status, 'queued');
  });
});
