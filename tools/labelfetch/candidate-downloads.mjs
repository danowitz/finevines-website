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

export async function downloadCandidates({
  items,
  directory,
  fetchImpl = globalThis.fetch,
  convert,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  concurrency = 3,
}) {
  await mkdirImpl(directory, { recursive: true });
  const attempted = items;
  const results = await mapLimit(attempted, concurrency, async (item, index) => {
    try {
      const response = await fetchImpl(item.url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { candidate: null, failure: 'http', status: response.status || 0, bytes: 0 };
      let bytes = Buffer.from(await response.arrayBuffer());
      const receivedBytes = bytes.length;
      if (bytes.length < 2000) return { candidate: null, failure: 'tooSmall', status: response.status || 200, bytes: receivedBytes };
      if (!supported(bytes)) {
        if (!convert) return { candidate: null, failure: 'unsupported', status: response.status || 200, bytes: receivedBytes };
        bytes = await convert(bytes, response.headers?.get?.('content-type') || '');
        if (!bytes || bytes.length < 2000) return { candidate: null, failure: 'conversion', status: response.status || 200, bytes: receivedBytes };
      }
      const file = join(directory, `candidate-${String(index + 1).padStart(2, '0')}.png`);
      await writeFileImpl(file, bytes);
      return { candidate: { ...item, id: `candidate-${index + 1}`, file }, failure: '', status: response.status || 200, bytes: bytes.length };
    } catch (error) {
      return { candidate: null, failure: 'transport', status: 0, bytes: 0, error: String(error?.message || error).split('\n')[0] };
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
    trace: results.map((result, index) => ({
      index: index + 1,
      url: attempted[index]?.url || '',
      context: attempted[index]?.context || '',
      title: attempted[index]?.title || '',
      declaredWidth: attempted[index]?.width || 0,
      declaredHeight: attempted[index]?.height || 0,
      status: result.status || 0,
      bytes: result.bytes || 0,
      outcome: result.failure || 'downloaded',
      file: result.candidate?.file || '',
      error: result.error || '',
    })),
  };
}
