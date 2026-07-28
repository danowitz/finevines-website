// Browser tests for the portfolio filter rail (issue #4) — the acceptance
// criteria from docs/work-packages/2026-07-27-portfolio-filter-rail.md, driven
// against the real built dist/ in real Chrome.
//
// The rail exists because a flat, always-open list of 310 producers is not a
// control anyone can use. Everything here tests that claim: that twelve ranked
// values are on screen at rest, that the other 298 are reachable by typing,
// and that what you have selected is always visible and always removable.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { serve } from '../helpers/server.js';
import { openBrowser, openPage, MOBILE } from '../helpers/browser.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist');
const TOP_N = 12; // must match facetSeedSize (build.go) and TOP_N (portfolio.js)

let server;
let browser;

before(async () => {
  assert.ok(
    existsSync(join(DIST, 'portfolio', 'index.html')),
    'dist/ is not built — run `go run ./cmd/finevines build` first'
  );
  server = await serve(DIST);
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function hydrated(page, path) {
  await page.goto(server.origin + path, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => {
    const nav = document.querySelector('.pagination');
    return nav && (nav.hidden || nav.querySelector('a[data-page], span.is-disabled'));
  }, { timeout: 15000 });
  // The rail repaints in the same render() call as the pagination, but wait
  // for a row to carry a live count before asserting on ranking.
  await page.waitForFunction(
    () => document.querySelector('[data-facet-values="producer"] .facet-count')?.textContent,
    { timeout: 5000 }
  );
}

// rows returns [value, count] for a group, in the order they appear.
const rows = (page, facet) =>
  page.$$eval(`[data-facet-values="${facet}"] .facet-row`, (els) =>
    els.map((el) => [
      el.querySelector('.facet-label').textContent,
      parseInt(el.querySelector('.facet-count').textContent, 10),
    ])
  );

const count = (page) =>
  page.$eval('#portfolio-count', (el) => parseInt(el.textContent.replace(/[^\d]/g, ''), 10));

// groupTotal reads the header's count of values AVAILABLE under current
// filters — the number the rows are a capped view of.
const groupTotal = (page, facet) =>
  page.$eval(`[data-facet-group="${facet}"] .facet-total`, (el) => parseInt(el.textContent, 10));

const openGroups = (page) =>
  page.$$eval('[data-facet-group]', (els) =>
    els.filter((e) => e.open).map((e) => e.dataset.facetGroup)
  );

// Interacting with the rail needs care: rows are re-created on every query, so
// a handle resolved by selector can be detached before the click lands. These
// helpers wait for a VISIBLE row and then click a live ElementHandle, which
// keeps the tests deterministic instead of racing the render.
async function openGroup(page, facet) {
  const sel = `[data-facet-group="${facet}"]`;
  if (await page.$eval(sel, (e) => e.open)) return;
  await page.click(`${sel} summary`);
  await page.waitForFunction((s) => document.querySelector(s).open, {}, sel);
  await page.waitForSelector(`[data-facet-values="${facet}"] .facet-row`, { visible: true });
}

async function closeGroup(page, facet) {
  const sel = `[data-facet-group="${facet}"]`;
  if (!(await page.$eval(sel, (e) => e.open))) return;
  await page.click(`${sel} summary`);
  await page.waitForFunction((s) => !document.querySelector(s).open, {}, sel);
}

// clickRow asserts the row is genuinely VISIBLE (waitForSelector's visibility
// check — which is what catches a row hidden behind a collapsed group or an
// off-canvas drawer), then dispatches the click in-page. The two steps are
// separate on purpose: an ElementHandle resolved in Node and clicked one
// round-trip later can be detached by any repaint that lands in between, which
// makes the test flaky for reasons that have nothing to do with the rail.
// Asserting visibility and then clicking a freshly-resolved node keeps both
// the real signal and determinism.
async function clickRow(page, facet, index = 0) {
  const sel = `[data-facet-values="${facet}"] .facet-row`;
  await page.waitForSelector(sel, { visible: true });
  const clicked = await page.$eval(
    `[data-facet-values="${facet}"]`,
    (container, i) => {
      const row = container.querySelectorAll('.facet-row')[i];
      if (!row) return null;
      row.click();
      return row.querySelector('.facet-label').textContent;
    },
    index
  );
  assert.ok(clicked, `no row ${index} in the ${facet} group`);
  return clicked;
}

describe('filter rail — at rest', () => {
  test('the big groups ship collapsed', async () => {
    // The entire point: nobody should meet 310 expanded producers.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    assert.deepEqual((await openGroups(page)).sort(), ['country', 'vintage']);
    page.assertNoPageErrors();
    await page.close();
  });

  test('each big group shows at most the top 12, ranked by wine count', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');

    for (const facet of ['producer', 'region', 'varietal']) {
      const r = await rows(page, facet);
      // min(TOP_N, available), not a flat 12 — asserting a bare 12 would tie
      // this suite to one particular catalog size.
      const available = await groupTotal(page, facet);
      assert.equal(
        r.length,
        Math.min(TOP_N, available),
        `${facet} should show min(${TOP_N}, ${available}) rows, got ${r.length}`
      );

      const counts = r.map(([, n]) => n);
      assert.deepEqual(
        counts,
        [...counts].sort((a, b) => b - a),
        `${facet} rows are not ranked by count: ${counts}`
      );
      assert.ok(counts[0] > 0, `${facet} top row has no count`);
    }

    page.assertNoPageErrors();
    await page.close();
  });

  test('the header total covers the values the rows do not show', async () => {
    // The gap between "12 rows on screen" and "N values available" is what the
    // filter box and the expander exist to bridge, so the header must report
    // the FULL number and the expander must appear exactly when there is one.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');

    const total = await groupTotal(page, 'producer');
    const shown = (await rows(page, 'producer')).length;
    assert.ok(total >= shown, `header total ${total} is below the ${shown} rows shown`);

    const hasExpander = await page.$eval(
      '[data-facet-group="producer"]',
      (d) => {
        const b = d.querySelector('.facet-expander');
        return !!b && !b.hidden;
      }
    );
    assert.equal(
      hasExpander,
      total > TOP_N,
      `expander should be ${total > TOP_N ? 'shown' : 'hidden'} for ${total} values`
    );

    page.assertNoPageErrors();
    await page.close();
  });

  test('vintage renders newest-first as a chip grid', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const years = (await rows(page, 'vintage')).map(([v]) => v);
    assert.deepEqual(years, [...years].sort().reverse(), 'vintages must read newest-first');
    assert.ok(
      await page.$('[data-facet-values="vintage"].is-grid'),
      'vintage should render as a grid, not a checkbox list'
    );
    page.assertNoPageErrors();
    await page.close();
  });
});

