// Builds the human-review sample: 10 representative wines showing the
// catalog's current AI-generated copy next to the three buckets extracted
// from the old site, so a person can decide what (if anything) to adopt.
//
// This tool does not modify data/wines.json — it only reads it and
// data/oldsite-prose/extracted.json to render reports/oldsite-prose-sample.html.
//
//   node tools/oldsiteharvest/prose-sample.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Picked to show variety: rich facts, multiple attributed/unattributed
// quotes, producer-copy-only, and one page where the source itself repeats
// a line as both unquoted producer voice and a standalone quoted pull-quote.
const SAMPLE_SKUS = [
  '603736*', '381020', '520581', '410440', '210663',
  '544215*', '603742*', '510426', '604750', '510927',
];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'));
const extracted = JSON.parse(readFileSync('data/oldsite-prose/extracted.json', 'utf8'));
const wineBySku = new Map(wines.map((w) => [w.sku, w]));
const extractedBySku = new Map(extracted.map((e) => [e.sku, e]));

const FACT_LABELS = {
  vineyard: 'Vineyard',
  soil: 'Soil',
  yield: 'Yield',
  harvestMethod: 'Harvest method',
  aging: 'Aging',
  productionVolume: 'Production volume',
  vinification: 'Vinification (general)',
};

function factsBlock(facts) {
  const keys = Object.keys(facts);
  if (!keys.length) return '<p class="empty">No structured facts parsed from this page.</p>';
  return '<dl class="facts">' + keys.map((k) =>
    `<dt>${esc(FACT_LABELS[k] || k)}</dt><dd>${esc(facts[k])}</dd>`
  ).join('') + '</dl>';
}

function producerCopyBlock(copy) {
  if (!copy.length) return '<p class="empty">No first-person producer/importer copy found on this page.</p>';
  return copy.map((p) => `<blockquote class="producer-copy">${esc(p)}</blockquote>`).join('');
}

function quotesBlock(quotes) {
  if (!quotes.length) return '<p class="empty">No quoted tasting note found on this page.</p>';
  return quotes.map((q) =>
    `<blockquote class="tasting-quote">&ldquo;${esc(q.quote)}&rdquo;` +
    (q.attribution ? `<footer>&mdash; ${esc(q.attribution)}</footer>` : '<footer class="unattributed">&mdash; source not named on the page</footer>') +
    '</blockquote>'
  ).join('');
}

function currentCatalogBlock(w) {
  const pairings = (w.foodPairings || []).map(esc).join(', ');
  return `
    <h4>Description</h4>
    <p>${esc(w.description) || '<span class="empty">(none)</span>'}</p>
    <h4>Sommelier notes</h4>
    <p>${esc(w.sommelierNotes) || '<span class="empty">(none)</span>'}</p>
    <h4>Aroma / Palate / Finish</h4>
    <p>${esc(w.aroma)} &middot; ${esc(w.palate)} &middot; ${esc(w.finish)}</p>
    ${pairings ? `<h4>Food pairings</h4><p>${pairings}</p>` : ''}
  `;
}

const cards = SAMPLE_SKUS.map((sku) => {
  const w = wineBySku.get(sku);
  const e = extractedBySku.get(sku);
  if (!w || !e) return `<section class="card missing">Missing data for SKU ${esc(sku)}</section>`;

  return `
  <section class="card">
    <h2>${esc(w.producer)} — ${esc(w.name)} <span class="vintage">${esc(w.vintage)}</span></h2>
    <p class="source"><a href="${esc(e.sourceUrl)}">${esc(e.sourceUrl)}</a></p>
    <div class="columns">
      <div class="col current">
        <h3>Current catalog (AI-generated)</h3>
        ${currentCatalogBlock(w)}
      </div>
      <div class="col extracted">
        <h3>Extracted from the old site</h3>
        <h4>1. Facts</h4>
        ${factsBlock(e.facts)}
        <h4>2. Producer / importer copy</h4>
        ${producerCopyBlock(e.producerCopy)}
        <h4>3. Quoted tasting notes</h4>
        ${quotesBlock(e.quotes)}
      </div>
    </div>
  </section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Old-site prose extraction — sample review</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 1200px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.5; color: #222; background: #fdfcf9; }
  @media (prefers-color-scheme: dark) { body { color: #ddd; background: #1b1a17; } }
  h1 { font-size: 1.6rem; border-bottom: 2px solid #7a1f2b; padding-bottom: .5rem; }
  .intro { max-width: 70ch; color: #555; }
  @media (prefers-color-scheme: dark) { .intro { color: #aaa; } }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1.25rem 1.5rem; margin: 2rem 0; background: rgba(122,31,43,0.03); }
  @media (prefers-color-scheme: dark) { .card { border-color: #444; background: rgba(255,255,255,0.03); } }
  .card h2 { margin-top: 0; font-size: 1.25rem; }
  .vintage { color: #7a1f2b; font-weight: normal; }
  .source a { font-size: .85rem; color: #7a1f2b; word-break: break-all; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 800px) { .columns { grid-template-columns: 1fr; } }
  .col { min-width: 0; }
  .col h3 { font-size: 1rem; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #999; padding-bottom: .25rem; }
  .col.current h3 { color: #555; }
  .col.extracted h3 { color: #7a1f2b; }
  .col h4 { font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; color: #888; margin-bottom: .25rem; }
  .empty { color: #999; font-style: italic; }
  dl.facts { margin: 0 0 1rem; }
  dl.facts dt { font-weight: bold; font-size: .9rem; }
  dl.facts dd { margin: 0 0 .6rem; }
  blockquote { margin: 0 0 .75rem; padding: .5rem .75rem; border-left: 3px solid #7a1f2b; background: rgba(122,31,43,0.05); }
  @media (prefers-color-scheme: dark) { blockquote { background: rgba(255,255,255,0.05); } }
  blockquote.tasting-quote footer { font-size: .85rem; color: #7a1f2b; margin-top: .25rem; }
  blockquote.tasting-quote footer.unattributed { color: #999; font-style: italic; }
  footer.page { margin-top: 3rem; font-size: .85rem; color: #888; }
</style>
</head>
<body>
<h1>Old-site prose extraction — sample review</h1>
<p class="intro">Ten wines selected to show the range of what the old finevines.com pages carried: structured
facts, the producer/importer's own marketing voice, and quoted third-party tasting notes. The left column is
the catalog's current AI-generated copy; the right column is what this extraction step proposes pulling forward.
Nothing here has been written into <code>data/wines.json</code> — this page is for deciding what, if anything,
to adopt.</p>
${cards}
<footer class="page">Generated by <code>tools/oldsiteharvest/prose-sample.mjs</code> from
<code>data/oldsite-prose/extracted.json</code> and <code>data/wines.json</code>. ${extracted.length} wines matched
across the full run; this page shows 10 of them.</footer>
</body>
</html>
`;

mkdirSync('reports', { recursive: true });
writeFileSync('reports/oldsite-prose-sample.html', html);
console.log('wrote reports/oldsite-prose-sample.html');
