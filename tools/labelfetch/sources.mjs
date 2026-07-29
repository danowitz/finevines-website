// Which hosts may supply a catalog image.
//
// Vivino is BLOCKED. Its bottle photography is the right shape — normalised,
// cut out, consistently framed, ~270x960 — and it was the first source that
// worked, but every file carries a burned-in "vivino" watermark. Publishing a
// competitor's branded images on a licensed distributor's catalog is a
// different problem from the copyright question already settled with the
// client: it is not "we used someone's photo", it is "our product pages
// advertise Vivino". Ruled out 2026-07-28.
//
// This is enforced rather than documented because the failure is silent. A
// watermark survives resizing and re-encoding, nobody reviewing 2,000 staged
// thumbnails will catch it, and the images are attractive enough that a future
// run would reach for them again.
//
// Watermark detection from pixels is NOT the check here — see
// tools/imgcheck: OCR reads Vivino's mark as "vlvlno", and any rule loose
// enough to catch that also matches "vino", which appears on most Italian
// labels. The download host is certain where the pixels are not.

// Hosts known to brand their images. Substring match, so subdomains and
// regional variants are covered without listing each.
export const BLOCKED = [
  'vivino',
  'wine-searcher',
  'winesearcher',
  'gettyimages',
  'alamy',
  'shutterstock',
  'istockphoto',
  'dreamstime',
  // Search engines are for DISCOVERY, never for images. A results page is
  // covered in thumbnails of other wines, and taking one produces a candidate
  // with no product page behind it and no relationship to the query beyond
  // having appeared near it. This is not hypothetical: a run took a thumbnail
  // off a results page and a vision model then judged it on its own merits and
  // accepted an Australian Shiraz for a Portuguese white — the exact silent
  // substitution the whole verification chain exists to prevent, let in
  // through the back door.
  'duckduckgo',
  'bing.com',
  'google.com',
  'gstatic.com',
  'googleusercontent',
  'yandex',
  'ecosia',
];

// hostOf returns the lowercase host of a URL, or '' if it will not parse.
export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

// blockedBy returns the rule a URL trips, or '' if the source is allowed.
export function blockedBy(url) {
  const h = hostOf(url);
  if (!h) return 'unparseable url';
  return BLOCKED.find((b) => h.includes(b)) || '';
}

// assertAllowed throws rather than returning a flag. A source rule that can be
// ignored by not checking the return value is not a rule.
export function assertAllowed(url) {
  const b = blockedBy(url);
  if (b) throw new Error(`blocked image source (${b}): ${url}`);
  return url;
}
