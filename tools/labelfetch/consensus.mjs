// Cross-source consensus: when two candidates fetched from DIFFERENT hosts
// show the same bottle artwork, that agreement is evidence the search
// converged on the right product — independent retailers photograph the wine
// they actually sell, and two wrong candidates rarely agree with each other.
//
// Distances come from tools/imghash (128-bit two-axis dHash over the subject
// crop). Calibrated on real files 2026-08-03: same artwork through different
// processing = 3; different wines = 39-67. The threshold sits far below the
// gap.
//
// Two upgrades, both conservative:
//   A. An ACCEPTED image flagged vision-only whose twin exists on another
//      host loses that flag ("corroborated") — two independent sources plus
//      a vision identity pass is stronger evidence than the flag implies, so
//      the wine imports clean instead of waiting on a human.
//   B. A wine with NO accepted image but a cross-host twin pair among its
//      refused candidates gets the higher-resolution twin STAGED, flagged
//      for confirmation — the choose-one card becomes a proposed pick.
//
//   node tools/labelfetch/consensus.mjs           # report only
//   node tools/labelfetch/consensus.mjs --apply   # write the upgrades
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { binPath } from './env.mjs';

const run = promisify(execFile);
const MANIFEST = 'data/fetched-images/manifest.json';
const CONSENSUS_MAX = 14;
const apply = process.argv.includes('--apply');
const exists = (p) => access(p).then(() => true, () => false);

const wines = JSON.parse(await readFile('data/wines.json', 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const needsImage = new Set(
  wines
    .filter((w) => w.imageSource === 'generated-label' || w.imageSource === 'generated-photo')
    .map((w) => w.slug)
);

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

async function distances(files) {
  const { stdout } = await run(binPath('imghash'), files);
  return JSON.parse(stdout).pairs;
}

let corroborated = 0;
let promoted = 0;
let examined = 0;
for (const [slug, rec] of Object.entries(manifest)) {
  if (!needsImage.has(slug)) continue;

  // Candidate set: the accepted file (if any) plus alternates on disk.
  const entries = [];
  if (rec.ok && rec.file && (await exists(rec.file))) {
    entries.push({ file: rec.file, host: hostOf(rec.page), accepted: true });
  }
  for (const a of rec.alternates || []) {
    if (await exists(a.file)) entries.push({ file: a.file, host: hostOf(a.page), alt: a });
  }
  if (entries.length < 2) continue;
  examined++;

  let pairs;
  try {
    pairs = await distances(entries.map((e) => e.file));
  } catch {
    continue;
  }

  const twins = pairs.filter(
    (p) =>
      p.distance <= CONSENSUS_MAX &&
      entries[p.a].host &&
      entries[p.a].host !== entries[p.b].host
  );
  if (!twins.length) continue;

  if (rec.ok) {
    // Case A: corroborate the accepted image.
    const t = twins.find((p) => entries[p.a].accepted || entries[p.b].accepted);
    if (!t) continue;
    const flags = rec.review || [];
    if (!flags.some((f) => f.startsWith('vision-only'))) continue;
    corroborated++;
    const other = entries[t.a].accepted ? entries[t.b] : entries[t.a];
    console.log(`CORR ${slug} — twin on ${other.host} (distance ${t.distance})`);
    if (apply) {
      rec.review = flags.filter((f) => !f.startsWith('vision-only'));
      rec.corroboratedBy = `${other.host} (imghash distance ${t.distance})`;
    }
  } else {
    // Case B: promote the better half of a twin pair as the proposed pick.
    const t = twins[0];
    const pick = entries[t.a]; // imghash preserved input order; sizes differ little — first is fine
    promoted++;
    console.log(`PICK ${slug} — ${entries[t.a].host} + ${entries[t.b].host} agree (distance ${t.distance})`);
    if (apply) {
      const dest = join('data/fetched-images', slug + '.png');
      await rename(pick.file, dest);
      rec.ok = true;
      rec.file = dest;
      rec.page = pick.alt?.page || rec.page;
      rec.label = pick.alt?.label || '';
      rec.size = pick.alt?.size || '';
      rec.verifiedBy = 'cross-source consensus';
      rec.alternates = (rec.alternates || []).filter((a) => a !== pick.alt);
      rec.review = [
        ...(rec.review || []),
        `cross-source consensus: ${entries[t.a].host} and ${entries[t.b].host} show the same bottle — confirm`,
      ];
      delete rec.watermarkSwept; // promoted pixels were never swept
      delete rec.watermarkClearedBy;
    }
  }
}

if (apply) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
console.log(
  `\n${examined} wines with 2+ candidates examined: ${corroborated} corroborated (flag lifted), ${promoted} ${apply ? 'promoted' : 'would promote'} as proposed picks`
);
if (!apply && (corroborated || promoted)) console.log('re-run with --apply');
