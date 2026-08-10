// Unit tests for the old-site review page's join and classification logic.
//
// This is the part where being wrong is silent: a manifest entry joined to the
// wrong wine, or a wine misclassified as a contest when it is really a rescue,
// would show a human the wrong comparison and they would have no way to notice
// from the page itself. Kept as pure functions, tested in isolation, so
// reviewpage.mjs itself only has to worry about rendering.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPhoto, joinManifest } from '../../tools/oldsiteharvest/reviewjoin.mjs';

const wine = (over = {}) => ({
  sku: '1',
  slug: 'dom-x-cuvee-a-2020',
  producer: 'Dom X',
  name: 'Cuvee A',
  vintage: '2020',
  imagePath: 'assets/img/wines/dom-x-cuvee-a-2020.jpg',
  imageSource: 'scraped-web',
  ...over,
});

const manifestEntry = (over = {}) => ({
  oldPath: '/portfolio/dom-x/cuvee-a',
  target: '/wines/dom-x-cuvee-a-2020/',
  sku: '1',
  wineHadPhoto: true,
  images: [
    { imageUrl: 'https://www.finevines.com/sites/default/files/product/a.jpg', file: 'a.jpg', bytes: 100, sha256: 'aaaa' },
  ],
  ...over,
});

describe('isPhoto', () => {
  test('a real photograph is a photo', () => {
    assert.equal(isPhoto(wine()), true);
  });

  test('the generated neutral SVG is not a photo', () => {
    assert.equal(isPhoto(wine({ imagePath: 'assets/img/wines/dom-x-cuvee-a-2020.svg' })), false);
  });

  test('no imagePath at all is not a photo', () => {
    assert.equal(isPhoto(wine({ imagePath: '' })), false);
  });
});

describe('joinManifest', () => {
  test('a manifest entry joins to the right wine by target', () => {
    const { rows, stats } = joinManifest([manifestEntry()], [wine()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sku, '1');
    assert.equal(rows[0].slug, 'dom-x-cuvee-a-2020');
    assert.equal(stats.byTarget, 1);
    assert.equal(stats.bySku, 0);
    assert.equal(stats.unmatched, 0);
  });

  test('falls back to SKU when the target does not resolve to a current wine', () => {
    const entry = manifestEntry({ target: '/wines/renamed-slug/' });
    const { rows, stats } = joinManifest([entry], [wine()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sku, '1');
    assert.equal(stats.byTarget, 0);
    assert.equal(stats.bySku, 1);
  });

  test('an entry whose target and SKU both fail to resolve is unmatched, not dropped silently', () => {
    const entry = manifestEntry({ target: '/wines/renamed-slug/', sku: '999' });
    const { rows, stats } = joinManifest([entry], [wine()]);
    assert.equal(rows.length, 0);
    assert.equal(stats.unmatched, 1);
  });

  test('a manifest entry with no SKU at all (the /portfolio/ catch-all) is not counted as unmatched', () => {
    const entry = manifestEntry({ target: '/portfolio/', sku: null });
    const { rows, stats } = joinManifest([entry], [wine()]);
    assert.equal(rows.length, 0);
    assert.equal(stats.unmatched, 0);
    assert.equal(stats.skippedNoSku, 1);
  });

  test('a wine with no current photo is classified a rescue', () => {
    const placeholderWine = wine({ imagePath: 'assets/img/wines/dom-x-cuvee-a-2020.svg', imageSource: 'generated-label' });
    const { rows, rescues, contests } = joinManifest([manifestEntry()], [placeholderWine]);
    assert.equal(rows[0].currentIsPhoto, false);
    assert.equal(rescues.length, 1);
    assert.equal(contests.length, 0);
  });

  test('a wine with both a current photo and an old-site photo is a contest', () => {
    const { rows, rescues, contests } = joinManifest([manifestEntry()], [wine()]);
    assert.equal(rows[0].currentIsPhoto, true);
    assert.equal(rescues.length, 0);
    assert.equal(contests.length, 1);
  });

  test('several manifest entries for one wine merge their images into one row', () => {
    const entries = [
      manifestEntry({ oldPath: '/portfolio/dom-x/cuvee-a', images: [{ imageUrl: 'https://x/a.jpg', file: 'a.jpg', bytes: 1, sha256: 'aaaa' }] }),
      manifestEntry({ oldPath: '/portfolio/dom-x/cuvee-a-alt', images: [{ imageUrl: 'https://x/b.jpg', file: 'b.jpg', bytes: 1, sha256: 'bbbb' }] }),
    ];
    const { rows } = joinManifest(entries, [wine()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].oldSiteImages.length, 2);
  });

  test('the same image mirrored twice (same sha256) is de-duplicated within a row', () => {
    const entries = [
      manifestEntry({ oldPath: '/portfolio/dom-x/cuvee-a' }),
      manifestEntry({ oldPath: '/portfolio/dom-x/cuvee-a-dup' }),
    ];
    const { rows } = joinManifest(entries, [wine()]);
    assert.equal(rows[0].oldSiteImages.length, 1);
  });

  test('a manifest entry pointing at a wine no longer in the catalog is unmatched, not thrown', () => {
    const entry = manifestEntry({ target: '/wines/gone/', sku: '404404' });
    const { rows, stats } = joinManifest([entry], [wine()]);
    assert.equal(rows.length, 0);
    assert.equal(stats.unmatched, 1);
  });

  test('a manifest entry with images but the current wine already has zero old-site images produces no row', () => {
    const entry = manifestEntry({ images: [] });
    const { rows } = joinManifest([entry], [wine()]);
    assert.equal(rows.length, 0);
  });
});
