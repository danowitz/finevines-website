const encoder = new TextEncoder();
const ITERATIONS = 600_000;

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function derive(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  if (typeof password !== 'string' || password.length < 14) throw new Error('password must contain at least 14 characters');
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt))}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, iterationsText, saltText, hashText, extra] = String(encoded).split('$');
    const iterations = Number(iterationsText);
    if (algorithm !== 'pbkdf2-sha256' || extra || iterations !== ITERATIONS) return false;
    return equalBytes(await derive(String(password), unb64(saltText), iterations), unb64(hashText));
  } catch {
    return false;
  }
}

function defaultTemporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `${b64(bytes).replaceAll('+', 'A').replaceAll('/', 'B').replaceAll('=', '')}!7x`;
}

function publicAccount(account) {
  return {
    email: account.email,
    name: account.name,
    role: account.role,
    source: account.source,
    status: !account.eligible ? 'disabled'
      : !account.passwordHash ? 'invitation_pending'
        : account.mustChangePassword ? 'invited' : 'active',
  };
}

function authenticatedAccount(account) {
  return {
    email: account.email,
    name: account.name,
    role: account.role,
    mustChangePassword: account.mustChangePassword,
    credentialVersion: account.credentialVersion,
  };
}

export function createReviewerAccounts({ state, mailer, now = () => new Date(), temporaryPassword = defaultTemporaryPassword }) {
  if (!state?.syncReviewerAccounts || !state?.reviewerAccount) throw new Error('reviewer accounts require review state');
  if (!mailer?.send) throw new Error('reviewer accounts require a mailer');

  async function sync(roster) {
    const eligible = [];
    for (const person of Array.isArray(roster) ? roster : []) {
      const email = String(person?.email || '').trim().toLowerCase();
      const name = String(person?.name || '').trim();
      const role = String(person?.role || '').trim();
      if (!email || !name || !['Executive', 'Back Office'].includes(role)) continue;
      eligible.push({ email, name, role, source: 'salesforce' });
    }
    eligible.push({ email: 'joel@danowitz.com', name: 'Joel Danowitz', role: 'Support', source: 'support' });
    await state.syncReviewerAccounts(eligible);
  }

  async function list() {
    return (await state.listReviewerAccounts()).filter(({ eligible }) => eligible).map(publicAccount);
  }

  async function activate(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const account = await state.reviewerAccount(normalized);
    if (!account?.eligible) throw new Error('reviewer account is not eligible');
    const password = temporaryPassword();
    const expiresAt = new Date(now().getTime() + 72 * 60 * 60 * 1000).toISOString();
    const updated = await state.setReviewerInvitation(normalized, await hashPassword(password), expiresAt);
    await mailer.send({
      dedupeKey: `reviewer-invitation:${normalized}:${updated.credentialVersion}`,
      to: normalized,
      subject: 'Your Fine Vines image review invitation',
      text: `Your temporary Fine Vines image review password is: ${password}\n\nIt expires in 72 hours and must be changed when you first sign in.`,
    });
  }

  async function authenticate(email, password) {
    const account = await state.reviewerAccount(String(email || '').trim().toLowerCase());
    if (!account?.eligible || !account.passwordHash || !await verifyPassword(password, account.passwordHash)) return null;
    if (account.mustChangePassword && (!account.temporaryExpiresAt || Date.parse(account.temporaryExpiresAt) <= now().getTime())) return null;
    if (account.mustChangePassword) {
      if (account.invitationUsedAt) return null;
      const consumed = await state.consumeReviewerInvitation(account.email, account.credentialVersion);
      return consumed ? authenticatedAccount(consumed) : null;
    }
    return authenticatedAccount(account);
  }

  async function changePassword(identity, currentPassword, newPassword) {
    const account = await state.reviewerAccount(String(identity?.email || '').trim().toLowerCase());
    if (!account?.eligible || account.credentialVersion !== identity.credentialVersion || !await verifyPassword(currentPassword, account.passwordHash)) throw new Error('current password is incorrect');
    if (currentPassword === newPassword) throw new Error('new password must be different');
    const updated = await state.setReviewerPassword(account.email, await hashPassword(newPassword));
    return authenticatedAccount(updated);
  }

  async function authorizeSession(email, credentialVersion) {
    const account = await state.reviewerAccount(String(email || '').trim().toLowerCase());
    return Boolean(account?.eligible && !account.mustChangePassword && account.credentialVersion === credentialVersion);
  }

  async function sessionIdentity(email, credentialVersion) {
    const account = await state.reviewerAccount(String(email || '').trim().toLowerCase());
    return account?.eligible && account.credentialVersion === credentialVersion ? authenticatedAccount(account) : null;
  }

  return { sync, list, activate, authenticate, changePassword, authorizeSession, sessionIdentity };
}
