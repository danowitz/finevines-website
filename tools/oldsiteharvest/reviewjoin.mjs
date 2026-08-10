// Joins data/oldsite-mirror/manifest.json against data/wines.json for the
// human review page (reviewpage.mjs), and classifies each joined wine as a
// rescue (no current photo) or a contest (current photo AND an old-site
// photo). Pure and side-effect-free on purpose: this is the part of the
// review tool where a wrong join or a wrong classification is silent — the
// page would just show a human the wrong comparison — so it is unit tested
// on its own rather than eyeballed in the rendered HTML.
//
// Classification is computed fresh from the CURRENT data/wines.json, not from
// the manifest's own wineHadPhoto flag: the manifest was frozen at harvest
// time, and the catalog's image state has kept moving since (imports,
// watermark pulls, SVG cleanup). "currently on the FineVines site" means
// right now, not whatever was true when the mirror ran.

// A wine has a real photograph, as opposed to the generated neutral
// "Product image unavailable" placeholder, exactly when it has an imagePath
// that is not an .svg. Mirrors tools/oldsiteharvest/harvest.mjs's isPhoto and
// tools/coverage/report.mjs's isPhoto — same rule, kept in sync by hand
// because none of the three files import from another.
export function isPhoto(wine) {
  return Boolean(wine && wine.imagePath && !/\.svg$/i.test(wine.imagePath));
}

// joinManifest matches each manifest entry to a catalog row: first by the
// entry's `target` (the /wines/<slug>/ URL the redirect matcher resolved it
// to) against the wine's own slug, and only when that fails, by exact SKU —
// covering a wine that has since been renamed or re-vintaged and so no longer
// owns the slug the old site's redirect pointed at.
//
// Returns { rows, rescues, contests, stats }. `rows` holds one entry per
// joined wine, with every mirrored image gathered onto it (several old-site
// pages — a listing photo and a detail photo, say — can point at the same
// wine, and a reviewer needs to see all of them as candidates, not just the
// first). `stats` reports how many entries joined by each route, and how many
// could not be joined at all, so a human can sanity-check the join itself
// before trusting anything downstream of it.
export function joinManifest(manifest, wines) {
  const bySlug = new Map(wines.map((w) => [`/wines/${w.slug}/`, w]));
  const bySku = new Map(wines.filter((w) => w.sku).map((w) => [w.sku, w]));

  const stats = { byTarget: 0, bySku: 0, unmatched: 0, skippedNoSku: 0 };
  const rowsByWine = new Map();

  for (const entry of manifest) {
    // No SKU means the redirect crawl could not resolve this old-site page to
    // any wine at all (the /portfolio/ catch-all target) — there was never a
    // catalog row to join to, so it is not a failed join, it is simply not a
    // candidate.
    if (!entry.sku) {
      stats.skippedNoSku++;
      continue;
    }

    let wine = bySlug.get(entry.target);
    let matchedBy = 'target';
    if (!wine) {
      wine = bySku.get(entry.sku);
      matchedBy = 'sku';
    }
    if (!wine) {
      stats.unmatched++;
      continue;
    }
    if (matchedBy === 'target') stats.byTarget++;
    else stats.bySku++;

    let row = rowsByWine.get(wine);
    if (!row) {
      row = {
        sku: wine.sku,
        slug: wine.slug,
        producer: wine.producer || '',
        name: wine.name || '',
        vintage: wine.vintage || '',
        currentImagePath: wine.imagePath || null,
        currentIsPhoto: isPhoto(wine),
        oldSiteImages: [],
      };
      rowsByWine.set(wine, row);
    }

    for (const img of entry.images || []) {
      if (row.oldSiteImages.some((existing) => existing.sha256 === img.sha256)) continue;
      row.oldSiteImages.push({
        file: img.file,
        imageUrl: img.imageUrl,
        bytes: img.bytes,
        sha256: img.sha256,
        oldPath: entry.oldPath,
      });
    }
  }

  // A joined wine that contributed zero images (the old-site page existed but
  // "no product image on the page") has nothing for a reviewer to look at.
  const rows = [...rowsByWine.values()].filter((r) => r.oldSiteImages.length > 0);
  const rescues = rows.filter((r) => !r.currentIsPhoto);
  const contests = rows.filter((r) => r.currentIsPhoto);

  return { rows, rescues, contests, stats };
}
