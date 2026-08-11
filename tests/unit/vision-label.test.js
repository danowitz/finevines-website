import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVisionFields, parseVisionIdentity } from '../../tools/labelfetch/vision-label.mjs';

test('vision identity keeps product fields and excludes unstructured label copy', () => {
  const response = JSON.stringify({
    single_bottle: true,
    producer_brand: 'The Cider Farm',
    product_cuvee: 'Oak Aged',
    appellation: '',
    vintage: '',
    address: 'Mineral Point, Wisconsin',
    tasting_notes: 'Vanilla, Toast, Butterscotch',
  });
  assert.equal(parseVisionIdentity(response), 'The Cider Farm Oak Aged');
});

test('vision identity accepts a fenced response and all identity fields', () => {
  assert.equal(parseVisionIdentity('```json\n' + JSON.stringify({
    single_bottle: true,
    producer_brand: 'Domaine Example',
    product_cuvee: 'Les Epenots',
    appellation: 'Pommard Premier Cru',
    vintage: '2022',
  }) + '\n```'), 'Domaine Example Les Epenots Pommard Premier Cru 2022');
});

test('vision identity refuses malformed and bottle-less responses', () => {
  assert.equal(parseVisionIdentity('not json'), null);
  assert.equal(parseVisionIdentity(JSON.stringify({ single_bottle: false })), null);
});

test('vision fields preserve a structured product vintage', () => {
  assert.deepEqual(parseVisionFields(JSON.stringify({
    single_bottle: true,
    producer_brand: 'Domaine Example',
    product_cuvee: 'Reserve',
    appellation: '',
    vintage: '2022',
    matches_requested_identity: true,
  })), {
    text: 'Domaine Example Reserve 2022',
    vintage: '2022',
    identityMatch: true,
    producerBrand: 'Domaine Example',
    productCuvee: 'Reserve',
    appellation: '',
    wineStyle: 'unknown',
  });
});

test('vision fields preserve a blind bottle style', () => {
  const parsed = parseVisionFields(JSON.stringify({
    single_bottle: true,
    producer_brand: 'Domaine de la Mordoree',
    product_cuvee: '',
    appellation: 'Cotes du Rhone',
    vintage: '',
    wine_style: 'rose',
  }));
  assert.equal(parsed.wineStyle, 'rose');
});

test('vision fields preserve unknown rather than turning it into a rejection', () => {
  assert.equal(parseVisionFields(JSON.stringify({
    single_bottle: true,
    producer_brand: 'Domaine Example',
    product_cuvee: 'Reserve',
    appellation: '',
    vintage: '',
    matches_requested_identity: null,
  })).identityMatch, null);
});
