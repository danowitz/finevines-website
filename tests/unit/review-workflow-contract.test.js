import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('hosted review workflow contract', () => {
  it('orders production acknowledgement after deploy and commit and never uses the retired shared queue', async () => {
    const workflow = await readFile('.github/workflows/pipeline.yml', 'utf8');
    const apply = workflow.indexOf('Prepare hosted review actions');
    const deploy = workflow.indexOf('- name: Deploy');
    const commit = workflow.indexOf("Commit the run's state back to master");
    const publish = workflow.indexOf('Publish the hosted review package');
    const finalize = workflow.indexOf('Finalize hosted review receipts');
    assert.ok(apply > 0 && apply < deploy && deploy < commit && commit < publish && publish < finalize);
    assert.doesNotMatch(workflow, /finevines applyqueue|_review\/queue\.json/);
    assert.match(workflow, /github\.event_name != 'repository_dispatch'/);
  });

  it('makes test clicks automatic but records validation rather than claiming a live deployment', async () => {
    const workflow = await readFile('.github/workflows/review-console-test-action.yml', 'utf8');
    assert.match(workflow, /repository_dispatch/);
    assert.match(workflow, /reviewapply -environment test/);
    assert.match(workflow, /-prepared-status validated -target validation-only/);
  });

  it('keeps console deployment gated until its Bunny infrastructure is configured', async () => {
    const workflow = await readFile('.github/workflows/review-console.yml', 'utf8');
    assert.match(workflow, /FINEVINES_REVIEW_AUTO_DEPLOY == 'true'/);
    assert.match(workflow, /environment: review-production/);
    assert.match(workflow, /BunnyWay\/actions\/deploy-script@0cae4ba05838d2707b3d5ed779f15c6bc2b43267/);
  });
});
