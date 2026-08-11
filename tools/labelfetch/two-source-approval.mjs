import { normalize, tokens } from './match.mjs';

const EXPLICIT_REFUSAL = /visible vintage|different cuvee|producer is|source says|label says|premier cru|lacks requested|requested .*candidate|watermark/i;

export function sourceHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

export function sourceIdentityScore(name, candidate) {
  const wanted = [...new Set(tokens(name || ''))];
  if (!wanted.length) return 0;
  // The product page is the independent provenance witness. An image filename
  // can be copied verbatim onto an unrelated page or CDN and must not make a
  // generic/sibling listing look like an exact source.
  const source = normalize(candidate.page || '');
  return wanted.filter((token) => source.includes(token)).length / wanted.length;
}

export function eligibleTwoSourceCandidate(candidate) {
  return candidate?.strongestGroup === true &&
    candidate.subjectOk !== false && candidate.displayOk !== false &&
    candidate.explicitConflict !== true &&
    !EXPLICIT_REFUSAL.test(candidate.why || '') &&
    Boolean(sourceHost(candidate.page));
}

function dimensions(candidate) {
  const [width, height] = String(candidate.size || '').split('x').map(Number);
  return { width: width || 0, height: height || 0 };
}

function publishable(candidate) {
  const { width, height } = dimensions(candidate);
  return width >= 180 && height >= 500;
}

function sourceVintage(url) {
  return String(url || '').match(/\b(19|20)\d\d\b/)?.[0] || '';
}

// `pairs` uses indexes into `candidates` and comes from the local perceptual
// hash helper. Agreement is deliberately narrower than the review-page badge:
// both images must be in the selector's strongest group, come from different
// permitted hosts, carry no explicit conflict, and have source URLs that name
// this product. This prevents a generic sibling-label pair from becoming an
// identity verdict merely because the bottles look alike.
export function chooseTwoSourceApproval(record, candidates, pairs, {
  maxDistance = 14,
  minSourceIdentity = 0.70,
} = {}) {
  const agreeing = pairs.filter((pair) => {
    const left = candidates[pair.a];
    const right = candidates[pair.b];
    const leftHost = sourceHost(left?.page);
    const rightHost = sourceHost(right?.page);
    return pair.distance <= maxDistance && leftHost && rightHost && leftHost !== rightHost &&
      eligibleTwoSourceCandidate(left) && eligibleTwoSourceCandidate(right) &&
      sourceIdentityScore(record.name, left) >= minSourceIdentity &&
      sourceIdentityScore(record.name, right) >= minSourceIdentity;
  });
  if (!agreeing.length) return null;

  const memberIndexes = [...new Set(agreeing.flatMap((pair) => [pair.a, pair.b]))];
  const expectedVintage = String(record.query || record.slug || '').match(/\b(19|20)\d\d\b/)?.[0] || '';
  const identityMembers = candidates.filter((candidate) =>
    eligibleTwoSourceCandidate(candidate) &&
    sourceIdentityScore(record.name, candidate) >= minSourceIdentity);
  // The agreeing pair proves the design. Selection may use a cleaner member of
  // that already-established strongest group, but a vintage-specific catalog
  // row must prefer an exact-vintage source. If none exists, only a source with
  // no year at all may stand in; an explicit older/newer listing is not neutral.
  const selectionPool = expectedVintage
    ? (identityMembers.filter((candidate) => sourceVintage(candidate.page) === expectedVintage).length
      ? identityMembers.filter((candidate) => sourceVintage(candidate.page) === expectedVintage)
      : identityMembers.filter((candidate) => !sourceVintage(candidate.page)))
    : identityMembers;
  const ranked = selectionPool
    .map((candidate) => ({ candidate, ...dimensions(candidate) }))
    .filter(({ candidate }) => publishable(candidate))
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  if (!ranked.length) return null;

  return {
    pick: ranked[0].candidate,
    matchingImages: memberIndexes.length,
    hosts: [...new Set(agreeing.flatMap((pair) => [
      sourceHost(candidates[pair.a].page),
      sourceHost(candidates[pair.b].page),
    ]))],
  };
}
