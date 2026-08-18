import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { afterEach, describe, it } from 'node:test';
import { createReviewState } from '../../edge/review-console/review-state.mjs';
import { createReviewerAccounts, hashPassword, verifyPassword } from '../../edge/review-console/reviewer-accounts.mjs';

const clients = [];
afterEach(() => { while (clients.length) clients.pop().close(); });

async function fixture(now = '2026-08-16T12:00:00.000Z', temporaryPassword = () => 'Random-Launch-Password-7x!', resetToken = () => 'Random-reset-token-92') {
  let clock = new Date(now);
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  const state = createReviewState({ client, now: () => new Date(clock) });
  await state.initialize();
  const messages = [];
  const resetDelays = [];
  const accounts = createReviewerAccounts({
    state,
    reviewUrl: 'https://review.finevines.biz',
    now: () => new Date(clock),
    temporaryPassword,
    resetToken,
    resetResponseDelay: async (milliseconds) => { resetDelays.push(milliseconds); },
    monotonicNow: () => 0,
    mailer: { send: async (message) => { messages.push(message); } },
  });
  return { accounts, messages, resetDelays, advanceTo: (value) => { clock = new Date(value); } };
}

const roster = [
  { name: 'Connie Molitor', email: 'connie@finevines.com', role: 'Executive' },
  { name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' },
  { name: 'Trish Earley', email: 'trish@finevines.com', role: 'Sales Rep' },
];

describe('reviewer accounts', () => {
  it('discovers eligible reviewers but requires administrator invitation', async () => {
    const { accounts } = await fixture();
    await accounts.sync(roster);
    assert.deepEqual(await accounts.list(), [
      { email: 'barb.fultz@finevines.com', name: 'Barb Fultz', role: 'Back Office', source: 'salesforce', status: 'invitation_pending' },
      { email: 'connie@finevines.com', name: 'Connie Molitor', role: 'Executive', source: 'salesforce', status: 'invitation_pending' },
      { email: 'joel@danowitz.com', name: 'Joel Danowitz', role: 'Support', source: 'support', status: 'invitation_pending' },
    ]);
    assert.equal(await accounts.authenticate('connie@finevines.com', 'anything'), null);
  });

  it('emails one expiring password and forces a change before review access', async () => {
    const { accounts, messages } = await fixture();
    await accounts.sync(roster);
    await accounts.activate('barb.fultz@finevines.com');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'barb.fultz@finevines.com');
    assert.match(messages[0].text, /Random-Launch-Password-7x!/);
    assert.match(messages[0].text, /Review page: https:\/\/review\.finevines\.biz/);
    assert.match(messages[0].text, /Username: barb\.fultz@finevines\.com/);
    assert.match(messages[0].text, /at least 8 characters/);
    assert.doesNotMatch(JSON.stringify(await accounts.list()), /Random-Launch-Password/);

    const temporary = await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-7x!');
    assert.equal(temporary.mustChangePassword, true);
    assert.equal(temporary.credentialVersion, 1);
    assert.equal(await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-7x!'), null, 'temporary password is single-use for sign-in');
    await accounts.changePassword(temporary, 'Random-Launch-Password-7x!', 'A-new-private-password-92!');
    assert.equal(await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-7x!'), null);
    const permanent = await accounts.authenticate('barb.fultz@finevines.com', 'A-new-private-password-92!');
    assert.equal(permanent.mustChangePassword, false);
    assert.equal(permanent.credentialVersion, 2);
  });

  it('accepts eight-character reviewer passwords but rejects shorter ones', async () => {
    await assert.rejects(hashPassword('1234567'), /at least 8 characters/);
    const encoded = await hashPassword('12345678');
    assert.equal(await verifyPassword('12345678', encoded), true);
  });

  it('issues a generic single-use reset link that expires and revokes existing sessions', async () => {
    let sequence = 0;
    const nextResetToken = () => `Random-reset-token-${++sequence}-92`;
    const { accounts, messages, resetDelays, advanceTo } = await fixture('2026-08-16T12:00:00.000Z', undefined, nextResetToken);
    await accounts.sync(roster);
    await accounts.activate('connie@finevines.com');
    const invited = await accounts.authenticate('connie@finevines.com', 'Random-Launch-Password-7x!');
    await accounts.changePassword(invited, 'Random-Launch-Password-7x!', 'Original-private-password-92!');
    const existingSession = await accounts.authenticate('connie@finevines.com', 'Original-private-password-92!');

    const invitationCount = messages.length;
    await accounts.requestPasswordReset('missing@finevines.com');
    assert.equal(messages.length, invitationCount, 'unknown addresses receive the same public response but no email');
    assert.equal(resetDelays.at(-1), 300);
    await accounts.requestPasswordReset(' CONNIE@FINEVINES.COM ');
    assert.equal(messages.length, invitationCount + 1);
    assert.equal(messages.at(-1).to, 'connie@finevines.com');
    assert.equal(messages.at(-1).sensitive, true);
    assert.equal(resetDelays.at(-1), 300, 'known and unknown accounts share the same minimum response duration');
    const firstToken = messages.at(-1).text.match(/reset-password\?token=([^\s]+)/)[1];
    await accounts.requestPasswordReset('connie@finevines.com');
    assert.equal(messages.length, invitationCount + 1, 'a five-minute cooldown prevents reset-email spam');

    await assert.rejects(accounts.resetPassword('wrong-token', 'Replacement-private-password-93!'), /invalid or expired/);
    await accounts.resetPassword(firstToken, 'Replacement-private-password-93!');
    assert.equal(await accounts.authenticate('connie@finevines.com', 'Original-private-password-92!'), null);
    assert.equal(await accounts.sessionIdentity(existingSession.email, existingSession.credentialVersion), null, 'reset revokes existing sessions');
    assert.ok(await accounts.authenticate('connie@finevines.com', 'Replacement-private-password-93!'));
    await assert.rejects(accounts.resetPassword(firstToken, 'Another-private-password-94!'), /invalid or expired/);

    advanceTo('2026-08-16T12:06:00.000Z');
    await accounts.requestPasswordReset('connie@finevines.com');
    const rotatedToken = messages.at(-1).text.match(/reset-password\?token=([^\s]+)/)[1];
    const current = await accounts.authenticate('connie@finevines.com', 'Replacement-private-password-93!');
    await accounts.changePassword(current, 'Replacement-private-password-93!', 'Rotated-private-password-94!');
    await assert.rejects(accounts.resetPassword(rotatedToken, 'Stolen-link-password-95!'), /invalid or expired/, 'ordinary credential rotation revokes outstanding reset links');

    advanceTo('2026-08-16T12:12:00.000Z');
    await accounts.requestPasswordReset('connie@finevines.com');
    const expiringToken = messages.at(-1).text.match(/reset-password\?token=([^\s]+)/)[1];
    assert.notEqual(expiringToken, firstToken);
    advanceTo('2026-08-16T13:13:00.000Z');
    await assert.rejects(accounts.resetPassword(expiringToken, 'Expired-private-password-95!'), /invalid or expired/);
  });

  it('expires temporary credentials, rotates resends, and revokes removed reviewers', async () => {
    let sequence = 0;
    const nextPassword = () => `Random-Launch-Password-${++sequence}-7x!`;
    const { accounts, messages, advanceTo } = await fixture('2026-08-16T12:00:00.000Z', nextPassword);
    await accounts.sync(roster);
    await accounts.activate('connie@finevines.com');
    assert.equal(messages.length, 1);
    advanceTo('2026-08-20T12:00:00.000Z');
    assert.equal(await accounts.authenticate('connie@finevines.com', 'Random-Launch-Password-1-7x!'), null);

    advanceTo('2026-08-16T12:30:00.000Z');
    await accounts.activate('connie@finevines.com');
    assert.equal(messages.length, 2);
    assert.equal(await accounts.authenticate('connie@finevines.com', 'Random-Launch-Password-1-7x!'), null);
    assert.ok(await accounts.authenticate('connie@finevines.com', 'Random-Launch-Password-2-7x!'));

    // A roster removal invalidates existing sessions by incrementing the credential version.
    advanceTo('2026-08-16T13:00:00.000Z');
    await accounts.activate('barb.fultz@finevines.com');
    const invited = await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-3-7x!');
    assert.ok(invited);
    await accounts.sync(roster.filter(({ email }) => email !== 'barb.fultz@finevines.com'));
    assert.equal(await accounts.sessionIdentity(invited.email, invited.credentialVersion), null);
    assert.equal((await accounts.list()).some(({ email }) => email === invited.email), false);
    assert.equal(sequence, 3);
  });
});
