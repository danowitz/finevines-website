import { normalize, tokens } from './match.mjs';

function host(candidate) {
  if (candidate.host) return String(candidate.host).replace(/^www\./, '');
  try { return new URL(candidate.url).host.replace(/^www\./, ''); } catch { return ''; }
}

function area(candidate) {
  return (candidate.width || 0) * (candidate.height || 0);
}

function vintages(text) {
  return String(text || '').match(/\b(?:19|20)\d{2}\b/g) || [];
}

function uniqueTokens(text) {
  return [...new Set(tokens(text || ''))];
}

function sourceText(candidate) {
  return [candidate.title, candidate.url, candidate.context].filter(Boolean).join(' ');
}

// Source evidence only ranks discovery results and reading slots. It can never
// make pixels publishable; identity must still come from the blind reader or a
// verified exact visual copy of reader-proven pixels.
export function sourceIdentityEvidence(wine, candidate) {
  const wanted = uniqueTokens(wine.name);
  const title = normalize(candidate.title || '');
  const titleTokens = new Set(tokens(candidate.title || ''));
  const combinedTokens = new Set(tokens(sourceText(candidate)));
  const wantedVintage = vintages(wine.vintage)[0] || '';
  const titleVintages = vintages(candidate.title);
  const combinedVintages = vintages(sourceText(candidate));
  const titleMatches = wanted.filter((token) => title.includes(token)).length;
  const combinedMatches = wanted.filter((token) => combinedTokens.has(token)).length;
  const conflictingTitleVintage = Boolean(
    wantedVintage && titleVintages.length && !titleVintages.includes(wantedVintage),
  );
  return {
    corroboratesTitle: wanted.length >= 2 && !conflictingTitleVintage && titleMatches / wanted.length >= 0.75,
    exactVintageSignal: wanted.length >= 2 && wanted.every((token) => titleTokens.has(token)) &&
      Boolean(wantedVintage) && titleVintages.length > 0 &&
      titleVintages.every((vintage) => vintage === wantedVintage),
    relevance: wanted.length ? combinedMatches / wanted.length : 0,
    requestedVintageInSource: Boolean(wantedVintage && combinedVintages.includes(wantedVintage)),
  };
}

function rankedRepresentatives(group) {
  return [...group].sort((left, right) =>
    Number(right.shapeOk) - Number(left.shapeOk) ||
    Number(right.cleanBackground) - Number(left.cleanBackground) ||
    area(right) - area(left));
}

export function bestVisualRepresentative(group) {
  return rankedRepresentatives(group)[0] || null;
}

function diverseRepresentatives(group) {
  const ranked = rankedRepresentatives(group);
  const picked = ranked.length ? [ranked[0]] : [];
  const second = ranked.find((candidate) =>
    candidate !== picked[0] && host(candidate) !== host(picked[0]));
  if (second) picked.push(second);
  const third = ranked.find((candidate) => !picked.includes(candidate));
  if (third) picked.push(third);
  return picked;
}

// Plan bounded identity reading. A target-relevant bottle gets one reserved
// primary slot even when ornate sibling labels form larger or tighter groups.
// Remaining slots preserve group and host diversity; callers may spend the
// entries after the first three only when the primary batch has no pixel anchor.
export function planIdentityReading(wine, groups, limit = 3) {
  const all = [...new Map(groups.flat().map((candidate) => [candidate.id, candidate])).values()];
  const baseline = [];
  for (const group of groups) {
    const ranked = diverseRepresentatives(group).sort((left, right) =>
      Number(sourceIdentityEvidence(wine, right).exactVintageSignal) -
      Number(sourceIdentityEvidence(wine, left).exactVintageSignal));
    for (const candidate of ranked) {
      if (!baseline.some(({ id }) => id === candidate.id)) baseline.push(candidate);
      if (baseline.length === limit) break;
    }
    if (baseline.length === limit) break;
  }
  const targeted = all
    .filter((candidate) => candidate.shapeOk && sourceIdentityEvidence(wine, candidate).relevance >= 0.60)
    .sort((left, right) => {
      const leftEvidence = sourceIdentityEvidence(wine, left);
      const rightEvidence = sourceIdentityEvidence(wine, right);
      return Number(rightEvidence.exactVintageSignal) - Number(leftEvidence.exactVintageSignal) ||
        Number(rightEvidence.requestedVintageInSource) - Number(leftEvidence.requestedVintageInSource) ||
        rightEvidence.relevance - leftEvidence.relevance ||
        Number(right.cleanBackground) - Number(left.cleanBackground) ||
        area(right) - area(left);
    });
  const planned = !targeted.length || baseline.some(({ id }) => id === targeted[0].id)
    ? [...baseline]
    : [targeted[0], ...baseline].slice(0, limit);
  // The first three preserve the bounded primary request. Additional entries
  // exist only for the miss-only second batch and never displace that order.
  const remaining = [...all].sort((left, right) => {
    const leftEvidence = sourceIdentityEvidence(wine, left);
    const rightEvidence = sourceIdentityEvidence(wine, right);
    return Number(rightEvidence.requestedVintageInSource) - Number(leftEvidence.requestedVintageInSource) ||
      rightEvidence.relevance - leftEvidence.relevance ||
      Number(right.shapeOk) - Number(left.shapeOk) ||
      Number(right.cleanBackground) - Number(left.cleanBackground) ||
      area(right) - area(left);
  });
  for (const candidate of remaining) {
    if (!planned.some(({ id }) => id === candidate.id)) planned.push(candidate);
    if (planned.length === limit) break;
  }
  return planned.slice(0, limit);
}
