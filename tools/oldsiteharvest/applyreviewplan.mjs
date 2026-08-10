// The decision-to-action logic behind applyreview.mjs, extracted so it can be
// tested without touching a filesystem or shelling out to imgnorm — mirrors
// tools/labelfetch/importrules.mjs, which does the same for import.mjs.
//
// planActions never writes anything; it only decides, per reviewer decision,
// whether that decision requires a copy into the catalog or is a no-op. The
// CLI (applyreview.mjs) is the only place with side effects, and only acts on
// the 'copy' plans, and only when --apply is passed.

// planActions(decisions, wines) -> [{ sku, action: 'copy'|'skip', reason?,
//   wine?, sourceFile?, sourceUrl?, destPath? }]
//
// A decision of 'current' (the contest default: keep what's already there) or
// 'neither' (the reviewer looked and rejected every old-site candidate) both
// plan to 'skip' — by design, since both mean "the catalog is already
// correct" and there is nothing here that should touch data/wines.json or
// assets/. Only 'old' plans a copy, and only when the wine still exists in
// the catalog and the decision recorded which file was chosen.
export function planActions(decisions, wines) {
  const bySku = new Map(wines.map((w) => [w.sku, w]));

  return decisions.map((d) => {
    if (d.choice === 'neither') {
      return { sku: d.sku, action: 'skip', reason: 'reviewer chose neither image' };
    }
    if (d.choice === 'current') {
      return { sku: d.sku, action: 'skip', reason: 'reviewer kept the current image' };
    }
    if (d.choice !== 'old') {
      return { sku: d.sku, action: 'skip', reason: `unrecognized choice "${d.choice}"` };
    }

    const wine = bySku.get(d.sku);
    if (!wine) {
      return { sku: d.sku, action: 'skip', reason: 'no such wine in the catalog' };
    }
    if (!d.file) {
      return { sku: d.sku, action: 'skip', reason: 'no old-site file recorded for this "old" choice' };
    }

    return {
      sku: d.sku,
      action: 'copy',
      wine,
      sourceFile: d.file,
      sourceUrl: d.sourceUrl || '',
      destPath: `assets/img/wines/${wine.slug}.jpg`,
    };
  });
}
