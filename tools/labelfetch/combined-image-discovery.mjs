import { IMAGE_SEARCH_RESULT_COUNT } from './candidate-window.mjs';

function roundRobin(results, limit) {
  const queues = results.map(({ result }) => [...(result.items || [])]);
  const items = [];
  const seen = new Set();
  while (items.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
      if (items.length === limit) break;
    }
  }
  return items;
}

// A bounded fan-in seam for independent image indexes. It queries providers
// concurrently, preserves provider-level outage evidence, and interleaves the
// usable candidates so one index cannot crowd the other out of the local
// consensus window. It never turns a partial outage into a definitive miss.
export function createCombinedImageDiscovery({
  providers = [],
  limit = IMAGE_SEARCH_RESULT_COUNT,
} = {}) {
  if (providers.length < 2) throw new Error('combined image discovery requires at least two providers');

  return async function discoverCombinedImages(query) {
    const results = await Promise.all(providers.map(async ({ name, discover }) => {
      try {
        return { name, result: await discover(query) };
      } catch (error) {
        return { name, result: {
          status: 'unavailable', searched: false, complete: false, items: [],
          returned: 0, blocked: 0, trace: [],
          error: String(error?.message || error).split('\n')[0] || 'request failed',
        } };
      }
    }));
    const searched = results.some(({ result }) => result.searched);
    const complete = results.every(({ result }) => result.searched && result.complete !== false);
    const errors = results
      .filter(({ result }) => !result.searched)
      .map(({ name, result }) => `${name}: ${result.error || 'unavailable'}`);
    const summaries = results.map(({ name, result }) => ({
      name,
      status: result.status,
      searched: result.searched,
      complete: result.searched && result.complete !== false,
      returned: result.returned || 0,
      blocked: result.blocked || 0,
      permitted: result.items?.length || 0,
      error: result.error || '',
      correctedQuery: result.correctedQuery || '',
    }));
    const trace = results.flatMap(({ name, result }) =>
      (result.trace || []).map((entry) => ({ provider: name, ...entry })));

    return {
      status: !searched ? 'unavailable' : complete ? 'ok' : 'partial',
      searched,
      complete,
      items: roundRobin(results, limit),
      returned: results.reduce((sum, { result }) => sum + (result.returned || 0), 0),
      blocked: results.reduce((sum, { result }) => sum + (result.blocked || 0), 0),
      error: errors.join('; '),
      correctedQuery: results.map(({ result }) => result.correctedQuery).find(Boolean) || '',
      providers: summaries,
      trace,
    };
  };
}
