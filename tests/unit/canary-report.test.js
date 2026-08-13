import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = resolve('tools/labelfetch/canary-report.mjs');

test('canary report packages every accepted image beside the HTML', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'finevines-canary-report-'));
  const source = join(cwd, 'data', 'fetched-images', 'example.png');
  const input = join(cwd, 'out-bottle', 'image-canary.json');
  const output = join(cwd, 'out-bottle', 'image-canary.html');
  await mkdir(dirname(source), { recursive: true });
  await mkdir(dirname(input), { recursive: true });
  await writeFile(source, Buffer.from('fixture image'));
  await writeFile(input, JSON.stringify({
    attempted: 1,
    accepted: 1,
    recovered: 1,
    labelBatches: 1,
    rows: [{
      ok: true,
      name: 'Example Wine',
      file: 'data/fetched-images/example.png',
      size: '400x800',
      matchingImages: 2,
      label: 'Example',
      page: 'https://example.com/wine',
    }],
  }));

  await execFileAsync(process.execPath, [script, input, output], { cwd });

  const html = await readFile(output, 'utf8');
  const src = html.match(/<img[^>]+src="([^"]+)"/)?.[1];
  assert.equal(src, 'image-canary-assets/example.png');
  assert.equal(
    await readFile(join(dirname(output), src), 'utf8'),
    'fixture image',
  );
});

test('canary report packages rejected candidates as clickable modal thumbnails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'finevines-canary-failures-'));
  const candidate = join(cwd, 'data', 'fetched-images', 'candidates', 'failed-wine', 'candidate-03.png');
  const input = join(cwd, 'out-bottle', 'image-canary.json');
  const output = join(cwd, 'out-bottle', 'image-canary.html');
  await mkdir(dirname(candidate), { recursive: true });
  await mkdir(dirname(input), { recursive: true });
  await writeFile(candidate, Buffer.from('rejected fixture image'));
  await writeFile(input, JSON.stringify({
    attempted: 1,
    accepted: 0,
    recovered: 0,
    labelBatches: 1,
    rows: [{
      ok: false,
      slug: 'failed-wine',
      name: 'Failed Wine',
      failureStage: 'identity-anchor',
      tried: [{ why: 'repeated designs lacked an exact readable anchor' }],
      alternates: [{
        file: 'data/fetched-images/candidates/failed-wine/candidate-03.png',
        image: 'https://images.example.com/candidate-03.png',
        page: 'https://example.com/failed-wine',
        size: '600x900',
        why: 'visible vintage 2021; catalog vintage 2022',
        strongestGroup: true,
        anchor: false,
        explicitConflict: true,
      }],
    }],
  }));

  await execFileAsync(process.execPath, [script, input, output], { cwd });

  const html = await readFile(output, 'utf8');
  assert.match(html, /class="candidate-open"/);
  assert.match(html, /data-modal-src="image-canary-assets\/failed-wine\/candidate-03\.png"/);
  assert.match(html, /visible vintage 2021; catalog vintage 2022/);
  assert.match(html, /<dialog id="image-modal"/);
  assert.match(html, /modal\.showModal\(\)/);
  assert.equal(
    await readFile(join(dirname(output), 'image-canary-assets', 'failed-wine', 'candidate-03.png'), 'utf8'),
    'rejected fixture image',
  );
});
