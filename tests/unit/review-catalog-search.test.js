import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchCatalogWines } from '../../edge/review-console/ui.mjs';

const wines = [
  {
    sku: 'FV-100*',
    skus: ['FV-100*', 'FV-100-CASE'],
    slug: 'domaine-test-chablis-2022',
    displayIdentity: 'Domaine Test Chablis 2022',
  },
  {
    sku: 'FV-200',
    skus: ['FV-200'],
    slug: 'another-producer-riesling-2021',
    displayIdentity: 'Another Producer Riesling 2021',
  },
];

describe('catalog image replacement search', () => {
  it('finds a pictured wine by producer, exact SKU, or Fine Vines URL', () => {
    assert.deepEqual(searchCatalogWines(wines, 'domaine chablis').map(({ sku }) => sku), ['FV-100*']);
    assert.deepEqual(searchCatalogWines(wines, 'FV-100*').map(({ sku }) => sku), ['FV-100*']);
    assert.deepEqual(searchCatalogWines(wines, 'https://finevines.com/wines/domaine-test-chablis-2022/').map(({ sku }) => sku), ['FV-100*']);
  });

  it('does not interpret another host as a trusted catalog URL', () => {
    assert.deepEqual(searchCatalogWines(wines, 'https://example.com/wines/domaine-test-chablis-2022/'), []);
  });
});
