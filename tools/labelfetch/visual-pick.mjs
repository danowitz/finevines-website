// Apply the human selection rule to one already-corroborated bottle group.
// Identity comes from a readable anchor; the selected member is the cleanest,
// highest-resolution non-conflicting bottle image in that group.
export function evaluateVisualPick(candidates) {
  const diagnostics = {
    groupedImages: candidates.length,
    identityAnchors: 0,
    explicitConflicts: candidates.filter((candidate) => candidate.explicitConflict).length,
    anchorShapeFailures: 0,
    anchorResolutionFailures: 0,
    publishableAnchors: 0,
  };
  if (candidates.length < 2) return { pick: null, diagnostics };
  const anchors = candidates.filter((candidate) => candidate.anchor && !candidate.explicitConflict);
  diagnostics.identityAnchors = anchors.length;
  if (!anchors.length) return { pick: null, diagnostics };

  // A visually similar sibling can share the bottle, typography, and label
  // architecture (Pichler-Krutzler Loibenberg Riesling vs Klostersatz Gruner
  // Veltliner measured above 0.93). Therefore only a positively read member
  // may be published; similarity corroborates identity but cannot transfer it
  // to an unreadable higher-resolution sibling.
  const usable = anchors.filter((candidate) => {
    const width = candidate.width || 0;
    const height = candidate.height || 0;
    // A tall, clean importer cutout can be narrow in pixels and still render
    // well in the normalized catalog card. Keep the ordinary 300x500 floor,
    // but admit a 180x650 clean bottle rather than discarding exact official
    // artwork such as Jean Royer's 188x700 Prestige image.
    const normalResolution = width >= 300 && height >= 500;
    const narrowCleanCutout = candidate.cleanBackground && width >= 180 && height >= 650;
    if (!candidate.shapeOk) diagnostics.anchorShapeFailures++;
    else if (!(normalResolution || narrowCleanCutout)) diagnostics.anchorResolutionFailures++;
    return candidate.shapeOk && (normalResolution || narrowCleanCutout);
  });
  diagnostics.publishableAnchors = usable.length;
  if (!usable.length) return { pick: null, diagnostics };

  const pick = [...usable].sort((a, b) =>
    Number(b.cleanBackground) - Number(a.cleanBackground) ||
    Number((b.height || 0) > (b.width || 0) * 1.15) - Number((a.height || 0) > (a.width || 0) * 1.15) ||
    (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];

  return {
    pick: {
      ...pick,
      matchingImages: candidates.length,
      anchorIds: anchors.map((candidate) => candidate.id),
    },
    diagnostics,
  };
}

export function selectVisualPick(candidates) {
  return evaluateVisualPick(candidates).pick;
}
