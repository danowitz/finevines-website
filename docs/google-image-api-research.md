# Google Custom Search image results: what is happening and what to test

Date: 2026-08-12

## Bottom line

The behavior is strange, but it is not evidence that the API key or `searchType=image` is misconfigured. Google's own documentation says Programmable Search image results **will differ from Google Images even when the engine searches the entire web**. A whole-web Programmable Search Engine searches only a subset of Google's corpus and omits Google.com features such as universal-search integrations. That means the strong Shopping/sponsored bottle row visible in a browser is not something the Custom Search JSON API promises to reproduce.

The API response model describes `items[].link` as the result's full URL and supplies indexed MIME/size metadata, but Google does **not** document that `link` is restricted to HTTP(S), that a later unauthenticated fetch will succeed, or that the live response will still have the indexed MIME type. `x-raw-image:///...` is not documented by Google at all. The defensible conclusion is that it is an unusable, undocumented result reference; we should reject it as non-HTTP and log it distinctly. Likewise, a URL that now serves HTML is a stale/redirected/protected search lead, not a downloadable image. The pipeline must verify scheme, HTTP response, final URL, signature, live content type, dimensions, and identity after every search result.

There are configuration changes worth testing, especially `imgType=photo`, `imgSize=large`, `filter=0`, locale hints, additional result pages, and targeted permitted domains. None can guarantee a downloadable original or browser-Google-Images parity.

## What the official documentation establishes

### 1. Programmable Search is not Google Images

