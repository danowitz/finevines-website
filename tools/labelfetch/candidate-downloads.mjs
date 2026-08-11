import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function supported(bytes) {
  return (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
}

async function mapLimit(items, limit, work) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

export async function downloadFirstTen({
  items,
  directory,
  fetchImpl = globalThis.fetch,
  convert,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  concurrency = 3,
}) {
  await mkdirImpl(directory, { recursive: true });
  const attempted = items.slice(0, 10);
  const results = await mapLimit(attempted, concurrency, async (item, index) => {
    try {
      const response = await fetchImpl(item.url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { candidate: null, failure: 'http' };
      let bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 2000) return { candidate: null, failure: 'tooSmall' };
      if (!supported(bytes)) {
        if (!convert) return { candidate: null, failure: 'unsupported' };
        bytes = await convert(bytes);
        if (!bytes || bytes.length < 2000) return { candidate: null, failure: 'conversion' };
      }
      const file = join(directory, `candidate-${String(index + 1).padStart(2, '0')}.png`);
      await writeFileImpl(file, bytes);
      return { candidate: { ...item, id: `candidate-${index + 1}`, file }, failure: '' };
    } catch {
      return { candidate: null, failure: 'transport' };
    }
  });
  const failures = (kind) => results.filter((result) => result.failure === kind).length;
  return {
    candidates: results.map((result) => result.candidate).filter(Boolean),
    diagnostics: {
      downloadAttempted: attempted.length,
      downloaded: results.filter((result) => result.candidate).length,
      downloadHttpFailures: failures('http'),
      downloadTooSmall: failures('tooSmall'),
      downloadUnsupported: failures('unsupported'),
      downloadConversionFailures: failures('conversion'),
      downloadTransportFailures: failures('transport'),
    },
  };
}
