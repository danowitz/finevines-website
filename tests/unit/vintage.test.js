import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vintageConflict } from '../../tools/labelfetch/vintage.mjs';

test('a contradictory visible product vintage is a hard conflict', () => {
  assert.deepEqual(vintageConflict('2018', '2009'), { expected: '2018', visible: '2009' });
});

test('matching or absent vintages are not conflicts', () => {
  assert.equal(vintageConflict('2022', '2022'), null);
  assert.equal(vintageConflict('2022', ''), null);
  assert.equal(vintageConflict('', '2022'), null);
});
