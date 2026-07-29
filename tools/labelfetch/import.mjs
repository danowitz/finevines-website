// Promotes verified, staged bottle photographs into the catalog.
//
// This is deliberately a SEPARATE step from fetching, and dry-run by default.
// The pipeline stages images and records where each came from; a human looks at
// them; only then does anything touch data/wines.json or assets/. A single
// command that fetched two thousand images and rewrote the catalog in one pass
// would be very hard to unpick if one producer's matches turned out wrong.
//
// Each image is normalised on the way in (tools/imgnorm): the bottle is located
// and re-composed onto one 600x900 canvas at a fixed height. Fetched images are
// correct but wildly inconsistent — 500x650 through 1200x1200, bottles at every
// scale — and a grid of those jostles. Consistency is the whole point of the
// exercise, so it is applied at the moment of import rather than left to CSS.
//
//   node tools/labelfetch/import.mjs           # dry run: report what would change
//   node tools/labelfetch/import.mjs --apply   # write it
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const MANIFEST = 'data/fetched-images/manifest.json';
const IMG_DIR = 'assets/img/wines';
const WINES = 'data/wines.json';
const NORMALIZER = 'imgnorm.exe';

const apply = process.argv.includes('--apply');
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(NORMALIZER))) {
  console.error(`missing ${NORMALIZER} — build it first:\n  go build -o ${NORMALIZER} ./tools/imgnorm`);
  process.exit(2);
}
if (!(await exists(MANIFEST))) {
  console.error(`no manifest at ${MANIFEST} — run tools/labelfetch/pipeline.mjs first`);
  process.exit(2);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const wines = JSON.parse(await readFile(WINES, 'utf8'));
const bySlug = new Map(wines.map((w) => [w.slug, w]));

const staged = Object.values(manifest).filter((r) => r.ok && r.file);
console.log(`${staged.length} verified images staged\n`);

await mkdir(IMG_DIR, { recursive: true });

let changed = 0;
let skipped = 0;
for (const rec of staged) {
  const wine = bySlug.get(rec.slug);
  if (!wine) {
    console.log(`  skip  ${rec.slug} — no such wine in the catalog`);
    skipped++;
    continue;
  }
  // Never overwrite a real photograph the catalog already holds. Only the
  // generated SVG fallback is replaced; anything else is an editorial choice
  // someone made and this is not the tool to reverse it.
  if (wine.imagePath && !wine.imagePath.endsWith('.svg')) {
    console.log(`  skip  ${rec.slug} — already has a photograph (${wine.imagePath})`);
    skipped++;
    continue;
  }

  const dest = join(IMG_DIR, rec.slug + '.jpg');
  if (apply) {
    try {
      await run(NORMALIZER, ['-in', rec.file, '-out', dest]);
    } catch (e) {
      console.log(`  FAIL  ${rec.slug} — normalise: ${String(e.message).split('\n')[0]}`);
      skipped++;
      continue;
    }
    wine.imagePath = dest.replace(/\\/g, '/');
    // 'scraped-web' is the canonical model.ImageScrapedWeb value. It must be
    // one the Go side classifies as a REAL image (model.ImageFieldSource ->
    // found): enrich preserves real images across re-enrichment, and anything
    // unrecognized would count as derived — scored wrong AND regenerated on
    // the next enrich run.
    wine.imageSource = 'scraped-web';
    // Provenance is kept per wine, not just in the run manifest: months from
    // now the question "where did this picture come from" has to be answerable
    // from the catalog itself.
    wine.imageSourceUrl = rec.page || rec.image || '';
    if (wine.sources) {
      wine.sources.image = 'found';
      // Mirror model.MetadataScore over model.ScoredFields: share of fields
      // whose value is real (salesforce/found) rather than inferred/absent.
      const scored = [
        'description', 'sommelierNotes', 'aroma', 'palate', 'finish', 'foodPairings',
        'appellation', 'country', 'color', 'abv', 'bottleSize', 'drinkWindow', 'image',
      ];
      const real = scored.filter((f) => wine.sources[f] === 'salesforce' || wine.sources[f] === 'found').length;
      wine.metadataScore = Math.round((100 * real) / scored.length);
    }
  }
  console.log(`  ${apply ? 'wrote' : 'would'} ${rec.slug}.jpg  <- ${rec.page ? new URL(rec.page).host : '?'}`);
  changed++;
}

if (apply && changed) {
  await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
  console.log(`\nwrote ${changed} images to ${IMG_DIR}/ and updated ${WINES}`);
} else {
  console.log(`\n${changed} would change, ${skipped} skipped. Re-run with --apply to write.`);
}
