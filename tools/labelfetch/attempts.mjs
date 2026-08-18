// The image attempt ledger: which wines the image stage has already tried for a
// photograph, when, and how it went.
//
// Why it has to exist: about 1,700 catalog wines have no real photograph, and
// most of them have none because none is on the open web. A nightly CI run with
// no memory re-searches all of them every night — hours of runner time and a
// vision call per candidate — to rediscover the same absence. So the default
// behaviour has to be "having failed, do not ask again for a while".
//
// Keyed by SKU, not slug. A slug changes when a wine is renamed or re-vintaged
// (see enrich.Run's rename handling), and a slug-keyed ledger would quietly
// forget everything it knew about a wine the moment its name was tidied up.
//
// Committed to the repo (data/image-attempts.json) because CI keeps no state
// between runs and remembering across them is the entire point.
import { readFile, writeFile } from 'node:fs/promises';

export const LEDGER_PATH = 'data/image-attempts.json';

// How long a failed search waits before being retried. Thirty days is the
// spec's default: long enough that the nightly run is cheap, short enough that a
// wine whose producer finally puts a bottle shot on their site is picked up
// within the month.
export const RETRY_DAYS = 30;

// A miss is meaningful only for the matcher that produced it. Increment this
// whenever discovery or identity selection changes enough that old misses need
// one controlled replay. Newly recorded misses then back off normally again.
// This durable ledger version predates the current Brave-only provider. Keep the legacy value
// until the matching algorithm changes; renaming it alone would replay old misses.
export const MATCHER_VERSION = 'google-image-consensus-v1';

// The only outcomes a record may carry.
//
// 'imported' is terminal — the wine has its photograph. 'miss' is everything the
// stage actually decided against: nothing found, nothing that passed the shape
// gate, a watermark hit, a normalise failure. Those are one outcome on purpose —
// from the ledger's point of view they all mean "no photograph yet, try again
// after the backoff", and distinguishing them would invite per-reason backoffs
// nobody has asked for.
//
// 'unevaluated' is the outcome that carries NO backoff (see isDue), and it is not
// a per-reason refinement of 'miss' — it is the absence of a decision. It exists
// because two things in this pipeline can stop a wine from being judged at all
// while looking exactly like a refusal: the vision endpoint being unreachable
// when the label is read (pipeline.mjs), and the watermark sweep failing to reach
// a verdict on an image that WAS found and verified (import.mjs, where the C2
// gate refuses an unswept record and the staged file then dies with the runner,
// data/fetched-images/ being gitignored). A 30-day bench earned by an OpenAI 429
// is a wine that never gets its photograph, so those runs record this instead and
// the wine stays due. The count still increments, so the history is not lost.
const OUTCOMES = new Set(['imported', 'miss', 'unevaluated']);