- Google explicitly says custom image results vary from Google Images even when configured to search the entire web, because Programmable Search provides a customized experience. [Enable Image Search](https://support.google.com/programmable-search/answer/12423774?hl=en)
- A whole-web Programmable Search Engine uses only a subset of the Google Web Search corpus, emphasizes configured sites, and excludes features such as Oneboxes, real-time results, universal search, social features, and personalized results. [Programmable Search Engine vs Google.com](https://support.google.com/programmable-search/answer/70392?hl=en)
- Therefore, browser Shopping/sponsored/product-image rows are not evidence that the JSON API should return the same URLs. There is no Custom Search JSON API parameter that opts into Google Shopping or Google's browser Images ranking/product modules.

### 2. What `searchType=image` actually returns

- `searchType=image` selects custom image search. Each response result can include `link`, `mime`, `fileFormat`, plus an `image` object with `contextLink`, indexed dimensions/byte size, and `thumbnailLink`. [Search response schema](https://developers.google.com/custom-search/v1/reference/rest/v1/Search)
- Google's schema calls `link` the full URL to which the search result points and `thumbnailLink` a URL to a thumbnail. It does not state that `link` is guaranteed to be HTTP(S), currently fetchable, hotlinkable, or byte-for-byte an image when fetched by a server.
- Programmable image search relies on structured data and image metadata discovered when Google crawls a page. That is indexed discovery metadata, not a live-origin health check performed for our downloader. [Filtering and sorting search results](https://developers.google.com/custom-search/docs/structured_search)
- Google acknowledges that stale pages can remain in Programmable Search results. [Problems with search results](https://support.google.com/programmable-search/answer/6001359?hl=en) This supports treating every URL as a lead that must be revalidated at download time.

### 3. `x-raw-image:///...` and HTML responses

- No official Programmable Search or Custom Search JSON API documentation defines the `x-raw-image` scheme. It is therefore unsafe to infer a supported retrieval method or construct a URL from it.
- Google can index PDFs and image formats, including JPEG, PNG, WebP, SVG, GIF, BMP, and AVIF. [File types indexable by Google](https://developers.google.com/search/docs/crawling-indexing/indexable-file-types) That makes PDF-associated image discovery plausible, but Google does not officially document that `x-raw-image` means “extract this embedded PDF image.” We should retain that as a hypothesis, not a fact.
- A result whose `link` later returns `text/html` may have redirected, changed since Google crawled it, or require browser/session behavior. There is no API switch that guarantees the origin will permit an automated direct-image fetch.

## Configuration and request parameters worth testing

The current implementation sends `q`, `searchType=image`, `num=10`, and `safe=active`. The API officially supports the following relevant controls. [cse.list parameters](https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list)

| Change | Why it may help | Limitation / risk |
|---|---|---|
| Verify Image Search is enabled in the engine control panel | Required engine-side setting for custom image search | The calls already returning image-shaped result objects strongly suggest this is enabled |
| Verify the existing engine still has “Search the entire web” enabled | Prevents an accidental small site list from constraining recall | Whole-web results are still only a subset of Google; once switched off, current Google guidance says it cannot be switched back on |
| `imgType=photo` | Biases away from logos, graphics, and animations | May exclude useful studio bottle renders; measure recall |
| `imgSize=large` (also test `xlarge`) | Favors publication-quality source dimensions | Can sharply reduce recall; indexed size does not guarantee the fetched bytes still match |
| `filter=0` | Turns off duplicate-content filtering, which may expose repeated copies of the same bottle design across hosts—the exact evidence the visual consensus stage wants | Returns more duplicates/noise; default is `filter=1` |
| `hl=en&gl=us` | Google says explicit UI language can improve quality and `gl` can improve relevance | A relevance hint, not a downloadability control |
| Fetch pages 2 and 3 with `start=11` and `start=21` | Gives the funnel 30 candidates instead of only the first 10 | Triples API calls/cost and downstream work; API is capped at 100 results and `num` at 10 |
| `fileType=jpg`, `fileType=png`, and `fileType=webp` as separate searches, then merge | May avoid document/container artifacts and yield conventional image files | One file type per request; can miss CDN URLs without extensions and increases query cost. Treat as an experiment, not a default |
| `siteSearch=<domain>&siteSearchFilter=i` for known producer/importer domains | Strong provenance and fewer hostile/irrelevant hosts | One named site restriction per call. Use only when a likely official domain is known |
| A curated “Sites to search” engine containing permitted producer/importer/retailer domains | Makes the engine topical and can improve quality across known sources | New engines are limited to designated domains; current guidance allows at most 50 distinct domains. It cannot replace broad-web discovery |
| Retry `spelling.correctedQuery` when Google returns it and the first pass is poor | Uses the correction exposed in the official response schema | Only useful when Google actually supplies a correction; should supplement, not replace, the exact catalog query |
| `rights=...` | Filters by Creative Commons licensing combinations | Does not guarantee fetchability, identity, or image quality and will reduce recall. Do not add merely to solve this defect |

`exactTerms` can force a phrase and `excludeTerms` can remove obvious noise, but exact producer/wine strings often vary by accents, abbreviations, vintage, or importer spelling. They should be tested only as fallback query variants, not imposed on every search.

## Recommended controlled experiment

Use a frozen set of 30 known misses, including the Anne Parent example. Preserve every raw API response and every HTTP fetch trace so search quality and downloader behavior remain separable.

Run these variants against the identical query strings:

1. Baseline: current request.
2. Photo: `imgType=photo`.
3. Photo + size: `imgType=photo&imgSize=large`.
4. Consensus recall: `filter=0`.
5. Locale: `hl=en&gl=us`.
6. Depth: baseline across `start=1,11,21`.
7. Conventional files: three calls with `fileType=jpg`, `png`, and `webp`, merged and deduplicated.
8. Provenance fallback: one targeted call for a known producer/importer domain when such a domain can be derived confidently.

For each wine and variant, record:

- API items returned;
- HTTP(S) links versus non-HTTP references;
- origin fetch success, final URL, live content type, and file signature;
- image decode success and dimensions;
- permitted-host count;
- exact-identity matches;
- publication-quality matches;
- final accepted image;
- API calls and processing time.

Choose defaults from **final accepted images per API call**, not raw search result count. In particular, test `filter=0`: duplicated images are usually undesirable in search UI, but here independent copies of the same label are useful consensus evidence.

## What not to expect from configuration

- No setting makes Programmable Search return the same result set as browser Google Images.
- No setting adds Google Shopping/sponsored results to the Custom Search JSON API.
- No documented setting guarantees `items[].link` is a downloadable, stable, unauthenticated image URL.
- `imgType`, `imgSize`, `fileType`, and `rights` are search filters, not delivery guarantees.
- `thumbnailLink` can be used as low-resolution diagnostic evidence, but it should not become the published asset or sole provenance record; the authoritative source remains `image.contextLink` plus a validated original-host image.

## Strategic constraint

Google now says the Custom Search JSON API is closed to new customers and will be discontinued for existing customers on **January 1, 2027**. It recommends Vertex AI Search for up to 50 domains or contacting Google about a full-web-search solution. [Custom Search JSON API overview](https://developers.google.com/custom-search/v1/overview) Google also says new Programmable Search Engines can no longer use “Search the entire web”; existing engines retain it only through the transition. [January 2026 product update](https://programmablesearchengine.googleblog.com/2026/01/updates-to-our-web-search-products.html)

Therefore, tuning the present API is worthwhile for the immediate catalog backlog, but it should not be the sole long-term discovery architecture. A curated permitted-domain search path and supplier/importer media ingestion should be developed as durable fallbacks before 2027.
