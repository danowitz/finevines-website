import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarise, cardKey, cuveeName } from '../../tools/coverage/report.mjs'

// The report's whole point is card-level accuracy, so its grouping has to be
// the SITE's grouping, not an approximation of it. These tests pin the JS port
// of internal/catalog's key (and of which row supplies a card's picture) to
// the cases that actually diverge in data/wines.json.

test('the card key matches internal/catalog: producer and cuvee are joined BEFORE slugifying', () => {
  // 1,602 of 2,642 rows have no producer field — the estate leads the name
  // instead. Go concatenates producer and cuvee and slugifies the pair, so
  // these two rows are the same card by design. A key that slugified the two
  // halves separately, or joined them with a literal '|', would split them.
  const a = { producer: '', name: 'Benjamin Leroux Auxey Duresses Blanc' }
  const b = { producer: 'Benjamin Leroux', name: 'Auxey Duresses Blanc' }
  assert.equal(cardKey(a), cardKey(b))
  assert.equal(cardKey(a), 'benjamin-leroux-auxey-duresses-blanc')
})

test('the card key collapses punctuation and whitespace splits', () => {
  // Real pair from the catalog: one row spaces the parenthesis, one does not.
  // Lowercasing alone leaves them as two cards; slugifying merges them.
  const a = { producer: 'Guiberteau', name: 'Clos de la Rue (Breze)' }
  const b = { producer: 'Guiberteau', name: 'Clos de la Rue ( Breze)' }
  assert.equal(cardKey(a), cardKey(b))
  assert.equal(cardKey(a), 'guiberteau-clos-de-la-rue-breze')
})

test('cuveeName strips vintage, pack size, bottle size, hold markers and asterisks', () => {
  assert.equal(cuveeName('Chablis 1er Cru 2019'), 'Chablis 1er Cru')
  assert.equal(cuveeName('Chablis 12/750'), 'Chablis')
  assert.equal(cuveeName('Chablis 1.5L'), 'Chablis')
  assert.equal(cuveeName('Chablis - GM HOLD do not ship'), 'Chablis')
  assert.equal(cuveeName('*Chablis*'), 'Chablis')
  // A vintage range is two years, and CuveeName strips years BEFORE pack
  // formats — so the slash survives as a bare token. Verified against Go:
  // catalog.CuveeName returns exactly this. It does not matter, because the
  // key slugifies the stray punctuation away; what matters is that the port
  // does not "improve" on the original and quietly split cards.
  assert.equal(cuveeName('Chablis 2018/2019'), 'Chablis /')
  assert.equal(cardKey({ producer: 'Dom X', name: 'Chablis 2018/2019' }), 'dom-x-chablis')
})

test('counts cards, not rows — vintages of one wine collapse', () => {
  const wines = [
    { sku: '1', slug: 'x-a-2020', producer: 'Dom X', name: 'Cuvee A 2020', vintage: '2020', imagePath: 'a.jpg' },
    { sku: '2', slug: 'x-a-2021', producer: 'Dom X', name: 'Cuvee A 2021', vintage: '2021', imagePath: 'a.jpg' },
    { sku: '3', slug: 'y-b-2020', producer: 'Dom Y', name: 'Cuvee B 2020', vintage: '2020', imagePath: 'c.svg' },
  ]
  const s = summarise(wines, {})
  assert.equal(s.cards, 2)
  assert.equal(s.cardsWithPhoto, 1)
  assert.equal(s.rowsWithPhoto, 2)
})

test("a card's picture comes from the row the grid shows, not from any row in the group", () => {
  // internal/build.portfolioCards takes the newest vintage's best-enriched
  // row. The 2020 has a photograph, but the visitor sees the 2021 — and the
  // 2021 is on a placeholder, so this card is NOT covered. Counting "any row
  // in the group has a photo" overstated coverage by 24 cards on real data.
  const wines = [
    { sku: '1', slug: 'x-a-2020', producer: 'Dom X', name: 'Cuvee A 2020', vintage: '2020', imagePath: 'a.jpg' },
    { sku: '2', slug: 'x-a-2021', producer: 'Dom X', name: 'Cuvee A 2021', vintage: '2021', imagePath: 'b.svg' },
  ]
  const s = summarise(wines, {})
  assert.equal(s.cards, 1)
  assert.equal(s.cardsWithPhoto, 0)
  assert.equal(s.rowsWithPhoto, 1)
})

