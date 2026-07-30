import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blockedBy, assertAllowed, hostOf } from '../../tools/labelfetch/sources.mjs';

describe('blocked image sources', () => {
  test('Vivino is blocked — its images carry a burned-in watermark', () => {
    // The source that worked first and must not be reached for again. Its
    // framing is ideal, which is exactly why this needs to be a rule and not
    // a note.
    assert.equal(blockedBy('https://images.vivino.com/thumbs/abc_pb_x960.png'), 'vivino');
    assert.equal(blockedBy('https://www.vivino.com/search/wines?q=x'), 'vivino');
  });

  test('iDealwine is blocked — auction-house photos carry an iDealwine mark', () => {
    // Found by the 2026-07-29 watermark sweep: several staged images fetched
    // from clean retailer hosts turned out to be re-hosted iDealwine photos.
    // Block the source outright, same reasoning as Vivino.
    assert.equal(blockedBy('https://www.idealwine.com/uk/wine/1.jpg'), 'idealwine');
    assert.equal(blockedBy('https://media.idealwine.biz/photos/x.png'), 'idealwine');
  });

  test('stock libraries are blocked', () => {
    for (const u of [
      'https://media.gettyimages.com/id/1/photo.jpg',
      'https://c8.alamy.com/comp/X/bottle.jpg',
      'https://www.shutterstock.com/image-photo/wine-1.jpg',
      'https://www.wine-searcher.com/images/labels/1.jpg',
    ]) {
      assert.notEqual(blockedBy(u), '', `${u} should be blocked`);
    }
  });

  test('a producer or retailer host is allowed', () => {
    assert.equal(blockedBy('https://www.domaine-anne-gros.com/img/bottle.jpg'), '');
    assert.equal(blockedBy('https://www.klwines.com/images/skus/1740122.jpg'), '');
  });

  test('subdomains and regional variants are covered', () => {
    assert.equal(blockedBy('https://es.vivino.com/x.png'), 'vivino');
    assert.equal(blockedBy('https://cdn.images.vivino.com/x.png'), 'vivino');
  });

  test('assertAllowed throws rather than returning a flag', () => {
    // A rule whose return value can be ignored is not a rule.
    assert.throws(() => assertAllowed('https://images.vivino.com/x.png'), /blocked image source \(vivino\)/);
    assert.equal(assertAllowed('https://example.com/bottle.jpg'), 'https://example.com/bottle.jpg');
  });

  test('an unparseable URL is refused, not waved through', () => {
    assert.equal(blockedBy('not a url'), 'unparseable url');
    assert.throws(() => assertAllowed('not a url'));
  });

  test('hostOf lowercases and survives junk', () => {
    assert.equal(hostOf('https://IMAGES.Vivino.COM/x.png'), 'images.vivino.com');
    assert.equal(hostOf(''), '');
  });
});
