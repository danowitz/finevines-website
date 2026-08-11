import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFirstTen } from '../../tools/labelfetch/candidate-downloads.mjs';

test('downloads only the first ten structured image results with bounded concurrency', async () => {
  let active = 0;
  let peak = 0;
  const writes = [];
  const items = Array.from({ length: 12 }, (_, index) => ({
    url: `https://images.example/${index}.jpg`, context: `https://source.example/${index}`, width: index, height: 800,
  }));
  const result = await downloadFirstTen({
    items,
    directory: 'ignored',
    concurrency: 3,
    mkdirImpl: async () => {},
    writeFileImpl: async (file) => writes.push(file),
    fetchImpl: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const bytes = Buffer.alloc(2100);
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      return { ok: true, arrayBuffer: async () => bytes };
    },
  });
  assert.equal(result.length, 10);
  assert.equal(writes.length, 10);
  assert.ok(peak <= 3);
  assert.equal(result[0].context, items[0].context);
  assert.equal(result[9].url, items[9].url);
});