// loadAttempts reads the ledger. A missing file is first-run behaviour; a
// CORRUPT file is also treated as empty rather than fatal, because the ledger is
// an optimisation — losing it costs a slow night, whereas failing the run over
// it costs the whole night.
export async function loadAttempts(path = LEDGER_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// saveAttempts writes the ledger with sorted keys and a trailing newline: it is
// committed to a public repo, so it has to diff one SKU at a time instead of
// reshuffling on every run.
//
// The sort is done by hand-building the JSON text from a sorted array of
// [sku, record] pairs rather than by inserting into a plain object in sorted
// order and letting JSON.stringify walk it. A plain object cannot carry an
// arbitrary string-sort key order: JS enumerates any key that reads as a
// canonical integer index (e.g. "180118") ahead of every other key, in
// ascending NUMERIC order, regardless of insertion order — and most catalog
// SKUs are all-digit strings. That silently splits the file into a numeric
// block followed by a non-numeric block instead of one lexicographic order.
export async function saveAttempts(attempts, path = LEDGER_PATH) {
  const skus = Object.keys(attempts).sort();
  const entries = skus.map((sku) => {
    // Re-indent the record's own JSON so it nests correctly under the
    // 1-space top-level indent: every line but the opening "{" gets one more
    // leading space.
    const body = JSON.stringify(attempts[sku], null, 1)
      .split('\n')
      .map((line, i) => (i === 0 ? line : ` ${line}`))
      .join('\n');
    return ` ${JSON.stringify(sku)}: ${body}`;
  });
  const text = entries.length ? `{\n${entries.join(',\n')}\n}\n` : '{}\n';
  await writeFile(path, text);
}

// isDue reports whether the image stage should try this SKU on this run.
//
// Unknown SKU: yes. Already imported: never again. Left unevaluated: yes, at
// once — nothing was decided, so there is nothing to back off from. A miss: only
// once the backoff has elapsed. A record whose timestamp cannot be read: yes —
// biasing to retry, because a corrupt record reading as "not due" would silently
// exclude a wine from image sourcing forever and nobody would ever notice.
export function isDue(
  attempts,
  sku,
  now = new Date(),
  retryDays = RETRY_DAYS,
  { imageMissing = false, matcherVersion = MATCHER_VERSION, reviewRequired = false } = {},
) {
  const rec = attempts?.[sku];
  if (reviewRequired) return true;
  if (!rec) return true;
  // The catalog is authoritative. An imported ledger record with no current
  // photograph means an audit or later edit withdrew the pixels; it must not
  // become a permanent hidden exclusion.
  if (rec.outcome === 'imported') return imageMissing;
  if (rec.outcome === 'unevaluated') return true;
  if (rec.outcome === 'miss' && rec.matcherVersion !== matcherVersion) return true;
  const last = Date.parse(rec.lastAttempted ?? '');
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= retryDays * 86400000;
}

// shouldRecordAttempt reports whether a run learned enough about a wine to write
// the ledger at all.
//
// The 30-day backoff is only defensible if a recorded miss means somebody
// actually looked. In the bounded selector, establishing the readable anchor can
// require one network call — and a 429 or a 502 says nothing whatsoever about
// the wine. Recording that as a miss benches a never-evaluated wine for a month,
// and the month after it can be benched the same way again, so a wine whose photo
// is sitting on its producer's website never gets found.
//
// The distinction is therefore "was a candidate EVALUATED", not "did a candidate
// pass":
//   - accepted, or any candidate judged: record. A judged-and-refused candidate is
//     a real miss and the backoff is exactly right for it.
//   - no candidates at all, with every source searched: record. An empty
//     completed search is the answer.
//   - candidates found but none could be judged: do NOT record. The wine stays due
//     and the next run tries it again.
//   - any discovery source unavailable: do NOT record a refusal or empty result.
//     "Could not search" is not evidence that no photograph exists.
export function shouldRecordAttempt({
  accepted = false,
  evaluated = 0,
  unevaluated = 0,
  discoveryComplete = true,
} = {}) {
  // A staged acceptance is recorded pessimistically until import promotes it,
  // even if another discovery source was unavailable. A refusal or empty result
  // earns a backoff only when every discovery source actually searched.
  if (accepted) return true;
  if (!discoveryComplete) return false;
  if (evaluated > 0) return true;
  return unevaluated === 0;
}

// recordAttempt stamps an attempt onto the ledger, incrementing the per-SKU
// count. Mutates and returns attempts so a caller can record inside a loop and
// save once at the end.
export function recordAttempt(
  attempts,
  sku,
  outcome,
  now = new Date(),
  { imageMissing = false, matcherVersion = MATCHER_VERSION } = {},
) {
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`recordAttempt: unknown outcome ${JSON.stringify(outcome)}; expected one of ${[...OUTCOMES].join(', ')}`);
  }
  // Imported is terminal. A manual fetch sample may omit --due-only and revisit
  // a placeholder row sharing a SKU/slug with an already imported card; that
  // search must not downgrade durable catalog state back to a 30-day miss.
  if (attempts[sku]?.outcome === 'imported' && outcome !== 'imported' && !imageMissing) {
    return attempts;
  }
  const prior = attempts[sku]?.attempts ?? 0;
  attempts[sku] = {
    lastAttempted: now.toISOString(),
    outcome,
    attempts: prior + 1,
    matcherVersion,
  };
  return attempts;
}
