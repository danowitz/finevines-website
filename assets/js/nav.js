// Mobile header nav toggle. Progressive enhancement: below the md breakpoint
// the CSS hides .site-nav and reveals the .nav-toggle button; this script
// wires the button's aria-expanded state to a .is-open class on the nav so
// the menu shows/hides. On wide screens the button is display:none and the
// nav is always visible, so this is a no-op there.
(function () {
  var btn = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (!btn || !nav) return;
  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    btn.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
    nav.classList.toggle('is-open', !open);
  });
})();
