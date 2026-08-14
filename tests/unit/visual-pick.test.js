import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVisualPick, selectVisualPick } from '../../tools/labelfetch/visual-pick.mjs';

test('two matching images plus one anchor choose the cleanest high-resolution bottle', () => {
  const pick = selectVisualPick([
    { id: 'readable', anchor: true, shapeOk: true, cleanBackground: false, width: 800, height: 1200 },
    { id: 'publishable', anchor: true, shapeOk: true, cleanBackground: true, width: 600, height: 1000 },
    { id: 'small', shapeOk: true, cleanBackground: true, width: 300, height: 600 },
  ]);
  assert.equal(pick.id, 'publishable');
  assert.equal(pick.matchingImages, 3);
  assert.deepEqual(pick.anchorIds, ['readable', 'publishable']);
});

test('a repeated design without an identity anchor is not a verdict', () => {
  assert.equal(selectVisualPick([
    { id: 'one', shapeOk: true, cleanBackground: true },
    { id: 'two', shapeOk: true, cleanBackground: true },
  ]), null);
});

test('explicit contradictions cannot anchor or be selected', () => {
  const pick = selectVisualPick([
    { id: 'wrong-vintage', anchor: true, explicitConflict: true, shapeOk: true, cleanBackground: true, width: 2000, height: 3000 },
    { id: 'anchor', anchor: true, shapeOk: true, cleanBackground: false, width: 400, height: 800 },
    { id: 'clean', anchor: true, shapeOk: true, cleanBackground: true, width: 500, height: 900 },
  ]);
  assert.equal(pick.id, 'clean');
  assert.deepEqual(pick.anchorIds, ['anchor', 'clean']);
});

test('a larger unverified lookalike in an anchored group cannot be selected', () => {
  const pick = selectVisualPick([
    { id: 'anchor', anchor: true, shapeOk: true, cleanBackground: true, width: 600, height: 1200 },
    { id: 'sibling', shapeOk: true, cleanBackground: true, width: 2000, height: 5000 },
  ]);
  assert.equal(pick.id, 'anchor');
});

test('a portrait bottle beats a larger square composite', () => {
  const pick = selectVisualPick([
    { id: 'composite', anchor: true, shapeOk: true, cleanBackground: true, width: 2000, height: 2000 },
    { id: 'portrait', anchor: true, shapeOk: true, cleanBackground: true, width: 1100, height: 1422 },
  ]);
  assert.equal(pick.id, 'portrait');
});

test('a tiny readable anchor cannot transfer identity to an unverified matching bottle', () => {
  assert.equal(selectVisualPick([
    { id: 'tiny', anchor: true, shapeOk: true, cleanBackground: true, width: 191, height: 600 },
    { id: 'corroborator', shapeOk: true, cleanBackground: true, width: 800, height: 1200 },
  ]).id, 'tiny');
});

test('a tall clean importer cutout is publishable despite a narrow source width', () => {
  const pick = selectVisualPick([
    { id: 'importer', anchor: true, shapeOk: true, cleanBackground: true, width: 188, height: 700 },
    { id: 'corroborator', shapeOk: true, cleanBackground: false, width: 800, height: 1200 },
  ]);
  assert.equal(pick.id, 'importer');
});

test('a 200x300 ordinary portrait is publishable at the reduced catalog-card floor', () => {
  const pick = selectVisualPick([
    { id: 'reduced-floor', anchor: true, shapeOk: true, cleanBackground: false, width: 200, height: 300 },
    { id: 'corroborator', shapeOk: true, cleanBackground: false, width: 900, height: 1200 },
  ]);
  assert.equal(pick.id, 'reduced-floor');
});

test('an ordinary image below both reduced dimensions remains too small', () => {
  assert.equal(selectVisualPick([
    { id: 'too-small', anchor: true, shapeOk: true, cleanBackground: false, width: 199, height: 299 },
    { id: 'corroborator', shapeOk: true, cleanBackground: false, width: 900, height: 1200 },
  ]), null);
});

test('publishability diagnostics distinguish identity, shape, and resolution failures', () => {
  const result = evaluateVisualPick([
    { id: 'conflict', anchor: true, explicitConflict: true, shapeOk: true, cleanBackground: true, width: 800, height: 1200 },
    { id: 'shape', anchor: true, shapeOk: false, cleanBackground: true, width: 800, height: 1200 },
    { id: 'small', anchor: true, shapeOk: true, cleanBackground: false, width: 190, height: 600 },
  ]);
  assert.equal(result.pick, null);
  assert.deepEqual(result.diagnostics, {
    groupedImages: 3,
    identityAnchors: 2,
    explicitConflicts: 1,
    anchorShapeFailures: 1,
    anchorResolutionFailures: 1,
    publishableAnchors: 0,
  });
});
