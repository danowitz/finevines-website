// Builds the review sheet: every staged bottle image beside the Salesforce row
// it is proposed for, and — where they exist — the other candidates that were
// fetched and refused.
//
// A report that only says "this might be wrong" leaves the reviewer to start
// the search over. The pipeline already downloads several candidates per wine
// and refuses most of them, and when the accepted image is wrong the right one
// is very often among those refusals. So they are kept, shown, and selectable:
// correcting a match becomes a click rather than a hunt.
//
// The page writes nothing itself — it is opened straight off disk. Choices
// accumulate in the browser and download as decisions.json, which
// tools/labelfetch/decide.mjs applies. Nothing reaches the catalog without
// that second, deliberate step.
//
//   node tools/labelfetch/review.mjs      -> out-bottle/review.html + .csv
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const MANIFEST = 'data/fetched-images/manifest.json';
const OUT_HTML = 'out-bottle/review.html';
const OUT_CSV = 'out-bottle/review.csv';

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

// The catalog row itself, so the sheet shows what Salesforce says this wine is
// — SKU, producer, vintage, region — beside the picture proposed for it.
const wines = new Map(
  JSON.parse(await readFile('data/wines.json', 'utf8')).map((w) => [w.slug, w])
);

const all = Object.values(manifest);
// The sheet is built while the pipeline may still be writing, and images get
// removed when a rule tightens. A record whose file is gone must not become a
// broken picture — that reads as a fetch failure rather than the bookkeeping
// lag it is.
const onDisk = (f) => !!f && existsSync(f);
// A record whose wine already wears a real photograph is moot: import would
// refuse to overwrite it, so reviewing it is wasted attention. This is what
// keeps the queue shrinking as imports and vintage-sharing land.
const wineNeedsImage = (slug) => {
  const w = wines.get(slug);
  return !w || !w.imagePath || w.imagePath.endsWith('.svg');
};
const ok = all.filter((r) => r.ok && onDisk(r.file) && wineNeedsImage(r.slug));
const moot = all.filter((r) => r.ok && onDisk(r.file) && !wineNeedsImage(r.slug)).length;
const stale = all.filter((r) => r.ok && !onDisk(r.file)).length;
const flagged = ok.filter((r) => r.review?.length);
const clean = ok.filter((r) => !r.review?.length);
// A wine that found nothing but has candidates on disk is the best possible
// use of this page: nothing is proposed, and the alternatives are one click away.
const missedWithOptions = all.filter((r) => !r.ok && (r.alternates || []).some((a) => onDisk(a.file)));
const missedBare = all.filter((r) => !r.ok && !(r.alternates || []).some((a) => onDisk(a.file)));

await mkdir('out-bottle', { recursive: true });

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Paths relative to the HTML file, so the sheet works with no server.
const src = (f) => relative(resolve('out-bottle'), resolve(f)).replace(/\\/g, '/');
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u || '';
  }
};

// A one-click search, for the wines where nothing on disk is right. Opens the
// same query the pipeline used, so the reviewer starts where it left off
// rather than retyping a Burgundy name from a SKU.
const searchTerms = (w, r) =>
  encodeURIComponent(([w.producer, w.name, w.vintage].filter(Boolean).join(' ') || r.name) + ' wine bottle');
const searchURL = (w, r) => `https://duckduckgo.com/?q=${searchTerms(w, r)}&iax=images&ia=images`;
// Google's image index is broader — often the difference for small-production
// wines. Fine as a link the HUMAN clicks; the pipeline's automated discovery
// stays on DuckDuckGo's HTML endpoint, which tolerates a robot where Google's
// SERP answers one with consent walls and CAPTCHAs.
const googleURL = (w, r) => `https://www.google.com/search?udm=2&q=${searchTerms(w, r)}`;

