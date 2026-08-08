import test from 'node:test';
import assert from 'node:assert/strict';
import { winesForSlug } from '../../tools/labelfetch/importapply.mjs';

test('returns every catalog row sharing the slug', () => {
  const wines = [
    { slug: 'shared', sku: 'first' },
    { slug: 'other', sku: 'other' },
    { slug: 'shared', sku: 'second' },
  ];

  assert.deepEqual(winesForSlug(wines, 'shared').map((wine) => wine.sku), ['first', 'second']);
});