test('within the newest vintage the best-enriched row wins, as it does on the site', () => {
  const wines = [
    { sku: '1', slug: 'x-a-2021-a', producer: 'Dom X', name: 'Cuvee A 2021', vintage: '2021', imagePath: 'a.svg', metadataScore: 10 },
    { sku: '2', slug: 'x-a-2021-b', producer: 'Dom X', name: 'Cuvee A 2021', vintage: '2021', imagePath: 'b.jpg', metadataScore: 90 },
  ]
  const s = summarise(wines, {})
  assert.equal(s.cards, 1)
  assert.equal(s.cardsWithPhoto, 1)
})

test('NV and blank vintages sort last, so a dated vintage represents the card', () => {
  const wines = [
    { sku: '1', slug: 'x-a-nv', producer: 'Dom X', name: 'Cuvee A', vintage: '', imagePath: 'a.svg' },
    { sku: '2', slug: 'x-a-2019', producer: 'Dom X', name: 'Cuvee A 2019', vintage: '2019', imagePath: 'b.jpg' },
  ]
  const s = summarise(wines, {})
  assert.equal(s.cards, 1)
  assert.equal(s.cardsWithPhoto, 1)
})

test('rows the site cannot group are not counted as cards', () => {
  // catalog.Build drops rows with no slug, no name, or an empty key.
  const wines = [
    { sku: '1', slug: '', producer: 'Dom X', name: 'Cuvee A', imagePath: 'a.jpg' },
    { sku: '2', slug: 'y', producer: 'Dom Y', name: '', imagePath: 'b.jpg' },
    { sku: '3', slug: 'z', producer: '', name: '2019', imagePath: 'c.jpg' },
    { sku: '4', slug: 'q', producer: 'Dom Q', name: 'Cuvee Q', imagePath: 'd.jpg' },
  ]
  const s = summarise(wines, {})
  assert.equal(s.rows, 4)
  assert.equal(s.cards, 1)
  assert.equal(s.ungroupable, 3)
})

test('splits the imageless into tried and never-tried', () => {
  const wines = [
    { sku: '1', slug: 'a', producer: 'A', name: 'A', imagePath: 'a.svg' },
    { sku: '2', slug: 'b', producer: 'B', name: 'B', imagePath: 'b.svg' },
  ]
  const ledger = { 1: { outcome: 'miss', attempts: 3 } }
  const s = summarise(wines, ledger)
  assert.equal(s.missing.miss, 1)
  assert.equal(s.missing.never, 1)
})

test('an unrecognised ledger outcome lands in `other` instead of vanishing', () => {
  // The markdown table names a fixed set of outcomes. Anything the ledger
  // grows later must still be counted, or the "why" table stops summing to
  // the placeholder total and nobody notices.
  const wines = [
    { sku: '1', slug: 'a', producer: 'A', name: 'A', imagePath: 'a.svg' },
    { sku: '2', slug: 'b', producer: 'B', name: 'B', imagePath: 'b.svg' },
  ]
  const ledger = { 1: { outcome: 'quarantined' }, 2: {} }
  const s = summarise(wines, ledger)
  assert.equal(s.missing.other, 2)
  assert.equal(s.missing.never, 0)
})

test('the missing buckets always sum to the rows without a photograph', () => {
  const wines = [
    { sku: '1', slug: 'a', producer: 'A', name: 'A', imagePath: 'a.jpg' },
    { sku: '2', slug: 'b', producer: 'B', name: 'B', imagePath: 'b.svg' },
    { sku: '3', slug: 'c', producer: 'C', name: 'C', imagePath: 'c.svg' },
    { sku: '4', slug: 'd', producer: 'D', name: 'D', imagePath: 'd.svg' },
  ]
  const ledger = { 2: { outcome: 'miss' }, 3: { outcome: 'sideways' } }
  const s = summarise(wines, ledger)
  const total = Object.values(s.missing).reduce((a, b) => a + b, 0)
  assert.equal(total, s.rows - s.rowsWithPhoto)
})

test('missing imagePath counts as imageless at both row and card level', () => {
  const wines = [
    { sku: '1', slug: 'x-a-2020', producer: 'Dom X', name: 'Wine A 2020', vintage: '2020', imagePath: 'a.jpg' },
    { sku: '2', slug: 'x-a-2021', producer: 'Dom X', name: 'Wine A 2021', vintage: '2021' }, // missing imagePath
    { sku: '3', slug: 'y-b-2020', producer: 'Dom Y', name: 'Wine B 2020', vintage: '2020' }, // missing imagePath
  ]
  const s = summarise(wines, {})
  assert.equal(s.rows, 3)
  assert.equal(s.rowsWithPhoto, 1)
  assert.equal(s.cards, 2)
  assert.equal(s.cardsWithPhoto, 0) // the 2021 represents Wine A, and it has no image
  assert.equal(s.missing.never, 2)
})
