import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAttempts,
  saveAttempts,
  isDue,
  recordAttempt,
  RETRY_DAYS,
} from '../../tools/labelfetch/attempts.mjs';

const NOW = new Date('2026-07-29T08:15:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

describe('which wines the image stage should try', () => {
  test('a wine nobody has ever tried is due', () => {
    assert.equal(isDue({}, 'AB1201', NOW), true);
  });

  test('a wine whose photograph was imported is never due again', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(400), outcome: 'imported', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), false);
  });

  test('a recent miss is not due — this is the whole point of the ledger', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(3), outcome: 'miss', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), false);
  });

  test('a miss older than the backoff is due again', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(RETRY_DAYS + 1), outcome: 'miss', attempts: 4 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), true);
  });

  test('the backoff boundary is inclusive', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(RETRY_DAYS), outcome: 'miss', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), true);
  });

  test('a record with an unreadable timestamp is due, not stuck forever', () => {
    // Bias to retrying: a corrupt record that reads as "never due" would silently
    // exclude a wine from image sourcing for good, and nobody would notice.
    assert.equal(isDue({ AB1201: { outcome: 'miss' } }, 'AB1201', NOW), true);
    assert.equal(isDue({ AB1201: { lastAttempted: 'yesterday', outcome: 'miss' } }, 'AB1201', NOW), true);
  });

  test('the backoff is overridable so a one-off sweep can ignore it', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(2), outcome: 'miss', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW, 1), true);
  });
});

describe('recording an attempt', () => {
  test('a first attempt records the outcome, the time, and a count of one', () => {
    const attempts = {};
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    assert.deepEqual(attempts.AB1201, {
      lastAttempted: '2026-07-29T08:15:00.000Z',
      outcome: 'miss',
      attempts: 1,
    });
  });

  test('a repeat attempt increments the count', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(40), outcome: 'miss', attempts: 3 } };
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    assert.equal(attempts.AB1201.attempts, 4);
    assert.equal(attempts.AB1201.lastAttempted, '2026-07-29T08:15:00.000Z');
  });

  test('import upgrades a miss to imported', () => {
    // The two writers run in order in CI: pipeline.mjs records the attempt as a
    // miss, then import.mjs upgrades the ones it actually wrote. That ordering
    // means a run that crashes between them still leaves the attempt recorded,
    // so the next night does not re-burn the search.
    const attempts = {};
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    recordAttempt(attempts, 'AB1201', 'imported', NOW);
    assert.equal(attempts.AB1201.outcome, 'imported');
    assert.equal(isDue(attempts, 'AB1201', new Date('2027-01-01T00:00:00Z')), false);
  });

  test('an unknown outcome is refused rather than written', () => {
    assert.throws(() => recordAttempt({}, 'AB1201', 'maybe', NOW), /outcome/);
  });
});

describe('persistence', () => {
  test('a missing ledger loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'));
    assert.deepEqual(await loadAttempts(join(dir, 'image-attempts.json')), {});
  });

  test('save then load round-trips, and the file is diff-friendly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'));
    const path = join(dir, 'image-attempts.json');
    const attempts = {};
    recordAttempt(attempts, 'MB5110', 'imported', NOW);
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    await saveAttempts(attempts, path);

    assert.deepEqual(await loadAttempts(path), attempts);
    const raw = await readFile(path, 'utf8');
    // Committed to a public repo, so it has to diff one SKU at a time and the
    // keys have to be sorted or every run reshuffles the whole file.
    assert.ok(raw.endsWith('\n'), 'no trailing newline');
    assert.ok(raw.indexOf('"AB1201"') < raw.indexOf('"MB5110"'), 'keys are not sorted');
  });

  test('a corrupt ledger loads as empty rather than failing the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'));
    const path = join(dir, 'image-attempts.json');
    await writeFile(path, '{ this is not json');
    assert.deepEqual(await loadAttempts(path), {});
  });
});
