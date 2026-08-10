// Mirror every product photograph off the old finevines.com before cutover
// kills it.
//
// The old site is the client's own photography — better provenance than
// anything sourced from the open web, and it disappears the moment DNS moves
// to Bunny. This fetches first and decides later: everything is written to
// data/oldsite-mirror/ with a manifest recording where each file came from and
// which wine (if any) it belongs to. Importing is a separate, deliberate step.
//
// Deliberately gentle. The old server times out under load — the redirect crawl
// lost thousands of URLs to that — so this runs a small worker pool, retries a
// timeout once, and records failures rather than dying on them.
//
//   node tools/oldsiteharvest/harvest.mjs [--limit N]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname } from 'node:path'

const OUT = join('data', 'oldsite-mirror')
const MANIFEST = join(OUT, 'manifest.json')
const OLD = 'https://www.finevines.com'
const CONCURRENCY = 5
const TIMEOUT_MS = 30000

const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity

mkdirSync(OUT, { recursive: true })

const redirects = JSON.parse(readFileSync('redirects.json', 'utf8'))
const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
const isPhoto = (x) => !!x.imagePath && !/\.svg$/i.test(x.imagePath)
const bySlug = new Map()
for (const w of wines) bySlug.set('/wines/' + w.slug + '/', w)

// Every old-site product page the redirect crawl found: /portfolio/<producer>/<wine>.
const pages = [...new Set(Object.keys(redirects).filter((k) => /^\/portfolio\/[^/?]+\/[^/?]+$/.test(k)))].sort()
const work = pages.slice(0, LIMIT)

console.log(`${pages.length} old-site product pages known; harvesting ${work.length}`)

// Resume: never re-fetch what a previous run already stored.
const done = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : []
const seen = new Set(done.map((d) => d.oldPath))
if (seen.size) console.log(`resuming — ${seen.size} already harvested`)

const results = [...done]
const failures = []

function fileNameFor(imageUrl) {
  const decoded = decodeURIComponent(imageUrl.split('/').pop())
  const ext = extname(decoded).toLowerCase() || '.jpg'
  const stem = decoded
    .slice(0, decoded.length - extname(decoded).length)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${stem}${ext}`
}

async function fetchWithRetry(url, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...opts })
    } catch (e) {
      if (attempt === 1) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function harvest(oldPath) {
  const target = redirects[oldPath]
  const wine = bySlug.get(target)

  const res = await fetchWithRetry(OLD + oldPath)
  if (!res.ok) throw new Error('page HTTP ' + res.status)
  const html = await res.text()

  // Drupal keeps product imagery under /sites/default/files/product/.
  const urls = [...new Set([...html.matchAll(/https?:\/\/[^"'\s]*\/sites\/default\/files\/product\/[^"'\s)\\]+/g)].map((m) => m[0]))]
  if (!urls.length) return { oldPath, target, sku: wine?.sku ?? null, images: [], note: 'no product image on the page' }

  const images = []
  for (const imageUrl of urls) {
    const ir = await fetchWithRetry(imageUrl)
    if (!ir.ok) {
      failures.push({ oldPath, imageUrl, error: 'image HTTP ' + ir.status })
      continue
    }
    const buf = Buffer.from(await ir.arrayBuffer())
    const file = fileNameFor(imageUrl)
    writeFileSync(join(OUT, file), buf)
    images.push({
      imageUrl,
      file,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    })
  }

  return {
    oldPath,
    target,
    sku: wine?.sku ?? null,
    wineHadPhoto: wine ? isPhoto(wine) : null,
    images,
  }
}

let cursor = 0
let completed = 0
async function worker() {
  while (cursor < work.length) {
    const oldPath = work[cursor++]
    if (seen.has(oldPath)) {
      completed++
      continue
    }
    try {
      const r = await harvest(oldPath)
      results.push(r)
    } catch (e) {
      failures.push({ oldPath, error: String(e.message || e).slice(0, 120) })
    }
    completed++
    if (completed % 25 === 0) {
      const withImg = results.filter((r) => r.images.length).length
      console.log(`  ${completed}/${work.length} pages · ${withImg} with imagery · ${failures.length} failures`)
      writeFileSync(MANIFEST, JSON.stringify(results, null, 1))
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

writeFileSync(MANIFEST, JSON.stringify(results, null, 1))
writeFileSync(join(OUT, 'failures.json'), JSON.stringify(failures, null, 1))

const withImages = results.filter((r) => r.images.length)
const files = withImages.flatMap((r) => r.images)
const bytes = files.reduce((n, i) => n + i.bytes, 0)
const rescues = withImages.filter((r) => r.wineHadPhoto === false)

console.log('\n=================================================')
console.log('pages harvested        :', results.length)
console.log('pages with imagery     :', withImages.length)
console.log('image files mirrored   :', files.length, `(${(bytes / 1048576).toFixed(1)} MB)`)
console.log('failures               :', failures.length)
console.log('--- the point of the exercise ---')
console.log('wines with NO photo today that now have a mirrored old-site image:', rescues.length)
console.log('manifest:', MANIFEST)
