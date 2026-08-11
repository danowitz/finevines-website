import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSearchQuery, uniqueImageTargets } from '../../tools/labelfetch/image-query.mjs';

test('first image query keeps the full producer and vintage', () => {
  assert.equal(
    imageSearchQuery({ producer: 'Weingut F.X. Pichler', name: 'Kellerberg Gruner Veltliner Smaragd', vintage: '2020' }),
    'Weingut F.X. Pichler Kellerberg Gruner Veltliner Smaragd 2020 bottle'
  );
});

test('rows sharing one public image slug become one target carrying every SKU', () => {
  assert.deepEqual(uniqueImageTargets([
    { slug: 'same-wine', sku: '100', name: 'Wine' },
    { slug: 'same-wine', sku: '200', name: 'Wine' },
    { slug: 'other-wine', sku: '300', name: 'Other' },
  ]), [
    { slug: 'same-wine', sku: '100', name: 'Wine', imageTargetSkus: ['100', '200'] },
    { slug: 'other-wine', sku: '300', name: 'Other', imageTargetSkus: ['300'] },
  ]);
});

test('uses the producer name the web actually uses for The Cider Farm', () => {
  assert.equal(
    imageSearchQuery({ producer: 'Cider Farm', name: 'Oak Aged Cider', vintage: '' }),
    'The Cider Farm Oak Aged Cider bottle'
  );
  assert.equal(
    imageSearchQuery({ producer: 'Cider Farm', name: 'Cider Farm Oak Aged Cider', vintage: '' }),
    'The Cider Farm Oak Aged Cider bottle'
  );
});
