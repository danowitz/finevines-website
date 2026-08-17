const encoder = new TextEncoder();

export const ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
export const ACTION_KINDS = new Set(['image-select', 'no-image', 'reviewer-image']);

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function csrfToken(secret, sessionId) {
  return b64url(await hmac(secret, `csrf:${sessionId}`));
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

export function protectedHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    // Same-origin form posts must retain their trustworthy Origin value for
    // CSRF checks. The policy still strips referrers from every cross-origin
    // request, including candidate-source and Google search links.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': ROBOTS,
    ...extra,
  };
}

export async function issueSession({ secret, environment, sessionId, reviewerEmail, credentialVersion, mustChangePassword, now, ttlSeconds = 43_200 }) {
  const payload = b64url(encoder.encode(JSON.stringify({
    v: 2, environment, sessionId, reviewerEmail, credentialVersion, mustChangePassword,
    exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
  })));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

export async function verifySession(token, { secret, environment, now }) {
  try {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra) return null;
    const expected = await hmac(secret, payload);
    const actual = fromB64url(signature);
    if (actual.length !== expected.length) return null;
    let mismatch = 0;
    for (let i = 0; i < actual.length; i++) mismatch |= actual[i] ^ expected[i];
    if (mismatch) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (parsed.v !== 2 || parsed.environment !== environment || typeof parsed.sessionId !== 'string') return null;
    if (typeof parsed.reviewerEmail !== 'string' || !Number.isInteger(parsed.credentialVersion) || typeof parsed.mustChangePassword !== 'boolean') return null;
    if (!Number.isInteger(parsed.exp) || parsed.exp <= Math.floor(now.getTime() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function validateAction(input, context) {
  const allowed = new Set(['kind', 'sku', 'packageId', 'targetCatalogCommit', 'wineRevision', 'candidateId', 'imageStorageName', 'imageSHA256', 'imageBytes', 'imageMIME']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('action must be an object');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown action field ${key}`);
  const text = (key, max, pattern = /^.{1,}$/u) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || !pattern.test(value)) throw new Error(`invalid ${key}`);
    return value;
  };
  const kind = text('kind', 32);
  if (!ACTION_KINDS.has(kind)) throw new Error('invalid kind');
  if (kind === 'reviewer-image' && context.allowReviewerImage !== true) throw new Error('invalid kind');
  const action = {
    schemaVersion: 1,
    id: context.id,
    environment: context.environment,
    reviewer: String(context.reviewerEmail || ''),
    sku: text('sku', 80, /^[A-Za-z0-9._*-]+$/),
    kind,
    packageId: text('packageId', 160, /^[A-Za-z0-9._-]+$/),
    targetCatalogCommit: text('targetCatalogCommit', 64, /^[a-f0-9]{7,64}$/),
    wineRevision: text('wineRevision', 64, /^[a-f0-9]{64}$/),
    candidateId: input.candidateId === '' && (kind === 'no-image' || kind === 'reviewer-image') ? '' : text('candidateId', 120, /^[A-Za-z0-9._-]+$/),
    submittedAt: context.now.toISOString(),
    csrfSessionId: context.sessionId,
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(action.reviewer) || action.reviewer.length > 254) throw new Error('invalid reviewer identity');
  if (kind === 'image-select' && !action.candidateId) throw new Error('image-select requires candidateId');
  if (kind === 'no-image' && action.candidateId) throw new Error('no-image cannot name a candidate');
  const imageFields = ['imageStorageName', 'imageSHA256', 'imageBytes', 'imageMIME'];
  if (kind === 'reviewer-image') {
    action.imageStorageName = text('imageStorageName', 180, /^[A-Za-z0-9._-]+$/);
    action.imageSHA256 = text('imageSHA256', 64, /^[a-f0-9]{64}$/);
    if (!Number.isInteger(input.imageBytes) || input.imageBytes <= 0 || input.imageBytes > 10 * 1024 * 1024) throw new Error('invalid imageBytes');
    action.imageBytes = input.imageBytes;
    action.imageMIME = text('imageMIME', 24, /^image\/(?:jpeg|png|webp)$/);
  } else if (imageFields.some((field) => input[field] !== undefined)) {
    throw new Error('image metadata requires reviewer-image');
  }
  return action;
}
