import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { before, describe, it } from 'node:test';

import { issueSession, protectedHeaders, validateAction, verifySession } from '../../edge/review-console/core.mjs';

before(() => { globalThis.crypto ??= webcrypto; });

describe('protected review console', () => {
  it('issues a host-environment-bound expiring session', async () => {
    const now = new Date('2026-08-11T20:00:00Z');
    const token = await issueSession({ secret: 'test-secret', environment: 'test', sessionId: 'session-1', reviewerEmail: 'barb.fultz@finevines.com', credentialVersion: 2, mustChangePassword: false, now });
    assert.deepEqual(await verifySession(token, { secret: 'test-secret', environment: 'test', now }), {
      v: 2, environment: 'test', sessionId: 'session-1', reviewerEmail: 'barb.fultz@finevines.com', credentialVersion: 2, mustChangePassword: false, exp: 1786521600,
    });
    assert.equal(await verifySession(token, { secret: 'test-secret', environment: 'production', now }), null);
    assert.equal(await verifySession(token, { secret: 'wrong', environment: 'test', now }), null);
    assert.equal(await verifySession(token, { secret: 'test-secret', environment: 'test', now: new Date(now.getTime() + 43_201_000) }), null);
  });

  it('marks every protected response as non-indexable and non-cacheable', () => {
    const headers = protectedHeaders();
    assert.match(headers['X-Robots-Tag'], /noindex/);
    assert.match(headers['X-Robots-Tag'], /noimageindex/);
    assert.equal(headers['Referrer-Policy'], 'same-origin', 'same-origin forms retain an Origin value for CSRF validation');
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(headers['X-Frame-Options'], 'DENY');
  });

  it('creates the strict immutable image-selection contract', () => {
    const action = validateAction({
      kind: 'image-select', sku: 'AB-123', packageId: 'abc123-package',
      targetCatalogCommit: 'abcdef1234567', wineRevision: 'a'.repeat(64), candidateId: 'candidate-2',
    }, { id: '00000000-0000-4000-8000-000000000001', environment: 'test', sessionId: 'session-1', reviewerEmail: 'barb.fultz@finevines.com', now: new Date('2026-08-11T20:00:00Z') });
    assert.equal(action.environment, 'test');
    assert.equal(action.schemaVersion, 1);
    assert.equal(action.csrfSessionId, 'session-1');
    assert.equal(action.reviewer, 'barb.fultz@finevines.com');
  });

  it('accepts catalog SKUs with inventory suffix asterisks', () => {
    const action = validateAction({
      kind: 'image-select', sku: '500740*', packageId: 'pkg',
      targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1',
    }, { id: '00000000-0000-4000-8000-000000000001', environment: 'test', sessionId: 'session-1', reviewerEmail: 'barb.fultz@finevines.com', now: new Date() });
    assert.equal(action.sku, '500740*');
  });

  it('creates reviewer-image actions only for the trusted upload route', () => {
    const input = {
      kind: 'reviewer-image', sku: '500740*', packageId: 'pkg',
      targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: '',
      imageStorageName: '00000000-0000-4000-8000-000000000001.png', imageSHA256: 'b'.repeat(64), imageBytes: 123, imageMIME: 'image/png',
    };
    const context = { id: '00000000-0000-4000-8000-000000000001', environment: 'test', sessionId: 'session-1', reviewerEmail: 'barb.fultz@finevines.com', now: new Date() };
    assert.throws(() => validateAction(input, context), /invalid kind/);
    const action = validateAction(input, { ...context, allowReviewerImage: true });
    assert.equal(action.kind, 'reviewer-image');
    assert.equal(action.imageSHA256, 'b'.repeat(64));
  });

  it('creates image-reopen actions only for the trusted administrator route', () => {
    const input = {
      kind: 'image-reopen', sku: '500740*', packageId: 'pkg',
      targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: '', reason: 'Support reported the current catalog image as wrong.',
    };
    const context = { id: '00000000-0000-4000-8000-000000000001', environment: 'production', sessionId: 'session-1', reviewerEmail: 'joel@danowitz.com', now: new Date() };
    assert.throws(() => validateAction(input, context), /invalid kind/);
    const action = validateAction(input, { ...context, allowImageReopen: true });
    assert.equal(action.kind, 'image-reopen');
    assert.equal(action.candidateId, '');
  });

  it('rejects extra fields, unsafe identifiers, and inconsistent kinds', () => {
    const base = { kind: 'image-select', sku: 'AB-123', packageId: 'pkg', targetCatalogCommit: 'abcdef1', wineRevision: 'a'.repeat(64), candidateId: 'c1' };
    const context = { id: 'id', environment: 'test', sessionId: 's', reviewerEmail: 'barb.fultz@finevines.com', now: new Date() };
    assert.throws(() => validateAction({ ...base, admin: true }, context), /unknown action field/);
    assert.throws(() => validateAction({ ...base, packageId: '../prod' }, context), /invalid packageId/);
    assert.throws(() => validateAction({ ...base, kind: 'no-image' }, context), /cannot name a candidate/);
    assert.throws(() => validateAction({ ...base, candidateId: '' }, context), /invalid candidateId/);
    assert.throws(() => validateAction({ ...base, reviewer: 'George Molitor' }, context), /unknown action field reviewer/);
  });
});
