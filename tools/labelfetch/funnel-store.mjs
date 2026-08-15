import { access, readFile, writeFile } from 'node:fs/promises';

export const FUNNEL_PATH = 'data/image-funnel.json';

export async function loadFunnelStore(path = FUNNEL_PATH) {
  try {
    await access(path);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export function funnelEntry(record, now = new Date()) {
  return {
    slug: record.slug,
    sku: record.sku || '',
    name: record.name || '',
    ok: record.ok === true,
    failureStage: record.failureStage || '',
    failureCode: record.failureCode || '',
    reason: record.tried?.[0]?.why || record.discoveryError || '',
    funnel: { ...(record.funnel || {}) },
    evidence: (record.evidence || []).map((item) => ({
      id: item.id,
      anchor: item.anchor === true,
      productAnchor: item.productAnchor === true,
      explicitConflict: item.explicitConflict === true,
      readStatus: item.readStatus || '',
      vintageStatus: item.vintageStatus || '',
      reasonCode: item.reasonCode || '',
      conflict: item.conflict,
      sourceVintageMismatch: item.sourceVintageMismatch,
      label: item.label || '',
      visibleVintage: item.visibleVintage || '',
      localVisibleVintage: item.localVisibleVintage || '',
    })),
    candidates: (record.alternates || []).map((item) => ({
      image: item.image || '',
      page: item.page || '',
      size: item.size || '',
      why: item.why || '',
      label: item.label || '',
      strongestGroup: item.strongestGroup === true,
      anchor: item.anchor === true,
      explicitConflict: item.explicitConflict === true,
    })),
    updatedAt: now.toISOString(),
  };
}

export function recordFunnel(store, record, now) {
  if (record?.slug && record?.funnel) store[record.slug] = funnelEntry(record, now);
  return store;
}

export async function saveFunnelStore(store, path = FUNNEL_PATH) {
  await writeFile(path, JSON.stringify(store, null, 1) + '\n');
}

// A stronger reader can help only when discovery and local visual grouping
// already succeeded and the cheap reader was the sole stopping point. Keep
// this policy beside the durable funnel schema so every caller uses the same
// definition and hard failures (watermark, conflict, quality, download) never
// leak into a paid recovery pass.
export function recoverableCandidateSlugs(store) {
  return new Set(Object.values(store || {})
    .filter((entry) => entry?.ok === false &&
      ['identity-anchor', 'reader-response', 'publication-vintage'].includes(entry.failureStage) &&
      entry.funnel?.recoveryScope !== 'quality' &&
      Number(entry.funnel?.downloaded || 0) >= 2 &&
      Number(entry.funnel?.repeatedGroups || 0) >= 1)
    .map((entry) => entry.slug)
    .filter(Boolean));
}

export function recoverableQualitySlugs(store) {
  return new Set(Object.values(store || {})
    .filter((entry) => entry?.ok === false &&
      ((entry.failureStage === 'publication-quality' &&
        Number(entry.funnel?.identityAnchors || 0) >= 1) ||
       entry.funnel?.recoveryScope === 'quality'))
    .map((entry) => entry.slug)
    .filter(Boolean));
}
