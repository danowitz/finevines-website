// Re-checks every staged image against the CURRENT verifier.
//
// Needed whenever the matching rule changes, which it did after an external
// review found it accepting a different producer's bottle: 75 of 253 staged
// images turned out wrong. Re-verifying is far cheaper than re-fetching, and
// keeps the vision-verified ones, whose evidence is independent of the local
// rule.
//
//   node tools/labelfetch/reverify.mjs           # report only
//   node tools/labelfetch/reverify.mjs --apply   # drop the failures
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const M = 'data/fetched-images/manifest.json';
const apply = process.argv.includes('--apply');

const man = JSON.parse(await readFile(M, 'utf8'));
const staged = Object.values(man).filter((r) => r.ok && r.file);

let pass = 0, visionHeld = 0, drop = 0;
for (const r of staged) {
  let accept = false;
  try {
    accept = JSON.parse((await run('imgcheck.exe', ['-json', '-img', r.file, '-name', r.name])).stdout).accept;
  } catch (e) {
    try { accept = JSON.parse(e.stdout).accept; } catch {}
  }
  if (accept) { pass++; continue; }
  // Locally refused now. If a vision model accepted it, that evidence is
  // independent of the rule that changed, so it stands — flagged.
  if (r.verifiedBy) {
    visionHeld++;
    if (apply && !(r.review || []).some((x) => x.startsWith('vision-only'))) {
      r.review = [...(r.review || []), 'vision-only (local rule refuses it)'];
    }
    continue;
  }
  drop++;
  if (apply) {
    r.ok = false;
    r.review = ['dropped: accepted by a superseded matcher'];
    try { await unlink(r.file); } catch {}
    delete r.file;
  }
}
if (apply) await writeFile(M, JSON.stringify(man, null, 1));
console.log(`${staged.length} staged images re-verified`);
console.log(`  still pass locally      ${pass}`);
console.log(`  held on vision evidence ${visionHeld}`);
console.log(`  ${apply ? 'DROPPED' : 'would drop'}                 ${drop}`);
if (!apply && drop) console.log('\nre-run with --apply to remove them');
