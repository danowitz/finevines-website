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
