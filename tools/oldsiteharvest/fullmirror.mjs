// Take a complete copy of the old finevines.com — raw HTML for every page, and
// every asset any page references — in one pass.
//
// Everything before this was targeted extraction: bottle images, then producer
// images, then per-wine prose, then hero images. Each pass found something the
// last one had walked straight past, because each pass only looked for what it
// already knew to want. That is a bad way to treat a source with a deadline:
// the old site becomes unreachable the moment DNS moves to Bunny, and a
// question nobody thought to ask before then can never be answered afterwards.
//
// So this makes no judgements about what matters. It saves the bytes. Analysis
// afterwards runs against the local copy, costs nothing, and can be re-run as
// many times as it takes.
//
//   node tools/oldsiteharvest/fullmirror.mjs [--assets-only]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { createHash } from 'node:crypto'

const OUT = join('data', 'oldsite-full')
const PAGES = join(OUT, 'pages')
const ASSETS = join(OUT, 'assets')
const OLD = 'https://www.finevines.com'
const CONCURRENCY = 6

mkdirSync(PAGES, { recursive: true })
mkdirSync(ASSETS, { recursive: true })

// Every distinct pathname the redirect crawl found. Query strings are dropped:
// 50,376 of the map's keys are facet permutations of 1,231 real pages.
const redirects = JSON.parse(readFileSync('redirects.json', 'utf8'))
const paths = [...new Set(Object.keys(redirects).map((k) => k.split('?')[0]))].sort()
console.log(`${paths.length} pages to mirror`)

// Windows and git both refuse very long path components, and the old site has
// URL-encoded filenames that expand past the limit ("Domaine_20Nicolas_20Joly_
// 20Savienni_C3_A8res_20Clos_20De_20La_20Coul_C3_A9e_20De_20Serrant" twice
// over). Truncate the basename and append a hash of the original so two long
// names can never collide, and record the mapping alongside the mirror.
const MAX_BASE = 120
const safe = (p) => {
  const cleaned = p === '/' ? 'index' : p.replace(/^\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._/-]/g, '_')
  const segs = cleaned.split('/')
  const base = segs.pop()
  if (base.length <= MAX_BASE) return [...segs, base].join('/')
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 10)
  return [...segs, base.slice(0, MAX_BASE - ext.length - 11) + '-' + hash + ext].join('/')
}
const pageFile = (p) => join(PAGES, safe(p) + '.html')

const failures = []
const assetUrls = new Set()

async function get(url, timeout = 30000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeout) })
    } catch (e) {
      if (attempt === 1) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

// --- pass 1: every page's raw HTML ------------------------------------------
if (!process.argv.includes('--assets-only')) {
  let cursor = 0, done = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < paths.length) {
        const p = paths[cursor++]
        const file = pageFile(p)
        if (existsSync(file)) { done++; continue }
        try {
          const r = await get(OLD + p)
          if (!r.ok) throw new Error('HTTP ' + r.status)
          const html = await r.text()
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, html)
        } catch (e) {
          failures.push({ path: p, error: String(e.message || e).slice(0, 120) })
        }
        if (++done % 100 === 0) console.log(`  pages ${done}/${paths.length} · ${failures.length} failed`)
      }
    })
  )
  console.log(`pages mirrored, ${failures.length} failures`)
}

// --- pass 2: every asset any saved page references ---------------------------
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
const htmlFiles = existsSync(PAGES) ? walk(PAGES).filter((f) => f.endsWith('.html')) : []
console.log(`scanning ${htmlFiles.length} saved pages for assets`)

for (const f of htmlFiles) {
  const h = readFileSync(f, 'utf8')
  for (const m of h.matchAll(/(?:src|href)="([^"]+)"/g)) {
    let u = m[1]
    if (u.startsWith('//')) u = 'https:' + u
    if (u.startsWith(OLD)) u = u.slice(OLD.length)
    if (!u.startsWith('/')) continue
    // Assets only — other pages are already covered by pass 1.
    if (!/\.(jpe?g|png|gif|svg|webp|pdf|docx?|xlsx?|csv|zip|mp4|webm|css|js|ico|woff2?|ttf|eot)(\?|$)/i.test(u)) continue
    assetUrls.add(u.split('#')[0])
  }
}
console.log(`${assetUrls.size} distinct assets referenced`)

const assetList = [...assetUrls]
let ac = 0, adone = 0, abytes = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (ac < assetList.length) {
      const u = assetList[ac++]
      const clean = u.split('?')[0]
      const file = join(ASSETS, safe(clean))
      if (existsSync(file)) { adone++; continue }
      try {
        const r = await get(OLD + u)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const buf = Buffer.from(await r.arrayBuffer())
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, buf)
        abytes += buf.length
      } catch (e) {
        failures.push({ asset: u, error: String(e.message || e).slice(0, 120) })
      }
      if (++adone % 200 === 0) console.log(`  assets ${adone}/${assetList.length} · ${(abytes / 1048576).toFixed(0)}MB`)
    }
  })
)

writeFileSync(join(OUT, 'failures.json'), JSON.stringify(failures, null, 1))
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({ mirroredAtPaths: paths.length, assets: assetList.length, failures: failures.length, assetList }, null, 1)
)

const byExt = {}
for (const u of assetList) {
  const e = (extname(u.split('?')[0]) || '(none)').toLowerCase()
  byExt[e] = (byExt[e] || 0) + 1
}
console.log('\n=================================================')
console.log('pages mirrored :', htmlFiles.length, 'of', paths.length)
console.log('assets fetched :', adone, `(${(abytes / 1048576).toFixed(1)} MB new this run)`)
console.log('by type        :', JSON.stringify(byExt))
console.log('failures       :', failures.length)
