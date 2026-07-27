// Off-canvas filter drawer for /portfolio/ on narrow screens (≤1024px).
// Progressive enhancement: the .facets panel is a static sidebar on desktop;
// below the lg breakpoint the CSS repositions it off-canvas and reveals the
// .filters-toggle button, which this script wires up to slide it in/out.
//
// The facet checkboxes stay inside .facets untouched, so assets/js/portfolio.js
// keeps filtering live whether the drawer is open or closed. This file only
// manages the drawer's open/close, focus, and body-scroll lock — accessibly.
(function () {
  var toggle = document.querySelector('.filters-toggle');
  var drawer = document.getElementById('portfolio-facets');
  if (!toggle || !drawer) return;

  var backdrop = document.querySelector('.facets-backdrop');
  var closeBtn = drawer.querySelector('.facets-close');
  var lastFocus = null;

  function focusable() {
    return Array.prototype.filter.call(
      drawer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null || el === document.activeElement; }
    );
  }

  function isOpen() { return drawer.classList.contains('is-open'); }

  function open() {
    if (isOpen()) return;
    lastFocus = document.activeElement;
    drawer.classList.add('is-open');
    if (backdrop) backdrop.hidden = false;
    document.body.classList.add('drawer-open');
    toggle.setAttribute('aria-expanded', 'true');
    (closeBtn || drawer).focus();
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (!isOpen()) return;
    drawer.classList.remove('is-open');
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove('drawer-open');
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Simple focus trap: keep Tab cycling within the drawer while it's open.
    var items = focusable();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!drawer.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  toggle.addEventListener('click', function () {
    isOpen() ? close() : open();
  });
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  // If the viewport widens back to desktop, the sidebar becomes static again —
  // drop any open state so nothing is left trapping focus or locking scroll.
  var mq = window.matchMedia('(min-width: 1025px)');
  var onChange = function (e) { if (e.matches) close(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
})();
