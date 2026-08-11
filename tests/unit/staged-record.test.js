import test from 'node:test';
import assert from 'node:assert/strict';
import { reusableStagedRecord } from '../../tools/labelfetch/staged-record.mjs';

test('preserves a verified staged image across a later fetch run', () => {
  const record = { ok: true, file: 'data/fetched-images/exact.png' };
  assert.equal(reusableStagedRecord(record, true), record);
});

test('does not preserve a miss or a stale staged path', () => {
  assert.equal(reusableStagedRecord({ ok: false, file: 'candidate.png' }, true), null);
  assert.equal(reusableStagedRecord({ ok: true, file: 'missing.png' }, false), null);
});
