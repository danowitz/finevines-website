// Hit-rate probe for recovering real bottle photographs.
//
// The catalog has 2,187 wines with no real image, currently falling back to a
// generated vector label. The working assumption had been that those wines'
// photographs did not exist. They do — spot checks found coverage for both
// first-growth Bordeaux and a 1,500-case custom-crush Napa label. What failed
// was RETRIEVAL: a plain HTTP fetch gets HTTP 403 from the sites that hold
// them, while the same URL in a real browser returns 200 and the image.
//
// So this drives actual Chrome (the same puppeteer-core harness the browser
// tests use) and reports how often a usable bottle shot can be found. It
// measures; it does not download. Establish the hit rate first, then decide
// whether a 2,187-wine run is worth building.
//
//   node tools/labelfetch/fetch.mjs --n 20
//   node tools/labelfetch/fetch.mjs --n 20 --json out.json
import { readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../tests/helpers/browser.js';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const N = parseInt(opt('n', '20'), 10);
const JSON_OUT = opt('json', '');

// A bottle shot is tall and reasonably large. Everything else on a wine page —
// logos, rating badges, flag icons, reviewer avatars — fails one or the other.
const MIN_HEIGHT = 260;
const MIN_ASPECT = 1.4;

// Vivino resizes on demand through the filename. The page serves x600 by
// default; x960 is the largest that resolves (verified by probing the pattern),
// and at 267x960 that is sharper than most of the label scans already in the
// catalog.
function upscale(url) {
  return url.replace(/_pb_x\d+\.png/, '_pb_x960.png');
}

// Salesforce names carry trade shorthand that hurts a search: pack/size
// suffixes, "Ch"/"Dom" abbreviations, and stray punctuation.
function query(w) {
  let name = (w.name || '')
    .replace(/\b\d+\s*(ml|l)\b/gi, '')
    .replace(/\b(6|12|24)\s*pk\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = [w.producer, name, w.vintage].filter((s) => s && String(s).trim());
  // Producer is often already the first words of name; do not repeat it.
  if (w.producer && name.toLowerCase().startsWith(w.producer.toLowerCase())) {
    return [name, w.vintage].filter(Boolean).join(' ');
  }
  return parts.join(' ');
}

const wines = JSON.parse(await readFile('data/wines.json', 'utf8')).filter(
  (w) => w.slug && w.name && (w.imagePath || '').endsWith('.svg')
);
wines.sort((a, b) => a.slug.localeCompare(b.slug));

// Sample evenly across the whole catalog rather than taking a prefix — the
// alphabet clusters producers, and a prefix would measure one importer's book.
const sample = Array.from({ length: N }, (_, i) =>
  wines[Math.floor((i + 0.5) * (wines.length / N))]
).filter(Boolean);

const browser = await openBrowser();
const page = await browser.newPage();
await page.setUserAgent(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
);

const results = [];
for (const w of sample) {
  const q = query(w);
  const url = 'https://www.vivino.com/search/wines?q=' + encodeURIComponent(q);
  let hit = null;
  let status = 0;
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = r ? r.status() : 0;
    await new Promise((s) => setTimeout(s, 2000)); // results hydrate client-side
    const imgs = await page.$$eval(
      'img',
      (els, minH, minA) =>
        els
          .map((e) => ({ src: e.currentSrc || e.src, w: e.naturalWidth, h: e.naturalHeight }))
          .filter((i) => i.src && i.h >= minH && i.w > 0 && i.h / i.w >= minA),
      MIN_HEIGHT,
      MIN_ASPECT
    );
    if (imgs.length) hit = { ...imgs[0], src: upscale(imgs[0].src) };
  } catch (e) {
    status = -1;
  }

  results.push({ slug: w.slug, producer: w.producer || '', query: q, status, hit });
  console.log(
    `${hit ? 'HIT ' : 'miss'}  [${String(status).padStart(3)}]  ${q.slice(0, 62).padEnd(62)}` +
      (hit ? `  ${hit.w}x${hit.h}` : '')
  );

  // Deliberate pacing. This is someone else's server and the eventual run is
  // 2,187 wines; hammering it is both rude and the fastest way to get blocked.
  await new Promise((s) => setTimeout(s, 1500));
}

await browser.close();

const hits = results.filter((r) => r.hit).length;
console.log(`\n${hits}/${results.length} found  (${Math.round((100 * hits) / results.length)}%)`);
const sizes = results.filter((r) => r.hit).map((r) => r.hit.h);
if (sizes.length) {
  sizes.sort((a, b) => a - b);
  console.log(`heights: min ${sizes[0]}  median ${sizes[Math.floor(sizes.length / 2)]}  max ${sizes[sizes.length - 1]}`);
}
if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify(results, null, 1));
  console.log('wrote', JSON_OUT);
}
