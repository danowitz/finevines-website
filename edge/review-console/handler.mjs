import { csrfToken, issueSession, protectedHeaders, readCookie, validateAction, verifySession } from './core.mjs';
import { APP_CSS, APP_JS, consolePage } from './ui.mjs';

const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fine Vines image review</title></head><body>${body}</body></html>`;
const response = (body, init = {}) => new Response(body, { ...init, headers: protectedHeaders(init.headers) });
const json = (value, status = 200) => response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const safeSegment = (value) => /^[A-Za-z0-9._-]{1,180}$/.test(value || '');

async function loadPackage(storage, prefix, packageId) {
  if (!safeSegment(packageId)) throw new Error('invalid package');
  const raw = await storage.get(`${prefix}/packages/${packageId}/manifest.json`);
  if (!raw) throw new Error('package not found');
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion !== 1 || manifest.packageId !== packageId || !Array.isArray(manifest.wines)) throw new Error('invalid package');
  return manifest;
}

function actionTarget(manifest, action) {
  if (manifest.environment !== action.environment || manifest.catalogCommit !== action.targetCatalogCommit) throw new Error('action does not match package');
  const created = Date.parse(manifest.createdAt);
  const expires = Date.parse(manifest.expiresAt);
  const submitted = Date.parse(action.submittedAt);
  if (![created, expires, submitted].every(Number.isFinite) || expires <= created || submitted < created || submitted > expires) throw new Error('review package has expired');
  const wine = manifest.wines.find((item) => item.sku === action.sku);
  if (!wine || wine.wineRevision !== action.wineRevision) throw new Error('action does not match wine');
  if (action.kind === 'image-select' && !wine.candidates?.some((candidate) => candidate.candidateId === action.candidateId)) throw new Error('candidate does not belong to wine');
  return wine;
}

async function equalSecret(left, right) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([left, right].map((v) => crypto.subtle.digest('SHA-256', enc.encode(String(v)))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let mismatch = aa.length ^ bb.length;
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  return mismatch === 0;
}
export function createReviewConsole({ config, storage, dispatch, now = () => new Date(), uuid = () => crypto.randomUUID() }) {
  const prefix = `_review/${config.environment}`;
  const cookieName = config.cookieName;
  const loginWindowMs = 10 * 60_000;
  const loginBlockMs = 15 * 60_000;
  let loginFailures = [];
  let loginBlockedUntil = 0;

  const route = async function route(request) {
    const url = new URL(request.url);
    if (url.origin !== config.origin) return response('Not found', { status: 404 });

    if (request.method === 'POST' && url.pathname === '/login') {
      const clock = now().getTime();
      if (clock < loginBlockedUntil) return response(html('<h1>Sign in</h1><p>Too many attempts. Try again later.</p>'), { status: 429, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(Math.ceil((loginBlockedUntil - clock) / 1000)) } });
      const form = await request.formData();
      if (!await equalSecret(form.get('password'), config.password)) {
        loginFailures = loginFailures.filter((time) => clock - time < loginWindowMs);
        loginFailures.push(clock);
        if (loginFailures.length >= 5) loginBlockedUntil = clock + loginBlockMs;
        return response(html('<h1>Sign in</h1><p>Incorrect password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      loginFailures = [];
      loginBlockedUntil = 0;
      const sessionId = uuid();
      const token = await issueSession({ secret: config.sessionSecret, environment: config.environment, sessionId, now: now() });
      return response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${cookieName}=${token}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict` } });
    }

    const token = readCookie(request.headers.get('cookie'), cookieName);
    const session = await verifySession(token, { secret: config.sessionSecret, environment: config.environment, now: now() });
    if (!session) {
      if (url.pathname !== '/') return response('Not found', { status: 404 });
      return response(html('<main><h1>Fine Vines image review</h1><form method="post" action="/login"><label>Password <input name="password" type="password" required autocomplete="current-password"></label><button>Sign in</button></form></main>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return response(consolePage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/app.css') {
      return response(APP_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      return response(APP_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
    }

    if (request.method === 'GET' && url.pathname === '/api/current') {
      const current = JSON.parse(await storage.get(`${prefix}/current.json`));
      const manifest = await loadPackage(storage, prefix, current.packageId);
      return json({ ...manifest, csrfToken: await csrfToken(config.sessionSecret, session.sessionId) });
    }

    const imageRoute = url.pathname.match(/^\/api\/packages\/([^/]+)\/images\/([^/]+)$/);
    if (request.method === 'GET' && imageRoute) {
      try {
        const [, packageId, candidateId] = imageRoute.map(decodeURIComponent);
        if (!safeSegment(candidateId)) throw new Error('invalid candidate');
        const manifest = await loadPackage(storage, prefix, packageId);
        const candidate = manifest.wines.flatMap((wine) => wine.candidates || []).find((item) => item.candidateId === candidateId);
        if (!candidate || !safeSegment(candidate.storageName)) throw new Error('candidate not found');
        const bytes = await storage.getBytes(`${prefix}/packages/${packageId}/images/${candidate.storageName}`);
        if (!bytes || bytes.byteLength !== candidate.bytes) throw new Error('candidate not found');
        return response(bytes, { headers: { 'Content-Type': candidate.mime, 'Content-Length': String(bytes.byteLength) } });
      } catch {
        return response('Not found', { status: 404 });
      }
    }

    const actionStatusRoute = url.pathname.match(/^\/api\/actions\/([0-9a-f-]{36})$/i);
    if (request.method === 'GET' && actionStatusRoute) {
      const id = actionStatusRoute[1];
      const receipt = await storage.get(`${prefix}/receipts/${id}.json`);
      if (receipt) return json(JSON.parse(receipt));
      const pending = await storage.get(`${prefix}/pending/${id}.json`);
      return pending ? json({ id, status: 'queued' }) : response('Not found', { status: 404 });
    }

    if (request.method === 'POST' && url.pathname === '/api/actions') {
      if (request.headers.get('origin') !== config.origin) return json({ error: 'invalid origin' }, 403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'content type must be application/json' }, 415);
      if (request.headers.get('x-csrf-token') !== await csrfToken(config.sessionSecret, session.sessionId)) return json({ error: 'invalid csrf token' }, 403);
      try {
        const id = uuid();
        const action = validateAction(await request.json(), { id, environment: config.environment, sessionId: session.sessionId, now: now() });
        const manifest = await loadPackage(storage, prefix, action.packageId);
        actionTarget(manifest, action);
        const encoded = JSON.stringify(action);
        await storage.putImmutable(`${prefix}/actions/${id}.json`, encoded);
        await storage.putImmutable(`${prefix}/pending/${id}.json`, encoded);
        let dispatched = true;
        try { await dispatch(id, config.environment); } catch { dispatched = false; }
        return json({ id, status: 'queued', dispatched }, 202);
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    return response('Not found', { status: 404 });
  };
  return async function handle(request) {
    try {
      return await route(request);
    } catch {
      return response('Temporarily unavailable', { status: 503 });
    }
  };
}
