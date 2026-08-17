import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const json = (value) => esc(JSON.stringify(value ?? null, null, 2));
const titleCase = (value) => String(value || '').replace(/^./, (character) => character.toUpperCase());

export function googleImagesURL(query) {
  return `https://www.google.com/search?udm=2&q=${encodeURIComponent(String(query || ''))}`;
}

function stageRows(trace) {
  const discovery = trace.discovery;
  const downloads = trace.downloads;
  const selector = trace.selector;
  const reader = selector?.reader;
  return [
    ['1. Catalog input', 'complete', `${trace.catalogInput?.name || ''} ${trace.catalogInput?.vintage || ''}`.trim()],
    ['2. Search query', 'complete', trace.query || ''],
    ['3. Image discovery', discovery ? discovery.status || 'complete' : 'not reached', discovery
      ? `${discovery.provider || 'provider'} returned ${discovery.returned || 0}; ${discovery.blocked || 0} blocked`
      : 'Provider was not called'],
    ['4. Downloads', downloads ? 'complete' : 'not reached', downloads
      ? `${downloads.filter((item) => item.outcome === 'downloaded').length}/${downloads.length} downloaded`
      : 'No permitted discovery result reached the downloader'],
    ['5. Visual grouping', selector ? 'complete' : 'not reached', selector
      ? `${selector.groups?.length || 0} repeated group(s); ${selector.reason || `pick ${selector.pick || 'none'}`}`
      : 'No downloaded candidate set reached the selector'],
    ['6. AI label reading', reader ? 'complete' : 'not called', reader
      ? `${reader.model || 'model'} read ${reader.candidateIds?.length || 0} image(s)`
      : 'The workflow stopped before an AI request was needed'],
    ['7. Final verdict', trace.final?.ok ? 'accepted' : 'failed', trace.final?.ok
      ? `selected ${trace.final.selectedImage || trace.final.selectedFile || ''}`
      : `${trace.final?.failureStage || 'unknown'}: ${trace.final?.tried?.[0]?.why || ''}`],
  ];
}

function renderDiscovery(discovery) {
  if (!discovery) return '<p class="empty">Discovery was not reached.</p>';
  const rows = (discovery.results || []).map((item) => `<tr><td>${esc(item.index)}</td><td>${esc(item.outcome)}</td><td>${esc(item.title)}</td><td>${esc(`${item.width || 0}x${item.height || 0}`)}</td><td><a href="${esc(item.image)}">image</a></td><td><a href="${esc(item.context)}">source</a></td></tr>`).join('');
  return `<p><b>${esc(discovery.provider)}</b>: searched=${esc(discovery.searched)}, status=${esc(discovery.status)}, returned=${esc(discovery.returned || 0)}, blocked=${esc(discovery.blocked || 0)}, corrected query=${esc(discovery.correctedQuery || 'none')}</p>
    ${rows ? `<div class="scroll"><table><thead><tr><th>#</th><th>Policy</th><th>Title</th><th>Declared size</th><th>Image</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">The provider returned no result records.</p>'}`;
}

