import { createHash } from 'node:crypto';

const SUBJECT_REFUSAL = /no clean background|multiple subjects|too wide|too narrow|no subject|fills the frame/i;
const REVIEWABLE_SOURCES = new Set(['generated-label', 'generated-photo', 'label-scan', '']);

const hash = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => String(value || '').trim();

export function wineRevision(wine) {
  return hash(JSON.stringify([
    1, clean(wine.sku), clean(wine.id), clean(wine.slug), clean(wine.producer), clean(wine.name),
    clean(wine.vintage), clean(wine.varietal), clean(wine.region), clean(wine.appellation),
    clean(wine.country), clean(wine.color), clean(wine.style), clean(wine.bottleSize),
    clean(wine.imagePath), clean(wine.imageSource), clean(wine.imageSourceUrl), clean(wine.sourceHash), clean(wine.status),
    clean(wine.imageReviewStatus), clean(wine.imageReviewedAt), clean(wine.imageReviewActionId),
  ]));
}

export function wineNeedsReview(wine) {
  if (wine?.imageReviewStatus === 'no-match') return false;
  return !wine?.imagePath || wine.imagePath.endsWith('.svg') || REVIEWABLE_SOURCES.has(clean(wine.imageSource));
}

function dimensions(candidate) {
  if (Number.isInteger(candidate.width) && Number.isInteger(candidate.height)) return [candidate.width, candidate.height];
  const match = clean(candidate.size || candidate.dimensions).match(/^(\d+)x(\d+)$/i);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function mimeOf(bytes, file) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ['image/png', 'png'];
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ['image/jpeg', 'jpg'];
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return ['image/webp', 'webp'];
  const ext = clean(file).split('.').pop().toLowerCase();
  if (ext === 'png') return ['image/png', 'png'];
  if (ext === 'webp') return ['image/webp', 'webp'];
  return ['image/jpeg', 'jpg'];
}

async function reviewableCandidate(candidate, fileExists) {
  return candidate?.file && await fileExists(candidate.file) && candidate.subjectOk !== false && candidate.displayOk !== false && !SUBJECT_REFUSAL.test(candidate.why || '');
}

