// Generates verified gpt-image-1 bottle photos for the catalog tail the web
// cannot photograph. Chunked by design — the operator approves spend per run.
//
//   node tools/imagegen/main.mjs --n 50            # generate for 50 placeholder wines
//   node tools/imagegen/main.mjs --n 5 --dry       # selection + prompts only, no spend
//
// Why HIGH quality: the 2026-07-29 dry run at medium garbled label text on
// 12/12 bottles; the 2026-08-03 re-test at high rendered 3/3 essentially
// correct. Text fidelity is what the quality tier buys ($0.25/image).
//
// Every image is VERIFIED before it ships, then normalised like any fetched
// photo:
//   1. gpt-4.1-nano reads the generated label back (same prompt as the fetch
//      pipeline's vision fallback);
//   2. imgcheck applies the same identity rules used on fetched candidates;
//   3. any 4-digit year on the label that contradicts the wine's vintage
//      fails it (the dry run's worst failure: 2016 printed on a 2018 wine);
//   4. one labeled retry, then a blank-label fallback — a photoreal bottle
//      with an unmarked label states nothing false and still beats the SVG.
//
// Wines get imageSource 'generated-photo', which the whole system treats as
// REPLACEABLE: enrich.hasRealImage (Go), importrules.mjs, and the fetch
// pipeline's --missing filter all let a verified real photograph overwrite it
// later. Generated is a stand-in, never an endpoint.
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { openaiKey, binPath } from '../labelfetch/env.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WINES = 'data/wines.json';
const IMG_DIR = 'assets/img/wines';
const MANIFEST = 'data/fetched-images/manifest.json';
const TMP = 'out-bottle/imagegen';
const MODEL = 'gpt-image-1';
const QUALITY = 'high';
const VISION_MODEL = 'gpt-4.1-nano';
const COST_PER_IMAGE = 0.2496; // 1024x1536 high, $40/1M output tokens

const argN = process.argv.indexOf('--n');
const N = argN >= 0 ? parseInt(process.argv[argN + 1], 10) : 50;
const dry = process.argv.includes('--dry');

const KEY = await openaiKey();
if (!KEY) {
  console.error('needs OPENAI_API_KEY in the environment or .env');
  process.exit(2);
}

const wines = JSON.parse(await readFile(WINES, 'utf8'));
let manifest = {};
try {
  manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
} catch {}

// Selection: placeholder wines whose real image is NOT already sitting in the
// review queue — generation money never races a photograph a click would
// promote. Deterministic order so successive chunks tile the catalog.
const stagedOk = new Set(Object.values(manifest).filter((r) => r.ok && r.file).map((r) => r.slug));
const pool = wines
  .filter(
    (w) =>
      (w.slug || '').trim() &&
      (w.name || '').trim() &&
      w.imageSource === 'generated-label' &&
      !stagedOk.has(w.slug)
  )
  .sort((a, b) => a.slug.localeCompare(b.slug));
const batch = pool.slice(0, N);
console.log(`imagegen: ${pool.length} eligible placeholder wines; this chunk: ${batch.length} at ${QUALITY} (~$${(batch.length * COST_PER_IMAGE).toFixed(2)} + retries)\n`);
if (!batch.length) process.exit(0);
await mkdir(TMP, { recursive: true });

// catalogName mirrors the fetch pipeline: the wine as the catalog holds it,
// stripped of trade shorthand, producer leading when it doesn't already.
function catalogName(w) {
  const name = (w.name || '').replace(/\*+/g, '').replace(/\b\d+\/\d+\b/g, '').trim();
  return w.producer && !name.toLowerCase().startsWith(w.producer.toLowerCase())
    ? `${w.producer} ${name}`
    : name;
}

function labeledPrompt(w) {
  const idn = catalogName(w);
  const descriptors = [w.color, w.varietal].filter(Boolean).join(' ');
  const from = w.region || w.country || '';
  return (
    `Photorealistic studio product photograph of a single bottle of ${idn}` +
    (w.vintage ? ` ${w.vintage}` : '') +
    (descriptors ? ` (${descriptors})` : '') +
    (from ? ` from ${from}` : '') +
    `. The label must be legible and read EXACTLY: "${idn}${w.vintage ? ' ' + w.vintage : ''}" — ` +
    `spell every word precisely as given, no other prominent text. Correct bottle shape, glass color ` +
    `and closure for the style. Seamless pure white studio background — the catalog composites every ` +
    `bottle on white, and a grey backdrop ships as a visible grey box (found live 2026-08-03). ` +
    `Soft key light, no props, bottle fills the frame.`
  );
}

function blankPrompt(w) {
  // The product CATEGORY must be in the prompt even though the label is
  // blank: "a single amber bottle" for a bourbon produced a beer bottle with
  // a crown cap (shipped live 2026-08-03 — the shape check can't tell beer
  // from bourbon). The wine's own name carries the category; the label
  // instruction keeps its words off the glass.
  const descriptors = [w.color, w.varietal].filter(Boolean).join(' ');
  const from = w.region || w.country || '';
  return (
    `Photorealistic studio product photograph of a single bottle of the kind used for ` +
    `"${catalogName(w)}"` +
    (descriptors ? ` (${descriptors})` : '') +
    (from ? ` from ${from}` : '') +
    `, but wearing a completely blank unmarked cream paper label with no text, no logos, no ` +
    `graphics of any kind. Correct bottle shape, glass color and closure for this kind of ` +
    `product — a wine bottle for wine, a spirits bottle for spirits, never a beer bottle. ` +
    `Seamless pure white studio background, soft key light, no props, bottle fills the frame.`
  );
}

