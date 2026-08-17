import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('hosted review workflow contract', () => {
  it('uses one bounded processor for immediate, scheduled, manual, and continuation runs', async () => {
    const workflow = await readFile('.github/workflows/review-actions.yml', 'utf8');
    assert.match(workflow, /repository_dispatch:/);
    assert.match(workflow, /types: \[review-console, review-console-continue\]/);
    assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /group: finevines-catalog-deploy/);
    assert.match(workflow, /timeout-minutes: 45/);
    assert.equal(workflow.match(/node tools\/review-console\/queue\.mjs claim/g)?.length, 1);
    assert.match(workflow, /reviewapply -environment test[^\n]*-action-ids \.run\/review-claims\.json/);
    assert.match(workflow, /review-console-continue/);
    assert.match(workflow, /queue\.mjs reconcile/);
    assert.match(workflow, /queue\.mjs complete/);
  });

  it('keeps review processing out of the nightly catalog workflow and retires validation-only processing', async () => {
    const pipeline = await readFile('.github/workflows/pipeline.yml', 'utf8');
    assert.doesNotMatch(pipeline, /repository_dispatch|reviewapply|reviewfinalize|Prepare hosted review actions|Finalize hosted review receipts/);
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
