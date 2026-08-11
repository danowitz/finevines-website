import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFunnelReport, summarizeFunnels } from '../../tools/labelfetch/funnel-report.mjs';

test('summarizes candidate counts and terminal failure stages', () => {
  const summary = summarizeFunnels([
    {
      ok: false,
      failureStage: 'identity-anchor',
      funnel: { searchResults: 10, downloaded: 9, decodedImages: 9, identityAnchors: 0, explicitConflicts: 2 },
    },
    {
      ok: true,
      funnel: { searchResults: 10, downloaded: 8, decodedImages: 8, identityAnchors: 1, publishableAnchors: 1 },
    },
    { ok: false },
  ]);
  assert.equal(summary.records, 3);
  assert.equal(summary.instrumented, 2);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.stages['identity-anchor'], 1);
  assert.equal(summary.totals.searchResults, 20);
  assert.equal(summary.totals.downloaded, 17);
  assert.equal(summary.totals.explicitConflicts, 2);
  assert.match(formatFunnelReport(summary), /identity-anchor\s+1/);
});
