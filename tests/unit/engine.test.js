// Unit tests for CatalogEngine — the pure filter/count/sort/paginate core of
// assets/js/portfolio.js, with no DOM and no network involved.
//
// The engine file is loaded into a node:vm context rather than imported, for
// two reasons: assets/js/portfolio.js is a hand-written browser IIFE (no build
// step, no module system — see package.json), and loading the shipped file
// directly means these tests can never drift from a copy. The IIFE publishes
// its pure half onto globalThis and returns before touching `document`.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let Engine;
let FACET_KEYS;

before(async () => {
  const src = await readFile(join(ROOT, 'assets', 'js', 'portfolio.js'), 'utf8');
  // A bare context: full JS intrinsics (the engine needs Intl.Collator and Set)
  // but no document, no window, no fetch — so any accidental DOM dependency
  // creeping into the engine half fails here immediately.
  const ctx = createContext({});
  runInContext(src, ctx);
  assert.ok(ctx.FineVinesCatalog, 'portfolio.js did not publish its engine');
  ({ Engine, FACET_KEYS } = ctx.FineVinesCatalog);
});

// A small hand-built catalog with known, checkable answers. Deliberately not a
// slice of real data: every count below is arithmetic a reader can verify.
//
//   producer   region     varietal     vintage  country
//   Lamy       Burgundy   Chardonnay   2021     France
//   Lamy       Burgundy   Chardonnay   2020     France
//   Roulot     Burgundy   Chardonnay   2021     France
//   Clape      Rhone      Syrah        2021     France
//   Ridgeview  Napa       Cabernet     2020     USA
//   Ridgeview  Napa       Cabernet     ''       USA   <- no vintage
const WINES = [
  { slug: 'lamy-a', name: 'Saint-Aubin', producer: 'Lamy', region: 'Burgundy', varietal: 'Chardonnay', vintage: '2021', country: 'France' },
  { slug: 'lamy-b', name: 'Chassagne', producer: 'Lamy', region: 'Burgundy', varietal: 'Chardonnay', vintage: '2020', country: 'France' },
  { slug: 'roulot', name: 'Meursault', producer: 'Roulot', region: 'Burgundy', varietal: 'Chardonnay', vintage: '2021', country: 'France' },
  { slug: 'clape', name: 'Cornas', producer: 'Clape', region: 'Rhone', varietal: 'Syrah', vintage: '2021', country: 'France' },
  { slug: 'ridge-a', name: 'Estate Cabernet', producer: 'Ridgeview', region: 'Napa', varietal: 'Cabernet', vintage: '2020', country: 'USA' },
  { slug: 'ridge-b', name: 'Reserve Cabernet', producer: 'Ridgeview', region: 'Napa', varietal: 'Cabernet', vintage: '', country: 'USA' },
];

const engine = () => new Engine(WINES.map((w) => ({ ...w })));

// The engine runs in its own vm realm, so the arrays and objects it returns
// have that realm's prototypes — structurally identical values are not
// deepEqual-equal across the boundary. These two helpers copy results into
// host-realm values before asserting. `counts` additionally flattens the
// engine's Object.create(null) maps into plain objects.
const slugs = (r) => Array.from(r.items, (i) => i.slug);
const counts = (r, facet) => ({ ...r.facetCounts[facet] });

describe('facet keys', () => {
  test('match the five facets build.go emits', () => {
    assert.deepEqual([...FACET_KEYS].sort(), ['country', 'producer', 'region', 'varietal', 'vintage']);
  });
});

