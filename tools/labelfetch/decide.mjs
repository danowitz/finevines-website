// Applies the choices made on the review sheet.
//
// The sheet is opened straight off disk and writes nothing itself; it collects
// decisions in the browser and downloads decisions.json. This applies them.
// Two kinds:
//
//   "<path>"    use this alternate instead of what the pipeline picked
//   "__none__"  none of these is right — drop it and mark it for another look
//
// Deliberately separate from the review sheet and from the fetcher, and it
// never guesses: a wine the reviewer did not touch is left exactly as it was.
// Marking something wrong is information worth keeping, so a rejection is
// recorded on the wine rather than silently erased — a later run can see that
// a human looked at this one and refused what was found.
//
//   node tools/labelfetch/decide.mjs                    # report
//   node tools/labelfetch/decide.mjs --apply            # apply
//   node tools/labelfetch/decide.mjs --file other.json  # a different download
import { readFile, writeFile, rename, unlink, access } from 'node:fs/promises';
import { join, basename } from 'node:path';

const MANIFEST = 'data/fetched-images/manifest.json';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fileArg = args.indexOf('--file');
// Browsers drop it in Downloads; accept either without being told.
const CANDIDATES = fileArg >= 0
  ? [args[fileArg + 1]]
  : ['decisions.json', join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'decisions.json')];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

let decisionsPath = '';
for (const c of CANDIDATES) if (await exists(c)) { decisionsPath = c; break; }
if (!decisionsPath) {
  console.error('no decisions.json found. Looked in:\n  ' + CANDIDATES.join('\n  '));
  console.error('\nOpen out-bottle/review.html, make your choices, then press "Download decisions".');
  process.exit(2);
}

const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const slugs = Object.keys(decisions);

if (!slugs.length) {
  console.log('decisions.json is empty — nothing was changed on the sheet.');
  process.exit(0);
}

let swapped = 0, rejected = 0, unknown = 0;
for (const slug of slugs) {
  const rec = manifest[slug];
  const choice = decisions[slug];
  if (!rec) { unknown++; console.log(`  ?      ${slug} — not in the manifest`); continue; }

  if (choice === '__none__') {
    rejected++;
    console.log(`  WRONG  ${rec.name}`);
    if (apply) {
      if (rec.file) { try { await unlink(rec.file); } catch {} }
      rec.ok = false;
      delete rec.file;
      // Recorded, not erased: a later run should know a human refused what was
      // found here rather than treating it as never attempted.
      rec.humanRejected = true;
      rec.review = ['rejected by review — none of the candidates was this wine'];
    }
    continue;
  }

  const alt = (rec.alternates || []).find((a) => a.file === choice);
  if (!alt) { unknown++; console.log(`  ?      ${slug} — chose ${basename(choice)}, which is not one of its candidates`); continue; }

  swapped++;
  console.log(`  SWAP   ${rec.name}\n            -> ${basename(alt.file)} from ${alt.page ? new URL(alt.page).host : '?'}`);
  if (apply) {
    const dest = join('data/fetched-images', slug + '.png');
    try { await unlink(dest); } catch {}
    await rename(alt.file, dest);
    rec.ok = true;
    rec.file = dest;
    rec.page = alt.page;
    rec.label = alt.label;
    rec.size = alt.size;
    rec.verifiedBy = 'human review';
    // A person looked at the bottle and the name together. That is stronger
    // evidence than either verifier produces, so the doubts they overrule go.
    rec.review = [];
    rec.alternates = (rec.alternates || []).filter((a) => a.file !== choice);
  }
}

if (apply) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));

console.log(`\n${slugs.length} decisions: ${swapped} swapped, ${rejected} marked wrong${unknown ? `, ${unknown} unrecognised` : ''}`);
if (!apply) {
  console.log('\nnothing written — re-run with --apply');
} else {
  console.log('\napplied. Re-run the sheet to see it: node tools/labelfetch/review.mjs');
  if (rejected) {
    console.log(`${rejected} wines are now marked for another look; they will be retried on the next`);
    console.log('pipeline run, which skips only wines that already have an accepted image.');
  }
}
