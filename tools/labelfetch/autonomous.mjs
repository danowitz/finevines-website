// Production adapter for the autonomous image-workflow module.
//
//   node tools/labelfetch/autonomous.mjs --apply
//   node tools/labelfetch/autonomous.mjs --canary --n 20
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { createGoogleImageDiscovery } from './google-images.mjs';
import { binPath, envOrFile, openaiKey } from './env.mjs';
import { runAutonomousImageWorkflow } from './autonomous-workflow.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const apply = has('apply');
const canary = has('canary');
const retryMisses = has('retry-misses');
if (apply === canary) {
  console.error('choose exactly one mode: --apply or --canary');
  process.exit(2);
}
const reportPath = opt('report', '.run/image-workflow.json');
// Process the complete due backlog by default. The wall-clock budget remains
// the safety valve: a run stops cleanly at two hours and commits its ledger,
// rather than artificially waiting another night after every 150 wines.
const winesPerRun = Number.parseInt(opt('n', process.env.WINES_PER_RUN || '5000'), 10);
const budgetMinutes = Number.parseFloat(opt('budget-minutes', process.env.IMAGE_BUDGET_MINUTES || '120'));
if (!Number.isInteger(winesPerRun) || winesPerRun < 1 || !Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
  console.error('--n must be a positive integer and --budget-minutes must be a positive number');
  process.exit(2);
}
const scripts = {
  pipeline: ['tools/labelfetch/pipeline.mjs'],
  'auto-approve': ['tools/labelfetch/auto-approve-two-sources.mjs'],
  'watermark-sweep': ['tools/labelfetch/watermarksweep.mjs'],
  import: ['tools/labelfetch/import.mjs'],
  review: ['tools/labelfetch/review.mjs'],
  'canary-report': ['tools/labelfetch/canary-report.mjs'],
};

async function runNodeStage(name, stageArgs) {
  const base = scripts[name];
  if (!base) throw new Error(`unknown stage ${name}`);
  console.log(`\n=== ${name} ===`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...base, ...stageArgs], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(signal ? `terminated by ${signal}` : `exited ${code}`)));
  });
}

async function preflight() {
  const [googleKey, googleCx, visionKey] = await Promise.all([
    envOrFile('FINEVINES_GOOGLE_CSE_KEY'),
    envOrFile('FINEVINES_GOOGLE_CSE_CX'),
    openaiKey(),
  ]);
  if (!googleKey || !googleCx) throw new Error('Google image credentials are missing');
  if (!visionKey) throw new Error('OPENAI_API_KEY is missing');
  for (const binary of ['imgcheck', 'imghash', 'imgnorm']) {
    try { await access(binPath(binary)); }
    catch { throw new Error(`missing ${binPath(binary)}; build tools/${binary} first`); }
  }
  await exec('python', ['-c', 'import cv2, numpy'], { timeout: 30_000 });

  // An actual image-mode request catches a disabled API, invalid CX, quota,
  // and key-restriction errors before any wine can receive a cached verdict.
  const health = await createGoogleImageDiscovery({ key: googleKey, cx: googleCx })(
    'Fine Vines wine bottle image workflow health check',
  );
  if (!health.searched) throw new Error(`Google image discovery unavailable: ${health.error}`);
  console.log(`preflight passed: Google image endpoint returned ${health.returned} result(s)`);
}

async function persist(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n');
  await rename(temporary, reportPath);
}

try {
  const report = await runAutonomousImageWorkflow({
    canary,
    winesPerRun,
    budgetMinutes,
    retryMisses,
    manifestPath: 'data/fetched-images/manifest.json',
  }, {
    preflight,
    runStage: runNodeStage,
    exists: (path) => access(path).then(() => true, () => false),
    persist,
  });
  console.log(`\nimage workflow ${report.outcome}; receipt -> ${reportPath}`);
} catch (error) {
  console.error(`\nimage workflow failed at ${error.stage || 'startup'}: ${error.message}`);
  process.exitCode = 2;
}
