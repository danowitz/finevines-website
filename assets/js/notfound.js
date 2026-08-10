// Turns dist/404.html from a signpost into a search.
//
// Anything that reaches this page is, by definition, a URL the redirect map
// did not know about — a wine that sold out and was delisted, a slug that
// moved when a producer's name was corrected, a link typed from a printed
// list, or one of the old site's 51,645 addresses that the crawl missed. The
// static page can only offer "here is the portfolio"; the visitor arrived
// wanting one specific bottle.
//
// So: read the path they asked for, and look for it in the same
// catalog-index the portfolio filters against. Two things make this cheap —
// the index is already built and content-hashed, and it carries the slug,
// producer, name and vintage list, which is everything needed to match on.
//
// DELIBERATELY NO AUTOMATIC REDIRECT. A JS hop off a 404 is a soft-404 to a
// search engine, and a fuzzy match is sometimes wrong — silently landing
// someone on a different wine is worse than showing them three candidates
// and letting them choose. A URL that genuinely SHOULD move belongs in
// data/lifecycle-redirects.json as a real 301 at the edge, not a guess made
// in the browser.
(function () {
  'use strict';

  var root = document.querySelector('#notfound-suggest');
  if (!root) return;

  var indexURL = root.dataset.indexUrl;
  var pathEl = document.querySelector('#notfound-path');

  // --- what did they ask for? ------------------------------------------

  // Section is the first path segment: "wines", "producers", "regions",
  // "varietals". Terms are the slug's words, which is what actually gets
  // matched — a slug is already lower-case and hyphen-separated, so it needs
  // no parsing beyond a split.
  function requested() {
    var parts = decodeURIComponent(location.pathname).split('/').filter(Boolean);
    if (!parts.length) return null;
    var section = parts[0].toLowerCase();
    // The last segment is the identifying one (/wines/<slug>/, and
    // /portfolio/page/12/ has nothing worth matching).
    var slug = (parts[parts.length - 1] || '').toLowerCase();
    // Drop a file extension so /wines/foo.html matches /wines/foo/.
    slug = slug.replace(/\.[a-z0-9]{2,5}$/, '');
    var terms = slug.split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
    return { section: section, slug: slug, terms: terms };
  }

  // Show the address that failed. Seeing it is often the whole answer — a
  // truncated paste or a stray character is obvious the moment it's on screen.
  var want = requested();
  if (pathEl && want) {
    pathEl.textContent = decodeURIComponent(location.pathname);
    pathEl.parentElement.hidden = false;
  }
  if (!want || !want.terms.length || !indexURL) return;

  // --- scoring ----------------------------------------------------------

  // A candidate scores by how many of the requested words it contains, and
  // loses a little for every word of its own that went unasked-for, so a
  // short exact-ish match beats a long one that merely happens to include
  // the same words. Vintages are handled separately (see below) because a
  // year is the single most likely thing to differ.
  var YEAR = /^(19|20)\d\d$/;

  function score(candidateSlug, terms) {
    var own = candidateSlug.split('-').filter(Boolean);
    var ownSet = Object.create(null);
    for (var i = 0; i < own.length; i++) ownSet[own[i]] = true;

    var hits = 0, yearAsked = null, yearMatched = false;
    for (var j = 0; j < terms.length; j++) {
      var t = terms[j];
      if (YEAR.test(t)) {
        yearAsked = t;
        if (ownSet[t]) yearMatched = true;
        continue;
      }
      if (ownSet[t]) hits++;
    }
    var wordsAsked = terms.filter(function (t) { return !YEAR.test(t); }).length;
    if (!wordsAsked || hits === 0) return null;

    var coverage = hits / wordsAsked;          // how much of the ask is met
    var extra = Math.max(0, own.length - hits); // how much noise came with it
    return {
      value: coverage - extra * 0.02 + (yearMatched ? 0.05 : 0),
      coverage: coverage,
      // A near-perfect word match whose only miss is the year is the
      // interesting case: the wine exists, the vintage moved on.
      vintageOnly: coverage === 1 && yearAsked !== null && !yearMatched,
      yearAsked: yearAsked
    };
  }

  // --- rendering --------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent, never innerHTML
    return n;
  }

  // A card matching the portfolio's, so a suggestion looks like the catalog
  // it came from rather than a search result pasted onto the page.
  function card(w) {
    var li = el('li');
    var a = el('a', 'wine-card');
    a.href = '/wines/' + w.slug + '/';

    var thumb = el('div', 'thumb');
    var img = document.createElement('img');
    img.src = w.img;
    img.alt = 'Bottle of ' + [w.producer, w.name, w.vintage].filter(Boolean).join(' ');
    img.loading = 'lazy';
    thumb.appendChild(img);

    var body = el('div', 'body');
    if (w.producer) body.appendChild(el('span', 'producer', w.producer));
    var h3 = el('h3', null, w.name);
    var vint = (w.vints && w.vints.length) ? w.vints.join(' · ') : w.vintage;
    if (vint) {
      h3.appendChild(document.createTextNode(' '));
      h3.appendChild(el('span', 'vintage', vint));
    }
    body.appendChild(h3);
    if (w.region || w.varietal) {
      body.appendChild(el('span', 'meta',
        (w.region && w.varietal) ? (w.region + ' · ' + w.varietal) : (w.region || w.varietal)));
    }

    a.appendChild(thumb);
    a.appendChild(body);
    li.appendChild(a);
    return li;
  }

  function show(headingText, wines, note) {
    root.textContent = '';
    if (note) root.appendChild(el('p', 'notfound-note', note));
    root.appendChild(el('h2', null, headingText));
    var ul = el('ul', 'wine-grid view-cards');
    ul.style.listStyle = 'none';
    ul.style.margin = '0';
    ul.style.padding = '0';
    for (var i = 0; i < wines.length; i++) ul.appendChild(card(wines[i]));
    root.appendChild(ul);
    root.hidden = false;
  }

  // Collections are matched from the values the index already carries, so
  // /producers/benjamn-leroux/ still finds Benjamin Leroux.
  function showLinks(headingText, links) {
    root.textContent = '';
    root.appendChild(el('h2', null, headingText));
    var ul = el('ul', 'notfound-links');
    for (var i = 0; i < links.length; i++) {
      var li = el('li');
      var a = el('a', null, links[i].name);
      a.href = links[i].url;
      li.appendChild(a);
      ul.appendChild(li);
    }
    root.appendChild(ul);
    root.hidden = false;
  }

  var SECTIONS = {
    producers: 'producer',
    regions: 'region',
    varietals: 'varietal'
  };

  fetch(indexURL)
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
    .then(function (items) {
      var field = SECTIONS[want.section];

      // A missing producer / region / varietal page: match the distinct
      // values rather than the wines, and link to their collection pages.
      if (field) {
        var seen = Object.create(null);
        var values = [];
        for (var i = 0; i < items.length; i++) {
          var v = items[i][field];
          if (!v || seen[v]) continue;
          seen[v] = true;
          values.push(v);
        }
        var scoredValues = [];
        for (var k = 0; k < values.length; k++) {
          // The published slug is how the value is addressed; deriving it the
          // same way the build does keeps the link honest.
          var vs = values[k].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          var s = score(vs, want.terms);
          if (s) scoredValues.push({ name: values[k], url: '/' + want.section + '/' + vs + '/', s: s.value });
        }
        scoredValues.sort(function (a, b) { return b.s - a.s; });
        if (scoredValues.length) {
          showLinks('Did you mean one of these?', scoredValues.slice(0, 6));
        }
        return;
      }

      // Otherwise treat it as a wine.
      var scored = [];
      for (var n = 0; n < items.length; n++) {
        var sc = score(items[n].slug, want.terms);
        if (sc && sc.coverage >= 0.5) scored.push({ w: items[n], s: sc });
      }
      if (!scored.length) return;
      scored.sort(function (a, b) { return b.s.value - a.s.value; });

      // The vintage case is worth saying out loud: the wine is still in the
      // book, just not the year that was asked for.
      //
      // When that claim is made, the list must contain ONLY that wine. The
      // ranking's next entries are other wines that share words — plausible
      // alternatives under a "were you looking for" heading, but a flat
      // contradiction of "this wine is still in the portfolio".
      var top = scored[0];
      if (top.s.vintageOnly && top.s.yearAsked) {
        var sameWine = scored.filter(function (x) { return x.s.coverage === 1; });
        show('Still available',
          sameWine.slice(0, 4).map(function (x) { return x.w; }),
          'The ' + top.s.yearAsked + ' is no longer listed. This wine is still in the portfolio:');
        return;
      }
      show('Were you looking for one of these?',
        scored.slice(0, 4).map(function (x) { return x.w; }), null);
    })
    .catch(function () {
      /* Index unavailable: the static signpost above is still a good page. */
    });

  // Record the miss so real redirects can be added for the paths people
  // actually hit. GA4 is only present when the site is configured with an
  // ID, so this is guarded rather than assumed.
  if (typeof window.gtag === 'function') {
    window.gtag('event', 'page_not_found', {
      missing_path: location.pathname,
      referrer: document.referrer || '(none)'
    });
  }
})();
