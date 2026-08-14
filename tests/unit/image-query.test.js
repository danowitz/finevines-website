import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogImageName,
  catalogImageSearchQuery,
  imageSearchQuery,
  uniqueImageTargets,
} from '../../tools/labelfetch/image-query.mjs';

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

test('catalog and review searches use the same exact string without search hints', () => {
  assert.equal(
    catalogImageSearchQuery({ producer: 'Arrow & Branch', name: 'Red Wine Napa Valley', vintage: '2012' }),
    'Arrow & Branch Red Wine Napa Valley 2012',
  );
  assert.equal(
    catalogImageName({ producer: 'Arrow & Branch', name: 'Arrow & Branch Red Wine Napa Valley' }),
    'Arrow & Branch Red Wine Napa Valley',
  );
  assert.equal(catalogImageSearchQuery({ name: 'Wine', vintage: '2020' }).includes('bottle'), false);
  assert.equal(imageSearchQuery({ name: 'Wine', vintage: '' }), 'Wine');
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
