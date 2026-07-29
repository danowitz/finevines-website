// Fetches real bottle photographs for the catalog, into a STAGING directory.
//
// Deliberately does not touch data/wines.json or assets/img/wines/. It writes
// images to data/fetched-images/ and a manifest beside them, so the results can
// be reviewed — and bad matches thrown away — before anything reaches the site.
// A 2,600-image run that silently rewrote the catalog would be very hard to
// unpick if the match quality turned out to be poor for some producer.
//
// Resumable: an image already staged is skipped, so the run can be stopped and
// restarted without re-hitting the source for work already done.
//
//   node tools/labelfetch/download.mjs --n 50            # try 50
//   node tools/labelfetch/download.mjs --all             # the whole catalog
//   node tools/labelfetch/download.mjs --all --missing   # only wines lacking a photo
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from '../../tests/helpers/browser.js';

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};

const OUT_DIR = 'data/fetched-images';
const MANIFEST = join(OUT_DIR, 'manifest.json');
const PACING_MS = 1500;
const MIN_HEIGHT = 260;
const MIN_ASPECT = 1.4;

// Vivino is wine-only, so a spirit will never resolve there. Skipping them
// keeps the miss rate honest rather than burying 46 structural failures in it.
const SPIRIT =
  /\b(whisk|bourbon|rye|vodka|gin|rum|tequila|mezcal|cognac|armagnac|brandy|liqueur|amaro|vermouth|sake|cider|absinthe|grappa|scotch)\b/i;

function query(w) {
  const name = (w.name || '')
    .replace(/\b\d+\s*(ml|l)\b/gi, '')
    .replace(/\*+/g, '')
    .replace(/\b\d+\/\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (w.producer && name.toLowerCase().startsWith(w.producer.toLowerCase())) {
    return [name, w.vintage].filter(Boolean).join(' ');
  }
  return [w.producer, name, w.vintage].filter((s) => s && String(s).trim()).join(' ');
}

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

let wines = JSON.parse(await readFile('data/wines.json', 'utf8')).filter((w) => w.slug && w.name);
if (has('missing')) wines = wines.filter((w) => (w.imagePath || '').endsWith('.svg'));
wines = wines.filter((w) => !SPIRIT.test(w.name));
wines.sort((a, b) => a.slug.localeCompare(b.slug));
if (!has('all')) {
  const n = parseInt(opt('n', '50'), 10);
  wines = Array.from({ length: n }, (_, i) => wines[Math.floor((i + 0.5) * (wines.length / n))]).filter(Boolean);
}

await mkdir(OUT_DIR, { recursive: true });
const manifest = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};

const browser = await openBrowser();
const page = await browser.newPage();
await page.setUserAgent(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
);

let done = 0;
let hits = 0;
let skipped = 0;

for (const w of wines) {
  const dest = join(OUT_DIR, w.slug + '.png');
  if (manifest[w.slug] && (await exists(dest))) {
    skipped++;
    continue;
  }
  done++;
  const q = query(w);
  let rec = { slug: w.slug, query: q, ok: false };

  try {
    await page.goto('https://www.vivino.com/search/wines?q=' + encodeURIComponent(q), {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await new Promise((s) => setTimeout(s, 2000));
    const found = await page.$$eval(
      'img',
      (els, minH, minA) =>
        els
          .map((e) => ({ src: e.currentSrc || e.src, w: e.naturalWidth, h: e.naturalHeight }))
          .filter((i) => i.src && i.h >= minH && i.w > 0 && i.h / i.w >= minA)[0] || null,
      MIN_HEIGHT,
      MIN_ASPECT
    );

    if (found) {
      // x960 is the largest variant that resolves (verified by probing the
      // pattern); the page itself only ever renders x300 thumbnails.
      const url = found.src.replace(/_pb_x\d+\.png/, '_pb_x960.png');
      const buf = await page.evaluate(async (u) => {
        const r = await fetch(u);
        if (!r.ok) return null;
        const b = new Uint8Array(await r.arrayBuffer());
        return Array.from(b);
      }, url);
      if (buf && buf.length > 2000) {
        await writeFile(dest, Buffer.from(buf));
        rec = { slug: w.slug, query: q, ok: true, url, bytes: buf.length, file: dest };
        hits++;
      }
    }
  } catch (e) {
    rec.error = String(e.message || e).split('\n')[0];
  }

  manifest[w.slug] = rec;
  console.log(`${rec.ok ? 'HIT ' : 'miss'}  ${String(done).padStart(4)}  ${q.slice(0, 66)}`);

  // Write the manifest as we go so a killed run keeps its progress.
  if (done % 20 === 0) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
  await new Promise((s) => setTimeout(s, PACING_MS));
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
await browser.close();
console.log(`\nattempted ${done}, found ${hits} (${done ? Math.round((100 * hits) / done) : 0}%), skipped ${skipped} already staged`);
console.log(`images -> ${OUT_DIR}/   manifest -> ${MANIFEST}`);
