import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { catalogImageSearchQuery } from './image-query.mjs';

const output = process.argv[2] || 'out-bottle/outstanding-images.html';
const catalog = JSON.parse(await readFile('data/wines.json', 'utf8'));
const funnel = JSON.parse(await readFile('data/image-funnel.json', 'utf8'));

const needsRealImage = (wine) => !wine.imagePath ||
  wine.imagePath.endsWith('.svg') ||
  wine.imageSource === 'generated-photo' ||
  wine.imageSource === 'label-scan';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const query = catalogImageSearchQuery;
const rows = catalog.filter(needsRealImage).map((wine) => {
  const record = funnel[wine.slug] || {};
  const facts = record.funnel || {};
  return {
    wine,
    stage: record.failureStage || 'not-yet-evaluated',
    reason: record.reason || 'No durable image-search verdict is recorded yet.',
    facts,
    hasCandidates: Number(facts.downloaded || 0) >= 2,
  };
}).sort((left, right) =>
  left.stage.localeCompare(right.stage) || left.wine.name.localeCompare(right.wine.name));

const stages = new Map();
for (const row of rows) stages.set(row.stage, (stages.get(row.stage) || 0) + 1);
const candidateBacked = rows.filter((row) => row.hasCandidates).length;
const siteBase = new URL('/', process.env.FINEVINES_SITE_BASE_URL?.trim() || 'https://finevines.com');

