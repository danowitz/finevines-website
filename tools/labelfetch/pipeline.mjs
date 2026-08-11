// Find a real bottle photograph without turning image search into a page-
// scraping or model-spend problem:
//
//   exact Google Image query -> first ten direct images -> local bottle check
//   -> local visual grouping -> one nano transcription of at most three images
//   -> best clean/high-resolution member of the anchored group
//
// This command only stages files and provenance. import.mjs remains the separate
// operation that changes the catalog.
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from '../../tests/helpers/browser.js';
import { binPath, envOrFile, openaiKey } from './env.mjs';
import { loadAttempts, isDue, recordAttempt, saveAttempts, shouldRecordAttempt } from './attempts.mjs';
import { buildProducerLookup, expectedProducer } from './catalog-producer.mjs';
import { deriveProducer } from './producerguess.mjs';
import { createGoogleImageDiscovery } from './google-images.mjs';
import { imageSearchQuery, uniqueImageTargets } from './image-query.mjs';
import { downloadFirstTen } from './candidate-downloads.mjs';
import { createBottleSelector } from './bottle-selector.mjs';
import { reusableStagedRecord } from './staged-record.mjs';
import { loadFunnelStore, recordFunnel, saveFunnelStore } from './funnel-store.mjs';
import {
  createBoundedLabelReader,
  createLocalBottleAdapters,
  ReaderUnavailableError,
} from './bottle-selector-runtime.mjs';

const OUT_DIR = 'data/fetched-images';
const CANDIDATE_DIR = join(OUT_DIR, 'candidates');
const MANIFEST = join(OUT_DIR, 'manifest.json');
const VERIFIER = binPath('imgcheck');
const MODEL = 'gpt-4.1-nano';
const WINE_CONCURRENCY = 2;

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const opt = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const BUDGET_MS = Math.max(0, Number.parseFloat(opt('budget-minutes', '0')) || 0) * 60_000;
const STARTED_AT = Date.now();
const DUE_ONLY = has('due-only');
const CANARY = has('canary');
const RECORD_ATTEMPTS = !CANARY && (!opt('slug') || has('record-attempts'));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function catalogName(wine) {
  const name = String(wine.name || '').replace(/\*+/g, '').replace(/\b\d+\/\d+\b/g, '').trim();
  return wine.producer && !name.toLowerCase().startsWith(wine.producer.toLowerCase())
    ? `${wine.producer} ${name}`
    : name;
}

function needsImage(wine) {
  return !wine.imagePath ||
    wine.imagePath.endsWith('.svg') ||
    wine.imageSource === 'generated-photo' ||
    wine.imageSource === 'label-scan';
}

function selectWines(catalog, attempts) {
  const only = opt('slug');
  let wines = [...catalog];
  if (only) {
    wines = wines.filter((wine) => wine.slug === only);
  } else {
    if (has('missing')) {
      wines = wines.filter(needsImage);
    }
    if (DUE_ONLY) wines = wines.filter((wine) =>
      isDue(attempts, wine.sku, new Date(), undefined, { imageMissing: needsImage(wine) }));
  }
  wines.sort((left, right) => left.slug.localeCompare(right.slug));
  wines = uniqueImageTargets(wines);
  if (has('all')) return wines;
  const limit = Number.parseInt(opt('n', '20'), 10);
  if (wines.length <= limit) return wines;
  return Array.from({ length: limit }, (_, index) =>
    wines[Math.floor((index + 0.5) * (wines.length / limit))]).filter(Boolean);
}

let browserPromise;
async function convertToPng(bytes) {
  browserPromise ||= openBrowser();
  const browser = await browserPromise;
  const page = await browser.newPage();
  try {
    const data = await page.evaluate((base64) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => resolve('');
      image.src = `data:application/octet-stream;base64,${base64}`;
    }), bytes.toString('base64'));
    return data ? Buffer.from(data.split(',')[1], 'base64') : null;
  } finally {
    await page.close();
  }
}

if (!(await exists(VERIFIER))) {
  console.error(`missing ${VERIFIER} - build it first: go build -o ${VERIFIER} ./tools/imgcheck`);
  process.exit(2);
}

const catalog = JSON.parse(await readFile('data/wines.json', 'utf8')).filter((wine) => wine.slug && wine.name);
if (!catalog.length) {
  console.error('data/wines.json holds no usable wines');
  process.exit(2);
}
const catalogBySku = new Map(catalog.map((wine) => [wine.sku, wine]));
const attempts = await loadAttempts();
const funnelStore = await loadFunnelStore();
const wines = selectWines(catalog, attempts);
if (!wines.length) {
  if (opt('slug')) {
    console.error(`no wine in the catalog has slug ${opt('slug')}`);
    process.exit(2);
  }
  console.log('no wines due tonight - image stage is converged; nothing to do');
  process.exit(0);
}

