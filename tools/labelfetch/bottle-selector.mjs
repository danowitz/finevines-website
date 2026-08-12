import { evaluateVisualPick } from './visual-pick.mjs';
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
  const edge = new Map(pairs.map((pair) => [`${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`, pair.score]));
  const cliques = [];
  // Ten candidates means at most 1,024 subsets. Requiring every member to
  // match every other member prevents A~B~C chains from dragging a visibly
  // different sibling into one giant connected component.
  for (let mask = 1; mask < (1 << candidates.length); mask++) {
    const indexes = [];
    for (let index = 0; index < candidates.length; index++) if (mask & (1 << index)) indexes.push(index);
    if (indexes.length < 2) continue;
    let coherent = true;
    let total = 0;
    let count = 0;
    for (let left = 0; left < indexes.length && coherent; left++) {
      for (let right = left + 1; right < indexes.length; right++) {
        const score = edge.get(`${indexes[left]}:${indexes[right]}`) || 0;
        if (score < threshold) { coherent = false; break; }
        total += score;
        count++;
      }
    }
    if (coherent) cliques.push({ indexes, mean: total / count });
  }
  const maximal = cliques.filter((clique) => !cliques.some((other) =>
    other.indexes.length > clique.indexes.length &&
    clique.indexes.every((index) => other.indexes.includes(index))));
  return maximal.sort((a, b) =>
    b.indexes.length - a.indexes.length || b.mean - a.mean)
    .map((clique) => clique.indexes.map((index) => candidates[index]));
}

