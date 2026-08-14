import { blockedBy } from './sources.mjs';
import { IMAGE_SEARCH_RESULT_COUNT } from './candidate-window.mjs';

const ENDPOINT = 'https://google.serper.dev/images';

// Serper is a browser-like Google Images adapter. Keep the direct image URL
// and its source page inseparable: source policy and later provenance checks
// apply to the complete pair, never to an image CDN hostname in isolation.
export function createSerperImageDiscovery({
  apiKey,
  count = IMAGE_SEARCH_RESULT_COUNT,
  fetchImpl = globalThis.fetch,
} = {}) {
  let down = '';

  return async function discoverSerperImages(query) {
    if (!apiKey) return {
      status: 'unavailable', searched: false, complete: false, items: [],
      error: 'credentials missing', returned: 0, blocked: 0, trace: [],
    };
    if (down) return {
      status: 'unavailable', searched: false, complete: false, items: [],
      error: down, returned: 0, blocked: 0, trace: [],
    };

    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ q: query, gl: 'us', hl: 'en', num: count }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = String(body?.message || body?.error || '').split('\n')[0];
        } catch {}
        down = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
        return {
          status: 'unavailable', searched: false, complete: false, items: [],
          error: down, returned: 0, blocked: 0, trace: [],
        };
      }

      const body = await res.json();
      const results = body.images || [];
      const candidates = [];
      const trace = [];
      let blocked = 0;
      for (const [index, item] of results.entries()) {
        const image = item.imageUrl || '';
        const context = item.link || '';
        let outcome = 'permitted';
        if (!image) outcome = 'missing-image-url';
        else if (blockedBy(image)) outcome = 'blocked-image-host';
        else if (context && blockedBy(context)) outcome = 'blocked-context-host';
        trace.push({
          index: index + 1,
          outcome,
          image,
          context,
          title: item.title || '',
          width: item.imageWidth || 0,
          height: item.imageHeight || 0,
          position: item.position || index + 1,
        });
        if (outcome !== 'permitted') {
          blocked++;
          continue;
        }
        let host = String(item.domain || '').replace(/^www\./, '');
        if (!host) {
          try { host = new URL(context || image).host.replace(/^www\./, ''); } catch {}
        }
        candidates.push({
          url: image,
          context,
          host,
          title: item.title || '',
          width: item.imageWidth || 0,
          height: item.imageHeight || 0,
          discovery: 'serper',
        });
      }

      return {
        status: 'ok',
        searched: true,
        complete: true,
        items: [...new Map(candidates.map((item) => [item.url, item])).values()],
        returned: results.length,
        blocked,
        error: '',
        trace,
      };
    } catch (error) {
      down = String(error?.message || error).split('\n')[0] || 'request failed';
      return {
        status: 'unavailable', searched: false, complete: false, items: [],
        error: down, returned: 0, blocked: 0, trace: [],
      };
    }
  };
}
