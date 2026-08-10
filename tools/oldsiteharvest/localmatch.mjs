// Match wines that still lack a photograph against the complete local mirror.
//
// Everything runs off data/oldsite-full/, so this can be re-run as often as it
// takes and covers all 1,219 pages rather than the subset a network pass
// managed to reach.
//
// Identity rules, learned the hard way:
//  - The redirect map is NOT usable for this. It matches URLs well enough to
//    route a visitor and badly enough to put a rose photo on a rouge.
//  - Matching must be BIDIRECTIONAL: every identifying token of the wine in the
//    page's title AND every token of the title in the wine. One-way containment
//    put a village Pommard photo on a 1er Cru Les Epenots.
//  - No edit-distance tolerance. It read "Genevrieres Dessus" and "Genevrieres
//    Dessous" as one vineyard; they are two.
//  - A filename declaring a colour the wine contradicts is rejected outright:
//    the old site's own Bandol Rouge page carries a file called "bandol rose".
//
//   node tools/oldsiteharvest/localmatch.mjs           # report
//   node tools/oldsiteharvest/localmatch.mjs --write   # write decisions JSON

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { tokens as tok, tokensEqual as eq, decode } from './tokenmatch.mjs'

const FULL = join('data', 'oldsite-full')
const PAGES = join(FULL, 'pages')
const ASSETS = join(FULL, 'assets')

const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
const isPhoto = (w) => !!w.imagePath && !/\.svg$/i.test(w.imagePath)

// Colour/style families — an image whose name declares one the wine contradicts
// is wrong no matter how well the page title matched.
const FAM = { rose:['rose','rosado','rosato'], white:['blanc','bianco','white','blanche'], red:['rouge','rosso','red','tinto'], sparkling:['cremant','champagne','spumante','sekt'] }
const fam = (s) => {
  const t = (s||'').toLowerCase(); const o = new Set()
  for (const [k, ws] of Object.entries(FAM)) if (ws.some((w) => new RegExp('(^|[^a-z])'+w+'([^a-z]|$)').test(t))) o.add(k)
  return o
}

// The exact transform fullmirror.mjs used when it wrote each asset to disk.
const MAX_BASE = 120
const mirrorPath = (p) => {
  const cleaned = p.replace(/^\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._/-]/g, '_')
  const segs = cleaned.split('/')
  const base = segs.pop()
  if (base.length <= MAX_BASE) return [...segs, base].join('/')
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 10)
  return [...segs, base.slice(0, MAX_BASE - ext.length - 11) + '-' + hash + ext].join('/')
}

const needy = wines.filter((w) => !isPhoto(w)).map((w) => ({ w, t: tok(`${w.producer||''} ${w.name||''}`) }))
console.log('wines still needing a photograph:', needy.length)

const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : [])
const htmlFiles = walk(PAGES).filter((f) => f.endsWith('.html'))
console.log('local pages to scan:', htmlFiles.length)

// Every asset actually on disk, indexed by basename so a page's reference can
// be resolved to a real file.
const assetByBase = new Map()
for (const f of walk(ASSETS)) {
  const b = basename(f)
  if (!assetByBase.has(b)) assetByBase.set(b, f)
}
console.log('local assets on disk:', assetByBase.size)

const matches = []
const ambiguous = []
let scanned = 0

for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8')
  // Producer INDEX pages list many wines and have no single product identity.
  if (/\/portfolio\/producer\//.test(html.slice(0, 4000)) && /class="[^"]*producer/.test(html)) { /* still allowed below via title check */ }

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = decode((h1?.[1] || tt?.[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\s*\|\s*Fine Vines\s*$/i, '').replace(/\s+/g, ' ').trim()
  if (!title) continue

  const pt = tok(title)
  if (pt.size < 2) continue

  const hits = needy.filter((c) => c.t.size >= 2 && eq(pt, c.t))
  scanned++
  if (hits.length !== 1) { if (hits.length > 1) ambiguous.push(title); continue }
  const wine = hits[0].w

  // Images this page references, original preferred over style derivative.
  const refs = [...new Set([...html.matchAll(/\/sites\/default\/files\/[^"'\s)]*\/(?:product|images\/product|importer)\/[^"'\s)]+/g)].map((m) => m[0]))]
    .filter((u) => !/\/default_images\//.test(u))
    .map((u) => u.replace(/\/styles\/[^/]+\/public\//, '/').replace(/\?itok=[^&]*$/, ''))
  if (!refs.length) continue

  // Resolve to a file that actually exists in the mirror. fullmirror.mjs saved
  // each asset under its URL path with every non-[A-Za-z0-9._/-] replaced by
  // '_', so the same transform has to be applied here — looking the raw
  // filename up finds nothing, because the stored name is already sanitized.
  let file = null
  for (const u of refs) {
    const direct = join(ASSETS, mirrorPath(u.split('?')[0]))
    if (existsSync(direct)) { file = direct; break }
    const b = basename(mirrorPath(u.split('?')[0]))
    const cand = assetByBase.get(b)
    if (cand) { file = cand; break }
  }
  if (!file) continue

  const ff = fam(basename(file))
  const wf = fam(`${wine.name||''} ${wine.color||''}`)
  if (ff.size && wf.size && ![...ff].some((x) => wf.has(x))) continue // colour contradiction

  matches.push({ sku: wine.sku, slug: wine.slug, wineName: `${wine.producer||''} ${wine.name||''}`.trim(), title, localFile: file })
}

const seen = new Set()
const unique = matches.filter((m) => { if (seen.has(m.sku)) return false; seen.add(m.sku); return true })

console.log('\npages whose title matched exactly one needy wine:', scanned)
console.log('MATCHES with a resolvable local image:', unique.length)
console.log('ambiguous titles:', ambiguous.length)
unique.slice(0, 12).forEach((m) => console.log(`   ${m.wineName}\n      title: ${m.title}\n      file : ${basename(m.localFile)}`))

if (process.argv.includes('--write')) {
  writeFileSync('data/oldsite-mirror/decisions-local.json', JSON.stringify(unique, null, 1))
  console.log('\nwrote data/oldsite-mirror/decisions-local.json')
}
