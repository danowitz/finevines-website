// Applies the choices made on the review sheet.
//
// The sheet is opened straight off disk and writes nothing itself; it collects
// decisions in the browser and downloads decisions.json. This applies them.
// Two kinds:
//
//   "<path>"    use this alternate instead of what the pipeline picked
//   "__none__"  none of these is right — drop it and mark it for another look
//
// Deliberately separate from the review sheet and from the fetcher, and it
// never guesses: a wine the reviewer did not touch is left exactly as it was.
// Marking something wrong is information worth keeping, so a rejection is
// recorded on the wine rather than silently erased — a later run can see that
// a human looked at this one and refused what was found.
//
//   node tools/labelfetch/decide.mjs                    # report
//   node tools/labelfetch/decide.mjs --apply            # apply
//   node tools/labelfetch/decide.mjs --file other.json  # a different download
import { readFile, writeFile, rename, unlink, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { binPath } from './env.mjs';
import { markHumanRejected, markHumanSelected } from './human-decision.mjs';

const VERIFIER = binPath('imgcheck');

const MANIFEST = 'data/fetched-images/manifest.json';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fileArg = args.indexOf('--file');
// Browsers drop it in Downloads; accept either without being told.
const CANDIDATES = fileArg >= 0
  ? [args[fileArg + 1]]
  : ['decisions.json', join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'decisions.json')];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

let decisionsPath = '';
for (const c of CANDIDATES) if (await exists(c)) { decisionsPath = c; break; }
if (!decisionsPath) {
  console.error('no decisions.json found. Looked in:\n  ' + CANDIDATES.join('\n  '));
  console.error('\nOpen out-bottle/review.html, make your choices, then press "Download decisions".');
  process.exit(2);
}

// A pasted URL is fetched with a real browser, like the pipeline does: many
// image hosts return 403 to a plain request and 200 to Chrome.
let browser = null, page = null;
async function fetchImage(url) {
  if (!page) {
    const { openBrowser } = await import('../../tests/helpers/browser.js');
    browser = await openBrowser();
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
  }
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || !res.ok()) return null;
    const buf = await res.buffer();
    if (!buf || buf.length < 2000) return null;
    const isJPEG = buf[0] === 0xff && buf[1] === 0xd8;
    const isPNG = buf[0] === 0x89 && buf[1] === 0x50;
    if (isJPEG || isPNG) return buf;
    // Anything else — webp, avif — is transcoded in the browser, which already
    // has decoders Go's standard library does not.
    const png = await page.evaluate((d) => new Promise((ok) => {
      const i = new Image();
      i.onload = () => { const c = document.createElement('canvas');
        c.width = i.naturalWidth; c.height = i.naturalHeight;
        c.getContext('2d').drawImage(i, 0, 0); ok(c.toDataURL('image/png')); };
      i.onerror = () => ok(null);
      i.src = d;
      setTimeout(() => ok(null), 12000);
    }), 'data:application/octet-stream;base64,' + buf.toString('base64'));
    return png ? Buffer.from(png.split(',')[1], 'base64') : null;
  } catch { return null; }
}

// cutBackground strips a scene background locally (tools/labelfetch/bgcut.py,
// rembg) and flattens onto white, in place. The reviewer picked a bottle
// photographed in a setting; the pick is right, the setting is what the
// clean-background gate refuses — so the setting goes. The shape check runs
// again afterwards and stays the judge: a cut that still shows a second
// subject (rembg keeps ALL foreground objects) is still refused.
async function cutBackground(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('python', ['tools/labelfetch/bgcut.py', file, file + '.cut.png']);
    await rename(file + '.cut.png', file);
    return true;
  } catch (e) {
    console.log(`            background removal failed: ${String(e.message).split('\n')[0]}`);
    return false;
  }
}

// Shape only. The reviewer has already decided this is the right WINE; what
// still has to hold is that it is a usable product photograph.
async function checkShape(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run(VERIFIER, ['-json', '-img', file, '-name', 'x', '-label', 'x']);
    const v = JSON.parse(stdout);
    return { ok: true, label: v.label };
  } catch (e) {
    try {
      const v = JSON.parse(e.stdout);
      // A label mismatch is expected and irrelevant here; a SHAPE refusal is not.
      return v.stage === 'shape' || v.stage === 'decode'
        ? { ok: false, reason: v.reason }
        : { ok: true, label: v.label };
    } catch { return { ok: false, reason: 'verifier failed' }; }
  }
}

const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const slugs = Object.keys(decisions);

if (!slugs.length) {
  console.log('decisions.json is empty — nothing was changed on the sheet.');
  process.exit(0);
}

