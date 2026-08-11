import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const input = process.argv[2] || 'out-bottle/image-canary.json';
const output = process.argv[3] || 'out-bottle/image-canary.html';
const report = JSON.parse(await readFile(input, 'utf8'));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const cards = report.rows.map((row) => {
  const image = row.ok && row.file ? pathToFileURL(resolve(row.file)).href : '';
  const reason = row.tried?.[0]?.why || row.discoveryError || 'no result';
  return `<article class="${row.ok ? 'ok' : 'miss'}">
    <h2>${esc(row.name)}</h2>
    <p class="status">${row.ok ? `ACCEPTED &middot; ${esc(row.size)} &middot; ${esc(row.matchingImages)} matching` : `NO PICK &middot; ${esc(reason)}`}</p>
    ${image ? `<img src="${esc(image)}" alt="${esc(row.name)}">` : '<div class="empty">No staged image</div>'}
    ${row.ok ? `<p class="label">Label: ${esc(row.label)}</p><p><a href="${esc(row.page)}">${esc(row.page)}</a></p>` : ''}
  </article>`;
}).join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Image canary</title><style>
body{margin:24px;background:#f4f1e8;color:#201d18;font:14px/1.4 system-ui}header{margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.grid article{background:white;border:1px solid #d8d0bf;border-radius:10px;padding:14px;min-height:420px}
h1{margin:0}h2{font:600 16px/1.25 Georgia,serif;min-height:40px}.status{font-size:12px;font-weight:700}.ok .status{color:#176c43}.miss .status{color:#8a3c2f}
img{display:block;width:100%;height:300px;object-fit:contain;background:#fafafa}.empty{height:300px;display:grid;place-items:center;background:#eee;color:#777}.label{font-size:12px}a{overflow-wrap:anywhere}
</style></head><body><header><h1>${report.attempted}-wine image canary</h1><p>${report.accepted}/${report.attempted} accepted &middot; ${report.labelBatches} nano label batches &middot; ledger unchanged</p></header><main class="grid">${cards}</main></body></html>`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(output);
