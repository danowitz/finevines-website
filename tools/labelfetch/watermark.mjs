// Watermark-sweep verdict handling, shared by watermarksweep.mjs (writer) and
// import.mjs (enforcer).
//
// Why this exists: the host gate (sources.mjs) blocks Vivino and the stock
// libraries, but a watermark TRAVELS — a retailer that re-hosts Vivino's photo
// serves it from a clean host, and one such image (Adamvs Quintvs, from
// hillsidevineyards.com) reached staging on 2026-07-29. Pixel OCR is a
// documented-weak backstop (Vivino's mark reads as "vlvlno"; see
// tools/imgcheck), so a vision model is asked directly and its verdict is
// recorded on the manifest record, where import can refuse it.

// parseVerdict extracts {watermark, mark} from a model reply, tolerating a
// ```json fence. Unparseable output returns null — the sweep reports it as
// unchecked rather than guessing either way.
export function parseVerdict(content) {
  if (!content) return null;
  const stripped = String(content).replace(/^```(?:json)?|```$/gm, '').trim();
  let v;
  try {
    v = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof v?.watermark !== 'boolean') return null;
  return { watermark: v.watermark, mark: String(v.mark || '') };
}

const FLAG_SUFFIX = ' — never import';

// flagWatermark records a confirmed mark on a manifest record: a machine field
// (rec.watermark) that import refuses on, plus a human-visible review flag.
// Idempotent, so re-running the sweep never stacks duplicate flags.
export function flagWatermark(rec, mark) {
  rec.watermark = mark || 'unknown mark';
  rec.review = rec.review || [];
  if (!rec.review.some((r) => r.startsWith('watermark ('))) {
    rec.review.push(`watermark (${rec.watermark})${FLAG_SUFFIX}`);
  }
}

// isWatermarked reports whether a record carries a confirmed watermark, via
// either the machine field or a review flag (older records may have only one).
export function isWatermarked(rec) {
  return Boolean(rec.watermark) || (rec.review || []).some((r) => r.startsWith('watermark ('));
}
