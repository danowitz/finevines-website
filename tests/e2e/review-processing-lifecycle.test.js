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
import { dispatchReviewWorkflow } from '../../tools/review-console/dispatch.mjs';
import { APP_JS, consolePage } from '../../edge/review-console/ui.mjs';
import { openBrowser } from '../helpers/browser.js';

globalThis.crypto ??= webcrypto;
const exec = promisify(execFile);
const roots = [];
const REQUIRED_TRACE_SCENARIOS = [
  'verified deployment and invalid-image isolation',
  'fifty-action continuation, isolation, release, and rediscovery',
  'real Go processor deadline yield',
  'real Go processor operational failure and preservation',
  'real browser onboarding, concurrency, counters, modal, and incident recovery',
];
const acceptanceTrace = REQUIRED_TRACE_SCENARIOS.map((scenario) => ({ scenario, outcome: 'not-run', evidence: {}, transitions: [] }));

async function recordStateTrace(client, scenario, outcome, evidence = {}, error) {
  const entry = acceptanceTrace.find((item) => item.scenario === scenario);
  entry.outcome = outcome;
  entry.evidence = { ...evidence, ...(error ? { error: { name: error.name, message: error.message, stack: error.stack } } : {}) };
  try {
    const result = await client.execute('SELECT action_id, status, occurred_at, detail FROM review_action_events ORDER BY sequence');
    entry.transitions = result.rows.map((row) => ({
      actionId: String(row.action_id), status: String(row.status), occurredAt: String(row.occurred_at), detail: String(row.detail || ''),
    }));
  } catch (traceError) {
    entry.evidence.traceReadError = traceError.message;
  }
}

async function tracedScenario(client, scenario, run) {
  const trace = { evidence: {} };
  try {
    await run(trace);
    await recordStateTrace(client, scenario, 'passed', trace.evidence);
  } catch (error) {
    await recordStateTrace(client, scenario, 'failed', trace.evidence, error);
    throw error;
  } finally {
    await client.close();
  }
}

