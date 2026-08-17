import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { afterEach, describe, it } from 'node:test';
import { createReviewState } from '../../edge/review-console/review-state.mjs';
import { createReviewerAccounts } from '../../edge/review-console/reviewer-accounts.mjs';

const clients = [];
afterEach(() => { while (clients.length) clients.pop().close(); });

async function fixture(now = '2026-08-16T12:00:00.000Z', temporaryPassword = () => 'Random-Launch-Password-7x!') {
  let clock = new Date(now);
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  const state = createReviewState({ client, now: () => new Date(clock) });
  await state.initialize();
  const messages = [];
  const accounts = createReviewerAccounts({
    state,
    now: () => new Date(clock),
    temporaryPassword,
    mailer: { send: async (message) => { messages.push(message); } },
  });
  return { accounts, messages, advanceTo: (value) => { clock = new Date(value); } };
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
    assert.doesNotMatch(JSON.stringify(await accounts.list()), /Random-Launch-Password/);

    const temporary = await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-7x!');
    assert.equal(temporary.mustChangePassword, true);
    assert.equal(temporary.credentialVersion, 1);
    assert.ok(await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-7x!'), 'temporary password remains usable until the required password change completes');
    await accounts.changePassword(temporary, 'Random-Launch-Password-7x!', 'A-new-private-password-92!');
    assert.equal(await accounts.authenticate('barb.fultz@finevines.com', 'Random-Launch-Password-7x!'), null);
    const permanent = await accounts.authenticate('barb.fultz@finevines.com', 'A-new-private-password-92!');
    assert.equal(permanent.mustChangePassword, false);
    assert.equal(permanent.credentialVersion, 2);
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
