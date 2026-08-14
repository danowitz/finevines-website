import { readFile } from 'node:fs/promises';
import { blockedBy } from './sources.mjs';

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

function permitted(url) {
  return url && !blockedBy(url);
}

// Deep module: callers provide verified or provisional visual seeds and
// receive bounded related-image candidates. Only full matches of verified
// seeds inherit identity; partial and visually-similar results remain
// provisional and must earn identity independently.
// Authentication, response association, source policy,
// deduplication and spend bounds stay inside.
export function createWebMatchExpander({
  apiKey,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  prepareSeed = async (seed) => readFileImpl(seed.file),
  prepareSeedVariants,
  maxSeeds = 1,
  maxCandidates = 10,
} = {}) {
  return async function expandVerifiedAnchors(seeds = []) {
    if (!apiKey) return {
      status: 'disabled', items: [], corroborationPages: [], error: 'credentials missing', requests: 0, blocked: 0, trace: [],
    };

    const items = [];
    const trace = [];
    const corroborationPages = [];
    let blocked = 0;
    let requests = 0;
    for (const seed of seeds.slice(0, maxSeeds)) {
      const verifiedIdentity = seed.verifiedIdentity === true;
      let variants;
      try {
        variants = prepareSeedVariants
          ? await prepareSeedVariants(seed)
          : [{ kind: 'seed', bytes: await prepareSeed(seed) }];
      } catch (error) {
        return {
          status: 'unavailable', items: [], corroborationPages, error: String(error?.message || error).split('\n')[0],
          requests, blocked, trace,
        };
      }
      for (const variant of (variants || []).slice(0, 2)) {
        let response;
        try {
          requests++;
          response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            // Keep credentials out of URLs, redirects and diagnostic traces.
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            signal: AbortSignal.timeout(30_000),
            body: JSON.stringify({ requests: [{
              image: { content: variant.bytes.toString('base64') },
              features: [{ type: 'WEB_DETECTION', maxResults: maxCandidates }],
            }] }),
          });
        } catch (error) {
          return {
            status: 'unavailable', items: [], corroborationPages, error: String(error?.message || error).split('\n')[0],
            requests, blocked, trace,
          };
        }
        if (!response.ok) {
          let detail = '';
          try { detail = (await response.json())?.error?.message || ''; } catch {}
          return {
            status: 'unavailable', items: [], corroborationPages, error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
            requests, blocked, trace,
          };
        }
        const body = await response.json();
        const annotation = body.responses?.[0];
        if (annotation?.error) return {
          status: 'unavailable', items: [], corroborationPages, error: annotation.error.message || 'Web Detection failed',
          requests, blocked, trace,
        };
        const web = annotation?.webDetection || {};
        const addMatch = ({ match, context = '', title = '', kind }) => {
        const url = match.url || '';
        const outcome = url === seed.url ? 'seed-duplicate'
          : !permitted(url) ? 'blocked-image-host'
          : context && !permitted(context) ? 'blocked-context-host' : `permitted-${kind}-match`;
        trace.push({
          seed: seed.id, seedIdentity: verifiedIdentity ? 'verified' : 'provisional',
          representation: variant.kind || 'seed', kind, url, context, outcome, score: match.score || 0,
        });
        if (!outcome.startsWith('permitted-')) {
          if (outcome.startsWith('blocked-')) blocked++;
          return;
        }
        if (items.some((item) => item.url === url) || items.length >= maxCandidates) return;
        let host = '';
        try { host = new URL(context || url).host.replace(/^www\./, ''); } catch {}
        const trustedFullMatch = kind === 'full' && verifiedIdentity;
        items.push({
          url,
          context,
          host,
          title,
          width: 0,
          height: 0,
          trustedFullMatch,
          provisionalFullMatch: !trustedFullMatch,
          webMatchKind: kind,
          identityAnchorUrl: seed.url,
          discovery: 'google-web-detection',
        });
        };

        for (const page of web.pagesWithMatchingImages || []) {
          const context = page.url || '';
          if (permitted(context) && corroborationPages.length < 20 &&
              !corroborationPages.some((entry) => entry.url === context)) {
            corroborationPages.push({
              url: context,
              title: page.pageTitle || '',
              fullMatches: (page.fullMatchingImages || []).map((match) => match.url).filter(permitted).slice(0, 10),
              partialMatches: (page.partialMatchingImages || []).map((match) => match.url).filter(permitted).slice(0, 10),
            });
          }
          for (const match of page.fullMatchingImages || []) {
            addMatch({ match, context, title: page.pageTitle || '', kind: 'full' });
          }
          for (const match of page.partialMatchingImages || []) {
            addMatch({ match, context, title: page.pageTitle || '', kind: 'partial' });
          }
        }
        // Cloud Vision also returns useful top-level matches that are not
        // repeated beneath a source page. Preserve their direct-image URL as
        // provenance. Only an exact full match from an already verified seed
        // inherits identity; partial/similar matches remain provisional.
        for (const match of web.fullMatchingImages || []) addMatch({ match, kind: 'full' });
        for (const match of web.partialMatchingImages || []) addMatch({ match, kind: 'partial' });
        for (const match of web.visuallySimilarImages || []) addMatch({ match, kind: 'similar' });
      }
    }
    const unique = [...new Map(items.map((item) => [item.url, item])).values()].slice(0, maxCandidates);
    return { status: 'ok', items: unique, corroborationPages, error: '', requests, blocked, trace };
  };
}
