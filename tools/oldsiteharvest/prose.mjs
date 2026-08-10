// Harvest the per-wine prose off the old site's product pages.
//
// Every product page carries copy written by people who know the wine —
// vinification detail, yields, tasting notes:
//
//   "100% de-stemmed, cold maceration, 18 days' fermentation in open wood
//    tank. 18 months' aging on lees in oak barrels (50% new oak)."
//
// The catalog's current descriptions are AI-generated from web search. This is
// the importer's own authoritative copy, and it stops existing when DNS moves.
// The image harvest walked these same 1,001 pages and read only the <img> tags.
//
// Captured here with the page's declared title, so the same bidirectional
// title matching that verified the photographs can attach the prose to a wine.
//
//   node tools/oldsiteharvest/prose.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join('data', 'oldsite-prose')
const MANIFEST = join(OUT, 'manifest.json')
const OLD = 'https://www.finevines.com'
const CONCURRENCY = 6

mkdirSync(OUT, { recursive: true })

const redirects = JSON.parse(readFileSync('redirects.json', 'utf8'))
const pages = [...new Set(Object.keys(redirects).map((k) => k.split('?')[0]))]
  .filter((p) => /^\/portfolio\/[^/?]+\/[^/?]+$/.test(p) && !/^\/portfolio\/producer\//.test(p))
  .sort()
console.log(`${pages.length} product pages`)

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à')
    .replace(/&ccedil;/g, 'ç').replace(/&ocirc;/g, 'ô').replace(/&acirc;/g, 'â')
    .replace(/&[a-z]+;/gi, ' ')

const done = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : []
const seen = new Set(done.map((d) => d.oldPath))
const results = [...done]
const failures = []

async function grab(oldPath) {
  const res = await fetch(OLD + oldPath, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const html = await res.text()

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = decode((h1?.[1] || tt?.[1] || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s*\|\s*Fine Vines\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
  const paras = text
    .split('\n')
    .map((s) => decode(s).replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 80)

  // The pages label their own sections; keeping the labels lets a later step
  // map them onto the catalog's aroma/palate/description fields rather than
  // dumping one undifferentiated blob.
  const classify = (p) => {
    if (/^on the nose/i.test(p)) return 'aroma'
    if (/^on the palate/i.test(p)) return 'palate'
    if (/^vinification/i.test(p)) return 'vinification'
    return 'description'
  }

  return { oldPath, title, paras: paras.map((p) => ({ kind: classify(p), text: p })), chars: paras.join(' ').length }
}

let cursor = 0
let completed = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < pages.length) {
      const p = pages[cursor++]
      if (seen.has(p)) { completed++; continue }
      try {
        results.push(await grab(p))
      } catch (e) {
        failures.push({ oldPath: p, error: String(e.message || e).slice(0, 120) })
      }
      if (++completed % 100 === 0) {
        console.log(`  ${completed}/${pages.length} · ${results.filter((r) => r.chars > 80).length} with prose`)
        writeFileSync(MANIFEST, JSON.stringify(results, null, 1))
      }
    }
  })
)

writeFileSync(MANIFEST, JSON.stringify(results, null, 1))
writeFileSync(join(OUT, 'failures.json'), JSON.stringify(failures, null, 1))

const withProse = results.filter((r) => r.chars > 80)
const kinds = {}
for (const r of results) for (const p of r.paras) kinds[p.kind] = (kinds[p.kind] || 0) + 1
console.log('\n=================================================')
console.log('pages harvested   :', results.length)
console.log('with prose        :', withProse.length)
console.log('total characters  :', results.reduce((n, r) => n + r.chars, 0).toLocaleString())
console.log('paragraphs by kind:', JSON.stringify(kinds))
console.log('failures          :', failures.length)
