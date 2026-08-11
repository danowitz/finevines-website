import { selectVisualPick } from './visual-pick.mjs';
import { normalize, tokens } from './match.mjs';

function host(candidate) {
  if (candidate.host) return String(candidate.host).replace(/^www\./, '');
  try { return new URL(candidate.url).host.replace(/^www\./, ''); } catch { return ''; }
}

function area(candidate) {
  return (candidate.width || 0) * (candidate.height || 0);
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function groupsFromPairs(candidates, pairs, threshold) {
  const parent = candidates.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left, right) => {
    left = find(left);
    right = find(right);
    if (left !== right) parent[right] = left;
  };
  for (const pair of pairs) {
    if (pair.score >= threshold) union(pair.a, pair.b);
  }
  const groups = new Map();
  for (let index = 0; index < candidates.length; index++) {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(candidates[index]);
    groups.set(root, group);
  }
  return [...groups.values()].filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function corroboratesTitle(wine, candidate) {
  const wanted = [...new Set(tokens(wine.name || ''))];
  if (wanted.length < 2) return false;
  const title = normalize(candidate.title || '');
  const found = wanted.filter((token) => title.includes(token));
  return found.length / wanted.length >= 0.75;
}

// Titles may corroborate a moderately similar visual pair, but they can never
// connect two images on their own. Search pages routinely carry exact product
// titles beside stale sibling-wine photographs; allowing title-only edges made
// those siblings one giant cluster and let the highest-resolution wrong label
// win.
function corroboratedVisualPairs(wine, candidates, pairs, threshold) {
  return pairs.map((pair) => {
    const left = candidates[pair.a];
    const right = candidates[pair.b];
    const titleSupport = pair.score >= 0.60 &&
      host(left) !== host(right) &&
      corroboratesTitle(wine, left) && corroboratesTitle(wine, right);
    return titleSupport ? { ...pair, score: Math.max(pair.score, threshold) } : pair;
  });
}

function representatives(group) {
  const ranked = [...group].sort((a, b) =>
    Number(b.shapeOk) - Number(a.shapeOk) ||
    Number(b.cleanBackground) - Number(a.cleanBackground) || area(b) - area(a));
  const picked = [ranked[0]];
  const second = ranked.find((candidate) =>
    candidate !== picked[0] && host(candidate) !== host(picked[0]));
  if (second) picked.push(second);
  const third = ranked.find((candidate) => !picked.includes(candidate));
  if (third) picked.push(third);
  return picked;
}

// The interface is intentionally one method. Adapters hide local image
// inspection, similarity computation, and the bounded label reader.
export function createBottleSelector({ inspect, compare, read, similarityThreshold = 0.90, inspectConcurrency = 3 }) {
  return {
    async select(wine, firstTenCandidates) {
      const inspected = (await mapLimit(firstTenCandidates.slice(0, 10), inspectConcurrency, async (candidate) => ({
        ...candidate,
        ...await inspect(candidate),
      }))).filter((candidate) => candidate.visualOk !== false);
      if (inspected.length < 2) return { pick: null, reason: 'fewer than two decodable images' };

      const pairs = corroboratedVisualPairs(wine, inspected, await compare(inspected), similarityThreshold);
      const groups = groupsFromPairs(inspected, pairs, similarityThreshold);
      if (!groups.length) return { pick: null, reason: 'no repeated bottle design' };

      // Cost boundary: read only the strongest repeated design, once. Searching
      // several weaker clusters turns one wine back into an open-ended image
      // batch and recreates the spend this module exists to remove.
      const group = groups[0];
      const candidates = representatives(group);
      const evidence = await read(wine, candidates);
      const byID = new Map(evidence.map((item) => [item.id, item]));
      const judged = candidates.map((candidate) => ({
        ...candidate,
        anchor: byID.get(candidate.id)?.anchor === true,
        explicitConflict: byID.get(candidate.id)?.explicitConflict === true,
      }));
      const pick = selectVisualPick(judged);
      if (pick) {
        return {
          pick,
          reason: '',
          matchingImages: group.length,
          inspectedImages: candidates.length,
          anchorLabels: evidence.filter((item) => item.anchor).map((item) => item.label).filter(Boolean),
          evidence,
        };
      }
      return { pick: null, reason: 'repeated designs lacked an exact readable anchor', evidence };
    },
  };
}
