// Builds reports/oldsite-review.html — a self-contained page for a human to
// choose, wine by wine, between the photograph currently live on the site and
// the one mirrored from the old finevines.com before it goes dark.
//
// Two populations, per the harvest's own framing (tools/oldsiteharvest/harvest.mjs):
//   rescues  — wines on the neutral placeholder today that now have an old-site
//              photo. No contest; the only question is whether it's good enough.
//   contests — wines that already have a photo AND an old-site photo. A human
//              picks.
//
// The join and classification live in reviewjoin.mjs (unit tested) — this file
// is rendering only. Images are referenced by path relative to reports/, so
// the page works opened directly from the filesystem with no server; see
// verifyRelativePaths below, which is what actually proves that rather than
// assuming the directory depth.
//
//   node tools/oldsiteharvest/reviewpage.mjs
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { joinManifest } from './reviewjoin.mjs';

const MANIFEST = 'data/oldsite-mirror/manifest.json';
const WINES = 'data/wines.json';
const OUT_DIR = 'reports';
const OUT_FILE = join(OUT_DIR, 'oldsite-review.html');

// Both image roots sit one level up from reports/, alongside it — NOT nested
// under it. Verified for real in verifyRelativePaths, not just assumed here.
const OLD_SITE_REL = '../data/oldsite-mirror';
const UP_ONE = '..';

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// Confirms every relative path this page emits actually resolves from
// reports/ — the exact thing "assuming the path depth" would get wrong.
// Returns the list of paths that do NOT resolve, so the caller can decide
// whether to proceed (a handful of missing old-site files, already logged
// per-image, is not fatal; every path failing would mean the directory
// structure assumption is wrong).
async function verifyRelativePaths(rows) {
  const missing = [];
  const checked = new Set();
  for (const row of rows) {
    // Only contest rows render the "current" candidate — a rescue's
    // currentImagePath points at the generated-at-build-time neutral SVG,
    // which the page never links to, so it must not be checked here either.
    if (row.currentIsPhoto && row.currentImagePath) {
      const rel = `${UP_ONE}/${row.currentImagePath}`;
      const disk = join(OUT_DIR, rel);
      if (!checked.has(disk)) {
        checked.add(disk);
        if (!(await exists(disk))) missing.push(disk);
      }
    }
    for (const img of row.oldSiteImages) {
      const rel = `${OLD_SITE_REL}/${img.file}`;
      const disk = join(OUT_DIR, rel);
      if (!checked.has(disk)) {
        checked.add(disk);
        if (!(await exists(disk))) missing.push(disk);
      }
    }
  }
  return missing;
}