const googleKey = await envOrFile('FINEVINES_GOOGLE_CSE_KEY');
const googleCx = await envOrFile('FINEVINES_GOOGLE_CSE_CX');
if (!googleKey || !googleCx) {
  console.error('Google image discovery credentials are missing; no wine was searched and no miss was recorded');
  process.exit(2);
}
const googleDiscover = createGoogleImageDiscovery({ key: googleKey, cx: googleCx });
const visionKey = await openaiKey();
const producerLookup = buildProducerLookup(catalog);
const catalogNames = catalog.map((wine) => wine.name);
const local = createLocalBottleAdapters({ verifier: VERIFIER });
let labelBatches = 0;
const boundedReader = createBoundedLabelReader({
  apiKey: visionKey,
  model: MODEL,
  verifyIdentity: local.verifyIdentity,
  prepareImage: local.prepareForReading,
});
const selector = createBottleSelector({
  inspect: local.inspect,
  compare: local.compare,
  read: async (...readerArgs) => {
    labelBatches++;
    return boundedReader(...readerArgs);
  },
});

await mkdir(OUT_DIR, { recursive: true });
await mkdir(CANDIDATE_DIR, { recursive: true });
const manifest = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};

console.log(`google image discovery: ${googleKey && googleCx ? 'ready' : 'unavailable - wines will stay due'}`);
console.log(`identity reader: ${visionKey ? `${MODEL}, one request of at most three images per grouped wine` : 'unavailable - grouped wines will stay due'}`);
console.log(`processing up to ${WINE_CONCURRENCY} wines concurrently`);

function fail(rec, stage, reason) {
  rec.failureStage = stage;
  rec.funnel.outcome = 'failed';
  rec.tried.push({ stage, why: reason });
}

async function processWine(wine) {
  const previous = manifest[wine.slug];
  const reusable = reusableStagedRecord(
    previous,
    Boolean(previous?.file) && await exists(previous.file),
  );
  if (reusable) {
    return {
      wine,
      rec: reusable,
      evaluated: 0,
      unevaluated: 0,
      discoveryComplete: true,
      reused: true,
    };
  }

  const name = catalogName(wine);
  const producer = expectedProducer(wine, producerLookup) || deriveProducer(name, catalogNames);
  const identity = { ...wine, name, producer };
  const rec = {
    slug: wine.slug,
    sku: wine.sku,
    skus: wine.imageTargetSkus || (wine.sku ? [wine.sku] : []),
    name,
    ok: false,
    tried: [],
    query: imageSearchQuery(identity),
    funnel: {
      googleSearched: false,
      searchResults: 0,
      sourcePolicyBlocked: 0,
      permittedCandidates: 0,
      downloadAttempted: 0,
      downloaded: 0,
      decodedImages: 0,
      bottleShapePassed: 0,
      cleanBackgrounds: 0,
      similarPairs: 0,
      repeatedGroups: 0,
      strongestGroupImages: 0,
      labelImagesRead: 0,
      identityAnchors: 0,
      explicitConflicts: 0,
      publishableAnchors: 0,
      outcome: 'pending',
    },
  };
  const google = await googleDiscover(rec.query);
  Object.assign(rec.funnel, {
    googleSearched: google.searched,
    searchResults: google.returned || 0,
    sourcePolicyBlocked: google.blocked || 0,
    permittedCandidates: google.items.length,
  });
  if (!google.searched) {
    rec.discoveryError = `google: ${google.error}`;
    fail(rec, 'google-unavailable', rec.discoveryError);
    return { wine, rec, evaluated: 0, unevaluated: 0, discoveryComplete: false };
  }
  if (!google.items.length) {
    const stage = rec.funnel.searchResults && rec.funnel.sourcePolicyBlocked
      ? 'source-policy'
      : 'google-empty';
    fail(rec, stage, 'Google Images returned no permitted candidates');
    return { wine, rec, evaluated: 0, unevaluated: 0, discoveryComplete: true };
  }

  const downloaded = await downloadFirstTen({
    items: google.items,
    directory: join(CANDIDATE_DIR, wine.slug),
    convert: convertToPng,
  });
  const candidates = downloaded.candidates;
  Object.assign(rec.funnel, downloaded.diagnostics);
  const downloadFailures = google.items.length - candidates.length;
  if (candidates.length < 2) {
    fail(rec, 'download', `only ${candidates.length} of ${google.items.length} candidates downloaded`);
    return { wine, rec, evaluated: 0, unevaluated: Math.max(1, downloadFailures), discoveryComplete: true };
  }

  let result;
  try {
    result = await selector.select(identity, candidates);
  } catch (error) {
    if (error instanceof ReaderUnavailableError) {
      fail(rec, 'identity-reader-unavailable', `identity reader unavailable: ${error.message}`);
      return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete: true };
    }
    fail(rec, 'selector-error', `selector failed: ${String(error?.message || error).split('\n')[0]}`);
    return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete: true };
  }

  Object.assign(rec.funnel, result.diagnostics || {});
  if (result.reviewCandidates?.length) rec.alternates = result.reviewCandidates;
  if (!result.pick) {
    if (result.evidence?.length) rec.evidence = result.evidence;
    const stage = rec.funnel.decodedImages < 2 ? 'decode'
      : rec.funnel.repeatedGroups === 0 ? 'visual-consensus'
      : rec.funnel.identityAnchors === 0 ? 'identity-anchor'
      : rec.funnel.publishableAnchors === 0 ? 'publication-quality'
      : 'selector';
    fail(rec, stage, result.reason);
    return { wine, rec, evaluated: candidates.length, unevaluated: downloadFailures, discoveryComplete: true };
  }

  const dest = join(OUT_DIR, `${wine.slug}.png`);
  try {
    await copyFile(result.pick.file, dest);
  } catch (error) {
    fail(rec, 'staging', `could not stage selected image: ${String(error?.message || error).split('\n')[0]}`);
    return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete: true };
  }
  rec.ok = true;
  rec.funnel.outcome = 'accepted';
  rec.file = dest;
  rec.page = result.pick.context || result.pick.url;
  rec.image = result.pick.url;
  rec.size = `${result.pick.width || 0}x${result.pick.height || 0}`;
  rec.label = result.anchorLabels?.[0] || '';
  rec.verifiedBy = `${MODEL} transcription + local identity rules`;
  // Import requires this explicit machine-readable verdict. The selector only
  // returns a pick after a blind label transcription anchors a repeated bottle
  // design and every readable identity conflict has been vetoed.
  rec.selectionIdentityVerified = true;
  rec.matchingImages = result.matchingImages;
  rec.anchorImages = result.pick.anchorIds;
  rec.evidence = result.evidence;
  rec.alternates = (rec.alternates || []).filter((candidate) => candidate.file !== result.pick.file);
  rec.review = [];
  return { wine, rec, evaluated: candidates.length, unevaluated: downloadFailures, discoveryComplete: true };
}

