// Unit tests for the old-site prose extractor.
//
// The old finevines.com carried authoritative importer/producer copy per
// product page — vinification detail, yields, tasting notes, and the
// occasional critic quote. This tool splits that copy into three buckets
// (facts / producerCopy / quotes) so each can be judged and rendered on its
// own terms rather than being blended into one undifferentiated blob and
// silently presented as Fine Vines' own words.
//
// Being wrong here is silent: a village Pommard's prose landing on a 1er Cru
// row, a critic's tasting note rendering as if Fine Vines wrote it, or a
// guessed soil type with no source in the page at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchWines,
  extractQuote,
  isBareScore,
  extractFacts,
  extractProducerCopy,
  buildExtracted,
} from '../../tools/oldsiteharvest/prose-extract.mjs';

describe('matchWines — bidirectional exact token equality', () => {
  const wines = [
    { sku: 'A1', slug: 'anne-parent-pommard-croix-noires', producer: 'Anne Parent', name: 'Domaine Anne Parent Pommard 1er Cru Croix Noires', vintage: '2018' },
    { sku: 'A2', slug: 'anne-parent-pommard-epenots', producer: 'Anne Parent', name: 'Domaine Anne Parent Pommard 1er Cru les Epenots', vintage: '2018' },
    { sku: 'A2v2', slug: 'anne-parent-pommard-epenots-2019', producer: 'Anne Parent', name: 'Domaine Anne Parent Pommard 1er Cru les Epenots', vintage: '2019' },
  ];

  test('pairs a page with the one wine whose tokens match exactly', () => {
    const hits = matchWines('Domaine Anne Parent Pommard 1er Cru Croix Noires', wines);
    assert.deepEqual(hits.map((w) => w.sku), ['A1']);
  });

  test('refuses a cuvée-level mismatch: village Pommard vs 1er Cru named vineyard', () => {
    // The exact incident from localmatch.mjs's own history: a village-level
    // title must not pair with a 1er Cru row just because the producer and
    // village both match — the named vineyard is the identifying token.
    const hits = matchWines('Domaine Anne Parent Pommard', wines);
    assert.deepEqual(hits, []);
  });

  test('no edit-distance tolerance: Genevrieres Dessus does not match Genevrieres Dessous', () => {
    const dessusDessous = [
      { sku: 'D1', slug: 'genevrieres-dessus', producer: 'Domaine X', name: 'Meursault Genevrieres Dessus' },
      { sku: 'D2', slug: 'genevrieres-dessous', producer: 'Domaine X', name: 'Meursault Genevrieres Dessous' },
    ];
    const hits = matchWines('Domaine X Meursault Genevrieres Dessus', dessusDessous);
    assert.deepEqual(hits.map((w) => w.sku), ['D1']);
  });

  test('a vintage-stripped title legitimately attaches to every vintage row of that cuvée', () => {
    const hits = matchWines('Domaine Anne Parent Pommard 1er Cru les Epenots', wines);
    assert.deepEqual(hits.map((w) => w.sku).sort(), ['A2', 'A2v2']);
  });

  test('a title with fewer than 2 identifying tokens matches nothing', () => {
    assert.deepEqual(matchWines('Wine', wines), []);
  });
});

describe('extractQuote — whole-paragraph quotation vs a phrase-level curly quote', () => {
  test('a paragraph wrapped almost entirely in quote marks, with a critic tail, lands in quotes', () => {
    const text = '“There’s a thread of mountain herbs here, sitting amid ripe plums and blackcurrant. Drink or hold.” - James Suckling (April 2019), 90 pts';
    const q = extractQuote(text);
    assert.ok(q, 'expected a quote to be extracted');
    assert.match(q.quote, /thread of mountain herbs/);
    assert.equal(q.attribution, 'James Suckling');
  });

  test('a curly quote used mid-sentence for a phrase is not a tasting-note quote', () => {
    // The exact trap named in the task: "Altocedro means "tall cedar,"" is an
    // etymology aside inside ordinary marketing prose, not a quoted note.
    const text = 'We strive for a La Consulta-terroir driven Malbec that is fresh, fruit-forward, and easy-to-drink. Altocedro means “tall cedar,” and represents both winemaker and owner Karim Mussi Saffie’s Lebanese-Argentine heritage.';
    assert.equal(extractQuote(text), null);
  });

  test('a quote with no named critic still lands in quotes, with no attribution', () => {
    const text = '“Fermented with indigenous yeasts in concrete vats… the palate is juicy, fresh and tasty… delicious.”';
    const q = extractQuote(text);
    assert.ok(q);
    assert.equal(q.attribution, undefined);
  });

  test('a "Name: " label immediately before a quote that fills the rest of the paragraph is captured with attribution', () => {
    const text = 'Allen Meadows: “A more deeply pitched nose is composed by plum, earth, pepper, spice.”';
    const q = extractQuote(text);
    assert.ok(q);
    assert.equal(q.attribution, 'Allen Meadows');
    assert.match(q.quote, /deeply pitched nose/);
  });

  test('a name followed by narrative prose that merely contains a short embedded quote is not captured', () => {
    // "Anne Parent notes "..."" — substantial text precedes the quote outside
    // any colon-delimited label, so the quote marks do not wrap "essentially
    // the whole paragraph".
    const text = 'Anne Parent notes “the wines have a presence, a life if you will, that is rarely seen and makes them wonderfully satisfying.”';
    assert.equal(extractQuote(text), null);
  });

  test('a plain narrative paragraph with an apostrophe is not a quote', () => {
    const text = "Bonneau du Martray’s Corton-Charlemagne is a difficult wine to describe, taking a decade before it opens up.";
    assert.equal(extractQuote(text), null);
  });
});