function sourceHost(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export async function buildReviewDraft({ catalog, manifest, fileExists, readBytes }) {
  const bySlug = new Map(catalog.map((wine) => [wine.slug, wine]));
  const wines = [];
  for (const record of Object.values(manifest || {})) {
    const wine = bySlug.get(record.slug);
    if (!wine || !wineNeedsReview(wine)) continue;
    const raw = [
      ...(record.ok && record.file ? [{ ...record, why: '', accepted: true }] : []),
      ...(record.alternates || []),
    ];
    const candidates = [];
    const seenBytes = new Set();
    for (let index = 0; index < raw.length; index++) {
      const candidate = raw[index];
      if (!await reviewableCandidate(candidate, fileExists)) continue;
      const bytes = new Uint8Array(await readBytes(candidate.file));
      if (!bytes.length) continue;
      const sha256 = hash(bytes);
      if (seenBytes.has(sha256)) continue;
      seenBytes.add(sha256);
      const candidateId = hash(`${wine.sku}\0${sha256}\0${clean(candidate.page)}\0${index}`).slice(0, 28);
      const [mime, extension] = mimeOf(bytes, candidate.file);
      const [width, height] = dimensions(candidate);
      const sourceUrl = clean(candidate.page || candidate.image);
      const badges = [];
      if (candidate.accepted) badges.push('selector accepted');
      if (candidate.repeatedDesign || candidate.visualConsensus || candidate.matchingImages > 1) badges.push('repeated design');
      if (candidate.cleanBackground === true || candidate.plainBackground === true) badges.push('clean background');
      candidates.push({
        candidateId, localFile: candidate.file, storageName: `${candidateId}.${extension}`,
        sha256, bytes: bytes.length, mime, width, height,
        sourceUrl, sourceImageUrl: clean(candidate.image), sourceHost: sourceHost(sourceUrl),
        reason: clean(candidate.why), labelRead: clean(candidate.label), badges,
      });
    }
    if (!candidates.length) continue;
    wines.push({
      sku: clean(wine.sku), slug: clean(wine.slug),
      displayIdentity: [wine.producer, wine.name, wine.vintage].map(clean).filter(Boolean).join(' · '),
      wineRevision: wineRevision(wine), currentImage: clean(wine.imagePath), candidates,
    });
  }
  wines.sort((left, right) => left.displayIdentity.localeCompare(right.displayIdentity));
  return { schemaVersion: 1, wines };
}

function publicCandidate(candidate) {
  const { localFile, storagePackageId, ...publicValue } = candidate;
  return publicValue;
}

async function optionalJSON(storage, path) {
  try {
    const raw = await storage.get(path);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function publishReviewPackage({ environment, catalogCommit, catalog, draft, storage, readBytes, now = () => new Date() }) {
  if (!['test', 'production'].includes(environment)) throw new Error('review package environment must be test or production');
  if (!/^[a-f0-9]{7,64}$/.test(catalogCommit)) throw new Error('review package requires a catalog commit');
  const prefix = `_review/${environment}`;
  const current = await optionalJSON(storage, `${prefix}/current.json`);
  const previous = current?.packageId ? await optionalJSON(storage, `${prefix}/packages/${current.packageId}/manifest.json`) : null;
  const revisions = new Map(catalog.filter(wineNeedsReview).map((wine) => [clean(wine.sku), wineRevision(wine)]));
  const incoming = new Map((draft.wines || []).map((wine) => [wine.sku, wine]));
  let carried = 0;
  for (const wine of previous?.wines || []) {
    if (incoming.has(wine.sku) || revisions.get(wine.sku) !== wine.wineRevision) continue;
    incoming.set(wine.sku, {
      ...wine,
      candidates: wine.candidates.map((candidate) => ({ ...candidate, storagePackageId: previous.packageId })),
    });
    carried++;
  }
  const wines = [...incoming.values()].sort((left, right) => left.displayIdentity.localeCompare(right.displayIdentity));
  // Once a package exists, publish an empty successor too. Otherwise the last
  // reviewed wine would remain in current.json forever even though the catalog
  // revision proves it has already been handled.
  if (!wines.length && !current?.packageId) return { published: false, packageId: '', wines: 0, carried: 0 };

  const created = now();
  const base = {
    schemaVersion: 1, environment, catalogCommit,
    createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 30 * 86400_000).toISOString(),
    wines: wines.map((wine) => ({ ...wine, candidates: wine.candidates.map(publicCandidate) })),
  };
  const digest = hash(JSON.stringify(base));
  const packageId = `${catalogCommit.slice(0, 12)}-${digest.slice(0, 20)}`;
  const manifest = { ...base, packageId };

  for (const wine of wines) {
    for (const candidate of wine.candidates) {
      const bytes = candidate.localFile
        ? new Uint8Array(await readBytes(candidate.localFile))
        : new Uint8Array(await storage.getBytes(`${prefix}/packages/${candidate.storagePackageId}/images/${candidate.storageName}`));
      if (!bytes.length || hash(bytes) !== candidate.sha256 || bytes.length !== candidate.bytes) throw new Error(`candidate integrity failed for ${wine.sku}/${candidate.candidateId}`);
      await storage.putImmutable(`${prefix}/packages/${packageId}/images/${candidate.storageName}`, bytes, candidate.mime);
    }
  }
  await storage.putImmutable(`${prefix}/packages/${packageId}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', 'application/json');
  await storage.put(`${prefix}/current.json`, JSON.stringify({ schemaVersion: 1, environment, packageId, catalogCommit, publishedAt: now().toISOString() }, null, 2) + '\n', 'application/json');
  return { published: true, packageId, wines: wines.length, carried, added: (draft.wines || []).length };
}
