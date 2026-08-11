// Apply the human selection rule to one already-corroborated bottle group.
// Identity comes from a readable anchor; the selected member is the cleanest,
// highest-resolution non-conflicting bottle image in that group.
export function selectVisualPick(candidates) {
  if (candidates.length < 2) return null;
  const anchors = candidates.filter((candidate) => candidate.anchor && !candidate.explicitConflict);
  if (!anchors.length) return null;

  // A visually similar sibling can share the bottle, typography, and label
  // architecture (Pichler-Krutzler Loibenberg Riesling vs Klostersatz Gruner
  // Veltliner measured above 0.93). Therefore only a positively read member
  // may be published; similarity corroborates identity but cannot transfer it
  // to an unreadable higher-resolution sibling.
  const usable = anchors.filter((candidate) =>
    candidate.shapeOk && (candidate.width || 0) >= 300 && (candidate.height || 0) >= 500);
  if (!usable.length) return null;

  const pick = [...usable].sort((a, b) =>
    Number(b.cleanBackground) - Number(a.cleanBackground) ||
    Number((b.height || 0) > (b.width || 0) * 1.15) - Number((a.height || 0) > (a.width || 0) * 1.15) ||
    (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];

  return {
    ...pick,
    matchingImages: candidates.length,
    anchorIds: anchors.map((candidate) => candidate.id),
  };
}
