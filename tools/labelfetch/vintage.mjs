export function vintageConflict(expected, visible) {
  const want = String(expected || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
  const got = String(visible || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
  return want && got && want !== got ? { expected: want, visible: got } : null;
}
