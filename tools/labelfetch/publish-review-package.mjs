import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBunnyStorage } from '../../edge/review-console/bunny-storage.mjs';
import { envOrFile } from './env.mjs';
import { publishReviewPackage } from './review-package.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (name, fallback = '') => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const environment = value('environment', process.env.FINEVINES_REVIEW_ENVIRONMENT || 'production');
const draftPath = value('draft', '.run/review-draft.json');
const [endpoint, zone, key] = await Promise.all([
  envOrFile('FINEVINES_REVIEW_STORAGE_ENDPOINT'), envOrFile('FINEVINES_REVIEW_STORAGE_ZONE'), envOrFile('FINEVINES_REVIEW_STORAGE_KEY'),
]);
const storage = createBunnyStorage({ endpoint, zone, key });
const [{ stdout }, catalog, draft] = await Promise.all([
  exec('git', ['rev-parse', 'HEAD']),
  readFile('data/wines.json', 'utf8').then(JSON.parse),
  readFile(draftPath, 'utf8').then(JSON.parse),
]);
const result = await publishReviewPackage({
  environment, catalogCommit: stdout.trim(), catalog, draft, storage,
  readBytes: (path) => readFile(path),
});
console.log(result.published
  ? `review package ${result.packageId}: ${result.wines} wine(s), ${result.added} new, ${result.carried} carried forward`
  : `review package unchanged: ${result.packageId || 'nothing pending'}`);
