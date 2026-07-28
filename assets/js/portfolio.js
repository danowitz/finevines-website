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
    // matchesFacetsExcept applies every selected facet EXCEPT `except` (pass
    // null to apply them all). This one predicate powers both the final filter
    // and the per-facet counts.
    function matchesFacetsExcept(it, except) {
      for (var i = 0; i < FACET_KEYS.length; i++) {
        var k = FACET_KEYS[i];
        if (k === except) continue;
        var s = sel[k];
        if (s.size && !s.has(it[k])) return false;
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
      for (var ci = 0; ci < FACET_KEYS.length; ci++) {
        var k = FACET_KEYS[ci];
        var val = it[k];
        if (!val) continue;
        if (matchesFacetsExcept(it, k)) {
          facetCounts[k][val] = (facetCounts[k][val] || 0) + 1;
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

  // ---------------------------------------------------------------------------
  // 2. UI bootstrap.
  // ---------------------------------------------------------------------------

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
  var indexURL = grid.dataset.indexUrl;
  if (!indexURL) return;

  var searchBox = document.querySelector('#portfolio-search');
  var sortSelect = document.querySelector('#portfolio-sort');
  var countEl = document.querySelector('#portfolio-count');
  var emptyEl = document.querySelector('#portfolio-empty');
  var paginationEl = document.querySelector('.pagination');
  var checkboxes = document.querySelectorAll('.facet input[type=checkbox]');

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
  function syncControls() {
    if (searchBox) searchBox.value = state.q;
    if (sortSelect) sortSelect.value = state.sort;
    Array.prototype.forEach.call(checkboxes, function (box) {
      var set = state.facets[box.dataset.facet];
      box.checked = !!(set && set.has(box.value));
    });
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
    h3.textContent = spaceJoin(w.name, w.vintage);
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

  // updateFacetCounts writes the live count beside each checkbox and dims +
  // disables a value that would yield zero results given the OTHER active
  // facets (but never a value that's currently checked — that must stay
  // toggleable so the user can undo it).
  function updateFacetCounts(facetCounts) {
    Array.prototype.forEach.call(checkboxes, function (box) {
      var counts = facetCounts[box.dataset.facet] || {};
      var n = counts[box.value] || 0;
      var label = box.closest('label');
      var span = label && label.querySelector('.facet-count');
      if (span) span.textContent = n ? String(n) : '';
      var dead = n === 0 && !box.checked;
      box.disabled = dead;
      if (label) label.classList.toggle('is-empty', dead);
    });
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

    if (emptyEl) emptyEl.hidden = result.total !== 0;
    if (countEl) countEl.textContent = result.total.toLocaleString() + ' wines';
    updateFacetCounts(result.facetCounts);
    renderPagination(result.page, result.pageCount);
  }

  // --- Events --------------------------------------------------------------

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

    Array.prototype.forEach.call(checkboxes, function (box) {
      box.addEventListener('change', function () {
        var set = state.facets[box.dataset.facet];
        if (!set) return;
        if (box.checked) set.add(box.value); else set.delete(box.value);
        state.page = 1;
        commit(true);
      });
    });

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
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.q = '';
        for (var i = 0; i < FACET_KEYS.length; i++) state.facets[FACET_KEYS[i]] = new Set();
        state.page = 1;
        syncControls();
        commit(true);
      });
    }

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
