import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReviewerRoster, buildReviewDraft, publishReviewPackage, wineRevision } from '../../tools/labelfetch/review-package.mjs';
import { IMAGE_REVIEW_REQUIRED } from '../../tools/labelfetch/image-review-status.mjs';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const wine = { id: 'wine-1', sku: 'AB-1', slug: 'producer-wine-2022', producer: 'Producer', name: 'Wine', vintage: '2022', imagePath: 'assets/img/wines/producer-wine-2022.svg', imageSource: 'generated-label', sourceHash: 'source' };
const reviewers = [{ name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' }];

function memoryStorage(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    get: async (path) => files.get(path),
    getBytes: async (path) => files.get(path),
    put: async (path, body) => files.set(path, body),
    putImmutable: async (path, body) => {
      if (files.has(path) && String(files.get(path)) !== String(body)) throw new Error('immutable conflict');
      files.set(path, body);
    },
  };
}

describe('hosted review package', () => {
  it('limits the reviewer roster to current executives and back office users', () => {
    assert.deepEqual(buildReviewerRoster([
      { name: 'Connie Molitor', email: 'CONNIE@finevines.com', role: 'Executive' },
      { name: 'Daniel Pilkey', email: 'dan@finevines.com', role: 'Sales Rep' },
      { name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' },
      { name: ' Connie Molitor ', email: 'connie@finevines.com', role: 'Executive' },
      { name: 'Missing Email', role: 'Back Office' },
    ]), [
      { name: 'Barb Fultz', email: 'barb.fultz@finevines.com', role: 'Back Office' },
      { name: 'Connie Molitor', email: 'connie@finevines.com', role: 'Executive' },
    ]);
  });
  it('shares one canonical wine revision contract with the Go action applier', () => {
    assert.equal(wineRevision(wine), '56514dfc14df894df9dbb0f24ba5f6d3180fb28b8d3d4a36b0a30237a4c99e7b');
  });

  it('builds only reviewable bottle candidates and removes local paths from the public manifest', async () => {
    const records = { one: { slug: wine.slug, query: 'Producer Wine 2022 exact search', ok: false, alternates: [
      { file: 'good.png', page: 'https://producer.example/wine', width: 400, height: 800, repeatedDesign: true },
      { file: 'scene.png', page: 'https://example/scene', why: 'no clean background — a photographed scene' },
    ] } };
    const draft = await buildReviewDraft({ catalog: [wine], manifest: records, fileExists: (path) => path !== 'missing.png', readBytes: async () => png });
    assert.equal(draft.wines.length, 1);
    assert.equal(draft.wines[0].candidates.length, 1);
    assert.deepEqual(draft.wines[0].candidates[0].badges, ['repeated design']);
    assert.equal(draft.wines[0].wineRevision, wineRevision(wine));
    assert.equal(draft.wines[0].searchQuery, 'Producer Wine 2022 exact search');
  });

  it('does not put an explicitly rejected candidate set back into the next review package', async () => {
    const dismissed = { ...wine, imageReviewStatus: 'no-match' };
    const draft = await buildReviewDraft({
      catalog: [dismissed],
      manifest: { one: { slug: wine.slug, ok: false, alternates: [{ file: 'good.png', page: 'https://producer.example/wine' }] } },
      fileExists: async () => true,
      readBytes: async () => png,
    });
    assert.deepEqual(draft.wines, []);
  });

  it('puts a recovered wrong-image wine back into review when fresh candidates exist', async () => {
    const reopened = { ...wine, imageReviewStatus: IMAGE_REVIEW_REQUIRED };
    const draft = await buildReviewDraft({
      catalog: [reopened],
      manifest: { one: { slug: wine.slug, query: 'Producer Wine 2022', ok: false, alternates: [{ file: 'good.png', page: 'https://producer.example/wine' }] } },
      fileExists: async () => true,
      readBytes: async () => png,
    });
    assert.equal(draft.wines.length, 1);
    assert.equal(draft.wines[0].sku, wine.sku);
  });

  it('awaits asynchronous file checks instead of trying to publish missing candidates', async () => {
    const draft = await buildReviewDraft({
      catalog: [wine],
      manifest: { one: { slug: wine.slug, ok: false, alternates: [{ file: 'missing.png' }, { file: 'good.png' }] } },
      fileExists: async (path) => path === 'good.png',
      readBytes: async (path) => { assert.equal(path, 'good.png'); return png; },
    });
    assert.equal(draft.wines[0].candidates.length, 1);
  });

  it('does not make a reviewer compare duplicate copies of identical bytes', async () => {
    const draft = await buildReviewDraft({
      catalog: [wine],
      manifest: { one: { slug: wine.slug, ok: false, alternates: [{ file: 'one.png' }, { file: 'two.png' }] } },
      fileExists: async () => true,
      readBytes: async () => png,
    });
    assert.equal(draft.wines[0].candidates.length, 1);
  });

  it('uses the direct image URL as provenance when the search result has no page URL', async () => {
    const draft = await buildReviewDraft({
      catalog: [wine],
      manifest: { one: { slug: wine.slug, ok: false, alternates: [{ file: 'one.png', image: 'https://producer.example/bottle.png' }] } },
      fileExists: async () => true,
      readBytes: async () => png,
    });
    assert.equal(draft.wines[0].candidates[0].sourceUrl, 'https://producer.example/bottle.png');
    assert.equal(draft.wines[0].candidates[0].sourceHost, 'producer.example');
  });

  it('publishes immutable image bytes and manifest before moving current.json', async () => {
    const storage = memoryStorage();
    const draft = await buildReviewDraft({ catalog: [wine], manifest: { one: { slug: wine.slug, query: 'Producer Wine 2022', ok: false, alternates: [{ file: 'good.png', page: 'https://producer.example/wine' }] } }, fileExists: () => true, readBytes: async () => png });
    const result = await publishReviewPackage({ environment: 'test', catalogCommit: 'a'.repeat(40), catalog: [wine], draft, reviewers, storage, readBytes: async () => png, now: () => new Date('2026-08-15T00:00:00Z') });
    assert.equal(result.wines, 1);
    const current = JSON.parse(storage.files.get('_review/test/current.json'));
    const manifest = JSON.parse(storage.files.get(`_review/test/packages/${current.packageId}/manifest.json`));
    assert.deepEqual(manifest.reviewers, reviewers);
    assert.equal(manifest.wines[0].candidates[0].localFile, undefined);
    assert.ok(storage.files.has(`_review/test/packages/${current.packageId}/images/${manifest.wines[0].candidates[0].storageName}`));
  });

  it('carries unresolved candidates forward only while the catalog revision still matches', async () => {
    const priorCandidate = { candidateId: 'old', storageName: 'old.png', sha256: 'hash', bytes: 3, mime: 'image/png', width: 1, height: 1 };
    const previous = { schemaVersion: 1, packageId: 'old-package', environment: 'test', catalogCommit: 'b'.repeat(40), wines: [{ sku: wine.sku, displayIdentity: 'Old', wineRevision: wineRevision(wine), candidates: [priorCandidate] }] };
    const storage = memoryStorage({
      '_review/test/current.json': JSON.stringify({ packageId: 'old-package' }),
      '_review/test/packages/old-package/manifest.json': JSON.stringify(previous),
      '_review/test/packages/old-package/images/old.png': new Uint8Array([1, 2, 3]),
    });
    priorCandidate.sha256 = (await import('node:crypto')).createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
    storage.files.set('_review/test/packages/old-package/manifest.json', JSON.stringify(previous));
    const result = await publishReviewPackage({ environment: 'test', catalogCommit: 'c'.repeat(40), catalog: [wine], draft: { schemaVersion: 1, searchQueries: { [wine.sku]: 'Producer Wine 2022 original query' }, wines: [] }, reviewers, storage, readBytes: async () => { throw new Error('not local'); }, now: () => new Date('2026-08-16T00:00:00Z') });
    assert.equal(result.carried, 1);
    assert.equal(result.wines, 1);
    const current = JSON.parse(storage.files.get('_review/test/current.json'));
    const manifest = JSON.parse(storage.files.get(`_review/test/packages/${current.packageId}/manifest.json`));
    assert.equal(manifest.wines[0].searchQuery, 'Producer Wine 2022 original query');
  });

  it('migrates a legacy carried card to a producer-name-year Google query', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const previous = {
      schemaVersion: 1, packageId: 'legacy-package', environment: 'test', catalogCommit: 'b'.repeat(40),
      wines: [{ sku: wine.sku, displayIdentity: 'Producer · Wine · 2022', wineRevision: wineRevision(wine), candidates: [{ candidateId: 'old', storageName: 'old.png', sha256, bytes: 3, mime: 'image/png', width: 1, height: 1 }] }],
    };
    const storage = memoryStorage({
      '_review/test/current.json': JSON.stringify({ packageId: 'legacy-package' }),
      '_review/test/packages/legacy-package/manifest.json': JSON.stringify(previous),
      '_review/test/packages/legacy-package/images/old.png': bytes,
    });
    await publishReviewPackage({ environment: 'test', catalogCommit: 'c'.repeat(40), catalog: [wine], draft: { schemaVersion: 1, wines: [] }, reviewers, storage, readBytes: async () => { throw new Error('not local'); } });
    const current = JSON.parse(storage.files.get('_review/test/current.json'));
    const manifest = JSON.parse(storage.files.get(`_review/test/packages/${current.packageId}/manifest.json`));
    assert.equal(manifest.wines[0].searchQuery, 'Producer Wine 2022');
  });

  it('refuses to publish a review card when its original discovery query is unavailable', async () => {
    const storage = memoryStorage();
    const draft = await buildReviewDraft({ catalog: [wine], manifest: { one: { slug: wine.slug, ok: false, alternates: [{ file: 'good.png' }] } }, fileExists: () => true, readBytes: async () => png });
    await assert.rejects(
      publishReviewPackage({ environment: 'test', catalogCommit: 'c'.repeat(40), catalog: [wine], draft, reviewers, storage, readBytes: async () => png }),
      /missing its original discovery query/,
    );
  });

  it('publishes an empty successor so the final reviewed wine disappears from the console', async () => {
    const previous = { schemaVersion: 1, packageId: 'old-package', environment: 'test', catalogCommit: 'b'.repeat(40), wines: [{ sku: wine.sku, displayIdentity: 'Old', wineRevision: wineRevision(wine), candidates: [] }] };
    const storage = memoryStorage({
      '_review/test/current.json': JSON.stringify({ packageId: 'old-package' }),
      '_review/test/packages/old-package/manifest.json': JSON.stringify(previous),
    });
    const changed = { ...wine, imagePath: 'assets/img/wines/producer-wine-2022.jpg', imageSource: 'scraped-web' };
    const result = await publishReviewPackage({ environment: 'test', catalogCommit: 'd'.repeat(40), catalog: [changed], draft: { schemaVersion: 1, wines: [] }, reviewers, storage, readBytes: async () => { throw new Error('not local'); }, now: () => new Date('2026-08-17T00:00:00Z') });
    assert.equal(result.wines, 0);
    const current = JSON.parse(storage.files.get('_review/test/current.json'));
    const manifest = JSON.parse(storage.files.get(`_review/test/packages/${current.packageId}/manifest.json`));
    assert.deepEqual(manifest.wines, []);
  });
});
