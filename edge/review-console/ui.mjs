export const APP_CSS = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f4f0e8; color: #251c18; }
* { box-sizing: border-box; }
body { margin: 0; }
button, input, select { font: inherit; }
button { cursor: pointer; }
.login-page { min-height: 100vh; display: grid; place-items: center; padding: 28px 18px; background: radial-gradient(circle at 50% 0%, #fff 0, #f7f3eb 42%, #eee6da 100%); }
.login-shell { width: min(440px, 100%); }
.login-brand { margin-bottom: 20px; text-align: center; }
.login-mark { display: inline-grid; place-items: center; width: 54px; height: 54px; margin-bottom: 14px; border: 1px solid #bca993; border-radius: 50%; background: #fffaf2; color: #7d263b; font: 700 20px/1 Georgia, serif; box-shadow: 0 8px 24px #3c24151a; }
.login-brand h1 { margin: 0; font: 700 clamp(32px, 8vw, 44px)/1.02 Georgia, serif; letter-spacing: -.02em; }
.login-brand p { margin: 10px auto 0; max-width: 34ch; color: #6e5b50; line-height: 1.5; }
.login-card { padding: 28px; border: 1px solid #d9cfc4; border-radius: 16px; background: #fff; box-shadow: 0 18px 50px #3c24151f; }
.login-card label { display: block; margin-bottom: 9px; color: #4c3c34; font-size: 14px; font-weight: 750; }
.login-card input { width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid #bfae9f; border-radius: 9px; background: #fff; color: #251c18; outline: none; }
.login-card input:focus { border-color: #7d263b; box-shadow: 0 0 0 3px #7d263b1f; }
.login-submit { width: 100%; min-height: 48px; margin-top: 14px; border: 0; border-radius: 9px; background: #7d263b; color: #fff; font-weight: 800; box-shadow: 0 8px 18px #7d263b33; }
.login-submit:hover { background: #681f31; }
.login-message { margin: 0 0 16px; padding: 11px 13px; border-left: 4px solid #a12222; border-radius: 7px; background: #fff1f0; color: #8a1d1d; font-size: 14px; line-height: 1.4; }
.login-note { margin: 18px 0 0; color: #78665a; font-size: 12px; line-height: 1.45; text-align: center; }
.shell { width: min(1500px, 100%); margin: 0 auto; padding: 24px; }
.mast { display: flex; gap: 24px; align-items: end; justify-content: space-between; margin-bottom: 20px; }
.mast h1 { margin: 0; font: 700 clamp(28px, 4vw, 52px)/1.02 Georgia, serif; }
.mast p { margin: 8px 0 0; color: #6e5b50; }
.controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.controls input, .controls select { min-width: 220px; padding: 11px 13px; border: 1px solid #c9b9aa; border-radius: 8px; background: #fff; color: #251c18; }
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
.modal { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 22px; background: #171310e8; color: #fff; }
.modal-dialog { width: min(1600px, 100%); max-height: calc(100vh - 44px); display: grid; grid-template-rows: auto 1fr; overflow: hidden; border: 1px solid #ffffff38; border-radius: 14px; background: #211b18; box-shadow: 0 24px 80px #0009; }
.modal-head { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 18px; background: #171310; }
.modal-heading { min-width: 0; }
.modal-heading strong, .modal-heading span { display: block; }
.modal-heading span { margin-top: 3px; color: #cdbfb5; font-size: 13px; }
.modal-stage { overflow: auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(310px, 100%), 1fr)); align-items: start; gap: 14px; padding: 16px; }
.compare-card { min-width: 0; overflow: hidden; border-radius: 10px; background: #fff; color: #251c18; }
.compare-card img { display: block; width: 100%; height: min(58vh, 620px); object-fit: contain; background: #fff; }
.compare-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; padding: 10px; border-top: 1px solid #e4ddd5; }
.compare-actions small { color: #69594f; flex: 1 0 100%; }
.compare-actions a { color: #69594f; overflow-wrap: anywhere; flex: 1 0 100%; }
.compare-actions button { flex: 1; border: 0; border-radius: 7px; padding: 9px 11px; font-weight: 750; }
.compare-remove { background: #eee8e1; color: #493c35; }
.compare-select { background: #7d263b; color: #fff; }
.modal-close { border: 1px solid #fff8; color: #fff; background: transparent; border-radius: 8px; padding: 9px 13px; }
.source { color: #f1d8a8; overflow-wrap: anywhere; }
@media (max-width: 700px) { .shell { padding: 14px; } .mast { align-items: start; flex-direction: column; } .candidate { grid-template-rows: 210px auto; } .candidate img { height: 210px; } }
`;

const FAVICON_BASE64 = 'AAABAAEAEBAAAAEAGABoAwAAFgAAACgAAAAQAAAAIAAAAAEAGAAAAAAAAAAAABMLAAATCwAAAAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////Apdj9/P3///////////////////////////////////+n3NSx4Nn///////////+ui838+/3////////////////////////////////0+/p6yr96yr/5/fz///////+zktD///////////////////////////////////+q3dbE5+O85N+w4Nn///////+jfMfDqdrHr93Hr93Hr93Hr93Eqtvz7ff////7/f16yr/////+//54yb79/v7///+ngMnQvOLVwuXVwuXVwuXVwuXSvuP28fn///+14tus3tf///////+q3da24tz///+zktD///////////////////////////////91yLz7/v3////////6/f11yLz///+rh8v07/j39Pr39Pr39Pr39Pr38/r6+vy44tyo3NX///////////////+p3da34ty3mNOvjM6zktCzktCzktCzktCwjc7Q0+Ws3tfy+fj////////////////1+vmt39j///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AAFDoAACGDQAABwMAAAAAAAAIfwAAAIAAACBIAAAeRQAAk5EAAOO+AACUDgAAAAAAAAh/AAAAgAAAAHAAAKEO';
export const FAVICON = Uint8Array.from(atob(FAVICON_BASE64), (character) => character.charCodeAt(0));

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

function showModal(wine) {
  state.modal = { wine, removed: new Set() };
  renderComparison();
  document.querySelector('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function renderComparison() {
  if (!state.modal) return;
  const { wine, removed } = state.modal;
  const candidates = wine.candidates.filter((candidate) => !removed.has(candidate.candidateId));
  document.querySelector('#modal-title').textContent = wine.displayIdentity;
  document.querySelector('#modal-count').textContent = candidates.length + ' candidate' + (candidates.length === 1 ? '' : 's') + ' remaining';
  const stage = document.querySelector('#modal-stage');
  stage.replaceChildren();
  for (const candidate of candidates) {
    const image = el('img', { src: imageUrl(candidate), alt: wine.displayIdentity });
    const remove = el('button', { class: 'compare-remove', type: 'button', text: 'Remove from comparison' });
    remove.addEventListener('click', () => { removed.add(candidate.candidateId); renderComparison(); });
    const select = el('button', { class: 'compare-select', type: 'button', text: 'Use this image' });
    select.addEventListener('click', () => {
      const wineCard = [...document.querySelectorAll('.wine')].find((card) => card.dataset.sku === wine.sku);
      const candidateCards = [...wineCard.querySelectorAll('.candidate')];
      const index = wine.candidates.findIndex((item) => item.candidateId === candidate.candidateId);
      choose(wine, candidate, candidateCards[index]);
      closeModal();
    });
    const details = (candidate.width || '?') + '×' + (candidate.height || '?') + (candidate.sourceHost ? ' · ' + candidate.sourceHost : '');
    const source = candidate.sourceUrl
      ? el('a', { href: candidate.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: details })
      : el('small', { text: details });
    const actions = el('div', { class: 'compare-actions' }, [source, remove, select]);
    stage.append(el('article', { class: 'compare-card' }, [image, actions]));
  }
  if (!candidates.length) stage.append(el('div', { class: 'empty', text: 'All candidates were removed. Close this comparison and choose “None of these,” or reopen it to start over.' }));
}

function closeModal() {
  document.querySelector('#modal').hidden = true;
  document.querySelector('#modal-stage').replaceChildren();
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
    image.addEventListener('click', (event) => { event.stopPropagation(); showModal(wine); });
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
  const card = el('article', { class: 'wine', 'data-sku': wine.sku, 'data-search': wine.displayIdentity.toLowerCase() }, [head, grid, el('div', { class: 'actions' }, [pick, none, output])]);
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
  for (const person of state.package.reviewers || []) reviewer.append(el('option', { value: person.name, text: person.name }));
  reviewer.disabled = reviewer.options.length === 1;
  if (reviewer.disabled) reviewer.options[0].textContent = 'Reviewer list unavailable';
  const wines = state.package.wines || [];
  status.textContent = wines.length + ' wines need a decision · package expires ' + new Date(state.package.expiresAt).toLocaleDateString();
  if (!wines.length) list.append(el('div', { class: 'empty', text: 'Nothing needs review right now.' }));
  else wines.forEach((wine) => list.append(renderWine(wine)));
}

search.addEventListener('input', applyFilter);
document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', closeModal));
const modal = document.querySelector('#modal');
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
start();
`;

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function documentPage(body, { script = false, bodyClass = '' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fine Vines image review</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="stylesheet" href="/app.css"></head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>${body}${script ? '<script src="/app.js" defer></script>' : ''}</body></html>`;
}

export function loginPage(message = '') {
  const feedback = message ? `<p class="login-message" role="alert">${escapeHtml(message)}</p>` : '';
  return documentPage(`<main class="login-shell"><header class="login-brand"><div class="login-mark" aria-hidden="true">FV</div><h1>Fine Vines</h1><p>Sign in to review and approve bottle images for the catalog.</p></header><section class="login-card">${feedback}<form method="post" action="/login"><label for="password">Review password</label><input id="password" name="password" type="password" required autocomplete="current-password" autofocus placeholder="Enter your password"><button class="login-submit" type="submit">Sign in</button></form><p class="login-note">Private review workspace · Authorized users only</p></section></main>`, { bodyClass: 'login-page' });
}

export function consolePage() {
  return documentPage(`<main class="shell"><header class="mast"><div><h1>Fine Vines image review</h1><p>Compare the candidates, enlarge them, then choose the bottle that matches the wine.</p></div><div class="controls"><select id="reviewer" required aria-label="Your name"><option value="">Select your name</option></select><input id="search" type="search" placeholder="Find a wine" aria-label="Find a wine"></div></header><div id="summary" class="summary">Loading the current review package…</div><section id="wine-list"></section></main>
<div id="modal" class="modal" hidden><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div class="modal-heading"><strong id="modal-title"></strong><span id="modal-count"></span></div><button class="modal-close" type="button" data-close>Close</button></div><div id="modal-stage" class="modal-stage"></div></section></div>`, { script: true });
}
