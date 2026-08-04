// Reclassifies "real" catalog images that are actually flat label scans (or
// otherwise not single-bottle shots) as imageSource 'label-scan' — a stand-in
// the import pipeline replaces and the fetch pipeline hunts. The old site
// photographed labels, not bottles: 468 of its 492 images failed the shape
// gate (audit 2026-08-04), and they had been classified as protected real
// photographs since July.
//
//   node tools/labelfetch/reclassifyscans.mjs           # report
//   node tools/labelfetch/reclassifyscans.mjs --apply   # write wines.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binPath } from './env.mjs';

const run = promisify(execFile);
const apply = process.argv.includes('--apply');

const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'));
const real = wines.filter(
  (w) =>
    (w.imageSource === 'old-site' || w.imageSource === 'scraped-web' || w.imageSource === 'producer-supplied') &&
    w.imagePath &&
    !w.imagePath.endsWith('.svg')
);
console.log(`checking ${real.length} real-image wines against the shape gate`);

let reclassified = 0;
let checked = 0;
for (const w of real) {
  if (!existsSync(w.imagePath)) continue;
  checked++;
  let refused = false;
  try {
    JSON.parse((await run(binPath('imgcheck'), ['-json', '-img', w.imagePath, '-name', 'x', '-label', 'x'])).stdout);
  } catch (e) {
    try {
      const v = JSON.parse(e.stdout);
      refused = v.stage === 'shape' || v.stage === 'decode';
    } catch {
      refused = false; // verifier trouble is not evidence of a scan
    }
  }
  if (!refused) continue;
  reclassified++;
  if (apply) {
    w.imageSource = 'label-scan';
    if (w.sources) {
      w.sources.image = 'derived';
      const scored = [
        'description', 'sommelierNotes', 'aroma', 'palate', 'finish', 'foodPairings',
        'appellation', 'country', 'color', 'abv', 'bottleSize', 'drinkWindow', 'image',
      ];
      const realN = scored.filter((f) => w.sources[f] === 'salesforce' || w.sources[f] === 'found').length;
      w.metadataScore = Math.round((100 * realN) / scored.length);
    }
  }
  if (checked % 200 === 0) console.log(`  …${checked}/${real.length}`);
}

if (apply) writeFileSync('data/wines.json', JSON.stringify(wines, null, 1) + '\n');
console.log(`${checked} checked: ${reclassified} ${apply ? 'reclassified as label-scan' : 'would reclassify'}`);
