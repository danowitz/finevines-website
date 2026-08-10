// Shared identity rule for matching an old-site page to a catalog wine.
//
// Two tools need the exact same rule and must never drift apart:
//  - localmatch.mjs uses it to pair a page's photograph to a wine.
//  - prose-extract.mjs uses it to pair a page's prose to a wine.
//
// Identity rules, learned the hard way (see localmatch.mjs's header for the
// incident history):
//  - Matching must be BIDIRECTIONAL: every identifying token of the wine in
//    the page's title AND every token of the title in the wine. One-way
//    containment put a village Pommard photo on a 1er Cru Les Epenots.
//  - No edit-distance tolerance. "Genevrieres Dessus" and "Genevrieres
//    Dessous" are two different vineyards, not a fuzzy match of one.

export const STOP = new Set([
  'the', 'and', 'of', 'de', 'du', 'des', 'la', 'le', 'les', 'domaine', 'dom',
  'chateau', 'ch', 'maison', 'weingut', 'winery', 'estate', 'wine', 'wines',
  'cru', 'grand', 'premier', '1er', 'vieilles', 'vignes', 'vv', 'ml', 'nv',
  'vin', 'vins',
]);

export const decode = (s) =>
  (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&rsquo;/g, "'")
    .replace(/&eacute;/g, 'e')
    .replace(/&egrave;/g, 'e')
    .replace(/&[a-z]+;/gi, ' ');

export const normalize = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Tokenize free text into the identity token set: normalized, stopwords and
// tokens of length <= 2 dropped, pure numbers (vintages) dropped.
export const tokens = (s) =>
  new Set(
    normalize(decode(s))
      .split(' ')
      .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t))
  );

// Bidirectional exact token-set equality — the whole rule in one place.
export const tokensEqual = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));

// Convenience: does `title`'s token set exactly equal the wine's producer+name
// token set? Returns false for degenerate matches (fewer than 2 tokens on
// either side) since those identify nothing.
export const titleMatchesWine = (title, wine) => {
  const t = tokens(title);
  const w = tokens(`${wine.producer || ''} ${wine.name || ''}`);
  if (t.size < 2 || w.size < 2) return false;
  return tokensEqual(t, w);
};
