// Re-searches flagged staged wines to CORROBORATE them: a fresh Google image
// search per wine, each gate-surviving candidate compared against the staged
// pick with tools/imghash. A candidate from a DIFFERENT host showing the same
// bottle artwork (distance <= 14; calibrated: same artwork = 3, different
// wines = 39-67) is independent confirmation — the vision-only doubt lifts
// and the wine imports clean. Nothing is ever discarded or replaced: a search
// that finds nothing, or only disagreement, leaves the record exactly as it
// was, still flagged, still awaiting its human.
//
//   node tools/labelfetch/research.mjs               # report only
//   node tools/labelfetch/research.mjs --apply       # lift flags on corroboration
//   node tools/labelfetch/research.mjs --n 20        # bounded slice
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { blockedBy } from './sources.mjs';
import { binPath, envOrFile } from './env.mjs';

const run = promisify(execFile);
const MANIFEST = 'data/fetched-images/manifest.json';
const CONSENSUS_MAX = 14;
const apply = process.argv.includes('--apply');
const argN = process.argv.indexOf('--n');
const N = argN >= 0 ? parseInt(process.argv[argN + 1], 10) : Infinity;
const exists = (p) => access(p).then(() => true, () => false);

const CSE_KEY = await envOrFile('FINEVINES_GOOGLE_CSE_KEY');
const CSE_CX = await envOrFile('FINEVINES_GOOGLE_CSE_CX');
if (!CSE_KEY || !CSE_CX) {
  console.error('needs FINEVINES_GOOGLE_CSE_KEY / _CX');
  process.exit(2);
}

const wines = JSON.parse(await readFile('data/wines.json', 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
// Only wines still wearing a stand-in: a flagged record whose wine already
// has a real photograph is moot for the review queue and for this pass.
const byImageNeed = new Map(
  wines
    .filter((w) => w.imageSource === 'generated-label' || w.imageSource === 'generated-photo')
    .map((w) => [w.slug, w])
);

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

async function cse(q) {
  const params = new URLSearchParams({
    key: CSE_KEY, cx: CSE_CX, q, searchType: 'image', num: '8',
    imgSize: 'large', imgType: 'photo', safe: 'active',
  });
  const res = await fetch('https://www.googleapis.com/customsearch/v1?' + params, {
    headers: { Referer: 'https://finevines.grithub.app' },
  });
  if (!res.ok) throw new Error(`CSE HTTP ${res.status}`);
  return (await res.json()).items || [];
}

const flagged = Object.values(manifest).filter(
  (r) =>
    r.ok &&
    r.file &&
    (r.review || []).length &&
    byImageNeed.has(r.slug)
);
const slice = flagged.slice(0, N);
console.log(`${flagged.length} flagged staged wines; re-searching ${slice.length} (~$${(slice.length * 0.005).toFixed(2)} CSE)\n`);

let corroborated = 0;
let checked = 0;
for (const rec of slice) {
  if (!(await exists(rec.file))) continue;
  const w = byImageNeed.get(rec.slug);
  const q = [w.producer, w.name, w.vintage].filter(Boolean).join(' ') + ' wine bottle';
  let items;
  try {
    items = await cse(q);
  } catch (e) {
    console.log(`ERR  ${rec.slug} — ${e.message}`);
    if (/429|403/.test(e.message)) break;
    continue;
  }
  checked++;

  const stagedHost = hostOf(rec.page);
  for (const it of items) {
    const img = it.link || '';
    const page = it.image?.contextLink || '';
    const host = hostOf(page || img);
    if (!img || !host || host === stagedHost) continue;
    if (blockedBy(img) || blockedBy(page) || /_pb_x\d+/.test(img)) continue;

    let buf;
    try {
      const res = await fetch(img, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!res.ok) continue;
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      continue;
    }
    if (!buf || buf.length < 2000) continue;
    const tmp = rec.file + '.probe';
    await writeFile(tmp, buf);

    let dist = Infinity;
    try {
      const { stdout } = await run(binPath('imghash'), [rec.file, tmp]);
      dist = JSON.parse(stdout).pairs?.[0]?.distance ?? Infinity;
    } catch {}
    await unlink(tmp).catch(() => {});

    if (dist <= CONSENSUS_MAX) {
      corroborated++;
      console.log(`CORR ${rec.slug} — ${host} shows the same bottle (distance ${dist})`);
      if (apply) {
        rec.review = (rec.review || []).filter((f) => !f.startsWith('vision-only'));
        rec.corroboratedBy = `${host} (re-search, imghash distance ${dist})`;
      }
      break;
    }
  }
}

if (apply) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
console.log(`\n${checked} re-searched: ${corroborated} corroborated${apply ? ' (vision-only flags lifted)' : ' (dry run)'}`);
