import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateWindow, IMAGE_SEARCH_RESULT_COUNT } from '../../tools/labelfetch/candidate-window.mjs';

test('owns the bounded ten plus five candidate policy', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ index }));
  const result = candidateWindow(items);
  assert.equal(IMAGE_SEARCH_RESULT_COUNT, 15);
  assert.deepEqual(result.candidates.map(({ index }) => index), Array.from({ length: 15 }, (_, index) => index));
  assert.deepEqual(result.diagnostics, {
    initialWindowCandidates: 10,
    extensionWindowCandidates: 5,
  });
});

test('reports no extension when discovery returns ten or fewer candidates', () => {
  assert.deepEqual(candidateWindow([{ index: 0 }]).diagnostics, {
    initialWindowCandidates: 1,
    extensionWindowCandidates: 0,
  });
});