const card = (r, { chosen }) => {
  const w = wines.get(r.slug) || {};
  const alts = (r.alternates || []).filter((a) => onDisk(a.file));
  const title = [w.producer, w.name].filter(Boolean).join(' — ') || r.name;
  // The host is a link to the product page the image was fetched from, so
  // the reviewer can see the picture in its retail context in one click.
  // Anchors are interactive elements, so clicking one navigates without
  // toggling the surrounding label's radio.
  const opt = (file, page, why, label, i) => `
      <label class="opt${i === 0 && chosen ? ' proposed' : ''}">
        <input type="radio" name="${esc(r.slug)}" value="${esc(file || '')}" ${i === 0 && chosen ? 'checked' : ''}>
        ${i === 0 && chosen ? '<span class="confirm-badge">click picture to confirm &#10003;</span>' : ''}
        <img src="${esc(src(file))}" loading="lazy" alt="">
        <span class="opt-src">${page ? `<a href="${esc(page)}" target="_blank" rel="noopener">${esc(hostOf(page))} &#8599;</a>` : esc(hostOf(page))}</span>
        ${why ? `<span class="opt-why">${esc(why)}</span>` : ''}
        ${why && /no clean background/.test(why) ? '<span class="opt-fix">pick it &mdash; background is removed automatically</span>' : ''}
        ${label ? `<span class="opt-label" title="the text OCR read off this bottle — the evidence the match was made on">text on bottle: ${esc(String(label).slice(0, 70))}</span>` : ''}
      </label>`;

  return `
  <figure class="${r.review?.length ? 'flag' : chosen ? 'ok' : 'none'}" data-slug="${esc(r.slug)}">
    <figcaption>
      <b>${esc(title)}</b>
      <span class="meta">${esc([w.vintage, w.region || w.country, w.varietal].filter(Boolean).join(' · '))}</span>
      <span class="sku">SKU ${esc(w.sku || '?')}</span>
      <span class="search">search:
        <a href="${esc(googleURL(w, r))}" target="_blank" rel="noopener">Google Images</a> &middot;
        <a href="${esc(searchURL(w, r))}" target="_blank" rel="noopener"
           title="the same query the pipeline searched to find these candidates">DuckDuckGo (pipeline's)</a></span>
      ${(r.review || []).map((f) => `<span class="why">${esc(f)}</span>`).join('')}
    </figcaption>
    <div class="opts">
      ${chosen ? opt(r.file, r.page, '', r.label, 0) : ''}
      ${alts.map((a, i) => opt(a.file, a.page, a.why, a.label, chosen ? i + 1 : i)).join('')}
      <label class="opt wrong">
        <input type="radio" name="${esc(r.slug)}" value="__none__">
        <span class="opt-none">&#10007; wrong<br>none of these</span>
        <a class="opt-search" href="${esc(googleURL(w, r))}" target="_blank" rel="noopener">search images &rarr;</a>
        <input class="opt-url" type="url" placeholder="paste image URL — scenes OK"
               data-slug="${esc(r.slug)}"
               title="Right-click an image in the search results, Copy image address, paste here. It is fetched, checked and normalised like any other candidate.">
      </label>
    </div>
  </figure>`;
};

const section = (title, rows, opts) =>
  rows.length ? `<h2>${title} — ${rows.length}</h2><div class="grid">${rows.map((r) => card(r, opts)).join('')}</div>` : '';

const html = `<!doctype html>
<meta charset="utf-8">
<title>Bottle images — ${flagged.length} to check</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px 24px 90px; background: #faf6ee; color: #2c211a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 34px 0 10px; text-transform: uppercase; letter-spacing: .1em; color: #6b1630; }
  .sum { color: #6e5d4e; margin-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
  figure { margin: 0; background: #fff; border: 1px solid #ece0cd; border-radius: 6px; padding: 12px; }
  figure.flag { border-color: #c2a14e; box-shadow: inset 3px 0 0 #c2a14e; }
  figure.none { border-color: #c98a9b; box-shadow: inset 3px 0 0 #9a2b2b; }
  figcaption { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
  b { font-size: 13px; }
  .meta { color: #6e5d4e; font-size: 11.5px; }
  .sku { color: #6b1630; font-size: 11px; font-family: ui-monospace, monospace; }
  .why { color: #8a6a2f; font-size: 11px; background: #f1e6c9; border-radius: 3px; padding: 2px 5px; align-self: flex-start; }
  .opts { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
  .opt { flex: 0 0 116px; display: flex; flex-direction: column; gap: 3px; cursor: pointer;
         border: 2px solid transparent; border-radius: 5px; padding: 5px; }
  .opt:hover { background: #f4ece0; }
  .opt:has(input:checked) { border-color: #6b1630; background: #fff8f0; }
  .opt img { width: 100%; height: 150px; object-fit: contain; background: #fff; }
  .opt input { accent-color: #6b1630; }
  .opt-src { color: #9c8c7c; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt-src a { color: #6b1630; text-decoration: none; }
  .opt-src a:hover { text-decoration: underline; }
  .search { font-size: 11px; color: #6b1630; align-self: flex-start; }
  .opt-why { color: #9a2b2b; font-size: 10px; }
  .opt-fix { color: #2e6b3f; font-size: 10px; }
  .opt-label { color: #43352a; font-size: 10px; font-style: italic; }
  .opt.wrong { justify-content: center; align-items: center; text-align: center; background: #faf6ee; }
  .opt.wrong:has(input:checked) { border-color: #9a2b2b; background: #fdf0f0; }
  .confirm-badge { font-size: 10px; color: #9c8c7c; text-align: center; }
  .opt.confirmed { border-color: #2e6b3f; background: #f0faf2; }
  .opt.confirmed .confirm-badge { color: #2e6b3f; font-weight: 700; }
  .opt-none { font-size: 11px; color: #6e5d4e; }
  .opt-search { font-size: 11px; color: #6b1630; }
  .opt-url { width: 100%; box-sizing: border-box; margin-top: 4px; font-size: 10px;
             padding: 4px; border: 1px solid #d8c6a8; border-radius: 3px; }
  .opt-url:focus { outline: 2px solid #c2a14e; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; background: #2a0a13; color: #f4ece0;
         padding: 12px 24px; display: flex; gap: 18px; align-items: center; font-size: 13px; }
  #bar button { font: inherit; padding: 7px 16px; border: 0; border-radius: 4px;
                background: #c2a14e; color: #2a0a13; font-weight: 700; cursor: pointer; }
  #bar b { color: #ddc489; }
</style>

<h1>Bottle images</h1>
<p class="sum">
  <b>${ok.length}</b> staged &middot; <b>${flagged.length}</b> flagged &middot;
  ${clean.length} unflagged &middot; <b>${missedWithOptions.length}</b> found nothing but have candidates &middot;
  ${missedBare.length} found nothing at all
</p>
<p class="sum">Four moves per card: <b>click the bottle picture</b> to confirm it (turns green — goes live on the
next import), <b>&#10007; wrong</b> rejects everything (the wine goes back to the fetch queue), click a
different candidate to swap it in, or <b>paste an image URL</b> you found yourself. A bottle photographed in a scene is fine to pick —
the background is removed automatically when decisions are applied (a second subject in frame still
gets refused). A card you don't touch stays in the queue. Then <b>Download decisions</b> and run
<code>node tools/labelfetch/decide.mjs --apply</code>.</p>
<p class="sum"><b>text on bottle</b> is what OCR actually read off that picture — it is the evidence
the match was made on, so a wrong image usually names a different estate there.</p>

${section('Found nothing — choose one', missedWithOptions, { chosen: false })}
${section('Flagged — check these', flagged, { chosen: true })}
${section('No flags raised', clean, { chosen: true })}
${missedBare.length ? `<h2>No candidates at all — ${missedBare.length}</h2><p class="sum">${missedBare.map((r) => esc(r.name)).slice(0, 60).join(' &middot; ')}${missedBare.length > 60 ? ' &hellip;' : ''}</p>` : ''}

<div id="bar">
  <span><b id="n">0</b> decisions</span>
  <button onclick="save()">Download decisions</button>
  <span>then: node tools/labelfetch/decide.mjs</span>
</div>

<script>
// Only DELIBERATE changes are recorded. A card left as the pipeline set it is
// not a decision, and writing it out would make an untouched page look reviewed.
const chosen = {};
const initial = {};
document.querySelectorAll('input[type=radio]:checked').forEach(i => initial[i.name] = i.value);
const count = () => document.getElementById('n').textContent = Object.keys(chosen).length;

// Confirming is a click on the proposed picture itself — the thing being
// judged — not a separate tile that reads like a competing choice. Clicking
// toggles; the green state is the receipt. Links inside the tile still
// navigate without confirming.
document.addEventListener('click', e => {
  if (e.target.closest('a')) return;
  // Clicking a label dispatches a SECOND, synthetic click targeted at its
  // radio. Handling both toggled the confirmation on and instantly off —
  // "clicking does nothing". Only the person's own click (img, badge, label
  // chrome) counts; the input-targeted echo is ignored.
  if (e.target.tagName === 'INPUT') return;
  const lab = e.target.closest('.opt.proposed');
  if (!lab) return;
  const radio = lab.querySelector('input[type=radio]');
  if (!radio.checked) return; // switching back from an alternate: change-handler territory
  const slug = radio.name;
  const badge = lab.querySelector('.confirm-badge');
  if (chosen[slug] === '__confirm__') {
    delete chosen[slug];
    lab.classList.remove('confirmed');
    badge.innerHTML = 'click picture to confirm &#10003;';
  } else {
    chosen[slug] = '__confirm__';
    lab.classList.add('confirmed');
    badge.innerHTML = '&#10003; confirmed — goes live next import';
  }
  count();
});
document.addEventListener('change', e => {
  if (e.target.type === 'radio') {
    if (e.target.value === initial[e.target.name]) delete chosen[e.target.name];
    else chosen[e.target.name] = e.target.value;
    count();
    return;
  }
  // A pasted URL is a stronger statement than "wrong": it says use THIS one.
  // It also selects the tile, so the card reads as decided at a glance.
  if (e.target.classList.contains('opt-url')) {
    const slug = e.target.dataset.slug;
    const v = e.target.value.trim();
    if (v) {
      chosen[slug] = v;
      e.target.closest('.opt').querySelector('input[type=radio]').checked = true;
    } else if (chosen[slug] && /^https?:/.test(chosen[slug])) {
      delete chosen[slug];
    }
    count();
  }
});
// Paste alone should count, without needing to leave the field.
document.addEventListener('paste', e => {
  const t = e.target;
  if (t.classList && t.classList.contains('opt-url')) setTimeout(() => t.dispatchEvent(new Event('change', {bubbles:true})), 0);
});
function save() {
  const blob = new Blob([JSON.stringify(chosen, null, 1)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'decisions.json';
  a.click();
}
</script>
`;

await writeFile(OUT_HTML, html);

const csv = [
  'slug,sku,producer,name,vintage,flags,label_read,source,alternates',
  ...ok.map((r) => {
    const w = wines.get(r.slug) || {};
    return [r.slug, w.sku || '', w.producer || '', w.name || r.name, w.vintage || '',
      (r.review || []).join(' | '), (r.label || '').replace(/\s+/g, ' '), r.page || '',
      (r.alternates || []).length]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
  }),
].join('\n');
await writeFile(OUT_CSV, csv);

const withAlts = ok.filter((r) => r.alternates?.length).length;
console.log(`${ok.length} staged  ${flagged.length} flagged  ${clean.length} unflagged`);
if (moot) console.log(`${moot} records hidden — their wine already wears a real photograph`);
if (stale) console.log(`${stale} records skipped — their image file is no longer on disk`);
console.log(`${missedWithOptions.length} found nothing but have candidates to choose from`);
console.log(`${withAlts} accepted images have alternates offered`);
console.log(`\n${OUT_HTML}\n${OUT_CSV}`);
