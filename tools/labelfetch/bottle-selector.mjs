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
  const adjacent = candidates.map(() => new Set());
  for (const pair of pairs) {
    if (pair.score < threshold) continue;
    adjacent[pair.a].add(pair.b);
    adjacent[pair.b].add(pair.a);
  }
  const maximal = [];
  // Enumerate maximal mutually matching groups directly. This preserves the
  // no-transitive-chain safety rule without scanning every possible subset.
  function visit(group, possible, excluded) {
    if (!possible.size && !excluded.size) {
      if (group.length < 2) return;
      let total = 0;
      let count = 0;
      for (let left = 0; left < group.length; left++) {
        for (let right = left + 1; right < group.length; right++) {
          const key = `${Math.min(group[left], group[right])}:${Math.max(group[left], group[right])}`;
          total += edge.get(key) || 0;
          count++;
        }
      }
      maximal.push({ indexes: group, mean: total / count });
      return;
    }
    for (const candidate of [...possible]) {
      const neighbors = adjacent[candidate];
      visit(
        [...group, candidate],
        new Set([...possible].filter((index) => neighbors.has(index))),
        new Set([...excluded].filter((index) => neighbors.has(index))),
      );
      possible.delete(candidate);
      excluded.add(candidate);
    }
  }
  visit([], new Set(candidates.map((_, index) => index)), new Set());
  const groups = maximal.sort((a, b) =>
    b.indexes.length - a.indexes.length || b.mean - a.mean)
    .map((clique) => clique.indexes.map((index) => candidates[index]));

  // Scene photos often match the clean product shot but not one another because
  // their crops, glasses, and backgrounds differ. Add a star group only around
  // a clean, publishable center with at least two independently matching
  // neighbors. This avoids the unsafe A~B~C transitive-chain behavior.
  for (let center = 0; center < candidates.length; center++) {
    if (!candidates[center].shapeOk || !candidates[center].cleanBackground) continue;
    const neighbors = [];
    for (let other = 0; other < candidates.length; other++) {
      if (other === center) continue;
      const score = edge.get(`${Math.min(center, other)}:${Math.max(center, other)}`) || 0;
      if (score >= threshold) neighbors.push(other);
    }
    if (neighbors.length < 2) continue;
    const star = [center, ...neighbors].map((index) => candidates[index]);
    const ids = new Set(star.map((candidate) => candidate.id));
    if (!groups.some((group) => group.length === ids.size && group.every((candidate) => ids.has(candidate.id)))) {
      groups.push(star);
    }
  }
  return groups.sort((left, right) => right.length - left.length);
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

