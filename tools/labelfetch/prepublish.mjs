// Independent, full-resolution identity gate for staged catalog images.
//
// The fetch pipeline already reads a candidate label and applies imgcheck's
// sibling-aware matcher. This is deliberately a second judge over the final
// pixels. Only an affirmative, well-formed verdict permits import; a negative,
// malformed reply, missing key, or transport error cannot publish an image.
//
//   node tools/labelfetch/prepublish.mjs --clean-only          # report
//   node tools/labelfetch/prepublish.mjs --clean-only --apply  # record verdicts
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openaiKey } from './env.mjs';

const MODEL = 'gpt-4.1';

export function parseIdentityVerdict(content) {
  if (!content) return null;
  let value;
  try {
    value = JSON.parse(String(content).replace(/^```(?:json)?|```$/gm, '').trim());
  } catch {
    return null;
  }
  if (typeof value?.names_this_wine !== 'boolean') return null;
  return { namesThisWine: value.names_this_wine, label: String(value.label ?? '') };
}

function addReview(rec, text) {
  rec.review = Array.isArray(rec.review) ? rec.review : [];
  if (!rec.review.includes(text)) rec.review.push(text);
}

export function applyIdentityVerdict(rec, verdict, error = '') {
  if (verdict?.namesThisWine === true) {
    rec.prepublishIdentityVerified = true;
    rec.prepublishLabel = verdict.label;
    delete rec.prepublishIdentityUnavailable;
    delete rec.prepublishIdentityError;
    return 'accepted';
  }
  rec.prepublishIdentityVerified = false;
  rec.prepublishLabel = verdict?.label || '';
  if (verdict?.namesThisWine === false) {
    delete rec.prepublishIdentityUnavailable;
    delete rec.prepublishIdentityError;
    addReview(rec, `prepublish identity refused (label: ${verdict.label || 'unreadable'})`);
    return 'refused';
  }
  rec.prepublishIdentityUnavailable = true;
  rec.prepublishIdentityError = error || 'malformed or empty model reply';
  addReview(rec, `prepublish identity unavailable (${rec.prepublishIdentityError})`);
  return 'unavailable';
}

export function isPrepublishCandidate(rec, wine, { exists = existsSync, cleanOnly = false } = {}) {
  if (!rec?.ok || !rec.file || !exists(rec.file) || !wine) return false;
  if (rec.watermark || rec.watermarkSwept !== true) return false;
  const isStandIn =
    !wine.imagePath ||
    wine.imagePath.endsWith('.svg') ||
    wine.imageSource === 'generated-photo' ||
    wine.imageSource === 'label-scan';
  if (!isStandIn) return false;
  if (cleanOnly && (rec.review || []).length) return false;
  return true;
}

function mimeFor(file) {
  switch (extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'image/png';
  }
}

function identity(wine) {
  return [wine.producer, wine.name, wine.vintage].filter(Boolean).join(' ');
}

async function judge(key, rec, wine) {
  const b64 = (await readFile(rec.file)).toString('base64');
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              `Read this product image at full resolution. Does it show exactly this wine: "${identity(wine)}"?\n` +
              'Require the producer and the distinguishing cuvee, vineyard, appellation, tier, or product name. ' +
              'A different wine from the same producer is false. If a vintage is visible and contradicts the catalog vintage, false. ' +
              'A single bottle or an authentic flat label scan may be true; a lineup, gift set, blank label, invented label, or unrelated image is false.\n' +
              'Answer strictly as JSON: {"names_this_wine":true|false,"label":"<main text actually visible>"}.' },
            { type: 'image_url', image_url: { url: `data:${mimeFor(rec.file)};base64,${b64}`, detail: 'high' } },
          ],
        }],
        max_completion_tokens: 160,
      }),
    });
  } catch (err) {
    return { verdict: null, error: String(err.message || err) };
  }
  if (!res.ok) return { verdict: null, error: `HTTP ${res.status}` };
  const json = await res.json();
  return { verdict: parseIdentityVerdict(json.choices?.[0]?.message?.content) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  const cleanOnly = process.argv.includes('--clean-only');
  const redo = process.argv.includes('--redo');
  const manifestPath = 'data/fetched-images/manifest.json';
  const wines = JSON.parse(await readFile('data/wines.json', 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bySlug = new Map(wines.map((w) => [w.slug, w]));
  const candidates = Object.values(manifest).filter((rec) =>
    isPrepublishCandidate(rec, bySlug.get(rec.slug), { cleanOnly }) &&
    (redo || rec.prepublishIdentityVerified !== true)
  );
  console.log(`${candidates.length} staged image(s) require independent full-resolution identity verification`);
  if (!candidates.length) process.exit(0);

  const key = await openaiKey();
  if (!key) {
    console.error('needs OPENAI_API_KEY; no candidate was cleared');
    process.exit(2);
  }

  const report = [];
  const tally = { accepted: 0, refused: 0, unavailable: 0 };
  let cursor = 0;
  const concurrency = 6;
  async function worker() {
    while (cursor < candidates.length) {
      const rec = candidates[cursor++];
      const wine = bySlug.get(rec.slug);
      const { verdict, error } = await judge(key, rec, wine);
      const outcome = applyIdentityVerdict(rec, verdict, error);
      tally[outcome]++;
      report.push({ slug: rec.slug, identity: identity(wine), outcome, label: verdict?.label || '', error: error || '' });
      console.log(`${outcome === 'accepted' ? 'YES ' : outcome === 'refused' ? 'NO  ' : '?   '} ${rec.slug}${verdict?.label ? ` (${verdict.label})` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  report.sort((a, b) => a.slug.localeCompare(b.slug));
  await mkdir(dirname('out-bottle/prepublish-verdicts.json'), { recursive: true });
  await writeFile('out-bottle/prepublish-verdicts.json', JSON.stringify(report, null, 2) + '\n');
  if (apply) await writeFile(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`\n${tally.accepted} accepted, ${tally.refused} refused, ${tally.unavailable} unavailable${apply ? ' (manifest updated)' : ' (dry run)'}`);
}
