// The complete path from a catalog row to a verified bottle photograph.
//
//   discover -> product page -> image -> source gate -> verify -> stage
//
// Nothing here writes to data/wines.json or assets/. Images land in a staging
// directory with a manifest recording exactly where each came from, so a run
// can be reviewed — and bad matches deleted — before anything reaches the site.
// tools/labelfetch/import.mjs is the separate, deliberate step that promotes
// staged images into the catalog.
//
// Why each stage exists, in the order the failures were found:
//
//  - DISCOVER via a general search engine rather than one wine site. Site
//    search pages serve small thumbnails and lazy-load unpredictably; six of
//    eight yielded nothing usable. General search returns PRODUCT pages, and
//    frequently the producer's own domain (anne-gros.com, fx-pichler.at),
//    which is the best possible source: authoritative, unbranded, and correct
//    by construction.
//
//  - SOURCE GATE because the first source that worked, Vivino, watermarks
//    every file. See sources.mjs.
//
//  - VERIFY against the image, not the page. Search ranks by relevance and
//    never returns nothing: asking for FX Pichler's Kellerberg returns Max
//    Ferd. Richter Mosels on pages whose text is entirely consistent, because
//    they genuinely are Richter listings. Taking the top hit on trust put the
//    wrong producer's bottle on 2 of 6 wines. Only the label settles it.
//
// Usage:
//   node tools/labelfetch/pipeline.mjs --n 20            # sample the catalog
//   node tools/labelfetch/pipeline.mjs --all --missing   # every wine lacking a photo
//   node tools/labelfetch/pipeline.mjs --slug some-wine  # one wine, verbose
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { openBrowser } from '../../tests/helpers/browser.js';
import { blockedBy } from './sources.mjs';
import { tokens, normalize } from './match.mjs';

const run = promisify(execFile);

const OUT_DIR = 'data/fetched-images';
const MANIFEST = join(OUT_DIR, 'manifest.json');
const VERIFIER = 'imgcheck.exe';

// How many search results to try before giving up on a wine. Three is a
// deliberate ceiling: past that the results stop being the wine asked for and
// start being other wines from the same appellation, which is exactly the
// substitution the verifier exists to reject — so the extra fetches cost time
// and find nothing.
const MAX_CANDIDATES = 5;
const PACING_MS = 1200;
const NAV_TIMEOUT = 30000;

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const VERBOSE = has('verbose') || opt('slug', '') !== '';
// Vision fallback is opt-in: the pipeline runs without an API key, just at a
// lower recovery rate.
const USE_VISION = has('vision');
const VISION_MODEL = opt('vision-model', 'gpt-4.1-nano');
let VISION_KEY = '';
let visionCalls = 0;
let visionRecovered = 0;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Vivino is wine-only, and a spirit will never resolve there or anywhere a
// wine search looks. Excluded so the miss rate reflects wines, not 46
// structural failures.
const SPIRIT =
  /\b(whisk|bourbon|rye|vodka|gin|rum|tequila|mezcal|cognac|armagnac|brandy|liqueur|amaro|vermouth|sake|cider|absinthe|grappa|scotch)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// searchQuery strips the trade shorthand Salesforce carries — pack counts,
