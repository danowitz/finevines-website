import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseVisionFields } from './vision-label.mjs';
import { vintageConflict } from './vintage.mjs';
import { normalize, tokens } from './match.mjs';

const run = promisify(execFile);

function processVerdict(error) {
  const output = error?.stdout;
  if (!output) return null;
  try { return JSON.parse(output); } catch { return null; }
}

export function createLocalBottleAdapters({ verifier, python = 'python', runImpl = run } = {}) {
  return {
    async prepareForReading(candidate) {
      const output = candidate.file.replace(/\.png$/i, '.label.png');
      await runImpl(python, ['tools/labelfetch/label-crop.py', candidate.file, output]);
      return readFile(output);
    },

    async inspect(candidate) {
      try {
        const { stdout } = await runImpl(verifier, [
          '-json', '-shape-only', '-img', candidate.file, '-name', 'candidate',
        ]);
        const verdict = JSON.parse(stdout);
        return { visualOk: true, shapeOk: verdict.accept === true, cleanBackground: verdict.cleanBackground === true };
      } catch (error) {
        const verdict = processVerdict(error);
        return {
          visualOk: verdict?.stage !== 'decode',
          shapeOk: verdict?.accept === true,
          cleanBackground: verdict?.cleanBackground === true,
          inspectError: verdict?.reason || String(error?.message || error).split('\n')[0],
        };
      }
    },

    async compare(candidates) {
      const { stdout } = await runImpl(python, [
        'tools/labelfetch/visual-similarity.py', ...candidates.map((candidate) => candidate.file),
      ]);
      return JSON.parse(stdout).pairs || [];
    },

    async verifyIdentity(wine, candidate, labelText) {
      const args = [
        '-json', '-single-bottle', '-img', candidate.file,
        '-name', wine.name,
        '-producer', wine.producer || '',
        '-label', labelText,
      ];
      let supplied;
      try {
        const { stdout } = await runImpl(verifier, args);
        supplied = JSON.parse(stdout);
      } catch (error) {
        supplied = processVerdict(error) || { accept: false, stage: 'verifier' };
      }
      // Read the pixels independently too. A requested vintage in a model
      // prompt can bias a transcription toward that year; local OCR is an
      // inexpensive second witness and a contradictory year fails closed.
      const localArgs = args.filter((value, index) => args[index - 1] !== '-label' && value !== '-label');
      let local;
      try {
        const { stdout } = await runImpl(verifier, localArgs);
        local = JSON.parse(stdout);
      } catch (error) {
        local = processVerdict(error);
      }
      return { ...supplied, localLabel: local?.label || '' };
    },
  };
}

export class ReaderUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReaderUnavailableError';
  }
}

