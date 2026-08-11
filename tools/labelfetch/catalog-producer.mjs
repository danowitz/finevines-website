import { normalize } from './match.mjs';

export function buildProducerLookup(wines) {
  const byName = new Map();
  for (const wine of wines || []) {
    const name = normalize(wine?.name || '');
    const producer = String(wine?.producer || '').trim();
    if (!name || !producer) continue;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(producer);
  }
  return byName;
}

export function expectedProducer(wine, lookup) {
  if (String(wine?.producer || '').trim()) return String(wine.producer).trim();
  const producers = lookup.get(normalize(wine?.name || ''));
  return producers?.size === 1 ? [...producers][0] : '';
}
