import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadFunnelStore } from './funnel-store.mjs';

const COUNTERS = [
  'searchResults',
  'sourcePolicyBlocked',
  'permittedCandidates',
  'downloadAttempted',
  'downloaded',
  'decodedImages',
  'bottleShapePassed',
  'cleanBackgrounds',
  'similarPairs',
  'repeatedGroups',
  'strongestGroupImages',
  'labelImagesRead',
  'identityAnchors',
  'explicitConflicts',
  'publishableAnchors',
  'watermarkClean',
  'watermarkRejected',
  'watermarkUnresolved',
  'imported',
];

export function summarizeFunnels(records) {
  const summary = {
    records: records.length,
    instrumented: 0,
    imported: 0,
    ready: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    stages: {},
    totals: Object.fromEntries(COUNTERS.map((counter) => [counter, 0])),
  };
  for (const record of records) {
    if (!record?.funnel) continue;
    summary.instrumented++;
    const outcome = record.funnel.outcome;
    const importStage = record.funnel.importStage;
    if (record.funnel.imported || outcome === 'imported') summary.imported++;
    else if (importStage === 'existing-photo' || importStage === 'catalog-missing') summary.skipped++;
    else if (outcome === 'pending') summary.pending++;
    else if (outcome === 'selected' || outcome === 'watermark-clean' || outcome === 'human-selected') summary.ready++;
    else {
      summary.failed++;
    }
    if (!record.funnel.imported && outcome !== 'imported' &&
        importStage !== 'existing-photo' && importStage !== 'catalog-missing') {
      const stage = record.failureStage || (outcome === 'pending' ? 'pending' : 'unknown');
      summary.stages[stage] = (summary.stages[stage] || 0) + 1;
    }
    for (const counter of COUNTERS) {
      summary.totals[counter] += Number(record.funnel[counter]) || 0;
    }
  }
  return summary;
}

export function formatFunnelReport(summary) {
  const lines = [
    `instrumented wines: ${summary.instrumented}/${summary.records}`,
    `imported: ${summary.imported}; ready: ${summary.ready}; pending: ${summary.pending}; failed: ${summary.failed}; skipped: ${summary.skipped}`,
    '',
    'candidate funnel:',
    ...COUNTERS.map((counter) => `  ${counter.padEnd(28)} ${summary.totals[counter]}`),
    '',
    'wine failure stages:',
  ];
  const stages = Object.entries(summary.stages).sort((left, right) => right[1] - left[1]);
  if (!stages.length) lines.push('  none');
  else for (const [stage, count] of stages) lines.push(`  ${stage.padEnd(28)} ${count}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const durable = await loadFunnelStore();
  const records = Object.keys(durable).length
    ? Object.values(durable)
    : Object.values(JSON.parse(await readFile('data/fetched-images/manifest.json', 'utf8')));
  const summary = summarizeFunnels(records);
  console.log(process.argv.includes('--json')
    ? JSON.stringify(summary, null, 2)
    : formatFunnelReport(summary));
}
