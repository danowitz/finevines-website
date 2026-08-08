import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIdentityVerdict,
  applyIdentityVerdict,
  isPrepublishCandidate,
} from '../../tools/labelfetch/prepublish.mjs';

describe('prepublish identity gate', () => {
  test('accepts only a literal boolean verdict', () => {
    assert.deepEqual(
      parseIdentityVerdict('{"names_this_wine":true,"label":"Estate Cuvee"}'),
      { namesThisWine: true, label: 'Estate Cuvee' }
    );
    for (const malformed of ['', 'yes', '{"names_this_wine":"true"}', '{}']) {
      assert.equal(parseIdentityVerdict(malformed), null);
    }
  });

  test('only clean, swept, on-disk stand-in candidates enter the automatic gate', () => {
    const rec = { ok: true, file: 'x.png', watermarkSwept: true, review: [] };
    const wine = { imageSource: 'generated-label', imagePath: 'assets/img/wines/x.svg' };
    assert.equal(isPrepublishCandidate(rec, wine, { exists: () => true, cleanOnly: true }), true);
    assert.equal(isPrepublishCandidate({ ...rec, review: ['low resolution'] }, wine, { exists: () => true, cleanOnly: true }), false);
    assert.equal(isPrepublishCandidate({ ...rec, watermarkSwept: undefined }, wine, { exists: () => true, cleanOnly: true }), false);
    assert.equal(isPrepublishCandidate(rec, { imageSource: 'scraped-web', imagePath: 'x.jpg' }, { exists: () => true, cleanOnly: true }), false);
  });

  test('positive, negative, and absent opinions are recorded fail-closed', () => {
    const yes = { review: [] };
    applyIdentityVerdict(yes, { namesThisWine: true, label: 'Estate Cuvee' });
    assert.equal(yes.prepublishIdentityVerified, true);
    assert.equal(yes.prepublishLabel, 'Estate Cuvee');

    const no = { review: [] };
    applyIdentityVerdict(no, { namesThisWine: false, label: 'Estate Other Wine' });
    assert.equal(no.prepublishIdentityVerified, false);
    assert.match(no.review.at(-1), /refused/i);

    const none = { review: [] };
    applyIdentityVerdict(none, null);
    assert.equal(none.prepublishIdentityVerified, false);
    assert.match(none.review.at(-1), /unavailable/i);
  });
});