function corroboratesTitle(wine, candidate) {
  const wanted = [...new Set(tokens(wine.name || ''))];
  if (wanted.length < 2) return false;
  const title = normalize(candidate.title || '');
  const wantedVintage = String(wine.vintage || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
  const visibleVintages = String(candidate.title || '').match(/\b(?:19|20)\d{2}\b/g) || [];
  if (wantedVintage && visibleVintages.length && !visibleVintages.includes(wantedVintage)) return false;
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

function conflictText(conflict) {
  if (!conflict) return '';
  if (typeof conflict === 'string') return conflict;
  if (conflict.expected && conflict.visible) {
    return `visible vintage ${conflict.visible}; catalog vintage ${conflict.expected}`;
  }
  return JSON.stringify(conflict);
}

function reviewCandidates(inspected, strongestGroup = [], evidence = []) {
  const inStrongest = new Set(strongestGroup.map((candidate) => candidate.id));
  const byID = new Map(evidence.map((item) => [item.id, item]));
  return inspected.map((candidate) => {
    const identity = byID.get(candidate.id);
    const why = conflictText(identity?.conflict) ||
      (!candidate.shapeOk ? candidate.inspectError || 'bottle-shape rule failed' : '') ||
      (strongestGroup.length && !inStrongest.has(candidate.id) ? 'not in strongest repeated bottle group' : '') ||
      (strongestGroup.length && !identity?.anchor ? 'identity not proven automatically' : '');
    return {
      file: candidate.file,
      page: candidate.context || candidate.url,
      image: candidate.url,
      size: `${candidate.width || 0}x${candidate.height || 0}`,
      why,
      label: identity?.label || '',
      subjectOk: candidate.shapeOk === true,
      // This is a human review surface. A locally valid bottle should be shown,
      // not sent through another paid model merely to decide whether to hide it.
      displayOk: candidate.shapeOk === true,
      strongestGroup: inStrongest.has(candidate.id),
      anchor: identity?.anchor === true,
      explicitConflict: identity?.explicitConflict === true,
    };
  });
}

// The interface is intentionally one method. Adapters hide local image
// inspection, similarity computation, and the bounded label reader.
export function createBottleSelector({ inspect, compare, read, similarityThreshold = 0.90, inspectConcurrency = 3 }) {
  return {
    async select(wine, firstTenCandidates) {
      const inspectedAll = await mapLimit(firstTenCandidates.slice(0, 10), inspectConcurrency, async (candidate) => ({
        ...candidate,
        ...await inspect(candidate),
      }));
      const inspected = inspectedAll.filter((candidate) => candidate.visualOk !== false);
      const trace = {
        input: firstTenCandidates.slice(0, 10).map((candidate) => ({ ...candidate })),
        inspections: inspectedAll.map((candidate) => ({
          id: candidate.id,
          file: candidate.file,
          visualOk: candidate.visualOk !== false,
          shapeOk: candidate.shapeOk === true,
          cleanBackground: candidate.cleanBackground === true,
          inspectError: candidate.inspectError || '',
          width: candidate.width || 0,
          height: candidate.height || 0,
        })),
        pairs: [],
        groups: [],
        representatives: [],
        evidence: [],
        pick: '',
        reason: '',
      };
      const diagnostics = {
        selectorReceived: inspectedAll.length,
        decodedImages: inspected.length,
        decodeFailures: inspectedAll.length - inspected.length,
        bottleShapePassed: inspected.filter((candidate) => candidate.shapeOk).length,
        cleanBackgrounds: inspected.filter((candidate) => candidate.cleanBackground).length,
        comparedPairs: 0,
        similarPairs: 0,
        repeatedGroups: 0,
        strongestGroupImages: 0,
        labelImagesRead: 0,
        identityAnchors: 0,
        explicitConflicts: 0,
        publishableAnchors: 0,
      };
      if (inspected.length < 2) return {
        pick: null,
        reason: 'fewer than two decodable images',
        trace: { ...trace, reason: 'fewer than two decodable images' },
        diagnostics,
        reviewCandidates: reviewCandidates(inspected),
      };

      const pairs = corroboratedVisualPairs(wine, inspected, await compare(inspected), similarityThreshold);
      trace.pairs = pairs;
      diagnostics.comparedPairs = pairs.length;
      diagnostics.similarPairs = pairs.filter((pair) => pair.score >= similarityThreshold).length;
      const groups = groupsFromPairs(inspected, pairs, similarityThreshold);
      trace.groups = groups.map((group) => group.map((candidate) => candidate.id));
      diagnostics.repeatedGroups = groups.length;
      diagnostics.strongestGroupImages = groups[0]?.length || 0;
      if (!groups.length) return {
        pick: null,
        reason: 'no repeated bottle design',
        trace: { ...trace, reason: 'no repeated bottle design' },
        diagnostics,
        reviewCandidates: reviewCandidates(inspected),
      };

      // Cost boundary: read only the strongest repeated design, once. Searching
      // several weaker clusters turns one wine back into an open-ended image
      // batch and recreates the spend this module exists to remove.
      const group = groups[0];
      const candidates = representatives(group);
      trace.representatives = candidates.map((candidate) => candidate.id);
      diagnostics.labelImagesRead = candidates.length;
      const evidence = await read(wine, candidates);
      trace.evidence = evidence;
      const byID = new Map(evidence.map((item) => [item.id, item]));
      const judged = candidates.map((candidate) => ({
        ...candidate,
        anchor: byID.get(candidate.id)?.anchor === true,
        explicitConflict: byID.get(candidate.id)?.explicitConflict === true,
      }));
      const evaluated = evaluateVisualPick(judged);
      const pick = evaluated.pick;
      Object.assign(diagnostics, {
        identityAnchors: evaluated.diagnostics.identityAnchors,
        explicitConflicts: evaluated.diagnostics.explicitConflicts,
        anchorShapeFailures: evaluated.diagnostics.anchorShapeFailures,
        anchorResolutionFailures: evaluated.diagnostics.anchorResolutionFailures,
        publishableAnchors: evaluated.diagnostics.publishableAnchors,
      });
      if (pick) {
        trace.pick = pick.id;
        return {
          pick,
          reason: '',
          matchingImages: group.length,
          inspectedImages: candidates.length,
          anchorLabels: evidence.filter((item) => item.anchor).map((item) => item.label).filter(Boolean),
          evidence,
          trace,
          diagnostics,
          reviewCandidates: reviewCandidates(inspected, group, evidence),
        };
      }
      const reason = diagnostics.identityAnchors === 0
        ? 'repeated designs lacked an exact readable anchor'
        : 'exact anchors failed bottle-shape or resolution publication rules';
      return {
        pick: null,
        reason,
        trace: { ...trace, reason },
        evidence,
        diagnostics,
        reviewCandidates: reviewCandidates(inspected, group, evidence),
      };
    },
  };
}
