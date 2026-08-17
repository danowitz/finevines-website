import { createClient } from '@libsql/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createReviewState } from '../../edge/review-console/review-state.mjs';

function options(args) {
  const values = { command: args[0] || '' };
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith('--') || args[index + 1] === undefined) throw new Error(`invalid queue option ${name || ''}`);
    values[name.slice(2)] = args[index + 1];
  }
  return values;
}

async function decisions(name) {
  const value = JSON.parse(await readFile(name, 'utf8'));
  if (!Array.isArray(value)) throw new Error('review decisions must be an array');
  return value;
}

async function transitionIfNeeded(state, environment, id, from, to, detail) {
  const current = await state.actionStatus(id, environment);
  if (!current) throw new Error(`review action ${id} is missing from transactional state`);
  if (current.status === to) return;
  if (current.status !== from) throw new Error(`review action ${id} is ${current.status}, expected ${from}`);
  await state.transition(id, from, to, detail);
}

export async function runQueueCommand({ args, state, now = () => new Date() }) {
  const value = options(args);
  const environment = value.environment || 'test';
  if (!['test', 'production'].includes(environment)) throw new Error('queue environment must be test or production');
  await state.initialize();

  if (value.command === 'claim') {
    if (!value.output) throw new Error('claim requires --output');
    const staleBefore = new Date(now().getTime() - 45 * 60_000).toISOString();
    const result = await state.claim(environment, { limit: 50, staleBefore });
    await mkdir(dirname(value.output), { recursive: true });
    await writeFile(value.output, `${JSON.stringify(result.actionIds, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { command: 'claim', claimed: result.actionIds.length, remaining: result.remaining, output: value.output };
  }

  if (value.command === 'reconcile') {
    if (!value.decisions) throw new Error('reconcile requires --decisions');
    const records = await decisions(value.decisions);
    let needsAttention = 0;
    for (const decision of records) {
      if (decision.status === 'prepared') continue;
      if (!['rejected', 'conflict'].includes(decision.status)) throw new Error(`unsupported review decision ${decision.status}`);
      await transitionIfNeeded(state, environment, decision.id, 'processing', 'needs_attention', decision.reason || decision.status);
      needsAttention += 1;
    }
    return { command: 'reconcile', decisions: records.length, needsAttention };
  }

  if (value.command === 'complete') {
    if (!value.decisions) throw new Error('complete requires --decisions');
    const records = await decisions(value.decisions);
    let completed = 0;
    for (const decision of records) {
      if (decision.status !== 'prepared') continue;
      await transitionIfNeeded(state, environment, decision.id, 'processing', 'completed', 'deployment and receipt verified');
      completed += 1;
    }
    return { command: 'complete', decisions: records.length, completed };
  }

  throw new Error('usage: queue.mjs <claim|reconcile|complete> --environment <name> [--output path|--decisions path]');
}

async function main() {
  const url = process.env.FINEVINES_REVIEW_DATABASE_URL?.trim();
  const authToken = process.env.FINEVINES_REVIEW_DATABASE_TOKEN?.trim();
  if (!url || !authToken) throw new Error('FINEVINES_REVIEW_DATABASE_URL and FINEVINES_REVIEW_DATABASE_TOKEN are required');
  const client = createClient({ url, authToken });
  try {
    const result = await runQueueCommand({ args: process.argv.slice(2), state: createReviewState({ client }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    client.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