describe('filtering', () => {
  test('no filters returns everything', () => {
    assert.equal(engine().query({}).total, 6);
  });

  test('OR within a facet', () => {
    const r = engine().query({ selectedFacets: { producer: ['Lamy', 'Clape'] } });
    assert.equal(r.total, 3);
    assert.deepEqual(slugs(r).sort(), ['clape', 'lamy-a', 'lamy-b']);
  });

  test('AND between facets', () => {
    const r = engine().query({ selectedFacets: { region: ['Burgundy'], vintage: ['2021'] } });
    assert.deepEqual(slugs(r).sort(), ['lamy-a', 'roulot']);
  });

  test('a combination matching nothing returns an empty page, not an error', () => {
    const r = engine().query({ selectedFacets: { region: ['Napa'], varietal: ['Syrah'] } });
    assert.equal(r.total, 0);
    assert.deepEqual(slugs(r), []);
    assert.equal(r.pageCount, 1, 'an empty result is still one (empty) page');
    assert.equal(r.page, 1);
  });

  test('an unknown facet value matches nothing rather than being ignored', () => {
    // If this ever "helpfully" returned everything, a stale shared link would
    // silently show the whole catalog instead of an empty state.
    assert.equal(engine().query({ selectedFacets: { producer: ['Nonexistent'] } }).total, 0);
  });
});

describe('search', () => {
  test('matches across producer, name, region and varietal', () => {
    assert.equal(engine().query({ search: 'meursault' }).total, 1); // name
    assert.equal(engine().query({ search: 'burgundy' }).total, 3);  // region
    assert.equal(engine().query({ search: 'cabernet' }).total, 2);  // varietal + name
    assert.equal(engine().query({ search: 'ridgeview' }).total, 2); // producer
  });

  test('is case-insensitive and trims', () => {
    assert.equal(engine().query({ search: '  RoUlOt ' }).total, 1);
  });

  test('combines with facets as AND', () => {
    const r = engine().query({ search: 'chardonnay', selectedFacets: { producer: ['Lamy'] } });
    assert.equal(r.total, 2);
  });
});

describe('facet counts', () => {
  test('with nothing selected, counts are plain totals', () => {
    const r = engine().query({});
    assert.deepEqual(counts(r, 'producer'), { Lamy: 2, Roulot: 1, Clape: 1, Ridgeview: 2 });
    assert.deepEqual(counts(r, 'region'), { Burgundy: 3, Rhone: 1, Napa: 2 });
    assert.deepEqual(counts(r, 'country'), { France: 4, USA: 2 });
  });

  test('a facet never narrows its own counts', () => {
    // THE faceted-search invariant. Selecting Lamy must leave every producer
    // count untouched, or you could never switch to a different producer.
    const base = counts(engine().query({}), 'producer');
    const after = counts(engine().query({ selectedFacets: { producer: ['Lamy'] } }), 'producer');
    assert.deepEqual(after, base);
  });

  test('a selection narrows every OTHER facet', () => {
    const r = engine().query({ selectedFacets: { producer: ['Lamy'] } });
    assert.deepEqual(counts(r, 'region'), { Burgundy: 2 });
    assert.deepEqual(counts(r, 'vintage'), { 2021: 1, 2020: 1 });
    assert.equal(counts(r, 'region').Napa, undefined, 'a zeroed value must be absent, not 0');
  });

  test('empty values never become a facet option', () => {
    // ridge-b has no vintage; it must not produce a blank checkbox.
    assert.equal('' in counts(engine().query({}), 'vintage'), false);
  });

  test('search narrows counts too', () => {
    assert.deepEqual(counts(engine().query({ search: 'burgundy' }), 'producer'), { Lamy: 2, Roulot: 1 });
  });
});

describe('collapsed vintages (vints)', () => {
  // A card that collapses several vintages of one wine ships vintage = newest
  // year plus vints = the full list (see build.go's writeCatalogIndex). The
  // vintage facet must treat the card as ALL of its years, not just the newest.
  const GROUPED = [
    { slug: 'acre-2019', name: 'Napa Cab', producer: 'Acre', region: 'Napa', varietal: 'Cabernet', vintage: '2019', vints: ['2019', '2018'], country: 'USA' },
    { slug: 'solo', name: 'Cornas', producer: 'Clape', region: 'Rhone', varietal: 'Syrah', vintage: '2018', country: 'France' },
  ];
  const grouped = () => new Engine(GROUPED.map((w) => ({ ...w })));

  test('a vintage selection matches any year in the group', () => {
    const r = grouped().query({ selectedFacets: { vintage: ['2018'] } });
    assert.deepEqual(slugs(r).sort(), ['acre-2019', 'solo']);
  });

  test('the newest year still matches too', () => {
    assert.deepEqual(slugs(grouped().query({ selectedFacets: { vintage: ['2019'] } })), ['acre-2019']);
  });

  test('facet counts count the group under every one of its years', () => {
    assert.deepEqual(counts(grouped().query({}), 'vintage'), { 2019: 1, 2018: 2 });
  });

  test('entries without vints behave exactly as before', () => {
    const r = grouped().query({ selectedFacets: { vintage: ['2018'], country: ['France'] } });
    assert.deepEqual(slugs(r), ['solo']);
  });
});

