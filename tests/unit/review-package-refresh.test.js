import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildReviewDraft, publishReviewPackage, wineRevision } from '../../tools/labelfetch/review-package.mjs';

test('a 350-wine refresh carries immutable images without transferring them again', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const catalog = Array.from({ length: 350 }, (_, n) => ({
    sku: String(n), slug: `wine-${n}`, name: `Wine ${n}`, producer: 'Producer', imagePath: 'fallback.svg',
  }));
  const originId = 'original-package';
  const previous = { packageId: originId, wines: catalog.map((wine) => ({
    sku: wine.sku, slug: wine.slug, displayIdentity: wine.name, searchQuery: wine.name,
    wineRevision: wineRevision(wine), candidates: [{
      candidateId: `candidate-${wine.sku}`, storageName: `candidate-${wine.sku}.png`,
      sha256, bytes: bytes.length, mime: 'image/png',
    }],
  })) };
  const files = new Map([
    ['_review/test/current.json', JSON.stringify({ packageId: originId })],
    [`_review/test/packages/${originId}/manifest.json`, JSON.stringify(previous)],
  ]);
  let imageReads = 0;
  let imageWrites = 0;
  const storage = {
    get: async (path) => files.get(path) || '',
    getBytes: async () => { imageReads++; return bytes; },
    putImmutable: async (path, content) => {
      if (path.includes('/images/')) imageWrites++;
      files.set(path, content);
    },
    put: async (path, content) => files.set(path, content),
  };
  for (let generation = 1; generation <= 3; generation++) {
    const result = await publishReviewPackage({
      environment: 'test', catalogCommit: 'a'.repeat(40), catalog, draft: { wines: [] },
      reviewers: [{ name: 'Reviewer', email: 'reviewer@example.com', role: 'Back Office' }],
      storage, readBytes: async () => { throw new Error('no new local images'); },
      now: () => new Date(`2026-10-${15 + generation}T00:00:00Z`),
    });
    assert.equal(result.carried, 350);
    assert.equal(imageReads, 0, 'refresh must not download carried image bytes');
    assert.equal(imageWrites, 0, 'refresh must not re-upload carried image bytes');
    const manifest = JSON.parse(files.get(`_review/test/packages/${result.packageId}/manifest.json`));
    assert.equal(manifest.wines.length, 350);
    assert.ok(manifest.wines.every((wine) => wine.candidates.every((c) => c.storagePackageId === originId)));
  }
});

test('an incomplete new candidate cannot publish a manifest with no image location', async () => {
  const wine = { sku: 'new', slug: 'new-wine', name: 'New Wine', imagePath: 'fallback.svg' };
  const writes = [];
  await assert.rejects(publishReviewPackage({
    environment: 'test', catalogCommit: 'a'.repeat(40), catalog: [wine],
    draft: { wines: [{ sku: 'new', displayIdentity: 'New Wine', searchQuery: 'New Wine',
      wineRevision: wineRevision(wine), candidates: [{ candidateId: 'new', storageName: 'new.png' }],
    }] },
    reviewers: [{ name: 'Reviewer', email: 'reviewer@example.com', role: 'Back Office' }],
    storage: {
      get: async () => null,
      putImmutable: async (path) => writes.push(path), put: async (path) => writes.push(path),
    },
    readBytes: async () => { throw new Error('missing local file'); },
  }), /candidate.*image location|missing local file/);
  assert.deepEqual(writes, []);
});

test('a mixed refresh preserves current on interruption and retries with only new image uploads', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
  const oldWine = { sku: 'old', slug: 'old-wine', name: 'Old Wine', imagePath: 'old.svg' };
  const newWine = { sku: 'new', slug: 'new-wine', name: 'New Wine', imagePath: 'new.svg' };
  const currentPath = '_review/test/current.json';
  const current = JSON.stringify({ packageId: 'original-package' });
  const files = new Map([
    [currentPath, current],
    ['_review/test/packages/original-package/manifest.json', JSON.stringify({ packageId: 'original-package', wines: [{
      sku: oldWine.sku, displayIdentity: oldWine.name, searchQuery: oldWine.name, wineRevision: wineRevision(oldWine),
      candidates: [{ candidateId: 'old', storageName: 'old.png' }],
    }] })],
  ]);
  const draft = await buildReviewDraft({
    catalog: [newWine], manifest: { new: { slug: newWine.slug, query: newWine.name,
      alternates: [{ file: 'new.png', page: 'https://example.com/new' }],
    } }, fileExists: async () => true, readBytes: async () => bytes,
  });
  let interrupt = true;
  const imageWrites = [];
  const storage = {
    get: async (path) => files.get(path),
    getBytes: async () => { throw new Error('carried bytes must not be downloaded'); },
    putImmutable: async (path, body) => {
      if (path.endsWith('/manifest.json') && interrupt) throw new Error('interrupted');
      if (path.includes('/images/')) imageWrites.push(path);
      files.set(path, body);
    },
    put: async (path, body) => files.set(path, body),
  };
  const input = { environment: 'test', catalogCommit: 'a'.repeat(40), catalog: [oldWine, newWine], draft,
    reviewers: [{ name: 'Reviewer', email: 'reviewer@example.com', role: 'Back Office' }],
    storage, readBytes: async () => bytes, now: () => new Date('2026-10-15T00:00:00Z'),
  };
  await assert.rejects(publishReviewPackage(input), /interrupted/);
  assert.equal(files.get(currentPath), current);
  interrupt = false;
  const result = await publishReviewPackage(input);
  assert.equal(result.carried, 1);
  const manifest = JSON.parse(files.get(`_review/test/packages/${result.packageId}/manifest.json`));
  assert.equal(manifest.wines.find(({ sku }) => sku === 'old').candidates[0].storagePackageId, 'original-package');
  const fresh = manifest.wines.find(({ sku }) => sku === 'new').candidates[0];
  assert.equal(fresh.storagePackageId, undefined);
  assert.ok(files.has(`_review/test/packages/${result.packageId}/images/${fresh.storageName}`));
  assert.equal(imageWrites.length, 2, 'one new image upload per attempt');
});
