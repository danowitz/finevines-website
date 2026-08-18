// Client-side catalog for /portfolio/. Progressive enhancement over the
// server-rendered, paginated pages: each /portfolio/ and /portfolio/page/N/
// document ships ~48 real wine cards + crawlable prev/next links, so no-JS
// visitors and search crawlers can walk the whole catalog. When this script
// runs it fetches ONE compact, content-hashed catalog-index (browse fields
// only — no descriptions) and, from then on, does ALL filtering, sorting, and
// pagination in the browser, replacing the grid with only the current 48
// cards. So at most ~48 cards ever live in the DOM under JS, versus the ~2,600
// the old single-page portfolio pre-rendered (2MB HTML, ~65k nodes, ~12s on 3G).
//
// The module has two clean halves:
//   1. CatalogEngine — a PURE data engine. `await CatalogEngine.load(url)` then
//      `engine.query({search, selectedFacets, sort, page, pageSize})`. No DOM,
//      no URL, no globals; it just turns state → results. Trivially testable.
//   2. The UI bootstrap — reads state from the URL query string, drives the
//      controls, calls the engine, renders the grid/counts/pagination, and
//      writes state back to the URL so refresh/back/forward/shared links work.
(function () {
  'use strict';

  // The facet keys, in one place. Each is simultaneously: a Wine field name in
  // the catalog-index, a checkbox's data-facet value, AND a URL query-param
  // name — so producer selections round-trip as ?producer=…&producer=… . Must
  // stay in lock-step with build.go's buildFacets specs.
  var FACET_KEYS = ['producer', 'region', 'varietal', 'country', 'vintage'];

  // ---------------------------------------------------------------------------
  // 1. CatalogEngine — pure query engine over the catalog-index.
  // ---------------------------------------------------------------------------

  function Engine(items) {
    this.items = items;
    // Precompute one lower-cased haystack per wine for free-text search over
    // producer + name + region + varietal, so query() never re-builds strings.
    for (var i = 0; i < items.length; i++) {
      var w = items[i];
      w._search = (w.producer + ' ' + w.name + ' ' + w.region + ' ' + w.varietal).toLowerCase();
    }
    // ONE cached collator for every sort (creating an Intl.Collator per compare
    // is very expensive). numeric:true keeps "Château 2" before "Château 10";
    // 'base' sensitivity makes sorting accent/case-insensitive, which reads
    // right for a wine list.
    this.collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  }

  // vintageKey turns a vintage string into a sortable number, or null for
  // empty / non-numeric values ("", "NV", "MV") which must sort LAST.
  function vintageKey(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  // _comparator returns a sort function for the given key. Producer/name/region
  // sort by the cached collator with name as a stable tiebreak; vintage sorts
  // numerically ascending with empties/NV pushed to the end.
  Engine.prototype._comparator = function (sort) {
    var c = this.collator;
    if (sort === 'vintage') {
      return function (a, b) {
        var av = vintageKey(a.vintage), bv = vintageKey(b.vintage);
        if (av === null && bv === null) return c.compare(a.name, b.name);
        if (av === null) return 1;   // a has no vintage → after b
        if (bv === null) return -1;  // b has no vintage → after a
        if (av !== bv) return av - bv;
        return c.compare(a.name, b.name);
      };
    }
    var key = (sort === 'name' || sort === 'region') ? sort : 'producer';
    return function (a, b) {
      // Wines missing the sort field go LAST (matching the vintage rule) —
      // otherwise "sort by producer" leads with every producerless wine.
      var ae = !a[key], be = !b[key];
      if (ae !== be) return ae ? 1 : -1;
      var r = c.compare(a[key] || '', b[key] || '');
      return r !== 0 ? r : c.compare(a.name, b.name);
    };
  };

  // query runs the full pipeline: filter → facet-count → sort → paginate.
  // Facet semantics: OR within one facet (any selected producer matches), AND
  // between facets (must match the producer set AND the region set …). Returns
  // { items, total, facetCounts, pageCount, page } where items is just the
  // requested page's slice and facetCounts[facet][value] is the count that
  // value WOULD yield given every OTHER active facet (the standard faceted
  // count, so a facet's own options never zero themselves out).
  Engine.prototype.query = function (opts) {
    opts = opts || {};
    var q = (opts.search || '').trim().toLowerCase();
    var pageSize = opts.pageSize || 48;

    // Normalise selectedFacets to Sets keyed by FACET_KEYS.
    var sel = {};
    for (var f = 0; f < FACET_KEYS.length; f++) {
      var key = FACET_KEYS[f];
      var v = opts.selectedFacets && opts.selectedFacets[key];
      sel[key] = (v instanceof Set) ? v : new Set(v || []);
    }

    function matchesSearch(it) {
      return !q || it._search.indexOf(q) !== -1;
    }
    // facetValues returns every value an entry carries for a facet. All facets
    // are single-valued except vintage: a card that collapses several vintages
    // of one wine ships the full list in `vints` (newest first; `vintage`
    // stays the newest year for sorting) — the card must match ANY of them.
    function facetValues(it, k) {
      if (k === 'vintage' && it.vints && it.vints.length) return it.vints;
      return it[k] ? [it[k]] : [];
    }
    function hasAny(s, values) {
      for (var i = 0; i < values.length; i++) if (s.has(values[i])) return true;
      return false;
    }
    // matchesFacetsExcept applies every selected facet EXCEPT `except` (pass
    // null to apply them all). This one predicate powers both the final filter
    // and the per-facet counts.
    function matchesFacetsExcept(it, except) {
      for (var i = 0; i < FACET_KEYS.length; i++) {
        var k = FACET_KEYS[i];
        if (k === except) continue;
        var s = sel[k];
        if (s.size && !hasAny(s, facetValues(it, k))) return false;
      }
      return true;
    }

    var items = this.items;
    var filtered = [];
    // facetCounts[facet] = { value: count } built in the same single pass.
    var facetCounts = {};
    for (var fi = 0; fi < FACET_KEYS.length; fi++) facetCounts[FACET_KEYS[fi]] = Object.create(null);

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!matchesSearch(it)) continue;
      // Full filter (all facets) → results.
      if (matchesFacetsExcept(it, null)) filtered.push(it);
      // Per-facet counts: for facet k, count it when all facets EXCEPT k match.
      // A collapsed card counts once under EACH of its vintages.
      for (var ci = 0; ci < FACET_KEYS.length; ci++) {
        var k = FACET_KEYS[ci];
        var vals = facetValues(it, k);
        if (!vals.length) continue;
        if (matchesFacetsExcept(it, k)) {
          for (var vi = 0; vi < vals.length; vi++) {
            facetCounts[k][vals[vi]] = (facetCounts[k][vals[vi]] || 0) + 1;
          }
        }
      }
    }

    filtered.sort(this._comparator(opts.sort));

    var total = filtered.length;
    var pageCount = Math.max(1, Math.ceil(total / pageSize));
    var page = Math.min(Math.max(1, opts.page || 1), pageCount);
    var start = (page - 1) * pageSize;

    return {
      items: filtered.slice(start, start + pageSize),
      total: total,
      facetCounts: facetCounts,
      pageCount: pageCount,
      page: page
    };
  };

  var CatalogEngine = {
    load: function (indexURL) {
      return fetch(indexURL)
        .then(function (r) {
          if (!r.ok) throw new Error('catalog-index ' + r.status);
          return r.json();
        })
        .then(function (items) { return new Engine(items); });
    }
  };

  // Expose the pure half for tests (tests/unit/engine.test.js loads this exact
  // file — not a copy — into a node:vm context, so what the tests exercise is
  // byte-for-byte what ships). In a browser `module` is undefined and this just
  // sets one property on window; no behaviour changes either way. Deliberately
  // placed BEFORE the DOM bootstrap below, which returns early off-page.
  var api = { Engine: Engine, CatalogEngine: CatalogEngine, FACET_KEYS: FACET_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof globalThis !== 'undefined') globalThis.FineVinesCatalog = api;

  // ---------------------------------------------------------------------------
  // 2. UI bootstrap.
  // ---------------------------------------------------------------------------

  // No document at all → we are under Node in the unit tests; the engine above
  // is all they need, and everything past here is DOM wiring.
  if (typeof document === 'undefined') return;

  var grid = document.querySelector('.wine-grid');
  if (!grid) return;

  // View toggle (Cards | List). Wired up synchronously so it works even if the
  // catalog-index fetch below fails — it only swaps a class on the grid, which
  // both server- and JS-rendered cards honour.
  (function setupViewToggle() {
    var buttons = document.querySelectorAll('.view-toggle-btn');
    if (!buttons.length) return;
    var KEY = 'fv-portfolio-view';
    function setView(view) {
      var list = view === 'list';
      grid.classList.toggle('view-list', list);
      grid.classList.toggle('view-cards', !list);
      Array.prototype.forEach.call(buttons, function (b) {
        var active = b.dataset.view === view;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      try { localStorage.setItem(KEY, view); } catch (e) { /* ignore */ }
    }
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
    if (saved === 'list' || saved === 'cards') setView(saved);
    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });
  })();

  // Config from the grid's data-attributes (server ↔ client single source).
  var BASE = '/portfolio/'; // the client always operates against this path
  var PAGE_SIZE = parseInt(grid.dataset.pageSize, 10) || 48;
  var WINE_TOTAL = parseInt(grid.dataset.wineTotal, 10) || 0;
  var indexURL = grid.dataset.indexUrl;
  if (!indexURL) return;

  var searchBox = document.querySelector('#portfolio-search');
  var sortSelect = document.querySelector('#portfolio-sort');
  var countEl = document.querySelector('#portfolio-count');
  var emptyEl = document.querySelector('#portfolio-empty');
  var paginationEl = document.querySelector('.pagination');
  var facetsEl = document.querySelector('#portfolio-facets');
  var chipsEl = document.querySelector('#portfolio-chips');
  var applyCountEl = document.querySelector('.facets-apply-count');
  var railCountEl = document.querySelector('.facets-count');

  // TOP_N must equal facetSeedSize in internal/build/build.go. The server seeds
  // each big group with exactly this many values; if the two disagreed the list
  // would visibly change length the moment the catalog-index landed.
  var TOP_N = 12;

  // The live UI state. Facets are Sets of selected values keyed by FACET_KEYS.
  var state = { q: '', facets: {}, sort: 'producer', page: 1 };
  var engine = null;

  // --- URL <-> state -------------------------------------------------------

  // readState reconstructs state from the URL. Facets and free text come from
  // the query string; the page number comes from ?page, falling back to a
  // /portfolio/page/N/ path segment so someone landing on (or a crawler
  // following) a server pagination link starts on the right page rather than
  // being bounced to page 1.
  function readState() {
    var params = new URLSearchParams(location.search);
    var facets = {};
    for (var i = 0; i < FACET_KEYS.length; i++) {
      facets[FACET_KEYS[i]] = new Set(params.getAll(FACET_KEYS[i]));
    }
    var page = parseInt(params.get('page') || '', 10);
    if (!(page >= 1)) {
      var m = location.pathname.match(/\/portfolio\/page\/(\d+)\/?$/);
      page = m ? parseInt(m[1], 10) : 1;
    }
    return {
      q: params.get('q') || '',
      facets: facets,
      sort: params.get('sort') || 'producer',
      page: page
    };
  }

  // queryString serialises state to a canonical query string. Defaults
  // (empty search, producer sort, page 1) are omitted so a pristine view has a
  // clean /portfolio/ URL and shared links stay tidy.
  function queryString(st) {
    var params = new URLSearchParams();
    if (st.q) params.set('q', st.q);
    for (var i = 0; i < FACET_KEYS.length; i++) {
      var k = FACET_KEYS[i];
      st.facets[k].forEach(function (v) { params.append(k, v); });
    }
    if (st.sort && st.sort !== 'producer') params.set('sort', st.sort);
    if (st.page && st.page > 1) params.set('page', String(st.page));
    var s = params.toString();
    return s ? '?' + s : '';
  }

  function urlFor(st) { return BASE + queryString(st); }

  // commit writes state to the URL then re-renders. push=true adds a history
  // entry (discrete actions: facet/sort/page changes); push=false replaces it
  // (debounced typing, so a search doesn't spam the back button).
  function commit(push) {
    var url = urlFor(state);
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    render();
  }

  // syncControls reflects state INTO the DOM controls (used on first paint and
  // on popstate, where the URL — not a control — is the source of truth).
  // The facet rows are NOT touched here: they are re-rendered wholesale from
  // the query result, which is the only place their checked state comes from.
  function syncControls() {
    if (searchBox) searchBox.value = state.q;
    if (sortSelect) sortSelect.value = state.sort;
  }

  // --- Rendering -----------------------------------------------------------

  // createCard builds a <li><a class="wine-card">…</a></li> IDENTICAL to the
  // server-rendered markup in portfolio.html.tmpl, so swapping server cards for
  // JS cards is seamless. Built via the DOM (not innerHTML) so any producer/
  // name text is inserted safely as text, never parsed as markup.
  // spaceJoin mirrors build.go's spaceJoin: join the non-empty parts with a
  // single space, so a missing producer/vintage never leaves a double space.
  function spaceJoin() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
      var p = (arguments[i] || '').trim();
      if (p) out.push(p);
    }
    return out.join(' ');
  }

  function createCard(w) {
    var li = document.createElement('li');
    li.dataset.slug = w.slug;

    var a = document.createElement('a');
    a.className = 'wine-card';
    a.href = '/wines/' + w.slug + '/';

    var thumb = document.createElement('div');
    thumb.className = 'thumb';
    var img = document.createElement('img');
    img.src = w.img; // catalog-index stores img with a leading slash
    img.alt = 'Bottle of ' + spaceJoin(w.producer, w.name, w.vintage);
    img.loading = 'lazy';
    thumb.appendChild(img);

    var body = document.createElement('div');
    body.className = 'body';
    // Producer, title, and meta each match the server template's conditionals
    // (build.go / portfolio.html.tmpl): omit an empty producer, omit the "·"
    // separator when only one of region/varietal is present, and drop the meta
    // line entirely when both are empty — so no card shows a stray separator.
    if (w.producer) {
      var producer = document.createElement('span');
      producer.className = 'producer';
      producer.textContent = w.producer;
      body.appendChild(producer);
    }
    var h3 = document.createElement('h3');
    h3.textContent = w.name;
    // A collapsed card lists every vintage in the group ("2019 · 2018", from
    // vints, newest first) — mirroring the template's VintLabel; a plain card
    // shows its single vintage as before.
    var vintLabel = (w.vints && w.vints.length) ? w.vints.join(' · ') : w.vintage;
    if (vintLabel) {
      // The vintage rides in its own de-emphasized span (see the template).
      h3.appendChild(document.createTextNode(' '));
      var vint = document.createElement('span');
      vint.className = 'vintage';
      vint.textContent = vintLabel;
      h3.appendChild(vint);
    }
    body.appendChild(h3);
    if (w.region || w.varietal) {
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = (w.region && w.varietal) ? (w.region + ' · ' + w.varietal) : (w.region || w.varietal);
      body.appendChild(meta);
    }
    a.appendChild(thumb);
    a.appendChild(body);
    li.appendChild(a);
    return li;
  }

  // ---------------------------------------------------------------------------
  // The facet rail.
  // ---------------------------------------------------------------------------
  //
  // The sidebar is rebuilt from the query result rather than being a static
  // list the server printed. That is what makes 310 producers usable: only the
  // twelve highest-count values are on screen at rest, ranked by how many wines
  // they actually yield, with a filter box to reach the rest.
  //
  // It costs no extra data. Engine.query already returns facetCounts[facet] —
  // exactly the values with a non-zero count given the OTHER active facets — so
  // the count map IS the row set. The only thing it lacks is a value the user
  // has selected which has since fallen to zero; that is unioned back in below,
  // because a selection you cannot see is a selection you cannot undo.
  //
  // Per-group UI state (open / query / show-all / sort) is deliberately NOT in
  // the URL. Only selections are, so shared links stay short and stable and the
  // pre-existing ?producer=…&region=… contract is untouched.
  var railState = {};   // facet -> { query, showAll, alpha }
  var lastCounts = {};  // last query's facetCounts, so typing can re-render one
                        // group without re-running the engine
  var pendingFocus = null;

  function groupState(key) {
    if (!railState[key]) railState[key] = { query: '', showAll: false, alpha: false };
    return railState[key];
  }

  function groupEls() {
    return facetsEl ? facetsEl.querySelectorAll('[data-facet-group]') : [];
  }

  // rowsFor builds the full candidate row list for one group: every value with
  // a live count, plus any selected value that has dropped to zero.
  function rowsFor(key, counts) {
    var sel = state.facets[key] || new Set();
    var rows = [];
    var seen = Object.create(null);
    for (var value in counts) {
      seen[value] = true;
      rows.push({ value: value, count: counts[value], checked: sel.has(value) });
    }
    sel.forEach(function (value) {
      // A selected value with no remaining matches. It must still render —
      // enabled — or the only way out of the filter would be editing the URL.
      if (!seen[value]) rows.push({ value: value, count: 0, checked: true });
    });
    return rows;
  }

  // sortRows ranks a group. Checked values are pinned to the top so a selection
  // never scrolls out of reach; the rest go by count desc (or A–Z on request),
  // with the value as a final tiebreak so ordering is total and stable.
  function sortRows(rows, key, isGrid) {
    if (isGrid) {
      // Vintage reads as a chronology, not a popularity chart.
      return rows.sort(function (a, b) { return b.value.localeCompare(a.value); });
    }
    var alpha = groupState(key).alpha;
    return rows.sort(function (a, b) {
      if (a.checked !== b.checked) return a.checked ? -1 : 1;
      if (!alpha && a.count !== b.count) return b.count - a.count;
      return a.value.localeCompare(b.value);
    });
  }

  function createRow(key, row) {
    var label = document.createElement('label');
    label.className = 'facet-row' + (row.checked ? ' is-checked' : '') +
      (row.count === 0 && !row.checked ? ' is-empty' : '');
    label.title = row.value + ': ' + row.count + (row.count === 1 ? ' wine' : ' wines');

    var box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.facet = key;
    box.value = row.value;
    box.checked = row.checked;

    var mark = document.createElement('span');
    mark.className = 'facet-box';
    mark.setAttribute('aria-hidden', 'true');

    var text = document.createElement('span');
    text.className = 'facet-label';
    text.textContent = row.value; // textContent, never innerHTML — see createCard

    var count = document.createElement('span');
    count.className = 'facet-count';
    count.textContent = String(row.count);

    label.appendChild(box);
    label.appendChild(mark);
    label.appendChild(text);
    label.appendChild(count);
    return label;
  }

  // renderGroup repaints exactly one group from the cached counts. Only the row
  // container's children are replaced — the filter input and sort control live
  // outside it, so typing can never destroy the element holding focus.
  function renderGroup(details) {
    var key = details.dataset.facetGroup;
    var isBig = details.dataset.big === '1';
    var isGrid = !!details.querySelector('.facet-values.is-grid');
    var gs = groupState(key);
    var counts = lastCounts[key] || {};

    var all = rowsFor(key, counts);
    var available = all.length;
    var query = gs.query.trim().toLowerCase();
    var matched = query
      ? all.filter(function (r) { return r.value.toLowerCase().indexOf(query) !== -1; })
      : all;
    sortRows(matched, key, isGrid);

    // A query bypasses the cap: if you searched for it, you should see it.
    var capped = isBig && !gs.showAll && !query;
    var shown = capped ? matched.slice(0, TOP_N) : matched;

    var container = details.querySelector('[data-facet-values]');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < shown.length; i++) frag.appendChild(createRow(key, shown[i]));
    container.replaceChildren(frag);
    container.classList.toggle('is-scrolling', !capped && shown.length > TOP_N);

    // Header: how many values remain reachable, and how many are selected.
    var selCount = (state.facets[key] || new Set()).size;
    var totalEl = details.querySelector('.facet-total');
    if (totalEl) totalEl.textContent = String(available);
    var selEl = details.querySelector('.facet-selected');
    if (selEl) {
      selEl.textContent = String(selCount);
      selEl.hidden = selCount === 0;
    }
    details.classList.toggle('has-selection', selCount > 0);

    var matchEl = details.querySelector('.facet-match');
    if (matchEl) {
      matchEl.textContent = query
        ? matched.length + ' matching'
        : (gs.showAll ? 'All ' + matched.length : 'Top ' + Math.min(TOP_N, matched.length) + ' by wine count');
    }
    var sortEl = details.querySelector('.facet-sort');
    if (sortEl) sortEl.textContent = gs.alpha ? 'A–Z' : 'Most wines';

    var expander = details.querySelector('.facet-expander');
    if (expander) {
      // Hidden while a query is active — "show all" is meaningless when the
      // list is already the full set of matches.
      expander.hidden = !!query || matched.length <= TOP_N;
      expander.textContent = gs.showAll
        ? 'Show fewer'
        : 'Show all ' + matched.length + ' ' + details.querySelector('.facet-name').textContent.toLowerCase() + 's';
    }

    var emptyEl2 = details.querySelector('.facet-empty');
    if (emptyEl2) {
      emptyEl2.hidden = shown.length !== 0;
      emptyEl2.textContent = query ? 'No match for “' + gs.query.trim() + '”.' : 'No values available.';
    }
  }

  // renderChips rebuilds the selected-value summary at the top of the rail.
  function renderChips() {
    if (!chipsEl) return;
    var list = chipsEl.querySelector('.facet-chips-list');
    var frag = document.createDocumentFragment();
    var n = 0;
    for (var i = 0; i < FACET_KEYS.length; i++) {
      var key = FACET_KEYS[i];
      // Bind key/value per iteration — a closure over the loop variable would
      // give every chip the last facet's key.
      (function (facet) {
        (state.facets[facet] || new Set()).forEach(function (value) {
          n++;
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'facet-chip';
          chip.dataset.chipFacet = facet;
          chip.dataset.chipValue = value;
          chip.setAttribute('aria-label', 'Remove filter ' + value);
          var text = document.createElement('span');
          text.textContent = value;
          var x = document.createElement('span');
          x.className = 'facet-chip-x';
          x.setAttribute('aria-hidden', 'true');
          x.textContent = '✕';
          chip.appendChild(text);
          chip.appendChild(x);
          frag.appendChild(chip);
        });
      })(key);
    }
    list.replaceChildren(frag);
    chipsEl.hidden = n === 0;
  }

  // renderRail repaints every group plus the chip summary. Called once per
  // query; at rest that is ~12 rows per OPEN group, versus the 577 checkboxes
  // the previous implementation walked on every single render.
  function renderRail(facetCounts, total) {
    lastCounts = facetCounts;
    var groups = groupEls();
    for (var i = 0; i < groups.length; i++) renderGroup(groups[i]);
    renderChips();
    if (applyCountEl) applyCountEl.textContent = total.toLocaleString();
    restoreFocus();
  }

  // restoreFocus puts the caret back on the checkbox the user just toggled.
  // Rows are transient DOM, so without this every keyboard interaction would
  // drop focus to <body> and lose the reader's place in the list.
  function restoreFocus() {
    if (!pendingFocus || !facetsEl) return;
    var sel = '[data-facet="' + CSS.escape(pendingFocus.facet) + '"][value="' +
      CSS.escape(pendingFocus.value) + '"]';
    var box = facetsEl.querySelector(sel);
    if (box) box.focus();
    pendingFocus = null;
  }

  // renderPagination rebuilds the prev/next nav for client-side paging. Links
  // point at the query-string URLs the JS pushes (kept shareable), and the
  // whole nav is hidden when there's only one page.
  function renderPagination(page, pageCount) {
    if (!paginationEl) return;
    paginationEl.hidden = pageCount <= 1;
    paginationEl.textContent = '';

    function control(label, target, cls, rel) {
      var el;
      if (target) {
        el = document.createElement('a');
        el.href = urlFor(withPage(state, target));
        el.dataset.page = String(target);
        if (rel) el.rel = rel;
      } else {
        el = document.createElement('span');
        el.className += ''; // no-op, kept for symmetry
        el.setAttribute('aria-disabled', 'true');
      }
      el.className = 'pagination-btn ' + cls + (target ? '' : ' is-disabled');
      el.textContent = label;
      return el;
    }

    var status = document.createElement('span');
    status.className = 'pagination-status';
    status.textContent = 'Page ' + page + ' of ' + pageCount;

    paginationEl.appendChild(control('Previous', page > 1 ? page - 1 : 0, 'pagination-prev', 'prev'));
    paginationEl.appendChild(status);
    paginationEl.appendChild(control('Next', page < pageCount ? page + 1 : 0, 'pagination-next', 'next'));
  }

  function withPage(st, page) {
    return { q: st.q, facets: st.facets, sort: st.sort, page: page };
  }

  // render is the single paint path: query the engine with the current state,
  // then update grid + counter + facet counts + pagination. It NEVER touches
  // the URL (commit does that) so it can be called from popstate too.
  function render() {
    if (!engine) return;
    var result = engine.query({
      search: state.q,
      selectedFacets: state.facets,
      sort: state.sort,
      page: state.page,
      pageSize: PAGE_SIZE
    });
    // The engine clamps the page into range (e.g. after a filter shrinks the
    // result set); adopt its clamped value so the URL/nav stay honest.
    state.page = result.page;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < result.items.length; i++) frag.appendChild(createCard(result.items[i]));
    grid.replaceChildren(frag);

    var hasFilters = state.q.trim() !== '';
    for (var fi = 0; fi < FACET_KEYS.length; fi++) {
      if ((state.facets[FACET_KEYS[fi]] || new Set()).size > 0) hasFilters = true;
    }
    // At rest, keep the customer-facing count aligned with the homepage and
    // email even though the browse cards are grouped. Once someone filters,
    // show the number of matching cards so the controls remain useful.
    var displayTotal = !hasFilters && WINE_TOTAL > 0 ? WINE_TOTAL : result.total;
    if (emptyEl) emptyEl.hidden = result.total !== 0;
    if (countEl) countEl.textContent = displayTotal.toLocaleString() + ' wines';
    if (railCountEl) railCountEl.textContent = displayTotal.toLocaleString() + ' wines';
    renderRail(result.facetCounts, displayTotal);
    renderPagination(result.page, result.pageCount);
  }

  // --- Events --------------------------------------------------------------

  // clearAll resets every filter in one action — the search box, every facet
  // selection, and each group's own filter-within-group query, which would
  // otherwise survive as an invisible constraint on a rail that claims to be
  // cleared. Reachable from both the empty state and the rail's chip summary.
  function clearAll() {
    state.q = '';
    for (var i = 0; i < FACET_KEYS.length; i++) state.facets[FACET_KEYS[i]] = new Set();
    for (var key in railState) railState[key].query = '';
    if (facetsEl) {
      Array.prototype.forEach.call(facetsEl.querySelectorAll('.facet-filter'), function (el) {
        el.value = '';
      });
    }
    state.page = 1;
    syncControls();
    commit(true);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function wireEvents() {
    if (searchBox) {
      // Debounce typing (~120ms) and use replaceState so a search doesn't fill
      // the back-button history with one entry per keystroke.
      searchBox.addEventListener('input', debounce(function () {
        state.q = searchBox.value.trim();
        state.page = 1;
        commit(false);
      }, 120));
    }

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        state.sort = sortSelect.value;
        state.page = 1;
        commit(true);
      });
    }

    // The rail is wired entirely by DELEGATION. Value rows are re-rendered on
    // every query, so a listener bound to an individual checkbox would be
    // discarded on the first repaint and the group would silently go dead.
    if (facetsEl) {
      facetsEl.addEventListener('change', function (e) {
        var box = e.target.closest('input[data-facet]');
        if (!box) return;
        var set = state.facets[box.dataset.facet];
        if (!set) return;
        if (box.checked) set.add(box.value); else set.delete(box.value);
        // Remember where the caret was; the row is about to be replaced.
        pendingFocus = { facet: box.dataset.facet, value: box.value };
        state.page = 1;
        commit(true);
      });

      // Filter-within-group. Repaints ONLY that group, and only from the
      // cached counts — narrowing a list of value names cannot change which
      // wines match, so re-running the engine here would be pure waste.
      facetsEl.addEventListener('input', debounce(function (e) {
        var input = e.target.closest('.facet-filter');
        if (!input) return;
        groupState(input.dataset.facetFilter).query = input.value;
        var details = input.closest('[data-facet-group]');
        if (details) renderGroup(details);
      }, 80));

      facetsEl.addEventListener('click', function (e) {
        var sortBtn = e.target.closest('.facet-sort');
        if (sortBtn) {
          var gs = groupState(sortBtn.dataset.facetSort);
          gs.alpha = !gs.alpha;
          renderGroup(sortBtn.closest('[data-facet-group]'));
          return;
        }

        var expand = e.target.closest('.facet-expander');
        if (expand) {
          var es = groupState(expand.dataset.facetExpand);
          es.showAll = !es.showAll;
          renderGroup(expand.closest('[data-facet-group]'));
          return;
        }

        var chip = e.target.closest('.facet-chip');
        if (chip) {
          var set = state.facets[chip.dataset.chipFacet];
          if (set) set.delete(chip.dataset.chipValue);
          state.page = 1;
          commit(true);
          return;
        }

        if (e.target.closest('.facet-clear')) {
          clearAll();
          return;
        }

        // Drawer "Show N wines" — commits nothing (filtering is already live)
        // and simply dismisses the panel. filters.js owns the close.
        if (e.target.closest('.facets-apply')) {
          var toggle = document.querySelector('.filters-toggle');
          var closeBtn = facetsEl.querySelector('.facets-close');
          if (closeBtn) closeBtn.click();
          if (toggle) toggle.focus();
        }
      });

      // NOTE: opening a group deliberately does NOT trigger a render.
      // renderRail repaints every group on every query — closed ones included —
      // so a group's rows are already correct by the time it is expanded.
      // Re-rendering on <details> toggle would be pure duplicate work, and
      // because the toggle event fires ASYNCHRONOUSLY it would also swap the
      // rows out from under a click that had already targeted one, detaching
      // the node mid-gesture.
    }

    // Delegated click handling for the (rebuilt-every-render) pagination links.
    if (paginationEl) {
      paginationEl.addEventListener('click', function (e) {
        var a = e.target.closest('a[data-page]');
        if (!a) return;
        e.preventDefault();
        state.page = parseInt(a.dataset.page, 10) || 1;
        commit(true);
        // Bring the top of the grid into view — a paged jump otherwise leaves
        // you scrolled to where the old page's bottom was.
        var top = document.querySelector('.portfolio-toolbar');
        if (top) top.scrollIntoView({ block: 'start' });
      });
    }

    var clearBtn = emptyEl && emptyEl.querySelector('.portfolio-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearAll);

    // Back/forward: rebuild state from the URL and repaint without pushing.
    window.addEventListener('popstate', function () {
      state = readState();
      syncControls();
      render();
    });
  }

  // --- Boot ----------------------------------------------------------------

  state = readState();
  syncControls(); // reflect the URL into the controls before the index arrives

  // Open any group the URL has selected into. Producer/region/varietal ship
  // collapsed, so without this a shared link would apply a filter the visitor
  // could see in the results but not find in the rail.
  Array.prototype.forEach.call(groupEls(), function (details) {
    var set = state.facets[details.dataset.facetGroup];
    if (set && set.size) details.open = true;
  });

  CatalogEngine.load(indexURL).then(function (e) {
    engine = e;
    wireEvents();
    render();
  }).catch(function () {
    // Fetch/parse failed: leave the server-rendered page and its real prev/next
    // links intact. The view toggle (wired above) still works; the site simply
    // falls back to crawlable server pagination.
  });
})();