// bottle sizes, asterisks — which a search engine treats as literal terms.
function searchQuery(w) {
  const name = (w.name || '')
    .replace(/\*+/g, '')
    .replace(/\b\d+\/\d+\b/g, '')
    .replace(/\b\d+\s*(ml|l)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base =
    w.producer && !name.toLowerCase().startsWith(w.producer.toLowerCase())
      ? `${w.producer} ${name}`
      : name;
  return `${base} ${w.vintage || ''} wine bottle`.replace(/\s+/g, ' ').trim();
}

// catalogName is what the label is checked against: the wine as the catalog
// holds it, without the search scaffolding.
function catalogName(w) {
  const name = (w.name || '').replace(/\*+/g, '').replace(/\b\d+\/\d+\b/g, '').trim();
  return w.producer && !name.toLowerCase().startsWith(w.producer.toLowerCase())
    ? `${w.producer} ${name}`
    : name;
}

// discover returns candidate product-page URLs, best first.
async function discover(page, query) {
  await page.goto('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });
  await sleep(1200);
  let links = await page.$$eval('a.result__a', (els) => els.map((e) => e.href).filter(Boolean));
  // Results are wrapped in a redirect; unwrap to the real destination.
  links = links
    .map((h) => {
      const m = h.match(/[?&]uddg=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : h;
    })
    .filter((h) => h.startsWith('http') && !blockedBy(h));

  // Never treat the search engine's own page as a product page. Its results
  // are wrapped in redirects that can resolve back to the engine, and a
  // results page is wall-to-wall thumbnails of OTHER wines.
  links = links.filter((h) => !/duckduckgo|bing\.com|google\.|yandex|ecosia/i.test(new URL(h).host));

  // A producer's own site first. It is unbranded, high resolution, and cannot
  // be showing a different grower's bottle.
  const producerish = /(domaine|chateau|weingut|bodega|tenuta)|\.(fr|it|de|at|es)$/i;
  return [...links].sort((a, b) => {
    const ah = new URL(a).host;
    const bh = new URL(b).host;
    return (producerish.test(bh) ? 1 : 0) - (producerish.test(ah) ? 1 : 0);
  });
}

// bestImageOn loads a product page and returns the most bottle-like image on
// it as PNG bytes.
//
// Fetching is done by NAVIGATING to the image and taking the response body,
// not by drawing it into a canvas. Canvas is a trap here, twice over: setting
// crossOrigin makes any host without CORS headers fail to load at all — which
// silently cost 13 of 20 wines in the first run — and leaving it unset taints
// the canvas so toDataURL throws instead. Navigation sidesteps both; the
// browser is acting as an HTTP client, not a renderer.
//
// The candidate filter here is deliberately loose. Its only job is to skip
// icons and banners; deciding whether something is a BOTTLE is imgcheck's
// job, and it does it far better than an aspect-ratio guess. A tight filter
// here would reject squarish product shots before anything ever looked at them.
async function bestImageOn(page, url) {
  const out = [];
  await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  await page.evaluate(() => window.scrollBy(0, 900)); // trigger lazy loading
  await sleep(1500);

  const cands = await page.$$eval('img', (els) =>
    els
      .map((e) => ({ src: e.currentSrc || e.src, w: e.naturalWidth, h: e.naturalHeight }))
      // SQUARE IMAGES COUNT. A product shot is very often a bottle centred on
      // white in a 500x500 canvas — the producer's own site serves exactly
      // that — and an earlier aspect filter of 1.05 discarded them before
      // anything looked, which was the single largest cause of "no usable
      // image". imgcheck measures the SUBJECT's proportions, not the canvas's,
      // so it reads such a bottle correctly at slimness ~0.25.
      .filter((i) => i.src && !i.src.startsWith('data:') && i.h >= 240 && i.w >= 180 && i.h / i.w >= 0.85)
      .sort((a, b) => b.h * b.w - a.h * a.w)
      .slice(0, 5)
  );

  for (const c of cands) {
    if (blockedBy(c.src)) continue;
    let bytes;
    try {
      const res = await page.goto(c.src, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      if (!res || !res.ok()) continue;
      bytes = await res.buffer();
    } catch {
      continue;
    }
    if (!bytes || bytes.length < 2000) continue;

    // Go's standard library decodes JPEG and PNG only. Anything else — webp,
    // and increasingly AVIF, both now served by default on modern storefronts
    // — is transcoded through the browser, which already has decoders for all
    // of them. A data: URL is same-origin, so the canvas is never tainted and
    // this path has none of the problems above.
    const isJPEG = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (!isJPEG && !isPNG) {
      const b64 = bytes.toString('base64');
      const png = await page.evaluate(
        (d) =>
          new Promise((ok) => {
            const i = new Image();
            i.onload = () => {
              const cv = document.createElement('canvas');
              cv.width = i.naturalWidth;
              cv.height = i.naturalHeight;
              cv.getContext('2d').drawImage(i, 0, 0);
              ok(cv.toDataURL('image/png'));
            };
            i.onerror = () => ok(null);
            i.src = d;
            setTimeout(() => ok(null), 12000);
          }),
        'data:application/octet-stream;base64,' + b64
      );
      if (!png) continue;
      bytes = Buffer.from(png.split(',')[1], 'base64');
    }
    out.push({ bytes, w: c.w, h: c.h, src: c.src });
    if (out.length >= 3) break;
  }
  return out;
}

// readLabel uses a vision model as a BETTER OCR — not as a judge.
//
// It was a judge first: the wine's name went into the prompt and the model
// answered whether the image matched. That was wrong, and measurably so. Of
// 451 images it accepted, 83 came back with label_text EXACTLY equal to the
// name it had been given — the model repeating the question instead of reading
// the bottle. Local OCR echoed the query 0 times out of 71, because it cannot:
// it never sees the name.
//
// So the name is no longer in the prompt. The model is asked only what is
// printed on the label, and the identity decision goes through the same
// match() the local path uses. That removes the echo channel entirely, keeps
// one tested set of identity rules instead of two, and makes every acceptance
// auditable against text that demonstrably came from the image.
//
// gpt-4.1-nano by measurement: best of seven models benchmarked, and cheapest,
// at $0.0002 an image.
async function readLabel(file) {
  const b64 = (await readFile(file)).toString('base64');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + VISION_KEY },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe the text printed on this wine bottle's label. ' +
                'Answer strictly as JSON: {"single_bottle":true|false,"label_text":"<every word you can read>"}. ' +
                'Transcribe only what is actually legible in the image. If a line is too small or blurred to read, ' +
                'leave it out rather than guessing. If there is no bottle, set single_bottle false.',
            },
            // detail:low costs a fraction of high and is ample for reading a
            // label's largest lines, which are the identifying ones.
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } },
          ],
        },
      ],
      max_completion_tokens: 800,
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  try {
    const v = JSON.parse((j.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/gm, '').trim());
    return v && v.single_bottle && v.label_text ? String(v.label_text) : null;
  } catch {
    return null;
  }
}

