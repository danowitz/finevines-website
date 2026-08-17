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
.summary small { display: block; margin-top: 5px; color: #78665a; font-size: 12px; }
.incidents:empty { display: none; }
.incident { margin: 0 0 12px; padding: 14px 16px; border: 2px solid #a12222; border-radius: 10px; background: #fff1f0; color: #681717; }
.incident strong, .incident span { display: block; }
.incident span { margin-top: 4px; line-height: 1.4; }
.incident button { margin-top: 10px; border: 0; border-radius: 7px; padding: 8px 12px; background: #7d263b; color: #fff; font-weight: 750; }
.admin { margin: 0 0 18px; padding: 16px; border: 1px solid #d9cfc4; border-radius: 10px; background: #fff; }
.admin:empty { display: none; }
.admin details > summary { cursor: pointer; font: 700 18px/1.2 Georgia, serif; }
.admin-intro { margin: 12px 0 4px; color: #6e5b50; font-size: 13px; }
.account { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid #eee5dc; }
.account > div { flex: 1; min-width: 240px; }
.account strong, .account small { display: block; }
.account small { margin-top: 3px; color: #78665a; }
.account button { border: 0; border-radius: 7px; padding: 8px 11px; background: #e8e0d7; font-weight: 750; }
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
.modal-stage { overflow-x: auto; overflow-y: hidden; display: flex; align-items: stretch; gap: 14px; padding: 16px; }
.compare-card { flex: 0 0 clamp(300px, 24vw, 430px); min-width: 0; display: flex; flex-direction: column; overflow: hidden; border-radius: 10px; background: #fff; color: #251c18; }
.compare-card img { display: block; width: 100%; height: min(65vh, 700px); min-height: 0; object-fit: contain; background: #fff; }
.compare-card .compare-actions { margin-top: auto; }
.compare-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; padding: 10px; border-top: 1px solid #e4ddd5; }
.compare-actions small { color: #69594f; flex: 1 0 100%; }
.compare-actions a { color: #69594f; overflow-wrap: anywhere; flex: 1 0 100%; }
.compare-actions button { flex: 1; border: 0; border-radius: 7px; padding: 9px 11px; font-weight: 750; }
.compare-remove { background: #eee8e1; color: #493c35; }
.compare-select { background: #7d263b; color: #fff; }
.modal-close { border: 1px solid #fff8; color: #fff; background: transparent; border-radius: 8px; padding: 9px 13px; }
.source { color: #f1d8a8; overflow-wrap: anywhere; }
.google-search { display: inline-flex; align-items: center; min-height: 40px; padding: 9px 13px; border: 1px solid #bca993; border-radius: 8px; color: #6f2035; background: #fffaf2; font-weight: 750; text-decoration: none; white-space: nowrap; }
.google-search:hover, .google-search:focus-visible { border-color: #7d263b; outline: 3px solid #7d263b1f; }
.paste-zone { margin-top: 14px; padding: 16px; border: 2px dashed #bca993; border-radius: 11px; background: #fffcf7; outline: none; }
.paste-zone:focus { border-color: #7d263b; box-shadow: 0 0 0 3px #7d263b1f; }
.paste-prompt { margin: 0; color: #594940; font-weight: 700; text-align: center; }
.paste-note { display: block; margin-top: 5px; color: #78665a; font-size: 12px; text-align: center; }
.paste-preview { display: grid; grid-template-columns: minmax(140px, 240px) 1fr; gap: 16px; align-items: center; }
.paste-preview img { width: 100%; height: 250px; object-fit: contain; background: #fff; border-radius: 8px; }
.paste-preview .paste-note { text-align: left; }
.paste-buttons { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 12px; }
.paste-error { margin: 9px 0 0; color: #a12222; font-size: 13px; font-weight: 700; }
@media (max-width: 700px) { .shell { padding: 14px; } .mast { align-items: start; flex-direction: column; } .candidate { grid-template-rows: 210px auto; } .candidate img { height: 210px; } .paste-preview { grid-template-columns: 1fr; } }
`;

const FAVICON_BASE64 = 'AAABAAEAEBAAAAEAGABoAwAAFgAAACgAAAAQAAAAIAAAAAEAGAAAAAAAAAAAABMLAAATCwAAAAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////Apdj9/P3///////////////////////////////////+n3NSx4Nn///////////+ui838+/3////////////////////////////////0+/p6yr96yr/5/fz///////+zktD///////////////////////////////////+q3dbE5+O85N+w4Nn///////+jfMfDqdrHr93Hr93Hr93Hr93Eqtvz7ff////7/f16yr/////+//54yb79/v7///+ngMnQvOLVwuXVwuXVwuXVwuXSvuP28fn///+14tus3tf///////+q3da24tz///+zktD///////////////////////////////91yLz7/v3////////6/f11yLz///+rh8v07/j39Pr39Pr39Pr39Pr38/r6+vy44tyo3NX///////////////+p3da34ty3mNOvjM6zktCzktCzktCzktCwjc7Q0+Ws3tfy+fj////////////////1+vmt39j///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AAFDoAACGDQAABwMAAAAAAAAIfwAAAIAAACBIAAAeRQAAk5EAAOO+AACUDgAAAAAAAAh/AAAAgAAAAHAAAKEO';
export const FAVICON = Uint8Array.from(atob(FAVICON_BASE64), (character) => character.charCodeAt(0));

export const APP_JS = `
const state = { package: null, selected: new Map(), modal: null, refreshing: null };
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
const incidentList = document.querySelector('#incidents');
const admin = document.querySelector('#admin');

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

async function finishQueue(wine, card) {
  const previewUrl = card.querySelector('.paste-zone')?.dataset.previewUrl;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  state.selected.delete(wine.sku);
  await refresh();
}

async function submit(wine, candidateId, card) {
  const kind = candidateId ? 'image-select' : 'no-image';
  const body = {
    kind, sku: wine.sku, packageId: state.package.packageId,
    targetCatalogCommit: state.package.catalogCommit, wineRevision: wine.wineRevision,
    candidateId: candidateId || '',
  };
  const res = await fetch('/api/actions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.package.csrfToken }, body: JSON.stringify(body) });
  const data = await res.json();
  const output = card.querySelector('.status');
  if (!res.ok) { output.textContent = data.error || 'Could not queue the selection.'; output.className = 'status bad'; return; }
  output.textContent = data.dispatched ? 'Queued. Processing is starting now.' : 'Queued. The processor checks for new decisions every five minutes.';
  output.className = 'status good';
  card.querySelectorAll('button').forEach((button) => button.disabled = true);
  await finishQueue(wine, card);
}

async function submitPasted(wine, file, card, button, output) {
  button.disabled = true;
  output.textContent = 'Saving and queueing the pasted image…';
  output.className = 'paste-error';
  const body = new FormData();
  body.set('sku', wine.sku);
  body.set('packageId', state.package.packageId);
  body.set('targetCatalogCommit', state.package.catalogCommit);
  body.set('wineRevision', wine.wineRevision);
  body.set('image', file, file.name || 'pasted-image');
  const res = await fetch('/api/reviewer-images', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': state.package.csrfToken }, body });
  const data = await res.json();
  if (!res.ok) {
    output.textContent = data.error || 'Could not queue the pasted image.';
    output.className = 'paste-error';
    button.disabled = false;
    return;
  }
  await finishQueue(wine, card);
}

function showPastedImage(wine, card, zone, file) {
  if (zone.dataset.previewUrl) URL.revokeObjectURL(zone.dataset.previewUrl);
  const previewUrl = URL.createObjectURL(file);
  zone.dataset.previewUrl = previewUrl;
  const image = el('img', { src: previewUrl, alt: 'Pasted image for ' + wine.displayIdentity });
  const clear = el('button', { class: 'secondary', type: 'button', text: 'Clear' });
  const use = el('button', { class: 'primary', type: 'button', text: 'Use this image' });
  const output = el('p', { class: 'paste-error', text: '' });
  clear.addEventListener('click', (event) => {
    event.stopPropagation();
    URL.revokeObjectURL(previewUrl);
    delete zone.dataset.previewUrl;
    renderPastePrompt(wine, card, zone);
  });
  use.addEventListener('click', (event) => { event.stopPropagation(); submitPasted(wine, file, card, use, output); });
  zone.replaceChildren(el('div', { class: 'paste-preview' }, [image, el('div', {}, [
    el('strong', { text: 'Keep this pasted image?' }),
    el('span', { class: 'paste-note', text: 'Your selection is treated as the correct bottle image.' }),
    el('div', { class: 'paste-buttons' }, [clear, use]), output,
  ])]));
}

function renderPastePrompt(wine, card, zone) {
  zone.replaceChildren(
    el('p', { class: 'paste-prompt', text: 'Click here, then press Control V to paste your image.' }),
    el('span', { class: 'paste-note', text: 'JPEG, PNG, or WebP · maximum 10 MB' }),
  );
  zone.onclick = () => zone.focus();
}

function pasteZone(wine, card) {
  const zone = el('div', { class: 'paste-zone', tabindex: '0', role: 'group', 'aria-label': 'Paste an image for ' + wine.displayIdentity });
  renderPastePrompt(wine, card, zone);
  zone.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    const item = [...(event.clipboardData?.items || [])].find((value) => value.kind === 'file' && value.type.startsWith('image/'));
    const file = files.find((value) => value.type.startsWith('image/')) || item?.getAsFile();
    if (!file) {
      zone.replaceChildren(el('p', { class: 'paste-error', text: 'The clipboard does not contain an image. Copy the image itself, then try again.' }));
      return;
    }
    event.preventDefault();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      zone.replaceChildren(el('p', { class: 'paste-error', text: 'Paste a JPEG, PNG, or WebP image.' }));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      zone.replaceChildren(el('p', { class: 'paste-error', text: 'The pasted image must be 10 MB or smaller.' }));
      return;
    }
    showPastedImage(wine, card, zone, file);
  });
  return zone;
}

function renderWine(wine) {
  const title = el('h2', { text: wine.displayIdentity });
  const meta = el('div', { class: 'wine-meta', text: 'SKU ' + wine.sku + ' · ' + wine.candidates.length + ' candidate' + (wine.candidates.length === 1 ? '' : 's') });
  const searchLink = wine.searchQuery
    ? el('a', { class: 'google-search', href: 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(wine.searchQuery), target: '_blank', rel: 'noopener noreferrer', text: 'Search Google Images' })
    : el('span', { class: 'wine-meta', text: 'Exact search query unavailable' });
  const head = el('div', { class: 'wine-head' }, [el('div', {}, [title, meta]), searchLink]);
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
  const card = el('article', { class: 'wine', 'data-sku': wine.sku }, [head, grid]);
  card.append(pasteZone(wine, card), el('div', { class: 'actions' }, [pick, none, output]));
  pick.addEventListener('click', () => submit(wine, state.selected.get(wine.sku), card));
  none.addEventListener('click', () => submit(wine, '', card));
  return card;
}

function summaryText(reviewStatus, expiresAt) {
  const value = reviewStatus || {};
  return [
    (value.needsDecision || 0) + ' need a decision',
    (value.queued || 0) + ' queued',
    (value.processing || 0) + ' processing',
    (value.completed || 0) + ' completed',
    (value.needsAttention || 0) + ' need attention',
  ].join(' · ') + ' · package expires ' + new Date(expiresAt).toLocaleDateString();
}

async function recoverIncident(incident, operation, button) {
  button.disabled = true;
  let reason = '';
  if (operation === 'reopen' || operation === 'exclude') {
    reason = prompt(operation === 'exclude' ? 'Why should this wine be temporarily excluded?' : 'Why are you reopening the original choices?') || '';
    if (!reason.trim()) { button.disabled = false; return; }
  }
  const res = await fetch('/api/admin/actions/' + encodeURIComponent(incident.actionId) + '/' + operation, {
    method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': state.package.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
  });
  if (!res.ok) { button.disabled = false; button.textContent = 'Retry failed'; return; }
  await refresh();
}

async function loadAccounts() {
  const res = await fetch('/api/admin/accounts', { credentials: 'same-origin' });
  if (!res.ok) return;
  const value = await res.json();
  const accounts = value.accounts || [];
  const rows = [el('p', { class: 'admin-intro', text: 'Invitations are only needed for new reviewers. Active reviewers can already sign in.' })];
  const labels = { invitation_pending: 'Not invited', invited: 'Invitation sent', active: 'Active' };
  for (const account of accounts) {
    const row = el('div', { class: 'account' }, [el('div', {}, [
      el('strong', { text: account.name + ' · ' + (labels[account.status] || account.status) }),
      el('small', { text: account.email + ' · ' + account.role }),
    ])]);
    if (account.status !== 'active') {
      const button = el('button', { type: 'button', text: account.status === 'invitation_pending' ? 'Send invitation' : 'Send new invitation' });
      button.addEventListener('click', async () => {
        button.disabled = true;
        const response = await fetch('/api/admin/accounts/' + encodeURIComponent(account.email) + '/activate', {
          method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': value.csrfToken },
        });
        if (response.ok) await loadAccounts();
        else { button.textContent = 'Could not send invitation'; button.disabled = false; }
      });
      row.append(button);
    }
    rows.push(row);
  }
  admin.replaceChildren(el('details', {}, [el('summary', { text: 'Manage reviewer access (' + accounts.length + ')' }), ...rows]));
}

async function refresh() {
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    const res = await fetch('/api/current', { credentials: 'same-origin' });
    if (!res.ok) { status.textContent = 'The review package is not available. Please try again later.'; return; }
    state.package = await res.json();
    const wines = state.package.wines || [];
    status.replaceChildren(
      document.createTextNode(summaryText(state.package.reviewStatus, state.package.expiresAt)),
      el('small', { text: 'Updates automatically every 10 seconds while this window is active.' }),
    );
    incidentList.replaceChildren();
    for (const incident of state.package.incidents || []) {
      const controls = el('div', { class: 'actions' });
      if (state.package.isAdministrator && incident.status === 'needs_attention') {
        for (const [operation, label] of [['retry', 'Retry safely'], ['reopen', 'Reopen choices'], ['rediscover', 'Search more broadly'], ['exclude', 'Temporarily exclude']]) {
          const button = el('button', { type: 'button', text: label });
          button.addEventListener('click', () => recoverIncident(incident, operation, button));
          controls.append(button);
        }
      }
      incidentList.append(el('section', { class: 'incident', role: 'alert' }, [
        el('strong', { text: 'Review issue · SKU ' + incident.sku }),
        el('span', { text: incident.reason + ' · open ' + incident.ageMinutes + ' minutes' }),
        el('span', { text: 'Next: ' + incident.nextAction }),
        controls,
      ]));
    }
    list.replaceChildren();
    if (!wines.length) list.append(el('div', { class: 'empty', text: 'Nothing needs review right now.' }));
    else wines.forEach((wine) => list.append(renderWine(wine)));
  })();
  try { await state.refreshing; } finally { state.refreshing = null; }
}

document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', closeModal));
const modal = document.querySelector('#modal');
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
const activeRefresh = () => {
  if (document.visibilityState === 'visible' && document.hasFocus()) refresh();
};
window.addEventListener('focus', activeRefresh);
document.addEventListener('visibilitychange', activeRefresh);
setInterval(activeRefresh, 10_000);
refresh().then(() => { if (state.package?.isAdministrator) loadAccounts(); });
`;

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function documentPage(body, { script = false, bodyClass = '' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fine Vines image review</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="stylesheet" href="/app.css"></head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>${body}${script ? '<script src="/app.js" defer></script>' : ''}</body></html>`;
}

export function loginPage(message = '') {
  const feedback = message ? `<p class="login-message" role="alert">${escapeHtml(message)}</p>` : '';
  return documentPage(`<main class="login-shell"><header class="login-brand"><div class="login-mark" aria-hidden="true">FV</div><h1>Fine Vines</h1><p>Sign in to review and approve bottle images for the catalog.</p></header><section class="login-card">${feedback}<form method="post" action="/login"><label for="email">Email address</label><input id="email" name="email" type="email" required autocomplete="username" autofocus placeholder="you@example.com"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Enter your password"><button class="login-submit" type="submit">Sign in</button></form><p class="login-note">Private review workspace · Authorized users only</p></section></main>`, { bodyClass: 'login-page' });
}

export function changePasswordPage(csrf, message = '') {
  const feedback = message ? `<p class="login-message" role="alert">${escapeHtml(message)}</p>` : '';
  return documentPage(`<main class="login-shell"><header class="login-brand"><div class="login-mark" aria-hidden="true">FV</div><h1>Choose your password</h1><p>Your temporary password must be replaced before you can review images.</p></header><section class="login-card">${feedback}<form method="post" action="/change-password"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label for="current-password">Temporary password</label><input id="current-password" name="currentPassword" type="password" required autocomplete="current-password"><label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" required minlength="8" autocomplete="new-password"><button class="login-submit" type="submit">Save password</button></form></section></main>`, { bodyClass: 'login-page' });
}

export function consolePage(reviewer) {
  return documentPage(`<main class="shell"><header class="mast"><div><h1>Fine Vines image review</h1><p>Compare the candidates, enlarge them, then choose the bottle that matches the wine.</p></div><div class="controls"><span>Signed in as ${escapeHtml(reviewer.name)}</span></div></header><div id="summary" class="summary">Loading the current review package…</div><div id="incidents" class="incidents" aria-live="polite"></div><section id="admin" class="admin"></section><section id="wine-list"></section></main>
<div id="modal" class="modal" hidden><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div class="modal-heading"><strong id="modal-title"></strong><span id="modal-count"></span></div><button class="modal-close" type="button" data-close>Close</button></div><div id="modal-stage" class="modal-stage"></div></section></div>`, { script: true });
}
