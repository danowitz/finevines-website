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

const slugArg = process.argv.indexOf('--slug');
const onlySlug = slugArg >= 0 ? process.argv[slugArg + 1] || '' : '';
const all = Object.values(manifest).filter((record) => !onlySlug || record.slug === onlySlug);
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
  if (!w || !w.imagePath || w.imagePath.endsWith('.svg')) return true;
  // Stand-ins want upgrading too: a label scan or a generated bottle renders,
  // but a staged real photograph beats either and import will take it.
  return w.imageSource === 'label-scan' || w.imageSource === 'generated-photo';
};
let ok = all.filter((r) => r.ok && onDisk(r.file) && wineNeedsImage(r.slug));
const moot = all.filter((r) => r.ok && onDisk(r.file) && !wineNeedsImage(r.slug)).length;
const stale = all.filter((r) => r.ok && !onDisk(r.file)).length;
let flagged = ok.filter((r) => r.review?.length);
let clean = ok.filter((r) => !r.review?.length);
// A wine that found nothing but has candidates on disk is the best possible
// use of this page — BUT only candidates that could plausibly be rescued.
// The alternates pile is the verifier's reject bin, and most of it (plated
// food, retailer logo collages, lifestyle scenes) has zero rescue value and
// buries the one real bottle. Display policy, learned from the operator
// staring at an Instagram logo above the fold (2026-08-03):
//   - a candidate refused for its SUBJECT (scene, multipack, no subject,
//     too wide/narrow, cropped) is not shown — it is not a bottle shot;
//   - a candidate refused on IDENTITY ("label does not name") or quality is
//     shown — that is a real bottle whose pairing needs a human;
//   - candidates where two DIFFERENT hosts show the same artwork (imghash
//     independent evidence) are sorted first and badged.
const SUBJECT_REFUSAL = /no clean background|multiple subjects|too wide|too narrow|no subject|fills the frame/;

// Legacy manifests may contain alternates created before the current selector.
// Re-judge those pixels with the current shape gate and cache the result; the
// production selector itself never stages a pick that failed this gate.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binPath } from './env.mjs';
const runCmd = promisify(execFile);
let manifestDirty = false;
async function subjectOk(a) {
  if (a.subjectOk !== undefined) return a.subjectOk;
  try {
    JSON.parse((await runCmd(binPath('imgcheck'), ['-json', '-img', a.file, '-name', 'x', '-label', 'x'])).stdout);
    a.subjectOk = true;
  } catch (e) {
    try {
      const v = JSON.parse(e.stdout);
      a.subjectOk = !(v.stage === 'shape' || v.stage === 'decode');
    } catch {
      a.subjectOk = false;
    }
  }
  manifestDirty = true;
  return a.subjectOk;
}
for (const r of all) {
  for (const a of r.alternates || []) {
    if (onDisk(a.file) && !SUBJECT_REFUSAL.test(a.why || '')) await subjectOk(a);
  }
}

// Display-only vision screen, the third signal. The shape gate is geometry
// and a portrait grid of dark tiles passes it as "one bottle-ish subject" —
// the operator's Saratoga collage did exactly that. The vision model is asked
// one thing: is this a single-bottle product photo? Its verdict only ever
// HIDES a candidate from the sheet; it never accepts anything — the repo's
// rule that vision must not override the shape check for publication stands
// (it once accepted a plated steak that way; see verifyText in pipeline.mjs).
// Worst case here is hiding a rescuable bottle, bounded and recoverable via
// the search links. Verdicts cache on the alternate (displayOk).
import { openaiKey } from './env.mjs';
const VISION_KEY = await openaiKey();
async function displayOk(a) {
  if (a.displayOk !== undefined) return a.displayOk;
  if (!VISION_KEY) return true; // no key — screen off, sheet still works
  try {
    const b64 = (await readFile(a.file)).toString('base64');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + VISION_KEY },
      body: JSON.stringify({
        model: 'gpt-4.1-nano',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              'Is this image a product photo of a SINGLE bottle (wine, spirits or similar)? ' +
              'A logo, a collage or grid of images, food, a person, a room, or several products is not. ' +
              'Answer strictly as JSON: {"single_bottle_product_photo":true|false}.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } },
          ],
        }],
        max_completion_tokens: 30,
      }),
    });
    if (!res.ok) return true; // no verdict — do not hide on a transport error
    const j = await res.json();
    const v = JSON.parse((j.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/gm, '').trim());
    a.displayOk = v.single_bottle_product_photo === true;
    manifestDirty = true;
    return a.displayOk;
  } catch {
    return true;
  }
}
for (const r of all) {
  for (const a of r.alternates || []) {
    if (onDisk(a.file) && !SUBJECT_REFUSAL.test(a.why || '') && a.subjectOk !== false) await displayOk(a);
  }
}

const rescuable = (a) =>
  onDisk(a.file) && !SUBJECT_REFUSAL.test(a.why || '') && a.subjectOk !== false && a.displayOk !== false;

