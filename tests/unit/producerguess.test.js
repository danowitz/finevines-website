import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProducer } from '../../tools/labelfetch/producerguess.mjs';

// Real shapes from data/wines.json — 929 placeholder wines carry the producer
// inside the name because Salesforce's FV_Brand__c mapping is still open.
describe('deriveProducer', () => {
  test('cuts at the appellation for classic Burgundy names', () => {
    assert.equal(
      deriveProducer('Domaine Bernard Moreau Pommard 1er Cru les Fremiers'),
      'Domaine Bernard Moreau'
    );
    assert.equal(deriveProducer('Domaine Bruno Clair Marsannay Les Vaudenelles'), 'Domaine Bruno Clair');
  });

  test('saint-názed producers survive — the boundary is the appellation, not "Saint"', () => {
    assert.equal(deriveProducer('Domaine Saint Damien Gigondas Rose'), 'Domaine Saint Damien');
  });

  test('cuts at grape variety when no appellation leads', () => {
    assert.equal(deriveProducer('Vine Hill Ranch Cabernet Sauvignon Napa Valley'), 'Vine Hill Ranch');
  });

  test('cuts at style/color words', () => {
    assert.equal(deriveProducer('Barrel Bomb 3 Year Kentucky Bourbon Whisky'), 'Barrel Bomb');
    assert.equal(deriveProducer('Chakana Ayni Rose Nature Sparkling'), 'Chakana Ayni');
  });

  test('no guess when the name STARTS with a wine term', () => {
    assert.equal(deriveProducer('Bourgogne Rouge Vieilles Vignes'), '');
    assert.equal(deriveProducer('Cava Brut Reserva'), '');
  });

  test('no guess from a single short token', () => {
    assert.equal(deriveProducer('X Chardonnay'), '');
  });

  test('a guess never exceeds five words', () => {
    const g = deriveProducer('One Two Three Four Five Six Chardonnay');
    assert.ok(g === '' || g.split(' ').length <= 5, g);
  });

  test('strips leading vintage and NV tokens before guessing', () => {
    assert.equal(deriveProducer('NV Denis Chaput Champagne Reserve Brut'), 'Denis Chaput');
    assert.equal(deriveProducer('2018 Adamvs Quintvs Cabernet Sauvignon'), 'Adamvs Quintvs');
  });

  test('a sibling wine sharing the prefix confirms a longer producer', () => {
    const all = [
      'Boigey Freres Vosne Romanee',
      'Boigey Freres Vosne Romanee Les Jachees',
    ];
    assert.equal(deriveProducer('Boigey Freres Vosne Romanee', all), 'Boigey Freres');
  });

  test('does not shrink a producer to a meaningless connector prefix', () => {
    const all = [
      'Domaine de la Villaudiere Sauvignon Blanc Igp Val de Loire',
      'Domaine de la Grosse Pierre Chiroubles aux Craz',
    ];
    assert.equal(
      deriveProducer('Domaine de la Villaudiere Sauvignon Blanc Igp Val de Loire', all),
      'Domaine de la Villaudiere'
    );
  });
});
