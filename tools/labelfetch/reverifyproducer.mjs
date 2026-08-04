// Re-judges refused candidates for producer-less wines using a producer
// DERIVED from the catalog name (producerguess.mjs).
//
// 929 placeholder wines have an empty producer field (Salesforce FV_Brand__c
// mapping open), which forced the identity match to demand the whole noisy
// name — and 660 of them had every candidate refused as "the label does not
// name this wine". The candidates are still on disk as alternates, most with
// their label text already read. This re-runs the SAME identity rules with
// the derived producer, which is how imgcheck was designed to be called.
//
// Accepts are staged FLAGGED ("matched via derived producer") — they surface
// on the review sheet for a human click, never in a clean import: the guess
// loosens matching, so a person confirms the pairing.
//
//   node tools/labelfetch/reverifyproducer.mjs           # report only
//   node tools/labelfetch/reverifyproducer.mjs --apply   # stage the accepts
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { deriveProducer } from './producerguess.mjs';
import { binPath, openaiKey } from './env.mjs';

const run = promisify(execFile);
const MANIFEST = 'data/fetched-images/manifest.json';
const apply = process.argv.includes('--apply');
const useVision = process.argv.includes('--vision');
const exists = (p) => access(p).then(() => true, () => false);

// Same fallback the fetch pipeline runs: a FRESH label read beats the stored
// one, which for refused candidates is usually the bad read that refused them.
const KEY = useVision ? await openaiKey() : '';
if (useVision && !KEY) {
  console.error('--vision needs OPENAI_API_KEY');
  process.exit(2);
}
async function readLabel(file) {
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
    return v && v.single_bottle && v.label_text ? String(v.label_text) : null;
  } catch {
    return null;
  }
}

const wines = JSON.parse(await readFile('data/wines.json', 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const allNames = wines.map((w) => w.name);

// Both generated kinds are stand-ins a real find should replace.
const candidates = wines.filter(
  (w) =>
    (w.imageSource === 'generated-label' || w.imageSource === 'generated-photo') &&
    !(w.producer || '').trim() &&
    (w.slug || '').trim()
);
console.log(`${candidates.length} producer-less stand-in wines to reconsider\n`);

let reconsidered = 0;
let staged = 0;
let noGuess = 0;
for (const w of candidates) {
  const rec = manifest[w.slug];
  const alts = (rec?.alternates || []);
  if (!rec || rec.ok || !alts.length) continue;

  const producer = deriveProducer(w.name, allNames);
  if (!producer) {
    noGuess++;
    continue;
  }
  reconsidered++;

  for (const alt of alts) {
    if (!(await exists(alt.file))) continue;
    const judge = async (label) => {
      const args = ['-json', '-img', alt.file, '-name', w.name, '-producer', producer];
      if (label) args.push('-label', label);
      try {
        return JSON.parse((await run(binPath('imgcheck'), args)).stdout);
      } catch (e) {
        try {
          return JSON.parse(e.stdout);
        } catch {
          return { accept: false };
        }
      }
    };
    let v = await judge(alt.label);
    if (!v.accept && useVision) {
      const fresh = await readLabel(alt.file);
      if (fresh && fresh.trim().length >= 3) {
        const vv = await judge(fresh);
        if (vv.accept) {
          v = vv;
          alt.label = fresh;
        }
      }
    }
    if (!v.accept) continue;

    staged++;
    console.log(`OK   ${w.slug}\n     producer guess "${producer}"  <- ${alt.page ? new URL(alt.page).host : '?'}`);
    if (apply) {
      const dest = join('data/fetched-images', w.slug + '.png');
      await rename(alt.file, dest);
      rec.ok = true;
      rec.file = dest;
      rec.page = alt.page;
      rec.label = alt.label || v.label || '';
      rec.size = alt.size;
      rec.verifiedBy = 'derived-producer reverify';
      rec.alternates = alts.filter((a) => a !== alt);
      // Flagged, never clean: a derived producer loosened the match, so the
      // pairing needs a human eye. New pixels for the record — sweep again.
      rec.review = [
        ...(rec.review || []).filter((x) => !x.startsWith('matched via derived producer')),
        `matched via derived producer ("${producer}") — confirm the pairing`,
      ];
      delete rec.watermarkSwept;
      delete rec.watermarkClearedBy;
    }
    break; // first accepted candidate wins; the rest stay alternates
  }
}

if (apply) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
console.log(
  `\n${reconsidered} wines re-judged (${noGuess} had no safe producer guess): ${staged} ${apply ? 'staged for review' : 'would stage'}`
);
if (!apply && staged) console.log('re-run with --apply, then sweep + review sheet');
