import { planIdentityReading } from './identity-reading-plan.mjs';

function evidenceRows(result) {
  return Array.isArray(result) ? result : [];
}

function batchEvidence(candidates, result) {
  const rows = evidenceRows(result);
  const byID = new Map(rows
    .filter((row) => row && typeof row.id === 'string')
    .map((row) => [row.id, row]));
  const positional = rows.length === candidates.length &&
    rows.every((row) => row && (row.id === undefined || typeof row.id === 'string'));
  return candidates.map((candidate, index) => {
    const row = byID.get(candidate.id) || (positional && !rows[index]?.id
      ? { ...rows[index], id: candidate.id }
      : null);
    if (!row || row.readStatus === 'invalid' || row.reasonCode === 'READER_RESPONSE_INVALID') return null;
    return row;
  });
}

function combinedReaderTrace(traces) {
  if (!traces.length) return null;
  if (traces.length === 1) return traces[0];
  return {
    model: traces.find(({ model }) => model)?.model || '',
    reasoningEffort: traces.find(({ reasoningEffort }) => reasoningEffort)?.reasoningEffort || '',
    candidateIds: traces.flatMap(({ candidateIds }) => candidateIds || []),
    batches: traces,
  };
}

// Identity proof is deliberately one deep module. The selector supplies one
// target plus its inspected candidates and repeated-design groups; this module
// owns the bounded reading schedule, malformed-response recovery, and complete
// candidate-level evidence ledger.
export function createIdentityProofEngine({
  read,
  primaryBatchSize = 3,
  maxCandidates = 10,
} = {}) {
  if (typeof read !== 'function') throw new TypeError('identity proof requires a read adapter');

  return {
    async prove(wine, { candidates = [], groups = [] } = {}) {
      const plan = planIdentityReading(wine, groups, maxCandidates, candidates);
      const repeatedIDs = new Set(groups.flat().map(({ id }) => id));
      const evidenceByID = new Map();
      const traces = [];
      const diagnostics = {
        plannedCandidates: plan.length,
        candidatesRead: 0,
        readerCalls: 0,
        readerRetries: 0,
        invalidReaderResults: 0,
      };

      async function invoke(batch, retry = false) {
        diagnostics.readerCalls++;
        if (retry) diagnostics.readerRetries++;
        const result = await read(wine, batch);
        if (result?.readerTrace) traces.push(result.readerTrace);
        return batchEvidence(batch, result);
      }

      async function readAndRecover(batch) {
        const rows = await invoke(batch);
        for (let index = 0; index < batch.length; index++) {
          const candidate = batch[index];
          let row = rows[index];
          if (!row) {
            const [retried] = await invoke([candidate], true);
            row = retried;
          }
          if (!row) {
            diagnostics.invalidReaderResults++;
            row = {
              id: candidate.id,
              anchor: false,
              productAnchor: false,
              explicitConflict: false,
              readStatus: 'invalid',
              reasonCode: 'READER_RESPONSE_INVALID',
              conflict: 'identity reader returned no valid result for this candidate',
            };
          }
          evidenceByID.set(candidate.id, row);
        }
        diagnostics.candidatesRead += batch.length;
      }

      if (plan.length) await readAndRecover(plan.slice(0, primaryBatchSize));
      let next = Math.min(primaryBatchSize, plan.length);
      const hasPublishableAnchor = () => [...evidenceByID.values()].some((item) =>
        item.anchor === true && repeatedIDs.has(item.id));
      while (!hasPublishableAnchor() && next < plan.length) {
        await readAndRecover([plan[next]]);
        next++;
      }

      const evidence = plan
        .map(({ id }) => evidenceByID.get(id))
        .filter(Boolean);
      return {
        evidence,
        representatives: evidence.map(({ id }) => id),
        readerTrace: combinedReaderTrace(traces),
        diagnostics,
        stopReason: hasPublishableAnchor() ? 'publishable-anchor' : 'evidence-exhausted',
      };
    },
  };
}
