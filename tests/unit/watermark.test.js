import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, flagWatermark, isWatermarked } from '../../tools/labelfetch/watermark.mjs';

describe('watermark sweep verdict parsing', () => {
  test('accepts a clean JSON verdict', () => {
    assert.deepEqual(parseVerdict('{"watermark":true,"mark":"vivino"}'), {
      watermark: true,
      mark: 'vivino',
    });
    assert.deepEqual(parseVerdict('{"watermark":false,"mark":""}'), {
      watermark: false,
      mark: '',
    });
  });

  test('tolerates a ```json fence around the verdict', () => {
    assert.deepEqual(parseVerdict('```json\n{"watermark":true,"mark":"getty"}\n```'), {
      watermark: true,
      mark: 'getty',
    });
  });

  test('returns null for unparseable output rather than guessing', () => {
    assert.equal(parseVerdict('I could not find a watermark.'), null);
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict(null), null);
  });

  test('a watermark verdict with no mark text still counts', () => {
    // The model may be sure a mark exists without reading it (Vivino's is
    // semi-transparent). Certainty of presence matters; the text is a bonus.
    assert.deepEqual(parseVerdict('{"watermark":true}'), { watermark: true, mark: '' });
  });
});

describe('flagging a manifest record', () => {
  test('flagWatermark records the mark and adds one review flag', () => {
    const rec = { ok: true, file: 'x.png', review: ['low resolution (267x267)'] };
    flagWatermark(rec, 'vivino');
    assert.equal(rec.watermark, 'vivino');
    assert.deepEqual(rec.review, [
      'low resolution (267x267)',
      'watermark (vivino) — never import',
    ]);
    // Flagging twice must not duplicate the review entry.
    flagWatermark(rec, 'vivino');
    assert.equal(rec.review.filter((r) => r.startsWith('watermark')).length, 1);
  });

  test('flagWatermark works on a record with no review array', () => {
    const rec = { ok: true, file: 'x.png' };
    flagWatermark(rec, '');
    assert.equal(rec.watermark, 'unknown mark');
    assert.deepEqual(rec.review, ['watermark (unknown mark) — never import']);
  });

  test('isWatermarked is true once flagged, false before', () => {
    const rec = { ok: true, file: 'x.png' };
    assert.equal(isWatermarked(rec), false);
    flagWatermark(rec, 'vivino');
    assert.equal(isWatermarked(rec), true);
  });
});
