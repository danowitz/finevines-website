import { normalize } from './match.mjs';

function isRealPhoto(wine) {
  const path = String(wine?.imagePath || '');
  return Boolean(path) &&
    !path.toLowerCase().endsWith('.svg') &&
    wine?.imageSource !== 'generated-photo' &&
    wine?.imageSource !== 'label-scan';
}

function productKey(wine) {
  const name = normalize(wine?.name || '');
  const vintage = String(wine?.vintage || '').trim();
  return name && vintage ? `${name}|${vintage}` : '';
}

export function buildCatalogImageDonors(catalog) {
  const donors = new Map();
  for (const wine of catalog || []) {
    const key = productKey(wine);
    if (key && isRealPhoto(wine) && !donors.has(key)) donors.set(key, wine);
  }
  return donors;
}

export function reusableCatalogImage(donors, wine) {
  const donor = donors.get(productKey(wine));
  return donor && donor.sku !== wine?.sku ? donor : null;
}
