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

// ---------------------------------------------------------------------------
// Concatenation repair — the old site's markup sometimes ran two labelled
// fields together with no separator at all: "...MendozaSoil: Alluvial..."
// (a "Vineyards:" value glued directly onto a following "Soil:" label) or
// "...winery.Total Production: 750 cases" (ordinary prose glued onto a
// following "Total Production:" label). labelValue's own regex has no
// leading word-boundary requirement, so it already parses the label OUT
// correctly either way — but a field's *stop* boundary (used to know where
// its OWN value ends) only recognizes the labels listed in ALL_LABELS, and
// "total production" isn't among them. Inserting a paragraph break wherever
// a recognized, Title-Case "Label:" starts flush against the previous
// character (no whitespace) turns every such case into an ordinary
// newline-terminated field, which every label regex below already treats as
// a hard stop (`\n` is in the stop lookahead) regardless of which specific
// labels are cross-listed against which — fixing the display glitch AND any
// stop-boundary gap in one place, rather than enumerating every label pair.
const TITLE_CASE_LABELS = [
  'Vineyards?', 'Soil', 'Nature of the Soil', 'Varietal', 'Varieties',
  'Sustainably Farmed', 'Yield', 'Age of Vines', 'Harvest', 'Vinification',
  'Aging', 'Ageing', 'Duration and Aging Method', 'Total Production', 'Production',
];
// Zero-width: fires only when the label is NOT already at the start of the
// string and NOT already preceded by whitespace — i.e. exactly the
// glued-together case, never a normal "sentence. Label:" paragraph (which
// already has a space before the label and is left untouched).
const CONCATENATED_LABEL_RE = new RegExp(`(?<!^)(?<!\\s)(?=(?:${TITLE_CASE_LABELS.join('|')})\\s*:)`, 'g');

export function splitConcatenatedLabels(text) {
  return text.replace(CONCATENATED_LABEL_RE, '\n');
}

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
  // The harvested paragraph almost always opens with its own redundant
  // "Vinification:" (or "Vinification & Ageing:") label — the dl already
  // supplies that label via oldSiteFactLabels on the Go side, so keeping it
  // baked into the value would print it twice in the SAME <dd>. Strip only
  // that leading label; the rest of the paragraph is kept verbatim.
  const vinificationParas = paragraphs
    .filter((p) => p.kind === 'vinification')
    .map((p) => p.text.trim().replace(/^vinification(?:\s*(?:&|and)\s*ag(?:e)?ing)?\s*:\s*/i, ''));
  if (vinificationParas.length) facts.vinification = vinificationParas.join(' ');

  return facts;
}

// ---------------------------------------------------------------------------
// Stripping fact spans out of paragraph text. extractFacts above LIFTS a
// fact out of a paragraph; left alone, the paragraph itself still carries
// the same text into producerCopy/tastingNote, so the reader sees it twice —
// once cleanly parsed and labelled, once raw (and, before
// splitConcatenatedLabels, mangled: "MendozaSoil:"). Only STRUCTURALLY
// SELF-CONTAINED spans are ever removed here — a labelled "Label: value"
// token, a whole vinification paragraph (consumed wholesale by
// facts.vinification), or a whole sentence (the aging sentence-fallback,
// bounded by real sentence punctuation) — never a bare number or short
// phrase sitting inside an otherwise ordinary sentence (yieldInline's
// "36hL/ha", the hand-harvested phrase, the inline production phrase),
// because cutting one of those out would leave a grammatically broken
// sentence behind. Each guard below only fires when the paragraph's OWN
// labelled span is the kind of value that would actually have produced the
// fact (e.g. a "Yield:" label whose value looks like hL/ha, not "Yield: low")
// so nothing is ever deleted without having been preserved in `facts` first.
// ---------------------------------------------------------------------------

const STOP_LABELS = [...ALL_LABELS, 'total production'];

function labelSpanSource(labels, stopLabels) {
  const stop = stopLabels.join('|');
  return `(?:${labels.join('|')})\\s*:\\s*[^\\n]+?(?=\\s*(?:${stop})\\s*:|\\n|$)`;
}

// Removes every occurrence of a labelled "Label: value" field from text.
// Mirrors labelValue's own regex exactly (same label alternation, same
// stop-boundary lookahead) so whatever this strips is EXACTLY what
// labelValue would have captured as the fact's value — never more, never
// less — just with the label word included, since the whole token is
// redundant once its value lives in `facts`.
function stripLabelSpans(text, labels) {
  return text.replace(new RegExp(labelSpanSource(labels, STOP_LABELS), 'gi'), '');
}