async function generate(prompt) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, prompt, size: '1024x1536', quality: QUALITY }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(attempt * 15_000);
      continue;
    }
    const j = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j.error).slice(0, 100)}`);
    return Buffer.from(j.data[0].b64_json, 'base64');
  }
}

async function readLabel(file) {
  const b64 = (await readFile(file)).toString('base64');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text:
            'Transcribe the text printed on the label of this wine bottle. ' +
            'Answer strictly as JSON: {"single_bottle":true|false,"label_text":"<every word you can read>"}. ' +
            'Transcribe only what is actually legible. If there is no bottle, set single_bottle false.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } },
        ],
      }],
      max_completion_tokens: 800,
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  try {
    const v = JSON.parse((j.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/gm, '').trim());
    return v && v.single_bottle ? String(v.label_text || '') : null;
  } catch {
    return null;
  }
}

// verifyLabeled: the same standard a fetched photo meets, plus the vintage
// contradiction check the dry run showed generation needs.
async function verifyLabeled(file, w) {
  const text = await readLabel(file);
  if (!text || text.trim().length < 3) return { ok: false, why: 'label unreadable' };
  const years = text.match(/\b(19|20)\d{2}\b/g) || [];
  if (w.vintage && years.some((y) => y !== w.vintage)) {
    return { ok: false, why: `label shows ${years.join('/')}, wine is ${w.vintage}` };
  }
  if (!w.vintage && years.length) return { ok: false, why: `label invents a vintage (${years[0]})` };
  try {
    const { stdout } = await run(binPath('imgcheck'), [
      '-json', '-img', file, '-name', w.name, '-producer', w.producer || '', '-label', text,
    ]);
    return JSON.parse(stdout).accept ? { ok: true } : { ok: false, why: 'identity rules refuse the read text' };
  } catch (e) {
    try {
      const v = JSON.parse(e.stdout);
      return v.accept ? { ok: true } : { ok: false, why: v.reason || 'identity rules refuse the read text' };
    } catch {
      return { ok: false, why: 'verifier failed' };
    }
  }
}

// verifyBlank: shape only — there is no text to judge, that being the point.
async function verifyBlank(file) {
  try {
    const { stdout } = await run(binPath('imgcheck'), ['-json', '-img', file, '-name', 'x', '-label', 'x']);
    JSON.parse(stdout);
    return true;
  } catch (e) {
    try {
      const v = JSON.parse(e.stdout);
      return !(v.stage === 'shape' || v.stage === 'decode');
    } catch {
      return false;
    }
  }
}

const tally = { labeled: 0, retried: 0, blank: 0, failed: 0, images: 0 };
let sinceCheckpoint = 0;
for (const w of batch) {
  if (dry) {
    console.log(`DRY  ${w.slug}\n     ${labeledPrompt(w).slice(0, 140)}…`);
    continue;
  }
  const tmp = join(TMP, w.slug + '.png');
  let source = null; // 'labeled' | 'labeled-retry' | 'blank'
  try {
    for (const attempt of ['labeled', 'labeled-retry', 'blank']) {
      const prompt = attempt === 'blank' ? blankPrompt(w) : labeledPrompt(w);
      await writeFile(tmp, await generate(prompt));
      tally.images++;
      if (attempt === 'blank' ? await verifyBlank(tmp) : (await verifyLabeled(tmp, w)).ok) {
        source = attempt;
        break;
      }
      const v = attempt !== 'blank' ? await verifyLabeled(tmp, w) : null;
      console.log(`  …  ${w.slug} ${attempt} failed${v && !v.ok ? `: ${v.why}` : ''}`);
    }
  } catch (e) {
    console.log(`ERR  ${w.slug} — ${String(e.message).split('\n')[0]}`);
    tally.failed++;
    continue;
  }
  if (!source) {
    console.log(`FAIL ${w.slug} — nothing verifiable generated; SVG label stays`);
    tally.failed++;
    continue;
  }

  const dest = join(IMG_DIR, w.slug + '.jpg');
  try {
    await run(binPath('imgnorm'), ['-in', tmp, '-out', dest]);
  } catch (e) {
    console.log(`FAIL ${w.slug} — normalise: ${String(e.message).split('\n')[0]}`);
    tally.failed++;
    continue;
  }
  try { await unlink(join(IMG_DIR, w.slug + '.svg')); } catch {}
  w.imagePath = dest.replace(/\\/g, '/');
  w.imageSource = 'generated-photo';
  w.imageSourceUrl = '';
  if (w.sources) w.sources.image = 'derived';

  if (source === 'labeled') tally.labeled++;
  else if (source === 'labeled-retry') tally.retried++;
  else tally.blank++;
  console.log(`OK   ${w.slug}  (${source})`);

  // Checkpoint every 10 so a crash mid-chunk loses minutes, not the run.
  if (++sinceCheckpoint >= 10) {
    await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
    sinceCheckpoint = 0;
  }
}

if (!dry && (tally.labeled + tally.retried + tally.blank)) {
  await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
}
console.log(
  `\n${tally.labeled} labeled first-try, ${tally.retried} on retry, ${tally.blank} blank fallback, ${tally.failed} failed` +
  `\n${tally.images} images generated ≈ $${(tally.images * COST_PER_IMAGE).toFixed(2)}`
);
