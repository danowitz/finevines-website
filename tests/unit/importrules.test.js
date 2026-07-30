import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldImport } from '../../tools/labelfetch/importrules.mjs';
import { flagWatermark } from '../../tools/labelfetch/watermark.mjs';

const rec = (over = {}) => ({ ok: true, file: 'data/fetched-images/x.png', slug: 'x', ...over });
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

  test('cleanOnly skips review-flagged records', () => {
    const r = rec({ review: ['low resolution (267x267)'] });
    assert.equal(shouldImport(r, placeholderWine(), { cleanOnly: true }).import, false);
    assert.match(shouldImport(r, placeholderWine(), { cleanOnly: true }).reason, /flagged for review/);
    // Without cleanOnly, a review flag alone does not block (the human said go).
    assert.equal(shouldImport(r, placeholderWine(), {}).import, true);
  });
});
