// Sweeps every staged image for a burned-in source watermark (Vivino, stock
// libraries) using the same vision model the pipeline verifies with.
//
// The host gate cannot catch a re-hosted copy — the Adamvs Quintvs and
// Château d'Aiguilhe images arrived from clean retailer hosts with Vivino's
// mark in the pixels — and local OCR is a documented-weak backstop. This is
// the check that runs before any import. ~$0.001/image with gpt-4.1-nano at
// detail:high (the mark is small and low-contrast; detail:low can erase it).
//
// Incremental: with --apply, every verdict is recorded on the manifest record
// (watermarkSwept either way, plus a watermark flag import refuses on a hit), so
// a re-run only spends on records that have never produced a verdict — rate-
// limited or crashed runs just get re-run until the unchecked count is zero.
//
// A record with NO verdict is left unswept on purpose, and importrules.mjs
// refuses to promote it. "Unchecked" is not "clean": an error or an unparseable
// reply means nobody has looked at that image, and a watermark that publishes
// on such a night can never be swept out again — the catalog will by then hold
// a real photograph, which import refuses to overwrite. The reason is written to
// the record as watermarkSweepError so the import log can name it.
//
// The model's verdicts are not deterministic, and a missed watermark is the
// expensive direction (it ships on the site), so a single clean verdict is not
// final: --recheck-clean re-votes records previously marked clean, and ANY
// true verdict across passes flags the image. Bias to recall — a false
// positive only costs a review look or a re-fetch. This is not hypothetical:
// the Adamvs Quintvs image (visually confirmed Vivino mark, caught by the
// validation probe) came back clean in a full sweep pass.
//
//   node tools/labelfetch/watermarksweep.mjs                   # report only
//   node tools/labelfetch/watermarksweep.mjs --apply           # record verdicts in the manifest
//   node tools/labelfetch/watermarksweep.mjs --apply --recheck-clean   # re-vote the cleans
import { readFile, writeFile, access } from 'node:fs/promises';
import { parseVerdict, flagWatermark, isWatermarked } from './watermark.mjs';
import { openaiKey } from './env.mjs';

const MANIFEST = 'data/fetched-images/manifest.json';
const MODEL = 'gpt-4.1-nano';
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const apply = process.argv.includes('--apply');
const recheckClean = process.argv.includes('--recheck-clean');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = await openaiKey();
if (!KEY) {
  console.error('needs OPENAI_API_KEY in the environment or .env');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const exists = (p) => access(p).then(() => true, () => false);

const staged = [];
let purged = 0;
let alreadySwept = 0;
for (const rec of Object.values(manifest)) {
  if (!(rec.ok && rec.file)) continue;
  if (!(await exists(rec.file))) {
    purged++; // stale manifest entry — the file was purged after fetch
    continue;
  }
  if (isWatermarked(rec) || (rec.watermarkSwept && !recheckClean)) {
    alreadySwept++;
    continue;
  }
  staged.push(rec);
}
console.log(
  `${staged.length} images to sweep (model ${MODEL}); skipping ${alreadySwept} already swept, ${purged} purged manifest entries\n`
);

async function check(rec) {
  const b64 = (await readFile(rec.file)).toString('base64');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'This is a product photo of a bottle. Does the IMAGE itself carry a website or stock-photo ' +
                  'source watermark — a semi-transparent or small brand mark laid over or beside the bottle, ' +
                  'such as "Vivino" (a diamond glyph plus the word, usually near the bottom), "wine-searcher", ' +
                  "Getty, Alamy or Shutterstock marks? Text printed on the wine's own LABEL does not count. " +
                  'Answer strictly as JSON: {"watermark":true|false,"mark":"<the mark you see, or empty>"}.',
              },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'high' } },
            ],
          },
        ],
        max_completion_tokens: 100,
      }),
    });
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      // Per-minute token limit — routine at this volume, means wait not fail.
      await sleep(attempt * 15_000);
      continue;
    }
    if (!res.ok) return { verdict: null, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { verdict: parseVerdict(j.choices?.[0]?.message?.content), error: null };
  }
}

const hits = [];
const unchecked = [];
let cleans = 0;
let done = 0;
const queue = [...staged];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let rec = queue.shift(); rec; rec = queue.shift()) {
      let verdict = null;
      let error = null;
      try {
        ({ verdict, error } = await check(rec));
      } catch (e) {
        error = String(e.message || e).split('\n')[0];
      }
      done++;
      if (!verdict) {
        // Recorded ON THE RECORD, not just in this run's console output: import
        // refuses anything the sweep has not cleared, and the operator reading
        // "skip <slug> — watermark sweep has not cleared this image (HTTP 429)"
        // in the import log needs the sweep's reason to have survived the run
        // that produced it.
        const why = error || 'unparseable verdict';
        rec.watermarkSweepErrorPending = why; // committed below under --apply
        unchecked.push(`${rec.slug} (${why})`);
      } else if (verdict.watermark) {
        hits.push({ rec, mark: verdict.mark });
        console.log(`  MARK  ${rec.slug} — ${verdict.mark || 'unnamed mark'}`);
      } else {
        cleans++;
        rec.watermarkSweptPending = true; // committed below under --apply
      }
      if (done % 50 === 0) console.log(`  …${done}/${staged.length}`);
    }
  })
);

console.log(`\n${done} swept: ${hits.length} watermarked, ${cleans} clean, ${unchecked.length} unchecked`);
for (const u of unchecked) console.log(`  unchecked ${u}`);

if (apply) {
  for (const { rec, mark } of hits) {
    flagWatermark(rec, mark);
    // watermarkSwept means "a verdict exists for this image", not "this image is
    // clean" — a hit is a verdict too. Import reads the two fields in order
    // (confirmed mark first, then swept-at-all), so setting it here keeps the
    // skip line naming the actual watermark instead of the weaker "never
    // checked", and stops a re-run paying to re-examine a settled hit.
    rec.watermarkSwept = true;
  }
  for (const rec of Object.values(manifest)) {
    if (rec.watermarkSweptPending) {
      delete rec.watermarkSweptPending;
      rec.watermarkSwept = true;
    }
    // A verdict supersedes whatever stopped an earlier pass from reaching one.
    if (rec.watermarkSwept) delete rec.watermarkSweepError;
    if (rec.watermarkSweepErrorPending) {
      rec.watermarkSweepError = rec.watermarkSweepErrorPending;
      delete rec.watermarkSweepErrorPending;
    }
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(
    `\nrecorded ${hits.length} watermark flags, ${cleans} clean verdicts and ${unchecked.length} unchecked reasons in ${MANIFEST}`
  );
} else {
  for (const rec of Object.values(manifest)) {
    delete rec.watermarkSweptPending;
    delete rec.watermarkSweepErrorPending;
  }
  if (hits.length) console.log('\nre-run with --apply to record these in the manifest');
}
if (unchecked.length) console.log('re-run to retry the unchecked ones (already-swept records are skipped)');
