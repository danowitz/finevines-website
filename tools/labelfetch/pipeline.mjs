// Find a real bottle photograph without turning image search into a page-
// scraping or model-spend problem:
//
//   exact image query -> bounded 10+5 result window -> local bottle check
//   -> local visual grouping -> one bounded transcription of at most three images
//   -> best clean/high-resolution member of the anchored group
//
// This command only stages files and provenance. import.mjs remains the separate
// operation that changes the catalog.
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { openBrowser } from '../../tests/helpers/browser.js';
import { binPath, envOrFile, openaiKey } from './env.mjs';
import { loadAttempts, isDue, recordAttempt, saveAttempts, shouldRecordAttempt } from './attempts.mjs';
import { buildProducerLookup, expectedProducer } from './catalog-producer.mjs';
import { deriveProducer } from './producerguess.mjs';
import { googleImageSearchProfile } from './google-images.mjs';
import { createImageDiscovery, IMAGE_DISCOVERY_PROVIDERS, validateImageDiscoveryCredentials } from './image-discovery.mjs';
import { catalogImageName, imageSearchQuery, uniqueImageTargets } from './image-query.mjs';
import { downloadCandidates } from './candidate-downloads.mjs';
import { candidateWindow } from './candidate-window.mjs';
import { passedSlugs, reportSlugs, unresolvedSlugs, withoutPassed } from './comparison-progress.mjs';
import { createBottleSelector } from './bottle-selector.mjs';
import { createWebMatchExpander } from './web-match-expander.mjs';
import { reusableStagedRecord } from './staged-record.mjs';
import { buildCatalogImageDonors, reusableCatalogImage } from './catalog-image-reuse.mjs';
import {
  loadFunnelStore,
  recordFunnel,
  recoverableCandidateSlugs,
  recoverableQualitySlugs,
  saveFunnelStore,
} from './funnel-store.mjs';
import {
  createBoundedLabelReader,
  createLocalBottleAdapters,
  ReaderUnavailableError,
} from './bottle-selector-runtime.mjs';

