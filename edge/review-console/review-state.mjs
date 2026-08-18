const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const ALL_STATUSES = new Set(['needs_decision', 'queued', 'processing', 'completed', 'needs_attention']);

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
    const actionTable = `CREATE TABLE IF NOT EXISTS review_actions (
        id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        package_id TEXT NOT NULL,
        wine_revision TEXT NOT NULL,
        sku TEXT NOT NULL,
        reviewer_email TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('needs_decision','queued','processing','completed','needs_attention')),
        action_json TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        attention_reason TEXT,
        launch_excluded INTEGER NOT NULL DEFAULT 0
      )`;
    await client.execute(actionTable);
    const schema = await client.execute(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_actions'`);
    if (!String(rowValue(schema.rows[0], 'sql') || '').includes('needs_decision')) {
      const priorColumns = await client.execute('PRAGMA table_info(review_actions)');
      const hadDecisionOpen = priorColumns.rows.some((row) => String(rowValue(row, 'name')) === 'decision_open');
      const migratedStatus = hadDecisionOpen ? `CASE WHEN status = 'needs_attention' AND decision_open = 1 THEN 'needs_decision' ELSE status END` : 'status';
      await client.execute('PRAGMA foreign_keys = OFF');
      try {
        await client.batch([
          actionTable.replaceAll('review_actions', 'review_actions_next').replace('IF NOT EXISTS ', ''),
          `INSERT INTO review_actions_next
            (id, environment, package_id, wine_revision, sku, reviewer_email, kind, status, action_json,
             submitted_at, started_at, completed_at, updated_at, attention_reason)
           SELECT id, environment, package_id, wine_revision, sku, reviewer_email, kind, ${migratedStatus}, action_json,
             submitted_at, started_at, completed_at, updated_at, attention_reason FROM review_actions`,
          'DROP TABLE review_actions',
          'ALTER TABLE review_actions_next RENAME TO review_actions',
        ], 'write');
      } finally {
        await client.execute('PRAGMA foreign_keys = ON');
      }
    }
    const actionColumns = await client.execute('PRAGMA table_info(review_actions)');
    if (!actionColumns.rows.some((row) => String(rowValue(row, 'name')) === 'launch_excluded')) {
      await client.execute('ALTER TABLE review_actions ADD COLUMN launch_excluded INTEGER NOT NULL DEFAULT 0');
    }
    await client.batch([
      `CREATE UNIQUE INDEX IF NOT EXISTS review_actions_active_wine
        ON review_actions(environment, wine_revision)
        WHERE status IN ('queued','processing')`,
      `CREATE INDEX IF NOT EXISTS review_actions_pending
        ON review_actions(environment, status, submitted_at, id)`,
      `CREATE TABLE IF NOT EXISTS review_action_uploads (
        action_id TEXT PRIMARY KEY REFERENCES review_actions(id),
        storage_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        image_bytes BLOB NOT NULL
      )`,
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
        invitation_used_at TEXT,
        must_change INTEGER NOT NULL DEFAULT 1,
        credential_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS review_incidents (
        id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        action_id TEXT NOT NULL REFERENCES review_actions(id),
        sku TEXT NOT NULL,
        action_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        next_action TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        escalated_at TEXT,
        recovered_at TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS review_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        text_body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','sending','sent')) DEFAULT 'queued',
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        sent_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS review_notifications_pending
        ON review_notifications(status, available_at, id)`,
      `CREATE TABLE IF NOT EXISTS reviewer_password_resets (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL REFERENCES reviewer_accounts(email),
        credential_version INTEGER NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS reviewer_password_resets_email
        ON reviewer_password_resets(email, requested_at)`,
      `CREATE TABLE IF NOT EXISTS review_rate_limits (
        bucket_key TEXT PRIMARY KEY,
        window_started_at TEXT NOT NULL,
        attempts INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS review_rate_limits_window
        ON review_rate_limits(window_started_at)`,
      `CREATE TABLE IF NOT EXISTS review_recoveries (
        action_id TEXT PRIMARY KEY REFERENCES review_actions(id),
        environment TEXT NOT NULL,
        wine_revision TEXT NOT NULL,
        sku TEXT NOT NULL,
        slug TEXT NOT NULL,
        rejected_candidates_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','ready','needs_attention','excluded')),
        reason TEXT NOT NULL DEFAULT '',
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS review_recoveries_pending
        ON review_recoveries(environment, status, requested_at, action_id)`,
    ], 'write');
    const reviewerColumns = await client.execute('PRAGMA table_info(reviewer_accounts)');
    if (!reviewerColumns.rows.some((row) => String(rowValue(row, 'name')) === 'invitation_used_at')) {
      await client.execute('ALTER TABLE reviewer_accounts ADD COLUMN invitation_used_at TEXT');
    }
    const notificationColumns = await client.execute('PRAGMA table_info(review_notifications)');
    if (!notificationColumns.rows.some((row) => String(rowValue(row, 'name')) === 'sensitive')) {
      await client.execute('ALTER TABLE review_notifications ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
    }
    const resetColumns = await client.execute('PRAGMA table_info(reviewer_password_resets)');
    if (!resetColumns.rows.some((row) => String(rowValue(row, 'name')) === 'credential_version')) {
      await client.execute('ALTER TABLE reviewer_password_resets ADD COLUMN credential_version INTEGER NOT NULL DEFAULT -1');
    }
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

  async function queue(action, upload) {
    const stamp = now().toISOString();
    try {
      const statements = [
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
      ];
      if (upload) statements.push({
        sql: `INSERT INTO review_action_uploads (action_id, storage_name, mime, image_bytes) VALUES (?, ?, ?, ?)`,
        args: [action.id, action.imageStorageName, action.imageMIME, upload.bytes],
      });
      await client.batch(statements, 'write');
      return { id: action.id, status: 'queued' };
    } catch (error) {
      const active = await activeFor(action);
      if (active && active.actionId !== action.id) throw new ActiveWineLockError(active);
      throw error;
    }
  }

  async function importLegacyAction(action) {
    if (!action?.id || action.environment === undefined || !action.wineRevision || !action.sku || !action.submittedAt) throw new Error('legacy review action is invalid');
    if (await actionStatus(action.id, action.environment)) return { id: action.id, status: 'existing' };
    try { return await queue(action); }
    catch (error) {
      if (!(error instanceof ActiveWineLockError)) throw error;
      const stamp = now().toISOString();
      await client.batch([
        { sql: `INSERT INTO review_actions
            (id, environment, package_id, wine_revision, sku, reviewer_email, kind, status, action_json, submitted_at, updated_at, attention_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_attention', ?, ?, ?, ?)`,
          args: [action.id, action.environment, action.packageId, action.wineRevision, action.sku, action.reviewer, action.kind, JSON.stringify(action), action.submittedAt, stamp, `migration found another active action ${error.actionId} for this wine`] },
        { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail) VALUES (?, 'needs_attention', ?, 'legacy migration found a duplicate active wine decision')`, args: [action.id, stamp] },
      ], 'write');
      return { id: action.id, status: 'needs_attention' };
    }
  }

  async function counts(environment = 'test') {
    const result = await client.execute({
      sql: `SELECT status, COUNT(*) AS total, MIN(submitted_at) AS oldest
        FROM review_actions WHERE environment = ? AND launch_excluded = 0 GROUP BY status`,
      args: [environment],
    });
    const values = { needs_decision: 0, queued: 0, processing: 0, completed: 0, needs_attention: 0 };
    let oldestPendingAt = null;
    for (const row of result.rows) {
      const status = String(rowValue(row, 'status'));
      if (Number(rowValue(row, 'launch_excluded') || 0) === 1) {
        statuses[wine.wineRevision] = { ...statusFrom(row), launchExcluded: true };
        continue;
      }
      if (!ALL_STATUSES.has(status)) continue;
      const total = Number(rowValue(row, 'total'));
      values[status] += total;
      if (ACTIVE_STATUSES.has(status)) {
        const oldest = rowValue(row, 'oldest');
        if (oldest && (!oldestPendingAt || String(oldest) < oldestPendingAt)) oldestPendingAt = String(oldest);
      }
    }
    return {
      needsDecision: values.needs_decision,
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
      sql: `SELECT id, wine_revision, status, submitted_at, attention_reason, launch_excluded
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
      if (status === 'needs_decision') { values.needsDecision += 1; decisions.push(wine); }
      else if (status === 'needs_attention') values.needsAttention += 1;
      else if (status === 'queued') values.queued += 1;
      else if (status === 'processing') values.processing += 1;
      else if (status === 'completed') values.completed += 1;
      statuses[wine.wineRevision] = statusFrom(row);
      if (ACTIVE_STATUSES.has(status)) {
        const submittedAt = String(rowValue(row, 'submitted_at'));
        if (!oldestPendingAt || submittedAt < oldestPendingAt) oldestPendingAt = submittedAt;
      }
    }
    const { oldestPendingAt: durableOldest, ...durable } = await counts(environment);
    return { counts: { ...durable, needsDecision: values.needsDecision }, oldestPendingAt: durableOldest, decisions, statuses };
  }

  async function actionStatus(id, environment) {
    const result = await client.execute({
      sql: `SELECT id, status, attention_reason, launch_excluded, submitted_at, started_at, completed_at
        FROM review_actions WHERE id = ? AND environment = ?`,
      args: [id, environment],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(rowValue(row, 'id')),
      status: String(rowValue(row, 'status')),
      attentionReason: rowValue(row, 'attention_reason') ? String(rowValue(row, 'attention_reason')) : '',
      launchExcluded: Number(rowValue(row, 'launch_excluded') || 0) === 1,
      submittedAt: String(rowValue(row, 'submitted_at')),
      startedAt: rowValue(row, 'started_at') ? String(rowValue(row, 'started_at')) : '',
      completedAt: rowValue(row, 'completed_at') ? String(rowValue(row, 'completed_at')) : '',
    };
  }

  async function pendingActionPayloads(environment, { limit = 100 } = {}) {
    const result = await client.execute({
      sql: `SELECT a.action_json, u.storage_name, u.mime, u.image_bytes
        FROM review_actions a LEFT JOIN review_action_uploads u ON u.action_id = a.id
        WHERE a.environment = ? AND a.status IN ('queued','processing')
          AND NOT EXISTS (SELECT 1 FROM review_recoveries r WHERE r.action_id = a.id AND r.status = 'pending')
        ORDER BY a.submitted_at, a.id LIMIT ?`,
      args: [environment, limit],
    });
    return result.rows.map((row) => ({
      action: JSON.parse(String(rowValue(row, 'action_json'))),
      upload: rowValue(row, 'image_bytes') == null ? null : {
        storageName: String(rowValue(row, 'storage_name')),
        mime: String(rowValue(row, 'mime')),
        bytes: rowValue(row, 'image_bytes'),
      },
    }));
  }

  async function launchExclusions(environment) {
    const result = await client.execute({
      sql: `SELECT sku, wine_revision, attention_reason FROM review_actions
        WHERE environment = ? AND launch_excluded = 1 ORDER BY sku, wine_revision`, args: [environment],
    });
    return result.rows.map((row) => ({
      sku: String(rowValue(row, 'sku')),
      wineRevision: String(rowValue(row, 'wine_revision')),
      reason: String(rowValue(row, 'attention_reason') || ''),
    }));
  }

  async function transition(id, from, to, detail = '') {
    const allowed = {
      queued: new Set(['processing', 'needs_attention']),
      processing: new Set(['completed', 'needs_attention', 'queued']),
      needs_attention: new Set(['queued', 'processing', 'needs_decision']),
      needs_decision: new Set(),
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

  async function scheduleRecovery(id, environment) {
    const result = await client.execute({ sql: 'SELECT * FROM review_actions WHERE id = ? AND environment = ?', args: [id, environment] });
    const row = result.rows[0];
    if (!row || String(rowValue(row, 'status')) !== 'processing') throw new Error(`review action ${id} is not processing`);
    const action = JSON.parse(String(rowValue(row, 'action_json')));
    if (action.kind !== 'no-image' || !/^[A-Za-z0-9._-]{1,180}$/.test(action.wineSlug || '') || !Array.isArray(action.rejectedCandidates) || !action.rejectedCandidates.length) {
      throw new Error(`review action ${id} has no valid rejected candidate set`);
    }
    const rejected = action.rejectedCandidates.map((candidate) => ({
      candidateId: String(candidate.candidateId || ''), sha256: String(candidate.sha256 || ''),
      sourceImageUrl: String(candidate.sourceImageUrl || ''), sourceUrl: String(candidate.sourceUrl || ''),
    }));
    if (rejected.some((candidate) => !/^[A-Za-z0-9._-]{1,120}$/.test(candidate.candidateId) || !/^[a-f0-9]{64}$/.test(candidate.sha256))) {
      throw new Error(`review action ${id} has invalid rejected candidates`);
    }
    const stamp = now().toISOString();
    await client.batch([
      { sql: `INSERT INTO review_recoveries
          (action_id, environment, wine_revision, sku, slug, rejected_candidates_json, status, requested_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(action_id) DO UPDATE SET status = 'pending', reason = '', updated_at = excluded.updated_at`,
        args: [id, environment, String(rowValue(row, 'wine_revision')), String(rowValue(row, 'sku')), action.wineSlug, JSON.stringify(rejected), stamp, stamp] },
      { sql: `UPDATE review_actions SET status = 'processing', updated_at = ?, attention_reason = ''
          WHERE id = ? AND status = 'processing'`, args: [stamp, id] },
      { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
          SELECT ?, 'processing', ?, 'broader candidate discovery scheduled' WHERE changes() = 1`, args: [id, stamp] },
    ], 'write');
    return { actionId: id, slug: action.wineSlug, rejected: rejected.length };
  }

  async function pendingRecoveries(environment) {
    const result = await client.execute({
      sql: `SELECT action_id, slug, rejected_candidates_json FROM review_recoveries
        WHERE environment = ? AND status = 'pending' ORDER BY requested_at, action_id`, args: [environment],
    });
    return result.rows.map((row) => ({ actionId: String(rowValue(row, 'action_id')), slug: String(rowValue(row, 'slug')), rejectedCandidates: JSON.parse(String(rowValue(row, 'rejected_candidates_json'))) }));
  }

  async function resolveRecovery(actionId, outcome, reason = '') {
    if (!['ready', 'needs_attention'].includes(outcome)) throw new Error('invalid recovery outcome');
    const actionStatus = outcome === 'ready' ? 'needs_decision' : 'needs_attention';
    const stamp = now().toISOString();
    const result = await client.batch([
      { sql: `UPDATE review_recoveries SET status = ?, reason = ?, updated_at = ?
          WHERE action_id = ? AND status = 'pending'
            AND EXISTS (SELECT 1 FROM review_actions WHERE id = ? AND status = 'processing')`, args: [outcome, reason, stamp, actionId, actionId] },
      { sql: `UPDATE review_actions SET status = ?, updated_at = ?, attention_reason = ?
          WHERE id = ? AND status = 'processing'
            AND EXISTS (SELECT 1 FROM review_recoveries WHERE action_id = ? AND status = ? AND updated_at = ?)`, args: [actionStatus, stamp, reason, actionId, actionId, outcome, stamp] },
      { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
          SELECT ?, ?, ?, ? WHERE changes() = 1`, args: [actionId, actionStatus, stamp, reason] },
    ], 'write');
    if (result[0].rowsAffected !== 1 || result[1].rowsAffected !== 1) throw new Error(`recovery ${actionId} is not pending`);
  }

  async function recoverAction(id, operation, reason = '') {
    if (!['retry', 'reopen', 'rediscover', 'exclude'].includes(operation)) throw new Error('invalid recovery operation');
    if ((operation === 'exclude' || operation === 'reopen') && !String(reason).trim()) throw new Error('recovery reason is required');
    if (operation === 'retry') return transition(id, 'needs_attention', 'queued', reason);
    if (operation === 'reopen') {
      const stamp = now().toISOString();
      const result = await client.batch([
        { sql: `UPDATE review_actions SET status = 'needs_decision', updated_at = ?, attention_reason = ?, launch_excluded = 0 WHERE id = ? AND status = 'needs_attention'`, args: [stamp, reason, id] },
        { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
            SELECT ?, 'needs_decision', ?, ? WHERE changes() = 1`, args: [id, stamp, reason] },
      ], 'write');
      if (result[0].rowsAffected !== 1) throw new Error(`review action ${id} cannot be reopened`);
      return { id, status: 'needs_decision' };
    }
    if (operation === 'exclude') {
      const stamp = now().toISOString();
      const detail = `temporarily excluded from launch: ${reason}`;
      const result = await client.batch([
        { sql: `UPDATE review_actions SET updated_at = ?, attention_reason = ?, launch_excluded = 1 WHERE id = ? AND status = 'needs_attention'`, args: [stamp, reason, id] },
        { sql: `INSERT INTO review_recoveries
            (action_id, environment, wine_revision, sku, slug, rejected_candidates_json, status, reason, requested_at, updated_at)
            SELECT id, environment, wine_revision, sku,
              COALESCE(json_extract(action_json, '$.wineSlug'), sku),
              COALESCE(json_extract(action_json, '$.rejectedCandidates'), '[]'),
              'excluded', ?, ?, ? FROM review_actions
            WHERE id = ? AND status = 'needs_attention' AND launch_excluded = 1 AND updated_at = ?
            ON CONFLICT(action_id) DO UPDATE SET status = 'excluded', reason = excluded.reason, updated_at = excluded.updated_at`,
          args: [reason, stamp, stamp, id, stamp] },
        { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
            SELECT ?, 'needs_attention', ?, ?
            WHERE EXISTS (SELECT 1 FROM review_recoveries WHERE action_id = ? AND status = 'excluded' AND updated_at = ?)`,
          args: [id, stamp, detail, id, stamp] },
      ], 'write');
      if (result[0].rowsAffected !== 1 || result[1].rowsAffected !== 1) throw new Error(`review action ${id} cannot be excluded`);
      return { id, status: 'needs_attention' };
    }
    const stamp = now().toISOString();
    const current = await client.execute({ sql: 'SELECT * FROM review_actions WHERE id = ? AND status = ?', args: [id, 'needs_attention'] });
    const row = current.rows[0];
    if (!row) throw new Error(`review action ${id} cannot be rediscovered`);
    const action = JSON.parse(String(rowValue(row, 'action_json')));
    if (action.kind !== 'no-image' || !/^[A-Za-z0-9._-]{1,180}$/.test(action.wineSlug || '') || !Array.isArray(action.rejectedCandidates) || !action.rejectedCandidates.length) {
      throw new Error(`review action ${id} has no valid rejected candidate set`);
    }
    const rejected = action.rejectedCandidates.map((candidate) => ({
      candidateId: String(candidate.candidateId || ''), sha256: String(candidate.sha256 || ''),
      sourceImageUrl: String(candidate.sourceImageUrl || ''), sourceUrl: String(candidate.sourceUrl || ''),
    }));
    if (rejected.some((candidate) => !/^[A-Za-z0-9._-]{1,120}$/.test(candidate.candidateId) || !/^[a-f0-9]{64}$/.test(candidate.sha256))) {
      throw new Error(`review action ${id} has invalid rejected candidates`);
    }
    const result = await client.batch([
      { sql: `INSERT INTO review_recoveries
          (action_id, environment, wine_revision, sku, slug, rejected_candidates_json, status, requested_at, updated_at)
          SELECT id, environment, wine_revision, sku, ?, ?, 'pending', ?, ? FROM review_actions WHERE id = ? AND status = 'needs_attention'
          ON CONFLICT(action_id) DO UPDATE SET status = 'pending', reason = '', requested_at = excluded.requested_at, updated_at = excluded.updated_at`,
        args: [action.wineSlug, JSON.stringify(rejected), stamp, stamp, id] },
      { sql: `UPDATE review_actions SET status = 'processing', updated_at = ?, attention_reason = '', launch_excluded = 0
          WHERE id = ? AND status = 'needs_attention'
            AND EXISTS (SELECT 1 FROM review_recoveries WHERE action_id = ? AND status = 'pending' AND updated_at = ?)`, args: [stamp, id, id, stamp] },
      { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
          SELECT ?, 'processing', ?, 'rediscovery requested by administrator' WHERE changes() = 1`, args: [id, stamp] },
    ], 'write');
    if (result[0].rowsAffected !== 1 || result[1].rowsAffected !== 1) throw new Error(`review action ${id} cannot be rediscovered`);
    return { id, status: 'processing' };
  }

  async function claim(environment, { limit = 50, staleBefore } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('review claim limit must be between 1 and 50');
    if (!staleBefore || !Number.isFinite(Date.parse(staleBefore))) throw new Error('review claim requires a stale cutoff');
    const stamp = now().toISOString();
    const candidates = await client.execute({
      sql: `SELECT id FROM review_actions
        WHERE environment = ? AND (status = 'queued' OR (status = 'processing' AND started_at < ?))
        ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, submitted_at, id LIMIT ?`,
      args: [environment, staleBefore, limit],
    });
    const selected = candidates.rows.map((row) => String(rowValue(row, 'id')));
    let actionIds = [];
    if (selected.length) {
      const statements = selected.flatMap((id) => [
        { sql: `UPDATE review_actions SET status = 'processing', started_at = ?, updated_at = ?, attention_reason = '', launch_excluded = 0
            WHERE id = ? AND environment = ? AND (status = 'queued' OR (status = 'processing' AND started_at < ?))`,
          args: [stamp, stamp, id, environment, staleBefore] },
        { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
            SELECT ?, 'processing', ?, 'processor claimed action' WHERE changes() = 1`, args: [id, stamp] },
      ]);
      const claimed = await client.batch(statements, 'write');
      actionIds = selected.filter((_, index) => Number(claimed[index * 2].rowsAffected || 0) === 1).sort();
    }
    const remainingResult = await client.execute({
      sql: `SELECT COUNT(*) AS total FROM review_actions
        WHERE environment = ? AND (status = 'queued' OR (status = 'processing' AND started_at < ?))`,
      args: [environment, staleBefore],
    });
    return { actionIds, remaining: Number(rowValue(remainingResult.rows[0], 'total')) };
  }

  async function releaseClaims(environment, actionIds, detail = 'processor stopped before completion') {
    const ids = [...new Set(Array.isArray(actionIds) ? actionIds : [])].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return { released: 0 };
    const stamp = now().toISOString();
    let released = 0;
    for (const id of ids) {
      const result = await client.batch([
        { sql: `UPDATE review_actions SET status = 'queued', started_at = NULL, updated_at = ?, attention_reason = ''
            WHERE id = ? AND environment = ? AND status = 'processing'
              AND NOT EXISTS (SELECT 1 FROM review_recoveries WHERE action_id = review_actions.id AND status = 'pending')`, args: [stamp, id, environment] },
        { sql: `INSERT INTO review_action_events (action_id, status, occurred_at, detail)
            SELECT ?, 'queued', ?, ? WHERE changes() = 1`, args: [id, stamp, detail] },
      ], 'write');
      released += Number(result[0].rowsAffected || 0);
    }
    return { released };
  }

  async function enqueueNotification(message) {
    const stamp = now().toISOString();
    await client.execute({
      sql: `INSERT INTO review_notifications (dedupe_key, recipient, subject, text_body, available_at, sensitive)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      args: [message.dedupeKey, message.to, message.subject, message.text, stamp, message.sensitive ? 1 : 0],
    });
  }

  function incidentFrom(row) {
    return {
      id: String(rowValue(row, 'id')),
      actionId: String(rowValue(row, 'action_id')),
      sku: String(rowValue(row, 'sku')),
      status: String(rowValue(row, 'action_status')),
      reason: String(rowValue(row, 'reason')),
      nextAction: String(rowValue(row, 'next_action')),
      openedAt: String(rowValue(row, 'opened_at')),
      ageMinutes: Math.max(0, Math.floor((now().getTime() - Date.parse(String(rowValue(row, 'opened_at')))) / 60_000)),
    };
  }

  async function scanIncidents(environment, recipient) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient || '')) throw new Error('incident recipient is invalid');
    const stamp = now().toISOString();
    const queuedCutoff = new Date(now().getTime() - 10 * 60_000).toISOString();
    const processingCutoff = new Date(now().getTime() - 45 * 60_000).toISOString();
    const actions = await client.execute({
      sql: `SELECT id, sku, status, submitted_at, started_at, attention_reason FROM review_actions
        WHERE environment = ? AND launch_excluded = 0 AND (
          status = 'needs_attention' OR
          (status = 'queued' AND submitted_at < ?) OR
          (status = 'processing' AND started_at < ?)
        ) ORDER BY submitted_at, id`,
      args: [environment, queuedCutoff, processingCutoff],
    });
    const active = new Set();
    for (const row of actions.rows) {
      const actionId = String(rowValue(row, 'id'));
      const status = String(rowValue(row, 'status'));
      const id = `${environment}:${actionId}`;
      active.add(id);
      const recovery = status === 'processing' && (await client.execute({ sql: `SELECT 1 FROM review_recoveries WHERE action_id = ? AND status = 'pending'`, args: [actionId] })).rows.length > 0;
      const reason = status === 'needs_attention'
        ? String(rowValue(row, 'attention_reason') || 'Action requires operator review')
        : status === 'queued' ? 'Queued for more than 10 minutes'
          : recovery ? 'Broader image discovery has not finished within 45 minutes'
            : 'Processing for more than 45 minutes';
      const nextAction = status === 'needs_attention' ? 'Review the action and choose retry, reopen, rediscover, or temporary exclusion.' : recovery ? 'Broader image discovery will be retried; investigate the recovery workflow if this persists.' : 'The processor will retry safely; investigate the workflow if this persists.';
      const existing = await client.execute({ sql: 'SELECT * FROM review_incidents WHERE id = ?', args: [id] });
      const prior = existing.rows[0];
      if (!prior || rowValue(prior, 'recovered_at')) {
        await client.batch([
          { sql: `INSERT INTO review_incidents (id, environment, action_id, sku, action_status, reason, next_action, opened_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET action_status = excluded.action_status, reason = excluded.reason, next_action = excluded.next_action,
                opened_at = excluded.opened_at, escalated_at = NULL, recovered_at = NULL, updated_at = excluded.updated_at
              WHERE review_incidents.recovered_at IS NOT NULL`,
            args: [id, environment, actionId, String(rowValue(row, 'sku')), status, reason, nextAction, stamp, stamp] },
          { sql: `INSERT INTO review_notifications (dedupe_key, recipient, subject, text_body, available_at)
              SELECT ?, ?, ?, ?, ? FROM review_incidents WHERE id = ? AND opened_at = ?
              ON CONFLICT(dedupe_key) DO NOTHING`,
            args: [`incident-open:${id}:${stamp}`, recipient, `Fine Vines review needs attention: ${rowValue(row, 'sku')}`, `${reason}\n\n${nextAction}`, stamp, id, stamp] },
        ], 'write');
      } else if (!rowValue(prior, 'escalated_at') && now().getTime() - Date.parse(String(rowValue(prior, 'opened_at'))) >= 4 * 60 * 60_000) {
        await client.batch([
          { sql: 'UPDATE review_incidents SET escalated_at = ?, updated_at = ? WHERE id = ? AND escalated_at IS NULL', args: [stamp, stamp, id] },
          { sql: `INSERT INTO review_notifications (dedupe_key, recipient, subject, text_body, available_at)
              SELECT ?, ?, ?, ?, ? FROM review_incidents WHERE id = ? AND escalated_at = ?
              ON CONFLICT(dedupe_key) DO NOTHING`,
            args: [`incident-escalation:${id}:${rowValue(prior, 'opened_at')}`, recipient, `Fine Vines review still blocked: ${rowValue(row, 'sku')}`, `${reason}\n\nThis incident has remained open for four hours. ${nextAction}`, stamp, id, stamp] },
        ], 'write');
      } else {
        await client.execute({ sql: 'UPDATE review_incidents SET action_status = ?, reason = ?, next_action = ?, updated_at = ? WHERE id = ?', args: [status, reason, nextAction, stamp, id] });
      }
    }
    const open = await client.execute({ sql: 'SELECT * FROM review_incidents WHERE environment = ? AND recovered_at IS NULL ORDER BY opened_at, id', args: [environment] });
    for (const row of open.rows) {
      const id = String(rowValue(row, 'id'));
      if (active.has(id)) continue;
      await client.batch([
        { sql: 'UPDATE review_incidents SET recovered_at = ?, updated_at = ? WHERE id = ? AND recovered_at IS NULL', args: [stamp, stamp, id] },
        { sql: `INSERT INTO review_notifications (dedupe_key, recipient, subject, text_body, available_at)
            SELECT ?, ?, ?, ?, ? FROM review_incidents WHERE id = ? AND recovered_at = ?
            ON CONFLICT(dedupe_key) DO NOTHING`,
          args: [`incident-recovery:${id}:${rowValue(row, 'opened_at')}`, recipient, `Fine Vines review recovered: ${rowValue(row, 'sku')}`, `The review incident has recovered. No further action is required.`, stamp, id, stamp] },
      ], 'write');
    }
    const current = await client.execute({ sql: 'SELECT * FROM review_incidents WHERE environment = ? AND recovered_at IS NULL ORDER BY opened_at, id', args: [environment] });
    return current.rows.map(incidentFrom);
  }

  async function claimNotifications({ limit = 25, staleBefore } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('notification claim limit must be between 1 and 100');
    const cutoff = staleBefore || new Date(now().getTime() - 15 * 60_000).toISOString();
    const stamp = now().toISOString();
    const result = await client.execute({
      sql: `UPDATE review_notifications SET status = 'sending', claimed_at = ?, attempts = attempts + 1
        WHERE id IN (SELECT id FROM review_notifications
          WHERE available_at <= ? AND (status = 'queued' OR (status = 'sending' AND claimed_at < ?))
          ORDER BY id LIMIT ?)
        RETURNING id, recipient, subject, text_body`,
      args: [stamp, stamp, cutoff, limit],
    });
    return result.rows.map((row) => ({
      id: Number(rowValue(row, 'id')), to: String(rowValue(row, 'recipient')),
      subject: String(rowValue(row, 'subject')), text: String(rowValue(row, 'text_body')),
    }));
  }

  async function completeNotification(id) {
    const result = await client.execute({
      sql: `UPDATE review_notifications SET status = 'sent', sent_at = ?,
        text_body = CASE WHEN sensitive = 1 THEN '[sensitive notification delivered and redacted]' ELSE text_body END
        WHERE id = ? AND status = 'sending'`,
      args: [now().toISOString(), id],
    });
    if (result.rowsAffected !== 1) throw new Error(`notification ${id} is not sending`);
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
      invitationUsedAt: rowValue(row, 'invitation_used_at') ? String(rowValue(row, 'invitation_used_at')) : '',
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
      sql: `UPDATE reviewer_accounts SET password_hash = ?, temporary_expires_at = ?, invitation_used_at = NULL, must_change = 1,
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

  async function createReviewerPasswordReset(email, tokenHash, expiresAt) {
    const stamp = now().toISOString();
    const cooldown = new Date(now().getTime() - 5 * 60_000).toISOString();
    const result = await client.batch([
      {
        sql: `INSERT INTO reviewer_password_resets (token_hash, email, credential_version, requested_at, expires_at)
          SELECT ?, email, credential_version, ?, ? FROM reviewer_accounts
          WHERE email = ? AND eligible = 1 AND password_hash IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM reviewer_password_resets WHERE email = ? AND requested_at > ?)`,
        args: [tokenHash, stamp, expiresAt, email, email, cooldown],
      },
      {
        sql: `UPDATE reviewer_password_resets SET consumed_at = ?
          WHERE email = ? AND token_hash <> ? AND consumed_at IS NULL
            AND EXISTS (SELECT 1 FROM reviewer_password_resets WHERE token_hash = ? AND requested_at = ?)`,
        args: [stamp, email, tokenHash, tokenHash, stamp],
      },
    ], 'write');
    return Number(result[0].rowsAffected || 0) === 1;
  }

  async function reviewerPasswordReset(tokenHash) {
    const result = await client.execute({
      sql: `SELECT r.email FROM reviewer_password_resets r
        JOIN reviewer_accounts a ON a.email = r.email
        WHERE r.token_hash = ? AND r.consumed_at IS NULL AND r.expires_at > ?
          AND a.eligible = 1 AND a.credential_version = r.credential_version`,
      args: [tokenHash, now().toISOString()],
    });
    return result.rows.length === 1;
  }

  async function consumeReviewerPasswordReset(tokenHash, passwordHash) {
    const stamp = now().toISOString();
    const result = await client.batch([
      {
        sql: `UPDATE reviewer_accounts SET password_hash = ?, temporary_expires_at = NULL,
          invitation_used_at = NULL, must_change = 0, credential_version = credential_version + 1, updated_at = ?
          WHERE eligible = 1 AND EXISTS (SELECT 1 FROM reviewer_password_resets r
            WHERE r.token_hash = ? AND r.email = reviewer_accounts.email AND r.credential_version = reviewer_accounts.credential_version
              AND r.consumed_at IS NULL AND r.expires_at > ?)`,
        args: [passwordHash, stamp, tokenHash, stamp],
      },
      {
        sql: `UPDATE reviewer_password_resets SET consumed_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND changes() = 1`,
        args: [stamp, tokenHash, stamp],
      },
      {
        sql: `UPDATE reviewer_password_resets SET consumed_at = ?
          WHERE email = (SELECT email FROM reviewer_password_resets WHERE token_hash = ? AND consumed_at = ?)
            AND token_hash <> ? AND consumed_at IS NULL`,
        args: [stamp, tokenHash, stamp, tokenHash],
      },
    ], 'write');
    return Number(result[0].rowsAffected || 0) === 1 && Number(result[1].rowsAffected || 0) === 1;
  }

  async function consumeRateLimit(bucketKey, limit, windowMs) {
    if (!bucketKey || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error('rate limit configuration is invalid');
    const stamp = now().toISOString();
    const cutoff = new Date(now().getTime() - windowMs).toISOString();
    const result = await client.batch([
      { sql: 'DELETE FROM review_rate_limits WHERE window_started_at <= ?', args: [cutoff] },
      {
        sql: `INSERT INTO review_rate_limits (bucket_key, window_started_at, attempts) VALUES (?, ?, 1)
          ON CONFLICT(bucket_key) DO UPDATE SET attempts = attempts + 1
          RETURNING attempts`,
        args: [bucketKey, stamp],
      },
    ], 'write');
    return Number(rowValue(result[1].rows[0], 'attempts')) <= limit;
  }

  async function consumeReviewerInvitation(email, credentialVersion) {
    const stamp = now().toISOString();
    const result = await client.execute({
      sql: `UPDATE reviewer_accounts SET invitation_used_at = ?, updated_at = ?
        WHERE email = ? AND credential_version = ? AND eligible = 1 AND must_change = 1 AND invitation_used_at IS NULL`,
      args: [stamp, stamp, email, credentialVersion],
    });
    if (result.rowsAffected !== 1) return null;
    return reviewerAccount(email);
  }

  return {
    initialize, queue, importLegacyAction, counts, packageStatus, actionStatus, pendingActionPayloads, launchExclusions, transition, claim, releaseClaims,
    scheduleRecovery, pendingRecoveries, resolveRecovery, recoverAction,
    enqueueNotification, scanIncidents, claimNotifications, completeNotification,
    syncReviewerAccounts, listReviewerAccounts, reviewerAccount, setReviewerInvitation, setReviewerPassword, consumeReviewerInvitation,
    createReviewerPasswordReset, reviewerPasswordReset, consumeReviewerPasswordReset, consumeRateLimit,
  };
}
