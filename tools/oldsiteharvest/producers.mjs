// Harvest the old site's PRODUCER pages: the estate image and the prose Fine
// Vines wrote about each producer.
//
// The bottle harvest missed both. Its regex matched /sites/default/files/product/
// and these live at /sites/default/files/producer/ — one character apart, and it
// cost the estate imagery entirely. The prose was never looked for at all.
//
// This matters more than another bottle shot: the new site has /producers/
// collection pages with nothing but a wine list on them, and this is the
// client's own writing about the people they represent. It becomes unreachable
// the moment DNS moves.
//
//   node tools/oldsiteharvest/producers.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname } from 'node:path'

const OUT = join('data', 'oldsite-producers')
const MANIFEST = join(OUT, 'manifest.json')
const OLD = 'https://www.finevines.com'
const CONCURRENCY = 5

mkdirSync(OUT, { recursive: true })

const redirects = JSON.parse(readFileSync('redirects.json', 'utf8'))
const pages = [...new Set(Object.keys(redirects).filter((k) => /^\/portfolio\/producer\/[^/?]+$/.test(k)))].sort()
console.log(`${pages.length} producer pages`)

const done = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : []
const seen = new Set(done.map((d) => d.oldPath))
const results = [...done]
const failures = []

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&[a-z]+;/gi, ' ')

async function grab(oldPath) {
  const res = await fetch(OLD + oldPath, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('page HTTP ' + res.status)
  const html = await res.text()

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const name = decode((h1?.[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

  // The estate image, preferring the original over the 555px style derivative.
  const raw = [...new Set([...html.matchAll(/\/sites\/default\/files\/[^"'\s)]*\/?producer\/[^"'\s)]+/g)].map((m) => m[0]))]
    .filter((u) => !/\/default_images\//.test(u))
  let image = null
  if (raw.length) {
    const original = raw[0].replace(/\/styles\/[^/]+\/public\//, '/').replace(/\?itok=[^&]*$/, '')
    for (const candidate of [original, raw[0]]) {
      try {
        const ir = await fetch(OLD + candidate, { signal: AbortSignal.timeout(30000) })
        if (!ir.ok) continue
        const buf = Buffer.from(await ir.arrayBuffer())
        const ext = extname(decodeURIComponent(candidate).split('?')[0]).toLowerCase() || '.png'
        const file = oldPath.split('/').pop() + ext
        writeFileSync(join(OUT, file), buf)
        image = { imageUrl: OLD + candidate, file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) }
        break
      } catch {
        /* try the derivative */
      }
    }
  }

  // The prose. Drop navigation and wine-list noise by keeping only substantial
  // paragraphs, then stop at the first line that looks like a product listing.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
  const paras = text
    .split('\n')
    .map((s) => decode(s).replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 80)
  const prose = paras.join('\n\n')

  return { oldPath, name, slug: oldPath.split('/').pop(), image, prose, proseChars: prose.length }
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
      if (++completed % 25 === 0) {
        console.log(`  ${completed}/${pages.length} · ${results.filter((r) => r.image).length} images · ${results.filter((r) => r.proseChars > 120).length} with prose`)
        writeFileSync(MANIFEST, JSON.stringify(results, null, 1))
      }
    }
  })
)

writeFileSync(MANIFEST, JSON.stringify(results, null, 1))
writeFileSync(join(OUT, 'failures.json'), JSON.stringify(failures, null, 1))

const withImage = results.filter((r) => r.image)
const withProse = results.filter((r) => r.proseChars > 120)
const bytes = withImage.reduce((n, r) => n + r.image.bytes, 0)
console.log('\n=================================================')
console.log('producer pages harvested :', results.length)
console.log('with an estate image     :', withImage.length, `(${(bytes / 1048576).toFixed(1)} MB)`)
console.log('with producer prose      :', withProse.length)
console.log('failures                 :', failures.length)
