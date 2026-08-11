import { blockedBy } from './sources.mjs';

// Google image discovery is stateful for one pipeline run: after the API says
// it is unavailable, later wines must not burn one doomed request apiece.
// Every call reports whether a search actually happened so an outage can never
// be recorded as "nothing found" in the attempt ledger.
export function createGoogleImageDiscovery({ key, cx, fetchImpl = globalThis.fetch } = {}) {
  let down = '';

  return async function discoverGoogleImages(query) {
    if (!key || !cx) {
      return { status: 'unavailable', searched: false, items: [], error: 'credentials missing' };
    }
    if (down) {
      return { status: 'unavailable', searched: false, items: [], error: down };
    }

    try {
      const params = new URLSearchParams({
        key,
        cx,
        q: query,
        searchType: 'image',
        num: '10',
        safe: 'active',
      });
      const res = await fetchImpl('https://www.googleapis.com/customsearch/v1?' + params, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = String((await res.json())?.error?.message || '').split('\n')[0]; } catch {}
        down = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
        return { status: 'unavailable', searched: false, items: [], error: down };
      }

      const items = (await res.json()).items || [];
      const candidates = [];
      for (const item of items) {
        const image = item.link || '';
        const context = item.image?.contextLink || '';
        // Image and context are one provenance record. If either side points at
        // a blocked competitor, reject the whole record rather than laundering
        // its pixels through an allowed CDN hostname.
        if (!image || blockedBy(image) || (context && blockedBy(context)) || /_pb_x\d+/.test(image)) continue;
        let host = '';
        try { host = new URL(context || image).host.replace(/^www\./, ''); } catch {}
        candidates.push({
          url: image,
          context,
          host,
          title: item.title || '',
          width: item.image?.width || 0,
          height: item.image?.height || 0,
        });
      }

      return {
        status: 'ok',
        searched: true,
        items: [...new Map(candidates.map((item) => [item.url, item])).values()],
        error: '',
      };
    } catch (error) {
      down = String(error?.message || error).split('\n')[0] || 'request failed';
      return { status: 'unavailable', searched: false, items: [], error: down };
    }
  };
}