let swapped = 0, rejected = 0, confirmed = 0, unknown = 0, pasted = 0, failed = 0;
for (const slug of slugs) {
  const rec = manifest[slug];
  const choice = decisions[slug];
  if (!rec) { unknown++; console.log(`  ?      ${slug} — not in the manifest`); continue; }

  // The reviewer looked at the shown image beside the catalog row and said it
  // is right. That human confirmation outranks every recorded doubt, so the
  // flags clear and the next clean-only import promotes it. The reviewer is
  // also the visual watermark check, so no second model call is necessary.
  if (choice === '__confirm__') {
    confirmed++;
    console.log(`  YES    ${rec.name}`);
    if (apply) {
      // A confirmed image photographed against a backdrop still gets the
      // backdrop stripped — the reviewer confirmed the WINE, and a clean
      // white ground is what the catalog grid needs.
      const v = await checkShape(rec.file);
      if (!v.ok && /no clean background/.test(v.reason || '')) {
        console.log('            scene background — removing it…');
        if (await cutBackground(rec.file)) delete rec.watermarkSwept;
      }
      markHumanSelected(rec, 'human review (confirmed)', { visualClearance: true });
    }
    continue;
  }

  if (choice === '__none__') {
    rejected++;
    console.log(`  WRONG  ${rec.name}`);
    if (apply) {
      if (rec.file) { try { await unlink(rec.file); } catch {} }
      markHumanRejected(rec);
      // Recorded, not erased: a later run should know a human refused what was
      // found here rather than treating it as never attempted.
      rec.review = ['rejected by review — none of the candidates was this wine'];
    }
    continue;
  }

  // A pasted URL: the reviewer found the picture themselves. It still goes
  // through the same fetch, shape check and normalisation as anything the
  // pipeline found — a human choosing the image is not a reason to skip
  // checking that it is one bottle on a clean background.
  if (/^https?:\/\//i.test(choice)) {
    // The same source gate the pipeline applies — a human paste is not exempt.
    // The _pb_x pattern is Vivino's CDN naming and travels to re-hosting
    // retailers, where the host check cannot see it.
    const { blockedBy } = await import('./sources.mjs');
    const gate = blockedBy(choice) || (/_pb_x\d+/.test(choice) ? 'vivino filename pattern' : '');
    if (gate) {
      failed++;
      console.log(`  BLOCK  ${rec.name}\n            ${gate}: ${choice.slice(0, 70)}`);
      continue;
    }
    pasted++;
    console.log(`  PASTE  ${rec.name}
            <- ${choice.slice(0, 78)}`);
    if (apply) {
      const got = await fetchImage(choice);
      if (!got) { console.log('            FAILED to fetch'); failed++; pasted--; continue; }
      const dest = join('data/fetched-images', slug + '.png');
      await writeFile(dest, got);
      let v = await checkShape(dest);
      if (!v.ok && /no clean background/.test(v.reason || '')) {
        console.log('            scene background — removing it…');
        if (await cutBackground(dest)) v = await checkShape(dest);
      }
      if (!v.ok) { console.log(`            REFUSED: ${v.reason}`); await unlink(dest).catch(() => {}); failed++; pasted--; continue; }
      rec.ok = true;
      rec.file = dest;
      rec.page = choice;
      rec.label = v.label || '';
      markHumanSelected(rec, 'human (pasted URL)', { visualClearance: true });
    }
    continue;
  }

  const alt = (rec.alternates || []).find((a) => a.file === choice);
  if (!alt) { unknown++; console.log(`  ?      ${slug} — chose ${basename(choice)}, which is not one of its candidates`); continue; }

  swapped++;
  console.log(`  SWAP   ${rec.name}\n            -> ${basename(alt.file)} from ${alt.page ? new URL(alt.page).host : '?'}`);
  if (apply) {
    // Shape-gate the alternate BEFORE touching the staged file: several
    // alternates were refused precisely for their background, and a swap the
    // gate ends up refusing must leave the record exactly as it was.
    let v = await checkShape(alt.file);
    if (!v.ok && /no clean background/.test(v.reason || '')) {
      console.log('            scene background — removing it…');
      if (await cutBackground(alt.file)) v = await checkShape(alt.file);
    }
    if (!v.ok) {
      console.log(`            REFUSED: ${v.reason}`);
      swapped--;
      failed++;
      continue;
    }
    const dest = join('data/fetched-images', slug + '.png');
    try { await unlink(dest); } catch {}
    await rename(alt.file, dest);
    rec.ok = true;
    rec.file = dest;
    rec.page = alt.page;
    rec.label = alt.label;
    rec.size = alt.size;
    markHumanSelected(rec, 'human review', { visualClearance: true });
    // A person looked at the bottle and the name together. That is stronger
    // evidence than either verifier produces, so the doubts they overrule go.
    rec.alternates = (rec.alternates || []).filter((a) => a.file !== choice);
  }
}

if (browser) await browser.close();
if (apply) await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));

console.log(`\n${slugs.length} decisions: ${confirmed} confirmed, ${swapped} swapped, ${rejected} marked wrong${unknown ? `, ${unknown} unrecognised` : ''}`);
if (!apply) {
  console.log('\nnothing written — re-run with --apply');
} else {
  console.log('\napplied. Re-run the sheet to see it: node tools/labelfetch/review.mjs');
  if (rejected) {
    console.log(`${rejected} wines are now marked for another look; they will be retried on the next`);
    console.log('pipeline run, which skips only wines that already have an accepted image.');
  }
}
