// Benchmarks vision models as the catalog's image verifier: which is cheapest
// that still gets the answer right.
//
// The question is NOT "can it read a label" — every model tried can. It is
// whether it will say NO. A verifier that accepts everything scores 100% on
// correct pairs and is worthless, because the failure being defended against
// is silent substitution: a search for FX Pichler's Kellerberg returns Max
// Ferd. Richter Mosels, and something has to refuse them.
//
// So the set is BALANCED. Every verified image appears twice: once with its
// own wine's name, and once with a different wine's name. A model that always
// answers yes scores 50%, which is the floor a real result has to beat.
//
//   node tools/visioncheck/bench.mjs                  # all models
//   node tools/visioncheck/bench.mjs --model gpt-5.4-nano
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const key = (await readFile('.env', 'utf8')).match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) {
  console.error('no OPENAI_API_KEY in .env');
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};

// gpt-5-mini is omitted: it spent 400 completion tokens reasoning and returned
// an empty answer on the probe, so it needs a much larger budget and is not a
// candidate for the cheap end anyway.
const MODELS = opt('model', '')
  ? [opt('model', '')]
  : ['gpt-5.4-nano', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4.1'];

const DIR = 'data/fetched-images';
const manifest = JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8'));
const verified = Object.values(manifest).filter((r) => r.ok && r.file);
if (verified.length < 4) {
  console.error('need a staged, verified set first: node tools/labelfetch/pipeline.mjs --n 20 --missing');
  process.exit(2);
}

// Build the balanced set: each image once as itself, once mislabelled with
// another wine from the same batch. Same-batch mislabels are deliberately
// HARD — they are mostly Burgundy, so a model cannot pass by noticing the
// wrong country or colour.
const cases = [];
for (let i = 0; i < verified.length; i++) {
  const r = verified[i];
  const other = verified[(i + 1) % verified.length];
  cases.push({ file: r.file, name: r.name, expect: true });
  if (other.name !== r.name) cases.push({ file: r.file, name: other.name, expect: false });
}

const PROMPT = (name) =>
  `A wholesale wine catalog needs to show a photograph of this wine:\n\n  ${name}\n\n` +
  `Look at the image. Answer strictly as JSON, no other text:\n` +
  `{"single_bottle": true|false, "label_text": "<the main text you can read on the label>", "is_this_wine": true|false}\n\n` +
  `"is_this_wine" must be true ONLY if the label is that producer's wine. A different producer's ` +
  `bottle from the same region or vineyard is NOT a match. If the label is unreadable, answer false.`;

const files = new Map();
async function imageOf(p) {
  if (!files.has(p)) files.set(p, 'data:image/png;base64,' + (await readFile(p)).toString('base64'));
  return files.get(p);
}

async function ask(model, c) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT(c.name) },
            // detail:low costs a fraction of high and is ample: the question is
            // whose name is on the label, not how the foil is embossed.
            { type: 'image_url', image_url: { url: await imageOf(c.file), detail: 'low' } },
          ],
        },
      ],
      max_completion_tokens: 1200,
    }),
  });
  const ms = Date.now() - t0;
  const j = await res.json();
  if (!res.ok) return { err: j.error?.message || 'http ' + res.status, ms };
  const u = j.usage || {};
  const raw = j.choices?.[0]?.message?.content || '';
  let parsed = null;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim());
  } catch {}
  return { parsed, raw, ms, in: u.prompt_tokens || 0, out: u.completion_tokens || 0 };
}

console.log(`${cases.length} cases (${cases.filter((c) => c.expect).length} correct pairs, ${cases.filter((c) => !c.expect).length} mislabelled)\n`);
console.log('model           acc    TP/FN   TN/FP   in_tok   out_tok  avg_ms  unparsed');
console.log('--------------------------------------------------------------------------');

const results = {};
for (const model of MODELS) {
  let tp = 0, fn = 0, tn = 0, fp = 0, unparsed = 0, tin = 0, tout = 0, tms = 0, errs = 0;
  for (const c of cases) {
    const r = await ask(model, c);
    if (r.err) { errs++; continue; }
    tin += r.in; tout += r.out; tms += r.ms;
    if (!r.parsed || typeof r.parsed.is_this_wine !== 'boolean') { unparsed++; continue; }
    const said = r.parsed.is_this_wine;
    if (c.expect && said) tp++;
    else if (c.expect && !said) fn++;
    else if (!c.expect && !said) tn++;
    else fp++;
  }
  const judged = tp + fn + tn + fp;
  const acc = judged ? (100 * (tp + tn)) / judged : 0;
  results[model] = { acc, tp, fn, tn, fp, unparsed, errs, in: tin, out: tout, n: cases.length };
  console.log(
    model.padEnd(15) +
      `${acc.toFixed(0).padStart(3)}%   ${String(tp).padStart(2)}/${String(fn).padEnd(2)}   ${String(tn).padStart(2)}/${String(fp).padEnd(2)}   ` +
      `${String(tin).padEnd(8)} ${String(tout).padEnd(8)} ${String(Math.round(tms / cases.length)).padEnd(7)} ${unparsed}${errs ? ' err:' + errs : ''}`
  );
}

await writeFile('out-bottle/vision-bench.json', JSON.stringify({ cases: cases.length, results }, null, 1));
console.log('\nTP=correct pair accepted  FN=correct pair wrongly rejected');
console.log('TN=mislabelled rejected   FP=mislabelled WRONGLY ACCEPTED (the dangerous one)');
console.log('\ntokens are TOTALS across all cases — divide by cases for per-image cost');
console.log('wrote out-bottle/vision-bench.json');