function parseArray(content) {
  try {
    const parsed = JSON.parse(String(content || '').replace(/^```(?:json)?|```$/gm, '').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasProductEvidence(wine, labelText) {
  const label = new Set(tokens(labelText));
  const producer = new Set(tokens(wine.producer || ''));
  if (!producer.size) return true;
  const product = tokens(wine.name || '').filter((token) => !producer.has(token));
  return product.some((token) => label.has(token));
}

const REQUIRED_TIERS = ['reserve', 'reserva', 'riserva', 'smaragd'];
const CUE_NOISE = new Set(['ried', 'valley', 'proprietary', 'rose']);
const CUVEE_NOISE = new Set(['dessus', 'dessous']);
const PRODUCER_NOISE = new Set(['domaine', 'chateau', 'maison', 'weingut', 'estate', 'winery', 'vineyards']);

function containsToken(text, wanted) {
  return normalize(text).split(' ').some((seen) =>
    seen === wanted || (seen.length >= 4 && (seen.startsWith(wanted) || wanted.startsWith(seen))));
}

// The reader is deliberately blind to the requested name, so this comparison
// cannot be satisfied by echoing words from the prompt. Require the expected
// producer (when one is known), the last distinguishing product/place token,
// and any explicit tier printed in the catalog name.
function identityConflict(wine, candidate, identity) {
  const expectedProducer = tokens(wine.producer || '').filter((token) =>
    token.length > 2 && !PRODUCER_NOISE.has(token));
  const requestedProduct = new Set(tokens(wine.name || '').filter((token) =>
    !expectedProducer.includes(token)));
  // Nano occasionally puts the appellation in producer_brand when the small
  // producer line is unreadable. Treat words that are already exact requested
  // product/place words as missing producer evidence, not as a contradictory
  // producer. A genuinely different name remains an explicit conflict.
  const seenProducer = tokens(identity.producerBrand || '').filter((token) =>
    !requestedProduct.has(token));
  const producerTokenSeen = (wanted) => seenProducer.some((seen) =>
    seen === wanted || seen.startsWith(wanted) || wanted.startsWith(seen));
  // Hyphenated estates are compound identities: F.X. Pichler is not
  // Pichler-Krutzler. Non-hyphenated catalog names often include a historical
  // suffix absent from the front label (Chofflet Valdenaire -> Chofflet), so
  // one distinctive matching name remains sufficient there.
  const compoundProducer = /[-‐-―]/.test(String(wine.producer || ''));
  const producerMatches = compoundProducer
    ? expectedProducer.every(producerTokenSeen)
    : expectedProducer.some(producerTokenSeen);
  if (expectedProducer.length && seenProducer.length && !producerMatches) {
    return `candidate producer is ${identity.producerBrand}; request is ${wine.producer}`;
  }

  const namedCuvee = tokens(identity.productCuvee || '').filter((token) => !CUVEE_NOISE.has(token));
  if (namedCuvee.length && !namedCuvee.some((token) => containsToken(wine.name || '', token))) {
    return `candidate label names a different cuvee: ${namedCuvee.join(' ')}`;
  }

  const producerSet = new Set(expectedProducer);
  const cues = tokens(wine.name || '')
    .filter((token) => !producerSet.has(token) && !CUE_NOISE.has(token));
  const cue = cues.at(-1);
  if (cue && !containsToken(identity.text, cue)) {
    const source = [candidate.title, candidate.context].filter(Boolean).join(' ');
    // An exact product page can supply a tiny/unreadable vineyard name, but it
    // must never override a different cuvee that is readable on the bottle.
    const sourceSuppliesCue = !identity.productCuvee && containsToken(source, cue);
    if (!sourceSuppliesCue) return `candidate label lacks requested discriminator ${cue}`;
  }

  const wantedWords = new Set(normalize(wine.name || '').split(' '));
  for (const tier of REQUIRED_TIERS) {
    if (wantedWords.has(tier) && !containsToken(identity.text, tier)) {
      return `candidate label lacks requested tier ${tier}`;
    }
  }
  if (wantedWords.has('estate') &&
      !containsToken(identity.text, 'estate') &&
      !containsToken([candidate.title, candidate.context, candidate.url].filter(Boolean).join(' '), 'estate')) {
    return 'candidate lacks requested Estate designation';
  }
  return '';
}

const VARIETIES = [
  'gruner veltliner', 'riesling', 'chardonnay', 'pinot noir', 'pinot grigio',
  'pinot gris', 'malbec', 'cabernet sauvignon', 'sauvignon blanc', 'merlot',
  'syrah', 'shiraz', 'gamay', 'nebbiolo', 'sangiovese', 'tempranillo',
  'grenache', 'viognier', 'aligote', 'vermentino', 'gewurztraminer', 'chenin blanc',
];

function namedVarieties(text) {
  const normalized = ` ${normalize(text)} `;
  return VARIETIES.filter((variety) => normalized.includes(` ${variety} `));
}

function varietalConflict(wine, candidate, identity) {
  const wanted = namedVarieties([wine.name, wine.varietal].filter(Boolean).join(' '));
  if (!wanted.length) return '';
  const sourceSeen = namedVarieties([candidate.title, candidate.context, candidate.url].filter(Boolean).join(' '));
  if (sourceSeen.length && !sourceSeen.some((variety) => wanted.includes(variety))) {
    return `candidate source says ${sourceSeen.join('/')}; request is ${wanted.join('/')}`;
  }
  const labelSeen = namedVarieties(identity.text);
  if (labelSeen.length && !labelSeen.some((variety) => wanted.includes(variety))) {
    return `candidate label says ${labelSeen.join('/')}; request is ${wanted.join('/')}`;
  }
  return '';
}

function styleConflict(wine, candidate, identity) {
  const wanted = new Set(normalize(wine.name || '').split(' '));
  const seen = identity.wineStyle;
  if (wanted.has('rose') && seen === 'red') return 'requested rose; candidate pixels show red';
  if ((wanted.has('rouge') || wanted.has('red')) && seen === 'rose') return 'requested red; candidate pixels show rose';
  if ((wanted.has('blanc') || wanted.has('white')) &&
      (seen === 'red' || seen === 'rose')) return 'requested white; candidate pixels show red or rose';
  const words = new Set(normalize([
    identity.text,
    candidate.title,
    candidate.context,
    candidate.url,
  ].filter(Boolean).join(' ')).split(' '));
  if (!wanted.has('1er') && !wanted.has('premier') &&
      (words.has('1er') || words.has('premier')) && words.has('cru')) return 'candidate is premier cru; request is not';
  return '';
}

// One request, never more than three images. The model sees no requested wine
// name: it only transcribes pixels. Tested local rules then compare that blind
// transcription with the catalog identity.
export function createBoundedLabelReader({
  apiKey,
  verifyIdentity,
  model = 'gpt-4.1-nano',
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  prepareImage,
} = {}) {
  return async function readLabels(wine, candidates) {
    if (!apiKey) throw new ReaderUnavailableError('OPENAI_API_KEY is missing');
    const bounded = candidates.slice(0, 3);
    const content = [{
      type: 'text',
      text:
        'Independently transcribe the product identity printed on each bottle. ' +
        'A small inset shows the complete product shot; use it to decide whether exactly one bottle is present. ' +
        'Report only words you can actually read in the image. Do not infer missing words from visual similarity or surrounding context. ' +
        'Return only a JSON array in the same order. Each item must be ' +
        '{"single_bottle":true|false,"producer_brand":"","product_cuvee":"","appellation":"","vintage":"","wine_style":"red|white|rose|unknown"}. ' +
        'Include every legible cuvee designation. Use empty strings for unreadable fields.',
    }];
    for (const candidate of bounded) {
      const bytes = prepareImage
        ? await prepareImage(candidate)
        : await readFileImpl(candidate.file);
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' },
      });
    }

    let response;
    try {
      response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_completion_tokens: 1200 }),
      });
    } catch (error) {
      throw new ReaderUnavailableError(String(error?.message || error).split('\n')[0]);
    }
    if (!response.ok) throw new ReaderUnavailableError(`HTTP ${response.status}`);

    let payload;
    try { payload = await response.json(); } catch { throw new ReaderUnavailableError('unreadable response body'); }
    const readings = parseArray(payload.choices?.[0]?.message?.content);
    const evidence = [];
    for (let index = 0; index < bounded.length; index++) {
      const candidate = bounded[index];
      const identity = parseVisionFields(JSON.stringify(readings[index] || {}));
      if (!identity) {
        evidence.push({ id: candidate.id, anchor: false, explicitConflict: false });
        continue;
      }
      const verifierWine = {
        ...wine,
        producer: wine.producer || identity.producerBrand,
      };
      const verdict = await verifyIdentity(verifierWine, candidate, identity.text);
      const localVintage = String(verdict.localLabel || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
      const siblingConflict = String(verdict.conflict || '').startsWith('label does not tell this apart');
      const identityProblem = identityConflict(verifierWine, candidate, identity);
      const conflict = vintageConflict(wine.vintage, identity.vintage) ||
        vintageConflict(wine.vintage, localVintage) ||
        varietalConflict(wine, candidate, identity) ||
        styleConflict(wine, candidate, identity) ||
        identityProblem ||
        (siblingConflict ? verdict.conflict : '');
      const confirmed = verdict.accept === true ||
        (!identityProblem && hasProductEvidence(verifierWine, identity.text));
      evidence.push({
        id: candidate.id,
        anchor: confirmed && !conflict,
        // A verifier failure means only "not proven." It is not evidence that
        // a different wine is printed on the bottle. Explicit contradiction
        // comes from a readable wrong identity or wrong vintage.
        explicitConflict: Boolean(conflict || identity.identityMatch === false),
        label: identity.text,
        visibleVintage: identity.vintage,
        localVisibleVintage: localVintage,
        identityMatch: identity.identityMatch,
        conflict: conflict || undefined,
      });
    }
    return evidence;
  };
}
