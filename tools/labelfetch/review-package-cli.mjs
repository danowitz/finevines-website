import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { buildReviewDraft } from './review-package.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const output = value('out', '.run/review-draft.json');
const catalog = JSON.parse(await readFile('data/wines.json', 'utf8'));
const manifest = JSON.parse(await readFile('data/fetched-images/manifest.json', 'utf8'));
const draft = await buildReviewDraft({
  catalog, manifest,
  fileExists: (path) => access(path).then(() => true, () => false),
  readBytes: (path) => readFile(path),
});
const { stdout } = await exec('git', ['rev-parse', 'HEAD']);
draft.sourceCommit = stdout.trim();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(draft, null, 2) + '\n');
console.log(`${draft.wines.length} wine(s) written to ${output}`);
