// Card-level image coverage for the portfolio.
//
// The unit that matters is the CARD a visitor sees, not the Salesforce row.
// 2,642 rows collapse into 1,902 cards, and a card wears exactly one picture,
// so counting rows — or grouping them by anything other than the site's own
// key — publishes a number the site does not agree with.
//
// Everything below the isPhoto line is a faithful JS port of internal/catalog
// (grouping) and internal/build.portfolioCards (which row supplies the
// picture). Keep the two in step: if group.go's key or CuveeName changes, this
// file changes with it. Verified 1:1 against dist/assets/catalog-index.*.json
// — same 1,902 keys, same representative row for every one of them.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const isPhoto = (w) => !!w.imagePath && !/\.svg$/i.test(w.imagePath)

// --- port of internal/catalog (group.go) ------------------------------------

const yearRE = /\b(?:19|20)\d\d\b/g
// "<bottles>/<size>" — 12/750, 6/375, 3/1.5L — is a CASE FORMAT, not a name.
const packSizeRE = /\b(\d{1,2})\s*\/\s*(?:\d+(?:\.\d+)?)\s*(?:l|liter|litre|ml)?\b/gi
// A size on its own: .5L, 1.5L, 3L, 375ml, 750 ML.
const bareSizeRE = /(?:^|\s)(?:\d*\.?\d+)\s*(?:ml|cl|l|liter|litre)\b/gi
const holdRE = /\s*-\s*(?:gm\s+hold|hold|do not sell|dns)\b.*$/i
const nonAlnumRE = /[^a-z0-9]+/g

// cuveeName mirrors catalog.CuveeName: strip everything that identifies a
// SHIPMENT rather than a wine — the vintage, the case format, the bottle size,
// the hold markers and asterisks.
export function cuveeName(name) {
  let n = name || ''
  n = n.replace(yearRE, ' ')
  n = n.replace(packSizeRE, ' ')
  n = n.replace(bareSizeRE, ' ')
  n = n.replace(holdRE, '')
  n = n.split('*').join(' ')
  return n.trim().split(/\s+/).filter(Boolean).join(' ')
}

// cardKey mirrors catalog.key: what decides two rows are the same wine.
//
// The producer and the cuvée are concatenated BEFORE slugifying, which is what
// makes the blank-producer case work — 1,602 rows have no producer and lead
// the name with the estate instead, so ('', 'Benjamin Leroux Auxey Duresses')
// and ('Benjamin Leroux', 'Auxey Duresses') are deliberately one card.
export function cardKey(w) {
  const p = (w.producer || '').trim().toLowerCase()
  const c = cuveeName(w.name).toLowerCase()
  return `${p} ${c}`.replace(nonAlnumRE, '-').replace(/^-+|-+$/g, '')
}

// representative mirrors internal/build.portfolioCards: the newest vintage's
// best-enriched row. That row's imagePath is the picture on the card, so it
// alone decides whether the card is covered — a 2020 with a photograph does
// not rescue a card whose 2021 is on the placeholder.
function representative(rows) {
  const byYear = new Map()
  for (const w of rows) {
    const y = (w.vintage || '').trim()
    if (!byYear.has(y)) byYear.set(y, [])
    byYear.get(y).push(w)
  }
  // Newest first; NV and blank sort last (catalog.Build's ordering).
  const years = [...byYear.keys()].sort((a, b) => {
    if ((a === '') !== (b === '')) return b === '' ? -1 : 1
    return a > b ? -1 : a < b ? 1 : 0
  })
  const newest = byYear.get(years[0])
  let rep = newest[0]
  for (const w of newest) {
    if ((w.metadataScore || 0) > (rep.metadataScore || 0)) rep = w
  }
  return rep
}

// --- the report ------------------------------------------------------------

// The outcomes the markdown table names. Anything else the ledger grows later
// lands in `other` rather than becoming a key nothing prints, which is what
// kept the "why" table from summing to the placeholder count.
const KNOWN_OUTCOMES = ['miss', 'unevaluated', 'imported', 'never']

export function summarise(wines, ledger) {
  const groups = new Map()
  let ungroupable = 0
  for (const w of wines) {
    // catalog.Build's own skips: a row with no slug, no name, or an empty key
    // never becomes a card.
    if (!(w.slug || '').trim() || !(w.name || '').trim()) {
      ungroupable++
      continue
    }
    const k = cardKey(w)
    if (!k) {
      ungroupable++
      continue
    }
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(w)
  }

  let cardsWithPhoto = 0
  for (const rows of groups.values()) {
    if (isPhoto(representative(rows))) cardsWithPhoto++
  }

  const missing = { miss: 0, unevaluated: 0, imported: 0, never: 0, other: 0 }
  for (const w of wines) {
    if (isPhoto(w)) continue
    const rec = ledger[w.sku] || ledger[w.id] || ledger[w.slug]
    if (!rec) missing.never++
    else if (KNOWN_OUTCOMES.includes(rec.outcome)) missing[rec.outcome]++
    else missing.other++
  }

  return {
    rows: wines.length,
    rowsWithPhoto: wines.filter(isPhoto).length,
    ungroupable,
    cards: groups.size,
    cardsWithPhoto,
    missing,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
  const ledger = JSON.parse(readFileSync('data/image-attempts.json', 'utf8'))
  const s = summarise(wines, ledger)

  // The "why" table has to account for every placeholder row or it is
  // misinformation. `other` makes that true by construction; this asserts it
  // rather than trusting it.
  const placeholders = s.rows - s.rowsWithPhoto
  const bucketed = Object.values(s.missing).reduce((a, b) => a + b, 0)
  if (bucketed !== placeholders) {
    throw new Error(`missing buckets sum to ${bucketed}, expected ${placeholders}`)
  }

  const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`
  const md = `# Catalog image coverage

Regenerate with \`node tools/coverage/report.mjs\`.

Cards are counted the way the site counts them: one card per wine — producer
and cuvée, with vintages folded in — and the card's picture is the one the grid
shows, from the newest vintage's best-enriched row.

| Metric | Value |
|---|---|
| Wines | ${s.rows} |
| Wines with a photograph | ${s.rowsWithPhoto} (${pct(s.rowsWithPhoto, s.rows)}) |
| Portfolio cards | ${s.cards} |
| Cards with a photograph | ${s.cardsWithPhoto} (${pct(s.cardsWithPhoto, s.cards)}) |
| Cards on the neutral placeholder | ${s.cards - s.cardsWithPhoto} |

## Why the rest are missing

Counted per wine, not per card, because the search runs per wine.

| Ledger outcome | Wines |
|---|---|
| searched, nothing usable found | ${s.missing.miss} |
| verified but never evaluated | ${s.missing.unevaluated} |
| imported then withdrawn on audit | ${s.missing.imported} |
| not yet searched | ${s.missing.never} |
| unrecognised ledger outcome | ${s.missing.other} |
| **total without a photograph** | **${placeholders}** |

"Searched, nothing usable found" is the ceiling the nightly run cannot move on
its own: the public web has already been asked and had nothing usable to give.
Moving it means asking the producers and importers we buy from for their own
bottle photography.
`
  writeFileSync('reports/image-coverage.md', md)
  console.log(md)
}
