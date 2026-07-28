# Portfolio filter rail at scale

**Issue:** #4   **Repos/branches:** `finevines-website@master` → `feat/portfolio-filter-rail`   **Status:** implemented, awaiting independent review

## Results (measured 2026-07-27)

| Criterion | Target | Measured | |
|---|---|---|---|
| 1 | ≤90 facet inputs, <100 KB | **84 inputs, 72,307 bytes** (was 577 / 147,719 — −51%) | ✅ |
| 2–13 | behaviour | 15 browser tests, `tests/e2e/filter-rail.test.js` | ✅ |
| 14 | render cost | **104 rail node insertions per toggle**, vs ~577 checkbox visits before | ⚠️ see below |
| 15 | determinism | `go test ./...` green incl. `TestBuildIsDeterministic` | ✅ |

Full suite: `npm test` **51 passing, 0 failing**; `go test ./...` all packages pass.

**Criterion 14 was written as "at most ~90 nodes" before anything was measured; the real figure
is 104.** The estimate ignored that all five groups repaint, not only the big three — 12×3 big +
28 vintage + 20 country = 84 rows, plus chips and headers. The criterion's intent (a bounded
repaint, not a walk of the whole catalog's values) holds: the old code visited all 577 checkboxes
and their label/count spans on every render. Recording the measured number rather than restating
the target.

## Objective

Replace the portfolio's flat 577-checkbox sidebar with the rail from
`docs/Portfolio filter sidebar at scale/`: collapsible groups, filter-within-group search,
count-ranked top-12 values with a "show all" expander, live per-value counts, a selected-value
chip summary, and a mobile drawer that commits with a "Show N wines" button. A visitor must be
able to find and select one producer out of 310 in a few seconds, and the page must get lighter
doing it — not heavier.

## Background

Verified this session against the current build and source:

- `dist/portfolio/index.html` is 147 KB and contains **577 facet checkboxes** —
  310 `producer`, 110 `varietal`, 109 `region`, 28 `vintage`, 20 `country`
  (counted with `grep -o 'data-facet="[a-z]*"' | sort | uniq -c`). That block repeats on every
  one of ~56 paginated pages and is roughly 40% of each page's bytes.
- Every group renders `<details … open>` — `templates/portfolio.html.tmpl:68` — so all 577 are
  expanded on first paint, sorted alphabetically by `buildFacets`
  (`internal/build/build.go:513`, `sort.Strings(values)`), with no search and no ranking.
- The checkboxes are **inert without JS**: no `href`, no `<form>`. `assets/js/filters.js` only
  opens/closes the drawer; `assets/js/portfolio.js` does all filtering.
- `updateFacetCounts` (`assets/js/portfolio.js:340-351`) walks all 577 checkboxes on **every**
  render to write counts and toggle `.is-empty`.
- The reference prototype (`Portfolio Filter Rail.dc.html`, with its `<script type="text/x-dc">`
  logic block) was built against the real cardinality — its 310/109/110/28/20 match the live
  build exactly, so its layout decisions are grounded in this catalog, not a mock.

Two facts that decide the architecture:

1. **The catalog-index already carries every facet value.** `indexEntry`
   (`internal/build/build.go:543-554`) ships `Producer`, `Region`, `Varietal`, `Country`,
   `Vintage` per wine, and `portfolio.js` already fetches it on first visit. The rail can be
   built entirely client-side with no new payload.
2. **The sidebar's facet strings duplicate an SEO surface that already exists.** Every producer,
   region, and varietal appears as body text on its own `/wines/<slug>/` detail page
   (`templates/wine.html.tmpl:44-50`) — 2,666 pages, all in the sitemap
   (`TestSitemapListsEveryPage`). Dropping ~493 duplicate strings from the sidebar removes no
   unique indexable content. Making them crawlable links instead would be a regression: 577
   query-string URLs is crawl-budget waste against a canonical `/portfolio/`.

## Owned scope

- `templates/portfolio.html.tmpl` — rail markup: seeded groups, group chrome, chip summary
  container, vintage chip grid, mobile CTA footer
- `assets/js/portfolio.js` — the new `FacetRail` module and its integration with `render()`
- `assets/js/filters.js` — drawer CTA wiring only
- `assets/css/site.css` — rail styles, semantic token aliases
- `internal/build/build.go` — `buildFacets`, `facetGroup`, and the portfolio page data it feeds
- `internal/build/build_test.go` — assertions for the above
- `package.json`, `tests/helpers/`, `tests/unit/`, `tests/e2e/` — the dev-only test harness
- `docs/work-packages/2026-07-27-portfolio-filter-rail.md` — this file