// verifyText applies the SAME identity rules to text the vision model read,
// via the same binary. Returns the label text if it names the wine, else null.
// One implementation of "is this the right wine" for both paths.
async function verifyText(file, name, labelText) {
  try {
    const { stdout } = await run(VERIFIER, ['-json', '-img', file, '-name', name, '-label', labelText]);
    return JSON.parse(stdout).accept ? labelText : null;
  } catch (e) {
    return null;
  }
}

// verify shells out to the Go binary: single-bottle shape check, then OCR of
// the label band against the catalog name.
async function verify(file, name) {
  try {
    const { stdout } = await run(VERIFIER, ['-json', '-img', file, '-name', name]);
    return JSON.parse(stdout);
  } catch (e) {
    // A rejection exits non-zero but still prints its verdict.
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch {}
    }
    return { accept: false, stage: 'verifier', reason: String(e.message).split('\n')[0] };
  }
}

// --- main --------------------------------------------------------------------

if (!(await exists(VERIFIER))) {
  console.error(`missing ${VERIFIER} — build it first:\n  go build -o ${VERIFIER} ./tools/imgcheck`);
  process.exit(2);
}

let wines = JSON.parse(await readFile('data/wines.json', 'utf8')).filter((w) => w.slug && w.name);
const only = opt('slug', '');
if (only) {
  wines = wines.filter((w) => w.slug === only);
} else {
  if (has('missing')) wines = wines.filter((w) => (w.imagePath || '').endsWith('.svg'));
  wines = wines.filter((w) => !SPIRIT.test(w.name));
  wines.sort((a, b) => a.slug.localeCompare(b.slug));
  if (!has('all')) {
    const n = parseInt(opt('n', '20'), 10);
    wines = Array.from({ length: n }, (_, i) => wines[Math.floor((i + 0.5) * (wines.length / n))]).filter(Boolean);
  }
}
if (!wines.length) {
  console.error('no wines selected');
  process.exit(2);
}

if (USE_VISION) {
  VISION_KEY = (await readFile('.env', 'utf8')).match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim() || '';
  if (!VISION_KEY) {
    console.error('--vision needs OPENAI_API_KEY in .env');
    process.exit(2);
  }
  console.log(`vision fallback: ${VISION_MODEL}`);
}

await mkdir(OUT_DIR, { recursive: true });
const manifest = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};

const browser = await openBrowser();
const page = await browser.newPage();
await page.setUserAgent(UA);

let accepted = 0;
let attempted = 0;
const rejectReasons = {};

