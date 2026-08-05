// Converts a consumer-AI's contact-sheet verdicts (out-bottle/ai-review/
// verdicts.txt, lines "W07 A" / "W12 NONE" / "W03 UNSURE") into a
// decisions.json for decide.mjs, mapping card IDs through index.tsv and
// candidate letters through the same candidate ordering aireview.mjs used.
//
// Deliberately asymmetric, because the draft AI judged 170px thumbnails:
//   - A/B/C picks (positive identifications by a strict judge) become
//     confirm/swap decisions — they still pass decide's gates and the
//     watermark sweep before anything publishes;
//   - NONE does NOT auto-reject: our own pipeline verified these images at
//     full resolution, so a thumbnail-based "no" is a conflict for the HUMAN
//     review sheet, not a discard. NONE slugs are written to a priority list.
//   - UNSURE is no action.
//
//   node tools/labelfetch/aiverdicts.mjs   -> out-bottle/ai-review/decisions-ai.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DIR = 'out-bottle/ai-review';
const verdicts = readFileSync(`${DIR}/verdicts.txt`, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim().match(/^W(\d+)\s+([ABC]|NONE|UNSURE)$/))
  .filter(Boolean)
  .map((m) => ({ id: parseInt(m[1], 10), verdict: m[2] }));

const index = new Map(
  readFileSync(`${DIR}/index.tsv`, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [id, slug] = l.split('\t');
      return [parseInt(id.slice(1), 10), slug];
    })
);

const manifest = JSON.parse(readFileSync('data/fetched-images/manifest.json', 'utf8'));
const onDisk = (f) => !!f && existsSync(f);

// Recreate aireview.mjs's candidate ordering for the default (flagged) mode:
// A = the staged pick, B/C = the first two subject-ok alternates on disk.
function candidates(rec) {
  return [
    { file: rec.file },
    ...(rec.alternates || []).filter((a) => onDisk(a.file) && a.subjectOk !== false).slice(0, 2),
  ];
}

const decisions = {};
const nones = [];
let confirms = 0;
let swaps = 0;
let unsure = 0;
let unmapped = 0;
for (const { id, verdict } of verdicts) {
  const slug = index.get(id);
  const rec = slug && manifest[slug];
  if (!rec) {
    unmapped++;
    continue;
  }
  if (verdict === 'UNSURE') {
    unsure++;
    continue;
  }
  if (verdict === 'NONE') {
    nones.push(slug);
    continue;
  }
  if (verdict === 'A') {
    decisions[slug] = '__confirm__';
    confirms++;
    continue;
  }
  const cands = candidates(rec);
  const pick = cands[verdict.charCodeAt(0) - 64]; // B->1, C->2
  if (pick?.file && pick.file !== rec.file) {
    decisions[slug] = pick.file;
    swaps++;
  } else {
    unmapped++;
  }
}

writeFileSync(`${DIR}/decisions-ai.json`, JSON.stringify(decisions, null, 1));
writeFileSync(`${DIR}/none-priority.txt`, nones.join('\n') + '\n');
console.log(
  `${verdicts.length} verdicts: ${confirms} confirms + ${swaps} swaps -> decisions-ai.json; ` +
    `${nones.length} NONEs -> none-priority.txt (human conflict list); ${unsure} unsure; ${unmapped} unmapped`
);