describe('sorting', () => {
  test('producer is the default, with name as a stable tiebreak', () => {
    assert.deepEqual(slugs(engine().query({})), ['clape', 'lamy-b', 'lamy-a', 'ridge-a', 'ridge-b', 'roulot']);
  });

  test('vintage sorts ascending with missing vintages LAST', () => {
    // The rule that matters: an empty/NV vintage must never sort as year zero
    // and lead the list.
    const ordered = slugs(engine().query({ sort: 'vintage' }));
    assert.equal(ordered[ordered.length - 1], 'ridge-b', 'the vintage-less wine must sort last');
    assert.deepEqual(ordered.slice(0, 2).sort(), ['lamy-b', 'ridge-a'], '2020s lead');
  });

  test('region and name sorts are honoured', () => {
    assert.equal(slugs(engine().query({ sort: 'region' }))[0], 'lamy-b', 'Burgundy first');
    assert.equal(slugs(engine().query({ sort: 'name' }))[0], 'lamy-b', 'Chassagne first');
  });

  test('an unknown sort key falls back to producer rather than throwing', () => {
    assert.deepEqual(slugs(engine().query({ sort: 'nonsense' })), slugs(engine().query({})));
  });

  test('sorting is accent- and case-insensitive', () => {
    const e = new Engine([
      { slug: 'a', name: 'x', producer: 'Écard', region: '', varietal: '', vintage: '', country: '' },
      { slug: 'b', name: 'x', producer: 'Dubois', region: '', varietal: '', vintage: '', country: '' },
      { slug: 'c', name: 'x', producer: 'faiveley', region: '', varietal: '', vintage: '', country: '' },
    ]);
    assert.deepEqual(slugs(e.query({})), ['b', 'a', 'c'], 'Dubois < Écard < faiveley');
  });
});

describe('pagination', () => {
  test('slices to the requested page', () => {
    const r = engine().query({ pageSize: 2, page: 2 });
    assert.equal(r.items.length, 2);
    assert.equal(r.pageCount, 3);
    assert.deepEqual(slugs(r), ['lamy-a', 'ridge-a']);
  });

  test('a page past the end clamps to the last page', () => {
    // Reached whenever a filter shrinks the result set under a deep-linked
    // ?page=. The clamped value is what the UI writes back to the URL.
    const r = engine().query({ pageSize: 2, page: 99 });
    assert.equal(r.page, 3);
    assert.equal(r.items.length, 2);
  });

  test('page 0 and negative pages clamp to 1', () => {
    assert.equal(engine().query({ pageSize: 2, page: 0 }).page, 1);
    assert.equal(engine().query({ pageSize: 2, page: -5 }).page, 1);
  });

  test('the default page size is 48', () => {
    assert.equal(engine().query({}).pageCount, 1);
  });

  test('pages tile the result set exactly — no gaps, no repeats', () => {
    const e = engine();
    const seen = [];
    for (let p = 1; p <= e.query({ pageSize: 2 }).pageCount; p++) {
      seen.push(...slugs(e.query({ pageSize: 2, page: p })));
    }
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6);
  });
});

describe('input handling', () => {
  test('accepts Sets and arrays interchangeably for selected facets', () => {
    const viaSet = engine().query({ selectedFacets: { producer: new Set(['Lamy']) } });
    const viaArray = engine().query({ selectedFacets: { producer: ['Lamy'] } });
    assert.deepEqual(slugs(viaSet), slugs(viaArray));
  });

  test('query() with no arguments does not throw', () => {
    assert.equal(engine().query().total, 6);
  });
});
