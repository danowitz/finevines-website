import { blockedBy } from './sources.mjs';

// Brave exposes an actual image-search contract: result.url is the source page
// and result.properties.url is the original image. Keep that pairing intact so
// source policy and provenance apply to both sides of every candidate.
export function createBraveImageDiscovery({ token, count = 10, fetchImpl = globalThis.fetch } = {}) {
  let down = '';

  return async function discoverBraveImages(query) {
    if (!token) {
      return { status: 'unavailable', searched: false, items: [], error: 'credentials missing', returned: 0, blocked: 0, trace: [] };
    }
    if (down) {
      return { status: 'unavailable', searched: false, items: [], error: down, returned: 0, blocked: 0, trace: [] };
    }

    try {
      const params = new URLSearchParams({
        q: query,
        country: 'US',
        search_lang: 'en',
        count: String(count),
        safesearch: 'strict',
      });
      const res = await fetchImpl(`https://api.search.brave.com/res/v1/images/search?${params}`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': token },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = String((await res.json())?.error?.detail || '').split('\n')[0]; } catch {}
        down = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
        return { status: 'unavailable', searched: false, items: [], error: down, returned: 0, blocked: 0, trace: [] };
      }

      const body = await res.json();
      const results = body.results || [];
      const candidates = [];
      const trace = [];
      let blocked = 0;
      for (const [index, result] of results.entries()) {
        const image = result.properties?.url || '';
        const context = result.url || '';
        let outcome = 'permitted';
        if (!image) outcome = 'missing-image-url';
        else if (blockedBy(image)) outcome = 'blocked-image-host';
        else if (context && blockedBy(context)) outcome = 'blocked-context-host';
        trace.push({
          index: index + 1,
          outcome,
          image,
          context,
          title: result.title || '',
          width: result.properties?.width || 0,
          height: result.properties?.height || 0,
        });
        if (outcome !== 'permitted') {
          blocked++;
          continue;
        }
        let host = '';
        try { host = new URL(context || image).host.replace(/^www\./, ''); } catch {}
        candidates.push({
          url: image,
          context,
          host,
          title: result.title || '',
          width: result.properties?.width || 0,
          height: result.properties?.height || 0,
        });
      }

      return {
        status: 'ok',
        searched: true,
        items: [...new Map(candidates.map((item) => [item.url, item])).values()],
        returned: results.length,
        blocked,
        error: '',
        trace,
        correctedQuery: body.query?.altered || '',
      };
    } catch (error) {
      down = String(error?.message || error).split('\n')[0] || 'request failed';
      return { status: 'unavailable', searched: false, items: [], error: down, returned: 0, blocked: 0, trace: [] };
    }
  };
}
