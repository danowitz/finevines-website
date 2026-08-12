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
  assert.equal(result.candidates.length, 10);
  assert.equal(writes.length, 10);
  assert.ok(peak <= 3);
  assert.equal(result.candidates[0].context, items[0].context);
  assert.equal(result.candidates[9].url, items[9].url);
  assert.deepEqual(result.diagnostics, {
    downloadAttempted: 10,
    downloaded: 10,
    downloadHttpFailures: 0,
    downloadTooSmall: 0,
    downloadUnsupported: 0,
    downloadConversionFailures: 0,
    downloadTransportFailures: 0,
  });
});

test('reports each download failure rule separately', async () => {
  const bytes = Buffer.alloc(2100);
  const result = await downloadFirstTen({
    items: [
      { url: 'https://example.test/http' },
      { url: 'https://example.test/small' },
      { url: 'https://example.test/unsupported' },
      { url: 'https://example.test/transport' },
    ],
    directory: 'ignored',
    mkdirImpl: async () => {},
    writeFileImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith('/http')) return { ok: false };
      if (url.endsWith('/transport')) throw new Error('network');
      if (url.endsWith('/small')) return { ok: true, arrayBuffer: async () => Buffer.alloc(20) };
      return { ok: true, arrayBuffer: async () => bytes };
    },
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.downloadHttpFailures, 1);
  assert.equal(result.diagnostics.downloadTooSmall, 1);
  assert.equal(result.diagnostics.downloadUnsupported, 1);
  assert.equal(result.diagnostics.downloadTransportFailures, 1);
  assert.deepEqual(result.trace.map(({ index, outcome }) => ({ index, outcome })), [
    { index: 1, outcome: 'http' },
    { index: 2, outcome: 'tooSmall' },
    { index: 3, outcome: 'unsupported' },
    { index: 4, outcome: 'transport' },
  ]);
});