function labelSpanValue(text, labels) {
  const m = text.match(new RegExp(labelSpanSource(labels, STOP_LABELS), 'i'));
  if (!m) return null;
  return m[0].replace(new RegExp(`^(?:${labels.join('|')})\\s*:\\s*`, 'i'), '').trim();
}

// Punctuation/whitespace only — what's left of a paragraph after every fact
// span has been cut out of it, when there was nothing else there to begin
// with (the concatenated-label case: a paragraph that was ONLY "Vineyards:
// ... Soil: ...", nothing more).
const BLANK_RE = /^[\s.,;:!?'’"“”()\-–—]*$/;

// stripFactSpans returns paragraphs with every fact span already captured
// into `facts` removed, and drops a paragraph entirely once nothing but
// punctuation/whitespace is left of it — that paragraph's entire substance
// now lives in `facts`, so keeping an empty <p> around would be a stray,
// pointless element on the page. Expects paragraphs whose text has already
// been through splitConcatenatedLabels (see buildExtracted).
export function stripFactSpans(paragraphs, facts) {
  const out = [];
  for (const p of paragraphs) {
    // A vinification-kind paragraph is consumed WHOLE by facts.vinification
    // (extractFacts joins every such paragraph verbatim) — none of it
    // belongs in tastingNote/producerCopy once captured.
    if (p.kind === 'vinification' && facts.vinification) continue;

    let text = p.text;
    if (facts.vineyard) text = stripLabelSpans(text, ['vineyards?']);
    if (facts.soil) text = stripLabelSpans(text, ['soil', 'nature of the soil']);
    if (facts.yield) {
      const v = labelSpanValue(text, ['yield']);
      if (v && /hl\s*\/\s*ha/i.test(v)) text = stripLabelSpans(text, ['yield']);
    }
    if (facts.harvestMethod) {
      const v = labelSpanValue(text, ['harvest']);
      if (v && /^(hand|manual)/i.test(v)) text = stripLabelSpans(text, ['harvest']);
    }
    if (facts.aging) {
      text = stripLabelSpans(text, ['aging', 'duration and aging method']);
      // The sentence-fallback form is a whole sentence, not a "Label:"
      // token — remove it by exact match rather than by label pattern.
      if (text.includes(facts.aging)) text = text.split(facts.aging).join('');
    }
    if (facts.productionVolume) text = stripLabelSpans(text, ['total production']);
    // The old site occasionally repeats its OWN vinification sentence
    // verbatim inside a second, unrelated paragraph that mixes several
    // topics together with no labels at all beyond its own opening word
    // (e.g. a "Maturing:" paragraph that runs Maturing + vinification detail
    // + vine age + vineyard situation together as one blob — a genuinely
    // different source-side duplication, not the concatenated-label bug
    // above). That paragraph is NOT kind==='vinification', so the whole-
    // paragraph guard above never sees it; an exact-substring removal here
    // catches it the same safe way the aging sentence-fallback does — the
    // sentence is bounded by real sentence punctuation on both sides, so
    // cutting it out leaves the surrounding prose grammatically intact.
    if (facts.vinification && p.kind !== 'vinification' && text.includes(facts.vinification)) {
      text = text.split(facts.vinification).join('');
    }

    // Collapse any newline splitConcatenatedLabels inserted but that didn't
    // end up consumed above (e.g. a labelled field that was NOT captured as
    // a fact, and so is deliberately left in place) back into ordinary
    // running text, rather than leaving a raw line break in rendered prose.
    text = text.replace(/\s*\n+\s*/g, ' ').trim();

    if (!text || BLANK_RE.test(text)) continue;
    out.push(text === p.text ? p : { ...p, text });
  }
  return out;
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

    // Repair glued-together labels ("...MendozaSoil:", "winery.Total
    // Production:") once, up front, so every bucket below sees the same
    // cleanly-separated paragraphs — extraction, span-stripping, and
    // bucketing can never disagree about where one field ends and the next
    // begins.
    const paras = page.paras.map((p) => ({ ...p, text: splitConcatenatedLabels(p.text) }));

    const facts = extractFacts(paras);
    // Once a fact has been lifted out of a paragraph, the paragraph itself
    // must not ALSO carry it into producerCopy/tastingNote/quotes — see
    // stripFactSpans's doc comment.
    const cleaned = stripFactSpans(paras, facts);
    const producerCopy = extractProducerCopy(cleaned);
    const tastingNote = extractTastingNote(cleaned);
    const quotes = [];

    for (const p of cleaned) {
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
