import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('production pipeline failure alerts', () => {
  it('runs after a failed pipeline and targets the operations mailbox', async () => {
    const workflow = await readFile('.github/workflows/pipeline.yml', 'utf8');

    assert.match(workflow, /alert-on-failure:\r?\n\s+needs: run/);
    assert.match(workflow, /if: \$\{\{ always\(\) && needs\.run\.result == 'failure' \}\}/);
    assert.match(workflow, /name: Send a production failure alert/);
    assert.match(workflow, /FINEVINES_FAILURE_NOTIFY_TO: joel@gritautomation\.com/);
    assert.match(workflow, /python tools\/pipeline\/notify_failure\.py/);
  });

  it('renders an actionable alert without contacting the relay in dry-run mode', () => {
    const result = spawnSync('python', ['tools/pipeline/notify_failure.py', '--dry-run'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FINEVINES_NOTIFY_FROM: 'FineVines Pipeline <catalog@finevines.com>',
        FINEVINES_FAILURE_NOTIFY_TO: 'joel@gritautomation.com',
        GITHUB_REPOSITORY: 'danowitz/finevines-website',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_SHA: '0123456789abcdef',
        GITHUB_REF_NAME: 'master',
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_WORKFLOW: 'pipeline',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^To: joel@gritautomation\.com$/m);
    assert.match(result.stdout, /^Subject: \[FineVines\] Production pipeline failed \(run 12345, attempt 2\)$/m);
    assert.match(result.stdout, /https:\/\/github\.com\/danowitz\/finevines-website\/actions\/runs\/12345/);
    assert.match(result.stdout, /Commit: 0123456789abcdef/);
    assert.match(result.stdout, /Branch: master/);
  });
});
