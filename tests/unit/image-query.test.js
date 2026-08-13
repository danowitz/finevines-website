import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSearchQuery, uniqueImageTargets } from '../../tools/labelfetch/image-query.mjs';

test('image query sends the full catalog display string in one shot', () => {
  assert.equal(
    imageSearchQuery({ producer: 'ignored', name: 'Weingut F.X. Pichler Kellerberg Gruner Veltliner Smaragd', vintage: '2020' }),
    'Weingut F.X. Pichler Kellerberg Gruner Veltliner Smaragd 2020'
  );
  assert.equal(
    imageSearchQuery({ name: 'Arrow & Branch Red Wine Napa Valley', vintage: '2012' }),
    'Arrow & Branch Red Wine Napa Valley 2012'
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
