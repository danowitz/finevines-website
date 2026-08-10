import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'

// The invented-label artwork is retired. Nothing hand-authored may sit in
// assets/img/wines/ as an SVG — every placeholder the site serves is generated
// at build time by internal/label. A stray .svg here is either dead weight
// shipped to the CDN or, worse, invented packaging back on the site.
test('assets/img/wines contains no hand-authored SVGs', () => {
  if (!existsSync('assets/img/wines')) return
  const svgs = readdirSync('assets/img/wines').filter((f) => f.endsWith('.svg'))
  assert.deepEqual(svgs, [], `${svgs.length} retired SVGs still present, e.g. ${svgs.slice(0, 3)}`)
})

test('no wine references an SVG that is checked into assets', () => {
  const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
  const checkedIn = existsSync('assets/img/wines')
    ? new Set(readdirSync('assets/img/wines'))
    : new Set()
  const bad = wines
    .map((w) => (w.imagePath || '').split('/').pop())
    .filter((f) => f.endsWith('.svg') && checkedIn.has(f))
  assert.deepEqual(bad, [], 'a wine points at a checked-in SVG instead of a generated one')
})