function candidateHtml(row) {
  const parts = [];

  if (row.currentIsPhoto) {
    parts.push(`
      <label class="candidate current" data-role="current">
        <input type="radio" name="row-${escapeAttr(row.sku)}" value="current" ${row.currentIsPhoto ? 'checked' : ''}>
        <div class="frame"><img src="${UP_ONE}/${escapeAttr(row.currentImagePath)}" loading="lazy" alt="Current site image"></div>
        <span class="tag tag-current">Current site</span>
      </label>`);
  }

  row.oldSiteImages.forEach((img, i) => {
    const isDefaultOld = !row.currentIsPhoto && i === 0;
    parts.push(`
      <label class="candidate old" data-role="old" data-file="${escapeAttr(img.file)}" data-url="${escapeAttr(img.imageUrl)}">
        <input type="radio" name="row-${escapeAttr(row.sku)}" value="old-${i}" ${isDefaultOld ? 'checked' : ''}>
        <div class="frame"><img src="${OLD_SITE_REL}/${escapeAttr(img.file)}" loading="lazy" alt="Old-site image"></div>
        <span class="tag tag-old">Old site${row.oldSiteImages.length > 1 ? ` #${i + 1}` : ''}</span>
        <a class="src" href="${escapeAttr(img.imageUrl)}" target="_blank" rel="noopener">${escapeHtml(img.oldPath)}</a>
      </label>`);
  });

  parts.push(`
      <label class="candidate neither" data-role="neither">
        <input type="radio" name="row-${escapeAttr(row.sku)}" value="neither">
        <span class="tag tag-neither">Neither</span>
      </label>`);

  return parts.join('\n');
}

function rowHtml(row) {
  const title = [row.producer, row.name].filter(Boolean).join(' — ');
  return `
    <section class="row" data-sku="${escapeAttr(row.sku)}">
      <h3>${escapeHtml(title)}${row.vintage ? ` <span class="vintage">${escapeHtml(row.vintage)}</span>` : ''}
        <span class="sku">SKU ${escapeHtml(row.sku)}</span></h3>
      <div class="candidates">
        ${candidateHtml(row)}
      </div>
    </section>`;
}

function sectionHtml(title, note, rows) {
  if (!rows.length) return '';
  return `
  <h2>${escapeHtml(title)} <span class="count">${rows.length}</span></h2>
  <p class="section-note">${escapeHtml(note)}</p>
  ${rows.map(rowHtml).join('\n')}`;
}

function pageHtml({ rescues, contests, stats, generatedAt }) {
  const totalRows = rescues.length + contests.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Old-site image review</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; padding: 0 0 6rem; background: #f6f5f3; color: #1c1a17; }
  header { position: sticky; top: 0; z-index: 10; background: #1c1a17; color: #f6f5f3; padding: 0.9rem 1.5rem; display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
  header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
  #progress { font-variant-numeric: tabular-nums; }
  #progress-bar { flex: 1 1 160px; max-width: 320px; height: 8px; background: #3a3630; border-radius: 4px; overflow: hidden; }
  #progress-bar-fill { height: 100%; width: 0%; background: #c9a24b; transition: width .15s ease; }
  .actions { margin-left: auto; display: flex; gap: 0.5rem; }
  button { font: inherit; padding: 0.5rem 0.9rem; border-radius: 6px; border: 1px solid #c9a24b; background: #c9a24b; color: #1c1a17; cursor: pointer; font-weight: 600; }
  button.secondary { background: transparent; color: #f6f5f3; }
  #toast { position: fixed; right: 1rem; bottom: 1rem; background: #1c1a17; color: #f6f5f3; padding: 0.6rem 1rem; border-radius: 6px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: 1; }
  main { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
  .stats { font-size: 0.85rem; color: #6b6459; margin: 0 0 1.5rem; }
  h2 { margin-top: 2.5rem; border-bottom: 2px solid #c9a24b; padding-bottom: 0.3rem; }
  .count { color: #6b6459; font-weight: 400; font-size: 0.85em; }
  .section-note { color: #6b6459; font-size: 0.9rem; margin-top: -0.5rem; }
  .row { background: #fff; border: 1px solid #e2ddd3; border-radius: 8px; padding: 1rem 1.2rem; margin: 1rem 0; }
  .row h3 { margin: 0 0 0.8rem; font-size: 1rem; }
  .row .vintage { color: #6b6459; font-weight: 400; }
  .row .sku { float: right; color: #6b6459; font-weight: 400; font-size: 0.85em; }
  .candidates { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; }
  .candidate { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; width: 320px; padding: 0.6rem; border: 2px solid transparent; border-radius: 8px; cursor: pointer; }
  .candidate:has(input:checked) { border-color: #c9a24b; background: #fbf6ea; }
  .candidate input { margin: 0 0 0.2rem; }
  .frame { width: 100%; height: 420px; background: #efece5; border-radius: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .frame img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .tag { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; padding: 0.15rem 0.5rem; border-radius: 999px; }
  .tag-current { background: #dbe7de; color: #235339; }
  .tag-old { background: #e6dfce; color: #6b5423; }
  .tag-neither { background: #eee; color: #666; }
  .candidate.neither { width: auto; min-width: 100px; justify-content: center; min-height: 100px; }
  .src { font-size: 0.75rem; color: #8a5a00; word-break: break-all; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #171512; color: #e9e5dc; }
    .row { background: #221f1b; border-color: #3a352c; }
    .frame { background: #2b2822; }
    .candidate:has(input:checked) { background: #2e2818; }
    .stats, .section-note, .row .vintage, .row .sku { color: #a89f8f; }
  }
</style>
</head>
<body>
<header>
  <h1>Old-site image review</h1>
  <span id="progress">0 of ${totalRows} reviewed</span>
  <div id="progress-bar"><div id="progress-bar-fill"></div></div>
  <div class="actions">
    <button class="secondary" id="reset-btn" type="button">Reset</button>
    <button id="copy-btn" type="button">Copy JSON</button>
    <button id="download-btn" type="button">Download JSON</button>
  </div>
</header>
<main>
  <p class="stats">
    Generated ${escapeHtml(generatedAt)} &middot;
    ${stats.byTarget} joined by target, ${stats.bySku} by SKU fallback, ${stats.unmatched} unmatched &middot;
    ${rescues.length} rescues, ${contests.length} contests
  </p>
  ${sectionHtml('Rescues', 'No current photo — the only question is whether the old-site image is good enough to publish. Defaults to the old-site image.', rescues)}
  ${sectionHtml('Contests', 'Already has a photo and an old-site photo exists. Defaults to keeping the current image.', contests)}
</main>
<div id="toast"></div>
<script>
(function () {
  'use strict';
  var STORAGE_KEY = 'oldsite-review-decisions-v1';
  var rows = Array.prototype.slice.call(document.querySelectorAll('section.row'));
  var totalEl = document.getElementById('progress');
  var barEl = document.getElementById('progress-bar-fill');
  var toastEl = document.getElementById('toast');
  var total = rows.length;

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { /* storage unavailable — the review still works this session */ }
  }

  var state = loadState();

  function applyStoredChoice(row, saved) {
    if (!saved) return;
    var sku = row.getAttribute('data-sku');
    var input;
    if (saved.choice === 'old') {
      var label = row.querySelector('.candidate.old[data-file="' + CSS.escape(saved.file || '') + '"]');
      input = label ? label.querySelector('input') : null;
    } else {
      input = row.querySelector('input[value="' + saved.choice + '"]');
    }
    if (input) input.checked = true;
  }

  rows.forEach(function (row) {
    var sku = row.getAttribute('data-sku');
    applyStoredChoice(row, state[sku]);
  });

  function readChoice(row) {
    var checked = row.querySelector('input:checked');
    if (!checked) return null;
    var label = checked.closest('label');
    var role = label.getAttribute('data-role');
    if (role === 'current') return { choice: 'current', file: null, sourceUrl: null };
    if (role === 'neither') return { choice: 'neither', file: null, sourceUrl: null };
    return { choice: 'old', file: label.getAttribute('data-file'), sourceUrl: label.getAttribute('data-url') };
  }

  function updateProgress() {
    var reviewed = Object.keys(state).length;
    totalEl.textContent = reviewed + ' of ' + total + ' reviewed';
    barEl.style.width = (total ? (100 * reviewed / total) : 0) + '%';
  }

  rows.forEach(function (row) {
    var sku = row.getAttribute('data-sku');
    row.querySelectorAll('input[type=radio]').forEach(function (input) {
      // 'click', not 'change': clicking the option already selected (the
      // default) must still register as the reviewer having looked at this
      // row, and 'change' does not fire when the value does not change.
      input.addEventListener('click', function () {
        state[sku] = readChoice(row);
        saveState(state);
        updateProgress();
      });
    });
  });

  document.getElementById('reset-btn').addEventListener('click', function () {
    if (!confirm('Clear all reviewed selections on this device? Rows will revert to their defaults.')) return;
    state = {};
    saveState(state);
    location.reload();
  });

  function currentDecisions() {
    return rows.map(function (row) {
      var sku = row.getAttribute('data-sku');
      var c = readChoice(row) || { choice: 'neither', file: null, sourceUrl: null };
      return { sku: sku, choice: c.choice, file: c.file, sourceUrl: c.sourceUrl };
    });
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }

  document.getElementById('copy-btn').addEventListener('click', function () {
    var json = JSON.stringify(currentDecisions(), null, 1);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () { showToast('Copied ' + rows.length + ' decisions to clipboard'); },
        function () { prompt('Copy failed — copy manually:', json); });
    } else {
      prompt('Copy this JSON:', json);
    }
  });

  document.getElementById('download-btn').addEventListener('click', function () {
    var json = JSON.stringify(currentDecisions(), null, 1);
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'oldsite-review-decisions.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Downloaded decisions JSON');
  });

  updateProgress();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const wines = JSON.parse(await readFile(WINES, 'utf8'));
  const { rescues, contests, stats } = joinManifest(manifest, wines);

  console.log(`join: ${stats.byTarget} by target, ${stats.bySku} by SKU fallback, ${stats.unmatched} unmatched (${stats.skippedNoSku} manifest entries had no SKU to join on)`);
  console.log(`rescues: ${rescues.length}   contests: ${contests.length}`);

  const missing = await verifyRelativePaths([...rescues, ...contests]);
  if (missing.length) {
    console.log(`\n${missing.length} referenced image path(s) did not resolve on disk (shown broken on the page, not fatal):`);
    for (const m of missing.slice(0, 20)) console.log(`  ${m}`);
    if (missing.length > 20) console.log(`  ...and ${missing.length - 20} more`);
  } else {
    console.log('\nevery relative image path resolved from reports/ — verified on disk, not assumed');
  }

  const html = pageHtml({ rescues, contests, stats, generatedAt: new Date().toISOString() });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, html);
  console.log(`\nwrote ${OUT_FILE}`);
}

main();
