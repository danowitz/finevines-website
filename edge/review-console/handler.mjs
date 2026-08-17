import { csrfToken, issueSession, protectedHeaders, readCookie, validateAction, verifySession } from './core.mjs';
import { inspectReviewerImage, ReviewerImageError } from './reviewer-image.mjs';
import { ActiveWineLockError } from './review-state.mjs';
import { APP_CSS, APP_JS, FAVICON, changePasswordPage, consolePage, loginPage } from './ui.mjs';

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

function actionTarget(manifest, action, reviewer) {
  if (manifest.environment !== action.environment || manifest.catalogCommit !== action.targetCatalogCommit) throw new Error('action does not match package');
  if (!['Executive', 'Back Office', 'Support'].includes(reviewer.role)) throw new Error('reviewer is not authorized');
  const created = Date.parse(manifest.createdAt);
  const expires = Date.parse(manifest.expiresAt);
  const submitted = Date.parse(action.submittedAt);
  if (![created, expires, submitted].every(Number.isFinite) || expires <= created || submitted < created || submitted > expires) throw new Error('review package has expired');
  const wine = manifest.wines.find((item) => item.sku === action.sku);
  if (!wine || wine.wineRevision !== action.wineRevision) throw new Error('action does not match wine');
  if (action.kind === 'image-select' && !wine.candidates?.some((candidate) => candidate.candidateId === action.candidateId)) throw new Error('candidate does not belong to wine');
  return wine;
}

