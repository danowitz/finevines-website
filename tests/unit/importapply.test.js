import test from 'node:test';
import assert from 'node:assert/strict';
import { wineForImageUpgrade, winesForSlug } from '../../tools/labelfetch/importapply.mjs';

test('returns every catalog row sharing the slug', () => {
  const wines = [
    { slug: 'shared', sku: 'first' },
    { slug: 'other', sku: 'other' },
    { slug: 'shared', sku: 'second' },
  ];

  assert.deepEqual(winesForSlug(wines, 'shared').map((wine) => wine.sku), ['first', 'second']);
});

test('prefers a stand-in when duplicate rows disagree about image quality', () => {
  const wines = [
    { slug: 'shared', sku: 'scan', imagePath: 'shared.jpg', imageSource: 'label-scan' },
    { slug: 'shared', sku: 'photo', imagePath: 'shared.jpg', imageSource: 'scraped-web' },
  ];

  assert.equal(wineForImageUpgrade(wines, 'shared').sku, 'scan');
});
