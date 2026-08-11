// Promote unresolved candidates only when two independent permitted sources
// show the same bottle and both source URLs identify the requested product.
// Dry-run by default; pass --apply to update the staging manifest.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { binPath } from './env.mjs';
import { chooseTwoSourceApproval, eligibleTwoSourceCandidate } from './two-source-approval.mjs';

const run = promisify(execFile);
const apply = process.argv.includes('--apply');
const manifestPath = 'data/fetched-images/manifest.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
let approved = 0;
let hashFailures = 0;
const approvals = [];

for (const record of Object.values(manifest)) {
  if (record.ok) continue;
  const candidates = (record.alternates || []).filter(eligibleTwoSourceCandidate);
  if (candidates.length < 2) continue;

  let pairs;
  try {
    const { stdout } = await run(binPath('imghash'), candidates.map((candidate) => candidate.file));
    pairs = JSON.parse(stdout).pairs || [];
  } catch (error) {
    hashFailures++;
    console.error(`  ERROR  ${record.name}\n         perceptual hash failed: ${String(error?.message || error).split('\n')[0]}`);
    continue;
  }
  const approval = chooseTwoSourceApproval(record, candidates, pairs);
  if (!approval) continue;

  approved++;
  approvals.push({ record, approval });
  const pick = approval.pick;
  console.log(`  AGREE  ${record.name}\n         ${approval.hosts.join(' + ')}\n         -> ${pick.file} (${pick.size})`);
}

if (hashFailures) {
  console.error(`\nrefusing to apply: perceptual hashing failed for ${hashFailures} record(s)`);
  process.exit(2);
}

if (apply) for (const { record, approval } of approvals) {
  const pick = approval.pick;

  const destination = join('data/fetched-images', `${record.slug}.png`);
  await copyFile(pick.file, destination);
  record.ok = true;
  record.file = destination;
  record.page = pick.page;
  record.image = pick.image;
  record.size = pick.size;
  record.label = pick.label || '';
  record.verifiedBy = 'two-source visual consensus + source identity rules';
  record.selectionIdentityVerified = true;
  record.matchingImages = approval.matchingImages;
  record.sourceConsensusHosts = approval.hosts;
  record.review = [];
  delete record.failureStage;
  delete record.watermark;
  delete record.watermarkSwept;
  delete record.watermarkSweptBy;
  delete record.watermarkSweepError;
  if (record.funnel) record.funnel.outcome = 'accepted';
}

if (apply) await writeFile(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`\n${approved} two-source approval${approved === 1 ? '' : 's'}${apply ? ' staged' : ' (dry run)'}.`);
