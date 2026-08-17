import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import { createReviewConsole } from '../../edge/review-console/handler.mjs';
import { createReviewerAccounts } from '../../edge/review-console/reviewer-accounts.mjs';
import { createReviewState } from '../../edge/review-console/review-state.mjs';
import { wineRevision } from '../../tools/labelfetch/review-package.mjs';
import { runQueueCommand } from '../../tools/review-console/queue.mjs';
import { APP_JS, consolePage } from '../../edge/review-console/ui.mjs';
import { openBrowser } from '../helpers/browser.js';

globalThis.crypto ??= webcrypto;
const exec = promisify(execFile);
const roots = [];
after(async () => {
  while (roots.length) {
    const root = roots.pop();
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
    }
  }
});

function fileStorage(root) {
  const name = (path) => {
    const target = resolve(root, ...path.split('/'));
    if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) throw new Error('storage path escaped root');
    return target;
  };
  return {
    get: async (path) => readFile(name(path), 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    getBytes: async (path) => readFile(name(path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    put: async (path, body) => { await mkdir(dirname(name(path)), { recursive: true }); await writeFile(name(path), body); },
    putImmutable: async (path, body) => {
      const target = name(path); await mkdir(dirname(target), { recursive: true });
      const existing = await readFile(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      const bytes = Buffer.from(body);
      if (existing && !existing.equals(bytes)) throw new Error('immutable object differs');
      if (!existing) await writeFile(target, bytes);
    },
  };
}

async function request(handle, path, init = {}) {
  return handle(new Request(`https://review.finevines.biz${path}`, init));
}

test('local acceptance gate carries one human selection through verified deployment', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'finevines-review-e2e-')); roots.push(root);
  const objectRoot = join(root, 'objects'); const storage = fileStorage(objectRoot);
  const client = createClient({ url: 'file::memory:' });
  const state = createReviewState({ client, now: () => new Date('2026-08-17T12:00:00Z') });
  await state.initialize();
  const mail = [];
  const accounts = createReviewerAccounts({ state, mailer: { send: async (message) => mail.push(message) }, now: () => new Date('2026-08-17T12:00:00Z'), temporaryPassword: () => 'Temporary-review-pass-92!' });
  await accounts.sync([{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }]);
  await accounts.activate('barb.fultz@finevines.com');
  assert.equal(mail.length, 1, 'invitation used the capture adapter');
  const invited = await accounts.authenticate('barb.fultz@finevines.com', 'Temporary-review-pass-92!');
  await accounts.changePassword(invited, 'Temporary-review-pass-92!', 'Private-review-password-93!');

  const wine = { id: 'wine-1', sku: '500740*', slug: 'producer-wine-2022', producer: 'Producer', name: 'Wine', vintage: '2022', imagePath: 'assets/img/wines/producer-wine-2022.svg', imageSource: 'generated-label', sourceHash: 'source', status: 'Active' };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const sha = createHash('sha256').update(png).digest('hex');
  const manifest = {
    schemaVersion: 1, packageId: 'pkg-e2e', environment: 'test', catalogCommit: 'abcdef1', createdAt: '2026-08-17T11:00:00Z', expiresAt: '2026-09-17T11:00:00Z',
    reviewers: [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }],
    wines: [{ sku: wine.sku, slug: wine.slug, displayIdentity: 'Producer Wine 2022', searchQuery: 'Producer Wine 2022', wineRevision: wineRevision(wine), candidates: [{ candidateId: 'candidate-1', storageName: 'candidate-1.png', sha256: sha, bytes: png.length, mime: 'image/png', width: 1, height: 1, sourceUrl: 'https://producer.example/wine', sourceImageUrl: 'https://producer.example/wine.png' }] }],
  };
  await storage.put('_review/test/current.json', JSON.stringify({ packageId: manifest.packageId }));
  await storage.put(`_review/test/packages/${manifest.packageId}/manifest.json`, JSON.stringify(manifest));
  await storage.put(`_review/test/packages/${manifest.packageId}/images/candidate-1.png`, png);

  const trace = [];
  const handle = createReviewConsole({
    config: { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', sessionSecret: 'local-e2e-session-secret', incidentRecipient: 'joel@gritautomation.com' },
    storage, state, accounts, dispatch: async () => { throw new Error('simulated immediate trigger outage'); },
    now: () => new Date('2026-08-17T12:00:00Z'), uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })(),
  });
  const login = await request(handle, '/login', { method: 'POST', body: new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'Private-review-password-93!' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0]; trace.push({ step: 'login', status: login.status });
  const current = await request(handle, '/api/current', { headers: { cookie } }); const currentBody = await current.json();
  const queued = await request(handle, '/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': currentBody.csrfToken }, body: JSON.stringify({ kind: 'image-select', sku: wine.sku, packageId: manifest.packageId, targetCatalogCommit: manifest.catalogCommit, wineRevision: manifest.wines[0].wineRevision, candidateId: 'candidate-1' }) });
  const queuedBody = await queued.json(); assert.equal(queuedBody.dispatched, false); trace.push({ step: 'queue', ...queuedBody });

  const claims = join(root, 'claims.json'); const claimed = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', claims], state, now: () => new Date('2026-08-17T12:05:00Z') });
  assert.equal(claimed.claimed, 1); trace.push({ step: 'scheduled-claim', claimed: claimed.claimed });
  const workspace = join(root, 'workspace'); await mkdir(join(workspace, 'data'), { recursive: true }); await mkdir(join(workspace, 'assets', 'img', 'wines'), { recursive: true });
  const catalog = join(workspace, 'data', 'wines.json'); await writeFile(catalog, JSON.stringify([wine]));
  const executable = join(root, process.platform === 'win32' ? 'finevines.exe' : 'finevines'); const normalizer = join(workspace, process.platform === 'win32' ? 'imgnorm.exe' : 'imgnorm');
  await exec('go', ['build', '-o', executable, './cmd/finevines']); await exec('go', ['build', '-o', normalizer, './tools/imgnorm']);
  const decisions = join(root, 'decisions.json'); const applied = join(root, 'applied.json');
  await exec(executable, ['reviewapply', '-environment', 'test', '-review-dir', objectRoot, '-catalog', catalog, '-image-dir', join(workspace, 'assets', 'img', 'wines'), '-action-ids', claims, '-decisions', decisions, '-applied', applied], { cwd: workspace });
  const decisionRows = JSON.parse(await readFile(decisions, 'utf8')); assert.equal(decisionRows[0].status, 'prepared'); trace.push({ step: 'prepare', status: decisionRows[0].status });
  await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisions], state });

  const deployedFile = resolve(workspace, ...decisionRows[0].deployedImagePath.split('/'));
  const server = createServer(async (req, res) => { const bytes = await readFile(deployedFile); res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(bytes); });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const target = `http://127.0.0.1:${server.address().port}`;
  try {
    await exec(executable, ['reviewfinalize', '-environment', 'test', '-review-dir', objectRoot, '-decisions', decisions, '-target', target, '-run-id', 'local-e2e', '-catalog-commit', 'a'.repeat(40)], { cwd: workspace });
  } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
  await runQueueCommand({ args: ['complete', '--environment', 'test', '--decisions', decisions], state });
  assert.equal((await state.actionStatus(queuedBody.id, 'test')).status, 'completed');
  assert.equal(await storage.get(`_review/test/pending/${queuedBody.id}.json`), null);
  assert.ok(await storage.get(`_review/test/receipts/${queuedBody.id}.json`));
  const deployedCatalog = JSON.parse(await readFile(catalog, 'utf8')); assert.equal(deployedCatalog[0].imageReviewActionId, queuedBody.id);
  trace.push({ step: 'verified-completion', actionId: queuedBody.id, status: 'completed', emailDeliveries: 0 });
  const tracePath = resolve(process.env.FINEVINES_E2E_TRACE || '.run/review-processing-e2e-trace.json'); await mkdir(dirname(tracePath), { recursive: true }); await writeFile(tracePath, JSON.stringify(trace, null, 2) + '\n');
  await client.close();
});