describe('filter rail — finding a value', () => {
  test('filtering within a group narrows values without touching the results', async () => {
    // The rail's own filter box and the portfolio search are different tools;
    // confusing them is the obvious failure mode, so it is pinned here.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');

    const resultsBefore = await count(page);
    const gridBefore = await page.$$eval('.wine-grid > li', (e) => e.length);
    const target = (await rows(page, 'producer'))[3][0];

    await page.type('[data-facet-filter="producer"]', target.slice(0, 4).toLowerCase());
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-facet-values="producer"] .facet-row').length < n,
      { timeout: 5000 },
      TOP_N
    );

    const shown = (await rows(page, 'producer')).map(([v]) => v);
    assert.ok(shown.length > 0 && shown.length < TOP_N);
    for (const v of shown) {
      assert.match(v.toLowerCase(), new RegExp(target.slice(0, 4).toLowerCase()));
    }
    assert.equal(await count(page), resultsBefore, 'filtering values must not filter wines');
    assert.equal(await page.$$eval('.wine-grid > li', (e) => e.length), gridBefore);

    page.assertNoPageErrors();
    await page.close();
  });

  test('a value outside the top 12 is reachable by typing', async (t) => {
    // The whole justification for capping at 12: the rest are still there.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');

    // Meaningless against a catalog with nothing past the seed — skip loudly
    // rather than assert something that is vacuously true.
    if ((await groupTotal(page, 'producer')) <= TOP_N) {
      await page.close();
      return t.skip('catalog has no producers beyond the seed');
    }

    const seeded = (await rows(page, 'producer')).map(([v]) => v);
    await page.click('.facet-expander[data-facet-expand="producer"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-facet-values="producer"] .facet-row').length > n,
      { timeout: 5000 },
      TOP_N
    );
    const all = (await rows(page, 'producer')).map(([v]) => v);
    assert.ok(all.length > seeded.length, 'the expander must reveal more values');

    const deep = all.find((v) => !seeded.includes(v) && /^[a-z0-9 ]{4,}$/i.test(v));
    assert.ok(deep, 'expected a value outside the seeded twelve');

    // Collapse back, then reach it purely by typing.
    await page.click('.facet-expander[data-facet-expand="producer"]');
    await page.type('[data-facet-filter="producer"]', deep.slice(0, 5));
    await page.waitForFunction(
      (want) =>
        [...document.querySelectorAll('[data-facet-values="producer"] .facet-label')]
          .some((e) => e.textContent === want),
      { timeout: 5000 },
      deep
    );

    page.assertNoPageErrors();
    await page.close();
  });

  test('a query with no match says so instead of showing an empty box', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');
    await page.type('[data-facet-filter="producer"]', 'zzzznotaproducer');
    await page.waitForFunction(
      () => !document.querySelector('[data-facet-group="producer"] .facet-empty').hidden,
      { timeout: 5000 }
    );
    const msg = await page.$eval('[data-facet-group="producer"] .facet-empty', (e) => e.textContent);
    assert.match(msg, /No match/);
    page.assertNoPageErrors();
    await page.close();
  });
});

