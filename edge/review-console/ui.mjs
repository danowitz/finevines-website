export const APP_CSS = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f4f0e8; color: #251c18; }
* { box-sizing: border-box; }
body { margin: 0; }
button, input { font: inherit; }
button { cursor: pointer; }
.shell { width: min(1500px, 100%); margin: 0 auto; padding: 24px; }
.mast { display: flex; gap: 24px; align-items: end; justify-content: space-between; margin-bottom: 20px; }
.mast h1 { margin: 0; font: 700 clamp(28px, 4vw, 52px)/1.02 Georgia, serif; }
.mast p { margin: 8px 0 0; color: #6e5b50; }
.controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.controls input { min-width: 220px; padding: 11px 13px; border: 1px solid #c9b9aa; border-radius: 8px; background: #fff; }
.summary { margin: 14px 0 22px; padding: 13px 16px; border-left: 5px solid #7d263b; background: #fff; border-radius: 8px; }
.wine { margin-bottom: 18px; padding: 18px; background: #fff; border: 1px solid #d9cfc4; border-radius: 14px; box-shadow: 0 2px 8px #3c24151a; }
.wine-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
.wine h2 { margin: 0 0 4px; font: 700 24px/1.15 Georgia, serif; }
.wine-meta { color: #78665a; font-size: 13px; }
.candidates { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-top: 15px; }
.candidate { position: relative; display: grid; grid-template-rows: 250px auto; border: 2px solid transparent; border-radius: 11px; background: #f8f6f1; overflow: hidden; text-align: left; padding: 0; }
.candidate:hover, .candidate:focus-visible { border-color: #7d263b; outline: none; }
.candidate.selected { border-color: #16704d; box-shadow: 0 0 0 3px #16704d33; }
.candidate img { width: 100%; height: 250px; object-fit: contain; background: #fff; }
.candidate-info { padding: 10px; min-height: 76px; }
.candidate-info strong { display: block; }
.candidate-info small { display: block; margin-top: 4px; color: #69594f; }
.badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.badge { padding: 3px 6px; border-radius: 99px; background: #e8e0f5; color: #452887; font-size: 10px; font-weight: 800; text-transform: uppercase; }
.actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; align-items: center; }
.primary, .secondary { border: 0; border-radius: 8px; padding: 10px 15px; font-weight: 750; }
.primary { background: #7d263b; color: #fff; }
.primary:disabled { opacity: .45; cursor: not-allowed; }
.secondary { background: #e8e0d7; color: #3a2d26; }
.status { font-size: 13px; color: #5e5048; }
.status.good { color: #12643f; font-weight: 700; }
.status.bad { color: #a12222; font-weight: 700; }
.empty { padding: 50px 20px; text-align: center; background: #fff; border-radius: 14px; }
.modal[hidden] { display: none; }
.modal { position: fixed; inset: 0; z-index: 20; display: grid; grid-template-rows: auto 1fr auto; background: #171310f2; color: #fff; }
.modal-head, .modal-foot { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 18px; background: #171310; }
.modal-stage { overflow: auto; display: grid; place-items: center; padding: 20px; }
.modal-stage img { display: block; width: auto; height: auto; max-width: min(1200px, 92vw); max-height: none; background: #fff; }
.modal-close { border: 1px solid #fff8; color: #fff; background: transparent; border-radius: 8px; padding: 9px 13px; }
.source { color: #f1d8a8; overflow-wrap: anywhere; }
@media (max-width: 700px) { .shell { padding: 14px; } .mast { align-items: start; flex-direction: column; } .candidate { grid-template-rows: 210px auto; } .candidate img { height: 210px; } }
`;

export const APP_JS = `
const state = { package: null, selected: new Map(), modal: null };
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
};
const status = document.querySelector('#summary');
const list = document.querySelector('#wine-list');
const reviewer = document.querySelector('#reviewer');
const search = document.querySelector('#search');

function imageUrl(candidate) {
  return '/api/packages/' + encodeURIComponent(state.package.packageId) + '/images/' + encodeURIComponent(candidate.candidateId);
}

function showModal(wine, candidate) {
  state.modal = { wine, candidate };
  document.querySelector('#modal-title').textContent = wine.displayIdentity;
  const image = document.querySelector('#modal-image');
  image.src = imageUrl(candidate);
  image.alt = wine.displayIdentity;
  const source = document.querySelector('#modal-source');
  source.textContent = candidate.sourceHost || candidate.sourceUrl || 'Source unavailable';
  source.href = candidate.sourceUrl || '#';
  source.hidden = !candidate.sourceUrl;
  document.querySelector('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.querySelector('#modal').hidden = true;
  document.querySelector('#modal-image').removeAttribute('src');
  document.body.style.overflow = '';
  state.modal = null;
}

function choose(wine, candidate, card) {
  state.selected.set(wine.sku, candidate.candidateId);
  card.closest('.wine').querySelectorAll('.candidate').forEach((node) => node.classList.remove('selected'));
  card.classList.add('selected');
  card.closest('.wine').querySelector('.primary').disabled = false;
}

async function submit(wine, candidateId, card) {
  const name = reviewer.value.trim();
  if (!name) { reviewer.focus(); reviewer.setCustomValidity('Enter your name before submitting.'); reviewer.reportValidity(); return; }
  reviewer.setCustomValidity('');
  const kind = candidateId ? 'image-select' : 'no-image';
  const body = {
    kind, reviewer: name, sku: wine.sku, packageId: state.package.packageId,
    targetCatalogCommit: state.package.catalogCommit, wineRevision: wine.wineRevision,
    candidateId: candidateId || '',
  };
  const res = await fetch('/api/actions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.package.csrfToken }, body: JSON.stringify(body) });
  const data = await res.json();
  const output = card.querySelector('.status');
  if (!res.ok) { output.textContent = data.error || 'Could not queue the selection.'; output.className = 'status bad'; return; }
  output.textContent = data.dispatched ? 'Queued. The deployment has been started.' : 'Queued. The nightly processor will pick it up.';
  output.className = 'status good';
  card.querySelectorAll('button').forEach((button) => button.disabled = true);
  poll(data.id, output);
}

async function poll(id, output) {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const res = await fetch('/api/actions/' + encodeURIComponent(id), { credentials: 'same-origin' });
    if (!res.ok) continue;
    const value = await res.json();
    output.textContent = value.status === 'deployed' ? 'Deployed to the website.' : value.status === 'validated' ? 'Test passed; production was not changed.' : value.status === 'conflict' ? 'Conflict: the wine changed; please review it again.' : value.status === 'rejected' ? 'Rejected by the safety checks.' : 'Queued for deployment.';
    output.className = 'status ' + (value.status === 'deployed' || value.status === 'validated' ? 'good' : value.status === 'conflict' || value.status === 'rejected' ? 'bad' : '');
    if (['deployed', 'validated', 'conflict', 'rejected'].includes(value.status)) return;
  }
}

function renderWine(wine) {
  const title = el('h2', { text: wine.displayIdentity });
  const meta = el('div', { class: 'wine-meta', text: 'SKU ' + wine.sku + ' · ' + wine.candidates.length + ' candidate' + (wine.candidates.length === 1 ? '' : 's') });
  const head = el('div', { class: 'wine-head' }, [el('div', {}, [title, meta])]);
  const grid = el('div', { class: 'candidates' });
  wine.candidates.forEach((candidate, index) => {
    const image = el('img', { src: imageUrl(candidate), alt: wine.displayIdentity, loading: 'lazy' });
    image.addEventListener('click', (event) => { event.stopPropagation(); showModal(wine, candidate); });
    const info = el('div', { class: 'candidate-info' }, [
      el('strong', { text: 'Candidate ' + (index + 1) }),
      el('small', { text: (candidate.width || '?') + '×' + (candidate.height || '?') + (candidate.sourceHost ? ' · ' + candidate.sourceHost : '') }),
    ]);
    const badges = el('div', { class: 'badges' });
    for (const badge of candidate.badges || []) badges.append(el('span', { class: 'badge', text: badge }));
    info.append(badges);
    const card = el('button', { class: 'candidate', type: 'button' }, [image, info]);
    card.addEventListener('click', () => choose(wine, candidate, card));
    grid.append(card);
  });
  const pick = el('button', { class: 'primary', type: 'button', disabled: 'disabled', text: 'Use selected image' });
  const none = el('button', { class: 'secondary', type: 'button', text: 'None of these' });
  const output = el('span', { class: 'status', text: '' });
  const card = el('article', { class: 'wine', 'data-search': wine.displayIdentity.toLowerCase() }, [head, grid, el('div', { class: 'actions' }, [pick, none, output])]);
  pick.addEventListener('click', () => submit(wine, state.selected.get(wine.sku), card));
  none.addEventListener('click', () => submit(wine, '', card));
  return card;
}

function applyFilter() {
  const query = search.value.trim().toLowerCase();
  document.querySelectorAll('.wine').forEach((card) => { card.hidden = query && !card.dataset.search.includes(query); });
}

async function start() {
  const res = await fetch('/api/current', { credentials: 'same-origin' });
  if (!res.ok) { status.textContent = 'The review package is not available. Please try again later.'; return; }
  state.package = await res.json();
  const wines = state.package.wines || [];
  status.textContent = wines.length + ' wines need a decision · package expires ' + new Date(state.package.expiresAt).toLocaleDateString();
  if (!wines.length) list.append(el('div', { class: 'empty', text: 'Nothing needs review right now.' }));
  else wines.forEach((wine) => list.append(renderWine(wine)));
}

search.addEventListener('input', applyFilter);
document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', closeModal));
document.querySelector('#modal-select').addEventListener('click', () => {
  if (!state.modal) return;
  const card = [...document.querySelectorAll('.wine')].find((node) => node.querySelector('.wine-meta').textContent.startsWith('SKU ' + state.modal.wine.sku));
  const candidateCards = [...card.querySelectorAll('.candidate')];
  const index = state.modal.wine.candidates.findIndex((candidate) => candidate.candidateId === state.modal.candidate.candidateId);
  choose(state.modal.wine, state.modal.candidate, candidateCards[index]);
  closeModal();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
start();
`;

export function consolePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fine Vines image review</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="shell"><header class="mast"><div><h1>Fine Vines image review</h1><p>Compare the candidates, enlarge them, then choose the bottle that matches the wine.</p></div><div class="controls"><input id="reviewer" autocomplete="name" placeholder="Your name" aria-label="Your name"><input id="search" type="search" placeholder="Find a wine" aria-label="Find a wine"></div></header><div id="summary" class="summary">Loading the current review package…</div><section id="wine-list"></section></main>
<div id="modal" class="modal" hidden><div class="modal-head"><strong id="modal-title"></strong><button class="modal-close" type="button" data-close>Close</button></div><div class="modal-stage"><img id="modal-image" alt=""></div><div class="modal-foot"><a id="modal-source" class="source" target="_blank" rel="noopener noreferrer"></a><button id="modal-select" class="primary" type="button">Select this image</button></div></div>
<script src="/app.js" defer></script></body></html>`;
}
