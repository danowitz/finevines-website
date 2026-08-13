import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadCandidates } from '../../tools/labelfetch/candidate-downloads.mjs';

test('downloads every candidate supplied by the pipeline with bounded concurrency', async () => {
  let active = 0;
  let peak = 0;
  const writes = [];
  const items = Array.from({ length: 12 }, (_, index) => ({
    url: `https://images.example/${index}.jpg`, context: `https://source.example/${index}`, width: index, height: 800,
  }));
  const result = await downloadCandidates({
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
  assert.equal(result.candidates.length, 12);
  assert.equal(writes.length, 12);
  assert.ok(peak <= 3);
  assert.equal(result.candidates[0].context, items[0].context);
  assert.equal(result.candidates[11].url, items[11].url);
  assert.deepEqual(result.diagnostics, {
    downloadAttempted: 12,
    downloaded: 12,
    downloadHttpFailures: 0,
    downloadTooSmall: 0,
    downloadUnsupported: 0,
    downloadConversionFailures: 0,
    downloadTransportFailures: 0,
  });
});

test('reports each download failure rule separately', async () => {
  const bytes = Buffer.alloc(2100);
  const result = await downloadCandidates({
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

test('passes the response image MIME type to the converter', async () => {
  const source = Buffer.alloc(2100, 1);
  const png = Buffer.alloc(2100, 2);
  png[0] = 0x89;
  png[1] = 0x50;
  png[2] = 0x4e;
  png[3] = 0x47;
  let seenType = '';
  const result = await downloadCandidates({
    items: [{ url: 'https://example.test/bottle.webp' }],
    directory: 'ignored',
    mkdirImpl: async () => {},
    writeFileImpl: async () => {},
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => source,
    }),
    convert: async (_bytes, contentType) => {
      seenType = contentType;
      return png;
    },
  });
  assert.equal(seenType, 'image/webp');
  assert.equal(result.candidates.length, 1);
});