describe('filter rail — selection', () => {
  test('zero-count values leave the list, but a selected one never does', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');

    // Narrow hard with a country, then check the producer group.
    await clickRow(page, 'country');
    await page.waitForFunction(
      () => document.querySelector('#portfolio-chips')?.hidden === false,
      { timeout: 5000 }
    );

    const producerRows = await rows(page, 'producer');
    for (const [value, n] of producerRows) {
      assert.ok(n > 0, `"${value}" has no matches and should have left the list`);
    }

    // Now select a producer and then a country that excludes it: the producer
    // must remain visible at zero, or there is no way to undo it in the rail.
    await openGroup(page, 'producer');
    const chosen = (await rows(page, 'producer'))[0][0];
    await clickRow(page, 'producer');
    await page.waitForFunction(
      (v) => document.querySelector(`.facet-chip[data-chip-value="${CSS.escape(v)}"]`) !== null,
      { timeout: 5000 },
      chosen
    );

    const stillThere = await page.$$eval(
      '[data-facet-values="producer"] .facet-row.is-checked .facet-label',
      (els) => els.map((e) => e.textContent)
    );
    assert.deepEqual(stillThere, [chosen], 'the selected producer must stay in the list');
    const disabled = await page.$eval(
      '[data-facet-values="producer"] .facet-row.is-checked input',
      (el) => el.disabled
    );
    assert.equal(disabled, false, 'a selected value must stay toggleable');

    page.assertNoPageErrors();
    await page.close();
  });

  test('a chip appears for each selection and removes it in one click', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const before = await count(page);

    await clickRow(page, 'country');
    await page.waitForFunction(
      (n) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) !== n,
      { timeout: 5000 },
      before
    );

    const chips = await page.$$eval('.facet-chip', (els) => els.map((e) => e.dataset.chipValue));
    assert.equal(chips.length, 1, 'one selection should mean one chip');

    await page.click('.facet-chip');
    await page.waitForFunction(
      (n) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) === n,
      { timeout: 5000 },
      before
    );
    assert.equal(await count(page), before, 'removing the chip must restore the full catalog');
    assert.ok(await page.$eval('#portfolio-chips', (e) => e.hidden), 'the summary should hide when empty');

    page.assertNoPageErrors();
    await page.close();
  });

  test('a collapsed group still announces that it is filtering', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');
    await clickRow(page, 'producer');
    await page.waitForFunction(
      () => !document.querySelector('[data-facet-group="producer"] .facet-selected').hidden,
      { timeout: 5000 }
    );

    // Collapse it again — the badge is what tells you a filter is still on.
    await closeGroup(page, 'producer');
    assert.equal(await page.$eval('[data-facet-group="producer"]', (e) => e.open), false);
    const badge = await page.$eval('[data-facet-group="producer"] .facet-selected', (e) => ({
      hidden: e.hidden,
      text: e.textContent,
    }));
    assert.equal(badge.hidden, false, 'a collapsed group with a selection must show its badge');
    assert.equal(badge.text, '1');

    page.assertNoPageErrors();
    await page.close();
  });

  test('toggling a value with the keyboard keeps focus on it', async () => {
    // Rows are transient DOM — re-created on every query — so without explicit
    // focus restoration every keyboard toggle would drop the user to <body>.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');

    const target = (await rows(page, 'producer'))[2][0];
    await page.$eval(
      '[data-facet-values="producer"]',
      (c, v) => {
        const row = [...c.querySelectorAll('.facet-row')]
          .find((r) => r.querySelector('.facet-label').textContent === v);
        row.querySelector('input').focus();
      },
      target
    );
    await page.keyboard.press('Space');
    await page.waitForFunction(
      (v) => document.querySelector(`.facet-chip[data-chip-value="${CSS.escape(v)}"]`) !== null,
      { timeout: 5000 },
      target
    );

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el.matches('input[data-facet]')
        ? { facet: el.dataset.facet, value: el.value, checked: el.checked }
        : null;
    });
    assert.deepEqual(focused, { facet: 'producer', value: target, checked: true });

    page.assertNoPageErrors();
    await page.close();
  });

  test('clear all resets selections, search, and every group filter box', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const before = await count(page);

    await openGroup(page, 'producer');
    await page.type('[data-facet-filter="producer"]', 'a');
    await clickRow(page, 'producer');
    await page.waitForFunction(() => document.querySelector('.facet-chip') !== null, { timeout: 5000 });

    await page.click('.facet-clear');
    await page.waitForFunction(
      (n) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) === n,
      { timeout: 5000 },
      before
    );

    assert.equal(await page.$$eval('.facet-chip', (e) => e.length), 0);
    assert.equal(
      await page.$eval('[data-facet-filter="producer"]', (e) => e.value),
      '',
      'a leftover group filter is an invisible constraint on a rail that claims to be clear'
    );
    assert.equal(await page.$$eval('[data-facet-values="producer"] .facet-row', (e) => e.length), TOP_N);

    page.assertNoPageErrors();
    await page.close();
  });

  test('a deep link opens the group it filtered on', async () => {
    // Producer ships collapsed, so without this a shared link would apply a
    // filter you could see in the results but not find in the rail.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    await openGroup(page, 'producer');
    const chosen = (await rows(page, 'producer'))[0][0];

    await hydrated(page, `/portfolio/?producer=${encodeURIComponent(chosen)}`);

    assert.ok(await page.$eval('[data-facet-group="producer"]', (e) => e.open), 'group must open');
    assert.deepEqual(
      await page.$$eval('.facet-chip', (els) => els.map((e) => e.dataset.chipValue)),
      [chosen]
    );

    page.assertNoPageErrors();
    await page.close();
  });
});

