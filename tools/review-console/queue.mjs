import { createClient } from '@libsql/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createReviewState } from '../../edge/review-console/review-state.mjs';
import { createOutboxMailer } from '../../edge/review-console/outbox-mailer.mjs';
import { createReviewerAccounts } from '../../edge/review-console/reviewer-accounts.mjs';
import { buildReviewerRoster } from '../labelfetch/review-package.mjs';

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

export async function runQueueCommand({ args, state, now = () => new Date(), mailer, accounts }) {
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

  if (value.command === 'notify') {
    if (!value.recipient || !value.from) throw new Error('notify requires --recipient and --from');
    const incidents = await state.scanIncidents(environment, value.recipient);
    if (mailer?.disabled) return { command: 'notify', incidents: incidents.length, sent: 0, delivery: 'disabled' };
    if (!mailer?.send) throw new Error('notify requires a mail transport');
    const messages = await state.claimNotifications({ limit: 25 });
    let sent = 0;
    for (const message of messages) {
      await mailer.send({ from: value.from, ...message });
      await state.completeNotification(message.id);
      sent += 1;
    }
    return { command: 'notify', incidents: incidents.length, sent, delivery: 'smtp' };
  }

  if (value.command === 'sync-accounts') {
    if (!value.roster) throw new Error('sync-accounts requires --roster');
    if (!accounts?.sync || !accounts?.list) throw new Error('sync-accounts requires reviewer accounts');
    const roster = buildReviewerRoster(JSON.parse(await readFile(value.roster, 'utf8')));
    await accounts.sync(roster);
    return { command: 'sync-accounts', eligible: (await accounts.list()).length };
  }

  if (value.command === 'invite') {
    if (!value.email) throw new Error('invite requires --email');
    if (!accounts?.activate) throw new Error('invite requires reviewer accounts');
    await accounts.activate(value.email);
    return { command: 'invite', email: value.email.trim().toLowerCase(), status: 'queued' };
  }

  throw new Error('usage: queue.mjs <claim|reconcile|complete|notify|sync-accounts|invite> --environment <name> [command options]');
}

async function main() {
  const url = process.env.FINEVINES_REVIEW_DATABASE_URL?.trim();
  const authToken = process.env.FINEVINES_REVIEW_DATABASE_TOKEN?.trim();
  if (!url || !authToken) throw new Error('FINEVINES_REVIEW_DATABASE_URL and FINEVINES_REVIEW_DATABASE_TOKEN are required');
  const client = createClient({ url, authToken });
  try {
    const command = process.argv[2];
    const state = createReviewState({ client });
    let mailer;
    if (command === 'notify') {
      const mode = process.env.FINEVINES_REVIEW_EMAIL_MODE || 'disabled';
      if (mode === 'disabled') mailer = { disabled: true };
      else if (mode === 'smtp') {
        const { default: nodemailer } = await import('nodemailer');
        const port = Number(process.env.FINEVINES_SMTP_PORT);
        if (!process.env.FINEVINES_SMTP_HOST || !Number.isInteger(port) || !process.env.FINEVINES_SMTP_USER || !process.env.FINEVINES_SMTP_PASS) {
          throw new Error('SMTP review delivery requires host, port, user, and password');
        }
        const transport = nodemailer.createTransport({
          host: process.env.FINEVINES_SMTP_HOST, port, secure: port === 465,
          auth: { user: process.env.FINEVINES_SMTP_USER, pass: process.env.FINEVINES_SMTP_PASS },
        });
        mailer = { send: (message) => transport.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text }) };
      } else throw new Error('FINEVINES_REVIEW_EMAIL_MODE must be disabled or smtp');
    }
    const accounts = ['sync-accounts', 'invite'].includes(command)
      ? createReviewerAccounts({ state, mailer: createOutboxMailer(state) })
      : undefined;
    const result = await runQueueCommand({ args: process.argv.slice(2), state, mailer, accounts });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    client.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
