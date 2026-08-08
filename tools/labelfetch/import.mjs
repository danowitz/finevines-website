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
//   node tools/labelfetch/import.mjs                        # dry run: report what would change
//   node tools/labelfetch/import.mjs --apply                # write it
//   node tools/labelfetch/import.mjs --apply --clean-only   # only records with no review flags
//
// Whether each record may be promoted is decided by importrules.mjs (tested):
// watermarked records are refused unconditionally, and --clean-only skips
// anything still carrying a review flag so the flagged set waits for its
// human pass in review.html.
import { readFile, writeFile, access, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { shouldImport } from './importrules.mjs';
import { winesForSlug } from './importapply.mjs';
import { binPath } from './env.mjs';
import { loadAttempts, recordAttempt, saveAttempts } from './attempts.mjs';

const run = promisify(execFile);
const MANIFEST = 'data/fetched-images/manifest.json';
const IMG_DIR = 'assets/img/wines';
const WINES = 'data/wines.json';
const NORMALIZER = binPath('imgnorm');

const apply = process.argv.includes('--apply');
const cleanOnly = process.argv.includes('--clean-only');
const slugArg = process.argv.indexOf('--slug');
const onlySlug = slugArg >= 0 ? process.argv[slugArg + 1] || '' : '';
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
const attempts = await loadAttempts();

const staged = Object.values(manifest).filter((r) => r.ok && r.file && (!onlySlug || r.slug === onlySlug));
console.log(`${staged.length} verified images staged\n`);

await mkdir(IMG_DIR, { recursive: true });

let changed = 0;
let skipped = 0;
let unresolved = 0;
for (const rec of staged) {
  // A manifest entry whose staged file was later purged is stale, not
  // importable — without this check the dry-run over-reports what a real
  // import would write.
  if (!(await exists(rec.file))) {
    console.log(`  skip  ${rec.slug} — staged file missing (purged after fetch)`);
    skipped++;
    continue;
  }
  const wine = bySlug.get(rec.slug);
  const verdict = shouldImport(rec, wine, { cleanOnly });
  if (!verdict.import) {
    console.log(`  skip  ${rec.slug} — ${verdict.reason}`);
    skipped++;
    // An UNRESOLVED refusal must reopen the wine's ledger entry.
    //
    // pipeline.mjs writes the ledger before this step runs, and writes 'miss'
    // even for a wine whose image it accepted — import is what upgrades the ones
    // it actually writes to 'imported'. That works for every settled refusal, but
    // not for this one: the image was found, verified, and is refused only
    // because the watermark sweep could not reach a verdict on it. The staged
    // file does not survive the runner (data/fetched-images/ is gitignored), so
    // leaving the 'miss' in place would discard a real photograph AND bench the
    // wine for thirty days on the strength of an OpenAI 429 — and nothing in a
    // later run would ever reveal that had happened.
    //
    // 'unevaluated' carries no backoff, so the wine is due again on the next run
    // and the search is simply redone. Same principle as readLabel's
    // transport-vs-verdict split in pipeline.mjs: an absent decision is not a
    // negative one.
    const sku = rec.sku ?? wine?.sku;
    if (verdict.unresolved && sku) {
      recordAttempt(attempts, sku, 'unevaluated');
      unresolved++;
    }
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
    // The Go image pipeline removes the sibling extension when a wine flips
    // label<->photo (enrich.writeImageFile); do the same here so the stale
    // SVG placeholder doesn't ship as an orphan asset next to the new .jpg.
    try {
      await unlink(join(IMG_DIR, rec.slug + '.svg'));
    } catch {}
    const matchingWines = winesForSlug(wines, rec.slug);
    for (const matchingWine of matchingWines) {
      matchingWine.imagePath = dest.replace(/\\/g, '/');
    // 'scraped-web' is the canonical model.ImageScrapedWeb value. It must be
    // one the Go side classifies as a REAL image (model.ImageFieldSource ->
    // found): enrich preserves real images across re-enrichment, and anything
    // unrecognized would count as derived — scored wrong AND regenerated on
    // the next enrich run.
      matchingWine.imageSource = 'scraped-web';
    // Provenance is kept per wine, not just in the run manifest: months from
    // now the question "where did this picture come from" has to be answerable
    // from the catalog itself.
      matchingWine.imageSourceUrl = rec.page || rec.image || '';
      if (matchingWine.sources) {
        matchingWine.sources.image = 'found';
      // Mirror model.MetadataScore over model.ScoredFields: share of fields
      // whose value is real (salesforce/found) rather than inferred/absent.
      const scored = [
        'description', 'sommelierNotes', 'aroma', 'palate', 'finish', 'foodPairings',
        'appellation', 'country', 'color', 'abv', 'bottleSize', 'drinkWindow', 'image',
      ];
        const real = scored.filter((f) => matchingWine.sources[f] === 'salesforce' || matchingWine.sources[f] === 'found').length;
        matchingWine.metadataScore = Math.round((100 * real) / scored.length);
      }
    }
  }
  if (rec.sku ?? wine.sku) recordAttempt(attempts, rec.sku ?? wine.sku, 'imported');
  console.log(`  ${apply ? 'wrote' : 'would'} ${rec.slug}.jpg  <- ${rec.page ? new URL(rec.page).host : '?'}`);
  changed++;
}

if (apply && changed) {
  await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
  console.log(`\nwrote ${changed} images to ${IMG_DIR}/ and updated ${WINES}`);
} else if (!apply) {
  console.log(`\n${changed} would change, ${skipped} skipped. Re-run with --apply to write.`);
}
// The ledger is saved on its own condition, not on `changed`. A run that imported
// nothing but reopened a wine the sweep could not clear has a ledger change and no
// catalog change, and dropping it would leave that wine benched for thirty days —
// the exact outcome the reopening exists to prevent.
if (apply && (changed || unresolved)) {
  await saveAttempts(attempts);
}
if (unresolved) {
  console.log(
    `${unresolved} verified image(s) refused for want of a watermark verdict — ` +
      `those wines were left DUE${apply ? '' : ' (would be)'}, not recorded as misses`
  );
}
