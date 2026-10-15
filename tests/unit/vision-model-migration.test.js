import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBoundedLabelReader } from '../../tools/labelfetch/bottle-selector-runtime.mjs';
import { visionModelOptions } from '../../tools/labelfetch/vision-model.mjs';

const exec = promisify(execFile);
const scriptPath = (script) => fileURLToPath(new URL(`../../tools/labelfetch/${script}.mjs`, import.meta.url));

// Execute the real CLI in a disposable catalog. No real credentials are inherited,
// and every fetch is intercepted before the entrypoint is imported.
async function fixture(t, { status = 200, verdict = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'finevines-vision-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'data/fetched-images'), { recursive: true });
  await writeFile(join(cwd, 'bottle.png'), 'test pixels');
  await writeFile(join(cwd, 'data/wines.json'), JSON.stringify([
    { slug: 'test-wine', sku: '123', name: 'Test Wine', producer: 'Test', vintage: '2022' },
  ]));
  const preload = join(cwd, 'intercept.mjs');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.openai.com/v1/chat/completions') throw new Error('unexpected request');
      appendFileSync('requests.jsonl', JSON.stringify(JSON.parse(options.body)) + '\\n');
      return { ok: ${status === 200}, status: ${status}, json: async () => ({
        choices: [{ message: { content: ${JSON.stringify(JSON.stringify(verdict))} } }],
      }) };
    };
  `);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP || tmpdir(),
    TMP: process.env.TMP || tmpdir(),
    OPENAI_API_KEY: 'test-only-no-real-key',
  };
  return {
    cwd,
    env,
    manifest: async (value) => writeFile(join(cwd, 'data/fetched-images/manifest.json'), JSON.stringify(value)),
    run: (script, args = [], overrides = {}) => exec(process.execPath, ['--import', pathToFileURL(preload).href, scriptPath(script), ...args], {
      cwd, env: { ...env, ...overrides }, timeout: 15_000,
    }),
    readManifest: async () => JSON.parse(await readFile(join(cwd, 'data/fetched-images/manifest.json'), 'utf8')),
    requests: async () => (await readFile(join(cwd, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

for (const [name, status, verdict] of [
  ['clean', 200, { watermark: false, mark: '' }],
  ['marked', 200, { watermark: true, mark: 'Vivino' }],
  ['retired model error', 404, {}],
  ['malformed verdict', 200, {}],
]) {
  test(`watermark CLI uses Luna and preserves ${name} handling`, async (t) => {
    const f = await fixture(t, { status, verdict });
    await f.manifest({ test: { slug: 'test-wine', ok: true, file: 'bottle.png', selectionIdentityVerified: true } });
    await f.run('watermarksweep', ['--apply']);
    const [request] = await f.requests();
    assert.equal(request.model, 'gpt-5.6-luna');
    assert.equal(request.reasoning_effort, 'none');
    assert.equal(request.max_completion_tokens, 100);
    assert.equal(request.messages[0].content.find((c) => c.type === 'image_url').image_url.detail, 'high');
    const { test: record } = await f.readManifest();
    if (name === 'clean') {
      assert.equal(record.watermarkSwept, true);
      assert.equal(record.watermark, undefined);
    } else if (name === 'marked') {
      assert.equal(record.watermarkSwept, true);
      assert.equal(record.watermark, 'Vivino');
    } else {
      assert.notEqual(record.watermarkSwept, true);
      assert.match(record.watermarkSweepError, name === 'retired model error' ? /HTTP 404/ : /unparseable verdict/);
    }
  });
}

for (const [name, status, verdict, expected] of [
  ['bottle', 200, { single_bottle_product_photo: true }, true],
  ['collage', 200, { single_bottle_product_photo: false }, false],
  ['API error', 404, {}, undefined],
]) {
  test(`review CLI uses Luna and preserves ${name} display handling`, async (t) => {
    const f = await fixture(t, { status, verdict });
    await f.manifest({ test: { slug: 'test-wine', name: 'Test Wine', ok: false, alternates: [
      { file: 'bottle.png', subjectOk: true, page: 'https://example.com/wine' },
    ] } });
    const { stdout } = await f.run('review');
    const [request] = await f.requests();
    assert.equal(request.model, 'gpt-5.6-luna');
    assert.equal(request.reasoning_effort, 'none');
    assert.equal(request.max_completion_tokens, 30);
    assert.equal((await f.readManifest()).test.alternates[0].displayOk, expected);
    assert.match(stdout, expected === false ? /0 found nothing but have candidates/ : /1 found nothing but have candidates/);
  });
}

test('label CLI preserves CLI > environment > Luna precedence without making requests', async (t) => {
  const f = await fixture(t);
  const verifier = join(f.cwd, 'unused-verifier');
  await writeFile(verifier, 'not executed');
  await writeFile(join(f.cwd, 'previous.json'), JSON.stringify({ rows: [] }));
  const env = { FINEVINES_IMGCHECK_BIN: verifier };
  // An empty replay exits before search/vision but records the effective model.
  for (const [args, overrides, model, effort] of [
    [[], {}, 'gpt-5.6-luna', 'none'],
    [[], { FINEVINES_LABEL_MODEL: 'gpt-4.1-mini' }, 'gpt-4.1-mini', ''],
    [['--label-model', 'gpt-5.6-luna'], { FINEVINES_LABEL_MODEL: 'gpt-4.1-mini' }, 'gpt-5.6-luna', 'none'],
  ]) {
    await f.run('pipeline', ['--canary', '--exclude-passed-report', 'previous.json', ...args], { ...env, ...overrides });
    const report = JSON.parse(await readFile(join(f.cwd, 'out-bottle/image-canary.json'), 'utf8'));
    assert.equal(report.labelModel, model);
    assert.equal(report.labelReasoningEffort, effort);
  }
  await assert.rejects(readFile(join(f.cwd, 'requests.jsonl')), { code: 'ENOENT' });
});

test('mini rollback omits reasoning parameters and keeps the bounded vision request', async () => {
  // Watermark and review callers use this same shared request policy.
  assert.deepEqual(visionModelOptions('gpt-4.1-mini'), { model: 'gpt-4.1-mini' });
  let body;
  const reader = createBoundedLabelReader({
    apiKey: 'test-only', model: 'gpt-4.1-mini',
    readFileImpl: async () => Buffer.from('test pixels'),
    verifyIdentity: async () => ({ accept: false }),
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[]' } }] }) };
    },
  });
  await reader({ name: 'Test Wine' }, [{ id: 'one', file: 'bottle.png' }]);
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  assert.equal(body.max_completion_tokens, 1200);
  assert.equal(body.response_format.json_schema.strict, true);
});

test('manual comparison defaults use Luna with reasoning disabled', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/brave-image-canary.yml', import.meta.url), 'utf8');
  assert.match(workflow, /label_model:[\s\S]*?default: 'gpt-5\.6-luna'/);
  assert.match(workflow, /label_reasoning_effort:[\s\S]*?default: 'none'/);
  assert.doesNotMatch(workflow, /gpt-4\.1-nano/);
});
