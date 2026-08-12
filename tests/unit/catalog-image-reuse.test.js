import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogImageDonors, reusableCatalogImage } from '../../tools/labelfetch/catalog-image-reuse.mjs';

const parent = {
  sku: '210430',
  producer: 'Anne Parent',
  name: 'Domaine Anne Parent Pommard 1er Cru les Epenots',
  vintage: '2018',
  imagePath: 'assets/img/wines/anne-parent-epenots-2018.jpg',
  imageSourceUrl: 'https://example.com/parent-epenots-2018',
};

test('a duplicate SKU with a producer typo reuses the exact product and vintage photograph', () => {
  const donors = buildCatalogImageDonors([parent]);
  const duplicate = {
    sku: '210429',
    producer: 'Anne Patent',
    name: 'Domaine Anne Parent Pommard 1er Cru les Epenots',
    vintage: '2018',
    imagePath: 'assets/img/wines/anne-patent-epenots-2018.svg',
  };
  assert.equal(reusableCatalogImage(donors, duplicate), parent);
});

test('catalog reuse never crosses product identity or vintage', () => {
  const donors = buildCatalogImageDonors([parent]);
  assert.equal(reusableCatalogImage(donors, { ...parent, sku: 'other', vintage: '2019', imagePath: 'x.svg' }), null);
  assert.equal(reusableCatalogImage(donors, { ...parent, sku: 'other', name: 'Domaine Anne Parent Pommard Les Chanlins', imagePath: 'x.svg' }), null);
});

test('placeholder artwork is never a reusable photograph', () => {
  const donors = buildCatalogImageDonors([{ ...parent, imagePath: 'assets/img/wines/parent.svg' }]);
  assert.equal(reusableCatalogImage(donors, { ...parent, sku: 'other', imagePath: 'x.svg' }), null);
});
