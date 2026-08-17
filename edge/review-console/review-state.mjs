const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const ALL_STATUSES = new Set(['queued', 'processing', 'completed', 'needs_attention']);

export class ActiveWineLockError extends Error {
  constructor({ sku, actionId }) {
    super(`wine ${sku} already has an active review action`);
    this.name = 'ActiveWineLockError';
    this.sku = sku;
    this.actionId = actionId;
  }
}

function rowValue(row, name) {
  return row?.[name] ?? row?.[Object.keys(row || {}).find((key) => key.toLowerCase() === name.toLowerCase())];
}

export function createReviewState({ client, now = () => new Date() }) {
  if (!client?.execute || !client?.batch) throw new Error('review state requires a transactional SQL client');

  async function initialize() {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS review_actions (
        id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        package_id TEXT NOT NULL,
        wine_revision TEXT NOT NULL,
        sku TEXT NOT NULL,
        reviewer_email TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','needs_attention')),
        action_json TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        attention_reason TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS review_actions_active_wine
        ON review_actions(environment, wine_revision)
        WHERE status IN ('queued','processing')`,
      `CREATE INDEX IF NOT EXISTS review_actions_pending
        ON review_actions(environment, status, submitted_at, id)`,
      `CREATE TABLE IF NOT EXISTS review_action_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL REFERENCES review_actions(id),
        status TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS reviewer_accounts (
        email TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('salesforce','support')),
        eligible INTEGER NOT NULL DEFAULT 1,
        password_hash TEXT,
        temporary_expires_at TEXT,
        must_change INTEGER NOT NULL DEFAULT 1,
        credential_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    ], 'write');
  }

  async function activeFor(action) {
    const result = await client.execute({
      sql: `SELECT id, sku FROM review_actions
        WHERE environment = ? AND wine_revision = ? AND status IN ('queued','processing')
        ORDER BY submitted_at, id LIMIT 1`,
      args: [action.environment, action.wineRevision],
    });
    const row = result.rows[0];
    return row ? { actionId: String(rowValue(row, 'id')), sku: String(rowValue(row, 'sku')) } : null;
  }

  async function queue(action) {
    const stamp = now().toISOString();
    try {
      await client.batch([
        {
          sql: `INSERT INTO review_actions
            (id, environment, package_id, wine_revision, sku, reviewer_email, kind, status, action_json, submitted_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
          args: [action.id, action.environment, action.packageId, action.wineRevision, action.sku,
            action.reviewer, action.kind, JSON.stringify(action), action.submittedAt, stamp],
        },
        {
          sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
            VALUES (?, 'queued', ?, 'review action accepted')`,
          args: [action.id, stamp],
        },
      ], 'write');
      return { id: action.id, status: 'queued' };
    } catch (error) {
      const active = await activeFor(action);
      if (active && active.actionId !== action.id) throw new ActiveWineLockError(active);
      throw error;
    }
  }

  async function counts(environment = 'test') {
    const result = await client.execute({
      sql: `SELECT status, COUNT(*) AS total, MIN(submitted_at) AS oldest
        FROM review_actions WHERE environment = ? GROUP BY status`,
      args: [environment],
    });
    const values = { queued: 0, processing: 0, completed: 0, needs_attention: 0 };
    let oldestPendingAt = null;
    for (const row of result.rows) {
      const status = String(rowValue(row, 'status'));
      if (!ALL_STATUSES.has(status)) continue;
      values[status] = Number(rowValue(row, 'total'));
      if (ACTIVE_STATUSES.has(status)) {
        const oldest = rowValue(row, 'oldest');
        if (oldest && (!oldestPendingAt || String(oldest) < oldestPendingAt)) oldestPendingAt = String(oldest);
      }
    }
    return {
      needsDecision: 0,
      queued: values.queued,
      processing: values.processing,
      completed: values.completed,
      needsAttention: values.needs_attention,
      oldestPendingAt,
    };
  }

  function statusFrom(row) {
    return {
      actionId: String(rowValue(row, 'id')),
      status: String(rowValue(row, 'status')),
      attentionReason: rowValue(row, 'attention_reason') ? String(rowValue(row, 'attention_reason')) : '',
    };
  }

  async function packageStatus(environment, wines) {
    const revisions = new Set((Array.isArray(wines) ? wines : []).map(({ wineRevision }) => wineRevision));
    const result = await client.execute({
      sql: `SELECT id, wine_revision, status, submitted_at, attention_reason
        FROM review_actions WHERE environment = ? ORDER BY submitted_at DESC, id DESC`,
      args: [environment],
    });
    const latest = new Map();
    for (const row of result.rows) {
      const revision = String(rowValue(row, 'wine_revision'));
      if (revisions.has(revision) && !latest.has(revision)) latest.set(revision, row);
    }
    const values = { needsDecision: 0, queued: 0, processing: 0, completed: 0, needsAttention: 0 };
    const statuses = {};
    const decisions = [];
    let oldestPendingAt = null;
    for (const wine of Array.isArray(wines) ? wines : []) {
      const row = latest.get(wine.wineRevision);
      if (!row) {
        values.needsDecision += 1;
        decisions.push(wine);
        continue;
      }
      const status = String(rowValue(row, 'status'));
      if (status === 'needs_attention') values.needsAttention += 1;
      else if (status === 'queued') values.queued += 1;
      else if (status === 'processing') values.processing += 1;
      else if (status === 'completed') values.completed += 1;
      statuses[wine.wineRevision] = statusFrom(row);
      if (ACTIVE_STATUSES.has(status)) {
        const submittedAt = String(rowValue(row, 'submitted_at'));
        if (!oldestPendingAt || submittedAt < oldestPendingAt) oldestPendingAt = submittedAt;
      }
    }
    return { counts: values, oldestPendingAt, decisions, statuses };
  }

  async function actionStatus(id, environment) {
    const result = await client.execute({
      sql: `SELECT id, status, attention_reason, submitted_at, started_at, completed_at
        FROM review_actions WHERE id = ? AND environment = ?`,
      args: [id, environment],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(rowValue(row, 'id')),
      status: String(rowValue(row, 'status')),
      attentionReason: rowValue(row, 'attention_reason') ? String(rowValue(row, 'attention_reason')) : '',
      submittedAt: String(rowValue(row, 'submitted_at')),
      startedAt: rowValue(row, 'started_at') ? String(rowValue(row, 'started_at')) : '',
      completedAt: rowValue(row, 'completed_at') ? String(rowValue(row, 'completed_at')) : '',
    };
  }

  async function transition(id, from, to, detail = '') {
    const allowed = {
      queued: new Set(['processing', 'needs_attention']),
      processing: new Set(['completed', 'needs_attention', 'queued']),
      needs_attention: new Set(['queued']),
      completed: new Set(),
    };
    if (!allowed[from]?.has(to)) throw new Error(`invalid review action transition ${from} -> ${to}`);
    const stamp = now().toISOString();
    const result = await client.batch([
      {
        sql: `UPDATE review_actions SET status = ?, updated_at = ?,
          started_at = CASE WHEN ? = 'processing' THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
          attention_reason = CASE WHEN ? = 'needs_attention' THEN ? ELSE '' END
          WHERE id = ? AND status = ?`,
        args: [to, stamp, to, stamp, to, stamp, to, detail, id, from],
      },
      {
        sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
          SELECT ?, ?, ?, ? WHERE changes() = 1`,
        args: [id, to, stamp, detail],
      },
    ], 'write');
    if (result[0].rowsAffected !== 1) throw new Error(`review action ${id} is not ${from}`);
    return { id, status: to };
  }

  async function syncReviewerAccounts(accounts) {
    const existing = await listReviewerAccounts();
    const incoming = new Set(accounts.map(({ email }) => email));
    const stamp = now().toISOString();
    const statements = [];
    for (const account of existing) {
      if (account.source === 'salesforce' && !incoming.has(account.email) && account.eligible) {
        statements.push({
          sql: `UPDATE reviewer_accounts SET eligible = 0, credential_version = credential_version + 1, updated_at = ? WHERE email = ?`,
          args: [stamp, account.email],
        });
      }
    }
    for (const account of accounts) {
      statements.push({
        sql: `INSERT INTO reviewer_accounts (email, name, role, source, eligible, updated_at)
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role,
            source = excluded.source, eligible = 1, updated_at = excluded.updated_at`,
        args: [account.email, account.name, account.role, account.source, stamp],
      });
    }
    if (statements.length) await client.batch(statements, 'write');
  }

  function accountFrom(row) {
    if (!row) return null;
    return {
      email: String(rowValue(row, 'email')),
      name: String(rowValue(row, 'name')),
      role: String(rowValue(row, 'role')),
      source: String(rowValue(row, 'source')),
      eligible: Boolean(Number(rowValue(row, 'eligible'))),
      passwordHash: rowValue(row, 'password_hash') ? String(rowValue(row, 'password_hash')) : '',
      temporaryExpiresAt: rowValue(row, 'temporary_expires_at') ? String(rowValue(row, 'temporary_expires_at')) : '',
      mustChangePassword: Boolean(Number(rowValue(row, 'must_change'))),
      credentialVersion: Number(rowValue(row, 'credential_version')),
    };
  }

  async function listReviewerAccounts() {
    const result = await client.execute('SELECT * FROM reviewer_accounts ORDER BY email');
    return result.rows.map(accountFrom);
  }

  async function reviewerAccount(email) {
    const result = await client.execute({ sql: 'SELECT * FROM reviewer_accounts WHERE email = ?', args: [email] });
    return accountFrom(result.rows[0]);
  }

  async function setReviewerInvitation(email, passwordHash, expiresAt) {
    const result = await client.execute({
      sql: `UPDATE reviewer_accounts SET password_hash = ?, temporary_expires_at = ?, must_change = 1,
        credential_version = credential_version + 1, updated_at = ? WHERE email = ? AND eligible = 1`,
      args: [passwordHash, expiresAt, now().toISOString(), email],
    });
    if (result.rowsAffected !== 1) throw new Error('reviewer account is not eligible');
    return reviewerAccount(email);
  }

  async function setReviewerPassword(email, passwordHash) {
    const result = await client.execute({
      sql: `UPDATE reviewer_accounts SET password_hash = ?, temporary_expires_at = NULL, must_change = 0,
        credential_version = credential_version + 1, updated_at = ? WHERE email = ? AND eligible = 1`,
      args: [passwordHash, now().toISOString(), email],
    });
    if (result.rowsAffected !== 1) throw new Error('reviewer account is not eligible');
    return reviewerAccount(email);
  }

  return {
    initialize, queue, counts, packageStatus, actionStatus, transition,
    syncReviewerAccounts, listReviewerAccounts, reviewerAccount, setReviewerInvitation, setReviewerPassword,
  };
}
