import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFunnelReport, summarizeFunnels } from '../../tools/labelfetch/funnel-report.mjs';

test('summarizes actual terminal outcomes instead of treating every staged record as accepted', () => {
  const summary = summarizeFunnels([
    {
      ok: false,
      failureStage: 'identity-anchor',
      funnel: { searchResults: 10, downloaded: 9, decodedImages: 9, identityAnchors: 0, explicitConflicts: 2 },
    },
    {
      ok: true,
      funnel: { searchResults: 10, downloaded: 8, decodedImages: 8, identityAnchors: 1, publishableAnchors: 1, outcome: 'pending', importStage: 'watermark-unresolved' },
    },
    { ok: true, funnel: { imported: 1, outcome: 'imported', importStage: 'imported' } },
    { ok: true, funnel: { outcome: 'failed', importStage: 'existing-photo' } },
    { ok: true, funnel: { outcome: 'selected' } },
    { ok: false },
  ]);
  assert.equal(summary.records, 6);
  assert.equal(summary.instrumented, 5);
  assert.equal(summary.imported, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.ready, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.stages['identity-anchor'], 1);
  assert.equal(summary.totals.searchResults, 20);
  assert.equal(summary.totals.downloaded, 17);
  assert.equal(summary.totals.explicitConflicts, 2);
  assert.match(formatFunnelReport(summary), /identity-anchor\s+1/);
});
