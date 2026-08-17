import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldDeferCertificate } from '../../tools/review-console/certificate-policy.mjs';

const notPointing = JSON.stringify({
  ErrorKey: 'pullzone.certificate_request_failed',
  Field: 'hostname',
  Message: 'The domain is not pointing to our servers.',
});

test('defers the production certificate until the production hostname points to Bunny', () => {
  assert.equal(shouldDeferCertificate({ environment: 'production', status: 400, detail: notPointing }), true);
});

test('does not hide the same certificate failure in the active test environment', () => {
  assert.equal(shouldDeferCertificate({ environment: 'test', status: 400, detail: notPointing }), false);
});

test('does not hide unrelated Bunny failures or malformed responses', () => {
  assert.equal(shouldDeferCertificate({ environment: 'production', status: 401, detail: notPointing }), false);
  assert.equal(shouldDeferCertificate({ environment: 'production', status: 400, detail: '{broken' }), false);
  assert.equal(shouldDeferCertificate({
    environment: 'production',
    status: 400,
    detail: JSON.stringify({ ErrorKey: 'different_error' }),
  }), false);
});