after(async () => {
  const tracePath = resolve(process.env.FINEVINES_E2E_TRACE || '.run/review-processing-e2e-trace.json');
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), scenarios: acceptanceTrace }, null, 2)}\n`);
  assert.deepEqual(acceptanceTrace.map(({ scenario }) => scenario), REQUIRED_TRACE_SCENARIOS);
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

async function serveConsole(createHandle) {
  let handle;
  const requests = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      requests.push({ method: incoming.method, url: incoming.url, origin: incoming.headers.origin || '' });
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const init = { method: incoming.method, headers: incoming.headers };
      if (!['GET', 'HEAD'].includes(incoming.method)) init.body = Buffer.concat(chunks);
      const value = await handle(new Request(`${server.origin}${incoming.url}`, init));
      outgoing.statusCode = value.status;
      value.headers.forEach((headerValue, headerName) => outgoing.setHeader(headerName, headerValue));
      outgoing.end(Buffer.from(await value.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(error.stack || error.message);
    }
  });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  server.origin = `http://127.0.0.1:${server.address().port}`;
  handle = createHandle(server.origin);
  return { origin: server.origin, requests, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

test('local acceptance gate carries one human selection through verified deployment', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'finevines-review-e2e-')); roots.push(root);
  const objectRoot = join(root, 'objects'); const storage = fileStorage(objectRoot);
  const client = createClient({ url: 'file::memory:' });
  await tracedScenario(client, 'verified deployment and invalid-image isolation', async (trace) => {
  const state = createReviewState({ client, now: () => new Date('2026-08-17T12:00:00Z') });
  await state.initialize();
  const mail = [];
  const accounts = createReviewerAccounts({ state, mailer: { send: async (message) => mail.push(message) }, reviewUrl: 'https://review.finevines.biz', now: () => new Date('2026-08-17T12:00:00Z'), temporaryPassword: () => 'Temporary-review-pass-92!' });
  await accounts.sync([{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }]);
  await accounts.activate('barb.fultz@finevines.com');
  assert.equal(mail.length, 1, 'invitation used the capture adapter');
  const invited = await accounts.authenticate('barb.fultz@finevines.com', 'Temporary-review-pass-92!');
  await accounts.changePassword(invited, 'Temporary-review-pass-92!', 'Private-review-password-93!');

  const wine = { id: 'wine-1', sku: '500740*', slug: 'producer-wine-2022', producer: 'Producer', name: 'Wine', vintage: '2022', imagePath: 'assets/img/wines/producer-wine-2022.svg', imageSource: 'generated-label', sourceHash: 'source', status: 'Active' };
  const badWine = { id: 'wine-2', sku: '500741*', slug: 'producer-bad-wine-2022', producer: 'Producer', name: 'Bad Wine', vintage: '2022', imagePath: 'assets/img/wines/producer-bad-wine-2022.svg', imageSource: 'generated-label', sourceHash: 'source-bad', status: 'Active' };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const corruptPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
  const sha = createHash('sha256').update(png).digest('hex');
  const corruptSha = createHash('sha256').update(corruptPng).digest('hex');
  const manifest = {
    schemaVersion: 1, packageId: 'pkg-e2e', environment: 'test', catalogCommit: 'abcdef1', createdAt: '2026-08-17T11:00:00Z', expiresAt: '2026-09-17T11:00:00Z',
    reviewers: [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }],
    wines: [
      { sku: wine.sku, slug: wine.slug, displayIdentity: 'Producer Wine 2022', searchQuery: 'Producer Wine 2022', wineRevision: wineRevision(wine), candidates: [{ candidateId: 'candidate-1', storageName: 'candidate-1.png', sha256: sha, bytes: png.length, mime: 'image/png', width: 1, height: 1, sourceUrl: 'https://producer.example/wine', sourceImageUrl: 'https://producer.example/wine.png' }] },
      { sku: badWine.sku, slug: badWine.slug, displayIdentity: 'Producer Bad Wine 2022', searchQuery: 'Producer Bad Wine 2022', wineRevision: wineRevision(badWine), candidates: [{ candidateId: 'candidate-bad', storageName: 'candidate-bad.png', sha256: corruptSha, bytes: corruptPng.length, mime: 'image/png', width: 1, height: 1, sourceUrl: 'https://producer.example/bad', sourceImageUrl: 'https://producer.example/bad.png' }] },
    ],
  };
  await storage.put('_review/test/current.json', JSON.stringify({ packageId: manifest.packageId }));
  await storage.put(`_review/test/packages/${manifest.packageId}/manifest.json`, JSON.stringify(manifest));
  await storage.put(`_review/test/packages/${manifest.packageId}/images/candidate-1.png`, png);
  await storage.put(`_review/test/packages/${manifest.packageId}/images/candidate-bad.png`, corruptPng);

  const handle = createReviewConsole({
    config: { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', sessionSecret: 'local-e2e-session-secret', incidentRecipient: 'joel@gritautomation.com' },
    storage, state, accounts, dispatch: async () => { throw new Error('simulated immediate trigger outage'); },
    now: () => new Date('2026-08-17T12:00:00Z'), uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })(),
  });
  const login = await request(handle, '/login', { method: 'POST', body: new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'Private-review-password-93!' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const current = await request(handle, '/api/current', { headers: { cookie } }); const currentBody = await current.json();
  const queued = await request(handle, '/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': currentBody.csrfToken }, body: JSON.stringify({ kind: 'image-select', sku: wine.sku, packageId: manifest.packageId, targetCatalogCommit: manifest.catalogCommit, wineRevision: manifest.wines[0].wineRevision, candidateId: 'candidate-1' }) });
  const queuedBody = await queued.json(); assert.equal(queuedBody.dispatched, false);
  const badQueued = await request(handle, '/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': currentBody.csrfToken }, body: JSON.stringify({ kind: 'image-select', sku: badWine.sku, packageId: manifest.packageId, targetCatalogCommit: manifest.catalogCommit, wineRevision: manifest.wines[1].wineRevision, candidateId: 'candidate-bad' }) });
  const badQueuedBody = await badQueued.json(); assert.equal(badQueued.status, 202);

  const claims = join(root, 'claims.json'); const claimed = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', claims], state, now: () => new Date('2026-08-17T12:05:00Z') });
  assert.equal(claimed.claimed, 2);
  const workspace = join(root, 'workspace'); await mkdir(join(workspace, 'data'), { recursive: true }); await mkdir(join(workspace, 'assets', 'img', 'wines'), { recursive: true });
  const catalog = join(workspace, 'data', 'wines.json'); await writeFile(catalog, JSON.stringify([wine, badWine]));
  const executable = join(root, process.platform === 'win32' ? 'finevines.exe' : 'finevines'); const normalizer = join(workspace, process.platform === 'win32' ? 'imgnorm.exe' : 'imgnorm');
  await exec('go', ['build', '-o', executable, './cmd/finevines']); await exec('go', ['build', '-o', normalizer, './tools/imgnorm']);
  const decisions = join(root, 'decisions.json'); const applied = join(root, 'applied.json');
  await exec(executable, ['reviewapply', '-environment', 'test', '-review-dir', objectRoot, '-catalog', catalog, '-image-dir', join(workspace, 'assets', 'img', 'wines'), '-action-ids', claims, '-decisions', decisions, '-applied', applied], { cwd: workspace });
  const decisionRows = JSON.parse(await readFile(decisions, 'utf8'));
  const preparedDecision = decisionRows.find(({ id }) => id === queuedBody.id);
  const rejectedDecision = decisionRows.find(({ id }) => id === badQueuedBody.id);
  assert.equal(preparedDecision.status, 'prepared');
  assert.equal(rejectedDecision.status, 'rejected');
  await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisions], state });

  const deployedFile = resolve(workspace, ...preparedDecision.deployedImagePath.split('/'));
  const server = createServer(async (req, res) => { const bytes = await readFile(deployedFile); res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(bytes); });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const target = `http://127.0.0.1:${server.address().port}`;
  try {
    await exec(executable, ['reviewfinalize', '-environment', 'test', '-review-dir', objectRoot, '-decisions', decisions, '-target', target, '-run-id', 'local-e2e', '-catalog-commit', 'a'.repeat(40)], { cwd: workspace });
  } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
  await runQueueCommand({ args: ['complete', '--environment', 'test', '--decisions', decisions], state, storage });
  assert.equal((await state.actionStatus(queuedBody.id, 'test')).status, 'completed');
  assert.equal((await state.actionStatus(badQueuedBody.id, 'test')).status, 'needs_attention');
  assert.equal(await storage.get(`_review/test/pending/${queuedBody.id}.json`), null);
  assert.ok(await storage.get(`_review/test/receipts/${queuedBody.id}.json`));
  const deployedCatalog = JSON.parse(await readFile(catalog, 'utf8'));
  assert.equal(deployedCatalog.find(({ sku }) => sku === wine.sku).imageReviewActionId, queuedBody.id);
  trace.evidence = {
    loginStatus: login.status,
    immediateDispatch: queuedBody.dispatched,
    scheduledClaimCount: claimed.claimed,
    prepared: { actionId: queuedBody.id, status: preparedDecision.status },
    invalidImage: { actionId: badQueuedBody.id, status: rejectedDecision.status, finalStatus: 'needs_attention', reason: rejectedDecision.reason },
    completion: { actionId: queuedBody.id, status: 'completed', pendingRemoved: true, receiptPresent: true, deployedHashVerified: true },
  };
  });
});

