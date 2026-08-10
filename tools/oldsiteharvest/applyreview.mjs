// Acts on the decisions a human made on reports/oldsite-review.html:
// data/oldsite-mirror/manifest.json photographs the reviewer chose over what
// is currently live get copied into the catalog; everything else is left
// alone.
//
// Deliberately a separate step from the review page itself, and dry-run by
// default — same shape as tools/labelfetch/import.mjs, for the same reason: a
// single command that read a JSON file and rewrote data/wines.json in one
// pass would be very hard to unpick if the export turned out wrong.
//
//   node tools/oldsiteharvest/applyreview.mjs decisions.json            # dry run
//   node tools/oldsiteharvest/applyreview.mjs decisions.json --apply    # write it
//
// Each image is normalised on the way in with the same tools/imgnorm binary
// import.mjs uses, for the same reason: mirrored photographs arrive at
// whatever size the old site served them, and a grid of those jostles next to
// the rest of the catalog, which is already normalised to one canvas.
//
// Which decision requires a write is decided by planActions
// (applyreviewplan.mjs, tested) — kept separate so the decision logic can be
// tested without a filesystem or a real imgnorm binary.
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { planActions } from './applyreviewplan.mjs';
import { binPath } from '../labelfetch/env.mjs';

const run = promisify(execFile);

const WINES = 'data/wines.json';
const MIRROR_DIR = 'data/oldsite-mirror';
const IMG_DIR = 'assets/img/wines';
const NORMALIZER = binPath('imgnorm');

const apply = process.argv.includes('--apply');
const decisionsPath = process.argv.slice(2).find((a) => !a.startsWith('--'));

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

if (!decisionsPath) {
  console.error('usage: node tools/oldsiteharvest/applyreview.mjs <decisions.json> [--apply]');
  process.exit(2);
}
if (!(await exists(decisionsPath))) {
  console.error(`no decisions file at ${decisionsPath}`);
  process.exit(2);
}

const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
const wines = JSON.parse(await readFile(WINES, 'utf8'));
const plans = planActions(decisions, wines);

const toCopy = plans.filter((p) => p.action === 'copy');
console.log(`${decisions.length} decision(s) — ${toCopy.length} would upgrade the catalog image, ${plans.length - toCopy.length} change nothing\n`);

if (apply && toCopy.length && !(await exists(NORMALIZER))) {
  console.error(`missing ${NORMALIZER} — build it first:\n  go build -o ${NORMALIZER} ./tools/imgnorm`);
  process.exit(2);
}

let changed = 0;
let skipped = 0;
for (const plan of plans) {
  if (plan.action !== 'copy') {
    console.log(`  skip  ${plan.sku} — ${plan.reason}`);
    skipped++;
    continue;
  }

  const src = join(MIRROR_DIR, plan.sourceFile);
  if (!(await exists(src))) {
    console.log(`  skip  ${plan.sku} — mirrored file missing: ${src}`);
    skipped++;
    continue;
  }

  if (apply) {
    await mkdir(IMG_DIR, { recursive: true });
    try {
      await run(NORMALIZER, ['-in', src, '-out', plan.destPath]);
    } catch (e) {
      console.log(`  FAIL  ${plan.sku} — normalise: ${String(e.message).split('\n')[0]}`);
      skipped++;
      continue;
    }
    plan.wine.imagePath = plan.destPath.replace(/\\/g, '/');
    // 'old-site' is the value already in use for photographs harvested from
    // finevines.com (tools/oldsiteharvest/harvest.mjs, model.ImageOldSite) —
    // distinct provenance from 'scraped-web' (found via search) even though
    // both are real photographs to model.ImageFieldSource.
    plan.wine.imageSource = 'old-site';
    plan.wine.imageSourceUrl = plan.sourceUrl;
    if (plan.wine.sources) {
      plan.wine.sources.image = 'found';
    }
  }
  console.log(`  ${apply ? 'wrote' : 'would'} ${plan.destPath}  <- ${plan.sourceFile}`);
  changed++;
}

if (apply && changed) {
  await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
  console.log(`\nwrote ${changed} image(s) to ${IMG_DIR}/ and updated ${WINES}`);
} else {
  console.log(`\n${changed} would change, ${skipped} unchanged. ${apply ? '' : 'Re-run with --apply to write.'}`);
}
