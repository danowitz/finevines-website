// The decision of whether one staged record may be promoted into the catalog.
// Extracted from import.mjs so the rules are testable and so the watermark
// refusal cannot be forgotten by a future edit to the import loop.
import { isWatermarked } from './watermark.mjs';

// shouldImport returns {import: boolean, reason?: string, unresolved?: boolean}.
//
// Order matters: the watermark refusal outranks everything, including a human
// having cleared the review queue — a watermarked image is never importable,
// it can only be replaced by a re-fetch from a clean source.
//
// `unresolved` distinguishes "this image is not importable" from "nobody has
// established whether this image is importable". Only the unswept refusal is the
// latter, and only it leaves the wine due for another attempt; see below.
export function shouldImport(rec, wine, { cleanOnly = false } = {}) {
  if (isWatermarked(rec)) {
    return { import: false, reason: `watermark (${rec.watermark || '?'}) — never imported` };
  }
  if (!wine) {
    return { import: false, reason: 'no such wine in the catalog' };
  }
  // Never overwrite a real photograph the catalog already holds. Only the
  // generated stand-ins are replaced — the SVG label and the gpt-image-1
  // photo (imageSource generated-photo) — matching enrich.hasRealImage on
  // the Go side: a generated image is a placeholder wearing better clothes,
  // and a verified real photograph always outranks it. Anything else is an
  // editorial choice someone made and this is not the tool to reverse it.
  if (
    wine.imagePath &&
    !wine.imagePath.endsWith('.svg') &&
    wine.imageSource !== 'generated-photo'
  ) {
    return { import: false, reason: `already has a photograph (${wine.imagePath})` };
  }
  // The invariant is "no image publishes until the sweep has LOOKED at it", not
  // "no image publishes once the sweep has condemned it" — and only the first of
  // those is safe. watermarksweep.mjs produces no verdict on a transport error,
  // an exhausted retry budget or an unparseable reply, and leaves such a record
  // exactly as it found it: unflagged, unswept, and (before this rule) freely
  // importable. That is the failure mode that matters, because it is permanent:
  // once a photograph sits in the catalog the rule above refuses to replace it,
  // so a watermark that slips through on a night the sweep was rate-limited can
  // never be swept out again.
  //
  // Placed last among the refusals on purpose: everything above is a decision
  // about this image, so `unresolved` marks the ONLY refusal that is not one.
  // That flag matters to the caller — the staged file is about to be discarded
  // (data/fetched-images/ is gitignored, so it does not survive the runner) and
  // the wine's ledger entry must therefore be left open rather than backed off
  // for thirty days. import.mjs records 'unevaluated' on the strength of it.
  if (rec.watermarkSwept !== true) {
    const why = rec.watermarkSweepError ? ` (${rec.watermarkSweepError})` : '';
    return {
      import: false,
      unresolved: true,
      reason: `watermark sweep has not cleared this image${why} — not imported, and the wine stays due`,
    };
  }
  if (cleanOnly && (rec.review || []).length) {
    return { import: false, reason: `flagged for review (${rec.review.join('; ')})` };
  }
  return { import: true };
}
