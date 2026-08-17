import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { sendRepositoryDispatch } from '../../edge/review-console/github-repository-dispatch.mjs';

const EVENTS = new Set(['review-console-continue', 'review-console-preflight']);

export async function dispatchReviewWorkflow({ repository, token, eventType, environment = 'test', reason = '', fetchImpl = fetch }) {
  if (!EVENTS.has(eventType)) throw new Error('unsupported review dispatch event');
  if (!['test', 'production'].includes(environment)) throw new Error('review dispatch environment must be test or production');
  await sendRepositoryDispatch({
    repository, token, eventType, fetchImpl, signal: AbortSignal.timeout(30_000),
    payload: { environment, ...(reason ? { reason } : {}) },
  });
  return { eventType, environment, reason };
}

function option(args, name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`--${name} requires a value`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const result = await dispatchReviewWorkflow({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    eventType: option(args, 'event-type', 'review-console-continue'),
    environment: option(args, 'environment', 'test'),
    reason: option(args, 'reason'),
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
