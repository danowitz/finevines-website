import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'finevines-domain-'));
  await mkdir(join(cwd, 'data'), { recursive: true });
  await writeFile(join(cwd, 'data', 'wines.json'), JSON.stringify([{
    slug: 'example-wine-2024',
    name: 'Example Wine',
    imagePath: 'assets/img/wines/example-wine-2024.svg',
  }]));
  await writeFile(join(cwd, 'data', 'image-funnel.json'), '{}');
  return cwd;
}

function run(cwd, script, args = [], env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.FINEVINES_SITE_BASE_URL;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [resolve(repo, script), ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

describe('standalone report site URLs', () => {
  it('defaults generated catalog and image-report URLs to finevines.com', async () => {
    const cwd = await fixture();
    run(cwd, 'tools/catalogexport/main.mjs');
    run(cwd, 'tools/labelfetch/outstanding-report.mjs');

    const catalog = await readFile(join(cwd, 'out-bottle', 'catalog-review.csv'), 'utf8');
    const report = await readFile(join(cwd, 'out-bottle', 'outstanding-images.html'), 'utf8');
    assert.match(catalog, /https:\/\/finevines\.com\/wines\/example-wine-2024\//);
    assert.match(report, /https:\/\/finevines\.com\/assets\/img\/wines\/example-wine-2024\.svg/);
    assert.doesNotMatch(catalog + report, /finevines\.biz/);
  });

  it('honors an explicit staging base URL without retaining a path', async () => {
    const cwd = await fixture();
    const env = { FINEVINES_SITE_BASE_URL: 'https://staging.example.test/release/' };
    run(cwd, 'tools/catalogexport/main.mjs', [], env);
    run(cwd, 'tools/labelfetch/outstanding-report.mjs', [], env);

    const catalog = await readFile(join(cwd, 'out-bottle', 'catalog-review.csv'), 'utf8');
    const report = await readFile(join(cwd, 'out-bottle', 'outstanding-images.html'), 'utf8');
    assert.match(catalog, /https:\/\/staging\.example\.test\/wines\/example-wine-2024\//);
    assert.match(report, /https:\/\/staging\.example\.test\/assets\/img\/wines\/example-wine-2024\.svg/);
    assert.doesNotMatch(catalog + report, /\/release\//);
  });
});
