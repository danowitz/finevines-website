import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordFunnel,
  recoverableCandidateSlugs,
  recoverableQualitySlugs,
} from '../../tools/labelfetch/funnel-store.mjs';

test('stores a compact durable rule funnel without candidate file paths', () => {
  const store = {};
  recordFunnel(store, {
    slug: 'wine-2022', sku: '1', name: 'Wine', ok: false,
    failureStage: 'identity-anchor', tried: [{ why: 'no anchor' }],
    funnel: { searchResults: 10, identityAnchors: 0 },
    failureCode: 'VISIBLE_WRONG_VINTAGE',
    evidence: [{
      id: 'candidate-1', productAnchor: true, explicitConflict: true,
      readStatus: 'ok', vintageStatus: 'wrong-visible', reasonCode: 'VISIBLE_WRONG_VINTAGE',
      conflict: { expected: '2022', visible: '2021' }, label: 'Exact Wine 2021',
      visibleVintage: '2021', localVisibleVintage: '', file: 'ignored.png',
    }],
    alternates: [{
      image: 'https://images.example/wine.png', page: 'https://example/wine',
      size: '400x800', why: 'visible wrong vintage', label: 'Exact Wine 2021',
      strongestGroup: true, anchor: false, explicitConflict: true, file: 'ignored.png',
    }],
  }, new Date('2026-08-11T00:00:00Z'));
  assert.deepEqual(store['wine-2022'], {
    slug: 'wine-2022', sku: '1', name: 'Wine', ok: false,
    failureStage: 'identity-anchor', failureCode: 'VISIBLE_WRONG_VINTAGE', reason: 'no anchor',
    funnel: { searchResults: 10, identityAnchors: 0 },
    evidence: [{
      id: 'candidate-1', anchor: false, productAnchor: true, explicitConflict: true,
      readStatus: 'ok', vintageStatus: 'wrong-visible', reasonCode: 'VISIBLE_WRONG_VINTAGE',
      conflict: { expected: '2022', visible: '2021' }, sourceVintageMismatch: undefined,
      label: 'Exact Wine 2021', visibleVintage: '2021', localVisibleVintage: '',
    }],
    candidates: [{
      image: 'https://images.example/wine.png', page: 'https://example/wine',
      size: '400x800', why: 'visible wrong vintage', label: 'Exact Wine 2021',
      strongestGroup: true, anchor: false, explicitConflict: true,
    }],
    updatedAt: '2026-08-11T00:00:00.000Z',
  });
});

test('candidate recovery selects only repeated designs stopped at identity anchoring', () => {
  const store = {
    recoverable: {
      slug: 'recoverable', ok: false, failureStage: 'identity-anchor',
      funnel: { downloaded: 7, repeatedGroups: 1 },
    },
    noGroup: {
      slug: 'no-group', ok: false, failureStage: 'visual-consensus',
      funnel: { downloaded: 7, repeatedGroups: 0 },
    },
    badQuality: {
      slug: 'bad-quality', ok: false, failureStage: 'publication-quality',
      funnel: { downloaded: 7, repeatedGroups: 1, identityAnchors: 1 },
    },
    watermark: {
      slug: 'watermark', ok: false, failureStage: 'import-watermark',
      funnel: { downloaded: 7, repeatedGroups: 1 },
    },
    accepted: {
      slug: 'accepted', ok: true, failureStage: '',
      funnel: { downloaded: 7, repeatedGroups: 1 },
    },
    qualityRetryStillMissing: {
      slug: 'quality-retry-still-missing', ok: false, failureStage: 'identity-anchor',
      funnel: { downloaded: 7, repeatedGroups: 1, recoveryScope: 'quality' },
    },
    readerResponse: {
      slug: 'reader-response', ok: false, failureStage: 'reader-response',
      funnel: { downloaded: 7, repeatedGroups: 1 },
    },
    wrongVisibleVintage: {
      slug: 'wrong-visible-vintage', ok: false, failureStage: 'publication-vintage',
      funnel: { downloaded: 7, repeatedGroups: 1 },
    },
  };
  assert.deepEqual([...recoverableCandidateSlugs(store)], [
    'recoverable', 'reader-response', 'wrong-visible-vintage',
  ]);
  assert.deepEqual([...recoverableQualitySlugs(store)], ['bad-quality', 'quality-retry-still-missing']);
});
