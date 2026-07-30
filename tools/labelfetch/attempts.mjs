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

// The only outcomes a record may carry. 'imported' is terminal — the wine has
// its photograph. 'miss' is everything else: nothing found, nothing that passed
// the shape gate, a watermark hit, a normalise failure. They are one outcome on
// purpose: from the ledger's point of view they all mean "no photograph yet, try
// again after the backoff", and distinguishing them would invite per-reason
// backoffs nobody has asked for.
const OUTCOMES = new Set(['imported', 'miss']);

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
// Unknown SKU: yes. Already imported: never again. A miss: only once the backoff
// has elapsed. A record whose timestamp cannot be read: yes — biasing to retry,
// because a corrupt record reading as "not due" would silently exclude a wine
// from image sourcing forever and nobody would ever notice.
export function isDue(attempts, sku, now = new Date(), retryDays = RETRY_DAYS) {
  const rec = attempts?.[sku];
  if (!rec) return true;
  if (rec.outcome === 'imported') return false;
  const last = Date.parse(rec.lastAttempted ?? '');
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= retryDays * 86400000;
}

// recordAttempt stamps an attempt onto the ledger, incrementing the per-SKU
// count. Mutates and returns attempts so a caller can record inside a loop and
// save once at the end.
export function recordAttempt(attempts, sku, outcome, now = new Date()) {
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`recordAttempt: unknown outcome ${JSON.stringify(outcome)}; expected one of ${[...OUTCOMES].join(', ')}`);
  }
  const prior = attempts[sku]?.attempts ?? 0;
  attempts[sku] = {
    lastAttempted: now.toISOString(),
    outcome,
    attempts: prior + 1,
  };
  return attempts;
}
