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
      try {
        const { stdout } = await runImpl(python, [
          'tools/labelfetch/visual-similarity.py', ...candidates.map((candidate) => candidate.file),
        ]);
        return JSON.parse(stdout).pairs || [];
      } catch (error) {
        const detail = String(error?.stderr || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
        throw new Error(`visual similarity failed: ${detail || String(error?.message || error).split('\n')[0]}`);
      }
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

function parseRows(content) {
  try {
    const parsed = JSON.parse(String(content || '').replace(/^```(?:json)?|```$/gm, '').trim());
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.readings) ? parsed.readings : [];
  } catch {
    return [];
  }
}

function readingsByCandidate(candidates, readings) {
  const keyed = new Map(readings
    .filter((reading) => reading && typeof reading.candidate_id === 'string')
    .map((reading) => [reading.candidate_id, reading]));
  if (keyed.size) return candidates.map(({ id }) => keyed.get(id) || null);
  // Backward-compatible only when the old positional contract is complete.
  // A short or long anonymous array is ambiguous and must be retried by ID.
  return readings.length === candidates.length ? readings : candidates.map(() => null);
}

function hasProductEvidence(wine, labelText) {
  const label = new Set(tokens(labelText));
  const producer = new Set(tokens(wine.producer || ''));
  if (!producer.size) return true;
  const product = tokens(wine.name || '').filter((token) => !producer.has(token));
  return product.some((token) => label.has(token));
}

const REQUIRED_TIERS = ['reserve', 'reserva', 'riserva', 'smaragd'];
const CUE_NOISE = new Set([
  'ried', 'valley', 'proprietary', 'rose', 'rouge', 'blanc', 'noir',
  'brut', 'doc', 'docg', 'igt', 'aoc', 'wine', 'wines', 'vino', 'cider',
  'whisky', 'whiskey', 'gin', 'vodka', 'rum',
]);
const CUVEE_NOISE = new Set(['dessus', 'dessous']);
const PRODUCER_NOISE = new Set(['domaine', 'chateau', 'maison', 'weingut', 'estate', 'winery', 'vineyards']);
const PRODUCER_BRAND_ALIASES = new Map([
  ['vine hill ranch', new Set(['baker hamilton'])],
  ['huteau boulanger', new Set(['laetitia ducroux'])],
]);

function bottleBrandAliases(wine) {
  const configured = Array.isArray(wine.bottleBrands) ? wine.bottleBrands : [];
  return new Set([
    ...(PRODUCER_BRAND_ALIASES.get(normalize(wine.producer || '')) || []),
    ...configured.map((brand) => normalize(brand)),
  ]);
}

function isBottleBrandAlias(wine, producerBrand) {
  const seen = tokens(producerBrand || '')
    .filter((token) => token.length > 2 && !PRODUCER_NOISE.has(token))
    .join(' ');
  return Boolean(seen) && bottleBrandAliases(wine).has(seen);
}

