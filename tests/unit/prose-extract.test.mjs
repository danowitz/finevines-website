// Unit tests for the old-site prose extractor.
//
// The old finevines.com carried authoritative importer/producer copy per
// product page — vinification detail, yields, tasting notes, and the
// occasional critic quote. This tool splits that copy into three buckets
// (facts / producerCopy / quotes) so each can be judged and rendered on its
// own terms rather than being blended into one undifferentiated blob and
// silently presented as FineVines' own words.
//
// Being wrong here is silent: a village Pommard's prose landing on a 1er Cru
// row, a critic's tasting note rendering as if FineVines wrote it, or a
// guessed soil type with no source in the page at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchWines,
  extractQuote,
  isBareScore,
  extractFacts,
  extractProducerCopy,
  extractTastingNote,
  splitConcatenatedLabels,
  stripFactSpans,
  dedupeQuotesAgainstProse,
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

  test('a vinification paragraph\'s own redundant "Vinification:" label is stripped from the fact value', () => {
    // The dl already supplies the "Vinification" label (oldSiteFactLabels on
    // the Go side); keeping the source's own leading "Vinification:" baked
    // into the value would print the label twice inside one <dd>.
    const paras = [{ kind: 'vinification', text: 'Vinification: Directly pressed, indigenous yeast fermentation.' }];
    const facts = extractFacts(paras);
    assert.equal(facts.vinification, 'Directly pressed, indigenous yeast fermentation.');
  });

  test('a "Vinification & Ageing:" variant label is also stripped', () => {
    const paras = [{ kind: 'vinification', text: 'Vinification & Ageing: 12 months in stainless steel.' }];
    const facts = extractFacts(paras);
    assert.equal(facts.vinification, '12 months in stainless steel.');
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

describe('splitConcatenatedLabels — repairing glued-together fields', () => {
  test('inserts a break before a Title-Case label glued directly onto the previous word', () => {
    const text = 'Vineyards: La Consulta, Valle de Uco, MendozaSoil: Alluvial, sandy loam, rocky bottom';
    assert.equal(splitConcatenatedLabels(text), 'Vineyards: La Consulta, Valle de Uco, Mendoza\nSoil: Alluvial, sandy loam, rocky bottom');
  });

  test('inserts a break before a label glued onto the end of a sentence, punctuation and all', () => {
    const text = 'a cedar tree which towers over the winery.Total Production: 750 cases';
    assert.equal(splitConcatenatedLabels(text), 'a cedar tree which towers over the winery.\nTotal Production: 750 cases');
  });

  test('leaves an already-separated label alone (no double break)', () => {
    const text = 'Hand picked and hand sorted. Total Production: 750 cases';
    assert.equal(splitConcatenatedLabels(text), text);
  });

  test('leaves a label at the very start of the text alone', () => {
    const text = 'Soil: Alluvial, sandy loam, rocky bottom';
    assert.equal(splitConcatenatedLabels(text), text);
  });
});

describe('stripFactSpans — a fact lifted out of a paragraph must not also print raw in prose', () => {
  test('a paragraph that is ONLY concatenated labels vanishes once both facts are captured', () => {
    // The exact reported bug: this paragraph is nothing but "Vineyards: ...
    // Soil: ..." glued together — once both are parsed into facts, nothing
    // of substance is left, so the paragraph itself must not survive into
    // tastingNote at all (no empty <p>, no raw "MendozaSoil:" mangling).
    const paras = [{
      kind: 'description',
      text: splitConcatenatedLabels('Vineyards: La Consulta, Valle de Uco, MendozaSoil: Alluvial, sandy loam, rocky bottom'),
    }];
    const facts = extractFacts(paras);
    assert.equal(facts.vineyard, 'La Consulta, Valle de Uco, Mendoza');
    assert.equal(facts.soil, 'Alluvial, sandy loam, rocky bottom');
    assert.deepEqual(stripFactSpans(paras, facts), []);
  });

  test('a paragraph carrying real prose plus a glued-on fact keeps the prose, loses only the fact', () => {
    const raw = 'We strive for a Cabernet Sauvignon that is fresh and fruit-forward.' +
      ' Altocedro means "tall cedar."' +
      'Total Production: 750 cases';
    const paras = [{ kind: 'description', text: splitConcatenatedLabels(raw) }];
    const facts = extractFacts(paras);
    assert.equal(facts.productionVolume, '750 cases');
    const cleaned = stripFactSpans(paras, facts);
    assert.equal(cleaned.length, 1);
    assert.ok(!cleaned[0].text.includes('Total Production'), 'the fact span must be gone');
    assert.ok(!cleaned[0].text.includes('\n'), 'no stray line break left behind');
    assert.match(cleaned[0].text, /We strive for a Cabernet Sauvignon/);
  });

  test('an inline, unlabelled fact (yieldInline, hand-harvested phrase) is never cut out of its sentence', () => {
    // "36hL/ha" and "hand-harvested" here are NOT "Label: value" tokens —
    // they are words inside an ordinary sentence. Removing them would leave
    // grammatically broken prose behind, so stripFactSpans must leave the
    // whole sentence intact even though both facts were captured.
    const text = 'A stunning value from Bandol - hand-harvested at low yields of 36hL/ha.';
    const paras = [{ kind: 'description', text }];
    const facts = extractFacts(paras);
    assert.equal(facts.yield, '36hL/ha');
    assert.equal(facts.harvestMethod, 'hand-harvested');
    const cleaned = stripFactSpans(paras, facts);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].text, text);
  });

  test('a vinification-kind paragraph is fully consumed by facts.vinification and drops out of prose', () => {
    const text = "Vinification: 100% de-stemmed, cold maceration, 18 days' fermentation in open wood tank.";
    const paras = [{ kind: 'vinification', text }];
    const facts = extractFacts(paras);
    assert.ok(facts.vinification);
    assert.deepEqual(stripFactSpans(paras, facts), []);
  });

  test('the vinification sentence also repeated verbatim inside an unrelated mixed-topic paragraph is cut out, not the whole paragraph', () => {
    // Real shape from the Domaine Méo-Camuzet Corton les Perrières page: a
    // "Maturing:" paragraph runs several unrelated topics together with no
    // further labels, and happens to repeat the SAME sentence a separate,
    // properly kind==='vinification' paragraph also carries. The kind==
    // 'vinification' paragraph is dropped whole (previous test); this
    // second, unrelated paragraph must keep its own content and lose only
    // the repeated sentence.
    const vinificationText = 'Little intervention... Perhaps a slightly higher temperature at the end of the fermentation to extract a little fatness, while avoiding reinforcing the tannins too much.';
    const maturing = `Long. New casks suit it well. ${vinificationText} Pinots with fairly large berries, planted in 1953-54.`;
    const paras = [
      { kind: 'description', text: maturing },
      { kind: 'vinification', text: `Vinification: ${vinificationText}` },
    ];
    const facts = extractFacts(paras);
    assert.equal(facts.vinification, vinificationText);
    const cleaned = stripFactSpans(paras, facts);
    assert.equal(cleaned.length, 1, 'the vinification-kind paragraph drops out; the mixed paragraph survives');
    assert.ok(!cleaned[0].text.includes('Little intervention'), 'the repeated sentence must be gone');
    assert.match(cleaned[0].text, /New casks suit it well/);
    assert.match(cleaned[0].text, /Pinots with fairly large berries/);
  });

  test('a labelled field with no matching fact (never captured) is left in the prose untouched', () => {
    // "Harvest: mid-September" does not match the hand/manual acceptance
    // test, so extractFacts never records it — stripFactSpans must not
    // delete information that lives nowhere else in the output.
    const text = 'Harvest: mid-September, by machine.';
    const paras = [{ kind: 'description', text }];
    const facts = extractFacts(paras);
    assert.equal('harvestMethod' in facts, false);
    assert.deepEqual(stripFactSpans(paras, facts), paras);
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

describe('extractTastingNote — bucket 4: third-person editorial prose, neither producer voice nor a critic quote', () => {
  // The mis-scoped original spec called this "leftover" content; it isn't —
  // it's the site's best writing, and it fell through all three buckets
  // because it is neither first-person nor quotation-marked. Real example
  // from the coordinator's own re-read of the unbucketed 224:
  const VINEYARD_NOTE =
    'This vineyard sits next to Musigny. The quality of the site is evidenced by the first sniff of the glass, ' +
    'with a seductive perfume of violets, redcurrants and a dash of white pepper. Classically Chambolle, with a ' +
    'touch of extra roundness and flesh courtesy of the site.';

  test('a third-person editorial paragraph about the wine/site lands in tastingNote', () => {
    const paras = [{ kind: 'description', text: VINEYARD_NOTE }];
    assert.deepEqual(extractTastingNote(paras), [VINEYARD_NOTE]);
  });

  test('a first-person paragraph stays exclusively in producerCopy, not tastingNote', () => {
    const text = 'We strive for a La Consulta-terroir driven Malbec that is fresh, fruit-forward, and easy-to-drink.';
    const paras = [{ kind: 'description', text }];
    assert.deepEqual(extractProducerCopy(paras), [text]);
    assert.deepEqual(extractTastingNote(paras), []);
  });

  test('a "Label Notes:" paragraph stays exclusively in producerCopy, not tastingNote', () => {
    const text = 'Label Notes: Altocedro means “tall cedar,” and represents the owner’s heritage.';
    const paras = [{ kind: 'description', text }];
    assert.equal(extractProducerCopy(paras).length, 1);
    assert.deepEqual(extractTastingNote(paras), []);
  });

  test('a whole-paragraph quotation still goes to quotes, not swept up as narrative', () => {
    const text = '“Big and rich-tasting, with concentrated flavors of dark plum, dried blackberry and dark currant.”';
    const paras = [{ kind: 'description', text }];
    assert.ok(extractQuote(text), 'sanity: this text is a quote');
    assert.deepEqual(extractTastingNote(paras), []);
  });

  test('a bare, unsourced score is not swept into tastingNote either', () => {
    const paras = [{ kind: 'description', text: '92 points' }];
    assert.deepEqual(extractTastingNote(paras), []);
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
        { kind: 'description', text: 'This vineyard sits on a gentle east-facing slope above the village, giving the fruit an extra week of hang time most years.' },
      ],
      chars: 260,
    },
  ];

  test('produces one entry per matched wine with sourceUrl reconstructed and all four buckets present', () => {
    const { extracted, dropped } = buildExtracted(manifest, wines);
    assert.equal(extracted.length, 1);
    const e = extracted[0];
    assert.equal(e.sku, 'S1');
    assert.equal(e.sourceUrl, 'https://www.finevines.com/portfolio/altocedro/altocedro-malbec-la-consulta-mendoza');
    assert.equal(e.facts.productionVolume, '750 cases');
    assert.equal(e.producerCopy.length, 1);
    // The fact is captured in e.facts.productionVolume — it must not also
    // print raw inside the producerCopy paragraph it was lifted out of.
    assert.ok(!e.producerCopy[0].includes('Total Production'));
    assert.equal(e.quotes.length, 1);
    assert.equal(e.tastingNote.length, 1);
    assert.match(e.tastingNote[0], /gentle east-facing slope/);
    assert.deepEqual(dropped, []);
  });

  test('a page matching no wine contributes nothing and is not an error', () => {
    const { extracted } = buildExtracted(manifest, []);
    assert.deepEqual(extracted, []);
  });
});

// Regression test for the exact page that shipped the bug: two paragraphs,
// one real producer-voice paragraph with "Total Production:" glued onto its
// last word, and one paragraph that is NOTHING BUT concatenated
// "Vineyards: ... Soil: ..." labels — every field printed three times (once
// parsed into facts, once raw in producerCopy, once raw and mangled
// ("MendozaSoil:") in tastingNote) before this fix.
describe('buildExtracted — the Altocedro Cabernet Sauvignon regression (facts no longer print 3x)', () => {
  const wines = [
    { sku: '603733', slug: 'altocedro-ano-cero-cabernet-sauvignon-la-consulta-mendoza-2020', producer: 'Altocedro', name: 'Altocedro Ano Cero Cabernet Sauvignon la Consulta Mendoza', vintage: '2020' },
  ];
  const manifest = [
    {
      oldPath: '/portfolio/altocedro/altocedro-ano-cero-cabernet-sauvignon-la-consulta-mendoza',
      title: 'Altocedro Ano Cero Cabernet Sauvignon La Consulta Mendoza',
      paras: [
        {
          kind: 'description',
          text: "We strive for a La Consulta-terroir driven Cabernet Sauvignon that is fresh, fruit-forward, and easy-to-drink. Altocedro means “tall cedar,” and represents both winemaker and owner Karim Mussi Saffie's Lebanese-Argentine heritage, and a cedar tree which towers over the winery.Total Production: 750 cases",
        },
        { kind: 'description', text: 'Vineyards: La Consulta, Valle de Uco, MendozaSoil: Alluvial, sandy loam, rocky bottom' },
      ],
      chars: 400,
    },
  ];

  test('vineyard/soil/production each appear exactly once, in facts only', () => {
    const { extracted } = buildExtracted(manifest, wines);
    assert.equal(extracted.length, 1);
    const e = extracted[0];

    assert.equal(e.facts.vineyard, 'La Consulta, Valle de Uco, Mendoza');
    assert.equal(e.facts.soil, 'Alluvial, sandy loam, rocky bottom');
    assert.equal(e.facts.productionVolume, '750 cases');

    // The second paragraph was ONLY concatenated labels — nothing survives
    // it, so tastingNote must be empty, not a mangled "MendozaSoil:" string.
    assert.deepEqual(e.tastingNote, []);

    // The first paragraph's real prose survives with the glued-on fact cut
    // out, and cleanly (no leftover "Total Production", no stray newline).
    assert.equal(e.producerCopy.length, 1);
    assert.match(e.producerCopy[0], /We strive for a La Consulta-terroir driven Cabernet Sauvignon/);
    assert.ok(!e.producerCopy[0].includes('Total Production'));
    assert.ok(!e.producerCopy[0].includes('\n'));
  });
});

describe('dedupeQuotesAgainstProse — a passage republished as both prose and a standalone quote', () => {
  test('an unattributed quote that duplicates retained prose is dropped; the prose survives untouched', () => {
    // The real Altocedro Malbec Reserva shape: the same sentence, once as
    // the tail of a producerCopy paragraph, once as its own quoted paragraph.
    const prose = 'We strive for a La Consulta-terroir driven Malbec that is complex and concentrated. ' +
      'Big and rich-tasting, with concentrated flavors of dark plum, dried blackberry and dark currant, ' +
      'flanked by luscious Asian spice notes. Very creamy as well, offering a plush, open-textured finish ' +
      'of dark chocolate and mocha.';
    const quote = {
      quote: 'Big and rich-tasting, with concentrated flavors of dark plum, dried blackberry and dark currant, ' +
        'flanked by luscious Asian spice notes. Very creamy as well, offering a plush, open-textured finish ' +
        'of dark chocolate and mocha.',
    };
    const result = dedupeQuotesAgainstProse([quote], [prose], []);
    assert.deepEqual(result.quotes, []);
    assert.deepEqual(result.producerCopy, [prose]);
    assert.deepEqual(result.tastingNote, []);
  });

  test('the source\'s own copy-paste slip still counts as the same passage (near-identical, not byte-identical)', () => {
    // Real shape from Altocedro Malbec Gran Reserva: the quote paragraph has
    // "fig ad boysenberry" where the prose paragraph correctly has "fig and
    // boysenberry" — a dropped letter in the SOURCE's own second copy, not a
    // different sentence.
    const prose = 'We strive for a La Consulta-terroir driven Malbec that is elegant with great depth. Very dark, ' +
      'but juicy and driven, with a mouthwatering streak of briar and anise that pushes the muscular core of ' +
      'raspberry, fig and boysenberry fruit. Graphite and black tea notes flash in the background. The finish ' +
      'is long and structured.';
    const quote = {
      quote: 'Very dark, but juicy and driven, with a mouthwatering streak of briar and anise that pushes the ' +
        'muscular core of raspberry, fig ad boysenberry fruit. Graphite and black tea notes flash in the ' +
        'background. The finish is long and structured.',
    };
    const result = dedupeQuotesAgainstProse([quote], [prose], []);
    assert.deepEqual(result.quotes, []);
    assert.deepEqual(result.producerCopy, [prose]);
  });

  test('an attributed quote survives, and the overlapping span is trimmed from the prose instead', () => {
    const prose = 'This is a serious, ambitious wine from a young estate. Bright, chiseled, and built for the ' +
      'cellar, with real precision in the fruit.';
    const quote = { quote: 'Bright, chiseled, and built for the cellar, with real precision in the fruit.', attribution: 'Vigneron\'s Journal' };
    const result = dedupeQuotesAgainstProse([quote], [prose], []);
    assert.deepEqual(result.quotes, [quote]);
    assert.equal(result.producerCopy.length, 1);
    assert.match(result.producerCopy[0], /This is a serious, ambitious wine from a young estate/);
    assert.ok(!result.producerCopy[0].includes('built for the'));
  });

  test('an attributed quote that IS the whole prose paragraph drops the paragraph entirely, not an empty one', () => {
    const prose = 'Big and rich-tasting, with concentrated flavors of dark plum.';
    const quote = { quote: prose, attribution: 'James Suckling' };
    const result = dedupeQuotesAgainstProse([quote], [], [prose]);
    assert.deepEqual(result.quotes, [quote]);
    assert.deepEqual(result.tastingNote, []);
  });

  test('a quote with no overlap anywhere is left alone, attributed or not', () => {
    const prose = 'This vineyard sits next to Musigny, on a gentle east-facing slope.';
    const quote = { quote: 'A completely unrelated tasting note about a totally different wine entirely.' };
    const result = dedupeQuotesAgainstProse([quote], [prose], []);
    assert.deepEqual(result.quotes, [quote]);
    assert.deepEqual(result.producerCopy, [prose]);
  });
});

// End-to-end regression for the reported bug: the real Altocedro Malbec
// Reserva page — one producer-voice paragraph and one paragraph that is
// JUST that paragraph's last two sentences re-published in quote marks.
describe('buildExtracted — the Altocedro Malbec Reserva regression (quote no longer stutters against prose)', () => {
  const wines = [
    { sku: '603736*', slug: 'altocedro-malbec-reserva-2018', producer: 'Altocedro', name: 'Altocedro Malbec Reserva', vintage: '2018' },
  ];
  const manifest = [
    {
      oldPath: '/portfolio/altocedro/altocedro-malbec-reserva',
      title: 'Altocedro Malbec Reserva',
      paras: [
        {
          kind: 'description',
          text: 'We strive for a La Consulta-terroir driven Malbec that is complex and concentrated. Big and ' +
            'rich-tasting, with concentrated flavors of dark plum, dried blackberry and dark currant, flanked by ' +
            'luscious Asian spice notes. Very creamy as well, offering a plush, open-textured finish of dark ' +
            'chocolate and mocha.',
        },
        {
          kind: 'description',
          text: '“Big and rich-tasting, with concentrated flavors of dark plum, dried blackberry and dark ' +
            'currant, flanked by luscious Asian spice notes. Very creamy as well, offering a plush, ' +
            'open-textured finish of dark chocolate and mocha.”',
        },
      ],
      chars: 400,
    },
  ];

  test('the passage appears exactly once — as prose, with no duplicate quote', () => {
    const { extracted } = buildExtracted(manifest, wines);
    assert.equal(extracted.length, 1);
    const e = extracted[0];
    assert.equal(e.producerCopy.length, 1);
    assert.match(e.producerCopy[0], /We strive for a La Consulta-terroir driven Malbec/);
    assert.deepEqual(e.quotes, []);
  });
});
