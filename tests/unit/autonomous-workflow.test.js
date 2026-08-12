import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomousImageWorkflow, ImageWorkflowStageError } from '../../tools/labelfetch/autonomous-workflow.mjs';

const config = {
  canary: false,
  winesPerRun: 25,
  budgetMinutes: 30,
  manifestPath: 'manifest.json',
};

function harness({ manifest = true, fail = '' } = {}) {
  const calls = [];
  const reports = [];
  return {
    calls,
    reports,
    adapters: {
      preflight: async () => {
        calls.push('preflight');
        if (fail === 'preflight') throw new Error('Google unavailable');
      },
      runStage: async (name, args) => {
        calls.push([name, args]);
        if (fail === name) throw new Error(`${name} broke`);
      },
      exists: async () => manifest,
      persist: async (report) => reports.push(report),
      now: () => '2026-08-11T00:00:00.000Z',
    },
  };
}

test('owns the complete safe production order behind one interface', async () => {
  const h = harness();
  const result = await runAutonomousImageWorkflow(config, h.adapters);
  assert.deepEqual(h.calls, [
    'preflight',
    ['pipeline', ['--n', '25', '--budget-minutes', '30', '--missing', '--due-only']],
    ['auto-approve', ['--apply']],
    ['watermark-sweep', ['--apply']],
    ['import', ['--apply', '--clean-only']],
    ['review', []],
  ]);
  assert.equal(result.outcome, 'completed');
  assert.equal(h.reports.at(-1).outcome, 'completed');
});

test('a Google health failure stops before search and leaves a failed receipt', async () => {
  const h = harness({ fail: 'preflight' });
  await assert.rejects(
    runAutonomousImageWorkflow(config, h.adapters),
    (error) => error instanceof ImageWorkflowStageError && error.stage === 'preflight',
  );
  assert.deepEqual(h.calls, ['preflight']);
  assert.equal(h.reports.at(-1).outcome, 'failed');
});

test('a fetch failure cannot fall through into approval or publication', async () => {
  const h = harness({ fail: 'pipeline' });
  await assert.rejects(runAutonomousImageWorkflow(config, h.adapters), /fetch-and-verify/);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), ['preflight', 'pipeline']);
});

test('a converged run with no manifest is a successful no-op', async () => {
  const h = harness({ manifest: false });
  const result = await runAutonomousImageWorkflow(config, h.adapters);
  assert.equal(result.outcome, 'nothing-due');
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), ['preflight', 'pipeline']);
});

test('canary mode cannot approve, sweep, or import', async () => {
  const h = harness();
  const result = await runAutonomousImageWorkflow({ ...config, canary: true }, h.adapters);
  assert.equal(result.outcome, 'canary-complete');
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'preflight', 'pipeline', 'canary-report',
  ]);
  assert.ok(h.calls[1][1].includes('--canary'));
});

test('recovery canary retries recorded misses without waiting for backoff', async () => {
  const h = harness();
  await runAutonomousImageWorkflow({ ...config, canary: true, retryMisses: true }, h.adapters);
  assert.deepEqual(h.calls[1], ['pipeline', [
    '--n', '25', '--budget-minutes', '30', '--missing', '--retry-misses', '--canary',
  ]]);
});

test('production recovery retries recorded misses and keeps every import gate', async () => {
  const h = harness();
  const result = await runAutonomousImageWorkflow({ ...config, retryMisses: true }, h.adapters);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(h.calls, [
    'preflight',
    ['pipeline', ['--n', '25', '--budget-minutes', '30', '--missing', '--retry-misses']],
    ['auto-approve', ['--apply']],
    ['watermark-sweep', ['--apply']],
    ['import', ['--apply', '--clean-only']],
    ['review', []],
  ]);
});

test('targeted canary can retain a full trace while bypassing catalog reuse', async () => {
  const h = harness();
  await runAutonomousImageWorkflow({
    ...config,
    canary: true,
    retryMisses: true,
    slug: 'anne-patent-epenots-2018',
    trace: true,
    noCatalogReuse: true,
  }, h.adapters);
  assert.deepEqual(h.calls[1], ['pipeline', [
    '--n', '25', '--budget-minutes', '30', '--missing', '--retry-misses', '--canary',
    '--slug', 'anne-patent-epenots-2018', '--trace', '--no-catalog-reuse',
  ]]);
});
