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

  return { initialize, queue, counts };
}
