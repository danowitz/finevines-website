const INITIAL_RESULTS = 10;
const EXTENSION_RESULTS = 5;

// One bounded discovery window establishes whether a repeated design is a
// trend. The first ten are normal evidence; five more absorb blocked, broken,
// or noisy early results without turning discovery into an unbounded crawl.
export const IMAGE_SEARCH_RESULT_COUNT = INITIAL_RESULTS + EXTENSION_RESULTS;

export function candidateWindow(items) {
  const candidates = items.slice(0, IMAGE_SEARCH_RESULT_COUNT);
  return {
    candidates,
    diagnostics: {
      initialWindowCandidates: Math.min(INITIAL_RESULTS, candidates.length),
      extensionWindowCandidates: Math.max(0, candidates.length - INITIAL_RESULTS),
    },
  };
}
