// Browser tests for /portfolio/ against the REAL built dist/, in real Chrome.
//
// These are deliberately written as BEHAVIOUR tests, not markup tests: they
// assert what a visitor can observe (counts, cards, URL, back/forward), never
// the shape of the sidebar. That is the point — the filter rail is about to be
// rebuilt (issue #4), and this file has to keep passing across that rebuild.
// Anything here that breaks when the rail changes is a real regression, not a
// test that needed updating.
//
// Markup-contract assertions live in Go, in internal/build/build_test.go.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { serve } from '../helpers/server.js';
import { openBrowser, openPage } from '../helpers/browser.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist');

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

// hydrated navigates to a portfolio URL and waits for portfolio.js to have
// taken over. The tell is the pagination nav: the server renders a static
// "Page N of M" and the JS REBUILDS it with data-page anchors, so the presence
// of `a[data-page]` (or a single-page result, where the nav is hidden) proves
// the catalog-index arrived and render() ran. Waiting on that instead of a
// fixed sleep is what keeps these tests from being flaky.
async function hydrated(page, path) {
  await page.goto(server.origin + path, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => {
    const nav = document.querySelector('.pagination');
    return nav && (nav.hidden || nav.querySelector('a[data-page], span.is-disabled'));
  }, { timeout: 15000 });
}

const count = (page) =>
  page.$eval('#portfolio-count', (el) => parseInt(el.textContent.replace(/[^\d]/g, ''), 10));
const cards = (page) => page.$$eval('.wine-grid > li', (els) => els.length);
const producers = (page) =>
  page.$$eval('.wine-grid .producer', (els) => els.map((e) => e.textContent.trim()));