let missedWithOptions = all.filter((r) => !r.ok && (r.alternates || []).some(rescuable));
const missedBare = all.filter((r) => !r.ok && !(r.alternates || []).some(rescuable));

// Twin detection per card: pairwise imghash over the rescuable candidates.
// The map answers "does this file have a same-artwork twin on another host,
// and at what distance" — used for both ordering and the badge.
const CONSENSUS_MAX = 14;
const twinOf = new Map(); // file -> {host, distance}
{
  const hostOfUrl = (u) => {
    try {
      return new URL(u).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  for (const r of [...missedWithOptions, ...all.filter((x) => x.ok && onDisk(x.file))]) {
    const cands = [
      ...(r.ok && onDisk(r.file) ? [{ file: r.file, page: r.page }] : []),
      ...(r.alternates || []).filter(rescuable),
    ];
    if (cands.length < 2) continue;
    try {
      const { stdout } = await runCmd(binPath('imghash'), cands.map((c) => c.file));
      for (const p of JSON.parse(stdout).pairs) {
        const A = cands[p.a];
        const B = cands[p.b];
        const ha = hostOfUrl(A.page);
        const hb = hostOfUrl(B.page);
        if (p.distance > CONSENSUS_MAX || !ha || ha === hb) continue;
        if (!twinOf.has(A.file) || twinOf.get(A.file).distance > p.distance)
          twinOf.set(A.file, { host: hb, distance: p.distance });
        if (!twinOf.has(B.file) || twinOf.get(B.file).distance > p.distance)
          twinOf.set(B.file, { host: ha, distance: p.distance });
      }
    } catch {}
  }
}

// One card per WINE, not per vintage row. The catalog stores a row per
// vintage, but a decision belongs to the wine: an imported image spreads to
// sibling vintages via tools/vintageshare in the promote cycle, so showing
// the 2019 and the 2021 as separate cards asks the reviewer the same question
// twice (operator-caught, 2026-08-04). The representative is the record with
// the strongest evidence; its card lists the vintages the decision covers.
const identityOf = (slug) => {
  const w = wines.get(slug);
  return w ? ((w.producer || '') + ' ' + (w.name || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-') : slug;
};
const hasTwinEvidence = (r) =>
  Boolean(r.corroboratedBy) ||
  (r.file && twinOf.has(r.file)) ||
  (r.alternates || []).some((a) => rescuable(a) && twinOf.has(a.file));
const evidenceScore = (r) =>
  (hasTwinEvidence(r) ? 4 : 0) + (r.ok ? 2 : 0) + Math.min((r.alternates || []).filter(rescuable).length, 9) / 10;
{
  const groups = new Map();
  for (const r of [...ok, ...missedWithOptions]) {
    const k = identityOf(r.slug);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const okReps = [];
  const missedReps = [];
  for (const rs of groups.values()) {
    rs.sort((a, b) => evidenceScore(b) - evidenceScore(a));
    const rep = rs[0];
    rep.siblingVintages = rs
      .slice(1)
      .map((x) => wines.get(x.slug)?.vintage || 'NV')
      .filter(Boolean);
    (rep.ok ? okReps : missedReps).push(rep);
  }
  ok = okReps;
  missedWithOptions = missedReps;
  flagged = ok.filter((r) => r.review?.length);
  clean = ok.filter((r) => !r.review?.length);
}

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

// One-click searches for the wines where nothing on disk is right.
const searchTerms = (w, r) =>
  encodeURIComponent(([w.producer, w.name, w.vintage].filter(Boolean).join(' ') || r.name) + ' wine bottle');
const searchURL = (w, r) => `https://duckduckgo.com/?q=${searchTerms(w, r)}&iax=images&ia=images`;
// This is the same exact identity query the pipeline sends to Google's image
// endpoint; the browser link is only for human follow-up.
const googleURL = (w, r) => `https://www.google.com/search?udm=2&q=${searchTerms(w, r)}`;

const card = (r, { chosen }) => {
  const w = wines.get(r.slug) || {};
  // Rescuable bottles only, twin-confirmed pairs first, then by refusal kind;
  // capped so a card is a choice, not a scroll.
  const alts = (r.alternates || [])
    .filter(rescuable)
    .sort((a, b) => {
      const ta = twinOf.has(a.file) ? twinOf.get(a.file).distance : 999;
      const tb = twinOf.has(b.file) ? twinOf.get(b.file).distance : 999;
      return ta - tb;
    })
    .slice(0, 5);
  const title = [w.producer, w.name].filter(Boolean).join(' — ') || r.name;
  const f = r.funnel || {};
  const funnel = r.funnel
    ? `${f.searchResults || 0} results → ${f.downloaded || 0} downloaded → ` +
      `${f.bottleShapePassed || 0} bottles → ${f.strongestGroupImages || 0} matching → ` +
      `${f.identityAnchors || 0} anchors → ${f.publishableAnchors || 0} publishable`
    : '';
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
        ${twinOf.has(file) ? `<span class="opt-twin">&#10003; same bottle also on ${esc(twinOf.get(file).host)}</span>` : ''}
        ${why ? `<span class="opt-why">${esc(why)}</span>` : ''}
        ${why && /no clean background/.test(why) ? '<span class="opt-fix">pick it &mdash; background is removed automatically</span>' : ''}
        ${label ? `<span class="opt-label" title="the text OCR read off this bottle — the evidence the match was made on">text on bottle: ${esc(String(label).slice(0, 70))}</span>` : ''}
      </label>`;

  const trust = hasTwinEvidence(r) ? 'two-sources' : r.ok ? 'verified' : 'single';
  return `
  <figure class="${r.review?.length ? 'flag' : chosen ? 'ok' : 'none'}" data-slug="${esc(r.slug)}" data-trust="${trust}">
    <figcaption>
      <b>${esc(title)}</b>
      <span class="meta">${esc([w.vintage, w.region || w.country, w.varietal].filter(Boolean).join(' · '))}</span>
      <span class="sku">SKU ${esc(w.sku || '?')}</span>
      ${r.failureStage ? `<span class="failure-stage">stopped at ${esc(r.failureStage)}</span>` : ''}
      ${funnel ? `<span class="funnel">${esc(funnel)}</span>` : ''}
      ${r.siblingVintages?.length ? `<span class="vints">decision also covers: ${esc(r.siblingVintages.join(' · '))} (image is shared across vintages on import)</span>` : ''}
      <span class="search">search:
        <a href="${esc(googleURL(w, r))}" target="_blank" rel="noopener">Google Images</a> &middot;
        <a href="${esc(searchURL(w, r))}" target="_blank" rel="noopener">DuckDuckGo</a></span>
      ${r.corroboratedBy ? `<span class="corr">&#10003; corroborated: ${esc(r.corroboratedBy)}</span>` : ''}
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
  .failure-stage { color: #fff; background: #9a2b2b; border-radius: 3px; padding: 2px 5px; align-self: flex-start; font-size: 10px; font-weight: 700; }
  .funnel { color: #43352a; background: #f4ece0; border-radius: 3px; padding: 3px 5px; font-size: 10px; }
  .why { color: #8a6a2f; font-size: 11px; background: #f1e6c9; border-radius: 3px; padding: 2px 5px; align-self: flex-start; }
  .corr { color: #2e6b3f; font-size: 11px; background: #e2eadd; border-radius: 3px; padding: 2px 5px; align-self: flex-start; font-weight: 600; }
  .vints { color: #6b1630; font-size: 11px; font-style: italic; }
  #filters { position: sticky; top: 0; z-index: 5; background: #faf6ee; padding: 10px 0; display: flex; gap: 8px;
             align-items: center; border-bottom: 1px solid #ece0cd; margin-bottom: 8px; }
  #filters .chip { font: inherit; font-size: 12.5px; padding: 6px 12px; border: 1px solid #d8c6a8;
                   border-radius: 15px; background: #fff; cursor: pointer; color: #43352a; }
  #filters .chip.active { background: #6b1630; color: #f4ece0; border-color: #6b1630; }
  #filters .chip b { font-variant-numeric: tabular-nums; }
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
  .opt-twin { color: #2e6b3f; font-size: 10px; font-weight: 700; }
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

<div id="filters">
  <span class="meta">show:</span>
  <button class="chip active" data-filter="all">all</button>
  <button class="chip" data-filter="two-sources">&#10003;&#10003; two sources agree</button>
  <button class="chip" data-filter="verified">verified, flagged</button>
  <button class="chip" data-filter="single">uncorroborated</button>
</div>

${section('Two sources show the same bottle — near-certain, pick it', missedWithOptions.filter((r) => (r.alternates || []).some((a) => rescuable(a) && twinOf.has(a.file))), { chosen: false })}
${section('Flagged — check these', flagged, { chosen: true })}
${section('Single candidates, no corroboration — weakest evidence, judge by the label text', missedWithOptions.filter((r) => !(r.alternates || []).some((a) => rescuable(a) && twinOf.has(a.file))), { chosen: false })}
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
// Trust filter: chips show only cards at that evidence level, and a section
// heading disappears with its last visible card. Counts are stamped once.
{
  const figs = [...document.querySelectorAll('figure[data-trust]')];
  for (const chip of document.querySelectorAll('#filters .chip')) {
    const f = chip.dataset.filter;
    const n = f === 'all' ? figs.length : figs.filter((x) => x.dataset.trust === f).length;
    chip.innerHTML += ' <b>' + n + '</b>';
    chip.addEventListener('click', () => {
      document.querySelectorAll('#filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      for (const x of figs) x.style.display = f === 'all' || x.dataset.trust === f ? '' : 'none';
      for (const grid of document.querySelectorAll('.grid')) {
        const any = [...grid.querySelectorAll('figure')].some((x) => x.style.display !== 'none');
        grid.style.display = any ? '' : 'none';
        const h = grid.previousElementSibling;
        if (h && h.tagName === 'H2') h.style.display = any ? '' : 'none';
      }
    });
  }
}
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
// Cache the subject re-check verdicts so the next regeneration is instant.
if (manifestDirty) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));

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
