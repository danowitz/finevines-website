// Exports the catalog's enriched prose as a reviewer-friendly CSV, for
// pasting into a consumer AI (ChatGPT app etc.) that can't run our API
// pipeline but can read an uploaded file and flag suspect rows.
//
//   node tools/catalogexport/main.mjs   -> out-bottle/catalog-review.csv
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const wines = JSON.parse(readFileSync('data/wines.json', 'utf8')).filter(
  (w) => (w.slug || '').trim() && (w.name || '').trim()
);
const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"';

const rows = [
  [
    'slug', 'url', 'producer', 'name', 'vintage', 'region', 'appellation', 'country',
    'varietal', 'color', 'abv', 'bottleSize', 'drinkWindow', 'matchConfidence',
    'description', 'sommelierNotes', 'aroma', 'palate', 'finish', 'foodPairings',
  ].join(','),
];
for (const w of wines) {
  rows.push(
    [
      w.slug, `https://finevines.biz/wines/${w.slug}/`, w.producer, w.name, w.vintage,
      w.region, w.appellation, w.country, w.varietal, w.color, w.abv, w.bottleSize,
      w.drinkWindow, w.matchConfidence, w.description, w.sommelierNotes, w.aroma,
      w.palate, w.finish, (w.foodPairings || []).join('; '),
    ]
      .map(esc)
      .join(',')
  );
}
mkdirSync('out-bottle', { recursive: true });
writeFileSync('out-bottle/catalog-review.csv', rows.join('\n') + '\n');
console.log(`out-bottle/catalog-review.csv — ${wines.length} rows`);
