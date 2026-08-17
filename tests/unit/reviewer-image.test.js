import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectReviewerImage, ReviewerImageError } from '../../edge/review-console/reviewer-image.mjs';

const samples = [
  ['image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='],
  ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q=='],
  ['image/webp', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'],
];

describe('reviewer image inspection', () => {
  it('accepts complete PNG, JPEG, and WebP containers by their bytes', async () => {
    for (const [mime, base64] of samples) {
      const bytes = Buffer.from(base64, 'base64');
      const inspected = await inspectReviewerImage(new Blob([bytes], { type: 'application/octet-stream' }));
      assert.equal(inspected.mime, mime);
      assert.equal(inspected.bytesLength, bytes.byteLength);
      assert.match(inspected.sha256, /^[a-f0-9]{64}$/);
    }
  });

  it('rejects a signature-only or truncated container', async () => {
    for (const [, base64] of samples) {
      const bytes = Buffer.from(base64, 'base64').subarray(0, 16);
      await assert.rejects(() => inspectReviewerImage(new Blob([bytes])), ReviewerImageError);
    }
  });
});
