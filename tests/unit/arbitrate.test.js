// Unit tests for the identity-arbitration verdict parser. The arbiter asks a
// vision model, at FULL resolution, whether a bottle's label names the wine we
// think it is — the tiebreak when our OCR pipeline and a thumbnail-judging
// consumer AI disagree. Parsing must never turn a malformed reply into a
// confident "yes": an unreadable verdict is `null` (no opinion), which the
// caller treats as "leave it for the human", not as an acceptance.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentityVerdict, revertToLabel } from '../../tools/labelfetch/arbitrate.mjs';

describe('parseIdentityVerdict', () => {
  test('reads a clean accept', () => {
    assert.deepEqual(parseIdentityVerdict('{"names_this_wine":true,"label":"Acre Napa Valley"}'), {
      namesThisWine: true,
      label: 'Acre Napa Valley',
    });
  });

  test('reads a clean reject', () => {
    assert.deepEqual(parseIdentityVerdict('{"names_this_wine":false,"label":"Caymus"}'), {
      namesThisWine: false,
      label: 'Caymus',
    });
  });

  test('tolerates a fenced code block', () => {
    assert.deepEqual(parseIdentityVerdict('```json\n{"names_this_wine":true,"label":"X"}\n```'), {
      namesThisWine: true,
      label: 'X',
    });
  });

  test('a missing label is empty, not undefined', () => {
    assert.deepEqual(parseIdentityVerdict('{"names_this_wine":false}'), {
      namesThisWine: false,
      label: '',
    });
  });

  test('garbage is no opinion, never an accept', () => {
    assert.equal(parseIdentityVerdict('I think so?'), null);
    assert.equal(parseIdentityVerdict(''), null);
    assert.equal(parseIdentityVerdict(null), null);
  });

  test('a non-boolean verdict is no opinion', () => {
    // "maybe" must not coerce to true via truthiness.
    assert.equal(parseIdentityVerdict('{"names_this_wine":"maybe"}'), null);
  });
});

describe('revertToLabel', () => {
  test('puts a wine back on its generated SVG label', () => {
    const w = {
      slug: 'acre-napa-cab-2019',
      imagePath: 'assets/img/wines/acre-napa-cab-2019.jpg',
      imageSource: 'scraped-web',
      imageSourceUrl: 'https://example.com/bottle.jpg',
      sources: { image: 'scraped' },
    };
    assert.equal(revertToLabel(w), 'assets/img/wines/acre-napa-cab-2019.jpg');
    assert.equal(w.imagePath, 'assets/img/wines/acre-napa-cab-2019.svg');
    assert.equal(w.imageSource, 'generated-label');
    assert.equal(w.imageSourceUrl, '', 'provenance of a wrong photo must not linger');
    assert.equal(w.sources.image, 'derived');
  });

  test('a wine already on its label is left alone and reports nothing to delete', () => {
    const w = { slug: 'x', imagePath: 'assets/img/wines/x.svg', imageSource: 'generated-label' };
    assert.equal(revertToLabel(w), null);
    assert.equal(w.imagePath, 'assets/img/wines/x.svg');
  });
});
