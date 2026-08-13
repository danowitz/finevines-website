import { readFile } from 'node:fs/promises';
import { blockedBy } from './sources.mjs';

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

function permitted(url) {
  return url && !blockedBy(url);
}

// Deep module: callers provide already-verified anchors and receive only
// provenance-paired full matches. Authentication, request shape, response
// association, source policy, deduplication and spend bounds stay inside.
export function createWebMatchExpander({
  apiKey,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  maxSeeds = 2,
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
      let response;
      try {
        const bytes = await readFileImpl(seed.file);
        requests++;
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          // Keep credentials out of URLs, redirects and diagnostic traces.
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ requests: [{
            image: { content: bytes.toString('base64') },
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
      for (const page of web.pagesWithMatchingImages || []) {
        const context = page.url || '';
        if (permitted(context) && corroborationPages.length < 20) {
          corroborationPages.push({
            url: context,
            title: page.pageTitle || '',
            fullMatches: (page.fullMatchingImages || []).map((match) => match.url).filter(permitted).slice(0, 10),
            partialMatches: (page.partialMatchingImages || []).map((match) => match.url).filter(permitted).slice(0, 10),
          });
        }
        for (const match of page.fullMatchingImages || []) {
          const url = match.url || '';
          const outcome = url === seed.url ? 'seed-duplicate'
            : !permitted(url) ? 'blocked-image-host'
            : !permitted(context) ? 'blocked-context-host' : 'permitted-full-match';
          trace.push({
            seed: seed.id, seedIdentity: verifiedIdentity ? 'verified' : 'provisional',
            url, context, outcome, score: match.score || 0,
          });
          if (outcome !== 'permitted-full-match') {
            if (outcome.startsWith('blocked-')) blocked++;
            continue;
          }
          let host = '';
          try { host = new URL(context).host.replace(/^www\./, ''); } catch {}
          items.push({
            url,
            context,
            host,
            title: page.pageTitle || '',
            width: 0,
            height: 0,
            trustedFullMatch: verifiedIdentity,
            provisionalFullMatch: !verifiedIdentity,
            identityAnchorUrl: seed.url,
            discovery: 'google-web-detection',
          });
          if (items.length >= maxCandidates) break;
        }
        if (items.length >= maxCandidates) break;
      }
      if (items.length >= maxCandidates) break;
    }
    const unique = [...new Map(items.map((item) => [item.url, item])).values()].slice(0, maxCandidates);
    return { status: 'ok', items: unique, corroborationPages, error: '', requests, blocked, trace };
  };
}