function containsToken(text, wanted) {
  return normalize(text).split(' ').some((seen) =>
    seen === wanted ||
    (seen.length >= 4 && (seen.startsWith(wanted) || wanted.startsWith(seen))) ||
    (seen.length >= 5 && wanted.length >= 5 && editDistance(seen, wanted) <= 1) ||
    (seen.length >= 6 && wanted.length >= 6 && editDistance(seen, wanted) <= 2));
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + Number(left[row - 1] !== right[column - 1]),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
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
    ![...requestedProduct].some((product) =>
      token === product ||
      (token.length >= 4 && (token.startsWith(product) || product.startsWith(token))) ||
      (token.length >= 6 && product.length >= 6 && editDistance(token, product) <= 2)));
  const producerTokenSeen = (wanted) => seenProducer.some((seen) =>
    seen === wanted || seen.startsWith(wanted) || wanted.startsWith(seen));
  // Hyphenated estates are compound identities: F.X. Pichler is not
  // Pichler-Krutzler. Non-hyphenated catalog names often include a historical
  // suffix absent from the front label (Chofflet Valdenaire -> Chofflet), so
  // one distinctive matching name remains sufficient there.
  const compoundProducer = /[-\u2010-\u2015]/u.test(String(wine.producer || ''));
  const producerMatches = compoundProducer
    ? expectedProducer.every(producerTokenSeen)
    : expectedProducer.some(producerTokenSeen);
  if (expectedProducer.length && seenProducer.length && !producerMatches &&
      !isBottleBrandAlias(wine, identity.producerBrand)) {
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

function sourceVintageConflict(wine, candidate) {
  const wanted = String(wine.vintage || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
  if (!wanted) return '';
  // Product titles are explicit evidence. Do not mine arbitrary page URLs or
  // article dates: those can describe publication time rather than vintage.
  const visible = String(candidate.title || '').match(/\b(?:19|20)\d{2}\b/g) || [];
  if (visible.length && !visible.includes(wanted)) {
    return `candidate source title says ${[...new Set(visible)].join('/')}; request is ${wanted}`;
  }
  return '';
}

function hasProducerEvidence(wine, identity) {
  const expected = tokens(wine.producer || '').filter((token) =>
    token.length > 2 && !PRODUCER_NOISE.has(token));
  if (!expected.length) return true;
  // Field placement is not trustworthy on tiny labels. Search every blind
  // transcription field, but require the requested producer's distinctive
  // name rather than accepting matching appellation/cuvee text alone.
  const seen = tokens(identity.text);
  const tokenSeen = (wanted) => seen.some((token) =>
    token === wanted || token.startsWith(wanted) || wanted.startsWith(token));
  const compoundProducer = /[-\u2010-\u2015]/u.test(String(wine.producer || ''));
  const direct = compoundProducer ? expected.every(tokenSeen) : expected.some(tokenSeen);
  if (direct) return true;
  // Some Salesforce producers own a differently named bottle brand. These
  // relationships are explicit: inferring them from catalog-name overlap made
  // appellations such as Chambolle-Musigny look like producer aliases.
  return isBottleBrandAlias(wine, identity.producerBrand);
}

function conflictReasonCode(conflict) {
  const text = String(conflict || '').toLowerCase();
  if (!text) return '';
  if (text.includes('producer')) return 'PRODUCER_CONFLICT';
  if (text.includes('cuvee') || text.includes('tell this apart')) return 'SIBLING_CUVEE_CONFLICT';
  if (text.includes('variety') || text.includes('grape') || text.includes('riesling') || text.includes('chardonnay')) {
    return 'VARIETAL_CONFLICT';
  }
  if (text.includes('premier') || text.includes('tier') || text.includes('estate')) return 'TIER_CONFLICT';
  if (text.includes('style') || text.includes('rose') || text.includes('red') || text.includes('white')) {
    return 'STYLE_CONFLICT';
  }
  if (text.includes('lacks requested')) return 'PRODUCT_FACET_UNREADABLE';
  return 'PRODUCT_IDENTITY_CONFLICT';
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
  reasoningEffort = '',
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  prepareImage,
} = {}) {
  return async function readLabels(wine, candidates) {
    if (!apiKey) throw new ReaderUnavailableError('OPENAI_API_KEY is missing');
    const bounded = candidates.slice(0, 3);
    const prompt =
      'Independently transcribe the product identity printed on each bottle. ' +
      'A small inset shows the complete product shot; use it to decide whether exactly one bottle is present. ' +
      'Report only words you can actually read in the image. Do not infer missing words from visual similarity or surrounding context. ' +
      'Each image is preceded by its candidate ID. Return exactly one item for every candidate ID. ' +
      'Return only a JSON object with a readings array. Each item must be ' +
      '{"candidate_id":"the supplied ID","single_bottle":true|false,"producer_brand":"","product_cuvee":"","appellation":"","vintage":"","wine_style":"red|white|rose|unknown"}. ' +
      'Include every legible cuvee designation. Use empty strings for unreadable fields.';
    const content = [{
      type: 'text',
      text: prompt,
    }];
    for (const candidate of bounded) {
      const bytes = prepareImage
        ? await prepareImage(candidate)
        : await readFileImpl(candidate.file);
      content.push({ type: 'text', text: `Candidate ID: ${candidate.id}` });
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
        signal: AbortSignal.timeout(reasoningEffort ? 90_000 : 45_000),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          max_completion_tokens: reasoningEffort ? 4000 : 1200,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'bottle_identity_readings',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['readings'],
                properties: {
                  readings: {
                    type: 'array',
                    minItems: bounded.length,
                    maxItems: bounded.length,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: [
                        'candidate_id', 'single_bottle', 'producer_brand', 'product_cuvee',
                        'appellation', 'vintage', 'wine_style',
                      ],
                      properties: {
                        candidate_id: { type: 'string' },
                        single_bottle: { type: 'boolean' },
                        producer_brand: { type: 'string' },
                        product_cuvee: { type: 'string' },
                        appellation: { type: 'string' },
                        vintage: { type: 'string' },
                        wine_style: { type: 'string', enum: ['red', 'white', 'rose', 'unknown'] },
                      },
                    },
                  },
                },
              },
            },
          },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
      });
    } catch (error) {
      throw new ReaderUnavailableError(String(error?.message || error).split('\n')[0]);
    }
    if (!response.ok) throw new ReaderUnavailableError(`HTTP ${response.status}`);

    let payload;
    try { payload = await response.json(); } catch { throw new ReaderUnavailableError('unreadable response body'); }
    const responseText = String(payload.choices?.[0]?.message?.content || '');
    const readings = parseRows(responseText);
    const mappedReadings = readingsByCandidate(bounded, readings);
    const responseCardinalityValid = mappedReadings.every(Boolean);
    const evidence = [];
    for (let index = 0; index < bounded.length; index++) {
      const candidate = bounded[index];
      const identity = parseVisionFields(JSON.stringify(mappedReadings[index] || {}));
      if (!identity) {
        evidence.push({
          id: candidate.id,
          anchor: false,
          productAnchor: false,
          explicitConflict: false,
          readStatus: 'invalid',
          reasonCode: 'READER_RESPONSE_INVALID',
        });
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
      const visibleVintageConflict = vintageConflict(wine.vintage, identity.vintage) ||
        vintageConflict(wine.vintage, localVintage);
      const sourceVintageMismatch = sourceVintageConflict(wine, candidate);
      const incompleteIdentity = /lacks requested|lacks requested estate/i.test(identityProblem);
      const hardIdentityProblem = incompleteIdentity ? '' : identityProblem;
      const productConflict = varietalConflict(wine, candidate, identity) ||
        styleConflict(wine, candidate, identity) ||
        hardIdentityProblem ||
        (siblingConflict ? verdict.conflict : '') ||
        (identity.identityMatch === false ? 'reader identified a different product' : '');
      const producerProven = hasProducerEvidence(wine, identity);
      const confirmed = producerProven && (verdict.accept === true ||
        (!identityProblem && hasProductEvidence(verifierWine, identity.text)));
      const productAnchor = confirmed && !productConflict && !incompleteIdentity;
      const vintageStatus = visibleVintageConflict
        ? 'wrong-visible'
        : identity.vintage || localVintage ? 'exact' : 'neutral';
      const conflict = productConflict || visibleVintageConflict;
      const reasonCode = visibleVintageConflict
        ? 'VISIBLE_WRONG_VINTAGE'
        : conflictReasonCode(productConflict) ||
          (incompleteIdentity ? 'PRODUCT_FACET_UNREADABLE' : '') ||
          (!producerProven ? 'BOTTLE_BRAND_ALIAS_UNKNOWN' : '') ||
          (!confirmed ? 'PRODUCT_TEXT_UNREADABLE' : '');
      evidence.push({
        id: candidate.id,
        anchor: productAnchor && !visibleVintageConflict,
        productAnchor,
        vintageStatus,
        readStatus: 'ok',
        // A verifier failure means only "not proven." It is not evidence that
        // a different wine is printed on the bottle. Explicit contradiction
        // comes from a readable wrong identity or wrong vintage.
        explicitConflict: Boolean(conflict),
        label: identity.text,
        visibleVintage: identity.vintage,
        localVisibleVintage: localVintage,
        identityMatch: identity.identityMatch,
        sourceVintageMismatch: sourceVintageMismatch || undefined,
        reasonCode: reasonCode || undefined,
        conflict: conflict || undefined,
      });
    }
    // Diagnostic metadata rides beside the array so existing callers keep the
    // small evidence interface. The selector copies it into trace.json only
    // when tracing is enabled; API credentials and image bytes are excluded.
    evidence.readerTrace = {
      model,
      reasoningEffort,
      candidateIds: bounded.map((candidate) => candidate.id),
      prompt,
      response: responseText,
      parsed: readings,
      responseCardinalityValid,
      responseId: String(payload.id || ''),
      usage: payload.usage || null,
    };
    return evidence;
  };
}
