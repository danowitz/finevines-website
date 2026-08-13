import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

const input = process.argv[2] || 'out-bottle/image-canary.json';
const output = process.argv[3] || 'out-bottle/image-canary.html';
const report = JSON.parse(await readFile(input, 'utf8'));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const safeSegment = (value) => String(value || 'wine').replace(/[^a-z0-9._-]+/gi, '-');

const outputDir = dirname(resolve(output));
const assetDir = join(outputDir, 'image-canary-assets');
await mkdir(assetDir, { recursive: true });

const packageImage = async (file, scope = '') => {
  if (!file) return '';
  const source = resolve(file);
  const destinationDir = scope ? join(assetDir, safeSegment(scope)) : assetDir;
  const packaged = join(destinationDir, basename(source));
  await mkdir(destinationDir, { recursive: true });
  try {
    await copyFile(source, packaged);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  return relative(outputDir, packaged).replaceAll('\\', '/');
};

const cards = [];
for (const [rowIndex, row] of report.rows.entries()) {
  const image = row.ok ? await packageImage(row.file) : '';
  const candidateCards = [];
  const candidateScope = row.slug || `wine-${rowIndex + 1}`;
  for (const [candidateIndex, candidate] of (row.alternates || []).entries()) {
    const candidateImage = await packageImage(candidate.file, candidateScope);
    if (!candidateImage) continue;
    const candidateName = basename(candidate.file || `candidate-${candidateIndex + 1}`).replace(/\.[^.]+$/, '');
    const reason = candidate.why || 'Downloaded candidate was not selected';
    const badges = [
      candidate.anchor ? '<span class="badge anchor">identity anchor</span>' : '',
      candidate.strongestGroup ? '<span class="badge group">repeated design</span>' : '',
      candidate.explicitConflict ? '<span class="badge conflict">explicit conflict</span>' : '',
    ].filter(Boolean).join('');
    candidateCards.push(`<button type="button" class="candidate-open"
      data-modal-src="${esc(candidateImage)}"
      data-modal-title="${esc(`${row.name} — ${candidateName}`)}"
      data-modal-reason="${esc(reason)}"
      data-modal-page="${esc(candidate.page)}"
      aria-label="Enlarge ${esc(candidateName)} for ${esc(row.name)}">
      <span class="thumb"><img loading="lazy" src="${esc(candidateImage)}" alt="${esc(`${row.name} ${candidateName}`)}"></span>
      <span class="candidate-meta"><strong>${esc(candidateName)}</strong><span>${esc(candidate.size || 'size unknown')}</span></span>
      <span class="badges">${badges}</span>
      <span class="reason">${esc(reason)}</span>
    </button>`);
  }
  const reason = row.tried?.[0]?.why || row.discoveryError || 'no result';
  cards.push(`<article class="${row.ok ? 'ok' : 'miss'}">
    <div class="wine-heading"><div><h2>${esc(row.name)}</h2><p class="query">${esc(row.query || '')}</p></div>
      <p class="status">${row.ok ? `ACCEPTED · ${esc(row.size)} · ${esc(row.matchingImages)} matching` : `NO PICK · ${esc(row.failureStage || 'failed')} · ${esc(reason)}`}</p></div>
    ${image ? `<div class="selected"><div><span class="selected-label">Selected image</span><img src="${esc(image)}" alt="${esc(row.name)}"></div><div><p class="label">Label: ${esc(row.label)}</p><p><a href="${esc(row.page)}">Open selected source page</a></p></div></div>` : ''}
    <h3>${candidateCards.length} downloaded candidate${candidateCards.length === 1 ? '' : 's'}</h3>
    ${candidateCards.length ? `<div class="candidate-grid">${candidateCards.join('\n')}</div>` : '<div class="empty">No downloaded candidate files were packaged</div>'}
  </article>`);
}

const recovered = Number.isInteger(report.recovered) ? report.recovered : 0;
const labelModel = report.labelModel || 'gpt-4.1-nano';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Image canary</title><style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#201d18;background:#eee9df}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;z-index:5;padding:20px 28px;background:rgba(244,241,232,.96);border-bottom:1px solid #d4cbbb;backdrop-filter:blur(10px)}header h1{margin:0;font:700 28px/1.1 Georgia,serif}header p{margin:7px 0 0;color:#5b5348}.wine-list{display:grid;gap:22px;padding:24px 28px 80px;max-width:1800px;margin:auto}.wine-list article{background:#fff;border:1px solid #d8d0bf;border-left:7px solid #a45b4c;border-radius:12px;padding:20px;box-shadow:0 5px 18px rgba(54,42,24,.06)}.wine-list article.ok{border-left-color:#26724c}.wine-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.wine-heading h2{margin:0;font:600 21px/1.25 Georgia,serif}.query{margin:5px 0 0;color:#71685b}.status{margin:0;max-width:54%;font-size:12px;font-weight:800;text-align:right;text-transform:uppercase;letter-spacing:.025em}.ok .status{color:#176c43}.miss .status{color:#8a3c2f}h3{margin:20px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#62594d}.selected{display:grid;grid-template-columns:180px 1fr;gap:18px;align-items:center;margin-top:18px;padding:12px;background:#f4f8f5;border:1px solid #cfe0d5;border-radius:9px}.selected img{display:block;width:100%;height:210px;object-fit:contain;background:#fff}.selected-label{display:block;margin-bottom:5px;color:#176c43;font-size:11px;font-weight:800;text-transform:uppercase}.label{font-size:13px}.candidate-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}.candidate-open{display:flex;min-width:0;flex-direction:column;gap:7px;padding:9px;text-align:left;color:inherit;background:#faf9f6;border:1px solid #d9d3c8;border-radius:9px;cursor:zoom-in;transition:transform .12s,border-color .12s,box-shadow .12s}.candidate-open:hover,.candidate-open:focus-visible{transform:translateY(-2px);border-color:#876f51;box-shadow:0 7px 17px rgba(48,36,19,.14);outline:none}.thumb{display:block;width:100%;height:170px;background:#fff;border-radius:5px;overflow:hidden}.thumb img{display:block;width:100%;height:100%;object-fit:contain}.candidate-meta{display:flex;justify-content:space-between;gap:5px;font-size:11px}.candidate-meta strong{font-size:12px}.candidate-meta span{color:#71685b}.badges{display:flex;flex-wrap:wrap;gap:4px;min-height:18px}.badge{padding:2px 5px;border-radius:999px;font-size:9px;font-weight:800;text-transform:uppercase}.badge.anchor{background:#d9ecdf;color:#165c39}.badge.group{background:#e4e1f2;color:#4d3a7b}.badge.conflict{background:#f4d9d5;color:#8c3028}.reason{font-size:11px;line-height:1.3;color:#675d51}.empty{min-height:110px;display:grid;place-items:center;background:#f0ede7;color:#777;border-radius:8px}a{color:#71472c;overflow-wrap:anywhere}dialog{width:min(1100px,calc(100vw - 32px));height:min(900px,calc(100vh - 32px));padding:0;border:0;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.45);overflow:hidden}dialog::backdrop{background:rgba(14,12,10,.78)}.modal-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#181614;color:#fff}.modal-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 18px;border-bottom:1px solid #39342f}.modal-head h2{margin:0;font:600 18px/1.3 Georgia,serif}.modal-close{width:46px;height:46px;border:1px solid #625b54;border-radius:50%;color:#fff;background:#302c28;font-size:28px;cursor:pointer}.modal-stage{min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:18px;background:#0e0d0c}.modal-stage img{display:block;max-width:100%;height:auto;background:#fff}.modal-foot{padding:12px 18px 16px;border-top:1px solid #39342f}.modal-foot p{margin:0 0 7px;color:#ddd3c8}.modal-foot a{color:#f4cda4}@media(max-width:700px){header{padding:16px}.wine-list{padding:16px}.wine-heading{display:block}.status{max-width:none;margin-top:10px;text-align:left}.candidate-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.selected{grid-template-columns:120px 1fr}.thumb{height:145px}}
</style></head><body><header><h1>${report.attempted}-wine image recovery canary</h1><p>${report.accepted}/${report.attempted} accepted · ${recovered} prior misses recovered · ${report.labelBatches} ${esc(labelModel)} label batches · click any candidate to enlarge</p></header><main class="wine-list">${cards.join('\n')}</main>
<dialog id="image-modal" aria-labelledby="modal-title"><div class="modal-shell"><div class="modal-head"><h2 id="modal-title"></h2><button type="button" class="modal-close" aria-label="Close enlarged image">×</button></div><div class="modal-stage"><img id="modal-image" alt=""></div><div class="modal-foot"><p id="modal-reason"></p><a id="modal-source" href="" target="_blank" rel="noopener">Open source page</a></div></div></dialog>
<script>
const modal=document.getElementById('image-modal');const modalImage=document.getElementById('modal-image');const modalTitle=document.getElementById('modal-title');const modalReason=document.getElementById('modal-reason');const modalSource=document.getElementById('modal-source');
document.querySelectorAll('.candidate-open').forEach((button)=>button.addEventListener('click',()=>{modalImage.src=button.dataset.modalSrc;modalImage.alt=button.dataset.modalTitle;modalTitle.textContent=button.dataset.modalTitle;modalReason.textContent=button.dataset.modalReason;modalSource.href=button.dataset.modalPage||'#';modalSource.hidden=!button.dataset.modalPage;modal.showModal();}));
document.querySelector('.modal-close').addEventListener('click',()=>modal.close());modal.addEventListener('click',(event)=>{if(event.target===modal)modal.close();});
</script></body></html>`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(output);
