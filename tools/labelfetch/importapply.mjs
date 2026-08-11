export function winesForSlug(wines, slug) {
  return wines.filter((wine) => wine.slug === slug);
}

// data/wines.json is normally emitted by Go's encoding/json, which escapes
// HTML-significant runes. Match that stable representation so a Node-side
// image import changes only the affected catalog records instead of producing
// a whole-file diff for every ampersand and angle bracket.
export function catalogJSON(wines) {
  return JSON.stringify(wines, null, 2)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029') + '\n';
}

export function isImageStandIn(wine) {
  return Boolean(
    wine && (
      !wine.imagePath ||
      wine.imagePath.endsWith('.svg') ||
      wine.imageSource === 'generated-photo' ||
      wine.imageSource === 'label-scan'
    )
  );
}

export function wineForImageUpgrade(wines, slug) {
  const matching = winesForSlug(wines, slug);
  return matching.find(isImageStandIn) || matching[0];
}
