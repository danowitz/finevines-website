// Unit tests for the decision-to-action logic behind applyreview.mjs, plus an
// integration check that the CLI itself is a genuine no-op without --apply —
// the property the task exists to guarantee, since a review tool that writes
// on a bare `node applyreview.mjs decisions.json` would be too dangerous to
// run casually.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planActions } from '../../tools/oldsiteharvest/applyreviewplan.mjs';

const wines = () => [
  { sku: '1', slug: 'dom-x-cuvee-a-2020', producer: 'Dom X', name: 'Cuvee A', imagePath: 'assets/img/wines/dom-x-cuvee-a-2020.svg', imageSource: 'generated-label' },
  { sku: '2', slug: 'dom-y-cuvee-b-2019', producer: 'Dom Y', name: 'Cuvee B', imagePath: 'assets/img/wines/dom-y-cuvee-b-2019.jpg', imageSource: 'scraped-web' },
];

describe('planActions', () => {
  test('choosing the old-site image plans a copy for a rescue', () => {
    const decisions = [{ sku: '1', choice: 'old', file: 'a.jpg', sourceUrl: 'https://www.finevines.com/a.jpg' }];
    const [plan] = planActions(decisions, wines());
    assert.equal(plan.action, 'copy');
    assert.equal(plan.destPath, 'assets/img/wines/dom-x-cuvee-a-2020.jpg');
    assert.equal(plan.sourceFile, 'a.jpg');
  });

  test('a decision of "neither" changes nothing', () => {
    const decisions = [{ sku: '1', choice: 'neither' }];
    const [plan] = planActions(decisions, wines());
    assert.equal(plan.action, 'skip');
  });

  test('keeping the current image changes nothing', () => {
    const decisions = [{ sku: '2', choice: 'current' }];
    const [plan] = planActions(decisions, wines());
    assert.equal(plan.action, 'skip');
  });

  test('a SKU no longer in the catalog is skipped, not thrown', () => {
    const decisions = [{ sku: '999', choice: 'old', file: 'a.jpg' }];
    const [plan] = planActions(decisions, wines());
    assert.equal(plan.action, 'skip');
    assert.match(plan.reason, /no such wine/);
  });

  test('choosing "old" with no file recorded is refused rather than guessed at', () => {
    const decisions = [{ sku: '1', choice: 'old' }];
    const [plan] = planActions(decisions, wines());
    assert.equal(plan.action, 'skip');
    assert.match(plan.reason, /no old-site file/);
  });
});

describe('applyreview.mjs CLI', () => {
  function scaffold() {
    const root = mkdtempSync(join(tmpdir(), 'applyreview-'));
    mkdirSync(join(root, 'data', 'oldsite-mirror'), { recursive: true });
    mkdirSync(join(root, 'assets', 'img', 'wines'), { recursive: true });
    writeFileSync(join(root, 'data', 'wines.json'), JSON.stringify(wines(), null, 1));
    writeFileSync(join(root, 'data', 'oldsite-mirror', 'a.jpg'), 'fake-jpeg-bytes');
    writeFileSync(
      join(root, 'decisions.json'),
      JSON.stringify([{ sku: '1', choice: 'old', file: 'a.jpg', sourceUrl: 'https://www.finevines.com/a.jpg' }])
    );
    cpSync(join(process.cwd(), 'tools', 'oldsiteharvest'), join(root, 'tools', 'oldsiteharvest'), { recursive: true });
    // applyreview.mjs imports binPath from tools/labelfetch/env.mjs.
    mkdirSync(join(root, 'tools', 'labelfetch'), { recursive: true });
    cpSync(join(process.cwd(), 'tools', 'labelfetch', 'env.mjs'), join(root, 'tools', 'labelfetch', 'env.mjs'));
    return root;
  }

  test('a dry run (no --apply) writes nothing', (t) => {
    const root = scaffold();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const before = readFileSync(join(root, 'data', 'wines.json'), 'utf8');
    execFileSync('node', ['tools/oldsiteharvest/applyreview.mjs', 'decisions.json'], { cwd: root, encoding: 'utf8' });
    const after = readFileSync(join(root, 'data', 'wines.json'), 'utf8');

    assert.equal(after, before);
    assert.equal(existsSync(join(root, 'assets', 'img', 'wines', 'dom-x-cuvee-a-2020.jpg')), false);
  });

  test('a decision of "neither" changes nothing even with --apply', (t) => {
    const root = scaffold();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    writeFileSync(join(root, 'decisions.json'), JSON.stringify([{ sku: '1', choice: 'neither' }]));
    const before = readFileSync(join(root, 'data', 'wines.json'), 'utf8');
    execFileSync('node', ['tools/oldsiteharvest/applyreview.mjs', 'decisions.json', '--apply'], { cwd: root, encoding: 'utf8' });
    const after = readFileSync(join(root, 'data', 'wines.json'), 'utf8');

    assert.equal(after, before);
  });
});