function exactVintageSourceAnchor(wine, candidate) {
  const wanted = [...new Set(tokens(wine.name || ''))];
  if (wanted.length < 2) return false;
  const titleTokens = new Set(tokens(candidate.title || ''));
  if (!wanted.every((token) => titleTokens.has(token))) return false;
  const wantedVintage = String(wine.vintage || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
  if (!wantedVintage) return false;
  const titleVintages = String(candidate.title || '').match(/\b(?:19|20)\d{2}\b/g) || [];
  return titleVintages.length > 0 && titleVintages.every((vintage) => vintage === wantedVintage);
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
    const sameArtwork = pair.local_inliers >= 5 && pair.local_ratio >= 0.75;
    return titleSupport || sameArtwork ? { ...pair, score: Math.max(pair.score, threshold) } : pair;
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

function rankGroups(wine, groups) {
  return groups
    .map((group, index) => ({
      group,
      index,
      exactSources: group.filter((candidate) => exactVintageSourceAnchor(wine, candidate)).length,
      corroboratingSources: group.filter((candidate) => corroboratesTitle(wine, candidate)).length,
    }))
    .sort((left, right) =>
      right.exactSources - left.exactSources ||
      right.corroboratingSources - left.corroboratingSources ||
      left.index - right.index)
    .map(({ group }) => group);
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
    async select(wine, candidates) {
      const inspectedAll = await mapLimit(candidates, inspectConcurrency, async (candidate) => ({
        ...candidate,
        ...await inspect(candidate),
      }));
      const inspected = inspectedAll.filter((candidate) => candidate.visualOk !== false);
      const trace = {
        input: candidates.map((candidate) => ({ ...candidate })),
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
        sourceIdentityAnchors: 0,
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
      const groups = rankGroups(wine, groupsFromPairs(inspected, pairs, similarityThreshold));
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

      // One bounded label request still covers the wine, but it samples across
      // credible groups instead of blindly spending all three slots on the
      // largest sibling-wine cluster. Exact-vintage result titles go first.
      const representativesToRead = [];
      for (const group of groups) {
        const ranked = [...representatives(group)].sort((left, right) =>
          Number(exactVintageSourceAnchor(wine, right)) - Number(exactVintageSourceAnchor(wine, left)));
        for (const candidate of ranked) {
          if (!representativesToRead.some(({ id }) => id === candidate.id)) representativesToRead.push(candidate);
          if (representativesToRead.length === 3) break;
        }
        if (representativesToRead.length === 3) break;
      }
      trace.representatives = representativesToRead.map((candidate) => candidate.id);
      diagnostics.labelImagesRead = representativesToRead.length;
      const evidence = await read(wine, representativesToRead);
      const byID = new Map(evidence.map((item) => [item.id, item]));
      let selectedGroup = groups[0];
      let bestEvaluated = null;
      let selectedSourceAnchorIds = [];
      const expansionSeeds = [];
      const traceEvidence = [];
      for (const group of groups) {
        const judged = group.map((candidate) => {
          const explicitConflict = byID.get(candidate.id)?.explicitConflict === true;
          const sourceAnchor = exactVintageSourceAnchor(wine, candidate);
          const identityAnchor = byID.get(candidate.id)?.anchor === true;
          const inheritedFullMatch = candidate.trustedFullMatch === true;
          return {
            ...candidate,
            explicitConflict,
            sourceAnchor,
            // A conflict vetoes every route to anchor status, including an
            // otherwise trusted full-match relationship from Web Detection.
            anchor: !explicitConflict && (identityAnchor || sourceAnchor || inheritedFullMatch),
          };
        });
        for (const candidate of judged) {
          if (candidate.anchor && !candidate.explicitConflict &&
              !expansionSeeds.some(({ id }) => id === candidate.id)) expansionSeeds.push(candidate);
        }
        const evaluated = evaluateVisualPick(judged);
        if (!bestEvaluated ||
            evaluated.diagnostics.identityAnchors > bestEvaluated.diagnostics.identityAnchors ||
            evaluated.diagnostics.publishableAnchors > bestEvaluated.diagnostics.publishableAnchors) {
          bestEvaluated = evaluated;
          selectedGroup = group;
        }
        for (const candidate of judged) {
          if (!traceEvidence.some(({ id }) => id === candidate.id)) traceEvidence.push({
            ...(byID.get(candidate.id) || { id: candidate.id, anchor: false, explicitConflict: false }),
            sourceAnchor: candidate.sourceAnchor,
            effectiveAnchor: candidate.anchor,
          });
        }
        if (evaluated.pick) {
          selectedGroup = group;
          bestEvaluated = evaluated;
          selectedSourceAnchorIds = judged
            .filter((candidate) => candidate.sourceAnchor && !candidate.explicitConflict)
            .map((candidate) => candidate.id);
          break;
        }
      }
      trace.evidence = traceEvidence;
      const pick = bestEvaluated?.pick || null;
      Object.assign(diagnostics, {
        identityAnchors: bestEvaluated?.diagnostics.identityAnchors || 0,
        explicitConflicts: evidence.filter((item) => item.explicitConflict).length,
        anchorShapeFailures: bestEvaluated?.diagnostics.anchorShapeFailures || 0,
        anchorResolutionFailures: bestEvaluated?.diagnostics.anchorResolutionFailures || 0,
        publishableAnchors: bestEvaluated?.diagnostics.publishableAnchors || 0,
        sourceIdentityAnchors: selectedSourceAnchorIds.length,
      });
      if (pick) {
        trace.pick = pick.id;
        return {
          pick,
          reason: '',
          matchingImages: selectedGroup.length,
          inspectedImages: inspected.length,
          anchorLabels: evidence.filter((item) => item.anchor).map((item) => item.label).filter(Boolean),
          sourceAnchorIds: selectedSourceAnchorIds,
          evidence,
          trace,
          diagnostics,
          reviewCandidates: reviewCandidates(inspected, selectedGroup, evidence),
          expansionSeeds,
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
        sourceAnchorIds: selectedSourceAnchorIds,
        diagnostics,
        reviewCandidates: reviewCandidates(inspected, selectedGroup, evidence),
        expansionSeeds,
      };
    },
  };
}
