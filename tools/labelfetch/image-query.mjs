// Search exactly what a person sees in the catalog. Do not append search hints,
// rewrite producers, quote fragments, or generate fallback queries: pasting the
// full display name and vintage into image search is the measured behavior.
export function imageSearchQuery(wine) {
  return `${String(wine.name || '').trim()} ${String(wine.vintage || '').trim()}`
    .replace(/\s+/g, ' ')
    .trim();
}

export function uniqueImageTargets(wines) {
  const bySlug = new Map();
  for (const wine of wines) {
    const current = bySlug.get(wine.slug);
    if (!current) {
      bySlug.set(wine.slug, { ...wine, imageTargetSkus: wine.sku ? [wine.sku] : [] });
    } else if (wine.sku && !current.imageTargetSkus.includes(wine.sku)) {
      current.imageTargetSkus.push(wine.sku);
    }
  }
  return [...bySlug.values()];
}
