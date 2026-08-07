// Re-matches the OLD finevines.com product pages to catalog rows.
//
// The old site is still live, still serving its images, and internally
// correct: each product page is titled for the wine it depicts. What was wrong
// was our matcher, which paired pages to catalog rows on the producer alone —
// so Anne Parent's "Pommard La Croix Blanche" page landed on our Pommard 1er
// Cru Croix Noires, and Maison Ambroise's Échezeaux on their Clos Vougeot. 223
// of the images the full-resolution audit pulled came from that matcher.
//
// This takes the page TITLE as the authority for what a page shows, and hands
// the identity judgement to imgcheck — one tested implementation, now with the
// sibling rule that refuses a wine that could be another by the same producer.
// A catalog row is claimed only when EXACTLY ONE page is accepted for it;
// ambiguity is left alone rather than guessed at.
//
//   node tools/labelfetch/oldsite.mjs            # report what it would match
//   node tools/labelfetch/oldsite.mjs --apply    # download the matched images
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { binPath } from './env.mjs';

const run = promisify(execFile);
const ORIGIN = 'https://www.finevines.com';

// pageTitle is the wine as the OLD SITE names it: the <title> minus the site
// suffix. Drupal's 404 page carries a title too, so that one specific value is
// treated as "no wine here" rather than a name to match against.
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  if (!m) return null;
  const text = decodeEntities(m[1]).replace(/\s*\|\s*Fine Vines\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (!text || /^page not found$/i.test(text)) return null;
  return text;
}

function decodeEntities(s) {
  const named = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
    acirc: 'â', agrave: 'à', eacute: 'é', egrave: 'è', ecirc: 'ê',
    icirc: 'î', ocirc: 'ô', ugrave: 'ù', ucirc: 'û', ccedil: 'ç',
    uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', rsquo: '’',
  };
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m0, n) => (n.toLowerCase() in named ? named[n.toLowerCase()] : m0));
}

