import { evaluateVisualPick } from './visual-pick.mjs';
import {
  bestVisualRepresentative,
  sourceIdentityEvidence,
} from './identity-reading-plan.mjs';
import { createIdentityProofEngine } from './identity-proof.mjs';

function host(candidate) {
  if (candidate.host) return String(candidate.host).replace(/^www\./, '');
  try { return new URL(candidate.url).host.replace(/^www\./, ''); } catch { return ''; }
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
  return sourceIdentityEvidence(wine, candidate).corroboratesTitle;
}

function exactVintageSourceSignal(wine, candidate) {
  return sourceIdentityEvidence(wine, candidate).exactVintageSignal;
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

function rankGroups(wine, groups) {
  return groups
    .map((group, index) => ({
      group,
      index,
      exactSources: group.filter((candidate) => exactVintageSourceSignal(wine, candidate)).length,
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
export function createBottleSelector({
  inspect,
  compare,
  read,
  similarityThreshold = 0.90,
  inspectConcurrency = 3,
  maxIdentityCandidates = 10,
}) {
  const identityProof = createIdentityProofEngine({ read, maxCandidates: maxIdentityCandidates });
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
        productIdentityAnchors: 0,
        wrongVisibleVintages: 0,
        explicitConflicts: 0,
        publishableAnchors: 0,
        sourceIdentityAnchors: 0,
        provisionalExpansionSeeds: 0,
        plannedIdentityCandidates: 0,
        readerCalls: 0,
        readerRetries: 0,
        invalidReaderResults: 0,
      };
      if (inspected.length < 2) return {
        pick: null,
        reason: 'fewer than two decodable images',
        trace: { ...trace, reason: 'fewer than two decodable images' },
        diagnostics,
        reviewCandidates: reviewCandidates(inspected),
      };

      const comparedPairs = await compare(inspected);
      const pairs = corroboratedVisualPairs(wine, inspected, comparedPairs, similarityThreshold);
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

      const proof = await identityProof.prove(wine, { candidates: inspected, groups });
      const evidence = [...proof.evidence];
      // Search metadata never proves pixels, but an explicit wrong grape is a
      // safe veto even when that candidate was not one of the bounded images
      // sent to the reader. Without this, a read Grenache could donate identity
      // to an unread Syrah merely because the producer's label layout matched.
      const evidenceIndex = new Map(evidence.map((item, index) => [item.id, index]));
      for (const candidate of inspected) {
        const sourceConflict = sourceIdentityEvidence(wine, candidate).sourceVarietalConflict;
        if (!sourceConflict) continue;
        const index = evidenceIndex.get(candidate.id);
        const previous = index === undefined ? { id: candidate.id } : evidence[index];
        const veto = {
          ...previous,
          anchor: false,
          productAnchor: false,
          explicitConflict: true,
          reasonCode: 'VARIETAL_CONFLICT',
          conflict: sourceConflict,
        };
        if (index === undefined) {
          evidenceIndex.set(candidate.id, evidence.length);
          evidence.push(veto);
        } else {
          evidence[index] = veto;
        }
      }
      trace.representatives = proof.representatives;
      trace.reader = proof.readerTrace;
      trace.identityProof = {
        stopReason: proof.stopReason,
        diagnostics: proof.diagnostics,
      };
      diagnostics.labelImagesRead = proof.diagnostics.candidatesRead;
      diagnostics.plannedIdentityCandidates = proof.diagnostics.plannedCandidates;
      diagnostics.readerCalls = proof.diagnostics.readerCalls;
      diagnostics.readerRetries = proof.diagnostics.readerRetries;
      diagnostics.invalidReaderResults = proof.diagnostics.invalidReaderResults;
      const byID = new Map(evidence.map((item) => [item.id, item]));
      let selectedGroup = groups[0];
      let bestEvaluated = null;
      let selectedSourceAnchorIds = [];
      const expansionSeeds = [];
      const provisionalSeeds = [];
      const traceEvidence = [];
      const candidateIndex = new Map(inspected.map((candidate, index) => [candidate.id, index]));
      // Title corroboration may admit a moderate pair into a review group, but
      // it must never transfer pixel identity. Identity can move only across a
      // pair that was independently strong before metadata boosted grouping,
      // or whose local artwork features establish a direct copy relationship.
      const directIdentityPairs = new Set(comparedPairs
        .filter((pair) => pair.score >= similarityThreshold ||
          (pair.local_inliers >= 5 && pair.local_ratio >= 0.75))
        .map((pair) => {
          const left = inspected[pair.a]?.id;
          const right = inspected[pair.b]?.id;
          return `${left}:${right}`;
        }));
      const directPairScore = new Map(pairs.map((pair) => {
        const left = inspected[pair.a]?.id;
        const right = inspected[pair.b]?.id;
        return [`${left}:${right}`, pair.score];
      }));
      const directMatch = (left, right) => {
        if (left === right) return true;
        const leftIndex = candidateIndex.get(left);
        const rightIndex = candidateIndex.get(right);
        if (leftIndex === undefined || rightIndex === undefined) return false;
        const a = inspected[Math.min(leftIndex, rightIndex)].id;
        const b = inspected[Math.max(leftIndex, rightIndex)].id;
        return directIdentityPairs.has(`${a}:${b}`) &&
          (directPairScore.get(`${a}:${b}`) || 0) >= similarityThreshold;
      };
      for (const group of groups) {
        const base = group.map((candidate) => {
          const explicitConflict = byID.get(candidate.id)?.explicitConflict === true;
          const sourceEvidence = sourceIdentityEvidence(wine, candidate);
          const sourceAnchor = sourceEvidence.exactVintageSignal;
          const identityAnchor = byID.get(candidate.id)?.anchor === true;
          const inheritedFullMatch = candidate.trustedFullMatch === true;
          return {
            ...candidate,
            explicitConflict,
            sourceAnchor,
            // Source metadata chooses what to read but never proves the pixels.
            // Publication requires blind pixel evidence or a verified full-copy
            // relationship to pixels that already earned that evidence.
            identityAnchor,
            inheritedFullMatch,
            // A directly read vintage-neutral bottle may survive stale source
            // metadata. An unread candidate may not inherit identity through a
            // source that explicitly names another vintage or grape.
            inheritanceBlocked: Boolean(
              sourceEvidence.conflictingTitleVintage || sourceEvidence.sourceVarietalConflict),
            sourceVintageMismatch: sourceEvidence.sourceVintageMismatch,
          };
        });
        const readableAnchors = base.filter((candidate) =>
          !candidate.explicitConflict && (candidate.identityAnchor || candidate.inheritedFullMatch));
        const judged = base.map((candidate) => {
          const inheritedFrom = !candidate.identityAnchor && !candidate.inheritedFullMatch &&
            !candidate.explicitConflict && !candidate.inheritanceBlocked
            ? readableAnchors.find((anchor) => directMatch(candidate.id, anchor.id))
            : null;
          return {
            ...candidate,
            anchor: !candidate.explicitConflict && Boolean(
              candidate.identityAnchor || candidate.inheritedFullMatch || inheritedFrom),
            inheritedIdentity: Boolean(inheritedFrom),
            inheritedFrom: inheritedFrom?.id || '',
          };
        });
        for (const candidate of judged) {
          if (candidate.anchor && !candidate.explicitConflict &&
              !expansionSeeds.some(({ id }) => id === candidate.id)) {
            expansionSeeds.push({ ...candidate, verifiedIdentity: true });
          }
        }
        // A conflict-free repeated design is useful as a reverse-search
        // hypothesis even when its tiny labels cannot prove identity. Keep it
        // explicitly provisional: neither it nor its Web Detection copies may
        // inherit anchor status from visual similarity alone.
        if (!judged.some((candidate) => candidate.explicitConflict)) {
          const seed = bestVisualRepresentative(judged);
          if (seed && !provisionalSeeds.some(({ id }) => id === seed.id)) {
            provisionalSeeds.push({ ...seed, verifiedIdentity: false });
          }
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
            sourceVintageMismatch: byID.get(candidate.id)?.sourceVintageMismatch ||
              candidate.sourceVintageMismatch || undefined,
            inheritanceBlocked: candidate.inheritanceBlocked,
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
      if (!expansionSeeds.length && provisionalSeeds.length) {
        expansionSeeds.push(provisionalSeeds[0]);
      }
      Object.assign(diagnostics, {
        identityAnchors: bestEvaluated?.diagnostics.identityAnchors || 0,
        productIdentityAnchors: evidence.filter((item) => item.productAnchor === true).length,
        wrongVisibleVintages: evidence.filter((item) => item.vintageStatus === 'wrong-visible').length,
        explicitConflicts: evidence.filter((item) => item.explicitConflict).length,
        anchorShapeFailures: bestEvaluated?.diagnostics.anchorShapeFailures || 0,
        anchorResolutionFailures: bestEvaluated?.diagnostics.anchorResolutionFailures || 0,
        publishableAnchors: bestEvaluated?.diagnostics.publishableAnchors || 0,
        sourceIdentityAnchors: selectedSourceAnchorIds.length,
        provisionalExpansionSeeds: expansionSeeds.filter((seed) => !seed.verifiedIdentity).length,
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
      const unresolvedCodes = [...new Set(evidence.map(({ reasonCode }) => reasonCode).filter(Boolean))];
      const failureCode = diagnostics.invalidReaderResults > 0 && diagnostics.productIdentityAnchors === 0
        ? 'READER_RESPONSE_INVALID'
        : diagnostics.productIdentityAnchors > 0 && diagnostics.wrongVisibleVintages > 0
          ? 'NO_EXACT_OR_VINTAGE_NEUTRAL_COPY'
          : diagnostics.identityAnchors === 0
            ? unresolvedCodes[0] || 'PRODUCT_TEXT_UNREADABLE'
            : 'PUBLICATION_QUALITY_FAILED';
      const reason = failureCode === 'READER_RESPONSE_INVALID'
        ? `identity reader returned invalid results for ${diagnostics.invalidReaderResults} candidate(s)`
        : failureCode === 'NO_EXACT_OR_VINTAGE_NEUTRAL_COPY'
          ? 'product identity was proven, but no correct-year or vintage-neutral copy was publishable'
          : diagnostics.identityAnchors === 0
            ? `identity unresolved: ${unresolvedCodes.join(', ') || 'no readable product anchor'}`
            : 'exact anchors failed bottle-shape or resolution publication rules';
      return {
        pick: null,
        reason,
        failureCode,
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
