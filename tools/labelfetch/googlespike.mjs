// SPIKE: measures whether Google's Custom Search JSON API can find bottle
// images for wines the DuckDuckGo discovery pass failed on. Reads a sample of
// failed manifest entries, asks CSE for image results, applies the same
// source gate as the pipeline, downloads the best candidates and runs the
// local verifier. Writes only to out-bottle/google-spike/ — no manifest, no
// catalog. If the yield justifies it, CSE becomes a second discovery source
// inside pipeline.mjs and this file is deleted.
//
//   node tools/labelfetch/googlespike.mjs [--n 20]
//
// Needs FINEVINES_GOOGLE_CSE_KEY / _CX in .env (GRIT-Hub's test key; it is
// referer-restricted, so requests send a grithub.app Referer). Cost: ~$5 per
// 1,000 queries past the free 100/day.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { blockedBy } from './sources.mjs';

const run = promisify(execFile);
const N = parseInt(process.argv[process.argv.indexOf('--n') + 1] || '20', 10) || 20;
const OUT = 'out-bottle/google-spike';

const env = await readFile('.env', 'utf8');
const KEY = env.match(/^FINEVINES_GOOGLE_CSE_KEY=(.*)$/m)?.[1]?.trim();
const CX = env.match(/^FINEVINES_GOOGLE_CSE_CX=(.*)$/m)?.[1]?.trim();
if (!KEY || !CX) {
  console.error('needs FINEVINES_GOOGLE_CSE_KEY and FINEVINES_GOOGLE_CSE_CX in .env');
  process.exit(2);
}

const manifest = JSON.parse(await readFile('data/fetched-images/manifest.json', 'utf8'));
const wines = new Map(JSON.parse(await readFile('data/wines.json', 'utf8')).map((w) => [w.slug, w]));

// The population of interest: wines the DDG pass tried and failed, whose
// catalog row still needs an image. Spread the sample evenly rather than
// taking the first N (all one alphabetic neighborhood says little).
const failed = Object.values(manifest)
  .filter((r) => !r.ok)
  .filter((r) => {
    const w = wines.get(r.slug);
    return w && (!w.imagePath || w.imagePath.endsWith('.svg'));
  });
const sample = Array.from({ length: N }, (_, i) => failed[Math.floor((i + 0.5) * (failed.length / N))]).filter(Boolean);

console.log(`google-spike: ${failed.length} failed wines still needing an image; sampling ${sample.length}\n`);
await mkdir(OUT, { recursive: true });

async function cse(q) {
  const params = new URLSearchParams({
    key: KEY, cx: CX, q, searchType: 'image', num: '8',
    imgSize: 'large', imgType: 'photo', safe: 'active',
  });
  const res = await fetch('https://www.googleapis.com/customsearch/v1?' + params, {
    headers: { Referer: 'https://finevines.grithub.app' },
  });
  if (!res.ok) throw new Error(`CSE HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).items || [];
}

const tally = { accepted: 0, visionMaybe: 0, nothing: 0, queriesEmpty: 0 };
const rows = [];
for (const r of sample) {
  const w = wines.get(r.slug);
  const q = [w.producer, w.name, w.vintage].filter(Boolean).join(' ') + ' wine bottle';
  let items;
  try {
    items = await cse(q);
  } catch (e) {
    console.log(`ERR  ${r.slug} — ${e.message}`);
    continue;
  }
  if (!items.length) {
    tally.queriesEmpty++;
    console.log(`NONE ${r.slug} — CSE returned no items`);
    continue;
  }

  let verdictLine = null;
  for (const it of items) {
    const imgURL = it.link || '';
    const pageURL = it.image?.contextLink || '';
    if (blockedBy(imgURL) || blockedBy(pageURL)) continue;
    // Vivino-pattern filename re-hosted elsewhere — seen live in this exact
    // spike's probe; the host gate cannot catch it, the filename can.
    if (/_pb_x\d+/.test(imgURL)) continue;

    let buf;
    try {
      const res = await fetch(imgURL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!res.ok) continue;
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      continue;
    }
    const file = join(OUT, r.slug + '.img');
    await writeFile(file, buf);

    let v;
    try {
      v = JSON.parse((await run('imgcheck.exe', ['-json', '-img', file, '-name', w.name, '-producer', w.producer || ''])).stdout);
    } catch (e) {
      try { v = JSON.parse(e.stdout); } catch { continue; } // undecodable etc.
    }
    if (v.accept) {
      verdictLine = `OK   ${r.slug} — ${new URL(pageURL || imgURL).host}`;
      tally.accepted++;
      break;
    }
    if (v.stage === 'label') {
      // Local OCR refused on the label — the class of refusal the pipeline's
      // vision fallback overturns 35% of the time. Count separately.
      verdictLine = `OK?  ${r.slug} — ${new URL(pageURL || imgURL).host} (local: ${v.reason}; vision would decide)`;
      tally.visionMaybe++;
      break;
    }
  }
  if (!verdictLine) {
    tally.nothing++;
    verdictLine = `MISS ${r.slug} — ${items.length} items, none survived gates`;
  }
  console.log(verdictLine);
  rows.push(verdictLine);
}

console.log(`\naccepted locally: ${tally.accepted}/${sample.length}`);
console.log(`plausible, needs vision: ${tally.visionMaybe}/${sample.length}`);
console.log(`nothing usable: ${tally.nothing}/${sample.length}  (CSE empty: ${tally.queriesEmpty})`);
console.log(`\nDDG found nothing for ALL of these — every accept above is net-new coverage.`);
