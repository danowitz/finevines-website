export function winesForSlug(wines, slug) {
  return wines.filter((wine) => wine.slug === slug);
}
