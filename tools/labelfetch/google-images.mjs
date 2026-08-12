import { blockedBy } from './sources.mjs';

// Google image discovery is stateful for one pipeline run: after the API says
// it is unavailable, later wines must not burn one doomed request apiece.
// Every call reports whether a search actually happened so an outage can never
// be recorded as "nothing found" in the attempt ledger.
export const GOOGLE_IMAGE_SEARCH_PROFILES = Object.freeze({
  baseline: Object.freeze({}),
  consensus: Object.freeze({ filter: '0', hl: 'en', gl: 'us' }),
});

export function googleImageSearchProfile(name = 'baseline') {
  const profile = GOOGLE_IMAGE_SEARCH_PROFILES[name];
  if (!profile) throw new Error(`unknown Google image search profile: ${name}`);
  return profile;
}

export function createGoogleImageDiscovery({
  key,
  cx,
  searchParams = GOOGLE_IMAGE_SEARCH_PROFILES.baseline,
  fetchImpl = globalThis.fetch,
} = {}) {
  let down = '';

  return async function discoverGoogleImages(query) {
    if (!key || !cx) {
      return { status: 'unavailable', searched: false, items: [], error: 'credentials missing', returned: 0, blocked: 0, trace: [] };
    }
    if (down) {
      return { status: 'unavailable', searched: false, items: [], error: down, returned: 0, blocked: 0, trace: [] };
    }

    try {
      const params = new URLSearchParams({
        key,
        cx,
        q: query,
        searchType: 'image',
        num: '10',
        safe: 'active',
        ...searchParams,
      });
      const res = await fetchImpl('https://www.googleapis.com/customsearch/v1?' + params, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = String((await res.json())?.error?.message || '').split('\n')[0]; } catch {}
        down = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
        return { status: 'unavailable', searched: false, items: [], error: down, returned: 0, blocked: 0, trace: [] };
      }

      const items = (await res.json()).items || [];
      const candidates = [];
      const trace = [];
      let blocked = 0;
      for (const [index, item] of items.entries()) {
        const image = item.link || '';
        const context = item.image?.contextLink || '';
        // Image and context are one provenance record. If either side points at
        // a blocked competitor, reject the whole record rather than laundering
        // its pixels through an allowed CDN hostname.
        let outcome = 'permitted';
        if (!image) outcome = 'missing-image-url';
        else if (blockedBy(image)) outcome = 'blocked-image-host';
        else if (context && blockedBy(context)) outcome = 'blocked-context-host';
        else if (/_pb_x\d+/.test(image)) outcome = 'blocked-placeholder';
        trace.push({
          index: index + 1,
          outcome,
          image,
          context,
          title: item.title || '',
          width: item.image?.width || 0,
          height: item.image?.height || 0,
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
          title: item.title || '',
          width: item.image?.width || 0,
          height: item.image?.height || 0,
        });
      }

      return {
        status: 'ok',
        searched: true,
        items: [...new Map(candidates.map((item) => [item.url, item])).values()],
        returned: items.length,
        blocked,
        error: '',
        trace,
      };
    } catch (error) {
      down = String(error?.message || error).split('\n')[0] || 'request failed';
      return { status: 'unavailable', searched: false, items: [], error: down, returned: 0, blocked: 0, trace: [] };
    }
  };
}
