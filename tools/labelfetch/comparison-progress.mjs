export function passedSlugs(report = {}) {
  return new Set([
    ...(Array.isArray(report.cumulativePassedSlugs) ? report.cumulativePassedSlugs : []),
    ...(Array.isArray(report.rows)
      ? report.rows.filter((row) => row?.ok && row.slug).map((row) => row.slug)
      : []),
  ]);
}

export function withoutPassed(wines, passed) {
  if (!passed?.size) return wines;
  return wines.filter((wine) => !passed.has(wine.slug));
}

export function unresolvedSlugs(report = {}) {
  const slugs = Array.isArray(report.remainingSlugs)
    ? report.remainingSlugs
    : Array.isArray(report.rows)
      ? report.rows.filter((row) => row?.ok === false && row.slug).map((row) => row.slug)
      : [];
  return new Set(slugs);
}

export function reportSlugs(report = {}) {
  return new Set(Array.isArray(report.rows)
    ? report.rows.filter((row) => row?.slug).map((row) => row.slug)
    : []);
}
