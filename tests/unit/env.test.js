import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binPath, openaiKey, envOrFile } from '../../tools/labelfetch/env.mjs';

describe('locating the Go helper binaries', () => {
  test('Windows keeps the .exe name it has always used', () => {
    assert.equal(binPath('imgcheck', 'win32', {}), 'imgcheck.exe');
    assert.equal(binPath('imgnorm', 'win32', {}), 'imgnorm.exe');
  });

  test('Linux gets an explicit ./ prefix', () => {
    // Bare "imgcheck" would not resolve: unlike cmd.exe, a POSIX shell does not
    // search the working directory, so execFile('imgcheck') is ENOENT even with
    // the binary sitting right there.
    assert.equal(binPath('imgcheck', 'linux', {}), './imgcheck');
    assert.equal(binPath('imgnorm', 'darwin', {}), './imgnorm');
  });

  test('an env override wins outright', () => {
    assert.equal(
      binPath('imgcheck', 'linux', { FINEVINES_IMGCHECK_BIN: '/opt/bin/imgcheck' }),
      '/opt/bin/imgcheck'
    );
  });
});

describe('finding the OpenAI key', () => {
  test('the real environment variable wins', async () => {
    assert.equal(await openaiKey({ OPENAI_API_KEY: 'sk-from-env' }, '/nonexistent'), 'sk-from-env');
  });

  test('falls back to .env so a workstation keeps working unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'FINEVINES_GA_ID=G-X\nOPENAI_API_KEY=sk-from-file\n');
    assert.equal(await openaiKey({}, path), 'sk-from-file');
  });

  test('no key anywhere is an empty string, not a throw', async () => {
    // The caller decides whether a missing key is fatal — the fetch pipeline
    // runs without vision at a lower recovery rate, the watermark sweep cannot.
    assert.equal(await openaiKey({}, '/nonexistent'), '');
  });

  test('surrounding whitespace is trimmed from both sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'OPENAI_API_KEY=  sk-padded  \n');
    assert.equal(await openaiKey({}, path), 'sk-padded');
    assert.equal(await openaiKey({ OPENAI_API_KEY: ' sk-padded ' }, path), 'sk-padded');
  });
});

describe('envOrFile — the general form behind openaiKey and search-provider keys', () => {
  test('the real environment variable wins', async () => {
    assert.equal(
      await envOrFile('FINEVINES_BRAVE_SEARCH_KEY', { FINEVINES_BRAVE_SEARCH_KEY: 'from-env' }, '/nonexistent'),
      'from-env'
    );
  });

  test('falls back to the same key inside .env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'FINEVINES_BRAVE_SEARCH_KEY=from-file\nFINEVINES_SERPER_KEY=serper-from-file\n');
    assert.equal(await envOrFile('FINEVINES_BRAVE_SEARCH_KEY', {}, path), 'from-file');
    assert.equal(await envOrFile('FINEVINES_SERPER_KEY', {}, path), 'serper-from-file');
  });

  test('neither the environment nor .env having it — nor .env existing at all — is an empty string, not a throw', async () => {
    // This is the exact crash this function replaces: pipeline.mjs used to
    // read .env directly and unconditionally for these two keys, so on
    // ubuntu-latest — no .env file — it threw ENOENT and took the whole
    // script down before a single wine was selected.
    assert.equal(await envOrFile('FINEVINES_BRAVE_SEARCH_KEY', {}, '/nonexistent'), '');
  });
});
