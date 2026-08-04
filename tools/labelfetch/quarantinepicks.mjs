// Re-judges every staged PROPOSED PICK — the files rec.ok points at — with
// the shape gate and the single-bottle vision screen, and demotes failures
// back to the alternates list (ok=false, nothing deleted, review can still
// rescue or reject).
//
// Exists because promotion paths multiplied: the fetch pipeline shape-checks
// its accepts, but consensus promotion trusted cross-host image agreement
// alone, and a syndicated winemaker portrait — identical on two retail
// sites — was staged as a pick. The nightly CI imports flagged records
// without a human, so a staged non-bottle is hours from publishing.
//
//   node tools/labelfetch/quarantinepicks.mjs           # report
//   node tools/labelfetch/quarantinepicks.mjs --apply   # demote failures
import { readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binPath, openaiKey } from './env.mjs';

const run = promisify(execFile);
const MANIFEST = 'data/fetched-images/manifest.json';
const apply = process.argv.includes('--apply');
const exists = (p) => access(p).then(() => true, () => false);

const KEY = await openaiKey();
const wines = JSON.parse(await readFile('data/wines.json', 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const needs = new Set(
  wines
    .filter((w) => w.imageSource === 'generated-label' || w.imageSource === 'generated-photo')
    .map((w) => w.slug)
);

async function shapeOk(file) {
  try {
    JSON.parse((await run(binPath('imgcheck'), ['-json', '-img', file, '-name', 'x', '-label', 'x'])).stdout);
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

async function singleBottle(file) {
  if (!KEY) return true;
  try {
    const b64 = (await readFile(file)).toString('base64');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: 'gpt-4.1-nano',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              'Is this image a product photo of a SINGLE bottle (wine, spirits or similar)? ' +
              'A logo, a collage, food, a person, a room, or several products is not. ' +
              'Answer strictly as JSON: {"single_bottle_product_photo":true|false}.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } },
          ],
        }],
        max_completion_tokens: 30,
      }),
    });
    if (!res.ok) return true; // no verdict is not a demotion
    const j = await res.json();
    return JSON.parse((j.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/gm, '').trim())
      .single_bottle_product_photo === true;
  } catch {
    return true;
  }
}

let checked = 0;
let demoted = 0;
for (const [slug, rec] of Object.entries(manifest)) {
  if (!rec.ok || !rec.file || !needs.has(slug)) continue;
  if (!(await exists(rec.file))) continue;
  checked++;
  const shape = await shapeOk(rec.file);
  const bottle = shape ? await singleBottle(rec.file) : false;
  if (shape && bottle) continue;

  demoted++;
  console.log(`DEMOTE ${slug} — ${shape ? 'vision: not a single-bottle product photo' : 'shape gate refuses it'}`);
  if (apply) {
    rec.alternates = [
      ...(rec.alternates || []),
      { file: rec.file, page: rec.page, label: rec.label, size: rec.size, why: 'demoted: not a single bottle', subjectOk: false },
    ];
    rec.ok = false;
    delete rec.file;
    rec.review = ['demoted by the pick quarantine — not a single-bottle product photo'];
  }
}

if (apply) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
console.log(`\n${checked} staged picks checked: ${demoted} ${apply ? 'demoted' : 'would demote'}`);