test('local acceptance gate covers concurrent reviewers, fifty-action continuation, and rejected-image recovery', async () => {
  const client = createClient({ url: 'file::memory:' });
  const state = createReviewState({ client, now: () => new Date('2026-08-17T12:00:00Z') });
  await state.initialize();
  const queued = [];
  for (let index = 1; index <= 51; index++) {
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const action = {
      schemaVersion: 1, id, environment: 'test', reviewer: index % 2 ? 'barb.fultz@finevines.com' : 'connie@finevines.com',
      sku: `SKU-${index}`, kind: 'image-select', packageId: 'pkg-matrix', targetCatalogCommit: 'abcdef1',
      wineRevision: index.toString(16).padStart(64, '0'), candidateId: `candidate-${index}`,
      submittedAt: '2026-08-17T12:00:00Z', csrfSessionId: `session-${index % 2}`,
    };
    queued.push(action); await state.queue(action);
  }
  const claimFile = join(await mkdtemp(join(tmpdir(), 'finevines-review-matrix-')), 'claims.json'); roots.push(dirname(claimFile));
  const first = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', claimFile], state, now: () => new Date('2026-08-17T12:01:00Z') });
  assert.deepEqual({ claimed: first.claimed, remaining: first.remaining }, { claimed: 50, remaining: 1 });
  assert.equal(new Set(queued.slice(0, 50).map(({ reviewer }) => reviewer)).size, 2, 'both reviewers retain independent decisions');

  // An action-specific rejection is isolated while a prepared neighbor stays
  // processing for verified deployment; an operational transition error does
  // not delete either action.
  const decisions = join(dirname(claimFile), 'decisions.json');
  await writeFile(decisions, JSON.stringify([
    { id: queued[0].id, status: 'rejected', reason: 'candidate revision conflict' },
    { id: queued[1].id, status: 'prepared' },
  ]));
  const reconciled = await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisions], state });
  assert.equal(reconciled.needsAttention, 1);
  assert.equal((await state.actionStatus(queued[0].id, 'test')).status, 'needs_attention');
  assert.equal((await state.actionStatus(queued[1].id, 'test')).status, 'processing');
  await assert.rejects(state.transition(queued[1].id, 'queued', 'completed'), /invalid review action transition|is not queued/);
  assert.equal((await state.actionStatus(queued[1].id, 'test')).status, 'processing');

  const rejected = {
    schemaVersion: 1, id: '20000000-0000-4000-8000-000000000001', environment: 'test', reviewer: 'barb.fultz@finevines.com',
    sku: 'SKU-RECOVERY', kind: 'no-image', packageId: 'pkg-matrix', targetCatalogCommit: 'abcdef1', wineRevision: 'f'.repeat(64),
    candidateId: '', wineSlug: 'recovery-wine-2022', submittedAt: '2026-08-17T12:02:00Z', csrfSessionId: 'session-1',
    rejectedCandidates: [{ candidateId: 'old', sha256: 'e'.repeat(64), sourceImageUrl: 'https://example.test/old.png', sourceUrl: 'https://example.test/old' }],
  };
  await state.queue(rejected);
  await state.transition(rejected.id, 'queued', 'processing');
  await state.scheduleRecovery(rejected.id, 'test');
  assert.equal((await state.pendingRecoveries('test'))[0].rejectedCandidates[0].candidateId, 'old');
  await state.resolveRecovery(rejected.id, 'ready', 'new candidate identity found');
  const reopened = await state.packageStatus('test', [{ sku: rejected.sku, slug: rejected.wineSlug, wineRevision: rejected.wineRevision }]);
  assert.equal(reopened.counts.needsDecision, 1);
  assert.equal(reopened.decisions[0].slug, rejected.wineSlug);
  await client.close();
});

test('review UI refreshes when focused and stays quiet in a background tab', { timeout: 30_000 }, async () => {
  const browser = await openBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(consolePage({ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__reviewFetches = 0;
      window.__reviewFocused = true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__reviewFocused ? 'visible' : 'hidden' });
      document.hasFocus = () => window.__reviewFocused;
      window.fetch = async () => {
        window.__reviewFetches += 1;
        return { ok: true, json: async () => ({ wines: [], incidents: [], isAdministrator: false, expiresAt: '2026-09-17T00:00:00Z', reviewStatus: {} }) };
      };
    });
    await page.evaluate((source) => (0, eval)(source), APP_JS);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const initial = await page.evaluate(() => window.__reviewFetches);
    assert.equal(initial, 1);
    await page.evaluate(() => { window.__reviewFocused = false; window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(await page.evaluate(() => window.__reviewFetches), initial);
    await page.evaluate(() => { window.__reviewFocused = true; window.dispatchEvent(new Event('focus')); });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(await page.evaluate(() => window.__reviewFetches), initial + 1);
  } finally {
    await page.close(); await browser.close();
  }
});
