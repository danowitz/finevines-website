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
        diagnostics,
        reviewCandidates: reviewCandidates(inspected),
      };

      const pairs = corroboratedVisualPairs(wine, inspected, await compare(inspected), similarityThreshold);
      diagnostics.comparedPairs = pairs.length;
      diagnostics.similarPairs = pairs.filter((pair) => pair.score >= similarityThreshold).length;
      const groups = groupsFromPairs(inspected, pairs, similarityThreshold);
      diagnostics.repeatedGroups = groups.length;
      diagnostics.strongestGroupImages = groups[0]?.length || 0;
      if (!groups.length) return {
        pick: null,
        reason: 'no repeated bottle design',
        diagnostics,
        reviewCandidates: reviewCandidates(inspected),
      };

      // Cost boundary: read only the strongest repeated design, once. Searching
      // several weaker clusters turns one wine back into an open-ended image
      // batch and recreates the spend this module exists to remove.
      const group = groups[0];
      const candidates = representatives(group);
      diagnostics.labelImagesRead = candidates.length;
      const evidence = await read(wine, candidates);
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
        return {
          pick,
          reason: '',
          matchingImages: group.length,
          inspectedImages: candidates.length,
          anchorLabels: evidence.filter((item) => item.anchor).map((item) => item.label).filter(Boolean),
          evidence,
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
        evidence,
        diagnostics,
        reviewCandidates: reviewCandidates(inspected, group, evidence),
      };
    },
  };
}
