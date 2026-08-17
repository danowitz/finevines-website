import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import { sendRepositoryDispatch } from '../../edge/review-console/github-repository-dispatch.mjs';
import { requireBunnyDatabaseUrl } from './bunny-database.mjs';

const REQUIRED = [
  'FINEVINES_BUNNY_API_KEY', 'FINEVINES_REVIEW_STORAGE_ENDPOINT', 'FINEVINES_REVIEW_STORAGE_ZONE',
  'FINEVINES_REVIEW_STORAGE_KEY', 'FINEVINES_REVIEW_DATABASE_URL', 'FINEVINES_REVIEW_DATABASE_TOKEN',
  'FINEVINES_REVIEW_GITHUB_DISPATCH_TOKEN', 'FINEVINES_REVIEW_TEST_SESSION_SECRET',
  'FINEVINES_REVIEW_PRODUCTION_SESSION_SECRET', 'FINEVINES_SMTP_HOST', 'FINEVINES_SMTP_PORT',
  'FINEVINES_SMTP_USER', 'FINEVINES_SMTP_PASS', 'FINEVINES_NOTIFY_FROM',
];

function values(environment) {
  const result = {};
  for (const name of REQUIRED) {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    result[name] = value;
  }
  if (result.FINEVINES_REVIEW_TEST_SESSION_SECRET.length < 32 || result.FINEVINES_REVIEW_PRODUCTION_SESSION_SECRET.length < 32) throw new Error('review session secrets must contain at least 32 characters');
  if (!Number.isInteger(Number(result.FINEVINES_SMTP_PORT))) throw new Error('FINEVINES_SMTP_PORT must be an integer');
  result.FINEVINES_REVIEW_DATABASE_URL = requireBunnyDatabaseUrl(result.FINEVINES_REVIEW_DATABASE_URL);
  return result;
}

async function requireOK(fetchImpl, url, init, name) {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`${name} preflight returned ${response.status}`);
  return response;
}

export async function runReviewPreflight({ environment = process.env, fetchImpl = fetch, createClientImpl = createClient } = {}) {
  const config = values(environment);
  await requireOK(fetchImpl, 'https://api.bunny.net/compute/script', { headers: { AccessKey: config.FINEVINES_BUNNY_API_KEY } }, 'Bunny account');
  const storageRoot = `${config.FINEVINES_REVIEW_STORAGE_ENDPOINT.replace(/\/$/, '')}/${encodeURIComponent(config.FINEVINES_REVIEW_STORAGE_ZONE)}/`;
  await requireOK(fetchImpl, storageRoot, { headers: { AccessKey: config.FINEVINES_REVIEW_STORAGE_KEY } }, 'Bunny review storage');
  const workflow = await requireOK(fetchImpl, 'https://api.github.com/repos/danowitz/finevines-website/actions/workflows/review-actions.yml', {
    headers: { Authorization: `Bearer ${config.FINEVINES_REVIEW_GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  }, 'GitHub processing trigger');
  const workflowBody = await workflow.json();
  if (workflowBody.state !== 'active') throw new Error(`GitHub processing trigger is ${workflowBody.state || 'unavailable'}`);
  await sendRepositoryDispatch({
    repository: 'danowitz/finevines-website', token: config.FINEVINES_REVIEW_GITHUB_DISPATCH_TOKEN,
    eventType: 'review-console-preflight', payload: { source: 'review-console-provision' }, fetchImpl,
  });
  const client = createClientImpl({ url: config.FINEVINES_REVIEW_DATABASE_URL, authToken: config.FINEVINES_REVIEW_DATABASE_TOKEN });
  try { await client.execute('SELECT 1 AS ready'); } finally { client.close(); }
  return { storage: 'reachable', database: 'reachable', processingTrigger: 'dispatched', email: 'configured' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runReviewPreflight().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
