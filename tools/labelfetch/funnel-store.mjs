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
    reason: record.tried?.[0]?.why || record.discoveryError || '',
    funnel: { ...(record.funnel || {}) },
    evidence: (record.evidence || []).map((item) => ({
      id: item.id,
      anchor: item.anchor === true,
      explicitConflict: item.explicitConflict === true,
      conflict: item.conflict,
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
      entry.failureStage === 'identity-anchor' &&
      Number(entry.funnel?.downloaded || 0) >= 2 &&
      Number(entry.funnel?.repeatedGroups || 0) >= 1)
    .map((entry) => entry.slug)
    .filter(Boolean));
}
