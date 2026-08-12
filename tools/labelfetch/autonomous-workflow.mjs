// One interface owns the unattended image workflow and its ordering invariants.
// External processes and persistence are adapters so tests exercise the same
// seam as the production CLI without touching Google, OpenAI, or the catalog.

export class ImageWorkflowStageError extends Error {
  constructor(stage, cause) {
    super(`${stage}: ${String(cause?.message || cause)}`);
    this.name = 'ImageWorkflowStageError';
    this.stage = stage;
    this.cause = cause;
  }
}

export async function runAutonomousImageWorkflow(config, adapters) {
  const {
    preflight,
    runStage,
    exists,
    persist,
    now = () => new Date().toISOString(),
  } = adapters;
  const report = {
    version: 1,
    mode: config.canary ? 'canary' : 'apply',
    startedAt: now(),
    completedAt: '',
    outcome: 'running',
    stages: [],
  };

  const save = () => persist(structuredClone(report));
  const stage = async (name, work) => {
    const entry = { name, status: 'running', startedAt: now(), completedAt: '', error: '' };
    report.stages.push(entry);
    await save();
    try {
      await work();
      entry.status = 'completed';
      entry.completedAt = now();
      await save();
    } catch (error) {
      entry.status = 'failed';
      entry.completedAt = now();
      entry.error = String(error?.message || error).split('\n')[0];
      report.outcome = 'failed';
      report.completedAt = now();
      await save();
      throw new ImageWorkflowStageError(name, error);
    }
  };

  await stage('preflight', preflight);
  const pipelineArgs = [
    '--n', String(config.winesPerRun),
    '--budget-minutes', String(config.budgetMinutes),
    '--missing',
    ...(config.retryMisses ? ['--retry-misses'] : ['--due-only']),
    ...(config.canary ? ['--canary'] : []),
  ];
  await stage('fetch-and-verify', () => runStage('pipeline', pipelineArgs));

  if (config.canary) {
    await stage('render-canary', () => runStage('canary-report', []));
    report.outcome = 'canary-complete';
    report.completedAt = now();
    await save();
    return report;
  }

  if (!(await exists(config.manifestPath))) {
    report.outcome = 'nothing-due';
    report.completedAt = now();
    await save();
    return report;
  }

  await stage('auto-approve-two-sources', () => runStage('auto-approve', ['--apply']));
  await stage('watermark-gate', () => runStage('watermark-sweep', ['--apply']));
  await stage('import', () => runStage('import', ['--apply', '--clean-only']));
  await stage('build-exception-review', () => runStage('review', []));

  report.outcome = 'completed';
  report.completedAt = now();
  await save();
  return report;
}
