// Search exactly what a person sees in the catalog. Do not append search hints,
// rewrite producers, quote fragments, or generate fallback queries: pasting the
// full display name and vintage into image search is the measured behavior.
export function imageSearchQuery(wine) {
  return `${String(wine.name || '').trim()} ${String(wine.vintage || '').trim()}`
    .replace(/\s+/g, ' ')
    .trim();
}

// The catalog sometimes stores the producer separately and sometimes already
// includes it in the display name. Normalize that representation once so the
// production search and human review links cannot drift apart.
export function catalogImageName(wine) {
  const name = String(wine.name || '').replace(/\*+/g, '').replace(/\b\d+\/\d+\b/g, '').trim();
  return wine.producer && !name.toLowerCase().startsWith(String(wine.producer).toLowerCase())
    ? `${wine.producer} ${name}`
    : name;
}

export function catalogImageSearchQuery(wine) {
  return imageSearchQuery({ name: catalogImageName(wine), vintage: wine.vintage });
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
