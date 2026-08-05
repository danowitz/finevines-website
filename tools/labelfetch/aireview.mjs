// Renders the review queue as CONTACT-SHEET PNGs a consumer AI chat (Gemini,
// Grok, ChatGPT vision) can judge without any API access: each sheet holds 8
// cards — catalog identity beside lettered candidate photos — and the model
// answers in text ("W03: B", "W07: NONE"), which decide-side tooling turns
// back into decisions.json. The human stays the final gate exactly as with
// the clicked sheet; this just drafts the first cut.
//
//   node tools/labelfetch/aireview.mjs           # flagged staged cards
//   node tools/labelfetch/aireview.mjs --missed  # choose-one cards instead
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBrowser } from '../../tests/helpers/browser.js';

const MANIFEST = 'data/fetched-images/manifest.json';
const OUT = 'out-bottle/ai-review';
const PER_SHEET = 8;
const missed = process.argv.includes('--missed');

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const wines = new Map(
  JSON.parse(await readFile('data/wines.json', 'utf8')).map((w) => [w.slug, w])
);
const needsImage = (slug) => {
  const w = wines.get(slug);
  if (!w) return false;
  return (
    !w.imagePath ||
    w.imagePath.endsWith('.svg') ||
    w.imageSource === 'label-scan' ||
    w.imageSource === 'generated-photo'
  );
};
const onDisk = (f) => !!f && existsSync(f);
const b64 = (p) => readFileSync(p).toString('base64');

const records = Object.values(manifest).filter((r) =>
  missed
    ? !r.ok && (r.alternates || []).some((a) => onDisk(a.file) && a.subjectOk !== false && a.displayOk !== false)
    : r.ok && onDisk(r.file) && (r.review || []).length && needsImage(r.slug)
);
console.log(`${records.length} cards -> sheets of ${PER_SHEET}`);
await mkdir(OUT, { recursive: true });

const cardHtml = (r, idx) => {
  const w = wines.get(r.slug) || {};
  const cands = missed
    ? (r.alternates || []).filter((a) => onDisk(a.file) && a.subjectOk !== false && a.displayOk !== false).slice(0, 3)
    : [{ file: r.file, label: r.label }, ...(r.alternates || []).filter((a) => onDisk(a.file) && a.subjectOk !== false).slice(0, 2)];
  const letters = 'ABCDE';
  return `<div class="card">
    <div class="head"><b>W${String(idx).padStart(2, '0')}</b> ${w.producer || ''} — ${w.name || r.name} ${w.vintage || ''}
      <span class="meta">${[w.region, w.varietal].filter(Boolean).join(' · ')}</span></div>
    <div class="cands">${cands
      .map(
        (c, i) => `<figure><figcaption>${letters[i]}</figcaption>
        <img src="data:image/png;base64,${b64(c.file)}">
        ${c.label ? `<p class="ocr">${String(c.label).slice(0, 70)}</p>` : ''}</figure>`
      )
      .join('')}</div>
  </div>`;
};

const style = `<style>
body{font-family:system-ui;margin:12px;background:#fff;width:1500px}
.card{border:1px solid #999;margin:6px 0;padding:8px;display:flex;gap:12px;align-items:flex-start}
.head{width:340px;font-size:14px}.head .meta{display:block;color:#666;font-size:12px}
.cands{display:flex;gap:10px}figure{margin:0;text-align:center}
figcaption{font-weight:700;font-size:16px}
img{height:170px;max-width:150px;object-fit:contain;border:1px solid #ddd}
.ocr{font-size:9px;color:#555;max-width:150px;margin:2px 0 0}
</style>`;

const browser = await openBrowser();
const page = await browser.newPage();
await page.setViewport({ width: 1540, height: 2100 });

const index = [];
for (let s = 0; s * PER_SHEET < records.length; s++) {
  const batch = records.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
  const html =
    style +
    batch.map((r, i) => cardHtml(r, s * PER_SHEET + i + 1)).join('\n');
  const tmp = resolve(OUT, `sheet-${String(s + 1).padStart(2, '0')}.html`);
  await writeFile(tmp, html);
  await page.goto('file://' + tmp.replace(/\\/g, '/'));
  await page.screenshot({ path: resolve(OUT, `sheet-${String(s + 1).padStart(2, '0')}.png`), fullPage: true });
  batch.forEach((r, i) => index.push(`W${String(s * PER_SHEET + i + 1).padStart(2, '0')}\t${r.slug}`));
  process.stdout.write('.');
}
await browser.close();
await writeFile(resolve(OUT, 'index.tsv'), index.join('\n') + '\n');
console.log(`\nwrote ${Math.ceil(records.length / PER_SHEET)} sheets + index.tsv to ${OUT}/`);
