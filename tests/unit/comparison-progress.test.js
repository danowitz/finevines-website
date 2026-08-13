import test from 'node:test';
import assert from 'node:assert/strict';
import { passedSlugs, unresolvedSlugs, withoutPassed } from '../../tools/labelfetch/comparison-progress.mjs';

test('carries prior passes forward and adds passes from the latest round', () => {
  const passed = passedSlugs({
    cumulativePassedSlugs: ['already-done'],
    rows: [
      { slug: 'new-pass', ok: true },
      { slug: 'still-due', ok: false },
    ],
  });
  assert.deepEqual([...passed].sort(), ['already-done', 'new-pass']);
});

test('continues the exact unresolved scope, including wines unreached by a prior budget', () => {
  assert.deepEqual(
    [...unresolvedSlugs({ remainingSlugs: ['still-due', 'not-reached'] })],
    ['still-due', 'not-reached'],
  );
  assert.deepEqual(
    [...unresolvedSlugs({ rows: [{ slug: 'pass', ok: true }, { slug: 'miss', ok: false }] })],
    ['miss'],
  );
});

test('removes passed wines without changing the surviving order', () => {
  const wines = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.deepEqual(withoutPassed(wines, new Set(['b'])), [wines[0], wines[2]]);
});
