import process from 'node:process';
import { pathToFileURL } from 'node:url';

const EVENTS = new Set(['review-console-continue', 'review-console-preflight']);

export async function dispatchReviewWorkflow({ repository, token, eventType, environment = 'test', reason = '', fetchImpl = fetch }) {
  const repositoryParts = String(repository || '').split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) || part.includes('..'))) {
    throw new Error('GitHub repository must be owner/name');
  }
  if (!token) throw new Error('GitHub dispatch token is required');
  if (!EVENTS.has(eventType)) throw new Error('unsupported review dispatch event');
  if (!['test', 'production'].includes(environment)) throw new Error('review dispatch environment must be test or production');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'finevines-review-processor',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ event_type: eventType, client_payload: { environment, ...(reason ? { reason } : {}) } }),
  });
  if (!response.ok) throw new Error(`GitHub review dispatch failed with HTTP ${response.status}`);
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
