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

// Source evidence has two deliberately separate uses. exactVintageAnchor is a
// strict identity verdict; relevance only decides which pixels are worth the
// bounded label-reader slots and can never make a candidate publishable.
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
    exactVintageAnchor: wanted.length >= 2 && wanted.every((token) => titleTokens.has(token)) &&
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

// Plan one bounded identity-reading request. A target-relevant bottle gets one
// reserved slot even when ornate sibling labels form larger or tighter groups.
// Remaining slots preserve the existing group and host diversity behavior.
export function planIdentityReading(wine, groups, limit = 3) {
  const all = [...new Map(groups.flat().map((candidate) => [candidate.id, candidate])).values()];
  const baseline = [];
  for (const group of groups) {
    const ranked = diverseRepresentatives(group).sort((left, right) =>
      Number(sourceIdentityEvidence(wine, right).exactVintageAnchor) -
      Number(sourceIdentityEvidence(wine, left).exactVintageAnchor));
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
      return Number(rightEvidence.exactVintageAnchor) - Number(leftEvidence.exactVintageAnchor) ||
        Number(rightEvidence.requestedVintageInSource) - Number(leftEvidence.requestedVintageInSource) ||
        rightEvidence.relevance - leftEvidence.relevance ||
        Number(right.cleanBackground) - Number(left.cleanBackground) ||
        area(right) - area(left);
    });
  if (!targeted.length || baseline.some(({ id }) => id === targeted[0].id)) return baseline;
  return [targeted[0], ...baseline].slice(0, limit);
}
