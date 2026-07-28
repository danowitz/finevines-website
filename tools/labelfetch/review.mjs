// Builds a review sheet for staged bottle images.
//
// A run over the whole catalog stages roughly two thousand images. Nobody is
// going to open two thousand files, so the pipeline records WHY each one might
// be wrong as it goes, and this turns those notes into one page: flagged
// images first, each beside the wine it is supposed to be, the label text that
// was actually read, and the doubt.
//
// The point is to make the uncertain set small and specific. "Verified" and
// "certain" are not the same thing, and the difference should be visible
// rather than assumed away.
//
//   node tools/labelfetch/review.mjs            -> out-bottle/review.html + .csv
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const MANIFEST = 'data/fetched-images/manifest.json';
const OUT_HTML = 'out-bottle/review.html';
const OUT_CSV = 'out-bottle/review.csv';

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const all = Object.values(manifest);
const ok = all.filter((r) => r.ok && r.file);
const flagged = ok.filter((r) => r.review?.length);
const clean = ok.filter((r) => !r.review?.length);
const missed = all.filter((r) => !r.ok);

await mkdir('out-bottle', { recursive: true });

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Paths are relative to the HTML file so the sheet works opened straight off
// disk, with no server.
const src = (f) => relative(resolve('out-bottle'), resolve(f)).replace(/\\/g, '/');

const card = (r) => `
  <figure class="${r.review?.length ? 'flag' : 'ok'}">
    <img src="${esc(src(r.file))}" alt="${esc(r.name)}" loading="lazy">
    <figcaption>
      <b>${esc(r.name)}</b>
      <span class="label">label read: ${esc(r.label || '(none)')}</span>
      <span class="src">${esc((() => { try { return new URL(r.page).host; } catch { return r.page || ''; } })())}${r.verifiedBy ? ` · ${esc(r.verifiedBy)}` : ''}</span>
      ${(r.review || []).map((f) => `<span class="why">${esc(f)}</span>`).join('')}
    </figcaption>
  </figure>`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>Bottle image review — ${flagged.length} to check</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; background: #faf6ee; color: #2c211a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 0 10px; text-transform: uppercase; letter-spacing: .1em; color: #6b1630; }
  .sum { color: #6e5d4e; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
  figure { margin: 0; background: #fff; border: 1px solid #ece0cd; border-radius: 6px; padding: 10px; }
  figure.flag { border-color: #c2a14e; box-shadow: inset 3px 0 0 #c2a14e; }
  img { width: 100%; height: 230px; object-fit: contain; background: #fff; }
  figcaption { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; font-size: 12px; }
  b { font-size: 12.5px; }
  .label { color: #43352a; font-style: italic; }
  .src { color: #9c8c7c; font-size: 11px; }
  .why { color: #8a6a2f; font-size: 11px; background: #f1e6c9; border-radius: 3px; padding: 2px 5px; }
</style>
<h1>Bottle image review</h1>
<p class="sum">
  <b>${ok.length}</b> staged &middot;
  <b>${flagged.length}</b> flagged for checking &middot;
  ${clean.length} clean &middot;
  ${missed.length} not found
</p>
<p class="sum">Flagged images passed verification — these are the reasons they might still be wrong.
Delete a bad one from <code>data/fetched-images/</code> before running <code>import.mjs --apply</code>.</p>

<h2>Check these (${flagged.length})</h2>
<div class="grid">${flagged.map(card).join('')}</div>

<h2>Clean (${clean.length})</h2>
<div class="grid">${clean.map(card).join('')}</div>
`;

await writeFile(OUT_HTML, html);

const csv = [
  'slug,name,flags,label_read,source,verified_by',
  ...flagged.map((r) =>
    [r.slug, r.name, (r.review || []).join(' | '), (r.label || '').replace(/\s+/g, ' '), r.page || '', r.verifiedBy || 'local']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ),
].join('\n');
await writeFile(OUT_CSV, csv);

console.log(`${ok.length} staged, ${flagged.length} flagged, ${clean.length} clean, ${missed.length} not found`);
if (flagged.length) {
  const counts = {};
  for (const r of flagged) for (const f of r.review) {
    const k = f.replace(/\(.*\)/, '').trim();
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log('\nreasons:');
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
}
console.log(`\n${OUT_HTML}\n${OUT_CSV}`);
