// Faceted filter for /portfolio/. Progressive enhancement: the full list is
// server-rendered; this script only hides non-matching cards and updates counts.
(async function () {
  const grid = document.querySelector('.wine-grid');
  if (!grid) return;
  const res = await fetch('/search-index.json');
  const wines = await res.json();
  const bySlug = new Map(wines.map(w => [w.slug, w]));
  const active = { producer: new Set(), varietal: new Set(), region: new Set(), vintage: new Set(), style: new Set() };
  const searchBox = document.querySelector('#portfolio-search');

  function matches(w) {
    for (const [facet, sel] of Object.entries(active)) {
      if (sel.size && !sel.has(w[facet])) return false;
    }
    const q = (searchBox?.value || '').trim().toLowerCase();
    if (q && !`${w.producer} ${w.name} ${w.region} ${w.varietal}`.toLowerCase().includes(q)) return false;
    return true;
  }

  function apply() {
    let shown = 0;
    for (const card of grid.children) {
      const w = bySlug.get(card.dataset.slug);
      const ok = w ? matches(w) : true;
      card.hidden = !ok;
      if (ok) shown++;
    }
    const counter = document.querySelector('#portfolio-count');
    if (counter) counter.textContent = `${shown} wines`;
  }

  document.querySelectorAll('.facet input[type=checkbox]').forEach(box => {
    box.addEventListener('change', () => {
      const set = active[box.dataset.facet];
      box.checked ? set.add(box.value) : set.delete(box.value);
      apply();
    });
  });
  searchBox?.addEventListener('input', apply);
  apply();
})();
