// Turn the old site's per-wine prose (data/oldsite-prose/manifest.json) into
// structured, attributable content for the FineVines catalog.
//
// The catalog's current description/sommelierNotes/aroma/palate fields are
// AI-generated from web search. The old finevines.com pages carry the
// importer's own authoritative copy instead, but it is NOT uniform: it mixes
// four things that carry different authority and must be rendered
// differently —
//
//   1. facts        — measurable detail (soil, yield, aging, production...)
//                      that a language model must never invent.
//   2. producerCopy  — the producer/importer's own first-person marketing
//                      voice ("We strive for...", "Label Notes: ...").
//   3. quotes        — third-party tasting notes, wrapped in quotation marks
//                      in the source, sometimes attributed to a named critic.
//   4. tastingNote   — third-person editorial prose about the wine or its
//                      site that is neither producer voice nor a quotation.
//                      Originally left unbucketed on the theory it was
//                      leftover filler; it turned out to be the best writing
//                      on the page ("This vineyard sits next to Musigny...").
//                      The distinction from producerCopy is voice, not
//                      content — first person stays producerCopy even when
//                      it reads like tasting prose; everything else
//                      substantive that isn't a quote lands here.
//
// This module proposes the split; it does not write into data/wines.json.
// Adoption is a separate decision.
//
//   node tools/oldsiteharvest/prose-extract.mjs           # write extracted.json + print counts
//   node tools/oldsiteharvest/prose-extract.mjs --dry-run # print counts only

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { titleMatchesWine } from './tokenmatch.mjs';

const OLD = 'https://www.finevines.com';

// ---------------------------------------------------------------------------
// Matching — thin wrapper around the shared bidirectional token rule.
// ---------------------------------------------------------------------------

// Returns every wine row whose producer+name token set exactly equals the
// page title's token set. A vintage-stripped title legitimately matches
// several vintages of the same cuvée — that is expected, not ambiguity.
export function matchWines(title, wines) {
  return wines.filter((w) => titleMatchesWine(title, w));
}

// ---------------------------------------------------------------------------
// Quotes — bucket 3. A paragraph belongs here only when the quotation marks
// wrap essentially the whole paragraph, not a phrase inside otherwise
// ordinary prose.
// ---------------------------------------------------------------------------

