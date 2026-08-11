import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldImport } from '../../tools/labelfetch/importrules.mjs';
import { flagWatermark } from '../../tools/labelfetch/watermark.mjs';

// A staged record as the sweep leaves it once it has actually looked: swept and
// clean. The unswept shape is the interesting one and is spelled out in the
// tests that need it, because "nobody has checked this image yet" is precisely
// the state that used to import.
const rec = (over = {}) => ({
  ok: true,
  file: 'data/fetched-images/x.png',
  slug: 'x',
  watermarkSwept: true,
  selectionIdentityVerified: true,
  ...over,
});
const placeholderWine = (over = {}) => ({
  slug: 'x',
  imagePath: 'assets/img/wines/x.svg',
  imageSource: 'generated-label',
  ...over,
});

describe('import selection rules', () => {
  test('a clean staged image for a placeholder wine imports', () => {
    const v = shouldImport(rec(), placeholderWine(), {});
    assert.equal(v.import, true);
    assert.equal(v.stage, 'ready');
  });

  test('a wine no longer in the catalog is skipped', () => {
    const v = shouldImport(rec(), undefined, {});
    assert.equal(v.import, false);
    assert.match(v.reason, /no such wine/);
  });

  test('a wine that already has a REAL photograph is never overwritten', () => {
    const v = shouldImport(
      rec(),
      placeholderWine({ imagePath: 'assets/img/wines/x.jpg', imageSource: 'scraped-web' }),
      {}
    );
    assert.equal(v.import, false);
    assert.match(v.reason, /already has a photograph/);
  });

  test('a label scan IS replaced by a staged real image', () => {
    // The old site's flat label scans (95% of its images, audit 2026-08-04)
    // are stand-ins exactly like generated photos.
    const v = shouldImport(
      rec(),
      placeholderWine({ imagePath: 'assets/img/wines/x.jpg', imageSource: 'label-scan' }),
      {}
    );
    assert.equal(v.import, true);
  });

  test('a generated photo IS replaced by a staged real image', () => {
    // The generated tail is a stand-in, not a photograph: the Go pipeline
    // already treats generated-* as replaceable (enrich.hasRealImage), and
    // import must agree or the tail becomes permanently fake.
    const v = shouldImport(
      rec(),
      placeholderWine({ imagePath: 'assets/img/wines/x.jpg', imageSource: 'generated-photo' }),
      {}
    );
    assert.equal(v.import, true);
  });

  test('a watermarked record is refused even without cleanOnly', () => {
    const r = rec();
    flagWatermark(r, 'vivino');
    const v = shouldImport(r, placeholderWine(), {});
    assert.equal(v.import, false);
    assert.equal(v.stage, 'watermark');
    assert.match(v.reason, /watermark/);
  });

  // The gate the watermark sweep actually needs. The sweep returns no verdict on
  // a transport error, an exhausted retry or an unparseable reply, and such a
  // record is neither flagged nor swept — so a rule that only refuses CONFIRMED
  // watermarks lets a never-examined image publish. Worse, it publishes
  // permanently: once a real photograph sits in the catalog the "already has a
  // photograph" rule refuses to replace it, so a later sweep can never undo it.
  // Failing closed per image costs nothing — the wine keeps its label and the
  // next sweep re-examines the same staged file.
  test('a record the sweep never checked is refused', () => {
    const r = rec({ watermarkSwept: undefined });
    const v = shouldImport(r, placeholderWine(), {});
    assert.equal(v.import, false);
    assert.match(v.reason, /watermark sweep/);
  });

  test('a candidate without an affirmative production-selector verdict is refused', () => {
    const missing = shouldImport(rec({ selectionIdentityVerified: undefined }), placeholderWine(), {});
    assert.equal(missing.import, false);
    assert.match(missing.reason, /production selector/i);
    assert.equal(missing.unresolved, true);

    const refused = shouldImport(rec({ selectionIdentityVerified: false }), placeholderWine(), {});
    assert.equal(refused.import, false);
    assert.match(refused.reason, /production selector/i);
    assert.ok(!refused.unresolved);
  });

  test('a pre-boolean production-selector record keeps its complete proof', () => {
    const legacy = rec({
      selectionIdentityVerified: undefined,
      verifiedBy: 'gpt-4.1-nano transcription + local identity rules',
      matchingImages: 2,
      evidence: [{ anchor: true }],
    });
    assert.equal(shouldImport(legacy, placeholderWine(), {}).import, true);
  });

  test('a model name alone is not selector identity proof', () => {
    const incomplete = rec({
      selectionIdentityVerified: undefined,
      verifiedBy: 'gpt-4.1-nano transcription + local identity rules',
      matchingImages: 2,
      evidence: [{ anchor: false }],
    });
    assert.equal(shouldImport(incomplete, placeholderWine(), {}).import, false);
  });

  test('the refusal names why the sweep could not check it', () => {
    const r = rec({ watermarkSwept: undefined, watermarkSweepError: 'HTTP 500' });
    assert.match(shouldImport(r, placeholderWine(), {}).reason, /HTTP 500/);
  });

  // An unswept refusal is the ONE refusal that says nothing about the image. The
  // caller has to be able to tell it apart without matching on prose, because the
  // wine must not be benched for thirty days over it: the image was found and
  // verified, and it is about to be thrown away with the runner.
  test('an unswept refusal is marked unresolved so the ledger can stay open', () => {
    const v = shouldImport(rec({ watermarkSwept: undefined }), placeholderWine(), {});
    assert.equal(v.import, false);
    assert.equal(v.unresolved, true);
  });

  test('every settled refusal is NOT unresolved', () => {
    const watermarked = rec();
    flagWatermark(watermarked, 'vivino');
    for (const [what, v] of [
      ['watermarked', shouldImport(watermarked, placeholderWine(), {})],
      ['no such wine', shouldImport(rec(), undefined, {})],
      ['already photographed', shouldImport(rec(), placeholderWine({ imagePath: 'assets/img/wines/x.jpg' }), {})],
      ['flagged under cleanOnly', shouldImport(rec({ review: ['low resolution'] }), placeholderWine(), { cleanOnly: true })],
    ]) {
      assert.equal(v.import, false, what);
      assert.ok(!v.unresolved, `${what} must not read as unresolved — it is a decision`);
    }
  });

  test('a swept-clean record imports', () => {
    assert.equal(shouldImport(rec({ watermarkSwept: true }), placeholderWine(), {}).import, true);
  });

  test('a swept-and-flagged record is refused as a watermark, not as unswept', () => {
    const r = rec({ watermarkSwept: true });
    flagWatermark(r, 'vivino');
    const v = shouldImport(r, placeholderWine(), {});
    assert.equal(v.import, false);
    assert.match(v.reason, /watermark \(vivino\)/);
  });

  test('cleanOnly skips review-flagged records', () => {
    const r = rec({ review: ['low resolution (267x267)'] });
    assert.equal(shouldImport(r, placeholderWine(), { cleanOnly: true }).import, false);
    assert.match(shouldImport(r, placeholderWine(), { cleanOnly: true }).reason, /flagged for review/);
    // Without cleanOnly, a review flag alone does not block (the human said go).
    assert.equal(shouldImport(r, placeholderWine(), {}).import, true);
  });
});
