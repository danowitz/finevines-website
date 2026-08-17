import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadRejectedCandidates } from '../../tools/labelfetch/rejected-candidates.mjs';

describe('review recovery rejected candidates', () => {
  it('rejects both recorded source identities and byte-identical images', async () => {
    const bytes = Buffer.from('previously rejected bottle bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const rejected = await loadRejectedCandidates('rejected.json', async () => JSON.stringify({
      rejectedCandidates: [{ candidateId: 'old-1', sha256, sourceImageUrl: 'https://images.example/bottle.jpg', sourceUrl: 'https://merchant.example/wine' }],
    }));

    assert.equal(rejected.acceptIdentity({ url: 'https://images.example/bottle.jpg', page: 'https://other.example' }), false);
    assert.equal(rejected.acceptIdentity({ url: 'https://new.example/bottle.jpg', page: 'https://merchant.example/wine' }), false);
    assert.equal(rejected.acceptBytes(bytes), false);
    assert.equal(rejected.acceptIdentity({ url: 'https://new.example/different.jpg', page: 'https://new.example/wine' }), true);
    assert.equal(rejected.acceptBytes(Buffer.from('genuinely new bottle bytes')), true);
  });
});
