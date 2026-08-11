import { csrfToken, issueSession, protectedHeaders, readCookie, validateAction, verifySession } from './core.mjs';

const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fine Vines image review</title></head><body>${body}</body></html>`;
const response = (body, init = {}) => new Response(body, { ...init, headers: protectedHeaders(init.headers) });
const json = (value, status = 200) => response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

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

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.origin !== config.origin) return response('Not found', { status: 404 });

    if (request.method === 'POST' && url.pathname === '/login') {
      const form = await request.formData();
      if (!await equalSecret(form.get('password'), config.password)) return response(html('<h1>Sign in</h1><p>Incorrect password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

    if (request.method === 'GET' && url.pathname === '/api/current') {
      const current = JSON.parse(await storage.get(`${prefix}/current.json`));
      const manifest = JSON.parse(await storage.get(`${prefix}/packages/${current.packageId}/manifest.json`));
      return json({ ...manifest, csrfToken: await csrfToken(config.sessionSecret, session.sessionId) });
    }

    if (request.method === 'POST' && url.pathname === '/api/actions') {
      if (request.headers.get('origin') !== config.origin) return json({ error: 'invalid origin' }, 403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'content type must be application/json' }, 415);
      if (request.headers.get('x-csrf-token') !== await csrfToken(config.sessionSecret, session.sessionId)) return json({ error: 'invalid csrf token' }, 403);
      try {
        const id = uuid();
        const action = validateAction(await request.json(), { id, environment: config.environment, sessionId: session.sessionId, now: now() });
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
}

