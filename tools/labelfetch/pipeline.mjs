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
import { binPath, openaiKey, envOrFile } from './env.mjs';
import { loadAttempts, isDue, recordAttempt, saveAttempts } from './attempts.mjs';

const run = promisify(execFile);

const OUT_DIR = 'data/fetched-images';
// Rejected candidates live beside the accepted ones so a reviewer correcting a
// bad match picks from images already fetched rather than starting over.
const ALT_DIR = 'data/fetched-images/alternates';
const MAX_ALTERNATES = 4;
const MANIFEST = join(OUT_DIR, 'manifest.json');
const VERIFIER = binPath('imgcheck');

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
// Vision label reading is opt-in: the pipeline runs without an API key, just at
// a lower recovery rate.
//
// --vision-first is what makes the pipeline work on Linux AT ALL. imgcheck's
// stage-2 label read shells out to the Windows OCR engine
// (tools/imgcheck/ocr.ps1), so on ubuntu-latest it exits 1 printing nothing,
// verify() reports stage 'verifier', and the vision second chance below never
// fires because it only reconsiders a 'label' refusal. Reading the label with
// the vision model FIRST and passing the text to imgcheck via -label skips
// local OCR entirely.
//
// Both hard gates survive that inversion. -single-bottle is still NOT passed
// (see verifyText), so stage 1 — the shape check, pure Go — still decides from
// pixels whether this is one bottle on a sweep; and the identity decision still
// goes through the one tested match() inside imgcheck rather than being taken on
// the model's word.
const VISION_FIRST = has('vision-first');
const USE_VISION = has('vision') || VISION_FIRST;
const VISION_MODEL = opt('vision-model', 'gpt-4.1-nano');
// --due-only consults the committed attempt ledger so a nightly run does not
// re-search the ~1,700 wines that have already been looked for and not found.
const DUE_ONLY = has('due-only');
let VISION_KEY = '';
let CSE_KEY = '';
let CSE_CX = '';
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

