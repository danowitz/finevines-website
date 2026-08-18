import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { createReviewConsole } from '../../edge/review-console/handler.mjs';
import { ActiveWineLockError } from '../../edge/review-console/review-state.mjs';

before(() => { globalThis.crypto ??= webcrypto; });

const REVIEWER_IDENTITY = { email: 'barb.fultz@finevines.com', name: 'Barb Fultz', role: 'Back Office', mustChangePassword: false, credentialVersion: 2 };

function fixture({ dispatch = async () => {}, identity = REVIEWER_IDENTITY, queueFailure = null, storageWriteFailure = null } = {}) {
  const candidate = new Uint8Array([1, 2, 3, 4]);
  const files = new Map([
    ['_review/test/current.json', JSON.stringify({ packageId: 'pkg-1' })],
    ['_review/test/packages/pkg-1/manifest.json', JSON.stringify({
      schemaVersion: 1, packageId: 'pkg-1', environment: 'test', catalogCommit: 'abcdef1', createdAt: '2026-08-10T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z',
      reviewers: [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }, { name: 'Connie Molitor', email: 'connie@finevines.com', role: 'Executive' }],
      wines: [
        { sku: '500740*', slug: 'producer-wine-2022', displayIdentity: 'Producer Wine 2022', searchQuery: 'Producer Wine 2022 exact query', wineRevision: 'a'.repeat(64), candidates: [{ candidateId: 'c1', storageName: 'c1.png', sha256: '1'.repeat(64), mime: 'image/png', bytes: candidate.length, width: 400, height: 800, sourceUrl: 'https://producer.example/wine', sourceImageUrl: 'https://producer.example/wine.png' }] },
        { sku: '500741*', slug: 'producer-other-wine-2021', displayIdentity: 'Producer Other Wine 2021', searchQuery: 'Producer Other Wine 2021', wineRevision: 'b'.repeat(64), candidates: [{ candidateId: 'c2', storageName: 'c2.png', sha256: '2'.repeat(64), mime: 'image/png', bytes: candidate.length, width: 400, height: 800, sourceUrl: 'https://producer.example/other', sourceImageUrl: 'https://producer.example/other.png' }] },
      ],
    })],
    ['_review/test/packages/pkg-1/images/c1.png', candidate],
    ['_review/test/packages/pkg-1/images/c2.png', candidate],
  ]);
  const writes = [];
  const activeWines = new Map();
  const queuedActions = [];
  const accountCalls = [];
  const rateLimits = new Map();
  const storage = {
    get: async (path) => files.get(path),
    getBytes: async (path) => files.get(path),
    putImmutable: async (path, body) => { if (storageWriteFailure) throw storageWriteFailure; if (files.has(path)) throw new Error('exists'); files.set(path, body); writes.push(path); },
  };
  const state = {
    initialize: async () => {},
    queue: async (action) => {
      if (queueFailure) throw queueFailure;
      const key = `${action.environment}:${action.wineRevision}`;
      const active = activeWines.get(key);
      if (active) throw new ActiveWineLockError({ sku: action.sku, actionId: active });
      activeWines.set(key, action.id);
      queuedActions.push(action);
      return { id: action.id, status: 'queued' };
    },
    packageStatus: async (environment, wines) => {
      const active = new Map(queuedActions.filter((action) => action.environment === environment).map((action) => [action.wineRevision, action]));
      const decisions = wines.filter((wine) => !active.has(wine.wineRevision));
      return {
        counts: { needsDecision: decisions.length, queued: active.size, processing: 0, completed: 0, needsAttention: 0 },
        oldestPendingAt: active.size ? queuedActions[0].submittedAt : null,
        decisions,
        statuses: Object.fromEntries([...active].map(([revision, action]) => [revision, { actionId: action.id, status: 'queued', attentionReason: '' }])),
      };
    },
    actionStatus: async (id, environment) => {
      const action = queuedActions.find((value) => value.id === id && value.environment === environment);
      return action ? { id, status: 'queued', attentionReason: '', submittedAt: action.submittedAt, startedAt: '', completedAt: '' } : null;
    },
    scanIncidents: async () => [],
    transition: async (id, from, to, detail) => {
      const action = queuedActions.find((value) => value.id === id);
      if (!action || action.status !== from) throw new Error('invalid transition');
      action.status = to; action.detail = detail;
    },
    recoverAction: async (id, operation, reason) => {
      const action = queuedActions.find((value) => value.id === id);
      if (!action || action.status !== 'needs_attention') throw new Error('invalid transition');
      action.status = operation === 'retry' ? 'queued' : operation === 'rediscover' ? 'rediscovering' : operation === 'reopen' ? 'reopened' : 'excluded';
      action.detail = reason;
      return { id, status: action.status };
    },
    pendingRecoveries: async () => [],
    consumeRateLimit: async (bucket, limit) => {
      const attempts = (rateLimits.get(bucket) || 0) + 1;
      rateLimits.set(bucket, attempts);
      return attempts <= limit;
    },
  };
  const accounts = {
    authenticate: async (email, password) => email === identity.email && password === 'correct horse' ? identity : null,
    sessionIdentity: async (email, version) => email === identity.email && version === identity.credentialVersion ? identity : null,
    changePassword: async (current, oldPassword, newPassword) => {
      assert.equal(current, identity);
      assert.equal(oldPassword, 'correct horse');
      assert.equal(newPassword, 'A-new-private-password-92!');
      identity = { ...identity, mustChangePassword: false, credentialVersion: identity.credentialVersion + 1 };
      return identity;
    },
    sync: async (roster) => accountCalls.push(['sync', roster]),
    list: async () => [{ email: 'barb.fultz@finevines.com', name: 'Barb Fultz', role: 'Back Office', source: 'salesforce', status: 'active' }],
    activate: async (email) => accountCalls.push(['activate', email]),
    requestPasswordReset: async (email) => accountCalls.push(['request-password-reset', email]),
    resetPassword: async (token, newPassword) => accountCalls.push(['reset-password', token, newPassword]),
  };
  const config = { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', sessionSecret: 'session-secret', incidentRecipient: 'joel@gritautomation.com' };
  const handle = createReviewConsole({ config, storage, state, accounts, dispatch, now: () => new Date('2026-08-11T20:00:00Z'), uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
  return { handle, writes, files, queuedActions, accountCalls };
}

async function login(handle) {
  const body = new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'correct horse' });
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
    assert.match(markup, /href="\/forgot-password"/);
    assert.match(markup, /class="login-shell"/);
    assert.match(markup, /class="login-logo"/);
    assert.match(markup, />Sign in for catalog review<\/p>/);
    assert.doesNotMatch(markup, /<h1>Fine Vines<\/h1>/);

    const stylesheet = await handle(new Request('https://review.finevines.biz/app.css'));
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    assert.match(await stylesheet.text(), /\.login-shell/);

    const favicon = await handle(new Request('https://review.finevines.biz/favicon.ico'));
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/x-icon');
    assert.ok((await favicon.arrayBuffer()).byteLength > 0);

    const robots = await handle(new Request('https://review.finevines.biz/robots.txt'));
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);
    assert.match(robots.headers.get('x-robots-tag'), /noindex/);
    assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
  });

  it('offers a non-enumerating, confirmed, single-use password reset flow', async () => {
    const { handle, accountCalls } = fixture();
    const requestPage = await handle(new Request('https://review.finevines.biz/forgot-password'));
    const requestMarkup = await requestPage.text();
    assert.match(requestMarkup, /name="email"/);

    const requested = await handle(new Request('https://review.finevines.biz/forgot-password', {
      method: 'POST', headers: { origin: 'https://review.finevines.biz' },
      body: new URLSearchParams({ email: 'unknown@example.com' }),
    }));
    assert.equal(requested.status, 200);
    assert.match(await requested.text(), /If an eligible account exists, a reset link has been sent/);
    assert.deepEqual(accountCalls.at(-1), ['request-password-reset', 'unknown@example.com']);

    const exchange = await handle(new Request('https://review.finevines.biz/reset-password?token=reset-token-92'));
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get('location'), '/reset-password');
    assert.equal(exchange.headers.get('referrer-policy'), 'no-referrer');
    assert.match(exchange.headers.get('set-cookie'), /fv_review_test_reset=reset-token-92;.*HttpOnly.*Secure.*SameSite=Strict/);
    const resetCookie = exchange.headers.get('set-cookie').split(';')[0];
    const resetPage = await handle(new Request('https://review.finevines.biz/reset-password', { headers: { cookie: resetCookie } }));
    const resetMarkup = await resetPage.text();
    assert.doesNotMatch(resetMarkup, /reset-token-92/);
    assert.match(resetMarkup, /name="newPassword"/);
    assert.match(resetMarkup, /name="confirmPassword"/);

    const mismatch = await handle(new Request('https://review.finevines.biz/reset-password', {
      method: 'POST', headers: { origin: 'https://review.finevines.biz', cookie: resetCookie },
      body: new URLSearchParams({ newPassword: 'Replacement-password-92!', confirmPassword: 'different-password' }),
    }));
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /New passwords do not match/);
    assert.notEqual(accountCalls.at(-1)?.[0], 'reset-password');

    const reset = await handle(new Request('https://review.finevines.biz/reset-password', {
      method: 'POST', headers: { origin: 'https://review.finevines.biz', cookie: resetCookie },
      body: new URLSearchParams({ newPassword: 'Replacement-password-92!', confirmPassword: 'Replacement-password-92!' }),
    }));
    assert.equal(reset.status, 303);
    assert.equal(reset.headers.get('location'), '/?password-reset=success');
    assert.match(reset.headers.get('set-cookie'), /fv_review_test_reset=; Max-Age=0/);
    assert.deepEqual(accountCalls.at(-1), ['reset-password', 'reset-token-92', 'Replacement-password-92!']);
  });

  it('silently rate limits password reset requests from one client', async () => {
    const { handle, accountCalls } = fixture();
    for (let index = 0; index < 6; index += 1) {
      const response = await handle(new Request('https://review.finevines.biz/forgot-password', {
        method: 'POST',
        headers: { origin: 'https://review.finevines.biz', 'bunnycdn-client-ip': '192.0.2.10' },
        body: new URLSearchParams({ email: `person-${index}@example.com` }),
      }));
      assert.equal(response.status, 200);
      assert.match(await response.text(), /If an eligible account exists/);
    }
    assert.equal(accountCalls.filter(([kind]) => kind === 'request-password-reset').length, 5);

    const fallback = fixture();
    for (let index = 0; index < 6; index += 1) {
      await fallback.handle(new Request('https://review.finevines.biz/forgot-password', {
        method: 'POST',
        headers: { origin: 'https://review.finevines.biz', 'x-forwarded-for': `192.0.2.${index}` },
        body: new URLSearchParams({ email: `fallback-${index}@example.com` }),
      }));
    }
    assert.equal(fallback.accountCalls.filter(([kind]) => kind === 'request-password-reset').length, 5, 'caller-controlled forwarding headers cannot rotate the bucket');
  });

  it('rate limits password reset submissions before expensive password hashing', async () => {
    const { handle, accountCalls } = fixture();
    for (let index = 0; index < 5; index += 1) {
      const response = await handle(new Request('https://review.finevines.biz/reset-password', {
        method: 'POST',
        headers: { origin: 'https://review.finevines.biz', 'bunnycdn-client-ip': '192.0.2.20', cookie: `fv_review_test_reset=token-${index}` },
        body: new URLSearchParams({ newPassword: 'Replacement-password-92!', confirmPassword: 'Replacement-password-92!' }),
      }));
      assert.equal(response.status, 303);
    }
    const blocked = await handle(new Request('https://review.finevines.biz/reset-password', {
      method: 'POST',
      headers: { origin: 'https://review.finevines.biz', 'bunnycdn-client-ip': '192.0.2.20', cookie: 'fv_review_test_reset=token-6' },
      body: new URLSearchParams({ newPassword: 'Replacement-password-92!', confirmPassword: 'Replacement-password-92!' }),
    }));
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /reset link is invalid or expired/);
    assert.equal(accountCalls.filter(([kind]) => kind === 'reset-password').length, 5);
  });

  it('hides protected routes and candidate data before login', async () => {
    const { handle } = fixture();
    const res = await handle(new Request('https://review.finevines.biz/api/current'));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
  });

  it('sets a secure host-only cookie without a Domain attribute', async () => {
    const { handle } = fixture();
    const res = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body: new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'correct horse' }) }));
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Domain=/i);
  });

  it('rate-limits repeated password failures without revealing protected data', async () => {
    const { handle } = fixture();
    for (let attempt = 0; attempt < 5; attempt++) {
      const denied = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body: new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'wrong' }) }));
      assert.equal(denied.status, 401);
    }
    const blocked = await handle(new Request('https://review.finevines.biz/login', { method: 'POST', body: new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'correct horse' }) }));
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
      config: { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', sessionSecret: 'session-secret' },
      storage: { get: async () => { throw new Error('storage offline'); } }, state: { initialize: async () => {}, queue: async () => {} }, accounts: { authenticate: async () => REVIEWER_IDENTITY, sessionIdentity: async () => REVIEWER_IDENTITY }, dispatch: async () => {}, now: () => new Date('2026-08-11T20:00:00Z'),
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
    const markup = await page.text();
    assert.match(markup, /Compare the candidates/);
    assert.doesNotMatch(markup, /<select id="reviewer"/);
    assert.match(markup, /Barb Fultz/);
    assert.match(markup, /class="modal-dialog"/);
    const app = await handle(new Request('https://review.finevines.biz/app.js', { headers: { cookie } }));
    const script = await app.text();
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /Remove from comparison/);
    assert.match(script, /event\.target === modal/);
    assert.match(script, /function renderWines\(wines\)/);
    assert.doesNotMatch(script, /list\.replaceChildren\(\)/);
    assert.match(script, /setInterval\(activeRefresh, 10_000\)/);
    assert.match(script, /Updates automatically every 10 seconds while this window is active/);
    assert.match(script, /processor checks for new decisions every five minutes/);
    assert.match(script, /Manage reviewer access/);
    assert.match(script, /Send invitation/);
    assert.doesNotMatch(script, /Resend invitation/);
    assert.match(script, /document\.visibilityState === 'visible' && document\.hasFocus\(\)/);
    assert.match(script, /window\.addEventListener\('focus', activeRefresh\)/);
    assert.match(script, /document\.addEventListener\('visibilitychange', activeRefresh\)/);
    assert.doesNotMatch(markup, /Search wines by name or SKU/);
    assert.match(script, /Click here, then press Control V to paste your image\./);
    assert.match(script, /google\.com\/search\?tbm=isch/);
    assert.match(script, /encodeURIComponent\(wine\.searchQuery\)/);
    assert.match(script, /clipboardData/);
    const css = await (await handle(new Request('https://review.finevines.biz/app.css'))).text();
    assert.match(css, /\.admin:empty\s*\{\s*display:\s*none/);
    assert.match(css, /\.modal-stage\s*\{[^}]*display:\s*flex;/s);
    assert.match(css, /\.modal-stage\s*\{[^}]*overflow-x:\s*auto;/s);
    assert.doesNotMatch(css, /\.modal-stage\s*\{[^}]*grid-template-columns/s);
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
    const action = { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    assert.equal(res.status, 202);
    assert.deepEqual(writes.map((p) => p.replace(/00000000-0000-4000-8000-\d{12}/, '<id>')), ['_review/test/actions/<id>.json', '_review/test/pending/<id>.json']);
    const refreshed = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const value = await refreshed.json();
    assert.equal(value.wines.length, 1);
    assert.deepEqual(value.reviewStatus, {
      needsDecision: 1, queued: 1, processing: 0, completed: 0, needsAttention: 0,
      oldestPendingAt: '2026-08-11T20:00:00.000Z',
    });
  });

  it('atomically accepts only one of two simultaneous same-wine submissions', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const request = () => new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) });
    const responses = await Promise.all([handle(request()), handle(request())]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
    assert.equal(new Set(writes).size, 2);
    assert.equal(writes.filter((path) => path.includes('/actions/')).length, 1);
    assert.equal(writes.filter((path) => path.includes('/pending/')).length, 1);
  });

  it('keeps the immutable pending action when immediate GitHub dispatch fails', async () => {
    const { handle, writes } = fixture({ dispatch: async () => { throw new Error('GitHub unavailable'); } });
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
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
    const action = { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'not-in-package' };
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    assert.equal(res.status, 400);
    assert.equal(writes.length, 0);
  });

  it('renders pending and durable receipt status', async () => {
    const { handle } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const queued = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    const { id } = await queued.json();
    const pending = await handle(new Request(`https://review.finevines.biz/api/actions/${id}`, { headers: { cookie } }));
    assert.equal((await pending.json()).status, 'queued');
  });

  it('accepts through a storage outage but writes nothing when the SQL transaction fails', async () => {
    const submit = async (options) => {
      const fixtureValue = fixture(options); const cookie = await login(fixtureValue.handle);
      const current = await fixtureValue.handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
      const csrf = (await current.json()).csrfToken;
      const response = await fixtureValue.handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' }) }));
      return { ...fixtureValue, response };
    };
    const storageDown = await submit({ storageWriteFailure: new Error('storage offline') });
    assert.equal(storageDown.response.status, 202);
    assert.equal(storageDown.queuedActions.length, 1);
    assert.deepEqual(storageDown.writes, []);
    const databaseDown = await submit({ queueFailure: new Error('database offline') });
    assert.equal(databaseDown.response.status, 400);
    assert.deepEqual(databaseDown.writes, []);
  });

  it('records the complete server-trusted rejected candidate identity set for none-of-these', async () => {
    const { handle, files, writes } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'no-image', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: '' };
    const response = await handle(new Request('https://review.finevines.biz/api/actions', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action),
    }));
    assert.equal(response.status, 202);
    const stored = JSON.parse(files.get(writes.find((path) => path.includes('/actions/'))));
    assert.equal(stored.wineSlug, 'producer-wine-2022');
    assert.deepEqual(stored.rejectedCandidates, [{ candidateId: 'c1', sha256: '1'.repeat(64), sourceImageUrl: 'https://producer.example/wine.png', sourceUrl: 'https://producer.example/wine' }]);
  });

  it('accepts simultaneous submissions for different wines', async () => {
    const { handle } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const actions = [
      { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' },
      { kind: 'image-select', sku: '500741*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'b'.repeat(64), candidateId: 'c2' },
    ];
    const responses = await Promise.all(actions.map((action) => handle(new Request('https://review.finevines.biz/api/actions', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action),
    }))));
    assert.deepEqual(responses.map(({ status }) => status), [202, 202]);
  });

  it('forces an invited reviewer to change the temporary password before review access', async () => {
    const invited = { ...REVIEWER_IDENTITY, mustChangePassword: true, credentialVersion: 1 };
    const { handle } = fixture({ identity: invited });
    const signedIn = await handle(new Request('https://review.finevines.biz/login', {
      method: 'POST', body: new URLSearchParams({ email: invited.email, password: 'correct horse' }),
    }));
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), '/change-password');
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];

    const formPage = await handle(new Request('https://review.finevines.biz/change-password', { headers: { cookie } }));
    const markup = await formPage.text();
    assert.match(markup, /Choose your password/);
    assert.match(markup, /minlength="8"/);
    assert.match(markup, /name="currentPassword"/);
    assert.match(markup, /name="newPassword"/);
    assert.match(markup, /name="confirmPassword"/);
    const csrf = markup.match(/name="csrf" value="([^"]+)"/)[1];
    const mismatch = await handle(new Request('https://review.finevines.biz/change-password', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz' },
      body: new URLSearchParams({ csrf, currentPassword: 'correct horse', newPassword: 'A-new-private-password-92!', confirmPassword: 'different-password' }),
    }));
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /New passwords do not match/);
    const changed = await handle(new Request('https://review.finevines.biz/change-password', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz' },
      body: new URLSearchParams({ csrf, currentPassword: 'correct horse', newPassword: 'A-new-private-password-92!', confirmPassword: 'A-new-private-password-92!' }),
    }));
    assert.equal(changed.status, 303);
    assert.equal(changed.headers.get('location'), '/');
    assert.notEqual(changed.headers.get('set-cookie').split(';')[0], cookie);
  });

  it('immutably stores and queues a reviewer-pasted image in dependency order', async () => {
    const { handle, writes, files } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const form = new FormData();
    form.set('sku', '500740*');
    form.set('packageId', 'pkg-1');
    form.set('targetCatalogCommit', 'abcdef1');
    form.set('wineRevision', 'a'.repeat(64));
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    form.set('image', new Blob([png], { type: 'image/png' }), 'pasted.png');
    const res = await handle(new Request('https://review.finevines.biz/api/reviewer-images', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'x-csrf-token': csrf }, body: form,
    }));
    assert.equal(res.status, 202);
    assert.deepEqual(writes.map((path) => path.replace(/00000000-0000-4000-8000-\d{12}/, '<id>')), [
      '_review/test/uploads/<id>.png', '_review/test/actions/<id>.json', '_review/test/pending/<id>.json',
    ]);
    const actionPath = writes.find((path) => path.includes('/actions/'));
    const action = JSON.parse(files.get(actionPath));
    assert.equal(action.kind, 'reviewer-image');
    assert.equal(action.imageMIME, 'image/png');
    assert.equal(action.imageBytes, png.byteLength);
    assert.match(action.imageSHA256, /^[a-f0-9]{64}$/);
    assert.equal(action.candidateId, '');
  });

  it('rejects unsafe reviewer-pasted image requests before writing anything', async () => {
    const { handle, writes, files } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const submit = async (bytes, type = 'image/png', origin = 'https://review.finevines.biz') => {
      const form = new FormData();
      for (const [key, value] of Object.entries({ sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64) })) form.set(key, value);
      form.set('image', new Blob([bytes], { type }), 'pasted.bin');
      return handle(new Request('https://review.finevines.biz/api/reviewer-images', { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrf }, body: form }));
    };
    assert.equal((await submit(new Uint8Array([1, 2, 3]), 'image/png')).status, 415);
    assert.equal((await submit(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'https://evil.example')).status, 403);
    assert.equal((await submit(new Uint8Array(10 * 1024 * 1024 + 1), 'image/png')).status, 413);
    const missingCSRF = new FormData();
    missingCSRF.set('image', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }));
    assert.equal((await handle(new Request('https://review.finevines.biz/api/reviewer-images', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz' }, body: missingCSRF }))).status, 403);
    assert.deepEqual(writes, []);
  });

  it('rejects truncated image containers before writing anything', async () => {
    const { handle, writes } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const submit = async (bytes) => {
      const form = new FormData();
      for (const [key, value] of Object.entries({ sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64) })) form.set(key, value);
      form.set('image', new Blob([bytes]), 'pasted.bin');
      return handle(new Request('https://review.finevines.biz/api/reviewer-images', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'x-csrf-token': csrf }, body: form }));
    };
    const corrupt = [
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52],
      [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46],
      [0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20],
    ];
    for (const bytes of corrupt) assert.equal((await submit(new Uint8Array(bytes))).status, 415);
    assert.deepEqual(writes, []);
  });

  it('derives the reviewer from the authenticated session', async () => {
    const { handle, writes, files } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const action = { kind: 'image-select', sku: '500740*', packageId: 'pkg-1', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const res = await handle(new Request('https://review.finevines.biz/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(action) }));
    assert.equal(res.status, 202);
    const actionPath = writes.find((path) => path.includes('/actions/'));
    assert.equal(JSON.parse(files.get(actionPath)).reviewer, 'barb.fultz@finevines.com');
  });

  it('synchronizes and manages eligible accounts without exposing credentials', async () => {
    const { handle, accountCalls } = fixture({ identity: { ...REVIEWER_IDENTITY, role: 'Support' } });
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    const listed = await handle(new Request('https://review.finevines.biz/api/admin/accounts', { headers: { cookie } }));
    const body = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(body.accounts[0].status, 'active');
    assert.equal(JSON.stringify(body).includes('password'), false);
    assert.equal(accountCalls[0][0], 'sync');
    const invited = await handle(new Request('https://review.finevines.biz/api/admin/accounts/barb.fultz%40finevines.com/activate', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'x-csrf-token': csrf },
    }));
    assert.equal(invited.status, 202);
    assert.deepEqual(accountCalls.at(-1), ['activate', 'barb.fultz@finevines.com']);
  });

  it('denies administrator routes to ordinary executive and back-office reviewers', async () => {
    const { handle } = fixture();
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    assert.equal((await handle(new Request('https://review.finevines.biz/api/admin/accounts', { headers: { cookie } }))).status, 403);
    assert.equal((await handle(new Request('https://review.finevines.biz/api/admin/accounts/barb.fultz%40finevines.com/activate', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'x-csrf-token': csrf },
    }))).status, 403);
  });

  it('offers retry but no unsafe force-complete endpoint', async () => {
    const { handle, queuedActions } = fixture({ identity: { ...REVIEWER_IDENTITY, role: 'Support' } });
    const cookie = await login(handle);
    const current = await handle(new Request('https://review.finevines.biz/api/current', { headers: { cookie } }));
    const csrf = (await current.json()).csrfToken;
    queuedActions.push({ id: '11111111-1111-4111-8111-111111111111', environment: 'test', status: 'needs_attention' });
    const retried = await handle(new Request('https://review.finevines.biz/api/admin/actions/11111111-1111-4111-8111-111111111111/retry', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'x-csrf-token': csrf },
    }));
    assert.equal(retried.status, 202);
    assert.equal(queuedActions.at(-1).status, 'queued');
    const forced = await handle(new Request('https://review.finevines.biz/api/admin/actions/11111111-1111-4111-8111-111111111111/complete', {
      method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'x-csrf-token': csrf },
    }));
    assert.equal(forced.status, 404);
  });
});