## Preserved scope

Leave **exactly alone**. Another session has uncommitted work in this shared checkout
(`git status --porcelain`, verified this session):

```
 M data/wines.json
 M internal/enrich/diff.go        M internal/enrich/diff_test.go
 M internal/enrich/hash.go        M internal/enrich/hash_test.go
 M internal/enrich/imagen.go      M internal/enrich/imagen_test.go
 M internal/enrich/rules.go       M tools/enrichprompts/main.go
```

Plus, unrelated to this work: `internal/salesforce/`, `internal/model/`, `internal/enrich/`,
`internal/redirects/`, `internal/deploy/`, `internal/label/`, `internal/report/`, all other
templates, `data/`, `assets/img/`.

**Commit with an explicit pathspec — never `git add -A`, never `git commit -a`.** The enrich
files above will silently ride along otherwise.

## Out of scope

- **Stock/inventory badges and `inventory.json`** — the prototype's "530 bottles · 44 cs + 2"
  badge and in-stock gate. Needs `FV_OnHand_Qty__c` plumbed through enrich → `wines.json` →
  catalog-index plus a refresh story for a static site. It is a data-pipeline change, not a
  sidebar change, and enrich already gates `stockQty > 0` so every catalog wine is in stock.
  Client decision this session: file separately.
- **Facet landing pages** (`/portfolio/producer/<slug>/`) — the real SEO win, and the right home
  for crawlable facet values. Separate issue.
- **The URL contract.** `?producer=…&region=…&q=…&sort=…&page=…` stays byte-identical, so
  existing shared links keep working. Per-group open/query/show-all state is transient UI state
  and stays out of the URL.
- **Wine card, grid, and Cards/List view toggle** — untouched; the prototype omits the toggle but
  it ships today and must survive.
