// Applies an external prose audit (ChatGPT reviewing out-bottle/
// catalog-review.csv) back onto the catalog. First run 2026-08-05: 982 flags
// over 2,642 wines, dominated by two systemic classes this fixes
// mechanically:
//
//   - Identity confusion (420): prose names a different vintage than the
//     row. Root cause was proseshare copying donor prose verbatim, plus the
//     enricher occasionally matching a neighboring vintage. Fix: replace the
//     wrong year with the wine's own vintage in its prose.
//   - Factual (59): drink windows that had already ended (or started before
//     the vintage existed). Fix: blank them — honest beats stale.
//
// Rows the machine can't fix (research-process leakage, garbled grammar,
// filler, hedging, wrong-color prose) get their SourceHash cleared so the
// real enricher redoes them. Duplicated-prose rows are counted, not touched:
// they are mostly short stock phrases and get a separate decision.
//
//   node tools/auditapply/main.mjs out-bottle/catalog-fact-check.csv          # report
//   node tools/auditapply/main.mjs out-bottle/catalog-fact-check.csv --apply  # write
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) {
  console.error('usage: auditapply <audit.csv> [--apply]');
  process.exit(2);
}

// Tolerant CSV: slug,category,"problem possibly, with commas"
function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿|^ï»¿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('slug,')) continue;
    const m = line.match(/^([^,]+),([^,]+),(.*)$/);
    if (!m) continue;
    let problem = m[3].trim();
    if (problem.startsWith('"') && problem.endsWith('"')) {
      problem = problem.slice(1, -1).replace(/""/g, '"');
    }
    rows.push({ slug: m[1].trim(), category: m[2].trim(), problem });
  }
  return rows;
}

const flags = parseCsv(readFileSync(file, 'utf8'));
const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'));
const bySlug = new Map(wines.map((w) => [w.slug, w]));

const scored = [
  'description', 'sommelierNotes', 'aroma', 'palate', 'finish', 'foodPairings',
  'appellation', 'country', 'color', 'abv', 'bottleSize', 'drinkWindow', 'image',
];
const rescore = (w) => {
  if (!w.sources) return;
  const real = scored.filter((f) => w.sources[f] === 'salesforce' || w.sources[f] === 'found').length;
  w.metadataScore = Math.round((100 * real) / scored.length);
};

const n = { vintageFixed: 0, windowsBlanked: 0, abvBlanked: 0, reenrich: 0, dupes: 0, unknownSlug: 0, unhandled: 0 };
const reenrichSlugs = new Set();

for (const f of flags) {
  const w = bySlug.get(f.slug);
  if (!w) {
    n.unknownSlug++;
    continue;
  }
  if (f.category === 'Duplicated prose across different wines') {
    n.dupes++;
    continue;
  }
  const vint = f.problem.match(/vintage (\d{4}), but the identity vintage is (\d{4})/);
  if (f.category === 'Identity confusion' && vint) {
    const [, wrong, right] = vint;
    if (apply) {
      const re = new RegExp('\\b' + wrong + '\\b', 'g');
      w.description = (w.description || '').replace(re, right);
      w.sommelierNotes = (w.sommelierNotes || '').replace(re, right);
    }
    n.vintageFixed++;
    continue;
  }
  if (f.category === 'Factual errors' && /Drink window .*(has already ended|starts before)/.test(f.problem)) {
    if (apply) {
      w.drinkWindow = '';
      if (w.sources) w.sources.drinkWindow = 'missing';
      rescore(w);
    }
    n.windowsBlanked++;
    continue;
  }
  if (f.category === 'Factual errors' && /ABV is unverified/.test(f.problem)) {
    if (apply) {
      w.abv = '';
      if (w.sources) w.sources.abv = 'missing';
      rescore(w);
    }
    n.abvBlanked++;
    continue;
  }
  // Everything else — leaked process language, garbled grammar, filler,
  // hedging, wrong-color prose, producer-misspelling identities — needs a
  // human-quality rewrite, which is the enricher's job.
  reenrichSlugs.add(f.slug);
  n.reenrich++;
}

// Catalog-wide mechanical language fixes: independent of individual flags,
// since a typo class the audit caught once tends to exist elsewhere too.
let spelling = 0;
for (const w of wines) {
  const before = (w.description || '') + (w.region || '');
  if (w.description) w.description = apply ? w.description.replace(/\benvelopes the senses\b/g, 'envelops the senses') : w.description;
  if (w.region) {
    if (apply) w.region = w.region.replace(/\bBurgudy\b|\bBurgandy\b/g, 'Burgundy').replace(/\bMendoze\b/g, 'Mendoza');
  }
  const after = (w.description || '') + (w.region || '');
  if (before !== after) spelling++;
}

if (apply) {
  for (const slug of reenrichSlugs) {
    const w = bySlug.get(slug);
    if (w) w.sourceHash = '';
  }
  writeFileSync('data/wines.json', JSON.stringify(wines, null, 1) + '\n');
}

console.log(`${flags.length} flags processed${apply ? ' and APPLIED' : ' (dry run)'}:`);
console.log(`  vintage references corrected: ${n.vintageFixed}`);
console.log(`  stale drink windows blanked:  ${n.windowsBlanked}`);
console.log(`  guessed ABVs blanked:         ${n.abvBlanked}`);
console.log(`  spelling/region fixes:        ${spelling}`);
console.log(`  marked for re-enrichment:     ${reenrichSlugs.size}`);
console.log(`  duplicate-prose rows parked:  ${n.dupes}`);
if (n.unknownSlug) console.log(`  unknown slugs skipped:        ${n.unknownSlug}`);
