import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBottleSelector } from './bottle-selector.mjs';
import { planIdentityReading, sourceIdentityEvidence } from './identity-reading-plan.mjs';

async function traceFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === 'trace.json') files.push(path);
    }
  }
  await walk(directory);
  return files.sort();
}

function parsedRows(response) {
  try {
    const value = JSON.parse(String(response || '').replace(/^```(?:json)?|```$/gm, '').trim());
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.readings) ? value.readings : [];
  } catch {
    return [];
  }
}

function readerBatches(reader) {
  if (!reader) return [];
  return Array.isArray(reader.batches) ? reader.batches : [reader];
}

function cachedCandidates(trace) {
  const inspections = new Map((trace.selector?.inspections || []).map((item) => [item.id, item]));
  return (trace.selector?.input || []).map((candidate) => ({
    ...candidate,
    ...(inspections.get(candidate.id) || {}),
  }));
}

function cachedGroups(trace, candidates) {
  const byID = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return (trace.selector?.groups || [])
    .map((ids) => ids.map((id) => byID.get(id)).filter(Boolean))
    .filter((group) => group.length >= 2);
}

export async function replayIdentityTraces(directory) {
  const rows = [];
  for (const file of await traceFiles(directory)) {
    const trace = JSON.parse(await readFile(file, 'utf8'));
    const wine = trace.catalogInput || {};
    const candidates = cachedCandidates(trace);
    const groups = cachedGroups(trace, candidates);
    const oldEvidence = new Map((trace.selector?.evidence || []).map((item) => [item.id, item]));
    const malformedBatches = readerBatches(trace.selector?.reader).filter((batch) => {
      const expected = batch.candidateIds || [];
      const parsed = parsedRows(batch.response);
      const ids = parsed.map((item) => item?.candidate_id).filter(Boolean);
      return parsed.length !== expected.length || (ids.length > 0 &&
        (ids.length !== expected.length || expected.some((id) => !ids.includes(id))));
    }).length;

    const plan = planIdentityReading(wine, groups, 10, candidates);
    const oldReadIDs = new Set(oldEvidence.keys());
    const strongUnread = candidates.filter((candidate) => {
      const source = sourceIdentityEvidence(wine, candidate);
      return candidate.shapeOk && source.relevance >= 0.45 &&
        source.requestedVintageInSource && !oldReadIDs.has(candidate.id);
    });
    const inspectByID = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selector = createBottleSelector({
      inspect: async (candidate) => inspectByID.get(candidate.id) || {},
      compare: async () => trace.selector?.pairs || [],
      read: async (_target, batch) => batch.map((candidate) => {
        const cached = oldEvidence.get(candidate.id);
        return cached
          ? { ...cached, readStatus: 'ok' }
          : {
              id: candidate.id,
              anchor: false,
              productAnchor: false,
              explicitConflict: false,
              readStatus: 'invalid',
              reasonCode: 'SAVED_TRACE_HAS_NO_READING',
            };
      }),
    });
    const replay = await selector.select(wine, candidates);
    const pickedOldConflict = Boolean(
      replay.pick && oldEvidence.get(replay.pick.id)?.explicitConflict === true,
    );
    rows.push({
      slug: wine.slug || file.split(/[\\/]/).at(-2),
      oldAccepted: trace.final?.ok === true,
      replayAccepted: Boolean(replay.pick),
      replayPick: replay.pick?.id || '',
      oldReads: oldReadIDs.size,
      plannedReads: plan.map(({ id }) => id),
      newlyPlanned: plan.filter(({ id }) => !oldReadIDs.has(id)).map(({ id }) => id),
      strongUnread: strongUnread.map(({ id }) => id),
      malformedBatches,
      invalidReplayReads: replay.diagnostics?.invalidReaderResults || 0,
      pickedOldConflict,
      repeatedPick: !replay.pick || Number(replay.matchingImages || 0) >= 2,
      reason: replay.reason || '',
    });
  }
  const failures = rows.filter((row) =>
    (row.oldAccepted && !row.replayAccepted) || row.pickedOldConflict || !row.repeatedPick);
  return {
    generatedAt: new Date().toISOString(),
    traceDirectory: resolve(directory),
    wines: rows.length,
    oldAccepted: rows.filter(({ oldAccepted }) => oldAccepted).length,
    replayAccepted: rows.filter(({ replayAccepted }) => replayAccepted).length,
    malformedBatchesDetected: rows.reduce((total, row) => total + row.malformedBatches, 0),
    winesWithNewlyPlannedCandidates: rows.filter(({ newlyPlanned }) => newlyPlanned.length).length,
    strongUnreadCandidates: rows.reduce((total, row) => total + row.strongUnread.length, 0),
    failures,
    rows,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = process.argv[2];
  if (!directory) {
    console.error('usage: node tools/labelfetch/replay-identity-traces.mjs TRACE_DIRECTORY [OUTPUT_JSON]');
    process.exit(2);
  }
  const report = await replayIdentityTraces(directory);
  const output = process.argv[3] || 'out-bottle/identity-proof-smoke.json';
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`identity proof smoke: ${report.replayAccepted}/${report.wines} replay accepted; ` +
    `${report.malformedBatchesDetected} malformed old batch(es) detected; ` +
    `${report.winesWithNewlyPlannedCandidates} wine(s) gain reading coverage`);
  console.log(`report -> ${resolve(output)}`);
  if (report.failures.length) process.exit(1);
}
