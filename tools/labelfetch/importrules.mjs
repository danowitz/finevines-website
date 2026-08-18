// The decision of whether one staged record may be promoted into the catalog.
// Extracted from import.mjs so the rules are testable and so the watermark
// refusal cannot be forgotten by a future edit to the import loop.
import { isWatermarked } from './watermark.mjs';
import { IMAGE_REVIEW_REQUIRED } from './image-review-status.mjs';

const PRODUCTION_SELECTOR = 'gpt-4.1-nano transcription + local identity rules';

// Records staged before the explicit boolean was introduced still carry the
// complete selector proof. Keep that bounded compatibility path so a reviewed
// batch does not need to be searched and paid for again.
export function hasSelectionIdentityVerdict(rec) {
  if (rec.selectionIdentityVerified === true) return true;
  return rec.verifiedBy === PRODUCTION_SELECTOR &&
    Number(rec.matchingImages) >= 2 &&
    Array.isArray(rec.evidence) && rec.evidence.some((item) => item?.anchor === true);
}

// shouldImport returns {import: boolean, reason?: string, unresolved?: boolean}.
//
// Order matters: the watermark refusal outranks everything, including a human
// having cleared the review queue — a watermarked image is never importable,
// it can only be replaced by a re-fetch from a clean source.
//
// `unresolved` distinguishes "this image is not importable" from "a required
// gate never reached a verdict". The latter leaves the wine due for another
// attempt; see import.mjs.
export function shouldImport(rec, wine, { cleanOnly = false } = {}) {
  if (isWatermarked(rec)) {
    return { import: false, stage: 'watermark', reason: `watermark (${rec.watermark || '?'}) — never imported` };
  }
  if (!wine) {
    return { import: false, stage: 'catalog-missing', reason: 'no such wine in the catalog' };
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
    wine.imageSource !== 'generated-photo' &&
    wine.imageSource !== 'label-scan'
  ) {
    return { import: false, stage: 'existing-photo', reason: `already has a photograph (${wine.imagePath})` };
  }
  if (wine.imageReviewStatus === IMAGE_REVIEW_REQUIRED) {
    return {
      import: false,
      stage: 'human-review-required',
      reason: 'review recovery requires a fresh human review before import',
    };
  }
  // Check selector identity before the paid watermark gate so incomplete
  // records are reported honestly and never consume a sweep request.
  if (!hasSelectionIdentityVerdict(rec)) {
    return {
      import: false,
      stage: 'identity-proof',
      unresolved: rec.selectionIdentityVerified === undefined,
      reason: 'production selector did not affirm this exact wine',
    };
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
  // This unresolved flag matters because the staged file is about to be discarded
  // (data/fetched-images/ is gitignored, so it does not survive the runner) and
  // the wine's ledger entry must therefore be left open rather than backed off
  // for thirty days. import.mjs records 'unevaluated' on the strength of it.
  if (rec.watermarkSwept !== true) {
    const why = rec.watermarkSweepError ? ` (${rec.watermarkSweepError})` : '';
    return {
      import: false,
      stage: 'watermark-unresolved',
      unresolved: true,
      reason: `watermark sweep has not cleared this image${why} — not imported, and the wine stays due`,
    };
  }
  if (cleanOnly && (rec.review || []).length) {
    return { import: false, stage: 'review', reason: `flagged for review (${rec.review.join('; ')})` };
  }
  return { import: true, stage: 'ready' };
}