describe('filter rail — without JavaScript', () => {
  test('renders a seeded, coherent rail with no dangling controls', async () => {
    const page = await openPage(browser);
    await page.setJavaScriptEnabled(false);
    await page.goto(server.origin + '/portfolio/', { waitUntil: 'domcontentloaded' });

    // Exactly the seed: 12 per big group, all values for the small ones.
    const total = await page.$$eval('input[data-facet]', (e) => e.length);
    assert.ok(total <= 90, `no-JS page should ship a seeded rail, got ${total} inputs`);
    for (const facet of ['producer', 'region', 'varietal']) {
      assert.equal(
        await page.$$eval(`[data-facet-values="${facet}"] .facet-row`, (e) => e.length),
        TOP_N
      );
    }

    // Every group body must be populated and every count real — no empty
    // groups, no blank counts waiting on JS that will never run.
    for (const [value, n] of await rows(page, 'producer')) {
      assert.ok(n > 0, `"${value}" rendered without a count`);
    }
    assert.equal(
      await page.$$eval('.facet-empty:not([hidden])', (e) => e.length),
      0,
      'no group may show its empty state on a static page'
    );

    await page.close();
  });
});

describe('filter rail — mobile drawer', () => {
  test('opens, tracks the live count, and returns focus on apply', async () => {
    // Below 1024px the rail is an off-canvas drawer. Filtering is live as you
    // tap, so the footer button commits nothing — it exists so you can see the
    // size of what you built before dismissing the panel.
    const page = await openPage(browser);
    await page.setViewport(MOBILE);
    await hydrated(page, '/portfolio/');

    const total = await count(page);
    assert.equal(
      await page.$eval('#portfolio-facets', (el) => el.classList.contains('is-open')),
      false,
      'the drawer must start closed'
    );

    await page.click('.filters-toggle');
    await page.waitForSelector('#portfolio-facets.is-open', { visible: true });
    assert.equal(await page.$eval('.filters-toggle', (el) => el.getAttribute('aria-expanded')), 'true');

    // The footer count starts at the full catalog and follows the filter.
    assert.equal(
      await page.$eval('.facets-apply-count', (el) => parseInt(el.textContent.replace(/[^\d]/g, ''), 10)),
      total
    );
    await clickRow(page, 'country');
    await page.waitForFunction(
      (n) => parseInt(document.querySelector('.facets-apply-count').textContent.replace(/[^\d]/g, ''), 10) !== n,
      { timeout: 5000 },
      total
    );
    const narrowed = await count(page);
    assert.equal(
      await page.$eval('.facets-apply-count', (el) => parseInt(el.textContent.replace(/[^\d]/g, ''), 10)),
      narrowed,
      'the drawer CTA must show the count you are about to get'
    );
    assert.ok(narrowed < total);

    await page.click('.facets-apply');
    await page.waitForFunction(
      () => !document.querySelector('#portfolio-facets').classList.contains('is-open'),
      { timeout: 5000 }
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains('filters-toggle')),
      true,
      'dismissing the drawer must return focus to the control that opened it'
    );

    page.assertNoPageErrors();
    await page.close();
  });
});
