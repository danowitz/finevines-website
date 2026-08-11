// Preserve the catalog identity in the first search. Removing the producer or
// vintage is a fallback strategy, never the default: exact Google Image queries
// are what surfaced the producer/importer photographs the old page scraper hid.
export function imageSearchQuery(wine) {
  const name = String(wine.name || '')
    .replace(/\*+/g, '')
    .replace(/\b\d+\/\d+\b/g, '')
    .replace(/\b\d+\s*(ml|l)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const rawProducer = String(wine.producer || '').trim();
  // Salesforce's brand is "Cider Farm"; the producer and every useful search
  // result use "The Cider Farm". Without the article, Google converges on the
  // unrelated Sea Cider Farm. Keep measured catalog/search aliases explicit.
  const producer = rawProducer.toLowerCase() === 'cider farm' ? 'The Cider Farm' : rawProducer;
  const nameLower = name.toLowerCase();
  const rawLower = rawProducer.toLowerCase();
  const identity = rawProducer && nameLower.startsWith(rawLower)
    ? `${producer}${name.slice(rawProducer.length)}`
    : producer && !nameLower.startsWith(producer.toLowerCase())
      ? `${producer} ${name}`
      : name;
  return `${identity} ${wine.vintage || ''} bottle`.replace(/\s+/g, ' ').trim();
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