const OPEN_QUOTE = /["“]/;
const CLOSE_QUOTE_CHARS = ['"', '”'];

const CRITIC_STOPWORDS = new Set(['and', 'the', 'a', 'an']);

// Trims a captured attribution string down to just the name/publication,
// dropping trailing dates, points, and parentheticals.
function cleanAttribution(raw) {
  let s = raw.trim();
  s = s.replace(/^[-–—,;:\s]+/, ''); // leading dash/comma/colon
  s = s.replace(/\(.*$/, '').trim(); // drop a trailing parenthetical onward
  s = s.replace(/,.*$/, '').trim(); // drop trailing ", 90 pts" etc.
  s = s.replace(/[.\s]+$/, '').trim();
  return s;
}

export function extractQuote(text) {
  const t = (text || '').trim();
  if (!t) return null;

  // An optional "Name: " label immediately before the quote (e.g. "Allen
  // Meadows: “...”"). Kept short and colon-delimited so it cannot swallow
  // ordinary narrative sentences that merely happen to contain a quote.
  const labelMatch = t.match(/^([A-Z][A-Za-z.'’\- ]{1,40}):\s*/);
  const afterLabel = labelMatch ? t.slice(labelMatch[0].length) : t;
  const label = labelMatch ? labelMatch[1].trim() : null;

  if (!OPEN_QUOTE.test(afterLabel[0] || '')) return null;

  const body = afterLabel.slice(1);
  let closeIdx = -1;
  for (const ch of CLOSE_QUOTE_CHARS) {
    const idx = body.lastIndexOf(ch);
    if (idx > closeIdx) closeIdx = idx;
  }
  if (closeIdx < 0) return null;

  const quote = body.slice(0, closeIdx).trim();
  if (quote.length < 20) return null; // too short to be a real tasting note

  const trailing = body.slice(closeIdx + 1).trim();

  // The quote must wrap "essentially the whole paragraph": any label prefix
  // must be short, and anything after the closing mark must read as a
  // trailing attribution, not a resumption of narrative prose.
  if (label === null && labelMatch) return null; // unreachable guard
  if (trailing.length > 80) return null;
  if (trailing && !/^[-–—(,]/.test(trailing) && !/^[A-Z][a-z]+ [A-Z]/.test(trailing)) {
    // Trailing text that isn't dash/paren-led and isn't itself a "Name ..."
    // attribution is treated as unrelated prose glued onto the paragraph —
    // reject rather than guess.
    return null;
  }

  const result = { quote };

  if (label) {
    result.attribution = label;
  } else if (trailing) {
    const attrMatch = trailing.match(/^[-–—(]*\s*([A-Z][A-Za-z.'’]*(?:\s+[A-Z][A-Za-z.'’]*){0,4})/);
    if (attrMatch) {
      const name = cleanAttribution(attrMatch[1]);
      if (name && !CRITIC_STOPWORDS.has(name.toLowerCase())) result.attribution = name;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Bare numeric scores — dropped entirely, never guessed into a bucket.
// ---------------------------------------------------------------------------

const SOURCE_WORDS = /wine spectator|parker|advocate|vinous|suckling|decanter|jancis|burghound|enthusiast|galloni|dunnuck|tanzer|atkin|meadows|basset|neal|wasserman|coates|feiring|robinson|asimov|molesworth|laube|steiman|competition|comp\.|fair|medal/i;

export function isBareScore(text) {
  const t = (text || '').trim();
  const hasScore = /\b\d{2,3}\s*(?:points?|pts?)\b/i.test(t) || /\b\d{2,3}\s*\/\s*100\b/i.test(t);
  if (!hasScore) return false;
  if (SOURCE_WORDS.test(t)) return false;
  if (extractQuote(t)) return false; // a sourced/quoted tasting note, not bare
  // A "bare" score paragraph is dominated by the score itself, not wrapped in
  // substantial independent prose (which would suggest an uncaptured but
  // still-sourced critic note rather than a lone number).
  return t.length < 120;
}

// ---------------------------------------------------------------------------
// Facts — bucket 1. Parsed only where the value is literally present.
// ---------------------------------------------------------------------------

// No leading word-boundary requirement before the label: the harvested text
// sometimes concatenates adjacent labels with no separating whitespace at
// all ("...MendozaSoil: Alluvial..."), so "Soil:" must still be found
// immediately after "Mendoza". The mandatory trailing colon keeps this from
// matching label words that merely appear inside running prose.
function labelValue(corpus, labels, stopLabels) {
  const stop = stopLabels.join('|');
  const re = new RegExp(`(?:${labels.join('|')})\\s*:\\s*([^\\n]+?)(?=\\s*(?:${stop})\\s*:|\\n|$)`, 'i');
  const m = corpus.match(re);
  return m ? m[1].trim().replace(/[.\s]+$/, '') : null;
}

const ALL_LABELS = ['vineyards?', 'soil', 'nature of the soil', 'varietal', 'varieties', 'sustainably farmed', 'yield', 'age of vines', 'harvest', 'vinification', 'aging', 'duration and aging method'];

export function extractFacts(paragraphs) {
  const corpus = paragraphs.map((p) => p.text).join('\n');
  const facts = {};

  const vineyard = labelValue(corpus, ['vineyards?'], ALL_LABELS);
  if (vineyard) facts.vineyard = vineyard;

  const soil = labelValue(corpus, ['soil', 'nature of the soil'], ALL_LABELS);
  if (soil) facts.soil = soil;

  const yieldLabel = labelValue(corpus, ['yield'], ALL_LABELS);
  const yieldInline = corpus.match(/(\d+(?:\.\d+)?\s*hl\s*\/\s*ha)/i);
  if (yieldLabel && /hl\s*\/\s*ha/i.test(yieldLabel)) facts.yield = yieldLabel;
  else if (yieldInline) facts.yield = yieldInline[1];

  const handPhrase = corpus.match(/\bhand[- ](?:harvested|picked|sorted)\b/i);
  const harvestLabel = labelValue(corpus, ['harvest'], ALL_LABELS);
  if (handPhrase) facts.harvestMethod = handPhrase[0].replace(/ /g, '-').toLowerCase();
  else if (harvestLabel && /^(hand|manual)/i.test(harvestLabel)) facts.harvestMethod = harvestLabel;

  // Aging: capture the literal clause carrying a duration + "aging"/"aged"
  // near an oak/barrel/tank/lees mention, rather than a synthesized summary.
  const agingLabel = labelValue(corpus, ['aging', 'duration and aging method'], ALL_LABELS);
  if (agingLabel) {
    facts.aging = agingLabel;
  } else {
    const sentences = corpus.split(/(?<=[.!?])\s+|\n/);
    const agingSentence = sentences.find(
      (s) => /\d+\s*(?:months?|years?)['’]?\s*(?:of\s+)?(?:aging|ageing|aged)|(?:aging|ageing|aged)[^.]*\d+\s*(?:months?|years?)/i.test(s) &&
        /oak|barrel|lees|tank|cask|foudre|bottle/i.test(s)
    );
    if (agingSentence) facts.aging = agingSentence.trim();
  }

  // Production volume: an explicit label, or an inline "production ... N
  // bottles/cases" phrase.
  const totalProduction = labelValue(corpus, ['total production'], ALL_LABELS);
  const inlineProduction = corpus.match(/production\s+(?:of\s+|around\s+)?(?:about\s+)?([\d,]+\s*(?:bottles|cases))/i);
  if (totalProduction) facts.productionVolume = totalProduction;
  else if (inlineProduction) facts.productionVolume = inlineProduction[1].trim();

  // Vinification: a general catch-all for any paragraph the harvest already
  // labelled as a vinification section, kept verbatim rather than re-parsed
  // further once the specific fields above have had first pick at it.
  const vinificationParas = paragraphs.filter((p) => p.kind === 'vinification').map((p) => p.text.trim());
  if (vinificationParas.length) facts.vinification = vinificationParas.join(' ');

  return facts;
}

// ---------------------------------------------------------------------------
// Producer copy — bucket 2. First-person marketing voice, or explicitly
// labelled "Label Notes:".
// ---------------------------------------------------------------------------

const LABEL_NOTES_PREFIX = /^label notes\s*:\s*/i;
const FIRST_PERSON_OPEN = /^(we|our)\b/i;

// The voice test shared with extractTastingNote: is this paragraph the
// producer/importer speaking about their own wine? Voice, not content — a
// paragraph that reads like tasting prose still counts as producerCopy if it
// opens in the first person plural. Kept as one predicate so the two buckets
// can never disagree about where a given paragraph belongs.
function isProducerVoice(text) {
  return LABEL_NOTES_PREFIX.test(text) || FIRST_PERSON_OPEN.test(text);
}

export function extractProducerCopy(paragraphs) {
  const out = [];
  for (const p of paragraphs) {
    const t = p.text.trim();
    const labelMatch = t.match(LABEL_NOTES_PREFIX);
    if (labelMatch) {
      out.push(t.slice(labelMatch[0].length).trim());
      continue;
    }
    if (FIRST_PERSON_OPEN.test(t)) {
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tasting note — bucket 4. Third-person editorial prose about the wine or
// its site: substantive, specific, evocative, but neither the producer's own
// voice (bucket 2) nor a quoted third party (bucket 3). Everything that
// clears the harvest's own length floor and isn't claimed by one of the
// other three buckets belongs here — this is deliberately the catch-all for
// "real prose with nowhere else to go" rather than a narrowly-patterned
// bucket, because the disqualifying tests (voice, quotation, bare score) are
// what carry the actual judgment.
// ---------------------------------------------------------------------------

export function extractTastingNote(paragraphs) {
  const out = [];
  for (const p of paragraphs) {
    const t = p.text.trim();
    if (!t) continue;
    if (isProducerVoice(t)) continue; // bucket 2 already has this — voice wins on a mix
    if (extractQuote(t)) continue; // bucket 3 already has this
    if (isBareScore(t)) continue; // dropped, not narrative
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// End-to-end wiring.
// ---------------------------------------------------------------------------

function sourceUrl(oldPath) {
  return OLD + oldPath;
}

export function buildExtracted(manifest, wines) {
  const bySku = new Map();
  const dropped = [];

  for (const page of manifest) {
    if (!page.title || !page.paras || !page.paras.length) continue;
    const hits = matchWines(page.title, wines);
    if (!hits.length) continue;

    const facts = extractFacts(page.paras);
    const producerCopy = extractProducerCopy(page.paras);
    const tastingNote = extractTastingNote(page.paras);
    const quotes = [];

    for (const p of page.paras) {
      const t = p.text.trim();
      if (isBareScore(t)) {
        dropped.push({ oldPath: page.oldPath, reason: 'bare-numeric-score', text: t });
        continue;
      }
      const q = extractQuote(t);
      if (q) quotes.push(q);
    }

    for (const wine of hits) {
      const entry = {
        sku: wine.sku,
        slug: wine.slug,
        wineName: `${wine.producer || ''} ${wine.name || ''}`.trim(),
        sourceUrl: sourceUrl(page.oldPath),
        facts,
        producerCopy,
        quotes,
        tastingNote,
      };
      // A wine could in principle be reachable from more than one page under
      // this rule; keep the first (pages are processed in manifest order).
      if (!bySku.has(wine.sku)) bySku.set(wine.sku, entry);
    }
  }

  return { extracted: [...bySku.values()], dropped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && /prose-extract\.mjs$/.test(process.argv[1])) {
  const manifest = JSON.parse(readFileSync(join('data', 'oldsite-prose', 'manifest.json'), 'utf8'));
  const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'));
  const { extracted, dropped } = buildExtracted(manifest, wines);

  const factKeyCounts = {};
  let withFacts = 0, withProducerCopy = 0, withQuotes = 0, withTastingNote = 0, withAnyBucket = 0;
  for (const e of extracted) {
    const hasFacts = Object.keys(e.facts).length > 0;
    if (hasFacts) withFacts++;
    for (const k of Object.keys(e.facts)) factKeyCounts[k] = (factKeyCounts[k] || 0) + 1;
    if (e.producerCopy.length) withProducerCopy++;
    if (e.quotes.length) withQuotes++;
    if (e.tastingNote.length) withTastingNote++;
    if (hasFacts || e.producerCopy.length || e.quotes.length || e.tastingNote.length) withAnyBucket++;
  }

  console.log('pages in manifest       :', manifest.length);
  console.log('wines matched           :', extracted.length);
  console.log('wines with facts        :', withFacts, JSON.stringify(factKeyCounts));
  console.log('wines with producerCopy :', withProducerCopy);
  console.log('wines with quotes       :', withQuotes);
  console.log('wines with tastingNote  :', withTastingNote);
  console.log('wines with >=1 bucket   :', withAnyBucket, 'of', extracted.length, 'matched');
  console.log('dropped (bare scores)   :', dropped.length);
  dropped.forEach((d) => console.log('  dropped:', d.oldPath, '|', d.text));

  if (!process.argv.includes('--dry-run')) {
    writeFileSync(join('data', 'oldsite-prose', 'extracted.json'), JSON.stringify(extracted, null, 1));
    console.log('\nwrote data/oldsite-prose/extracted.json');
  }
}
