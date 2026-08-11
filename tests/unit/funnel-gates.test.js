import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markImportOutcome,
  markWatermarkClean,
  markWatermarkRejected,
  markWatermarkUnresolved,
} from '../../tools/labelfetch/funnel-gates.mjs';

test('watermark outcomes are mutually exclusive terminal gates', () => {
  const record = { funnel: {} };
  markWatermarkUnresolved(record);
  assert.equal(record.failureStage, 'watermark-unresolved');
  markWatermarkRejected(record);
  assert.equal(record.failureStage, 'watermark');
  assert.deepEqual(
    [record.funnel.watermarkClean, record.funnel.watermarkRejected, record.funnel.watermarkUnresolved],
    [0, 1, 0],
  );
  markWatermarkClean(record);
  assert.equal(record.failureStage, undefined);
  assert.equal(record.funnel.outcome, 'watermark-clean');
});

test('import outcome records success and unresolved publication failures', () => {
  const record = { funnel: {} };
  markImportOutcome(record, 'watermark-unresolved', { unresolved: true });
  assert.equal(record.failureStage, 'import-watermark-unresolved');
  assert.equal(record.funnel.outcome, 'pending');
  markImportOutcome(record, 'imported', { imported: true });
  assert.equal(record.failureStage, undefined);
  assert.equal(record.funnel.imported, 1);
  assert.equal(record.funnel.outcome, 'imported');
});
