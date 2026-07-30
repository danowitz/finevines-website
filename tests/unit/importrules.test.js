import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldImport } from '../../tools/labelfetch/importrules.mjs';
import { flagWatermark } from '../../tools/labelfetch/watermark.mjs';

// A staged record as the sweep leaves it once it has actually looked: swept and
// clean. The unswept shape is the interesting one and is spelled out in the
// tests that need it, because "nobody has checked this image yet" is precisely
// the state that used to import.
const rec = (over = {}) => ({ ok: true, file: 'data/fetched-images/x.png', slug: 'x', watermarkSwept: true, ...over });
const placeholderWine = (over = {}) => ({
  slug: 'x',
  imagePath: 'assets/img/wines/x.svg',
  imageSource: 'generated-label',
  ...over,
});

describe('import selection rules', () => {
  test('a clean staged image for a placeholder wine imports', () => {
    const v = shouldImport(rec(), placeholderWine(), {});
    assert.equal(v.import, true);
  });

  test('a wine no longer in the catalog is skipped', () => {
    const v = shouldImport(rec(), undefined, {});
    assert.equal(v.import, false);
    assert.match(v.reason, /no such wine/);
  });

  test('a wine that already has a photograph is never overwritten', () => {
    const v = shouldImport(rec(), placeholderWine({ imagePath: 'assets/img/wines/x.jpg' }), {});
    assert.equal(v.import, false);
    assert.match(v.reason, /already has a photograph/);
  });

  test('a watermarked record is refused even without cleanOnly', () => {
    const r = rec();
    flagWatermark(r, 'vivino');
    const v = shouldImport(r, placeholderWine(), {});
    assert.equal(v.import, false);
    assert.match(v.reason, /watermark/);
  });

  // The gate the watermark sweep actually needs. The sweep returns no verdict on
  // a transport error, an exhausted retry or an unparseable reply, and such a
  // record is neither flagged nor swept — so a rule that only refuses CONFIRMED
  // watermarks lets a never-examined image publish. Worse, it publishes
  // permanently: once a real photograph sits in the catalog the "already has a
  // photograph" rule refuses to replace it, so a later sweep can never undo it.
  // Failing closed per image costs nothing — the wine keeps its label and the
  // next sweep re-examines the same staged file.
  test('a record the sweep never checked is refused', () => {
    const r = rec({ watermarkSwept: undefined });
    const v = shouldImport(r, placeholderWine(), {});
    assert.equal(v.import, false);
    assert.match(v.reason, /watermark sweep/);
  });

  test('the refusal names why the sweep could not check it', () => {
    const r = rec({ watermarkSwept: undefined, watermarkSweepError: 'HTTP 500' });
    assert.match(shouldImport(r, placeholderWine(), {}).reason, /HTTP 500/);
  });

  test('a swept-clean record imports', () => {
    assert.equal(shouldImport(rec({ watermarkSwept: true }), placeholderWine(), {}).import, true);
  });

  test('a swept-and-flagged record is refused as a watermark, not as unswept', () => {
    const r = rec({ watermarkSwept: true });
    flagWatermark(r, 'vivino');
    const v = shouldImport(r, placeholderWine(), {});
    assert.equal(v.import, false);
    assert.match(v.reason, /watermark \(vivino\)/);
  });

  test('cleanOnly skips review-flagged records', () => {
    const r = rec({ review: ['low resolution (267x267)'] });
    assert.equal(shouldImport(r, placeholderWine(), { cleanOnly: true }).import, false);
    assert.match(shouldImport(r, placeholderWine(), { cleanOnly: true }).reason, /flagged for review/);
    // Without cleanOnly, a review flag alone does not block (the human said go).
    assert.equal(shouldImport(r, placeholderWine(), {}).import, true);
  });
});