test('local acceptance gate covers concurrent reviewers, fifty-action continuation, and rejected-image recovery', async () => {
  const client = createClient({ url: 'file::memory:' });
  await tracedScenario(client, 'fifty-action continuation, isolation, release, and rediscovery', async (trace) => {
  const state = createReviewState({ client, now: () => new Date('2026-08-17T12:00:00Z') });
  await state.initialize();
  const root = await mkdtemp(join(tmpdir(), 'finevines-review-concurrent-')); roots.push(root);
  const storage = fileStorage(join(root, 'objects'));
  const mail = [];
  let passwordSequence = 0;
  const accounts = createReviewerAccounts({ state, mailer: { send: async (message) => mail.push(message) }, reviewUrl: 'https://review.finevines.biz', now: () => new Date('2026-08-17T12:00:00Z'), temporaryPassword: () => `Temporary-review-pass-${++passwordSequence}-92!` });
  await accounts.sync([
    { name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' },
    { name: 'Connie Molitor', email: 'connie@finevines.com', role: 'Executive' },
  ]);
  for (const [email, temporary, permanent] of [
    ['barb.fultz@finevines.com', 'Temporary-review-pass-1-92!', 'Private-review-password-93!'],
    ['connie@finevines.com', 'Temporary-review-pass-2-92!', 'Private-review-password-94!'],
  ]) {
    await accounts.activate(email);
    const invited = await accounts.authenticate(email, temporary);
    await accounts.changePassword(invited, temporary, permanent);
  }
  const wines = Array.from({ length: 51 }, (_, offset) => {
    const index = offset + 1;
    return { sku: `SKU-${index}`, slug: `wine-${index}`, displayIdentity: `Wine ${index}`, searchQuery: `Wine ${index}`, wineRevision: index.toString(16).padStart(64, '0'), candidates: [{ candidateId: `candidate-${index}`, storageName: `candidate-${index}.png`, sha256: 'a'.repeat(64), bytes: 68, mime: 'image/png', width: 1, height: 1, sourceUrl: 'https://example.test/wine', sourceImageUrl: 'https://example.test/wine.png' }] };
  });
  const manifest = { schemaVersion: 1, packageId: 'pkg-matrix', environment: 'test', catalogCommit: 'abcdef1', createdAt: '2026-08-17T11:00:00Z', expiresAt: '2026-09-17T11:00:00Z', reviewers: [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }, { name: 'Connie Molitor', email: 'connie@finevines.com', role: 'Executive' }], wines };
  await storage.put('_review/test/current.json', JSON.stringify({ packageId: manifest.packageId }));
  await storage.put('_review/test/packages/pkg-matrix/manifest.json', JSON.stringify(manifest));
  let uuidSequence = 0;
  const handle = createReviewConsole({ config: { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', sessionSecret: 'matrix-session-secret', incidentRecipient: 'joel@gritautomation.com' }, storage, state, accounts, dispatch: async () => {}, now: () => new Date('2026-08-17T12:00:00Z'), uuid: () => `10000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}` });
  const sessions = [];
  for (const [email, password] of [['barb.fultz@finevines.com', 'Private-review-password-93!'], ['connie@finevines.com', 'Private-review-password-94!']]) {
    const login = await request(handle, '/login', { method: 'POST', body: new URLSearchParams({ email, password }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const current = await request(handle, '/api/current', { headers: { cookie } });
    sessions.push({ cookie, csrf: (await current.json()).csrfToken });
  }
  const queued = [];
  await Promise.all(wines.map(async (wine, index) => {
    const session = sessions[index % 2];
    const response = await request(handle, '/api/actions', { method: 'POST', headers: { cookie: session.cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': session.csrf }, body: JSON.stringify({ kind: 'image-select', sku: wine.sku, packageId: manifest.packageId, targetCatalogCommit: manifest.catalogCommit, wineRevision: wine.wineRevision, candidateId: wine.candidates[0].candidateId }) });
    assert.equal(response.status, 202);
    queued[index] = { ...(await response.json()), reviewer: index % 2 ? 'connie@finevines.com' : 'barb.fultz@finevines.com' };
  }));
  const claimFile = join(await mkdtemp(join(tmpdir(), 'finevines-review-matrix-')), 'claims.json'); roots.push(dirname(claimFile));
  const first = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', claimFile], state, now: () => new Date('2026-08-17T12:01:00Z') });
  assert.deepEqual({ claimed: first.claimed, remaining: first.remaining }, { claimed: 50, remaining: 1 });
  assert.equal(new Set(queued.slice(0, 50).map(({ reviewer }) => reviewer)).size, 2, 'both reviewers retain independent decisions');
  const secondFile = join(dirname(claimFile), 'claims-continued.json');
  const second = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', secondFile], state, now: () => new Date('2026-08-17T12:02:00Z') });
  assert.deepEqual({ claimed: second.claimed, remaining: second.remaining }, { claimed: 1, remaining: 0 });

  // An action-specific rejection is isolated while a prepared neighbor stays
  // processing for verified deployment; an operational transition error does
  // not delete either action.
  const decisions = join(dirname(claimFile), 'decisions.json');
  await writeFile(decisions, JSON.stringify([
    { id: queued[0].id, status: 'rejected', reason: 'candidate revision conflict' },
    { id: queued[1].id, status: 'prepared' },
    { id: queued[2].id, status: 'deferred', reason: 'processor yielded before the time limit' },
  ]));
  const reconciled = await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisions], state });
  assert.equal(reconciled.needsAttention, 1);
  assert.equal(reconciled.deferred, 1);
  assert.equal((await state.actionStatus(queued[0].id, 'test')).status, 'needs_attention');
  assert.equal((await state.actionStatus(queued[1].id, 'test')).status, 'processing');
  assert.equal((await state.actionStatus(queued[2].id, 'test')).status, 'queued');
  await assert.rejects(state.transition(queued[1].id, 'queued', 'completed'), /invalid review action transition|is not queued/);
  assert.equal((await state.actionStatus(queued[1].id, 'test')).status, 'processing');
  const dispatches = [];
  const fetchImpl = async (url, init) => { dispatches.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };
  await dispatchReviewWorkflow({ repository: 'danowitz/finevines-website', token: 'test-token', eventType: 'review-console-continue', environment: 'test', reason: 'time-budget-yield', fetchImpl });
  assert.equal(dispatches[0].body.client_payload.reason, 'time-budget-yield');
  const released = await runQueueCommand({ args: ['release', '--environment', 'test', '--action-ids', claimFile, '--reason', 'simulated operational failure'], state });
  assert.ok(released.released > 0);
  await dispatchReviewWorkflow({ repository: 'danowitz/finevines-website', token: 'test-token', eventType: 'review-console-continue', environment: 'test', reason: 'operational-retry', fetchImpl });
  assert.equal(dispatches[1].body.client_payload.reason, 'operational-retry');

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
  const recoveryFile = join(dirname(claimFile), 'recovery.json');
  const recoveryDraft = join(dirname(claimFile), 'recovery-draft.json');
  await runQueueCommand({ args: ['export-recovery', '--environment', 'test', '--action-id', rejected.id, '--output', recoveryFile], state });
  assert.equal(JSON.parse(await readFile(recoveryFile, 'utf8')).rejectedCandidates[0].candidateId, 'old');
  await writeFile(recoveryDraft, JSON.stringify({ wines: [{ slug: rejected.wineSlug, candidates: [{ candidateId: 'new' }] }] }));
  const resolved = await runQueueCommand({ args: ['resolve-recovery', '--environment', 'test', '--action-id', rejected.id, '--draft', recoveryDraft], state });
  assert.equal(resolved.outcome, 'ready');
  const reopened = await state.packageStatus('test', [{ sku: rejected.sku, slug: rejected.wineSlug, wineRevision: rejected.wineRevision }]);
  assert.equal(reopened.counts.needsDecision, 1);
  assert.equal(reopened.decisions[0].slug, rejected.wineSlug);
  trace.evidence = {
    firstClaim: { claimed: first.claimed, remaining: first.remaining },
    continuationClaim: { claimed: second.claimed, remaining: second.remaining },
    deferred: { actionId: queued[2].id, reason: 'processor yielded before the time limit', dispatchedReason: dispatches[0].body.client_payload.reason },
    operationalRelease: { released: released.released, dispatchedReason: dispatches[1].body.client_payload.reason },
    rejected: { actionId: queued[0].id, status: 'needs_attention', reason: 'candidate revision conflict' },
    rediscovery: { actionId: rejected.id, rejectedCandidateId: 'old', outcome: resolved.outcome, resultingStatus: 'needs_decision' },
  };
  });
});

test('real processor yields on deadline and preserves claims after an operational normalizer failure', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'finevines-review-boundaries-')); roots.push(root);
  const executable = join(root, process.platform === 'win32' ? 'finevines.exe' : 'finevines');
  await exec('go', ['build', '-o', executable, './cmd/finevines']);

  for (const mode of ['deadline', 'operational-failure']) {
    const scenarioRoot = join(root, mode); const objectRoot = join(scenarioRoot, 'objects');
    const storage = fileStorage(objectRoot);
    const client = createClient({ url: 'file::memory:' });
    const scenario = mode === 'deadline' ? 'real Go processor deadline yield' : 'real Go processor operational failure and preservation';
    await tracedScenario(client, scenario, async (trace) => {
    const state = createReviewState({ client, now: () => new Date('2026-08-17T12:00:00Z') });
    await state.initialize();
    const accounts = createReviewerAccounts({ state, mailer: { send: async () => {} }, reviewUrl: 'https://review.finevines.biz', now: () => new Date('2026-08-17T12:00:00Z'), temporaryPassword: () => 'Temporary-boundary-pass-92!' });
    await accounts.sync([{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }]);
    await accounts.activate('barb.fultz@finevines.com');
    const invited = await accounts.authenticate('barb.fultz@finevines.com', 'Temporary-boundary-pass-92!');
    await accounts.changePassword(invited, 'Temporary-boundary-pass-92!', 'Private-boundary-password-93!');
    const wine = { id: `wine-${mode}`, sku: `SKU-${mode}`, slug: `producer-${mode}-2022`, producer: 'Producer', name: mode, vintage: '2022', imagePath: `assets/img/wines/producer-${mode}-2022.svg`, imageSource: 'generated-label', sourceHash: `source-${mode}`, status: 'Active' };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const sha = createHash('sha256').update(png).digest('hex');
    const manifest = {
      schemaVersion: 1, packageId: `pkg-${mode}`, environment: 'test', catalogCommit: 'abcdef1', createdAt: '2026-08-17T11:00:00Z', expiresAt: '2026-09-17T11:00:00Z',
      reviewers: [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }],
      wines: [{ sku: wine.sku, slug: wine.slug, displayIdentity: `Producer ${mode} 2022`, searchQuery: `Producer ${mode} 2022`, wineRevision: wineRevision(wine), candidates: [{ candidateId: `candidate-${mode}`, storageName: `candidate-${mode}.png`, sha256: sha, bytes: png.length, mime: 'image/png', width: 1, height: 1, sourceUrl: 'https://producer.example/wine', sourceImageUrl: 'https://producer.example/wine.png' }] }],
    };
    await storage.put('_review/test/current.json', JSON.stringify({ packageId: manifest.packageId }));
    await storage.put(`_review/test/packages/${manifest.packageId}/manifest.json`, JSON.stringify(manifest));
    await storage.put(`_review/test/packages/${manifest.packageId}/images/candidate-${mode}.png`, png);
    let uuidSequence = 0;
    const handle = createReviewConsole({
      config: { environment: 'test', origin: 'https://review.finevines.biz', cookieName: 'fv_review_test', sessionSecret: `boundary-session-${mode}`, incidentRecipient: 'joel@gritautomation.com' },
      storage, state, accounts, dispatch: async () => {}, now: () => new Date('2026-08-17T12:00:00Z'),
      uuid: () => `40000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
    });
    const login = await request(handle, '/login', { method: 'POST', body: new URLSearchParams({ email: 'barb.fultz@finevines.com', password: 'Private-boundary-password-93!' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const current = await request(handle, '/api/current', { headers: { cookie } }); const currentBody = await current.json();
    const queuedResponse = await request(handle, '/api/actions', { method: 'POST', headers: { cookie, origin: 'https://review.finevines.biz', 'content-type': 'application/json', 'x-csrf-token': currentBody.csrfToken }, body: JSON.stringify({ kind: 'image-select', sku: wine.sku, packageId: manifest.packageId, targetCatalogCommit: manifest.catalogCommit, wineRevision: manifest.wines[0].wineRevision, candidateId: `candidate-${mode}` }) });
    const queued = await queuedResponse.json(); assert.equal(queuedResponse.status, 202);
    const claims = join(scenarioRoot, 'claims.json');
    const claimed = await runQueueCommand({ args: ['claim', '--environment', 'test', '--output', claims], state, now: () => new Date('2026-08-17T12:01:00Z') });
    assert.equal(claimed.claimed, 1);

    const workspace = join(scenarioRoot, 'workspace');
    await mkdir(join(workspace, 'data'), { recursive: true }); await mkdir(join(workspace, 'assets', 'img', 'wines'), { recursive: true });
    const catalog = join(workspace, 'data', 'wines.json'); await writeFile(catalog, JSON.stringify([wine]));
    const normalizerSource = mode === 'deadline'
      ? 'package main\nimport "time"\nfunc main(){ time.Sleep(5*time.Second) }\n'
      : 'package main\nimport "os"\nfunc main(){ os.Exit(1) }\n';
    const normalizerSourcePath = join(workspace, 'normalizer.go'); await writeFile(normalizerSourcePath, normalizerSource);
    await exec('go', ['build', '-o', join(workspace, process.platform === 'win32' ? 'imgnorm.exe' : 'imgnorm'), normalizerSourcePath], { cwd: workspace });
    const decisions = join(scenarioRoot, 'decisions.json'); const applied = join(scenarioRoot, 'applied.json');
    const args = ['reviewapply', '-environment', 'test', '-review-dir', objectRoot, '-catalog', catalog, '-image-dir', join(workspace, 'assets', 'img', 'wines'), '-action-ids', claims, '-decisions', decisions, '-applied', applied];
    const dispatches = [];
    const fetchImpl = async (url, init) => { dispatches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
    if (mode === 'deadline') {
      args.push('-max-prepare-duration', '50ms');
      await exec(executable, args, { cwd: workspace });
      const records = JSON.parse(await readFile(decisions, 'utf8'));
      assert.equal(records[0].status, 'deferred');
      const reconciled = await runQueueCommand({ args: ['reconcile', '--environment', 'test', '--decisions', decisions], state });
      assert.equal(reconciled.deferred, 1);
      await dispatchReviewWorkflow({ repository: 'danowitz/finevines-website', token: 'test-token', eventType: 'review-console-continue', environment: 'test', reason: 'time-budget-yield', fetchImpl });
      assert.equal((await state.actionStatus(queued.id, 'test')).status, 'queued');
      trace.evidence = { actionId: queued.id, processorDecision: records[0], dispatched: dispatches[0] };
    } else {
      await assert.rejects(exec(executable, args, { cwd: workspace }), /reviewapply/);
      assert.equal((await state.actionStatus(queued.id, 'test')).status, 'processing');
      const released = await runQueueCommand({ args: ['release', '--environment', 'test', '--action-ids', claims, '--reason', 'normalizer execution failed'], state });
      assert.equal(released.released, 1);
      await dispatchReviewWorkflow({ repository: 'danowitz/finevines-website', token: 'test-token', eventType: 'review-console-continue', environment: 'test', reason: 'operational-retry', fetchImpl });
      assert.equal((await state.actionStatus(queued.id, 'test')).status, 'queued');
      assert.ok(await storage.get(`_review/test/pending/${queued.id}.json`));
      assert.equal(JSON.parse(await readFile(catalog, 'utf8'))[0].imageReviewActionId || '', '');
      trace.evidence = { actionId: queued.id, processorError: 'normalizer execution failed', released: released.released, pendingPreserved: true, catalogUnchanged: true, dispatched: dispatches[0] };
    }
    });
  }
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
        return { ok: true, json: async () => ({
          packageId: 'pkg-refresh', catalogCommit: 'abcdef1', csrfToken: 'csrf',
          wines: [{
            sku: 'refresh-1', wineRevision: 'a'.repeat(64), displayIdentity: 'Refresh Test Wine 2022', searchQuery: 'Refresh Test Wine 2022',
            candidates: [{ candidateId: 'candidate-1', width: 400, height: 800, sourceHost: 'producer.example' }],
          }],
          incidents: [], isAdministrator: false, expiresAt: '2026-09-17T00:00:00Z', reviewStatus: {},
        }) };
      };
    });
    await page.evaluate((source) => (0, eval)(source), APP_JS);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const initial = await page.evaluate(() => window.__reviewFetches);
    assert.equal(initial, 1);
    await page.click('.candidate');
    assert.equal(await page.$eval('.candidate', (node) => node.classList.contains('selected')), true);
    assert.equal(await page.$eval('.primary', (node) => node.disabled), false);
    await page.evaluate(() => { window.__reviewFocused = false; window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(await page.evaluate(() => window.__reviewFetches), initial);
    await page.evaluate(() => { window.__reviewFocused = true; window.dispatchEvent(new Event('focus')); });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(await page.evaluate(() => window.__reviewFetches), initial + 1);
    assert.equal(await page.$eval('.candidate', (node) => node.classList.contains('selected')), true, 'background refresh must preserve the selected candidate');
    assert.equal(await page.$eval('.primary', (node) => node.disabled), false, 'background refresh must preserve the enabled submit button');
  } finally {
    await page.close(); await browser.close();
  }
});

test('real browser covers onboarding, modal choice, conflict, counters, and incident recovery', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'finevines-review-browser-')); roots.push(root);
  const storage = fileStorage(join(root, 'objects'));
  const client = createClient({ url: 'file::memory:' });
  await tracedScenario(client, 'real browser onboarding, concurrency, counters, modal, and incident recovery', async (trace) => {
  const clock = () => new Date('2026-08-17T12:00:00Z');
  const state = createReviewState({ client, now: clock });
  await state.initialize();
  let passwordSequence = 0;
  const sentMail = [];
  const accounts = createReviewerAccounts({
    state,
    mailer: { send: async (message) => { sentMail.push(message); } },
    reviewUrl: 'https://review.finevines.biz',
    now: clock,
    temporaryPassword: () => `Temporary-review-pass-${++passwordSequence}-92!`,
    resetToken: () => 'browser-reset-token-95',
  });
  const roster = [
    { name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' },
    { name: 'Joel Danowitz', email: 'joel@danowitz.com', role: 'Support' },
  ];
  await accounts.sync(roster);
  await accounts.activate(roster[0].email);
  await accounts.activate(roster[1].email);
  const supportInvite = await accounts.authenticate(roster[1].email, 'Temporary-review-pass-2-92!');
  await accounts.changePassword(supportInvite, 'Temporary-review-pass-2-92!', 'Private-support-password-94!');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const sha = createHash('sha256').update(png).digest('hex');
  const wines = ['A', 'B', 'C'].map((suffix) => ({
    sku: `SKU-${suffix}`,
    slug: `wine-${suffix.toLowerCase()}-2022`,
    displayIdentity: `Producer Wine ${suffix} 2022`,
    searchQuery: `Producer Wine ${suffix} 2022`,
    wineRevision: suffix.toLowerCase().repeat(64),
    candidates: [1, 2].map((number) => ({
      candidateId: `candidate-${suffix.toLowerCase()}-${number}`,
      storageName: `candidate-${suffix.toLowerCase()}-${number}.png`,
      sha256: sha,
      bytes: png.length,
      mime: 'image/png',
      width: number,
      height: number,
      sourceHost: 'producer.example',
      sourceUrl: `https://producer.example/${suffix}/${number}`,
      sourceImageUrl: `https://producer.example/${suffix}/${number}.png`,
    })),
  }));
  const manifest = {
    schemaVersion: 1,
    packageId: 'pkg-browser',
    environment: 'test',
    catalogCommit: 'abcdef1',
    createdAt: '2026-08-17T11:00:00Z',
    expiresAt: '2026-09-17T11:00:00Z',
    reviewers: roster,
    wines,
  };
  await storage.put('_review/test/current.json', JSON.stringify({ packageId: manifest.packageId }));
  await storage.put('_review/test/packages/pkg-browser/manifest.json', JSON.stringify(manifest));
  for (const wine of wines) for (const candidate of wine.candidates) {
    await storage.put(`_review/test/packages/pkg-browser/images/${candidate.storageName}`, png);
  }

  let uuidSequence = 0;
  const hosted = await serveConsole((origin) => createReviewConsole({
    config: { environment: 'test', origin, cookieName: 'fv_review_test', sessionSecret: 'browser-session-secret', incidentRecipient: 'joel@gritautomation.com' },
    storage,
    state,
    accounts,
    dispatch: async () => {},
    now: clock,
    uuid: () => `30000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
  }));
  const reviewerBrowser = await openBrowser();
  const supportBrowser = await openBrowser();
  const reviewerPage = await reviewerBrowser.newPage();
  const supportPage = await supportBrowser.newPage();
  try {
    await reviewerPage.goto(hosted.origin, { waitUntil: 'domcontentloaded' });
    await reviewerPage.type('#email', roster[0].email);
    await reviewerPage.type('#password', 'Temporary-review-pass-1-92!');
    await Promise.all([reviewerPage.waitForNavigation(), reviewerPage.click('button[type=submit]')]);
    assert.match(reviewerPage.url(), /\/change-password$/);
    await reviewerPage.type('#current-password', 'Temporary-review-pass-1-92!');
    await reviewerPage.type('#new-password', 'Private-review-password-93!');
    await reviewerPage.type('#confirm-password', 'Private-review-password-93!');
    await Promise.all([reviewerPage.waitForNavigation(), reviewerPage.click('button[type=submit]')]);
    assert.equal(new URL(reviewerPage.url()).pathname, '/', `${await reviewerPage.$eval('body', (node) => node.innerText)}\n${JSON.stringify(hosted.requests.slice(-3))}`);
    await reviewerPage.waitForFunction(() => document.querySelector('.wine') || !document.querySelector('#summary')?.textContent.includes('Loading'), { timeout: 10_000 });
    assert.ok(await reviewerPage.$('.wine[data-sku="SKU-A"]'), await reviewerPage.$eval('body', (node) => node.innerText));

    await reviewerPage.goto(`${hosted.origin}/forgot-password`, { waitUntil: 'domcontentloaded' });
    await reviewerPage.type('#email', roster[0].email);
    await Promise.all([reviewerPage.waitForNavigation(), reviewerPage.click('button[type=submit]')]);
    assert.match(await reviewerPage.$eval('body', (node) => node.innerText), /If an eligible account exists/);
    const resetMail = sentMail.find(({ subject }) => subject === 'Reset your Fine Vines review password');
    assert.match(resetMail?.text || '', /browser-reset-token-95/);
    await reviewerPage.goto(`${hosted.origin}/reset-password?token=browser-reset-token-95`, { waitUntil: 'domcontentloaded' });
    await reviewerPage.type('#new-password', 'Reset-private-password-95!');
    await reviewerPage.type('#confirm-password', 'Reset-private-password-95!');
    await Promise.all([reviewerPage.waitForNavigation(), reviewerPage.click('button[type=submit]')]);
    assert.match(await reviewerPage.$eval('body', (node) => node.innerText), /Password updated/);
    await reviewerPage.type('#email', roster[0].email);
    await reviewerPage.type('#password', 'Reset-private-password-95!');
    await Promise.all([reviewerPage.waitForNavigation(), reviewerPage.click('button[type=submit]')]);
    await reviewerPage.waitForSelector('.wine[data-sku="SKU-A"]');

    await supportPage.goto(hosted.origin, { waitUntil: 'domcontentloaded' });
    await supportPage.type('#email', roster[1].email);
    await supportPage.type('#password', 'Private-support-password-94!');
    await Promise.all([supportPage.waitForNavigation(), supportPage.click('button[type=submit]')]);
    await supportPage.waitForSelector('.wine[data-sku="SKU-A"]');

    await reviewerPage.click('.wine[data-sku="SKU-A"] .candidate img');
    await reviewerPage.waitForSelector('#modal:not([hidden])');
    assert.equal(await reviewerPage.$$eval('#modal-stage .compare-card', (nodes) => nodes.length), 2);
    await reviewerPage.evaluate(() => document.querySelector('#modal').click());
    await reviewerPage.waitForSelector('#modal[hidden]');
    await reviewerPage.click('.wine[data-sku="SKU-A"] .candidate img');
    await reviewerPage.click('#modal-stage .compare-select');
    await reviewerPage.click('.wine[data-sku="SKU-A"] .primary');
    await reviewerPage.waitForFunction(() => !document.querySelector('.wine[data-sku="SKU-A"]'));

    await supportPage.click('.wine[data-sku="SKU-A"] .candidate-info');
    await supportPage.click('.wine[data-sku="SKU-A"] .primary');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.ok(await supportPage.$('.wine[data-sku="SKU-A"] .status.bad'), await supportPage.$eval('body', (node) => node.innerText));
    assert.match(await supportPage.$eval('.wine[data-sku="SKU-A"] .status', (node) => node.textContent), /active|queued|decision/i);

    await supportPage.click('.wine[data-sku="SKU-B"] .candidate-info');
    await supportPage.click('.wine[data-sku="SKU-B"] .primary');
    await supportPage.waitForFunction(() => !document.querySelector('.wine[data-sku="SKU-B"]'));
    await reviewerPage.bringToFront();
    await reviewerPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    await reviewerPage.waitForFunction(() => document.querySelector('#summary')?.textContent.includes('2 queued'));

    const locked = await client.execute({ sql: "SELECT id FROM review_actions WHERE environment = 'test' AND sku = 'SKU-A'", args: [] });
    const actionId = String(locked.rows[0].id);
    await state.transition(actionId, 'queued', 'needs_attention', 'candidate requires operator review');
    await supportPage.bringToFront();
    await supportPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    await supportPage.waitForSelector('.incident');
    assert.match(await supportPage.$eval('.incident', (node) => node.textContent), /SKU-A/);
    supportPage.once('dialog', (dialog) => dialog.accept('review the original choices again'));
    await supportPage.evaluate(() => [...document.querySelectorAll('.incident button')].find((button) => button.textContent === 'Reopen choices').click());
    await supportPage.waitForFunction(() => !document.querySelector('.incident'));
    assert.equal((await state.actionStatus(actionId, 'test')).status, 'needs_decision');
    trace.evidence = {
      onboarding: { reviewer: roster[0].email, forcedPasswordChange: true, passwordReset: true, resultingPath: '/' },
      modal: { opened: true, comparedCandidates: 2, backdropClosed: true, selectionApplied: true },
      sameWineConflict: { sku: 'SKU-A', visibleToReviewer: roster[1].email },
      independentWine: { sku: 'SKU-B', queued: true },
      durableCounter: '2 queued',
      incident: { actionId, visible: true, operation: 'reopen', resultingStatus: 'needs_decision' },
    };
  } finally {
    await reviewerPage.close();
    await supportPage.close();
    await reviewerBrowser.close();
    await supportBrowser.close();
    await hosted.close();
  }
  });
});
