import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'));

test('catalog image policy', async (t) => {
  await t.test('contains no invented bottle photos', () => {
    const legacy = wines.filter((wine) => wine.imageSource === 'generated-photo');
    assert.deepEqual(legacy.map((wine) => wine.slug), []);
  });

  await t.test('every claimed photograph or label scan exists', () => {
    const missing = wines
      .filter((wine) => wine.imageSource !== 'generated-label')
      .filter((wine) => !wine.imagePath || !existsSync(wine.imagePath))
      .map((wine) => `${wine.slug}: ${wine.imagePath || '(empty)'}`);
    assert.deepEqual(missing, []);
  });

  await t.test('every fallback uses its slugged neutral SVG path', () => {
    const invalid = wines
      .filter((wine) => wine.imageSource === 'generated-label')
      .filter((wine) => wine.imagePath !== `assets/img/wines/${wine.slug}.svg`)
      .map((wine) => `${wine.slug}: ${wine.imagePath}`);
    assert.deepEqual(invalid, []);
  });
});