function renderDownloads(downloads) {
  if (!downloads) return '<p class="empty">Downloader was not reached.</p>';
  const rows = downloads.map((item) => `<tr><td>${esc(item.index)}</td><td>${esc(item.outcome)}</td><td>${esc(item.status)}</td><td>${esc(item.bytes)}</td><td>${esc(item.error)}</td><td><a href="${esc(item.url)}">requested image</a></td><td><a href="${esc(item.context)}">source</a></td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>#</th><th>Outcome</th><th>HTTP</th><th>Bytes</th><th>Error</th><th>Image</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderImageDiagnosticHtml({ trace, images = [], googleCapture = null }) {
  const selector = trace.selector;
  const reader = selector?.reader;
  const googleURL = googleImagesURL(trace.query);
  const stages = stageRows(trace).map(([name, status, detail]) => `<tr><th>${esc(name)}</th><td><span class="status ${esc(status.replaceAll(' ', '-'))}">${esc(status)}</span></td><td>${esc(detail)}</td></tr>`).join('');
  const candidates = images.map((image) => `<button class="candidate" type="button" data-image="${esc(image.src)}"><img src="${esc(image.src)}" alt="${esc(image.id)}"><b>${esc(image.id)}</b></button>`).join('');
  const googleStatus = googleCapture
    ? `Automated capture: HTTP ${esc(googleCapture.status || 0)}; final URL ${esc(googleCapture.finalUrl || '')}`
    : 'No automated page capture was attempted. Open the exact query in a normal browser.';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Image diagnostic - ${esc(trace.catalogInput?.name)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#eee9df;color:#261d18;font:14px/1.45 system-ui,sans-serif}header,main{max-width:1500px;margin:auto}header{padding:24px 28px 10px}h1{margin:0;font:700 28px Georgia,serif}h2{font:700 20px Georgia,serif;margin:0 0 12px}section{margin:14px 28px;padding:18px;background:#fff;border:1px solid #d9cfbf;border-radius:10px}.query{font:600 14px ui-monospace,monospace;background:#f4efe6;padding:10px;border-radius:5px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e7dfd4;text-align:left;vertical-align:top}a{color:#6b1630}.status{display:inline-block;padding:3px 7px;border-radius:999px;background:#ddd}.status.complete,.status.accepted,.status.ok{background:#d6eadc;color:#155a35}.status.failed,.status.not-reached,.status.not-called{background:#f2d7d2;color:#812d22}.empty{padding:12px;background:#f5f2ed;color:#695f56}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.candidate{padding:8px;border:1px solid #d8cdbd;border-radius:7px;background:#faf9f6;cursor:zoom-in}.candidate img{display:block;width:100%;height:230px;object-fit:contain;background:#fff}.candidate b{display:block;margin-top:7px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#171513;color:#f3eade;padding:14px;border-radius:7px;max-height:520px;overflow:auto}.google-shot{display:block;max-width:100%;max-height:750px;border:1px solid #cabca9}.modal{position:fixed;inset:0;display:none;place-items:center;background:#000d;padding:20px}.modal.open{display:grid}.modal img{max-width:95vw;max-height:92vh;background:#fff}.modal button{position:fixed;right:22px;top:16px;font-size:30px;background:#fff;border:0;border-radius:50%;width:48px;height:48px} @media(max-width:600px){section{margin:10px}header{padding:18px 12px}}
  </style></head><body><header><h1>${esc(trace.catalogInput?.name || trace.query)}</h1><p>${esc(trace.catalogInput?.vintage || '')} - final result: <b>${esc(trace.final?.failureStage || (trace.final?.ok ? 'accepted' : 'unknown'))}</b></p></header>
  <main><section><h2>Step-by-step execution</h2><table><tbody>${stages}</tbody></table></section>
  <section><h2>Catalog input and exact query</h2><pre>${json(trace.catalogInput)}</pre><p class="query">${esc(trace.query)}</p></section>
  <section><h2>Google Images page</h2><p><a href="${esc(googleURL)}" target="_blank" rel="noopener">Open this exact query in Google Images</a></p><p>${googleStatus}</p>${googleCapture?.screenshot ? `<img class="google-shot" src="${esc(googleCapture.screenshot)}" alt="Rendered Google Images diagnostic page">` : ''}</section>
  <section><h2>${esc(titleCase(trace.discovery?.provider || 'Image'))} discovery</h2>${renderDiscovery(trace.discovery)}</section>
  <section><h2>Download attempts</h2>${renderDownloads(trace.downloads)}</section>
  <section><h2>Downloaded candidate images</h2>${candidates ? `<div class="grid">${candidates}</div>` : '<p class="empty">No candidate image was downloaded, so there was nothing to show or send to AI.</p>'}</section>
  <section><h2>Visual comparison and selection</h2>${selector ? `<pre>${json({ pairs: selector.pairs, groups: selector.groups, representatives: selector.representatives, evidence: selector.evidence, pick: selector.pick, reason: selector.reason })}</pre>` : '<p class="empty">Not reached.</p>'}</section>
  <section><h2>AI label-reader request and response</h2>${reader ? `<h3>Model</h3><pre>${json({ model: reader.model, reasoningEffort: reader.reasoningEffort, candidateIds: reader.candidateIds, usage: reader.usage, responseId: reader.responseId })}</pre><h3>Prompt</h3><pre>${esc(reader.prompt)}</pre><h3>Raw response</h3><pre>${esc(reader.response)}</pre><h3>Parsed response</h3><pre>${json(reader.parsed)}</pre>` : '<p class="empty">No AI query occurred. An earlier stage stopped the wine.</p>'}</section>
  <section><h2>Final recorded verdict</h2><pre>${json(trace.final)}</pre></section></main>
  <div class="modal"><button type="button" aria-label="Close">&times;</button><img alt="Enlarged candidate"></div><script>const modal=document.querySelector('.modal'),large=modal.querySelector('img');document.querySelectorAll('[data-image]').forEach(b=>b.onclick=()=>{large.src=b.dataset.image;modal.classList.add('open')});modal.querySelector('button').onclick=()=>modal.classList.remove('open');modal.onclick=e=>{if(e.target===modal)modal.classList.remove('open')}</script></body></html>`;
}

async function packageTrace(tracePath, outputDirectory) {
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const assetDirectory = join(outputDirectory, 'assets');
  await mkdir(assetDirectory, { recursive: true });
  const images = [];
  const downloads = trace.downloads || [];
  for (const item of downloads.filter((entry) => entry.file)) {
    const destination = join(assetDirectory, basename(item.file));
    try {
      await copyFile(resolve(item.file), destination);
      images.push({ id: `candidate-${item.index}`, src: relative(outputDirectory, destination).replaceAll('\\', '/') });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  let googleCapture = null;
  try {
    googleCapture = JSON.parse(await readFile(join(dirname(tracePath), 'google-images.json'), 'utf8'));
  } catch {}
  if (googleCapture) try {
    const screenshotSource = join(dirname(tracePath), 'google-images.png');
    const screenshotDestination = join(outputDirectory, 'google-images.png');
    await copyFile(screenshotSource, screenshotDestination);
    googleCapture.screenshot = 'google-images.png';
  } catch {}
  await writeFile(join(outputDirectory, 'index.html'), renderImageDiagnosticHtml({ trace, images, googleCapture }));
}

async function main() {
  const traceRoot = process.argv[2] || 'out-bottle/image-traces';
  const outputRoot = process.argv[3] || 'out-bottle/image-diagnostics';
  const entries = await readdir(traceRoot, { withFileTypes: true });
  const links = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const tracePath = join(traceRoot, entry.name, 'trace.json');
    const outputDirectory = join(outputRoot, entry.name);
    try {
      await mkdir(outputDirectory, { recursive: true });
      await packageTrace(tracePath, outputDirectory);
      links.push(`<li><a href="${esc(`${entry.name}/index.html`)}">${esc(entry.name)}</a></li>`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Image diagnostics</title><h1>Image diagnostics</h1><ul>${links.join('')}</ul>`);
  console.log(`${links.length} diagnostic dossier(s) -> ${outputRoot}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
