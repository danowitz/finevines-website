import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityProofEngine } from '../../tools/labelfetch/identity-proof.mjs';

function candidate(id, overrides = {}) {
  return {
    id,
    file: `${id}.png`,
    url: `https://${id}.example/${id}.png`,
    context: `https://${id}.example/${id}`,
    title: id,
    width: 400,
    height: 800,
    shapeOk: true,
    cleanBackground: true,
    ...overrides,
  };
}

test('retries only candidate IDs missing from a malformed reader batch', async () => {
  const calls = [];
  const subject = createIdentityProofEngine({
    read: async (_wine, batch) => {
      calls.push(batch.map(({ id }) => id));
      if (calls.length === 1) {
        const evidence = [{ id: 'one', anchor: false, readStatus: 'ok' }];
        evidence.readerTrace = { candidateIds: ['one', 'two', 'three'], response: 'one row only' };
        return evidence;
      }
      return batch.map(({ id }) => ({ id, anchor: id === 'two', readStatus: 'ok' }));
    },
  });
  const candidates = ['one', 'two', 'three'].map((id) => candidate(id));

  const result = await subject.prove(
    { name: 'Target Wine', vintage: '2022' },
    { candidates, groups: [candidates] },
  );

  assert.deepEqual(calls, [['one', 'two', 'three'], ['two'], ['three']]);
  assert.deepEqual(result.evidence.map(({ id }) => id), ['one', 'two', 'three']);
  assert.equal(result.evidence.find(({ id }) => id === 'two').anchor, true);
  assert.equal(result.diagnostics.readerRetries, 2);
  assert.equal(result.diagnostics.invalidReaderResults, 0);
});

test('keeps reading evidence-directed candidates beyond the old six-image ceiling', async () => {
  const calls = [];
  const candidates = Array.from({ length: 9 }, (_, index) => candidate(`candidate-${index + 1}`, {
    title: `other ${index + 1}`,
  }));
  const subject = createIdentityProofEngine({
    maxCandidates: 10,
    read: async (_wine, batch) => {
      calls.push(batch.map(({ id }) => id));
      return batch.map(({ id }) => ({
        id,
        anchor: id === 'candidate-8',
        readStatus: 'ok',
      }));
    },
  });

  const result = await subject.prove(
    { name: 'Target Wine', vintage: '2022' },
    { candidates, groups: [candidates] },
  );

  assert.equal(result.evidence.some(({ id, anchor }) => id === 'candidate-8' && anchor), true);
  assert.equal(result.diagnostics.candidatesRead, 8);
  assert.deepEqual(calls.map((batch) => batch.length), [3, 1, 1, 1, 1, 1]);
  assert.equal(result.stopReason, 'publishable-anchor');
});

test('does not stop at a product anchor carrying a visibly wrong vintage', async () => {
  const candidates = ['old', 'neutral'].map((id) => candidate(id));
  const subject = createIdentityProofEngine({
    read: async (_wine, batch) => batch.map(({ id }) => id === 'old'
      ? {
          id,
          anchor: false,
          productAnchor: true,
          vintageStatus: 'wrong-visible',
          readStatus: 'ok',
        }
      : {
          id,
          anchor: true,
          productAnchor: true,
          vintageStatus: 'neutral',
          readStatus: 'ok',
        }),
  });

  const result = await subject.prove(
    { name: 'Target Wine', vintage: '2022' },
    { candidates, groups: [candidates] },
  );

  assert.equal(result.evidence.find(({ id }) => id === 'old').productAnchor, true);
  assert.equal(result.evidence.find(({ id }) => id === 'neutral').anchor, true);
  assert.equal(result.stopReason, 'publishable-anchor');
});

test('records an explicit diagnostic when a single-candidate retry is still malformed', async () => {
  const subject = createIdentityProofEngine({ read: async () => [] });
  const candidates = [candidate('one'), candidate('two')];

  const result = await subject.prove(
    { name: 'Target Wine' },
    { candidates, groups: [candidates] },
  );

  assert.equal(result.diagnostics.invalidReaderResults, 2);
  assert.deepEqual(result.evidence.map(({ reasonCode }) => reasonCode), [
    'READER_RESPONSE_INVALID',
    'READER_RESPONSE_INVALID',
  ]);
  assert.equal(result.stopReason, 'evidence-exhausted');
});