const OUT_DIR = 'data/fetched-images';
const CANDIDATE_DIR = join(OUT_DIR, 'candidates');
const MANIFEST = join(OUT_DIR, 'manifest.json');
const VERIFIER = binPath('imgcheck');
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
const RETRY_MISSES = has('retry-misses');
const CANDIDATE_RECOVERY = has('candidate-recovery');
const QUALITY_RECOVERY = has('quality-recovery');
const OMIT_QUERY_VINTAGE = has('omit-query-vintage');
const CATALOG_REUSE = !has('no-catalog-reuse');
const TRACE = has('trace');
const TRACE_DIR = opt('trace-dir', 'out-bottle/image-traces');
const SEARCH_PROFILE_NAME = opt('search-profile', 'baseline');
const SEARCH_PROVIDER = opt('search-provider', 'google');
const MODEL = opt('label-model', process.env.FINEVINES_LABEL_MODEL || 'gpt-4.1-nano');
const EXCLUDE_PASSED_REPORT = opt('exclude-passed-report', '');
const REPLAY_REPORT = opt('replay-report', '');
if (EXCLUDE_PASSED_REPORT && REPLAY_REPORT) {
  console.error('choose only one prior report mode');
  process.exit(2);
}
const SUPPORTED_LABEL_MODELS = new Set(['gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.6-sol']);
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const LABEL_REASONING_EFFORT = MODEL === 'gpt-5.6-sol' ? opt('label-reasoning-effort', 'medium') : '';
if (OMIT_QUERY_VINTAGE && !QUALITY_RECOVERY && !CANDIDATE_RECOVERY) {
  console.error('--omit-query-vintage is recovery-only');
  process.exit(2);
}
if (!IMAGE_DISCOVERY_PROVIDERS.has(SEARCH_PROVIDER)) {
  console.error(`unknown image search provider: ${SEARCH_PROVIDER}`);
  process.exit(2);
}
if (!SUPPORTED_LABEL_MODELS.has(MODEL)) {
  console.error(`unsupported label model: ${MODEL}`);
  process.exit(2);
}
if (LABEL_REASONING_EFFORT && !REASONING_EFFORTS.has(LABEL_REASONING_EFFORT)) {
  console.error(`unsupported label reasoning effort: ${LABEL_REASONING_EFFORT}`);
  process.exit(2);
}
let searchProfile;
try {
  searchProfile = googleImageSearchProfile(SEARCH_PROFILE_NAME);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const RECORD_ATTEMPTS = !CANARY && (!opt('slug') || has('record-attempts'));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function needsImage(wine) {
  return !wine.imagePath ||
    wine.imagePath.endsWith('.svg') ||
    wine.imageSource === 'generated-photo' ||
    wine.imageSource === 'label-scan';
}

function selectWines(catalog, attempts, funnelStore) {
  const only = opt('slug');
  let wines = [...catalog];
  if (only) {
    wines = wines.filter((wine) => wine.slug === only);
  } else {
    if (has('missing')) {
      wines = wines.filter(needsImage);
    }
    if (RETRY_MISSES) {
      wines = wines.filter((wine) => funnelStore[wine.slug]?.ok === false);
    } else if (DUE_ONLY) wines = wines.filter((wine) =>
      isDue(attempts, wine.sku, new Date(), undefined, { imageMissing: needsImage(wine) }));
  }
  if (CANDIDATE_RECOVERY) {
    const recoverable = recoverableCandidateSlugs(funnelStore);
    wines = wines.filter((wine) => recoverable.has(wine.slug));
  }
  if (QUALITY_RECOVERY) {
    const recoverable = recoverableQualitySlugs(funnelStore);
    wines = wines.filter((wine) => recoverable.has(wine.slug));
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
async function convertToPng(bytes, contentType = '') {
  browserPromise ||= openBrowser();
  const browser = await browserPromise;
  const page = await browser.newPage();
  try {
    const data = await page.evaluate(({ base64, mime }) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => resolve('');
      image.src = `data:${mime};base64,${base64}`;
    }), {
      base64: bytes.toString('base64'),
      mime: /^image\/[a-z0-9.+-]+$/i.test(contentType.split(';')[0].trim())
        ? contentType.split(';')[0].trim()
        : 'application/octet-stream',
    });
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
const catalogImageDonors = buildCatalogImageDonors(catalog);
const attempts = await loadAttempts();
const funnelStore = await loadFunnelStore();
let inheritedPassed = new Set();
let continuationSlugs = new Set();
let replaySlugs = new Set();
if (EXCLUDE_PASSED_REPORT || REPLAY_REPORT) {
  if (!CANARY) {
    console.error('prior comparison reports are comparison-only');
    process.exit(2);
  }
  try {
    const reportPath = EXCLUDE_PASSED_REPORT || REPLAY_REPORT;
    const priorReport = JSON.parse(await readFile(reportPath, 'utf8'));
    if (REPLAY_REPORT) replaySlugs = reportSlugs(priorReport);
    else {
      inheritedPassed = passedSlugs(priorReport);
      continuationSlugs = unresolvedSlugs(priorReport);
    }
  } catch (error) {
    console.error(`could not read prior comparison report: ${String(error?.message || error).split('\n')[0]}`);
    process.exit(2);
  }
}
const wines = REPLAY_REPORT
  ? uniqueImageTargets(catalog.filter((wine) => replaySlugs.has(wine.slug)))
      .sort((left, right) => left.slug.localeCompare(right.slug))
  : EXCLUDE_PASSED_REPORT
  ? uniqueImageTargets(catalog.filter((wine) => continuationSlugs.has(wine.slug)))
      .sort((left, right) => left.slug.localeCompare(right.slug))
  : withoutPassed(selectWines(catalog, attempts, funnelStore), inheritedPassed);
if (CANDIDATE_RECOVERY) {
  console.log(`candidate recovery: ${wines.length} prior identity-anchor misses selected`);
}
if (QUALITY_RECOVERY) {
  console.log(`quality recovery: ${wines.length} prior publication-quality misses selected`);
}
if (!wines.length) {
  if (opt('slug')) {
    console.error(`no wine in the catalog has slug ${opt('slug')}`);
    process.exit(2);
  }
  if (CANARY && EXCLUDE_PASSED_REPORT) {
    await mkdir('out-bottle', { recursive: true });
    await writeFile('out-bottle/image-canary.json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      searchProfile: SEARCH_PROFILE_NAME,
      searchProvider: SEARCH_PROVIDER,
      labelModel: MODEL,
      labelReasoningEffort: LABEL_REASONING_EFFORT,
      inheritedPassed: inheritedPassed.size,
      cumulativePassedSlugs: [...inheritedPassed].sort(),
      remainingSlugs: [],
      attempted: 0,
      accepted: 0,
      recovered: 0,
      labelBatches: 0,
      rows: [],
    }, null, 2) + '\n');
    console.log('comparison is converged; all scoped wines passed in earlier rounds');
    process.exit(0);
  }
  console.log('no wines due tonight - image stage is converged; nothing to do');
  process.exit(0);
}

const googleKey = await envOrFile('FINEVINES_GOOGLE_CSE_KEY');
const googleCx = await envOrFile('FINEVINES_GOOGLE_CSE_CX');
const braveKey = await envOrFile('FINEVINES_BRAVE_SEARCH_KEY');
const serperKey = await envOrFile('FINEVINES_SERPER_KEY');
const googleVisionKey = await envOrFile('FINEVINES_GOOGLE_VISION_KEY');
try {
  validateImageDiscoveryCredentials(SEARCH_PROVIDER, { googleKey, googleCx, braveKey, serperKey });
} catch (error) {
  console.error(`${error.message}; no wine was searched and no miss was recorded`);
  process.exit(2);
}
const imageDiscover = createImageDiscovery({
  name: SEARCH_PROVIDER,
  googleKey,
  googleCx,
  braveKey,
  serperKey,
  googleSearchParams: searchProfile,
});
const visionKey = await openaiKey();
const producerLookup = buildProducerLookup(catalog);
const catalogNames = catalog.map((wine) => wine.name);
const local = createLocalBottleAdapters({ verifier: VERIFIER });
let labelBatches = 0;
const boundedReader = createBoundedLabelReader({
  apiKey: visionKey,
  model: MODEL,
  reasoningEffort: LABEL_REASONING_EFFORT,
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
const expandWebMatches = createWebMatchExpander({
  apiKey: googleVisionKey,
  prepareSeedVariants: async (seed) => [
    { kind: 'whole-bottle', bytes: await readFile(seed.file) },
    { kind: 'label-crop', bytes: await local.prepareForReading(seed) },
  ],
});

await mkdir(OUT_DIR, { recursive: true });
await mkdir(CANDIDATE_DIR, { recursive: true });
const manifest = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};

console.log(`${SEARCH_PROVIDER} image discovery: ready`);
if (SEARCH_PROVIDER === 'google') console.log(`google image search profile: ${SEARCH_PROFILE_NAME}`);
console.log(`identity reader: ${visionKey ? `${MODEL}${LABEL_REASONING_EFFORT ? ` (${LABEL_REASONING_EFFORT} effort)` : ''}, three images plus one miss-only batch of three` : 'unavailable - grouped wines will stay due'}`);
console.log(`label reverse-search expansion: ${googleVisionKey ? 'Google Cloud Vision Web Detection ready (whole bottle + label crop)' : 'disabled - FINEVINES_GOOGLE_VISION_KEY is missing'}`);
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
  if (reusable && !TRACE) {
    return {
      wine,
      rec: reusable,
      evaluated: 0,
      unevaluated: 0,
      discoveryComplete: true,
      reused: true,
    };
  }

  const name = catalogImageName(wine);
  const producer = expectedProducer(wine, producerLookup) || deriveProducer(name, catalogNames);
  const identity = { ...wine, name, producer };
  const rec = {
    slug: wine.slug,
    sku: wine.sku,
    skus: wine.imageTargetSkus || (wine.sku ? [wine.sku] : []),
    name,
    ok: false,
    tried: [],
    query: imageSearchQuery({
      ...identity,
      vintage: OMIT_QUERY_VINTAGE ? '' : identity.vintage,
    }),
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
      webExpansionRequests: 0,
      webExpansionCandidates: 0,
      webExpansionBlocked: 0,
      webExpansionDownloaded: 0,
      outcome: 'pending',
      recoveryScope: QUALITY_RECOVERY ? 'quality' : CANDIDATE_RECOVERY ? 'candidate' : '',
      queryVintageOmitted: OMIT_QUERY_VINTAGE,
    },
  };
  const donor = CATALOG_REUSE ? reusableCatalogImage(catalogImageDonors, wine) : null;
  if (donor && await exists(donor.imagePath)) {
    try {
      const extension = extname(donor.imagePath) || '.jpg';
      const dest = join(OUT_DIR, `${wine.slug}${extension}`);
      await mkdir(OUT_DIR, { recursive: true });
      await copyFile(donor.imagePath, dest);
      rec.ok = true;
      rec.funnel.catalogImageReused = 1;
      rec.funnel.outcome = 'accepted';
      rec.file = dest;
      rec.page = donor.imageSourceUrl || '';
      rec.image = donor.imageSourceUrl || '';
      rec.size = 'catalog copy';
      rec.label = donor.name || name;
      rec.verifiedBy = `exact catalog product + vintage match from SKU ${donor.sku}`;
      rec.selectionIdentityVerified = true;
      rec.matchingImages = 1;
      rec.anchorImages = [`catalog:${donor.sku}`];
      rec.evidence = [{
        id: `catalog:${donor.sku}`,
        anchor: true,
        explicitConflict: false,
        label: donor.name || name,
      }];
      rec.alternates = [];
      rec.review = [];
      return { wine, rec, evaluated: 0, unevaluated: 0, discoveryComplete: true };
    } catch (error) {
      console.warn(`catalog image reuse failed for ${wine.slug}: ${String(error?.message || error).split('\n')[0]}; falling back to configured image discovery`);
    }
  }
  const trace = TRACE ? {
    generatedAt: new Date().toISOString(),
    catalogInput: identity,
    query: rec.query,
    discovery: null,
    downloads: null,
    selector: null,
    webExpansion: null,
  } : null;
  if (trace) rec.debugTrace = trace;
  const discovery = await imageDiscover(rec.query);
  const discoveryComplete = discovery.complete !== false;
  if (trace) trace.discovery = {
    provider: SEARCH_PROVIDER,
    status: discovery.status,
    searched: discovery.searched,
    returned: discovery.returned || 0,
    blocked: discovery.blocked || 0,
    error: discovery.error || '',
    correctedQuery: discovery.correctedQuery || '',
    providers: discovery.providers || [],
    results: discovery.trace || [],
    permittedCandidates: discovery.items,
  };
  Object.assign(rec.funnel, {
    googleSearched: SEARCH_PROVIDER === 'google' && discovery.searched,
    searchProvider: SEARCH_PROVIDER,
    labelModel: MODEL,
    labelReasoningEffort: LABEL_REASONING_EFFORT,
    searchResults: discovery.returned || 0,
    sourcePolicyBlocked: discovery.blocked || 0,
    permittedCandidates: discovery.items.length,
    providerResults: discovery.providers || [],
  });
  if (discovery.status === 'partial') rec.discoveryWarning = discovery.error;
  if (!discovery.searched) {
    rec.discoveryError = `${SEARCH_PROVIDER}: ${discovery.error}`;
    fail(rec, `${SEARCH_PROVIDER}-unavailable`, rec.discoveryError);
    return { wine, rec, evaluated: 0, unevaluated: 0, discoveryComplete: false };
  }
  if (!discovery.items.length) {
    const stage = rec.funnel.searchResults && rec.funnel.sourcePolicyBlocked
      ? 'source-policy'
      : `${SEARCH_PROVIDER}-empty`;
    fail(rec, stage, `${SEARCH_PROVIDER} Images returned no permitted candidates`);
    return { wine, rec, evaluated: 0, unevaluated: 0, discoveryComplete };
  }

  const window = candidateWindow(discovery.items);
  Object.assign(rec.funnel, window.diagnostics);
  const downloaded = await downloadCandidates({
    items: window.candidates,
    directory: join(CANDIDATE_DIR, wine.slug),
    convert: convertToPng,
  });
  if (trace) trace.downloads = downloaded.trace || [];
  const candidates = downloaded.candidates;
  Object.assign(rec.funnel, downloaded.diagnostics);
  const downloadFailures = window.candidates.length - candidates.length;
  if (candidates.length < 2) {
    fail(rec, 'download', `only ${candidates.length} of ${window.candidates.length} candidates downloaded`);
    return { wine, rec, evaluated: 0, unevaluated: Math.max(1, downloadFailures), discoveryComplete };
  }

  let result;
  try {
    result = await selector.select(identity, candidates);
    if (trace) trace.selector = result.trace || null;
  } catch (error) {
    if (error instanceof ReaderUnavailableError) {
      fail(rec, 'identity-reader-unavailable', `identity reader unavailable: ${error.message}`);
      return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete };
    }
    fail(rec, 'selector-error', `selector failed: ${String(error?.message || error).split('\n')[0]}`);
    return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete };
  }

  // Reverse-image expansion is a bounded rescue for a verified anchor or a
  // conflict-free repeated-design hypothesis. It is optional: an unavailable
  // Web Detection API leaves the original selector verdict intact and visible.
  if (!result.pick && result.expansionSeeds?.length && googleVisionKey) {
    const expansion = await expandWebMatches(result.expansionSeeds);
    Object.assign(rec.funnel, {
      webExpansionStatus: expansion.status,
      webExpansionRequests: expansion.requests || 0,
      webExpansionCandidates: expansion.items?.length || 0,
      webExpansionBlocked: expansion.blocked || 0,
      webExpansionError: expansion.error || '',
    });
    if (trace) trace.webExpansion = expansion;
    if (expansion.items?.length) {
      const expandedDownloads = await downloadCandidates({
        items: expansion.items,
        directory: join(CANDIDATE_DIR, wine.slug),
        convert: convertToPng,
        idPrefix: 'web-match',
        filePrefix: 'web-match',
      });
      rec.funnel.webExpansionDownloaded = expandedDownloads.candidates.length;
      if (trace) trace.webExpansion.downloads = expandedDownloads.trace;
      if (expandedDownloads.candidates.length) {
        candidates.push(...expandedDownloads.candidates);
        try {
          result = await selector.select(identity, candidates);
          if (trace) trace.selectorAfterWebExpansion = result.trace || null;
        } catch (error) {
          if (error instanceof ReaderUnavailableError) {
            fail(rec, 'identity-reader-unavailable', `identity reader unavailable after Web Detection: ${error.message}`);
            return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete };
          }
          fail(rec, 'selector-error', `selector failed after Web Detection: ${String(error?.message || error).split('\n')[0]}`);
          return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete };
        }
      }
    }
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
    return { wine, rec, evaluated: candidates.length, unevaluated: downloadFailures, discoveryComplete };
  }

  const dest = join(OUT_DIR, `${wine.slug}.png`);
  try {
    await copyFile(result.pick.file, dest);
  } catch (error) {
    fail(rec, 'staging', `could not stage selected image: ${String(error?.message || error).split('\n')[0]}`);
    return { wine, rec, evaluated: 0, unevaluated: candidates.length, discoveryComplete };
  }
  rec.ok = true;
  rec.funnel.outcome = 'accepted';
  rec.file = dest;
  rec.page = result.pick.context || result.pick.url;
  rec.image = result.pick.url;
  rec.size = `${result.pick.width || 0}x${result.pick.height || 0}`;
  rec.label = result.anchorLabels?.[0] || '';
  rec.verifiedBy = result.pick.trustedFullMatch
    ? 'verified pixel anchor + exact visual copy'
    : `${MODEL} transcription + local identity rules`;
  // Import requires this explicit machine-readable verdict. The selector only
  // returns a pick after either blind label transcription or an exact visual
  // copy of already-verified pixels anchors a repeated bottle design. Source
  // titles rank candidates but never prove the image itself.
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
    if (CANARY && funnelStore[wine.slug]) {
      const previous = funnelStore[wine.slug];
      rec.previous = {
        ok: previous.ok === true,
        failureStage: previous.failureStage || '',
        reason: previous.reason || '',
      };
    }
    if (TRACE && rec.debugTrace) {
      const traceDirectory = join(TRACE_DIR, wine.slug);
      await mkdir(traceDirectory, { recursive: true });
      await writeFile(join(traceDirectory, 'trace.json'), JSON.stringify({
        ...rec.debugTrace,
        final: {
          ok: rec.ok,
          failureStage: rec.failureStage || '',
          tried: rec.tried || [],
          funnel: rec.funnel || {},
          selectedFile: rec.file || '',
          selectedImage: rec.image || '',
          selectedPage: rec.page || '',
        },
      }, null, 2) + '\n');
      console.log(`TRACE ${wine.slug} -> ${join(traceDirectory, 'trace.json')}`);
      delete rec.debugTrace;
    }
    runRows.push(rec);
    manifest[wine.slug] = rec;
    if (!CANARY) recordFunnel(funnelStore, rec);
    if (!discoveryComplete && !rec.ok) {
      fatalDiscoveryError ||= rec.discoveryError || rec.discoveryWarning || `${SEARCH_PROVIDER} image discovery incomplete`;
    }
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
  const recovered = runRows.filter((row) => row.ok && row.previous?.ok === false).length;
  const cumulativePassedSlugs = [...new Set([
    ...inheritedPassed,
    ...runRows.filter((row) => row.ok).map((row) => row.slug),
  ])].sort();
  const passedThisRound = new Set(runRows.filter((row) => row.ok).map((row) => row.slug));
  const remainingSlugs = wines.map((wine) => wine.slug).filter((slug) => !passedThisRound.has(slug));
  await mkdir('out-bottle', { recursive: true });
  await writeFile('out-bottle/image-canary.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    searchProfile: SEARCH_PROFILE_NAME,
    searchProvider: SEARCH_PROVIDER,
    labelModel: MODEL,
    labelReasoningEffort: LABEL_REASONING_EFFORT,
    inheritedPassed: inheritedPassed.size,
    cumulativePassedSlugs,
    remainingSlugs,
    attempted,
    accepted,
    recovered,
    labelBatches,
    rows: runRows,
  }, null, 2) + '\n');
  console.log('canary report -> out-bottle/image-canary.json; attempt ledger unchanged');
}
if (fatalDiscoveryError) {
  console.error(`image stage stopped: ${fatalDiscoveryError}; affected wines remain due`);
  process.exitCode = 2;
}