// googleDiscover asks the Custom Search JSON API for image results and
// returns their CONTEXT pages — the product pages the images live on — so
// they flow through the same extract/gate/verify chain as DDG candidates.
// A second discovery source, not a replacement: measured on a 20-wine sample
// of DDG failures (2026-07-29 spike, tools/labelfetch/googlespike.mjs), CSE
// found a gate-surviving candidate for 18, of which 3 machine-verified and
// ~5 more were the right wine recoverable in review.
//
// Optional by construction: no FINEVINES_GOOGLE_CSE_KEY/_CX in .env means no
// Google rung, and ANY error (including the 429 that follows the free
// 100-query day on the test key) just returns [] — the pipeline continues
// DDG-only rather than dying mid-run.
let cseDown = false; // once quota is gone, stop burning a request per wine
async function googleDiscover(query) {
  if (!CSE_KEY || !CSE_CX || cseDown) return [];
  try {
    const params = new URLSearchParams({
      key: CSE_KEY, cx: CSE_CX, q: query, searchType: 'image', num: '8',
      imgSize: 'large', imgType: 'photo', safe: 'active',
    });
    const res = await fetch('https://www.googleapis.com/customsearch/v1?' + params, {
      // The GRIT-Hub test key is referer-restricted to grithub.app.
      headers: { Referer: 'https://finevines.grithub.app' },
    });
    if (res.status === 429 || res.status === 403) {
      cseDown = true;
      console.log(`     google discovery off for this run (HTTP ${res.status} — quota)`);
      return [];
    }
    if (!res.ok) return [];
    const items = (await res.json()).items || [];
    // The direct image URL leads, its context page follows as backup: the
    // spike's verified wins came from the direct link (navigating Chrome to
    // it yields a one-image page bestImageOn reads normally), while a context
    // page can bury or lazy-load the image the API indexed off it.
    const urls = [];
    for (const it of items) {
      const img = it.link || '';
      const ctx = it.image?.contextLink || '';
      // The Vivino filename pattern travels to re-hosting retailers; the host
      // gate can't see it, the URL of the image itself can.
      if (blockedBy(img) || blockedBy(ctx) || /_pb_x\d+/.test(img)) continue;
      if (img) urls.push(img);
      if (ctx) urls.push(ctx);
    }
    return urls;
  } catch {
    return [];
  }
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
                'Transcribe the text printed on the label of this wine bottle. ' +
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

// reviewFlags lists the reasons a staged image might still be wrong, so a run
// of two thousand yields a short list to check rather than a pile to trust.
//
// None is a rejection — the image already passed. These are the differences
// between "verified" and "certain", recorded at the moment they are visible,
// because at this scale nobody re-examines everything.
function reviewFlags({ wine, name, label, viaVision, localReason, w, h, page }) {
  const flags = [];

  // Deliberately NOT flagged any more: "a vision model was involved". It fired
  // on 433 of 504 images, and a flag that fires on nearly everything is the
  // same as no flag. Vision now only READS the label — the identity decision
  // is the same rule in both paths — so its involvement is not itself a doubt.
  // What matters is whether the evidence is thin, which the flags below test.

  const lab = normalize(label || '');
  const want = tokens(name);
  const missing = want.filter((x) => !lab.includes(x.slice(0, Math.max(4, x.length - 2))));
  if (want.length && missing.length > want.length / 2) {
    flags.push(`label missing most of the name (${missing.slice(0, 4).join(', ')})`);
  }

  // A label this short cannot have carried much evidence either way.
  if (lab.replace(/\s+/g, '').length < 12) flags.push('almost nothing legible on the label');

  const wantY = String(wine.vintage || '').match(/(19|20)\d\d/)?.[0];
  const gotY = (label || '').match(/(19|20)\d\d/)?.[0];
  if (wantY && gotY && wantY !== gotY) flags.push(`vintage on label is ${gotY}, catalog says ${wantY}`);

  // Below this the label is unreadable on a detail page and the normalised
  // 600x900 canvas is upscaling.
  if (h && h < 500) flags.push(`low resolution (${w}x${h})`);

  // The local shape check refused it and only the model's single-bottle call
  // carried it through — worth an eye, unlike vision involvement in general.
  if (viaVision && /clean background|multiple subjects|too wide|too narrow/.test(localReason || '')) {
    flags.push(`shape disputed (local said: ${localReason})`);
  }

  return flags;
}

// verifyText applies the SAME identity rules to text the vision model read,
// via the same binary. Returns the label text if it names the wine, else null.
// One implementation of "is this the right wine" for both paths.
async function verifyText(file, name, producer, labelText) {
  try {
    // NOTE: -single-bottle is deliberately NOT passed.
    //
    // It was, briefly, so a model reporting single_bottle could overturn the
    // local shape check. Reviewing the results killed the idea: it let through
    // a photograph of a plated steak with a bottle in the background, and a
    // close-up of grapes on the vine with no bottle at all. In both the local
    // check had said "a photographed scene, not a product shot" and been
    // exactly right.
    //
    // Whether an image is one bottle on a sweep is a fact about pixels, and the
    // thing that measures pixels decides it. The model is allowed to overturn
    // the LABEL reading, which is where it is genuinely better.
    const { stdout } = await run(VERIFIER, [
      '-json', '-img', file, '-name', name, '-producer', producer || '',
      '-label', labelText,
    ]);
    return JSON.parse(stdout).accept ? labelText : null;
  } catch (e) {
    return null;
  }
}

// verify shells out to the Go binary: single-bottle shape check, then OCR of
// the label band against the catalog name.
async function verify(file, name, producer) {
  try {
    const { stdout } = await run(VERIFIER, ['-json', '-img', file, '-name', name, '-producer', producer || '']);
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

// verifyVisionFirst reads the label with the vision model and then applies the
// SAME identity rules through the same binary, returning a verdict shaped
// exactly like verify()'s so the calling loop needs no other change.
//
// It is the only path that works on Linux (see VISION_FIRST above). Note what it
// does NOT do: it does not pass -single-bottle, so the local shape gate still
// runs and can still refuse; and it does not let the model decide identity, only
// read the text. An empty or near-empty read is a refusal, not a pass — a wine
// was once accepted on a photograph of grapes because a blank string was allowed
// through here.
async function verifyVisionFirst(file, name, producer) {
  const text = await readLabel(file);
  if (!text || text.trim().length < 3) {
    return { accept: false, stage: 'label', label: text || '', reason: 'nothing legible on the label' };
  }
  const ok = await verifyText(file, name, producer, text);
  return ok
    ? { accept: true, stage: 'label', label: text, verifiedBy: VISION_MODEL }
    : { accept: false, stage: 'label', label: text, reason: 'the label does not name this wine' };
}

// --- main --------------------------------------------------------------------

if (!(await exists(VERIFIER))) {
  console.error(`missing ${VERIFIER} — build it first:\n  go build -o ${VERIFIER} ./tools/imgcheck`);
  process.exit(2);
}

let wines = JSON.parse(await readFile('data/wines.json', 'utf8')).filter((w) => w.slug && w.name);
const attempts = await loadAttempts();
const only = opt('slug', '');
if (only) {
  wines = wines.filter((w) => w.slug === only);
} else {
  if (has('missing')) wines = wines.filter((w) => (w.imagePath || '').endsWith('.svg'));
  if (DUE_ONLY) {
    const before = wines.length;
    wines = wines.filter((w) => isDue(attempts, w.sku));
    console.log(`due per the attempt ledger: ${wines.length} of ${before} imageless wines`);
  }
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
  VISION_KEY = await openaiKey();
  if (!VISION_KEY) {
    console.error('--vision needs OPENAI_API_KEY in the environment or .env');
    process.exit(2);
  }
  console.log(`vision label reading: ${VISION_MODEL}${VISION_FIRST ? ' (first, local OCR skipped)' : ' (fallback)'}`);
}
// Same env-then-.env resolution as the OpenAI key, via the shared helper: an
// environment variable wins outright, .env is a tolerant fallback, and either
// key simply missing — no .env file at all included — leaves discovery off
// rather than crashing the run. A direct, unconditional readFile('.env') here
// used to ENOENT-kill the whole script on any machine without a .env file,
// which is exactly ubuntu-latest, the one place this pipeline most needs to
// keep running.
CSE_KEY = await envOrFile('FINEVINES_GOOGLE_CSE_KEY');
CSE_CX = await envOrFile('FINEVINES_GOOGLE_CSE_CX');
if (CSE_KEY && CSE_CX) console.log('google discovery: on (Custom Search JSON API)');

await mkdir(OUT_DIR, { recursive: true });
await mkdir(ALT_DIR, { recursive: true });
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
  // Google image search sees product pages DDG misses (measured: candidates
  // for 18 of 20 DDG failures). Its context pages join the same queue —
  // deduped by host so the run doesn't visit one shop twice for one wine.
  {
    const seen = new Set(pages.map((p) => new URL(p).host));
    for (const u of await googleDiscover(searchQuery(w))) {
      const h = new URL(u).host;
      if (seen.has(h)) continue;
      seen.add(h);
      pages.push(u);
      if (pages.length >= MAX_CANDIDATES * 2) break;
    }
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
      const v = VISION_FIRST
        ? await verifyVisionFirst(dest, name, w.producer)
        : await verify(dest, name, w.producer);
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
        if (VISION_FIRST) rec.verifiedBy = VISION_MODEL;
        break;
      }
      // The second chance only exists for the local-OCR path; in vision-first
      // mode the model has already read the label, so re-reading it would just
      // pay twice for the same answer.
      if (USE_VISION && !VISION_FIRST && v.stage !== 'decode') {
        visionCalls++;
        // Only reconsider a LABEL refusal. A shape refusal stands: see
        // verifyText. And an empty read is not evidence — a wine was accepted
        // on a picture of grapes with nothing legible on it because a blank
        // string was allowed through here.
        const text = v.stage === 'label' ? await readLabel(dest) : null;
        const vv = text && text.trim().length >= 3
          ? await verifyText(dest, name, w.producer, text)
          : null;
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
            wine: w, name, label: vv, viaVision: true,
            localReason: v.reason, w: got.w, h: got.h, page: src,
          });
          accepted++;
          visionRecovered++;
          break;
        }
      }
      // KEEP the rejected candidate. Every one is a picture of something, taken
      // from a page that claimed to be this wine — and when the accepted image
      // turns out wrong, the right one is very often among the ones refused.
      // Throwing them away meant a human correcting a bad match had to start
      // the search from nothing; keeping them makes it a choice between images
      // already on disk. They are gitignored and deleted with the staging dir.
      if ((rec.alternates || []).length < MAX_ALTERNATES) {
        const altFile = join(ALT_DIR, `${w.slug}-${(rec.alternates || []).length}.png`);
        try {
          await writeFile(altFile, got.bytes);
          rec.alternates = [...(rec.alternates || []), {
            file: altFile, page: src, size: `${got.w}x${got.h}`,
            why: v.reason || 'rejected', label: v.label || '',
          }];
        } catch {}
      }
      rec.tried.push({ src: got.src, why: v.reason || 'rejected', stage: v.stage, missing: v.missing });
      rejectReasons[v.reason || 'unknown'] = (rejectReasons[v.reason || 'unknown'] || 0) + 1;
    }
    if (rec.ok) break;
    await sleep(PACING_MS);
  }

  if (!rec.ok) {
    // The last rejected candidate must not sit at the accepted path pretending
    // to be this wine's image — but it is kept as an alternate, because a wine
    // that found nothing is exactly where a reviewer most needs options.
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(dest);
    } catch {}
  }

  manifest[w.slug] = rec;
  // Record the attempt as a MISS regardless of how the fetch went. import.mjs
  // upgrades the ones it actually writes to 'imported' afterwards. Recording
  // pessimistically first is deliberate: a run that dies between fetch and
  // import still leaves the attempt on record, so the next night does not
  // re-burn the same search.
  if (w.sku) {
    recordAttempt(attempts, w.sku, 'miss');
    await saveAttempts(attempts);
  }
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