// productImage is the bottle/label file the page shows. Drupal files them all
// under sites/default/files/product/, which separates them from the theme's
// logos, icons and banners without needing to guess from the markup around them.
// The pages serve a Drupal image-style derivative —
//   /sites/default/files/styles/product_555/public/product/<dir>/<file>?itok=…
// — so the style segment is stripped back to the original file, which is
// larger and is what the manifest already records for the entries we kept.
export function productImage(html, origin) {
  const re = /<img[^>]+src=["']([^"']*\/sites\/default\/files\/[^"']*product\/[^"']+)["']/i;
  const m = re.exec(html || '');
  if (!m) return null;
  const src = m[1]
    .replace(/\/styles\/[^/]+\/public\//, '/')
    .replace(/\?.*$/, '');
  if (/^https?:\/\//i.test(src)) return src;
  return origin.replace(/\/$/, '') + (src.startsWith('/') ? src : '/' + src);
}

// productPages picks the old product URLs out of the crawled redirect map:
// exactly /portfolio/<producer>/<wine>, never the listing or a producer index.
export function productPages(redirectMap) {
  return Object.keys(redirectMap || {})
    .filter((p) => p.startsWith('/portfolio/') && p.split('/').filter(Boolean).length === 3)
    .sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  const CHECK = binPath('imgcheck');
  // imgcheck wants an image path even when judging supplied label text; any
  // real bottle serves, and -single-bottle skips the shape gate it would apply.
  const STUB = 'assets/img/wines/1-1-3-un-mes-un-fan-tres-1-1-3-cava-brut.jpg';

  const wines = JSON.parse(await readFile('data/wines.json', 'utf8'));
  const redirects = JSON.parse(await readFile('dist/redirects.json', 'utf8'));
  const pages = productPages(redirects);
  console.log(`${pages.length} old product pages in the crawl map`);

  // Only wines that still need a picture are worth matching.
  const needy = wines.filter((w) => (w.imagePath || '').endsWith('.svg'));
  console.log(`${needy.length} catalog wines currently on a placeholder\n`);

  // Group the needy by producer key so each page is only tested against wines
  // it could plausibly be, keeping this to a few thousand cheap checks.
  const keyOf = (s) =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t.length > 2)[0] || '';
  const byKey = new Map();
  for (const w of needy) {
    const k = keyOf(w.producer || w.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(w);
  }

  // Phase 1 — fetch every page. Network-bound, so run several at once; a page
  // that hangs must not stall the run, hence the per-request timeout. The
  // result is cached: the old site is static and a full sweep is ten minutes,
  // which is a long time to re-spend while iterating on the matching. --refetch
  // ignores the cache.
  const PAGE_CACHE = 'out-bottle/oldsite-pages.json';
  let scraped = [];
  if (!process.argv.includes('--refetch')) {
    try {
      scraped = JSON.parse(await readFile(PAGE_CACHE, 'utf8'));
      console.log(`${scraped.length} pages loaded from ${PAGE_CACHE} (--refetch to re-crawl)\n`);
    } catch { /* no cache yet */ }
  }
  if (!scraped.length) {
    scraped = await crawl();
    await mkdir('out-bottle', { recursive: true });
    await writeFile(PAGE_CACHE, JSON.stringify(scraped, null, 1));
  }

  async function crawl() {
  const scraped = [];
  let fetched = 0, titled = 0, withImage = 0;
  const CONC = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < pages.length) {
      const path = pages[cursor++];
      const url = ORIGIN + path;
      let html = '';
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'finevines-site-rebuild/1.0' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) continue;
        html = await res.text();
      } catch { continue; } finally { fetched++; }
      const title = pageTitle(html);
      if (!title) continue;
      titled++;
      const image = productImage(html, ORIGIN);
      if (!image) continue;
      withImage++;
      scraped.push({ path, url, title, image });
      if (scraped.length % 200 === 0) console.log(`  ...${fetched}/${pages.length} pages`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\n${fetched} pages fetched, ${titled} titled, ${withImage} carrying a product image`);
  return scraped;
  }

  // Phase 2 — judge every plausible pairing in ONE imgcheck process. Spawning
  // it per pairing re-parsed the whole catalog each time and turned minutes
  // into hours; the batch loads it once.
  const pairs = [];
  for (const s of scraped) {
    const seg = s.path.split('/').filter(Boolean)[1] || '';
    for (const w of byKey.get(keyOf(seg)) || []) {
      let name = w.name || '';
      const p = (w.producer || '').trim();
      if (p && !name.toLowerCase().startsWith(p.toLowerCase())) name = p + ' ' + name;
      pairs.push({ w, s, line: [name, p, s.title].join('\t').replace(/\r?\n/g, ' ') });
    }
  }
  console.log(`${pairs.length} plausible pairings to judge`);

  // spawn, not execFile: execFile has no `input` option (that is spawnSync's),
  // so passing one silently leaves the child's stdin unwritten and unclosed and
  // both sides block forever waiting on each other.
  let verdicts = [];
  if (pairs.length) {
    verdicts = await new Promise((resolve, reject) => {
      const child = spawn(CHECK, ['-batch', '-index', 'data/token-index.json', '-wines', 'data/wines.json'],
        { stdio: ['pipe', 'pipe', 'inherit'] });
      const chunks = [];
      child.stdout.on('data', (d) => chunks.push(d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`imgcheck -batch exited ${code}`));
        resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter((l) => l !== ''));
      });
      child.stdin.on('error', reject);
      child.stdin.end(pairs.map((p) => p.line).join('\n') + '\n');
    });
  }
  if (verdicts.length !== pairs.length) {
    console.error(`verdict count ${verdicts.length} != pairing count ${pairs.length}; refusing to guess`);
    process.exit(1);
  }

  const claims = new Map(); // slug -> {title, page, image}
  const ambiguous = new Set();
  pairs.forEach((p, i) => {
    if (verdicts[i] !== '1') return;
    const prev = claims.get(p.w.slug);
    if (prev && prev.page !== p.s.url) {
      ambiguous.add(p.w.slug); // two pages both accepted: refuse to guess
      return;
    }
    claims.set(p.w.slug, { title: p.s.title, page: p.s.url, image: p.s.image });
  });

  for (const s of ambiguous) claims.delete(s);
  console.log(
    `\n${claims.size} placeholder wines matched to exactly one page; ${ambiguous.size} dropped as ambiguous`
  );

  const out = [...claims].map(([slug, c]) => ({ slug, ...c }));
  await mkdir('out-bottle', { recursive: true });
  await writeFile('out-bottle/oldsite-matches.json', JSON.stringify(out, null, 1));
  console.log('matches -> out-bottle/oldsite-matches.json');

  if (!apply) {
    console.log('\nnothing downloaded — re-run with --apply');
    process.exit(0);
  }

  await mkdir('data/oldsite-fetched', { recursive: true });
  let got = 0;
  for (const c of out) {
    try {
      const res = await fetch(c.image, { headers: { 'user-agent': 'finevines-site-rebuild/1.0' } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) continue; // a tracking pixel or an error page
      await writeFile(`data/oldsite-fetched/${c.slug}.img`, buf);
      got++;
    } catch { /* leave it for the next run */ }
  }
  console.log(`downloaded ${got} images to data/oldsite-fetched/`);
}