- **Empty-producer data quality** (1,629 wines, issue #2) — it will make the producer group's
  ranked list look thin; that is a data problem, not a rail problem.
- **Duplicate-SKU pack/bottle variants** (73 SKUs, `docs/portfolio-slug-duplicates.md`).

## Constraints

- **No build step, no framework, no dependencies.** `assets/js/*.js` are hand-written ES5-style
  IIFEs served directly. There is no `package.json` and no bundler; do not introduce one.
- **Build determinism.** `TestBuildIsDeterministic` requires byte-identical output for identical
  input. Ranking facet values by count needs an explicit total order — count desc, then label
  asc — because Go map iteration is randomised and `sort.Slice` is not stable.
- **Progressive enhancement holds.** With JS off, the page must still render, still be crawlable,
  and still expose working prev/next pagination. The rail may be non-functional without JS (it
  already is) but must not be *broken* — no empty group bodies, no dangling "Show all" control.
- **Focus must survive re-render.** Rows are now transient DOM. Toggling a checkbox or typing in
  a group's filter box must not drop keyboard focus.
- **`.facets` is also the mobile drawer.** `filters.js`'s focus trap enumerates focusables at
  each Tab keypress, so transient rows are safe — but the trap must not be bypassed by new
  controls rendered outside `#portfolio-facets`.

## Acceptance criteria

Observable, checkable by someone who did not write the code.

1. **Page weight.** A freshly built `dist/portfolio/index.html` contains at most **90** elements
   matching `data-facet=` (12 producer + 12 region + 12 varietal + 28 vintage + 20 country = 84),
   down from 577, and the file is under 100 KB. Verified by
   `grep -c 'data-facet=' dist/portfolio/index.html` and `ls -l`.
2. **Ranking.** With no filters applied, each of producer/region/varietal shows its 12
   highest-wine-count values, count desc, ties broken alphabetically — identical order
   server-rendered and after JS hydration.
3. **Find-a-producer.** Opening Producer, typing three characters of a producer's name, and
   clicking its checkbox filters the grid to that producer — with no scrolling of a 310-item
   list at any point.
4. **Group filter is not wine search.** Typing in a group's filter box narrows only that group's
   values and never changes the result count or the grid. Typing in `#portfolio-search` filters
   wines and never empties a group's filter box.
5. **Zero-count values leave the list.** After selecting a region, the producer group contains no
   value with count 0 — except a producer that is itself selected, which remains visible,
   enabled, and un-toggleable back off.
6. **Counts stay live and correct.** Every visible `.facet-count` equals the number of wines that
   value would yield given every *other* active facet — i.e. selecting a producer does not
   change any count within the producer group.
7. **Expander.** "Show all 310 producers" reveals the full ranked list in a scroll-capped
   container; the label reflects the *available* count under current filters, not a constant;
   "Show fewer" returns to 12.
8. **Chips.** Every selected value appears as a chip at the rail top; clicking a chip's ✕ removes
   exactly that value; "Clear all" empties every facet and the search box in one action and
   returns the URL to a bare `/portfolio/`.
9. **Collapsed default.** On first load producer/region/varietal are collapsed and
   vintage/country expanded. A group with a selection renders a count badge in its header and
   opens on load if the URL selected into it.
10. **Focus survives.** Toggling a value with the keyboard leaves focus on that value's checkbox.
    Typing in a group's filter box never moves focus out of that input.
11. **URL round-trip unchanged.** `/portfolio/?producer=X&region=Y&sort=vintage&page=3` restores
    the same result set, count, sort, and page as before this change; back/forward still work.
12. **No-JS.** With JavaScript disabled, `/portfolio/` renders its 48 cards, the seeded rail with
    no empty group bodies and no "Show all" control, and working prev/next links.
13. **Mobile drawer.** At ≤1024px the drawer shows a sticky "Show N wines" button whose N tracks
    the live result count; pressing it closes the drawer and returns focus to the Filters button.
14. **Render cost.** A facet toggle with no filters active touches at most ~90 rail DOM nodes,
    not 577. Measured via a DevTools performance recording of one toggle.
15. **Determinism.** `go test ./...` passes, including `TestBuildIsDeterministic`, and two
    consecutive builds of the same `data/wines.json` produce byte-identical `dist/portfolio/`.

## Production boundary

`None — repository change only.` No deploy, no Bunny push, no Salesforce call, no live target.
Local `dist/` output only. Deploying this to the live site is a separate, separately-authorised
step under `production-acceptance`.

## Validation plan

| Level | What it proves | Status |
|---|---|---|
| Unit (Go) | `buildFacets` returns top-12 per big group, ranked count desc then label asc, with the full `Total` carried for the expander label; vintage sorts newest-first; empty values still skipped | to write |
| Unit (Go) | `TestBuildIsDeterministic` still passes — ranking is a total order | exists, must keep passing |
| Integration (Go) | `TestPortfolioPage` — the JS↔template hook contract survives: `data-facet`, `.facet-count`, `#portfolio-search`, `#portfolio-sort`, `#portfolio-count`, `#portfolio-empty`, `.pagination`, drawer hooks; **plus** new assertions that the seed is capped and the group `Total` is rendered | exists, must extend |
| Unit (JS) | `CatalogEngine` filter / facet-count / sort / paginate semantics, headless, no DOM — `npm run test:unit`, 26 tests | **built, green** |
| Unit (JS) | The new `FacetRail` row-selection + ranking function, once written — same harness | to write |
| Browser (real Chrome) | Criteria 3–13 driven through the actual built `dist/` — `npm run test:e2e`, 10 tests | **built, green** |
| Browser (real Chrome) | Criterion 12 (no-JS) and fail-open on a dead catalog-index | **built, green** |
| Regression | Criterion 11 — the URL contract, asserted as behaviour that must survive the rebuild | **built, green** |

**Scope change, agreed this session:** the original draft recorded "no JavaScript test
infrastructure in this repo" as an accepted gap. That was rejected — a harness was required
before implementation. It now exists:

- `package.json` — dev-only. Nothing ships from it; the site remains Go-built static HTML plus
  hand-written IIFE scripts served directly, with no bundler and no runtime dependencies.
  `node_modules/` was already gitignored.
- `puppeteer-core` (not `puppeteer`) driving the **system Chrome** via `CHROME_PATH`, so no
  ~120MB pinned Chromium is downloaded and the tests exercise a real, current browser.
- `tests/helpers/server.js` — zero-dependency static server over `dist/`. Serving over loopback
  rather than `file://` is required, not cosmetic: `file://` blocks the catalog-index `fetch()`
  and changes `history.pushState` behaviour, so `file://` tests would prove nothing.
- `tests/unit/engine.test.js` — loads the shipped `assets/js/portfolio.js` into a `node:vm`
  context, so the tests can never drift from a copy of the engine.
- `tests/e2e/portfolio.test.js` — **behaviour** tests only. They assert what a visitor observes
  (counts, cards, URL, back/forward) and never the shape of the sidebar, so they must keep
  passing across the rail rebuild. Anything here that breaks is a real regression, not a test
  needing an update. Every page is instrumented to fail on any `pageerror`, `console.error`, or
  failed request — a silent JS failure otherwise hides behind an intact server-rendered page.

One three-line change to production JS was needed to make the engine reachable: the IIFE now
publishes `{Engine, CatalogEngine, FACET_KEYS}` and returns early when `document` is undefined.
In a browser this sets one property on `window` and changes no behaviour.

Baseline captured before implementation — `npm test`: **36 passing, 0 failing**;
`go test ./...`: all packages pass.

Performance (criterion 14) is measured, not asserted: a DevTools recording of one facet toggle
before and after, kept in the PR description.

## Rollback

`git revert` the single commit. `dist/` is gitignored and regenerated by `finevines build`, so
nothing persists. No migration, no schema change, no external state, no cache to invalidate — the
catalog-index filename is content-hashed and is not touched by this work.

**Nothing here is irreversible.**

## Stop conditions

The six formal blockers from `references/authority-and-evidence.md` §5. Package-specific
restatements:

- **§5.5 repository-state conflict** — the enrich/`wines.json` edits listed under Preserved scope
  are another session's. If a commit here is found to contain any of them, stop and unwind rather
  than amending forward.
- **§5.6 acceptance criteria unreachable without expanding scope** — if criterion 12 (no-JS)
  cannot be met without server-side facet filtering, stop; that is a different architecture and
  needs a decision, not an improvisation.

Everything else — failing tests, styling iterations, a second review pass, the length of the job
— is ordinary work. Continue through it without asking.

## Deliverables

- `templates/portfolio.html.tmpl` — seeded rail
- `assets/js/portfolio.js` — `FacetRail` module
- `assets/js/filters.js` — drawer CTA
- `assets/css/site.css` — rail styles + semantic token aliases
- `internal/build/build.go` — counted, ranked, capped `buildFacets`
- `internal/build/build_test.go` — extended assertions
- Issue #4 updated with the before/after page-weight and render measurements
- Two follow-up issues filed: inventory badges, facet landing pages
- This document, moved to `Status: closed` at completion

---

## Design assurance

Checked = evidence exists, cited.

- [x] **Authority** — no ADR register exists in this repo (`ls docs/adr` → not found), so there is
  no accepted architecture decision to check against. The governing documents are `CLAUDE.md` and
  `docs/superpowers/specs/2026-07-03-finevines-static-site-design.md`. The portfolio's current
  client/server split is owned by the header comments in `templates/portfolio.html.tmpl:1-31` and
  `assets/js/portfolio.js:1-17`, which state the contract explicitly; this work stays inside it.
- [x] **Data flow** — traced end to end, not assumed: `data/wines.json` → `buildFacets`
  (`build.go:483`) → `facetGroup` → `portfolio.html.tmpl:67-80` → checkbox DOM; and separately
  `wines.json` → `writeCatalogIndex` (`build.go:540`) → hashed JSON → `CatalogEngine.load` →
  `Engine.query` → `facetCounts` → `updateFacetCounts`. The rail is fed by the **second** path
  after hydration; the first path only seeds first paint.
- [x] **Bounds** — max 310 values in one group; ~577 across all five; 2,666 wines. `query()` is
  one O(n·k) ≈ 13k-op pass and already runs on every keystroke today. Sorting 577 row objects per
  render is sub-millisecond. Rendered rows are capped at 12/group (or the scroll-capped full list
  on "show all"). No unbounded growth: the catalog is a wholesale portfolio, not user content.
- [x] **States** — per group: `{open, query, showAll, sortMode}`, product with `{selected}` from
  the URL. Illegal states named: `showAll` while `query` is non-empty is not reachable (a query
  bypasses the cap, and the expander is hidden); a checked value with count 0 is legal and must
  render enabled; a group with zero rows and a non-empty query renders the "No match" line, not
  an empty box.
- [x] **Negative cases** — enumerated: catalog-index fetch fails (rail stays as the server seed,
  today's behaviour, no crash); a URL selects a facet value that no longer exists in the catalog
  (must render as a chip and a checked zero row, and be removable — otherwise it is unclearable);
  empty facet values (already skipped in `buildFacets:507`); a group's filter query matching
  nothing; every value filtered out by another facet.
- [x] **Stale evidence** — the server seed is top-12 by *global* count, while the client's first
  render is top-12 given the URL's selections. Landing on `/portfolio/?region=Burgundy` therefore
  shows a global seed for ~one frame before JS corrects it. Same class as today's card hydration
  flash; accepted, and named so it is not later mistaken for a bug.
- [x] **Duplication** — a checked value must appear exactly once even though it can arrive from
  two sources: `facetCounts[k]` keys (when count > 0) and `state.facets[k]` (when it has fallen
  to zero). Union them through a `Set` keyed on the value string, or the row renders twice.
- [x] **Observability** — an operator can verify the whole thing from the rendered page: counts
  are visible next to every value, the group header carries the available total, and the result
  counter is on screen. No debugger needed. Build-side, `grep -c 'data-facet='` on the output is
  the one-command check.
- [x] **Failure semantics** — fail *open*, deliberately: if the index fetch or the rail build
  throws, the server-rendered seed and the crawlable prev/next pagination remain and the visitor
  can still browse the catalog. A filter rail is not a security boundary; showing more wines than
  intended is the correct failure direction. Wrap the rail build in the existing `.catch()` at
  `portfolio.js:500`.
- [x] **Security** — no new input reaches the DOM as markup. Group filter queries are matched
  against value strings and never interpolated; rows are built through `document.createElement` +
  `textContent`, mirroring `createCard` (`portfolio.js:280-334`). No new network calls, no
  credentials, no user-generated content anywhere in this path.
- [x] **Interruption / retry / idempotence** — N/A for a static page build and a pure client
  render. `render()` is idempotent: same state in, same DOM out. A build interrupted mid-write
  leaves a partial `dist/`, which the next build overwrites; that is pre-existing and unchanged.
- [x] **Identities** — facet values are their own identity (the value string is the URL param
  value, the checkbox `value`, and the `facetCounts` key). No new IDs introduced. Values are not
  slugged, so a producer renamed in Salesforce breaks any shared link containing it — pre-existing
  behaviour, unchanged by this work, and the reason the zero-count-but-selected case above must
  stay removable.
- [x] **Ordering** — matters, and is guaranteed: count desc → label asc, an explicit total order,
  applied identically in Go (`sort.Slice` with a full comparator) and JS (`Array.sort` with the
  same). Required by `TestBuildIsDeterministic`.
- [ ] **Clocks** — N/A. Nothing in this path reads a clock. Vintage is an opaque string sorted
  lexically descending, not a date.
- [ ] **Partial failure** — N/A. Single-file build output and a single synchronous DOM render;
  there is no multi-target publish, no transaction, nothing to half-apply.
- [ ] **Migration** — N/A. No persisted state, no schema, no versioned artifact. The one piece of
  client-persisted state is the Cards/List preference in `localStorage` under `fv-portfolio-view`
  (`portfolio.js:172`), which this work does not touch and whose key does not change.

### Does this need an ADR?

**No.** This is implementation detail under the already-accepted architecture — the
server-renders-a-page / client-owns-interaction split is stated in
`templates/portfolio.html.tmpl:1-31` and `assets/js/portfolio.js:1-17` and is not being changed.
No invariant, boundary, ownership, or canonical model moves; no dependency, protocol, persistence,
or security strategy is introduced; the URL contract is explicitly preserved; and the whole thing
reverts with one `git revert`.

The one decision with a durable trade-off — *dropping ~493 facet strings from crawlable HTML* — is
recorded here under Background with its evidence, and the repo has no ADR register to file it in.
If `governance-bootstrap` later stands one up, this is a candidate to backfill.

## Knowledge capture

Candidate lessons (see `knowledge-capture`; not yet promoted):

1. **A faceted search engine's per-facet counts are already the row set.** `Engine.query` returns
   `facetCounts[facet][value]` for exactly the values with a non-zero count under the *other*
   facets. A "which values should this group show" question therefore needs no separate index and
   no extra pass — only a union with the currently-selected values. Worth remembering before
   anyone builds a parallel facet-value store.
2. **"Remove it from HTML and lose SEO" is usually testable, not arguable.** Here the answer came
   from checking whether the strings appeared anywhere else on the site — they did, on 2,666
   detail pages — which converted a judgment call into a measurement. Retirement condition: stops
   applying if the catalog ever stops generating per-wine detail pages.
