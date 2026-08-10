import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const isPhoto = (w) => !!w.imagePath && !/\.svg$/i.test(w.imagePath)
const cardKey = (w) => `${(w.producer || '').toLowerCase()}|${(w.name || '').toLowerCase()}`

export function summarise(wines, ledger) {
  const cards = new Map()
  for (const w of wines) {
    const k = cardKey(w)
    cards.set(k, (cards.get(k) || false) || isPhoto(w))
  }
  const missing = { miss: 0, unevaluated: 0, imported: 0, never: 0 }
  for (const w of wines) {
    if (isPhoto(w)) continue
    const rec = ledger[w.sku] || ledger[w.id] || ledger[w.slug]
    if (!rec) missing.never++
    else missing[rec.outcome] = (missing[rec.outcome] || 0) + 1
  }
  return {
    rows: wines.length,
    rowsWithPhoto: wines.filter(isPhoto).length,
    cards: cards.size,
    cardsWithPhoto: [...cards.values()].filter(Boolean).length,
    missing,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
  const ledger = JSON.parse(readFileSync('data/image-attempts.json', 'utf8'))
  const s = summarise(wines, ledger)
  const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`
  const md = `# Catalog image coverage

Regenerate with \`node tools/coverage/report.mjs\`.

| Metric | Value |
|---|---|
| Wines | ${s.rows} |
| Wines with a photograph | ${s.rowsWithPhoto} (${pct(s.rowsWithPhoto, s.rows)}) |
| Portfolio cards | ${s.cards} |
| Cards with a photograph | ${s.cardsWithPhoto} (${pct(s.cardsWithPhoto, s.cards)}) |
| Cards on the neutral placeholder | ${s.cards - s.cardsWithPhoto} |

## Why the rest are missing

| Ledger outcome | Wines |
|---|---|
| searched, nothing usable found | ${s.missing.miss || 0} |
| verified but never evaluated | ${s.missing.unevaluated || 0} |
| imported then withdrawn on audit | ${s.missing.imported || 0} |
| not yet searched | ${s.missing.never || 0} |

"Searched, nothing usable found" is the ceiling the nightly run cannot move on
its own. Those need supplier media (see docs/supplier-media-request.md).
`
  writeFileSync('reports/image-coverage.md', md)
  console.log(md)
}
