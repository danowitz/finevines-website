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
  const downloaded = await mapLimit(items.slice(0, 10), concurrency, async (item, index) => {
    try {
      const response = await fetchImpl(item.url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      let bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 2000) return null;
      if (!supported(bytes)) {
        if (!convert) return null;
        bytes = await convert(bytes);
        if (!bytes || bytes.length < 2000) return null;
      }
      const file = join(directory, `candidate-${String(index + 1).padStart(2, '0')}.png`);
      await writeFileImpl(file, bytes);
      return { ...item, id: `candidate-${index + 1}`, file };
    } catch {
      return null;
    }
  });
  return downloaded.filter(Boolean);
}