let accepted = 0;
let attempted = 0;
let budgetSpent = false;
let fatalDiscoveryError = '';
const runRows = [];
for (let offset = 0; offset < wines.length; offset += WINE_CONCURRENCY) {
  if (BUDGET_MS && Date.now() - STARTED_AT >= BUDGET_MS) {
    budgetSpent = true;
    break;
  }
  const batch = wines.slice(offset, offset + WINE_CONCURRENCY);
  const results = await Promise.all(batch.map(processWine));
  for (const result of results) {
    attempted++;
    const { wine, rec, evaluated, unevaluated, discoveryComplete, reused = false } = result;
    runRows.push(rec);
    manifest[wine.slug] = rec;
    if (!CANARY) recordFunnel(funnelStore, rec);
    if (!discoveryComplete) fatalDiscoveryError ||= rec.discoveryError || 'Google image discovery unavailable';
    if (rec.ok) accepted++;
    if (!reused && RECORD_ATTEMPTS && rec.skus.length && shouldRecordAttempt({ accepted: rec.ok, evaluated, unevaluated, discoveryComplete })) {
      for (const sku of rec.skus) {
        const wineForSku = catalogBySku.get(sku);
        recordAttempt(attempts, sku, 'miss', new Date(), { imageMissing: needsImage(wineForSku || wine) });
      }
      await saveAttempts(attempts);
    }
    const state = reused ? 'KEEP' : rec.ok ? 'OK  ' : discoveryComplete && (evaluated || !unevaluated) ? 'MISS' : 'WAIT';
    console.log(`${state} ${rec.name.slice(0, 60).padEnd(60)} ${rec.ok ? `${rec.matchingImages} matching; ${rec.size}` : rec.tried[0]?.why || rec.discoveryError}`);
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
  if (!CANARY) await saveFunnelStore(funnelStore);
  if (fatalDiscoveryError) break;
}

if (browserPromise) await (await browserPromise).close();
if (budgetSpent) console.log(`stopped cleanly at the ${BUDGET_MS / 60_000}-minute budget; unreached wines stay due`);
console.log(`accepted ${accepted}/${attempted}; ${labelBatches} ${MODEL} label batch(es), at most three images each`);
const failureSummary = new Map();
for (const rec of runRows) {
  if (rec.ok) continue;
  const stage = rec.failureStage || 'unknown';
  failureSummary.set(stage, (failureSummary.get(stage) || 0) + 1);
}
if (failureSummary.size) {
  console.log('failure funnel:');
  for (const [stage, count] of [...failureSummary].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${stage.padEnd(28)} ${count}`);
  }
}
console.log(`images -> ${OUT_DIR}/; manifest -> ${MANIFEST}`);
if (CANARY) {
  await mkdir('out-bottle', { recursive: true });
  await writeFile('out-bottle/image-canary.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    attempted,
    accepted,
    labelBatches,
    rows: runRows,
  }, null, 2) + '\n');
  console.log('canary report -> out-bottle/image-canary.json; attempt ledger unchanged');
}
if (fatalDiscoveryError) {
  console.error(`image stage stopped: ${fatalDiscoveryError}; affected wines remain due`);
  process.exitCode = 2;
}
