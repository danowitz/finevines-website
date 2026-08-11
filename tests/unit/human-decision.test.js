import test from 'node:test';
import assert from 'node:assert/strict';
import { markHumanRejected, markHumanSelected } from '../../tools/labelfetch/human-decision.mjs';

test('a clicked candidate becomes valid human identity evidence', () => {
  const record = {
    failureStage: 'identity-anchor',
    humanRejected: true,
    review: ['identity not proven'],
    funnel: { outcome: 'failed' },
  };
  markHumanSelected(record, 'human review');
  assert.equal(record.selectionIdentityVerified, true);
  assert.equal(record.verifiedBy, 'human review');
  assert.equal(record.failureStage, undefined);
  assert.equal(record.humanRejected, undefined);
  assert.deepEqual(record.review, []);
  assert.equal(record.funnel.outcome, 'human-selected');
});

test('none-of-these is persisted as a terminal human rejection', () => {
  const record = { ok: true, file: 'candidate.png', funnel: { outcome: 'selected' } };
  markHumanRejected(record);
  assert.equal(record.ok, false);
  assert.equal(record.file, undefined);
  assert.equal(record.failureStage, 'human-rejected');
  assert.equal(record.funnel.outcome, 'failed');
});