export function createReviewConsole({ config, storage, state, accounts, dispatch, now = () => new Date(), uuid = () => crypto.randomUUID() }) {
  if (!state?.initialize || !state?.queue) throw new Error('review console requires review state');
  if (!accounts?.authenticate || !accounts?.sessionIdentity) throw new Error('review console requires reviewer accounts');
  const prefix = `_review/${config.environment}`;
  const cookieName = config.cookieName;
  const loginWindowMs = 10 * 60_000;
  const loginBlockMs = 15 * 60_000;
  let loginFailures = [];
  let loginBlockedUntil = 0;
  const stateReady = state.initialize();

  async function queueAction(id, action, upload) {
    if (upload) await storage.putImmutable(`${prefix}/uploads/${action.imageStorageName}`, upload.bytes, action.imageMIME);
    const encoded = JSON.stringify(action);
    await storage.putImmutable(`${prefix}/actions/${id}.json`, encoded, 'application/json');
    await stateReady;
    await state.queue(action);
    await storage.putImmutable(`${prefix}/pending/${id}.json`, encoded, 'application/json');
    let dispatched = true;
    try { await dispatch(id, config.environment); } catch { dispatched = false; }
    return { id, status: 'queued', dispatched };
  }

  const route = async function route(request) {
    const url = new URL(request.url);
    if (url.origin !== config.origin) return response('Not found', { status: 404 });

    // These assets contain no review data. They are public so the sign-in
    // screen renders before a session exists; review JavaScript and data stay
    // behind the authentication guard below.
    if (request.method === 'GET' && url.pathname === '/app.css') {
      return response(APP_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      return response(FAVICON, { headers: { 'Content-Type': 'image/x-icon', 'Content-Length': String(FAVICON.byteLength) } });
    }

    if (request.method === 'POST' && url.pathname === '/login') {
      const clock = now().getTime();
      if (clock < loginBlockedUntil) return response(loginPage('Too many attempts. Try again later.'), { status: 429, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(Math.ceil((loginBlockedUntil - clock) / 1000)) } });
      const form = await request.formData();
      const identity = await accounts.authenticate(form.get('email'), form.get('password'));
      if (!identity) {
        loginFailures = loginFailures.filter((time) => clock - time < loginWindowMs);
        loginFailures.push(clock);
        if (loginFailures.length >= 5) loginBlockedUntil = clock + loginBlockMs;
        return response(loginPage('Incorrect password.'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      loginFailures = [];
      loginBlockedUntil = 0;
      const sessionId = uuid();
      const token = await issueSession({ secret: config.sessionSecret, environment: config.environment, sessionId,
        reviewerEmail: identity.email, credentialVersion: identity.credentialVersion,
        mustChangePassword: identity.mustChangePassword, now: now() });
      return response(null, { status: 303, headers: { Location: identity.mustChangePassword ? '/change-password' : '/', 'Set-Cookie': `${cookieName}=${token}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict` } });
    }

    const token = readCookie(request.headers.get('cookie'), cookieName);
    const session = await verifySession(token, { secret: config.sessionSecret, environment: config.environment, now: now() });
    const reviewer = session ? await accounts.sessionIdentity(session.reviewerEmail, session.credentialVersion) : null;
    if (!session || !reviewer) {
      if (url.pathname !== '/') return response('Not found', { status: 404 });
      return response(loginPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (reviewer.mustChangePassword) {
      const tokenValue = await csrfToken(config.sessionSecret, session.sessionId);
      if (request.method === 'GET' && url.pathname === '/change-password') {
        return response(changePasswordPage(tokenValue), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'POST' && url.pathname === '/change-password') {
        if (request.headers.get('origin') !== config.origin) return response(changePasswordPage(tokenValue, 'Invalid request.'), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        const form = await request.formData();
        if (form.get('csrf') !== tokenValue) return response(changePasswordPage(tokenValue, 'Invalid request.'), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        try {
          const updated = await accounts.changePassword(reviewer, form.get('currentPassword'), form.get('newPassword'));
          const next = await issueSession({ secret: config.sessionSecret, environment: config.environment, sessionId: uuid(),
            reviewerEmail: updated.email, credentialVersion: updated.credentialVersion, mustChangePassword: false, now: now() });
          return response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${cookieName}=${next}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict` } });
        } catch (error) {
          return response(changePasswordPage(tokenValue, error.message), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
      }
      return response(null, { status: 303, headers: { Location: '/change-password' } });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return response(consolePage(reviewer), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      return response(APP_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/accounts') {
      const current = JSON.parse(await storage.get(`${prefix}/current.json`));
      const manifest = await loadPackage(storage, prefix, current.packageId);
      await stateReady;
      await accounts.sync(manifest.reviewers || []);
      return json({ accounts: await accounts.list(), csrfToken: await csrfToken(config.sessionSecret, session.sessionId) });
    }

    const activateAccountRoute = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/activate$/);
    if (request.method === 'POST' && activateAccountRoute) {
      if (request.headers.get('origin') !== config.origin) return json({ error: 'invalid origin' }, 403);
      if (request.headers.get('x-csrf-token') !== await csrfToken(config.sessionSecret, session.sessionId)) return json({ error: 'invalid csrf token' }, 403);
      const email = decodeURIComponent(activateAccountRoute[1]);
      try {
        await accounts.activate(email);
        let dispatched = true;
        try { await dispatch(`account:${email}`, config.environment); } catch { dispatched = false; }
        return json({ status: 'invited', dispatched }, 202);
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    const retryActionRoute = url.pathname.match(/^\/api\/admin\/actions\/([0-9a-f-]{36})\/retry$/i);
    if (request.method === 'POST' && retryActionRoute) {
      if (request.headers.get('origin') !== config.origin) return json({ error: 'invalid origin' }, 403);
      if (request.headers.get('x-csrf-token') !== await csrfToken(config.sessionSecret, session.sessionId)) return json({ error: 'invalid csrf token' }, 403);
      try {
        await state.transition(retryActionRoute[1], 'needs_attention', 'queued', `retried by ${reviewer.email}`);
        let dispatched = true;
        try { await dispatch(retryActionRoute[1], config.environment); } catch { dispatched = false; }
        return json({ status: 'queued', dispatched }, 202);
      } catch (error) {
        return json({ error: error.message }, 409);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/current') {
      const current = JSON.parse(await storage.get(`${prefix}/current.json`));
      const manifest = await loadPackage(storage, prefix, current.packageId);
      await stateReady;
      const currentStatus = await state.packageStatus(config.environment, manifest.wines);
      const incidents = await state.scanIncidents(config.environment, config.incidentRecipient);
      return json({
        ...manifest,
        wines: currentStatus.decisions,
        reviewStatus: { ...currentStatus.counts, oldestPendingAt: currentStatus.oldestPendingAt },
        incidents,
        csrfToken: await csrfToken(config.sessionSecret, session.sessionId),
      });
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
      await stateReady;
      const value = await state.actionStatus(id, config.environment);
      return value ? json(value) : response('Not found', { status: 404 });
    }

    if (request.method === 'POST' && url.pathname === '/api/reviewer-images') {
      if (request.headers.get('origin') !== config.origin) return json({ error: 'invalid origin' }, 403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) return json({ error: 'content type must be multipart/form-data' }, 415);
      if (request.headers.get('x-csrf-token') !== await csrfToken(config.sessionSecret, session.sessionId)) return json({ error: 'invalid csrf token' }, 403);
      try {
        const form = await request.formData();
        const inspected = await inspectReviewerImage(form.get('image'));
        const id = uuid();
        const imageStorageName = `${id}.${inspected.extension}`;
        const action = validateAction({
          kind: 'reviewer-image', sku: form.get('sku'), packageId: form.get('packageId'),
          targetCatalogCommit: form.get('targetCatalogCommit'), wineRevision: form.get('wineRevision'), candidateId: '',
          imageStorageName, imageSHA256: inspected.sha256, imageBytes: inspected.bytesLength, imageMIME: inspected.mime,
        }, { id, environment: config.environment, sessionId: session.sessionId, reviewerEmail: reviewer.email, now: now(), allowReviewerImage: true });
        const manifest = await loadPackage(storage, prefix, action.packageId);
        actionTarget(manifest, action, reviewer);
        return json(await queueAction(id, action, inspected), 202);
      } catch (error) {
        return json({ error: error.message }, error instanceof ReviewerImageError ? error.status : error instanceof ActiveWineLockError ? 409 : 400);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/actions') {
      if (request.headers.get('origin') !== config.origin) return json({ error: 'invalid origin' }, 403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'content type must be application/json' }, 415);
      if (request.headers.get('x-csrf-token') !== await csrfToken(config.sessionSecret, session.sessionId)) return json({ error: 'invalid csrf token' }, 403);
      try {
        const id = uuid();
        const action = validateAction(await request.json(), { id, environment: config.environment, sessionId: session.sessionId, reviewerEmail: reviewer.email, now: now() });
        const manifest = await loadPackage(storage, prefix, action.packageId);
        actionTarget(manifest, action, reviewer);
        return json(await queueAction(id, action), 202);
      } catch (error) {
        return json({ error: error.message }, error instanceof ActiveWineLockError ? 409 : 400);
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
