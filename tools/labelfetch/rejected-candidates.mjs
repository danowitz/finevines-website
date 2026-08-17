import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const clean = (value) => String(value || '').trim();

export async function loadRejectedCandidates(file, read = readFile) {
  if (!file) return { count: 0, acceptIdentity: () => true, acceptBytes: () => true };
  const parsed = JSON.parse(await read(file, 'utf8'));
  if (!Array.isArray(parsed?.rejectedCandidates)) throw new Error('rejected candidate file has no candidate set');
  const hashes = new Set();
  const sourceIdentities = new Set();
  for (const candidate of parsed.rejectedCandidates) {
    const sha256 = clean(candidate?.sha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('rejected candidate has an invalid sha256');
    hashes.add(sha256);
    for (const value of [candidate?.sourceImageUrl, candidate?.sourceUrl]) {
      if (clean(value)) sourceIdentities.add(clean(value));
    }
  }
  return {
    count: parsed.rejectedCandidates.length,
    acceptIdentity: (candidate) => ![candidate?.url, candidate?.page, candidate?.sourceUrl, candidate?.context]
      .some((value) => clean(value) && sourceIdentities.has(clean(value))),
    acceptBytes: (bytes) => !hashes.has(createHash('sha256').update(bytes).digest('hex')),
  };
}