for (const w of wines) {
  const dest = join(OUT_DIR, w.slug + '.png');
  if (manifest[w.slug]?.ok && (await exists(dest))) continue;
  attempted++;

  const name = catalogName(w);
  const rec = { slug: w.slug, name, ok: false, tried: [] };

  let pages = [];
  try {
    pages = (await discover(page, searchQuery(w))).slice(0, MAX_CANDIDATES);
  } catch (e) {
    rec.error = 'discover: ' + String(e.message).split('\n')[0];
  }

  for (const src of pages) {
    let cands = [];
    try {
      cands = await bestImageOn(page, src);
    } catch {
      rec.tried.push({ src, why: 'page failed to load' });
      continue;
    }
    if (!cands.length) {
      rec.tried.push({ src, why: 'no usable image on page' });
      continue;
    }

    // Verify EVERY downloadable candidate on the page, not just the largest.
    // Product pages lead with a lifestyle shot or a vineyard photo as often as
    // with the bottle, and the bottle is frequently the second or third image.
    for (const got of cands) {
      await writeFile(dest, got.bytes);
      const v = await verify(dest, name);
      if (v.accept) {
        rec.ok = true;
        rec.file = dest;
        rec.page = src;
        rec.image = got.src;
        rec.size = `${got.w}x${got.h}`;
        rec.label = v.label;
        rec.matched = v.found;
        rec.review = reviewFlags({ wine: w, name, label: v.label, w: got.w, h: got.h, page: src });
        accepted++;
        break;
      }
      // Second chance: re-read the label with a better OCR, then apply the
      // SAME identity rules. Vision supplies evidence; it does not decide.
      if (USE_VISION && v.stage !== 'decode') {
        visionCalls++;
        const text = await readLabel(dest);
        const vv = text ? await verifyText(dest, name, text) : null;
        if (vv) {
          rec.ok = true;
          rec.file = dest;
          rec.page = src;
          rec.image = got.src;
          rec.size = `${got.w}x${got.h}`;
          rec.label = vv;
          rec.verifiedBy = VISION_MODEL;
          rec.localReason = v.reason;
          rec.review = reviewFlags({
            wine: w, name, label: vv.label_text, verifiedBy: VISION_MODEL,
            localReason: v.reason, w: got.w, h: got.h, page: src,
          });
          accepted++;
          visionRecovered++;
          break;
        }
      }
      rec.tried.push({ src: got.src, why: v.reason || 'rejected', stage: v.stage, missing: v.missing });
      rejectReasons[v.reason || 'unknown'] = (rejectReasons[v.reason || 'unknown'] || 0) + 1;
    }
    if (rec.ok) break;
    await sleep(PACING_MS);
  }

  if (!rec.ok) {
    // Do not leave the last rejected candidate on disk pretending to be this
    // wine's image.
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(dest);
    } catch {}
  }

  manifest[w.slug] = rec;
  const mark = rec.ok ? (rec.review?.length ? 'OK? ' : 'OK  ') : 'MISS';
  console.log(`${mark} ${name.slice(0, 56).padEnd(56)} ${rec.ok ? new URL(rec.page).host : (rec.tried[0]?.why || rec.error || 'no candidates')}`);
  if (VERBOSE && rec.ok) console.log(`       label: ${rec.label?.slice(0, 90)}`);
  if (VERBOSE && !rec.ok) rec.tried.forEach((t) => console.log(`       tried ${new URL(t.src).host}: ${t.why}`));

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
  await sleep(PACING_MS);
}

await browser.close();

console.log(`\naccepted ${accepted}/${attempted}  (${attempted ? Math.round((100 * accepted) / attempted) : 0}%)`);
if (Object.keys(rejectReasons).length) {
  console.log('rejections by reason:');
  for (const [why, n] of Object.entries(rejectReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${why}`);
  }
}
if (USE_VISION) {
  console.log(`vision: ${visionCalls} calls, recovered ${visionRecovered} the local verifier had refused`);
}
const flagged = Object.values(manifest).filter((r) => r.ok && r.review?.length).length;
const clean = Object.values(manifest).filter((r) => r.ok && !r.review?.length).length;
console.log(`confidence: ${clean} clean, ${flagged} flagged for review  (OK? rows above)`);
console.log(`images -> ${OUT_DIR}/   manifest -> ${MANIFEST}`);
console.log('review sheet: node tools/labelfetch/review.mjs');
