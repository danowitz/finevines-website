export function winesForSlug(wines, slug) {
  return wines.filter((wine) => wine.slug === slug);
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
