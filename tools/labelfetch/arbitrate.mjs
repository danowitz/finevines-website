// Arbitrates identity disputes at FULL resolution.
//
// Two judges already disagree by the time this runs: our own pipeline verified
// a staged image by OCR at full resolution and accepted it, while a consumer
// AI judging 170px contact-sheet thumbnails answered NONE (see aiverdicts.mjs,
// which deliberately records those as conflicts rather than discards). A
// thumbnail cannot read a Burgundy label, so its "no" is weak evidence — but
// so is a single OCR pass. This asks a third judge the one question that
// settles it, with the actual pixels the site will publish.
//
// Conservative by construction: only a confident, well-formed `false` counts
// against an image. A malformed reply, a transport error, or a missing key is
// NO OPINION — the image keeps whatever standing it had and stays on the
// human list. The arbiter can therefore only ever move an image from
// "published" to "pulled", never the reverse.
//
//   node tools/labelfetch/arbitrate.mjs --slugs list.txt          # report
//   node tools/labelfetch/arbitrate.mjs --slugs list.txt --apply  # revert the refused
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openaiKey } from './env.mjs';

// parseIdentityVerdict turns a model reply into {namesThisWine, label}, or
// null when the reply carries no usable verdict. Exported for tests; a
// non-boolean verdict must never coerce to an accept.
export function parseIdentityVerdict(content) {
  if (!content) return null;
  const stripped = String(content).replace(/^```(?:json)?|```$/gm, '').trim();
  let v;
  try {
    v = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof v?.names_this_wine !== 'boolean') return null;
  return { namesThisWine: v.names_this_wine, label: String(v.label ?? '') };
}

// revertToLabel puts a wine back on its generated SVG label — the guaranteed
// no-broken-image fallback — and clears the provenance of the photo being
// pulled. Returns the image file that should now be deleted, or null when the
// wine was already on its label (so a re-run is a harmless no-op). Mutates the
// wine in place; the caller owns saving and unlinking.
export function revertToLabel(w) {
  const old = w.imagePath;
  if (!old || old.endsWith('.svg')) return null;
  w.imagePath = `assets/img/wines/${w.slug}.svg`;
  w.imageSource = 'generated-label';
  w.imageSourceUrl = '';
  if (w.sources) w.sources.image = 'derived';
  return old;
}

// Everything below is the CLI; importing this module runs no I/O. Compared via
// pathToFileURL because a bare `file://` + Windows path never matches Node's
// three-slash file:///C:/… form — which silently made the CLI a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  const si = process.argv.indexOf('--slugs');
  // --revert takes an ALREADY-JUDGED slug list and pulls those photos without
  // paying to judge them again — the audit's verdicts are on disk, and
  // re-running a 1,500-image sweep to re-derive them would be pure waste.
  const ri = process.argv.indexOf('--revert');
  if (si === -1 && ri === -1) {
    console.error('needs --slugs <file> (judge) or --revert <file> (pull already-judged)');
    process.exit(2);
  }
  const listFile = ri !== -1 ? process.argv[ri + 1] : process.argv[si + 1];
  const slugs = (await readFile(listFile, 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  const WINES = 'data/wines.json';
  const wines = JSON.parse(await readFile(WINES, 'utf8'));
  const bySlug = new Map(wines.map((w) => [w.slug, w]));

  // pull reverts the named wines to their SVG label, deletes the pulled photo
  // files, saves the catalog, and records what it did.
  async function pull(list) {
    let n = 0;
    for (const slug of list) {
      const w = bySlug.get(slug);
      if (!w) continue;
      const old = revertToLabel(w);
      if (!old) continue;
      try { await unlink(old); } catch {}
      n++;
    }
    await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
    await writeFile('out-bottle/ai-review/arbitration-pulled.txt', list.join('\n') + '\n');
    console.log(`\nreverted ${n} wines to their SVG label; slugs in out-bottle/ai-review/arbitration-pulled.txt`);
    return n;
  }

  if (ri !== -1) {
    if (!apply) {
      console.log(`${slugs.length} slugs would be reverted — re-run with --apply`);
      process.exit(0);
    }
    await pull(slugs);
    process.exit(0);
  }

  const KEY = await openaiKey();
  if (!KEY) {
    console.error('needs OPENAI_API_KEY');
    process.exit(2);
  }

  // The catalog's own words for the wine, so the judge compares like with like.
  const identity = (w) => [w.producer, w.name, w.vintage].filter(Boolean).join(' ');

  async function judge(w) {
    const file = w.imagePath;
    if (!file || !existsSync(file)) return null;
    const b64 = (await readFile(file)).toString('base64');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: 'gpt-4.1',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              `Read this bottle's label. Does it name this wine: "${identity(w)}"?\n` +
              'Judge the PRODUCER and the CUVEE/wine name only. A different vintage of the ' +
              'same wine is still a yes. A different producer, or a different cuvee or ' +
              'appellation from the same producer, is a no. Anything that is not a single ' +
              'bottle is a no.\n' +
              'Answer strictly as JSON: {"names_this_wine":true|false,"label":"<the main text you can read>"}.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'high' } },
          ],
        }],
        max_completion_tokens: 120,
      }),
    });
    if (!res.ok) return null; // transport failure is no opinion, never a refusal
    const j = await res.json();
    return parseIdentityVerdict(j.choices?.[0]?.message?.content);
  }

  const refused = [];
  let held = 0, noOpinion = 0, missing = 0;
  const LIMIT = 6; // concurrent judgements; well inside chat rate limits
  let cursor = 0;
  async function worker() {
    while (cursor < slugs.length) {
      const slug = slugs[cursor++];
      const w = bySlug.get(slug);
      if (!w) { missing++; continue; }
      const v = await judge(w);
      if (v === null) { noOpinion++; console.log(`  ?    ${slug}`); continue; }
      if (v.namesThisWine) { held++; console.log(`  HELD ${slug}  (${v.label})`); continue; }
      refused.push({ slug, label: v.label });
      console.log(`  PULL ${slug}  label reads: ${v.label}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, slugs.length) }, worker));

  console.log(
    `\n${slugs.length} disputed: ${held} held (label names the wine), ${refused.length} refused, ` +
    `${noOpinion} no opinion, ${missing} not in catalog`
  );

  if (!apply) {
    console.log('\nnothing written — re-run with --apply to revert the refused');
    process.exit(0);
  }

  await pull(refused.map((r) => r.slug));
}
