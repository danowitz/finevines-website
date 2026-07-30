// The decision of whether one staged record may be promoted into the catalog.
// Extracted from import.mjs so the rules are testable and so the watermark
// refusal cannot be forgotten by a future edit to the import loop.
import { isWatermarked } from './watermark.mjs';

// shouldImport returns {import: boolean, reason?: string}.
//
// Order matters: the watermark refusal outranks everything, including a human
// having cleared the review queue — a watermarked image is never importable,
// it can only be replaced by a re-fetch from a clean source.
export function shouldImport(rec, wine, { cleanOnly = false } = {}) {
  if (isWatermarked(rec)) {
    return { import: false, reason: `watermark (${rec.watermark || '?'}) — never imported` };
  }
  if (!wine) {
    return { import: false, reason: 'no such wine in the catalog' };
  }
  // Never overwrite a real photograph the catalog already holds. Only the
  // generated SVG fallback is replaced; anything else is an editorial choice
  // someone made and this is not the tool to reverse it.
  if (wine.imagePath && !wine.imagePath.endsWith('.svg')) {
    return { import: false, reason: `already has a photograph (${wine.imagePath})` };
  }
  if (cleanOnly && (rec.review || []).length) {
    return { import: false, reason: `flagged for review (${rec.review.join('; ')})` };
  }
  return { import: true };
}