describe('isBareScore — an unsourced numeric score is dropped, never guessed into a bucket', () => {
  test('a bare score with no critic or publication is flagged for drop', () => {
    assert.equal(isBareScore('92 points'), true);
    assert.equal(isBareScore('93/100'), true);
  });

  test('a score with an identifiable source is not a bare score', () => {
    assert.equal(isBareScore('92 points - James Suckling'), false);
    assert.equal(isBareScore('"Delicious." - Wine Spectator, 93/100'), false);
  });

  test('ordinary prose with no score at all is not a bare score', () => {
    assert.equal(isBareScore('Aged 18 months in French oak, 50% new.'), false);
  });
});

describe('extractFacts — a fact key is emitted only when literally present in the source', () => {
  test('parses a labelled Vineyards / Soil pair from concatenated label text', () => {
    const paras = [{ kind: 'description', text: 'Vineyards: La Consulta, Valle de Uco, MendozaSoil: Alluvial, sandy loam, rocky bottom' }];
    const facts = extractFacts(paras);
    assert.equal(facts.vineyard, 'La Consulta, Valle de Uco, Mendoza');
    assert.equal(facts.soil, 'Alluvial, sandy loam, rocky bottom');
  });

  test('given text with no soil mentioned, soil is absent rather than guessed', () => {
    const paras = [{ kind: 'description', text: 'A stunning value from Bandol - hand-harvested at low yields of 36hL/ha.' }];
    const facts = extractFacts(paras);
    assert.equal('soil' in facts, false);
    assert.equal('vineyard' in facts, false);
  });

  test('parses an inline yield expressed as hL/ha with no label at all', () => {
    const paras = [{ kind: 'description', text: 'A stunning value from Bandol - hand-harvested at low yields of 36hL/ha. Entirely destemmed, 22 day fermentation.' }];
    const facts = extractFacts(paras);
    assert.equal(facts.yield, '36hL/ha');
    assert.equal(facts.harvestMethod, 'hand-harvested');
  });

  test('parses an aging clause with duration and new-oak percentage as a literal sentence', () => {
    const paras = [{
      kind: 'vinification',
      text: "Vinification: 100% de-stemmed, cold maceration, 18 days' fermentation in open wood tank. 18 months' aging on lees in oak barrels (50% new oak), racked once.",
    }];
    const facts = extractFacts(paras);
    assert.match(facts.aging, /18 months' aging on lees in oak barrels \(50% new oak\)/);
  });

  test('parses a Total Production label into productionVolume', () => {
    const paras = [{ kind: 'description', text: 'Hand picked and hand sorted. Total Production: 750 cases' }];
    const facts = extractFacts(paras);
    assert.equal(facts.productionVolume, '750 cases');
  });

  test('never fabricates a fact key that has no supporting text anywhere in the source', () => {
    const paras = [{ kind: 'description', text: 'A pleasant, easy-drinking red for weeknight dinners.' }];
    const facts = extractFacts(paras);
    assert.deepEqual(facts, {});
  });
});

describe('extractProducerCopy — the producer/importer\'s own marketing voice', () => {
  test('captures a first-person "We/Our" paragraph verbatim', () => {
    const paras = [{ kind: 'description', text: 'We strive for a La Consulta-terroir driven Malbec that is fresh, fruit-forward, and easy-to-drink.' }];
    const copy = extractProducerCopy(paras);
    assert.deepEqual(copy, ['We strive for a La Consulta-terroir driven Malbec that is fresh, fruit-forward, and easy-to-drink.']);
  });

  test('strips a "Label Notes:" prefix and keeps the remainder', () => {
    const paras = [{ kind: 'description', text: 'Label Notes: Altocedro means “tall cedar,” and represents the owner’s heritage.' }];
    const copy = extractProducerCopy(paras);
    assert.deepEqual(copy, ['Altocedro means “tall cedar,” and represents the owner’s heritage.']);
  });

  test('third-person historical prose that is neither first-person nor labelled is not producer copy', () => {
    const paras = [{ kind: 'description', text: 'The name Chambolle comes from the French word describing the aspect of the foaming stream.' }];
    assert.deepEqual(extractProducerCopy(paras), []);
  });
});

describe('buildExtracted — end-to-end wiring, matching + bucketing together', () => {
  const wines = [
    { sku: 'S1', slug: 'altocedro-malbec', producer: 'Altocedro', name: 'Altocedro Malbec La Consulta Mendoza', vintage: '2019' },
  ];
  const manifest = [
    {
      oldPath: '/portfolio/altocedro/altocedro-malbec-la-consulta-mendoza',
      title: 'Altocedro Malbec La Consulta Mendoza',
      paras: [
        { kind: 'description', text: 'We strive for a La Consulta-terroir driven Malbec that is fresh, fruit-forward, and easy-to-drink. Total Production: 750 cases' },
        { kind: 'description', text: '“Fermented with indigenous yeasts in concrete vats… delicious.”' },
      ],
      chars: 200,
    },
  ];

  test('produces one entry per matched wine with sourceUrl reconstructed and all three buckets present', () => {
    const { extracted, dropped } = buildExtracted(manifest, wines);
    assert.equal(extracted.length, 1);
    const e = extracted[0];
    assert.equal(e.sku, 'S1');
    assert.equal(e.sourceUrl, 'https://www.finevines.com/portfolio/altocedro/altocedro-malbec-la-consulta-mendoza');
    assert.equal(e.facts.productionVolume, '750 cases');
    assert.equal(e.producerCopy.length, 1);
    assert.equal(e.quotes.length, 1);
    assert.deepEqual(dropped, []);
  });

  test('a page matching no wine contributes nothing and is not an error', () => {
    const { extracted } = buildExtracted(manifest, []);
    assert.deepEqual(extracted, []);
  });
});
