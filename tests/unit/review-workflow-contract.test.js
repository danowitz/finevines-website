import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('hosted review workflow contract', () => {
  it('uses one bounded processor for immediate, scheduled, manual, and continuation runs', async () => {
    const workflow = await readFile('.github/workflows/review-actions.yml', 'utf8');
    assert.match(workflow, /repository_dispatch:/);
    assert.match(workflow, /types: \[review-console, review-console-continue, review-recovery, review-console-preflight\]/);
    assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /group: finevines-catalog-deploy/);
    assert.match(workflow, /timeout-minutes: 60/);
    assert.match(workflow, /timeout[^\n]*16m[^\n]*max-prepare-duration 15m/);
    assert.match(workflow, /timeout[^\n]*3m \.\/finevines build -launch-exclusions \.run\/launch-exclusions\.json/);
    assert.match(workflow, /timeout[^\n]*7m \.\/finevines deploy/);
    assert.match(workflow, /timeout[^\n]*3m bash tools\/pipeline\/commitback\.sh/);
    assert.match(workflow, /timeout[^\n]*3m \.\/finevines reviewfinalize/);
    assert.match(workflow, /timeout[^\n]*2m node tools\/review-console\/queue\.mjs reconcile/);
    assert.match(workflow, /timeout[^\n]*2m node tools\/review-console\/queue\.mjs release/);
    assert.match(workflow, /always\(\) && \(failure\(\) \|\| cancelled\(\)\)/);
    assert.equal(workflow.match(/node tools\/review-console\/queue\.mjs claim/g)?.length, 1);
    assert.match(workflow, /reviewapply -environment test[^\n]*-action-ids \.run\/review-claims\.json/);
    assert.match(workflow, /review-console-continue/);
    assert.equal(workflow.match(/node tools\/review-console\/dispatch\.mjs/g)?.length, 3);
    assert.match(workflow, /queue\.mjs reconcile/);
    assert.match(workflow, /queue\.mjs complete/);
    assert.match(workflow, /queue\.mjs export-launch-exclusions/);
    assert.match(workflow, /\.\/finevines reviewers > \.run\/salesforce-reviewers\.json/);
    assert.match(workflow, /sync-accounts --environment test --roster \.run\/salesforce-reviewers\.json/);
    assert.match(workflow, /Synchronize eligible reviewer accounts\r?\n\s+id: reviewer_sync\r?\n\s+continue-on-error: true/);
    assert.match(workflow, /invite_reviewer != '' && steps\.reviewer_sync\.outcome == 'success'/);
    assert.doesNotMatch(workflow, /sync-accounts --environment test --roster data\/team\.json/);
  });

  it('keeps application and targeted rediscovery in one review workflow without catalog auto-import', async () => {
    const pipeline = await readFile('.github/workflows/pipeline.yml', 'utf8');
    const review = await readFile('.github/workflows/review-actions.yml', 'utf8');
    assert.doesNotMatch(pipeline, /types: \[review-recovery\]|export-recovery|resolve-recovery/);
    assert.doesNotMatch(pipeline, /reviewapply|reviewfinalize|Prepare hosted review actions|Finalize hosted review receipts/);
    assert.match(pipeline, /export-launch-exclusions[^\n]*\.run\/launch-exclusions\.json/);
    assert.match(pipeline, /finevines build -launch-exclusions \.run\/launch-exclusions\.json/);
    assert.match(review, /export-recovery/);
    assert.match(review, /resolve-recovery/);
    assert.match(review, /Publish only the new review evidence/);
    await assert.rejects(readFile('.github/workflows/review-console-test-action.yml', 'utf8'), { code: 'ENOENT' });
  });

  it('keeps console deployment gated until its Bunny infrastructure is configured', async () => {
    const workflow = await readFile('.github/workflows/review-console.yml', 'utf8');
    const provision = await readFile('.github/workflows/review-console-provision.yml', 'utf8');
    assert.match(workflow, /FINEVINES_REVIEW_AUTO_DEPLOY == 'true'/);
    assert.match(workflow, /environment: review-production/);
    assert.match(workflow, /BunnyWay\/actions\/deploy-script@0cae4ba05838d2707b3d5ed779f15c6bc2b43267/);
    assert.match(workflow, /expected exactly one test Edge Script/);
    assert.match(workflow, /expected exactly one production Edge Script/);
    assert.match(workflow, /\.Items\[\]/);
    assert.match(workflow, /api_key: \$\{\{ secrets\.FINEVINES_BUNNY_API_KEY \}\}/);
    assert.doesNotMatch(workflow, /deploy_key:/);
    assert.match(provision, /node tools\/review-console\/provision\.mjs/);
    assert.match(provision, /node tools\/review-console\/preflight\.mjs/);
    assert.match(provision, /environment: review-production/);
    const provisioner = await readFile('tools/review-console/provision.mjs', 'utf8');
    assert.match(provisioner, /bunny\('\/compute\/script'\)\)\.Items/);
    assert.match(provisioner, /bunny\('\/dnszone'\)\)\.Items/);
    assert.match(provisioner, /DisableCookies: false/);
    assert.match(provisioner, /CacheControlMaxAgeOverride: -1/);
    assert.match(provisioner, /CacheControlPublicMaxAgeOverride: -1/);
    assert.match(provisioner, /EnableRequestCoalescing: false/);
    assert.match(provisioner, /BUNNY_DATABASE_URL/);
    assert.match(provisioner, /BUNNY_DATABASE_AUTH_TOKEN/);
  });
});