describe('portfolio — client-side catalog', () => {
  test('hydrates and reports the full catalog', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');

    const total = await count(page);
    // The public count follows the published inventory rows used by the
    // homepage and email, while the grid quietly groups related rows.
    assert.ok(total > 2500, `expected the published catalog count, got ${total} wines`);
    assert.equal(await cards(page), 48, 'page 1 should render one full page of cards');

    assert.equal(
      await page.$$eval('.vintage-badge', (items) => items.length),
      0,
      'the browse UI must not explain internal vintage grouping'
    );

    // The engine must be paginating the WHOLE catalog, not just this page.
    const pageCount = await page.$eval('.pagination-status', (el) => el.textContent);
    assert.match(pageCount, /^Page 1 of \d+$/);

    page.assertNoPageErrors();
    await page.close();
  });

  test('selecting a facet filters the grid and writes the URL', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const before = await count(page);

    // Pick the first producer that has a live count — whichever it is. Not
    // hardcoded, so a data refresh cannot break this test.
    const chosen = await page.$$eval('input[data-facet="producer"]', (boxes) => {
      const live = boxes.find((b) => !b.disabled);
      if (live) live.click();
      return live ? live.value : null;
    });
    assert.ok(chosen, 'no selectable producer facet found');

    await page.waitForFunction(
      (b) => {
        const el = document.querySelector('#portfolio-count');
        return el && parseInt(el.textContent.replace(/[^\d]/g, ''), 10) < b;
      },
      { timeout: 5000 },
      before
    );

    const after = await count(page);
    assert.ok(after > 0 && after < before, `filter should narrow ${before} → got ${after}`);

    // The URL is the state. It must carry the selection.
    const url = new URL(page.url());
    assert.deepEqual(url.searchParams.getAll('producer'), [chosen]);

    // Every rendered card must actually belong to the selected producer.
    for (const p of await producers(page)) {
      assert.equal(p, chosen, 'a card slipped through that is not the selected producer');
    }

    page.assertNoPageErrors();
    await page.close();
  });

  test('a facet never zeroes out its own options', async () => {
    // The defining invariant of faceted counting: selecting one producer must
    // not change any count inside the PRODUCER group (you must still be able
    // to switch to another producer), while it does change counts in region.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');

    const read = (facet) =>
      page.$$eval(
        `input[data-facet="${facet}"]`,
        (boxes) =>
          boxes.map((b) => {
            const span = b.closest('label')?.querySelector('.facet-count');
            return [b.value, span ? span.textContent.trim() : ''];
          })
      );

    const producerBefore = await read('producer');
    const regionBefore = await read('region');

    const chosen = await page.$$eval('input[data-facet="producer"]', (boxes) => {
      const live = boxes.find((b) => !b.disabled);
      if (live) live.click();
      return live ? live.value : null;
    });
    assert.ok(chosen);
    await page.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepEqual(
      await read('producer'),
      producerBefore,
      'selecting a producer must not change counts within the producer group'
    );
    assert.notDeepEqual(
      await read('region'),
      regionBefore,
      'selecting a producer must narrow the region counts'
    );

    page.assertNoPageErrors();
    await page.close();
  });

  test('search narrows the catalog', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const before = await count(page);

    await page.type('#portfolio-search', 'chardonnay');
    // Wait for the URL to carry the FULL query, not just for the count to
    // drop: the debounced URL write can fire mid-typing on a slow runner
    // ("ch" narrowed the count, the assert then read a half-typed q).
    await page.waitForFunction(
      () => new URL(location.href).searchParams.get('q') === 'chardonnay',
      { timeout: 5000 }
    );
    await page.waitForFunction(
      (b) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) < b,
      { timeout: 5000 },
      before
    );

    const after = await count(page);
    assert.ok(after > 0, 'search for "chardonnay" should match something');
    assert.ok(after < before);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'chardonnay');

    page.assertNoPageErrors();
    await page.close();
  });

  test('sort reorders the whole result set, not just the page', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const byProducer = await page.$$eval('.wine-grid > li', (els) => els.map((e) => e.dataset.slug));

    await page.select('#portfolio-sort', 'vintage');
    await page.waitForFunction(
      (first) => document.querySelector('.wine-grid > li')?.dataset.slug !== first,
      { timeout: 5000 },
      byProducer[0]
    );

    const byVintage = await page.$$eval('.wine-grid > li', (els) => els.map((e) => e.dataset.slug));
    assert.notDeepEqual(byVintage, byProducer, 'changing sort must change the page 1 slice');
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'vintage');

    page.assertNoPageErrors();
    await page.close();
  });

  test('paging changes the cards and the URL', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const first = await page.$$eval('.wine-grid > li', (els) => els.map((e) => e.dataset.slug));

    await page.click('.pagination-next');
    await page.waitForFunction(
      (f) => document.querySelector('.wine-grid > li')?.dataset.slug !== f,
      { timeout: 5000 },
      first[0]
    );

    const second = await page.$$eval('.wine-grid > li', (els) => els.map((e) => e.dataset.slug));
    assert.notDeepEqual(second, first);
    assert.equal(new URL(page.url()).searchParams.get('page'), '2');
    // No wine may appear on two pages.
    assert.equal(new Set([...first, ...second]).size, first.length + second.length);

    page.assertNoPageErrors();
    await page.close();
  });

  test('a deep link restores filter, sort and page', async () => {
    // Criterion 11 of the work package: the URL contract. This is the test the
    // filter-rail rebuild must not break.
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const chosen = await page.$$eval('input[data-facet="producer"]', (boxes) => {
      const live = boxes.find((b) => !b.disabled);
      return live ? live.value : null;
    });
    assert.ok(chosen);

    const deep = `/portfolio/?producer=${encodeURIComponent(chosen)}&sort=vintage`;
    await hydrated(page, deep);

    // The control state must reflect the URL, not the other way round.
    assert.equal(await page.$eval('#portfolio-sort', (el) => el.value), 'vintage');
    const checked = await page.$$eval('input[data-facet="producer"]:checked', (b) =>
      b.map((x) => x.value)
    );
    assert.deepEqual(checked, [chosen], 'the URL-selected producer must render checked');
    for (const p of await producers(page)) assert.equal(p, chosen);

    page.assertNoPageErrors();
    await page.close();
  });

  test('back and forward restore previous result sets', async () => {
    const page = await openPage(browser);
    await hydrated(page, '/portfolio/');
    const unfiltered = await count(page);

    const chosen = await page.$$eval('input[data-facet="producer"]', (boxes) => {
      const live = boxes.find((b) => !b.disabled);
      if (live) live.click();
      return live ? live.value : null;
    });
    await page.waitForFunction(
      (b) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) < b,
      { timeout: 5000 },
      unfiltered
    );
    const filtered = await count(page);

    await page.goBack();
    await page.waitForFunction(
      (n) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) === n,
      { timeout: 5000 },
      unfiltered
    );
    assert.equal(await count(page), unfiltered, 'back must restore the unfiltered catalog');
    assert.equal(
      await page.$$eval('input[data-facet="producer"]:checked', (b) => b.length),
      0,
      'back must also uncheck the facet — the URL is the source of truth'
    );

    await page.goForward();
    await page.waitForFunction(
      (n) => parseInt(document.querySelector('#portfolio-count').textContent.replace(/[^\d]/g, ''), 10) === n,
      { timeout: 5000 },
      filtered
    );
    assert.equal(await count(page), filtered, 'forward must restore the filtered set');
    assert.ok(chosen);

    page.assertNoPageErrors();
    await page.close();
  });
});

describe('portfolio — progressive enhancement', () => {
  test('renders a full, crawlable page with JavaScript disabled', async () => {
    // The whole architecture rests on this: no-JS visitors and crawlers get
    // real cards and real prev/next links. If the filter-rail rebuild ever
    // moves card rendering client-side, this fails — which is the point.
    const page = await openPage(browser);
    await page.setJavaScriptEnabled(false);
    await page.goto(server.origin + '/portfolio/page/3/', { waitUntil: 'domcontentloaded' });

    assert.equal(await cards(page), 48, 'a no-JS page must still render its cards');

    const links = await page.$$eval('.wine-grid a.wine-card', (els) => els.map((e) => e.getAttribute('href')));
    assert.equal(links.length, 48);
    for (const href of links) assert.match(href, /^\/wines\/[a-z0-9-]+\/$/);

    // Crawlable pagination in both directions.
    assert.ok(await page.$('a[rel="prev"]'), 'page 3 must link back');
    assert.ok(await page.$('a[rel="next"]'), 'page 3 must link forward');

    await page.close();
  });

  test('survives a missing catalog-index without losing the page', async () => {
    // Fail-open, as the work package requires: if the index 404s, the visitor
    // keeps the server-rendered cards and working pagination links.
    const page = await openPage(browser);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('catalog-index')) req.abort();
      else req.continue();
    });

    await page.goto(server.origin + '/portfolio/', { waitUntil: 'networkidle2' });
    assert.equal(await cards(page), 48, 'cards must survive a dead index');
    assert.ok(await page.$('a[rel="next"]'), 'server pagination must survive a dead index');

    await page.close();
  });
});