const cards = rows.map(({ wine, stage, reason, facts, hasCandidates }) => {
  const q = encodeURIComponent(query(wine));
  const fallback = wine.imagePath ? new URL(wine.imagePath.replace(/^\//, ''), siteBase).href : '';
  const evidence = [
    `${facts.searchResults || 0} results`,
    `${facts.downloaded || 0} downloaded`,
    `${facts.bottleShapePassed || 0} bottles`,
    `${facts.strongestGroupImages || 0} matching`,
    `${facts.identityAnchors || 0} anchors`,
  ].join(' → ');
  return `<article data-stage="${esc(stage)}" data-candidates="${hasCandidates ? 'yes' : 'no'}"
      data-search="${esc(query(wine).toLowerCase())}">
    <button class="thumb" type="button" ${fallback ? `data-image="${esc(fallback)}"` : 'disabled'}>
      ${fallback ? `<img src="${esc(fallback)}" loading="lazy" alt="Current fallback for ${esc(wine.name)}">` : '<span>No current image</span>'}
    </button>
    <div class="body">
      <h2>${esc(wine.producer ? `${wine.producer} — ${wine.name}` : wine.name)}</h2>
      <p class="meta">${esc([wine.vintage, wine.region || wine.country, `SKU ${wine.sku || '?'}`].filter(Boolean).join(' · '))}</p>
      <span class="stage">${esc(stage)}</span>${hasCandidates ? '<span class="candidate">candidates found</span>' : ''}
      <p class="reason">${esc(reason)}</p>
      <p class="evidence">${esc(evidence)}</p>
      <details><summary>Exact search string</summary><code>${esc(query(wine))}</code></details>
      <p class="links"><a target="_blank" rel="noopener" href="https://www.google.com/search?udm=2&q=${q}">Google Images</a>
        <a target="_blank" rel="noopener" href="https://search.brave.com/images?q=${q}">Brave Images</a></p>
    </div>
  </article>`;
}).join('\n');

const stageButtons = [...stages].sort((a, b) => b[1] - a[1]).map(([stage, count]) =>
  `<button data-filter="${esc(stage)}">${esc(stage)} <b>${count}</b></button>`).join('');

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Fine Vines outstanding bottle images</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#f6f0e7;color:#2e211b;font:14px/1.45 system-ui,sans-serif}
  header{position:sticky;top:0;z-index:5;padding:18px 24px;background:#2b0914;color:#fff;box-shadow:0 2px 12px #0003}
  h1{margin:0;font:700 25px Georgia,serif}.summary{margin:4px 0 12px;color:#ead8c1}.controls{display:flex;gap:8px;flex-wrap:wrap}
  input{min-width:280px;padding:9px 12px;border:0;border-radius:5px}.controls button{padding:7px 10px;border:1px solid #ac8f72;border-radius:15px;background:#fff;color:#4d2631;cursor:pointer}
  .controls button.active{background:#c7a85e;color:#27100f;border-color:#c7a85e}.controls b{font-variant-numeric:tabular-nums}
  main{display:grid;grid-template-columns:repeat(auto-fill,minmax(370px,1fr));gap:14px;padding:20px}
  article{display:grid;grid-template-columns:125px 1fr;gap:13px;background:#fff;border:1px solid #dfd1bd;border-radius:8px;padding:11px;min-height:215px}
  .thumb{border:0;background:#fbfaf7;border-radius:5px;padding:5px;cursor:zoom-in}.thumb img{width:100%;height:185px;object-fit:contain}.body{min-width:0}
  h2{font:700 16px/1.25 Georgia,serif;margin:2px 0 4px}.meta,.evidence{color:#776657;font-size:11px}.stage,.candidate{display:inline-block;margin:3px 5px 3px 0;padding:3px 6px;border-radius:4px;font-size:10px;font-weight:750;text-transform:uppercase}
  .stage{background:#922c2c;color:#fff}.candidate{background:#e4df91;color:#312d05}.reason{margin:8px 0;color:#533f31}.evidence{background:#f4eee4;padding:5px;border-radius:4px}
  details{font-size:11px}code{display:block;white-space:normal;margin-top:4px}.links{display:flex;gap:8px}.links a{background:#6b1630;color:#fff;text-decoration:none;padding:6px 9px;border-radius:4px;font-weight:700}
  dialog{border:0;border-radius:8px;padding:12px;background:#fff;max-width:min(92vw,1000px);max-height:92vh}dialog::backdrop{background:#000c}dialog img{display:block;max-width:86vw;max-height:82vh;object-fit:contain}dialog button{position:absolute;right:7px;top:3px;border:0;background:#fff;font-size:30px;cursor:pointer}
  @media(max-width:520px){header{position:static}main{grid-template-columns:1fr;padding:10px}article{grid-template-columns:100px 1fr}.thumb img{height:160px}input{min-width:100%;width:100%}}
</style>
<header><h1>Outstanding bottle images</h1>
  <p class="summary"><b>${rows.length}</b> still need real photography · <b>${candidateBacked}</b> previously downloaded at least two candidates · generated ${esc(new Date().toLocaleString())}</p>
  <div class="controls"><input id="search" type="search" placeholder="Filter producer, wine, vintage, SKU">
    <button class="active" data-filter="all">all <b>${rows.length}</b></button>
    <button data-filter="candidates">candidates found <b>${candidateBacked}</b></button>${stageButtons}</div>
</header>
<main>${cards}</main>
<dialog><button aria-label="Close">×</button><img alt="Enlarged current fallback"></dialog>
<script>
  const cards=[...document.querySelectorAll('article')],search=document.querySelector('#search');let filter='all';
  function apply(){const q=search.value.trim().toLowerCase();for(const card of cards)card.hidden=!(card.dataset.search.includes(q)&&(filter==='all'||(filter==='candidates'&&card.dataset.candidates==='yes')||card.dataset.stage===filter));}
  search.addEventListener('input',apply);document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.classList.remove('active'));button.classList.add('active');filter=button.dataset.filter;apply();});
  const dialog=document.querySelector('dialog');document.querySelectorAll('[data-image]').forEach(button=>button.onclick=()=>{dialog.querySelector('img').src=button.dataset.image;dialog.showModal();});dialog.querySelector('button').onclick=()=>dialog.close();dialog.onclick=e=>{if(e.target===dialog)dialog.close();};
</script>`;

await mkdir(output.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
await writeFile(output, html);
console.log(`${rows.length} outstanding; ${candidateBacked} previously had at least two downloaded candidates`);
console.log(output);
